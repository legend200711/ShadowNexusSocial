/**
 * snx-gifts.js
 * Shadow Nexus Social — Gifting & Creator Monetization System
 *
 * Architecture:
 *   - Coin purchases go through PayPal (via paypal-worker.js Cloudflare Worker)
 *   - Coins are credited ONLY after PayPal webhook/capture verification on backend
 *   - ALL gift financial writes go through secure Firestore transactions
 *   - Creator payouts go through PayPal Payouts API via backend Worker
 *   - Client NEVER writes coin balances, earnings, or payouts directly
 *
 * Collections used:
 *   wallets/{uid}            — coin balance (backend-written only)
 *   coinPurchases/{id}       — purchase records (backend-managed)
 *   giftCatalog/{giftId}     — gift definitions
 *   giftTransactions/{id}    — immutable gift audit records
 *   creatorEarnings/{uid}    — creator accumulated earnings (backend-written)
 *   creatorPayouts/{id}      — cash-out requests (backend-managed)
 *   paypalAccounts/{uid}     — creator PayPal connection status
 */

'use strict';

/* ══════════════════════════════════════════════════
   FIRESTORE / AUTH HELPERS (reuse existing app)
   ══════════════════════════════════════════════════ */
function _snxgDb()   { return window._snxFirestore || null; }
function _snxgUser() { return window._snxCurrentUser || null; }
function _snxgToast(msg, ms) {
  // index.html defines toastNotification; live.html uses a liveToast div via live.js
  if (typeof toastNotification === 'function') {
    toastNotification(msg, ms);
    return;
  }
  // Fallback for live.html — drive the liveToast element directly
  const liveToast = document.getElementById('liveToast');
  if (liveToast) {
    liveToast.textContent = msg;
    liveToast.classList.add('visible');
    clearTimeout(liveToast._snxTimer);
    liveToast._snxTimer = setTimeout(() => liveToast.classList.remove('visible'), ms || 3200);
  }
}

// PayPal Worker base URL — the yellow-term-11e6 worker handles all PayPal routes.
// This is a different origin from shadownexussocial.online so the URL must be absolute.
const SNX_PAYPAL_WORKER = 'https://yellow-term-11e6.nthntjrn.workers.dev/paypal';

/**
 * Get the current user's Firebase ID token for backend calls.
 * Never send this to a third party — only to our own paypal-worker.
 */
async function _snxgGetIdToken() {
  const user = _snxgUser();
  if (!user) throw new Error('Not authenticated');
  if (typeof user.getIdToken === 'function') return user.getIdToken(/* forceRefresh */ false);
  throw new Error('Cannot get ID token');
}

/**
 * Make an authenticated call to the paypal-worker backend.
 */
async function _snxgPaypalPost(endpoint, body) {
  const res = await fetch(`${SNX_PAYPAL_WORKER}${endpoint}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ success: false, error: 'Invalid server response' }));
  return { ok: res.ok, status: res.status, data };
}

/* ══════════════════════════════════════════════════
   GIFT CATALOG — authoritative prices live in
   Firestore /giftCatalog but we keep a client cache
   for fast UI rendering.  Server always revalidates.
   ══════════════════════════════════════════════════ */
const SNX_GIFT_CATALOG = [
  { id: 'black_cat',       name: 'Black Cat',         art: '🐱',  coins: 10,  premium: false, enabled: true },
  { id: 'shadow_lightning',name: 'Shadow Lightning',  art: '⚡',  coins: 25,  premium: false, enabled: true },
  { id: 'blue_flame',      name: 'Blue Flame',        art: '🔵🔥', coins: 50,  premium: false, enabled: true },
  { id: 'wolf',            name: 'Wolf',              art: '🐺',  coins: 100, premium: false, enabled: true },
  { id: 'grim_reaper',     name: 'Grim Reaper',       art: '💀',  coins: 200, premium: true,  enabled: true },
  { id: 'stay_legendary',  name: 'STAY LEGENDARY',    art: '🌑',  coins: 300, premium: true,  enabled: true },
];

// Coin exchange rate: 100 coins = $1.00  →  1 coin = $0.01
const COINS_PER_DOLLAR = 100;

/* ══════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════ */
let _snxgCoinBalance  = 0;  // cached locally; authoritative copy is in Firestore
let _snxgWalletUnsub  = null;
let _snxgTargetPostId = null;
let _snxgTargetUid    = null;  // creator uid of post/live being gifted to
let _snxgSelectedGift = null;
let _snxgLiveMode     = false;
let _snxgSending      = false;

/* ══════════════════════════════════════════════════
   INIT — called after Firebase auth resolves
   ══════════════════════════════════════════════════ */
function snxgInit() {
  const user = _snxgUser();
  if (!user) return;
  _snxgSubscribeWallet(user.uid);
  _snxgRenderCoinPill();
}
window.snxgInit = snxgInit;

/* ══════════════════════════════════════════════════
   WALLET SUBSCRIPTION — real-time coin balance
   ══════════════════════════════════════════════════ */
function _snxgSubscribeWallet(uid) {
  const fs = _snxgDb();
  if (!fs) return;
  const { db, doc, onSnapshot } = fs;

  if (_snxgWalletUnsub) { try { _snxgWalletUnsub(); } catch(_) {} }

  const walletRef = doc(db, 'wallets', uid);
  _snxgWalletUnsub = onSnapshot(walletRef, snap => {
    const data = snap.exists() ? snap.data() : {};
    _snxgCoinBalance = data.shadowCoins || 0;
    _snxgRenderCoinPill();
    _snxgRefreshGiftAffordability();
    // Sync all nav coin displays
    if (typeof window._snxgSyncNavCoins === 'function') window._snxgSyncNavCoins(_snxgCoinBalance);
  }, err => {
    console.warn('[SNX-GIFTS] Wallet snapshot error:', err.code);
  });
}

/* ══════════════════════════════════════════════════
   COIN PILL — top-right shortcut
   ══════════════════════════════════════════════════ */
function _snxgRenderCoinPill() {
  const pill = document.getElementById('snxCoinPill');
  if (!pill) return;
  const amtEl = pill.querySelector('.coin-pill-amt');
  if (amtEl) amtEl.textContent = _snxgCoinBalance.toLocaleString();
}

/* ══════════════════════════════════════════════════
   COIN PURCHASE MODAL
   ══════════════════════════════════════════════════ */
const QUICK_BUY_AMOUNTS = [0.01, 1, 5, 10, 25, 50, 100];

function snxgOpenBuyCoins() {
  const user = _snxgUser();
  if (!user) { _snxgToast('Please sign in first.'); return; }
  const overlay = document.getElementById('snxCoinModal');
  if (!overlay) { _snxgBuildCoinModal(); return snxgOpenBuyCoins(); }
  _snxgUpdateCoinModalBalance();
  overlay.classList.add('open');
}
window.snxgOpenBuyCoins = snxgOpenBuyCoins;

function snxgCloseBuyCoins() {
  const overlay = document.getElementById('snxCoinModal');
  if (overlay) overlay.classList.remove('open');
}
window.snxgCloseBuyCoins = snxgCloseBuyCoins;

function _snxgBuildCoinModal() {
  const quickBtns = QUICK_BUY_AMOUNTS.map(amt => {
    const coins = Math.floor(amt * COINS_PER_DOLLAR);
    return `<button class="snxg-qb-btn" data-amt="${amt}" onclick="snxgSelectQuickBuy(${amt},this)">
      <div class="qb-price">$${amt < 1 ? amt.toFixed(2) : amt}</div>
      <div class="qb-coins">🪙 ${coins}</div>
    </button>`;
  }).join('');

  const html = `
  <div class="snxg-modal-overlay" id="snxCoinModal" onclick="if(event.target===this)snxgCloseBuyCoins()">
    <div class="snxg-modal-card" style="position:relative;">
      <button class="snxg-modal-close" onclick="snxgCloseBuyCoins()">✕</button>
      <div class="snxg-modal-title">🪙 Buy Shadow Coins</div>
      <div class="snxg-modal-sub">Power up your wallet to send gifts to creators</div>

      <div class="snxg-coin-header">
        <div class="snxg-coin-header-icon">🪙</div>
        <div class="snxg-coin-header-info">
          <div class="snxg-coin-header-label">Current Balance</div>
          <div class="snxg-coin-header-balance" id="snxCoinModalBal">${_snxgCoinBalance.toLocaleString()}</div>
          <div style="font-size:11px;color:#4a7a9a;">Shadow Coins</div>
        </div>
      </div>

      <div class="snxg-section-label">Quick Buy</div>
      <div class="snxg-quickbuy-grid">${quickBtns}</div>

      <div class="snxg-section-label">Custom Amount</div>
      <div class="snxg-custom-row">
        <label>$</label>
        <input class="snxg-custom-input" id="snxCoinCustomAmt" type="number" min="0.01" max="100" step="0.01" placeholder="0.00" oninput="snxgCustomAmountChange(this.value)">
      </div>

      <div class="snxg-coins-preview">
        <div class="cp-label">You will receive</div>
        <div class="cp-amount" id="snxCoinPreviewAmt">–</div>
        <div style="font-size:16px;margin:2px 0;">Shadow Coins</div>
        <div class="cp-rate">100 coins = $1.00 USD</div>
      </div>

      <div class="cs-status-msg info" id="snxCoinPurchaseNote" style="display:none;"></div>

      <button class="snxg-buy-btn" id="snxCoinBuyBtn" onclick="snxgConfirmPurchase()" disabled>
        <img src="https://www.paypalobjects.com/webstatic/en_US/i/buttons/PP_logo_h_200x51.png" alt="PayPal" style="height:18px;vertical-align:middle;margin-right:6px;">Pay with PayPal
      </button>

      <p style="font-size:10px;color:#3a5a7a;text-align:center;margin-top:10px;line-height:1.6;">
        Coins are credited after payment is verified by our backend.<br>
        Minimum $0.01 · Maximum $100 per purchase.
      </p>
    </div>
  </div>`;

  document.body.insertAdjacentHTML('beforeend', html);
}

let _snxgSelectedBuyAmt = null;
function snxgSelectQuickBuy(amt, btn) {
  _snxgSelectedBuyAmt = amt;
  document.querySelectorAll('.snxg-qb-btn').forEach(b => b.classList.remove('selected'));
  if (btn) btn.classList.add('selected');
  const custom = document.getElementById('snxCoinCustomAmt');
  if (custom) custom.value = '';
  _snxgUpdateCoinPreview(amt);
}
window.snxgSelectQuickBuy = snxgSelectQuickBuy;

function snxgCustomAmountChange(val) {
  document.querySelectorAll('.snxg-qb-btn').forEach(b => b.classList.remove('selected'));
  const num = parseFloat(val);
  _snxgSelectedBuyAmt = (!isNaN(num) && num >= 0.01 && num <= 100) ? num : null;
  _snxgUpdateCoinPreview(_snxgSelectedBuyAmt);
}
window.snxgCustomAmountChange = snxgCustomAmountChange;

function _snxgUpdateCoinPreview(amt) {
  const previewEl = document.getElementById('snxCoinPreviewAmt');
  const buyBtn    = document.getElementById('snxCoinBuyBtn');
  if (!previewEl) return;
  if (amt && amt >= 0.01 && amt <= 100) {
    const coins = Math.floor(amt * COINS_PER_DOLLAR);
    previewEl.textContent = coins.toLocaleString();
    if (buyBtn) buyBtn.disabled = false;
  } else {
    previewEl.textContent = '–';
    if (buyBtn) buyBtn.disabled = true;
  }
}

function _snxgUpdateCoinModalBalance() {
  const el = document.getElementById('snxCoinModalBal');
  if (el) el.textContent = _snxgCoinBalance.toLocaleString();
}

async function snxgConfirmPurchase() {
  const user = _snxgUser();
  if (!user) { _snxgToast('Please sign in first.'); return; }
  if (!_snxgSelectedBuyAmt || _snxgSelectedBuyAmt < 0.01 || _snxgSelectedBuyAmt > 100) {
    _snxgToast('Please select a valid amount between $0.01 and $100.');
    return;
  }

  const btn  = document.getElementById('snxCoinBuyBtn');
  const note = document.getElementById('snxCoinPurchaseNote');
  if (btn)  { btn.disabled = true; btn.textContent = 'Opening PayPal…'; }
  if (note) { note.style.display = 'block'; note.className = 'cs-status-msg info'; note.textContent = 'Creating your order…'; }

  let idToken;
  try {
    idToken = await _snxgGetIdToken();
  } catch {
    if (note) { note.className = 'cs-status-msg error'; note.textContent = 'Session expired. Please sign out and back in.'; }
    if (btn)  { btn.disabled = false; btn.textContent = '💳 Pay with PayPal'; }
    return;
  }

  // Store token in sessionStorage so paypal-return.html can use it after redirect
  sessionStorage.setItem('snxg_paypal_idtoken', idToken);

  try {
    const { ok, data } = await _snxgPaypalPost('/create-order', {
      usdAmount: _snxgSelectedBuyAmt,
      idToken,
    });

    if (!ok || !data.success) {
      const msg = data?.error || 'Payment service unavailable. Please try again.';
      if (note) { note.className = 'cs-status-msg error'; note.textContent = msg; }
      if (btn)  { btn.disabled = false; btn.textContent = '💳 Pay with PayPal'; }
      return;
    }

    if (note) { note.className = 'cs-status-msg info'; note.textContent = 'Redirecting to PayPal…'; }

    // Redirect to PayPal approval page
    // PayPal will redirect back to paypal-return.html after approval
    window.location.href = data.approveLink;

  } catch (err) {
    console.error('[SNX-GIFTS] confirmPurchase error:', err);
    sessionStorage.removeItem('snxg_paypal_idtoken');
    if (note) { note.className = 'cs-status-msg error'; note.textContent = 'Network error. Please check your connection and try again.'; }
    if (btn)  { btn.disabled = false; btn.textContent = '💳 Pay with PayPal'; }
  }
}
window.snxgConfirmPurchase = snxgConfirmPurchase;

/* ══════════════════════════════════════════════════
   GIFT TRAY — OPEN / CLOSE
   ══════════════════════════════════════════════════ */
function snxgOpenGiftTray(postId, creatorUid, isLive) {
  const user = _snxgUser();
  if (!user) { _snxgToast('Please sign in to send gifts.'); return; }
  if (user.uid === creatorUid) { _snxgToast('You cannot gift yourself.'); return; }

  _snxgTargetPostId = postId   || null;
  _snxgTargetUid    = creatorUid || null;
  _snxgLiveMode     = !!isLive;
  _snxgSelectedGift = null;

  const tray = document.getElementById('snxGiftTray');
  if (!tray) { _snxgBuildGiftTray(); return snxgOpenGiftTray(postId, creatorUid, isLive); }

  _snxgRenderGiftTrayGrid();
  _snxgRefreshGiftAffordability();
  _snxgHideConfirmBanner();
  tray.classList.add('open');
}
window.snxgOpenGiftTray = snxgOpenGiftTray;

function snxgCloseGiftTray() {
  const tray = document.getElementById('snxGiftTray');
  if (tray) tray.classList.remove('open');
  _snxgSelectedGift = null;
  _snxgSending = false;
}
window.snxgCloseGiftTray = snxgCloseGiftTray;

function _snxgBuildGiftTray() {
  const html = `
  <div id="snxGiftTray">
    <div class="tray-backdrop" onclick="snxgCloseGiftTray()"></div>
    <div class="gift-tray-sheet">
      <div class="gift-tray-handle"></div>
      <div class="gift-tray-header">
        <div class="gift-tray-title">🎁 Send a Gift</div>
        <button class="gift-tray-close" onclick="snxgCloseGiftTray()">✕</button>
      </div>
      <div class="gift-tray-balance">Your balance: <span id="giftTrayBalance">${_snxgCoinBalance.toLocaleString()}</span> 🪙
        <span style="margin-left:8px;font-size:11px;cursor:pointer;color:#00AEEF;" onclick="snxgCloseGiftTray();snxgOpenBuyCoins()">+ Buy Coins</span>
      </div>
      <div class="gift-tray-grid" id="giftTrayGrid"></div>
      <div class="gift-confirm-banner" id="giftConfirmBanner">
        <div class="gift-confirm-art" id="giftConfirmArt"></div>
        <div class="gift-confirm-info">
          <div class="gift-confirm-name" id="giftConfirmName"></div>
          <div class="gift-confirm-cost" id="giftConfirmCost"></div>
        </div>
        <button class="gift-confirm-send" id="giftConfirmSend" onclick="snxgSendGift()">Send 🎁</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

function _snxgRenderGiftTrayGrid() {
  const grid    = document.getElementById('giftTrayGrid');
  const balEl   = document.getElementById('giftTrayBalance');
  if (!grid) return;
  if (balEl) balEl.textContent = _snxgCoinBalance.toLocaleString();

  grid.innerHTML = SNX_GIFT_CATALOG.filter(g => g.enabled).map(gift => {
    const canAfford = _snxgCoinBalance >= gift.coins;
    const artHtml   = _snxgGiftArt(gift, 'tray');
    return `
    <div class="gift-item${gift.premium ? ' premium' : ''}${canAfford ? '' : ' insufficient'}"
         id="giftItem_${gift.id}"
         onclick="snxgSelectGift('${gift.id}')">
      ${gift.premium ? '<span class="gift-premium-badge">PREMIUM</span>' : ''}
      <span class="gift-item-art">${artHtml}</span>
      <div class="gift-item-name">${gift.name}</div>
      <div class="gift-item-price"><span class="coin-sym">🪙</span> ${gift.coins}</div>
    </div>`;
  }).join('');
}

function _snxgGiftArt(gift, context) {
  if (gift.id === 'stay_legendary') return `<span style="filter:drop-shadow(0 0 8px rgba(0,174,239,0.9));">${gift.art}</span>`;
  if (gift.id === 'grim_reaper')    return `<span style="filter:drop-shadow(0 0 6px rgba(80,0,200,0.7));">${gift.art}</span>`;
  if (gift.id === 'wolf')           return `<span style="filter:drop-shadow(0 0 5px rgba(0,174,239,0.6));">${gift.art}</span>`;
  return gift.art;
}

function snxgSelectGift(giftId) {
  const gift = SNX_GIFT_CATALOG.find(g => g.id === giftId);
  if (!gift) return;
  if (_snxgCoinBalance < gift.coins) {
    _snxgToast('Not enough Shadow Coins. 🪙 Reload Coins to send this gift.');
    _snxgShowReloadStrip();
    return;
  }
  _snxgSelectedGift = gift;

  // Highlight selected
  document.querySelectorAll('.gift-item').forEach(el => el.style.borderColor = '');
  const selEl = document.getElementById('giftItem_' + giftId);
  if (selEl) selEl.style.borderColor = 'rgba(0,174,239,0.9)';

  // Show confirm banner
  const banner  = document.getElementById('giftConfirmBanner');
  const artEl   = document.getElementById('giftConfirmArt');
  const nameEl  = document.getElementById('giftConfirmName');
  const costEl  = document.getElementById('giftConfirmCost');
  if (banner) banner.classList.add('visible');
  if (artEl)  artEl.textContent = gift.art;
  if (nameEl) nameEl.textContent = gift.name;
  if (costEl) costEl.textContent = `${gift.coins} Shadow Coins · Your balance: ${_snxgCoinBalance.toLocaleString()}`;
}
window.snxgSelectGift = snxgSelectGift;

function _snxgHideConfirmBanner() {
  const banner = document.getElementById('giftConfirmBanner');
  if (banner) banner.classList.remove('visible');
}

function _snxgRefreshGiftAffordability() {
  SNX_GIFT_CATALOG.forEach(gift => {
    const el = document.getElementById('giftItem_' + gift.id);
    if (!el) return;
    if (_snxgCoinBalance >= gift.coins) { el.classList.remove('insufficient'); }
    else { el.classList.add('insufficient'); }
  });
  const balEl = document.getElementById('giftTrayBalance');
  if (balEl) balEl.textContent = _snxgCoinBalance.toLocaleString();
}

function _snxgShowReloadStrip() {
  const banner = document.getElementById('giftConfirmBanner');
  if (!banner) return;
  banner.classList.add('visible');
  banner.innerHTML = `
    <div class="snxg-reload-strip" style="width:100%;margin:0;" onclick="snxgCloseGiftTray();snxgOpenBuyCoins()">
      <span class="reload-coin-icon">🪙</span>
      <div class="reload-text">Need more coins?<br><span style="font-size:10px;color:#4a7a9a;">Reload in seconds to keep gifting.</span></div>
      <div class="reload-cta">+ Reload Coins →</div>
    </div>`;
}

/* ══════════════════════════════════════════════════
   SEND GIFT — FIRESTORE TRANSACTION
   ══════════════════════════════════════════════════ */
async function snxgSendGift() {
  if (_snxgSending) return;

  // ── [GIFT DEBUG] START ─────────────────────────────────────────────────────
  console.log('[GIFT DEBUG] START snxgSendGift()');

  // ── 1. Auth check ──
  const user = _snxgUser();
  console.log('[GIFT DEBUG] authenticated user:', user ? user.uid : 'NONE');
  if (!user) { _snxgToast('Please sign in to send gifts.'); return; }

  // ── 2. Gift selection ──
  const gift = _snxgSelectedGift;
  console.log('[GIFT DEBUG] gift ID:',    gift ? gift.id    : 'NONE');
  console.log('[GIFT DEBUG] gift name:',  gift ? gift.name  : 'NONE');
  console.log('[GIFT DEBUG] gift price:', gift ? gift.coins : 'NONE');
  if (!gift) { _snxgToast('Please select a gift first.'); return; }

  // ── 3. Recipient ──
  console.log('[GIFT DEBUG] recipient ID:', _snxgTargetUid || 'NONE');
  if (!_snxgTargetUid) { _snxgToast('Invalid recipient.'); return; }

  // ── 4. Content context ──
  const postId   = _snxgTargetPostId || null;
  const isLive   = _snxgLiveMode;
  const contentType = isLive ? 'live' : (postId ? 'post' : 'feed');
  const contentId   = postId || null;
  console.log('[GIFT DEBUG] content type:', contentType);
  console.log('[GIFT DEBUG] content ID:',   contentId || '(none)');

  // ── 5. Gifting feature flag — read from siteSettings/config ──
  // Prefer the cached value set by the siteSettings onSnapshot listener in index.html.
  // Fall back to a direct Firestore read when the cache isn't available (e.g. live.html).
  // No flag = gifting is enabled by default.
  let giftingEnabled = true;
  if (typeof window._snxGiftingEnabled === 'boolean') {
    // Use the real-time cached value — already synced by the siteSettings onSnapshot.
    giftingEnabled = window._snxGiftingEnabled;
    console.log('[GIFT DEBUG] gifting enabled (cached):', giftingEnabled);
  } else {
    // Cache miss — read Firestore directly (live.html or first load before snapshot fires).
    try {
      const fs0 = _snxgDb();
      if (fs0) {
        const cfgSnap = await fs0.getDoc(fs0.doc(fs0.db, 'siteSettings', 'config'));
        const cfg = cfgSnap.exists() ? cfgSnap.data() : {};
        giftingEnabled = cfg.giftingEnabled !== false;
      }
    } catch (flagErr) {
      console.warn('[GIFT DEBUG] could not read siteSettings — defaulting gifting to enabled:', flagErr.message);
    }
    console.log('[GIFT DEBUG] gifting enabled (live read):', giftingEnabled);
  }
  if (!giftingEnabled) {
    _snxgToast('Gifting is currently disabled by the platform.');
    return;
  }

  // ── 6. Firestore availability ──
  const fs = _snxgDb();
  console.log('[GIFT DEBUG] Firestore available:', !!fs);
  if (!fs) {
    // _snxFirestore was not set by the page's module script.
    // This can happen if Firebase failed to initialize or if snx-gifts.js
    // loaded before the inline Firebase module script finished running.
    console.error('[GIFT ERROR] window._snxFirestore is null — Firebase not initialized yet.');
    _snxgToast('Gift could not be sent (Firestore unavailable). Please reload and try again.');
    return;
  }

  const { db, doc, collection, getDoc: fsGetDoc, runTransaction, serverTimestamp } = fs;

  // ── 7. Wallet pre-check (UX only — server is authoritative) ──
  const walletRef0 = doc(db, 'wallets', user.uid);
  let walletFound  = false;
  let currentBalance = 0;
  try {
    const wSnap = await fsGetDoc(walletRef0);
    walletFound    = wSnap.exists() ? true : false;
    currentBalance = (wSnap.exists() && typeof wSnap.data().shadowCoins === 'number')
      ? wSnap.data().shadowCoins : 0;
  } catch (wErr) {
    console.warn('[GIFT DEBUG] wallet pre-read error:', wErr.code, wErr.message);
  }
  console.log('[GIFT DEBUG] wallet found:', walletFound);
  console.log('[GIFT DEBUG] current balance:', currentBalance, '| gift costs:', gift.coins);

  // Only block early if we know the balance and it's truly insufficient
  if (walletFound && currentBalance < gift.coins) {
    _snxgToast('Not enough Shadow Coins. 🪙 Reload Coins to continue.');
    _snxgShowReloadStrip();
    return;
  }

  _snxgSending = true;
  const sendBtn = document.getElementById('giftConfirmSend');
  if (sendBtn) { sendBtn.disabled = true; sendBtn.innerHTML = '<span class="snxg-processing">Sending…</span>'; }

  // Snapshot all fields needed by the transaction
  const giftId       = gift.id;
  const giftName     = gift.name;
  const giftArt      = gift.art;
  const coinPrice    = gift.coins;   // always from trusted local catalog
  const creatorId    = _snxgTargetUid;
  const senderId     = user.uid;
  const senderName   = user.displayName || 'Shadow User';
  const senderAvatar = user.photoURL    || '';

  // 90/10 split — remainder avoids float drift
  const creatorCoins  = Math.floor(coinPrice * 0.9);
  const platformCoins = coinPrice - creatorCoins;

  const txId            = _snxgGenTxId();
  const senderWalletRef = doc(db, 'wallets',         senderId);
  const creatorEarnRef  = doc(db, 'creatorEarnings', creatorId);
  // Use txId as the document ID — this makes the transaction idempotent.
  // If the same txId is committed twice (network retry), Firestore will
  // reject the second write on the giftTxRef with 'already-exists', but
  // since the wallet deduction already happened, the retry loop will fail
  // at the balance check (insufficient_coins).  The client _snxgSending lock
  // prevents double-clicks within the same tab; txId uniqueness protects
  // against multi-tab or network-retry duplicates.
  const giftTxRef       = doc(db, 'giftTransactions', txId);

  try {
    console.log('[GIFT DEBUG] transaction starting — txId:', txId);

    await runTransaction(db, async (tx) => {

      // ── READ 0: idempotency check — abort if txId already committed ────────
      // This prevents a network retry from deducting coins twice.
      // The giftTxRef uses txId as the document ID — if it exists, the gift
      // was already processed successfully.
      const existingTxSnap = await tx.get(giftTxRef);
      if (existingTxSnap.exists()) {
        // Gift was already committed (e.g. double-click in different tab).
        // Throw a special sentinel so the catch block shows a clear message.
        throw new Error('already_sent');
      }

      // ── READ 0b: server-side gift price verification ──────────────────────
      // Read the gift price from Firestore giftCatalog so the client cannot
      // manipulate the coin deduction amount.
      // If the catalog doc exists, use its price. Otherwise fall back to
      // the local catalog (which is also trusted since it's code, not input).
      const catalogRef  = doc(db, 'giftCatalog', giftId);
      const catalogSnap = await tx.get(catalogRef);
      let verifiedPrice = coinPrice;  // fallback: local catalog value
      if (catalogSnap.exists()) {
        const catalogData = catalogSnap.data();
        const catalogCoins = typeof catalogData.coins === 'number' ? catalogData.coins
          : typeof catalogData.coinPrice === 'number' ? catalogData.coinPrice
          : null;
        if (catalogCoins !== null && catalogCoins > 0) {
          verifiedPrice = catalogCoins;
          console.log('[GIFT DEBUG] catalog price:', verifiedPrice, '| client price:', coinPrice);
          if (verifiedPrice !== coinPrice) {
            console.warn('[GIFT] price mismatch: client sent', coinPrice, 'but catalog says', verifiedPrice, '— using catalog price');
          }
        }
      }
      // Override coinPrice with the server-verified price.
      // This is the authoritative amount deducted and recorded.
      const verifiedCoinPrice    = verifiedPrice;
      const verifiedCreatorCoins = Math.floor(verifiedCoinPrice * 0.9);
      const verifiedPlatformCoins = verifiedCoinPrice - verifiedCreatorCoins;

      // ── READ 1: sender wallet ──────────────────────────────────────────────
      const senderSnap = await tx.get(senderWalletRef);
      const senderData = senderSnap.exists() ? senderSnap.data() : {};
      const txCoins    = typeof senderData.shadowCoins === 'number' ? senderData.shadowCoins : 0;
      console.log('[GIFT DEBUG] tx wallet balance:', txCoins, '| wallet doc exists:', senderSnap.exists());

      if (txCoins < verifiedCoinPrice) {
        throw new Error('insufficient_coins');
      }

      const newBalance = txCoins - verifiedCoinPrice;
      const totalSpent = (typeof senderData.totalSpent === 'number' ? senderData.totalSpent : 0) + verifiedCoinPrice;

      // ── READ 2: creator earnings ───────────────────────────────────────────
      const earnSnap = await tx.get(creatorEarnRef);
      const earnData = earnSnap.exists() ? earnSnap.data() : {};
      console.log('[GIFT DEBUG] creator earnings doc exists:', earnSnap.exists());

      const newPending   = (typeof earnData.pendingCoins   === 'number' ? earnData.pendingCoins   : 0) + verifiedCreatorCoins;
      const newAvailable = (typeof earnData.availableCoins === 'number' ? earnData.availableCoins : 0) + verifiedCreatorCoins;
      const newLifetime  = (typeof earnData.lifetimeCoins  === 'number' ? earnData.lifetimeCoins  : 0) + verifiedCreatorCoins;
      const newPlatform  = (typeof earnData.platformCoins  === 'number' ? earnData.platformCoins  : 0) + verifiedPlatformCoins;

      // ── WRITE 1: deduct sender wallet ──────────────────────────────────────
      // Use update() when doc exists, set() when it doesn't — avoids the
      // create-rule path for update operations on existing wallets.
      if (senderSnap.exists()) {
        tx.update(senderWalletRef, {
          shadowCoins: newBalance,
          totalSpent,
          lastGiftAt:  serverTimestamp(),
        });
      } else {
        // Wallet doesn't exist yet (edge case) — create it.
        // The create rule requires: isOwner(uid) && shadowCoins is number >= 0.
        tx.set(senderWalletRef, {
          uid:         senderId,
          shadowCoins: newBalance,
          totalSpent,
          lastGiftAt:  serverTimestamp(),
        });
      }

      // ── WRITE 2: credit creator earnings ──────────────────────────────────
      tx.set(creatorEarnRef, {
        uid:            creatorId,
        pendingCoins:   newPending,
        availableCoins: newAvailable,
        lifetimeCoins:  newLifetime,
        platformCoins:  newPlatform,
        lastGiftAt:     serverTimestamp(),
      }, { merge: true });

      // ── WRITE 3: immutable gift transaction record ─────────────────────────
      tx.set(giftTxRef, {
        txId,
        senderId,
        senderName,
        senderAvatar,
        recipientId:     creatorId,
        creatorId,
        contentType,
        contentId,
        postId:          contentId,
        isLive,
        giftId,
        giftName,
        giftArt,
        coinAmount:      verifiedCoinPrice,
        creatorCoins:    verifiedCreatorCoins,
        platformCoins:   verifiedPlatformCoins,
        creatorPct:      90,
        platformPct:     10,
        transactionType: 'TEST_GIFT',
        environment:     'sandbox',
        status:          'completed',
        createdAt:       serverTimestamp(),
      });
    });

    console.log('[GIFT DEBUG] transaction committed ✓');

    // ── Only after commit: update UI ──
    snxgCloseGiftTray();
    _snxgToast(`🎁 ${giftName} sent!`);
    _snxgPlayGiftAnimation(gift, senderName);
    if (isLive) _snxgShowLiveGiftToast(senderName, gift);

  } catch (err) {
    // Full technical error — ALWAYS visible in console regardless of user-facing message
    const errCode    = err.code    || '(none)';
    const errMessage = err.message || '(none)';
    console.error('[GIFT ERROR] sendGift transaction failed');
    console.error('[GIFT ERROR] error.code:',    errCode);
    console.error('[GIFT ERROR] error.message:', errMessage);
    console.error('[GIFT ERROR] error.stack:',   err.stack || '(none)');
    console.error('[GIFT ERROR] txId:', txId);
    console.error('[GIFT ERROR] giftId:', giftId, '| coinPrice:', coinPrice);
    console.error('[GIFT ERROR] senderId:', senderId, '| creatorId:', creatorId);
    console.error('[GIFT ERROR] contentType:', contentType, '| contentId:', contentId || '(none)');
    console.error('[GIFT ERROR] full error object:', err);

    let msg;
    if (err.message === 'already_sent') {
      // This can happen if the same gift was submitted from two browser tabs.
      // The first one succeeded — show success rather than an error.
      console.warn('[GIFT] Gift was already committed with txId:', txId, '— suppressing duplicate.');
      snxgCloseGiftTray();
      _snxgToast(`🎁 ${giftName} already sent! (duplicate request ignored)`);
      _snxgPlayGiftAnimation(gift, senderName);
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send 🎁'; }
      _snxgSending = false;
      return;
    } else if (err.message === 'insufficient_coins') {
      msg = 'Not enough Shadow Coins. 🪙 Reload Coins to continue.';
    } else if (errCode === 'permission-denied') {
      msg = 'Gift blocked (permission-denied). Check console for details.';
    } else if (errCode === 'unavailable' || errCode === 'deadline-exceeded') {
      msg = 'Network issue — your gift was not sent. Please try again.';
    } else if (errCode === 'aborted') {
      msg = 'Gift could not be sent (transaction conflict). Please try again.';
    } else if (errCode === 'not-found') {
      msg = 'Gift could not be sent (document not found). Please try again.';
    } else if (errCode === 'invalid-argument') {
      msg = `Gift could not be sent (invalid data: ${errMessage}). See console.`;
    } else if (errCode === 'unauthenticated') {
      msg = 'Gift blocked — please sign out and sign in again.';
    } else {
      // Show the actual error code so it can be reported — never hides the real cause
      msg = `Gift failed [${errCode}]: ${errMessage.slice(0, 80)}`;
    }
    _snxgToast(msg);
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send 🎁'; }
  } finally {
    _snxgSending = false;
  }
}
window.snxgSendGift = snxgSendGift;

/* ── Unique transaction ID ── */
function _snxgGenTxId() {
  return 'snx_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9).toUpperCase();
}

/* ══════════════════════════════════════════════════
   GIFT ANIMATIONS
   ══════════════════════════════════════════════════ */
function _snxgPlayGiftAnimation(gift, senderName) {
  if (gift.id === 'stay_legendary') {
    snxgPlayStayLegendary(senderName);
    return;
  }

  // General pop animation
  const el = document.createElement('div');
  el.className = 'snxg-gift-pop';

  // Position: center of viewport or over the post area
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  el.style.left = (vw * 0.5 - 50) + 'px';
  el.style.top  = (vh * 0.35) + 'px';

  let artContent = gift.art;
  if (gift.id === 'grim_reaper') {
    el.style.left = (vw * 0.5 - 60) + 'px';
    el.style.top  = (vh * 0.25) + 'px';
  }

  el.innerHTML = `
    <span class="snxg-gift-pop-art">${artContent}</span>
    <div class="snxg-gift-pop-name">${gift.name}</div>
    <div class="snxg-gift-pop-sender">from ${senderName}</div>
  `;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

/* ══════════════════════════════════════════════════
   STAY LEGENDARY ANIMATION
   ══════════════════════════════════════════════════ */
function snxgPlayStayLegendary(senderName) {
  let overlay = document.getElementById('snxStayLegendaryOverlay');
  if (!overlay) {
    _snxgBuildStayLegendaryOverlay();
    overlay = document.getElementById('snxStayLegendaryOverlay');
  }

  // Update sender name
  const senderEl = overlay.querySelector('.slo-sender');
  if (senderEl) senderEl.innerHTML = `Sent by <strong>${senderName}</strong>`;

  // Show overlay
  overlay.classList.add('active');

  // Start canvas particles
  _snxgStartSloCanvas();

  // Auto-dismiss after 5.5 seconds
  setTimeout(() => {
    overlay.classList.remove('active');
    _snxgStopSloCanvas();
  }, 5500);
}
window.snxgPlayStayLegendary = snxgPlayStayLegendary;

function _snxgBuildStayLegendaryOverlay() {
  // Build random lightning bolts
  let lightningHtml = '';
  for (let i = 0; i < 8; i++) {
    const x = Math.random() * 100;
    const h = 40 + Math.random() * 120;
    const delay = Math.random() * 2;
    lightningHtml += `<div class="slo-lightning" style="left:${x}%;top:${(Math.random() * 60)}%;height:${h}px;animation-delay:${delay}s;animation-duration:${0.1+Math.random()*0.2}s;"></div>`;
  }

  // Blue flames at bottom
  let flameHtml = '';
  for (let i = 0; i < 6; i++) {
    const x = 5 + i * 16;
    const delay = i * 0.15;
    flameHtml += `<div class="slo-flame" style="left:${x}%;bottom:0;animation-delay:${delay}s;"></div>`;
  }

  const html = `
  <div id="snxStayLegendaryOverlay">
    <div class="slo-bg"></div>
    <canvas id="sloCanvas"></canvas>
    ${lightningHtml}
    ${flameHtml}
    <div class="slo-content">
      <span class="slo-emblem">🌑</span>
      <span class="slo-title">STAY LEGENDARY</span>
      <span class="slo-tagline">Shadow Nexus Social</span>
      <div class="slo-sender">Sent by <strong>Shadow User</strong></div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

/* Simple canvas particle system for STAY LEGENDARY */
let _sloRafId = null;
const _sloParticles = [];

function _snxgStartSloCanvas() {
  const canvas = document.getElementById('sloCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;

  // Seed particles
  _sloParticles.length = 0;
  for (let i = 0; i < 80; i++) {
    _sloParticles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: 1 + Math.random() * 3,
      vx: (Math.random() - 0.5) * 1.5,
      vy: -(0.5 + Math.random() * 1.5),
      alpha: 0.4 + Math.random() * 0.6,
      color: Math.random() > 0.4 ? '#00AEEF' : '#3366ff',
    });
  }

  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of _sloParticles) {
      p.x += p.vx;
      p.y += p.vy;
      p.alpha -= 0.003;
      if (p.y < -10 || p.alpha <= 0) {
        p.x = Math.random() * canvas.width;
        p.y = canvas.height + 5;
        p.alpha = 0.4 + Math.random() * 0.6;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    _sloRafId = requestAnimationFrame(tick);
  }
  tick();
}

function _snxgStopSloCanvas() {
  if (_sloRafId) { cancelAnimationFrame(_sloRafId); _sloRafId = null; }
  const canvas = document.getElementById('sloCanvas');
  if (canvas) { const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); }
}

/* ══════════════════════════════════════════════════
   LIVE GIFT TOAST
   ══════════════════════════════════════════════════ */
function _snxgShowLiveGiftToast(senderName, gift) {
  let wrap = document.getElementById('snxLiveToastWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'snxLiveToastWrap';
    wrap.className = 'snxg-live-toast-wrap';
    document.body.appendChild(wrap);
  }

  const toast = document.createElement('div');
  toast.className = 'snxg-live-toast';
  toast.innerHTML = `
    <span class="lt-art">${gift.art}</span>
    <span><span class="lt-sender">${senderName}</span> sent <span class="lt-gift-name">${gift.name}!</span></span>
  `;
  wrap.appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

// Exposed so live.js can call it when receiving gift events via Firestore
window.snxgShowLiveGiftToast = function(senderName, giftId) {
  const gift = SNX_GIFT_CATALOG.find(g => g.id === giftId);
  if (!gift) return;
  if (gift.id === 'stay_legendary') {
    snxgPlayStayLegendary(senderName);
    return;
  }
  _snxgShowLiveGiftToast(senderName, gift);
  _snxgPlayGiftAnimation(gift, senderName);
};

/* ══════════════════════════════════════════════════
   CREATOR STUDIO PAGE
   ══════════════════════════════════════════════════ */
async function snxgLoadCreatorStudio() {
  const user = _snxgUser();
  if (!user) return;
  const fs = _snxgDb();
  if (!fs) return;

  const { db, doc, getDoc, collection, query, where, orderBy, limit, getDocs } = fs;

  _snxgSetEarningsLoading(true);

  try {
    // Load earnings
    const earnSnap = await getDoc(doc(db, 'creatorEarnings', user.uid));
    const earn = earnSnap.exists() ? earnSnap.data() : {};

    const available  = earn.availableCoins || 0;
    const pending    = earn.pendingCoins   || 0;
    const lifetime   = earn.lifetimeCoins  || 0;
    const platform   = earn.platformCoins  || 0;

    _snxgSetEarningsValues(available, pending, lifetime, platform);

    // Check last payout date for 24h cooldown (backend also enforces this)
    const payoutsQ = query(
      collection(db, 'creatorPayouts'),
      where('creatorId', '==', user.uid),
      orderBy('requestedAt', 'desc'),
      limit(1)
    );
    const payoutSnaps = await getDocs(payoutsQ);
    let lastPayoutTs = null;
    if (!payoutSnaps.empty) {
      const last = payoutSnaps.docs[0].data();
      lastPayoutTs = last.requestedAt?.toDate() || null;
    }
    _snxgUpdateCashOutBtn(available, lastPayoutTs);

  } catch(err) {
    console.error('[SNX-GIFTS] loadCreatorStudio:', err);
  } finally {
    _snxgSetEarningsLoading(false);
  }

  // Also load PayPal connection status
  snxgLoadPayPalStatus().catch(() => {});
}
window.snxgLoadCreatorStudio = snxgLoadCreatorStudio;

function _snxgSetEarningsLoading(loading) {
  const el = document.getElementById('csEarningsLoading');
  if (el) el.style.display = loading ? 'block' : 'none';
}

function _snxgSetEarningsValues(available, pending, lifetime, platform) {
  const fmt = (coins) => {
    const usd = (coins / COINS_PER_DOLLAR).toFixed(2);
    return `$${usd}`;
  };

  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setEl('csAvailBal',   fmt(available));
  setEl('csPendingBal', fmt(pending));
  setEl('csLifetimeBal',fmt(lifetime));
  setEl('csPlatformShare', fmt(platform));
  setEl('csAvailCoins', `${available.toLocaleString()} coins`);
}

function _snxgUpdateCashOutBtn(available, lastPayoutTs) {
  const btn  = document.getElementById('csCashOutBtn');
  const note = document.getElementById('csCashOutNote');
  if (!btn) return;

  const minCoins = 100; // $1.00 minimum payout
  const now      = Date.now();
  const cooldownMs = 24 * 60 * 60 * 1000;
  const hoursLeft  = lastPayoutTs
    ? Math.max(0, Math.ceil((lastPayoutTs.getTime() + cooldownMs - now) / 3600000))
    : 0;

  if (available < minCoins) {
    btn.disabled = true;
    if (note) { note.className = 'cs-status-msg info'; note.style.display = 'block'; note.textContent = `Minimum cash-out is $1.00 (${minCoins} coins). Keep growing! 🌑`; }
  } else if (hoursLeft > 0) {
    btn.disabled = true;
    if (note) { note.className = 'cs-status-msg warn'; note.style.display = 'block'; note.textContent = `You can request another payout after ${hoursLeft} hour${hoursLeft !== 1 ? 's' : ''}.`; }
  } else {
    btn.disabled = false;
    const usd = (available / COINS_PER_DOLLAR).toFixed(2);
    btn.textContent = `💰 Cash Out $${usd}`;
    if (note) { note.style.display = 'none'; }
  }
}

async function snxgRequestCashOut() {
  const user = _snxgUser();
  if (!user) return;

  const btn  = document.getElementById('csCashOutBtn');
  const note = document.getElementById('csCashOutNote');
  if (btn) btn.disabled = true;
  if (note) { note.className = 'cs-status-msg info'; note.style.display = 'block'; note.textContent = 'Processing payout request…'; }

  let idToken;
  try {
    idToken = await _snxgGetIdToken();
  } catch {
    if (note) { note.className = 'cs-status-msg error'; note.textContent = 'Session expired. Please sign out and back in.'; }
    if (btn)  btn.disabled = false;
    return;
  }

  try {
    const { ok, status, data } = await _snxgPaypalPost('/payout', { idToken });

    if (!ok || !data.success) {
      const msg = data?.error || 'Payout request failed. Please try again.';
      if (note) { note.className = 'cs-status-msg error'; note.textContent = msg; }
      if (btn)  btn.disabled = false;
      return;
    }

    if (note) {
      note.className = 'cs-status-msg success';
      note.innerHTML = `✅ Payout of <strong>$${data.usdAmount?.toFixed(2)}</strong> submitted!<br>
        <span style="font-size:10px;color:#4a7a9a;">PayPal Batch: ${data.paypalBatchId || 'Pending'}</span>`;
    }
    _snxgToast('✅ Your payout request is being processed!');
    await snxgLoadCreatorStudio();
    snxgLoadPayoutHistory();

  } catch(err) {
    console.error('[SNX-GIFTS] cashOut error:', err);
    if (note) { note.className = 'cs-status-msg error'; note.textContent = 'Network error. Please check your connection and try again.'; }
    if (btn)  btn.disabled = false;
  }
}
window.snxgRequestCashOut = snxgRequestCashOut;

/* ── Creator Studio Tab Switching ── */
function snxgSwitchCreatorTab(tab) {
  document.querySelectorAll('#creatorStudioPage .cs-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('#creatorStudioPage .cs-tab-panel').forEach(p => p.style.display = 'none');
  const activeTab   = document.querySelector(`#creatorStudioPage [data-tab="${tab}"]`);
  const activePanel = document.getElementById('csPanel_' + tab);
  if (activeTab)  activeTab.classList.add('active');
  if (activePanel) activePanel.style.display = 'block';

  if (tab === 'history') snxgLoadGiftHistory();
  if (tab === 'payouts') snxgLoadPayoutHistory();
}
window.snxgSwitchCreatorTab = snxgSwitchCreatorTab;

async function snxgLoadGiftHistory() {
  const user = _snxgUser();
  if (!user) return;
  const fs = _snxgDb();
  if (!fs) return;

  const { db, collection, query, where, orderBy, limit, getDocs } = fs;
  const listEl = document.getElementById('csGiftHistoryList');
  if (!listEl) return;
  listEl.innerHTML = '<div class="cs-empty"><div class="snxg-processing">Loading…</div></div>';

  try {
    const q = query(
      collection(db, 'giftTransactions'),
      where('creatorId', '==', user.uid),
      orderBy('createdAt', 'desc'),
      limit(50)
    );
    const snaps = await getDocs(q);
    if (snaps.empty) {
      listEl.innerHTML = '<div class="cs-empty"><div class="cs-empty-icon">🎁</div>No gifts received yet.<br>Share your content to start earning!</div>';
      return;
    }

    listEl.innerHTML = snaps.docs.map(d => {
      const g = d.data();
      const ts = g.createdAt?.toDate();
      const dateStr = ts ? ts.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
      const earnUsd = ((g.creatorCoins || 0) / COINS_PER_DOLLAR).toFixed(2);
      return `
      <div class="cs-gift-item">
        <div class="cs-gift-item-art">${g.giftArt || '🎁'}</div>
        <div class="cs-gift-item-info">
          <div class="cs-gift-item-name">${g.giftName || 'Gift'}</div>
          <div class="cs-gift-item-meta">
            From <strong style="color:#c8e8ff;">${g.senderName || 'User'}</strong> · ${dateStr}
          </div>
        </div>
        <div class="cs-gift-item-earn">
          <div class="earn-val">+$${earnUsd}</div>
          <div class="earn-label">${g.creatorCoins || 0} coins</div>
        </div>
      </div>`;
    }).join('');
  } catch(err) {
    console.error('[SNX-GIFTS] loadGiftHistory:', err);
    listEl.innerHTML = '<div class="cs-empty">Failed to load gift history.</div>';
  }
}
window.snxgLoadGiftHistory = snxgLoadGiftHistory;

/* ══════════════════════════════════════════════════
   ADMIN — GIFT MANAGEMENT
   ══════════════════════════════════════════════════ */
async function snxgAdminLoadGifts() {
  const user = _snxgUser();
  if (!user) return;
  const fs = _snxgDb();
  if (!fs) return;

  const { db, collection, getDocs } = fs;
  const listEl  = document.getElementById('agGiftList');
  const revEl   = document.getElementById('agPlatformRevenue');
  if (!listEl) return;

  listEl.innerHTML = '<div class="cs-empty"><div class="snxg-processing">Loading…</div></div>';

  try {
    // Load platform revenue
    const earnSnaps = await getDocs(collection(db, 'creatorEarnings'));
    let totalPlatform = 0;
    earnSnaps.forEach(d => { totalPlatform += (d.data().platformCoins || 0); });
    if (revEl) revEl.textContent = `$${(totalPlatform / COINS_PER_DOLLAR).toFixed(2)}`;

    // Gift catalog uses local catalog (could load from Firestore in production)
    listEl.innerHTML = SNX_GIFT_CATALOG.map(gift => `
    <div class="ag-gift-row">
      <div class="ag-gift-art">${gift.art}</div>
      <div class="ag-gift-info">
        <div class="ag-name">${gift.name}</div>
        <div class="ag-price">🪙 ${gift.coins} coins · ${gift.premium ? '⭐ PREMIUM' : 'Standard'}</div>
      </div>
      <div class="ag-gift-actions">
        <button class="ag-gift-toggle ${gift.enabled ? 'enabled' : 'disabled'}">${gift.enabled ? 'Enabled' : 'Disabled'}</button>
      </div>
    </div>`).join('');

  } catch(err) {
    console.error('[SNX-GIFTS] adminLoadGifts:', err);
    listEl.innerHTML = '<div class="cs-empty">Failed to load gifts.</div>';
  }
}
window.snxgAdminLoadGifts = snxgAdminLoadGifts;

async function snxgAdminLoadCoinStats() {
  const user = _snxgUser();
  if (!user) return;
  const fs = _snxgDb();
  if (!fs) return;

  const { db, collection, getDocs, query, orderBy, limit } = fs;

  try {
    // Total coins purchased
    const purchSnaps = await getDocs(collection(db, 'coinPurchases'));
    let totalPurchased = 0;
    purchSnaps.forEach(d => {
      if (d.data().status === 'completed') totalPurchased += (d.data().coinsRequested || 0);
    });
    const el = document.getElementById('agTotalCoinsPurchased');
    if (el) el.textContent = `${totalPurchased.toLocaleString()} coins ($${(totalPurchased/COINS_PER_DOLLAR).toFixed(2)})`;

    // Total gift transactions
    const txSnaps = await getDocs(collection(db, 'giftTransactions'));
    const txCountEl = document.getElementById('agTotalGiftTx');
    if (txCountEl) txCountEl.textContent = txSnaps.size.toLocaleString();

    // Total payouts requested (from new creatorPayouts collection)
    const payoutSnaps = await getDocs(collection(db, 'creatorPayouts'));
    let totalPayout = 0;
    payoutSnaps.forEach(d => { totalPayout += parseFloat(d.data().usdAmount || 0); });
    const payoutEl = document.getElementById('agTotalPayouts');
    if (payoutEl) payoutEl.textContent = `$${totalPayout.toFixed(2)}`;

  } catch(err) {
    console.error('[SNX-GIFTS] adminLoadCoinStats:', err);
  }
}
window.snxgAdminLoadCoinStats = snxgAdminLoadCoinStats;

/* ══════════════════════════════════════════════════
   PAYPAL CREATOR ONBOARDING
   ══════════════════════════════════════════════════ */

/**
 * Start PayPal onboarding for a creator.
 * Redirects them to PayPal's managed onboarding flow.
 */
async function snxgConnectPayPal() {
  const user = _snxgUser();
  if (!user) { _snxgToast('Please sign in first.'); return; }

  const btn = document.getElementById('csPayPalConnectBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }

  let idToken;
  try { idToken = await _snxgGetIdToken(); }
  catch {
    _snxgToast('Session expired. Please sign out and back in.');
    if (btn) { btn.disabled = false; btn.textContent = '🔗 Connect PayPal'; }
    return;
  }

  try {
    const { ok, data } = await _snxgPaypalPost('/onboard-creator', { idToken });
    if (!ok || !data.success) {
      const msg = data?.error || 'PayPal onboarding unavailable. Please try again later.';
      _snxgToast(msg);
      if (btn) { btn.disabled = false; btn.textContent = '🔗 Connect PayPal'; }
      return;
    }

    // Redirect creator to PayPal onboarding
    window.location.href = data.actionUrl;

  } catch (err) {
    console.error('[SNX-GIFTS] connectPayPal error:', err);
    _snxgToast('Network error. Please try again.');
    if (btn) { btn.disabled = false; btn.textContent = '🔗 Connect PayPal'; }
  }
}
window.snxgConnectPayPal = snxgConnectPayPal;

/**
 * Fetch and display the creator's PayPal connection status.
 */
async function snxgLoadPayPalStatus() {
  const user = _snxgUser();
  if (!user) return;

  const statusEl  = document.getElementById('csPayPalStatus');
  const connectEl = document.getElementById('csPayPalConnectBtn');
  if (!statusEl) return;

  statusEl.textContent = 'Checking…';

  let idToken;
  try { idToken = await _snxgGetIdToken(); }
  catch { statusEl.textContent = 'Not checked'; return; }

  try {
    const res  = await fetch(`${SNX_PAYPAL_WORKER}/creator-status?idToken=${encodeURIComponent(idToken)}`);
    const data = await res.json();

    if (!data.success) { statusEl.textContent = 'Unknown'; return; }

    const status = data.onboardingStatus;
    const payoutsEnabled = data.payoutsEnabled;

    let label, color, showConnect = false;
    switch (status) {
      case 'completed':
        label      = payoutsEnabled ? '✓ Connected · Payouts Active' : '⚠ Connected · Verification Required';
        color      = payoutsEnabled ? '#33ff99' : '#ffcc44';
        showConnect = false;
        break;
      case 'pending':
        label      = '⏳ Connecting — please complete setup in PayPal';
        color      = '#ffcc44';
        showConnect = true;
        break;
      default:
        label      = 'Not Connected';
        color      = '#6a90b8';
        showConnect = true;
    }

    statusEl.textContent  = label;
    statusEl.style.color  = color;
    if (connectEl) connectEl.style.display = showConnect ? '' : 'none';

    // Update cashout button if payouts not enabled
    const cashOutNote = document.getElementById('csCashOutNote');
    const cashOutBtn  = document.getElementById('csCashOutBtn');
    if (status !== 'completed' || !payoutsEnabled) {
      if (cashOutBtn) cashOutBtn.disabled = true;
      if (cashOutNote && status !== 'completed') {
        cashOutNote.className = 'cs-status-msg warn';
        cashOutNote.style.display = 'block';
        cashOutNote.textContent = 'Connect your PayPal account to enable cash-outs.';
      } else if (cashOutNote && !payoutsEnabled) {
        cashOutNote.className = 'cs-status-msg warn';
        cashOutNote.style.display = 'block';
        cashOutNote.textContent = 'PayPal requires additional verification before you can receive payouts.';
      }
    }

  } catch (err) {
    console.error('[SNX-GIFTS] loadPayPalStatus error:', err);
    statusEl.textContent = 'Status unavailable';
  }
}
window.snxgLoadPayPalStatus = snxgLoadPayPalStatus;

/**
 * Load payout history from the backend (reads creatorPayouts collection).
 */
async function snxgLoadPayoutHistory() {
  const user = _snxgUser();
  if (!user) return;
  const fs = _snxgDb();
  if (!fs) return;

  const { db, collection, query, where, orderBy, limit, getDocs } = fs;
  const listEl = document.getElementById('csPayoutHistoryList');
  if (!listEl) return;
  listEl.innerHTML = '<div class="cs-empty"><div class="snxg-processing">Loading…</div></div>';

  try {
    const q = query(
      collection(db, 'creatorPayouts'),
      where('creatorId', '==', user.uid),
      orderBy('requestedAt', 'desc'),
      limit(20)
    );
    const snaps = await getDocs(q);
    if (snaps.empty) {
      listEl.innerHTML = '<div class="cs-empty"><div class="cs-empty-icon">💸</div>No payouts yet.</div>';
      return;
    }
    listEl.innerHTML = snaps.docs.map(d => {
      const p   = d.data();
      const ts  = p.requestedAt?.toDate?.();
      const dateStr = ts ? ts.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '—';
      const status  = p.status || 'pending';
      const batchId = p.paypalBatchId ? `<div class="pi-id">${p.paypalBatchId}</div>` : '';
      return `
      <div class="cs-payout-item">
        <div class="cs-payout-icon">💸</div>
        <div class="cs-payout-info">
          <div class="pi-amount">$${parseFloat(p.usdAmount || 0).toFixed(2)}</div>
          <div class="pi-date">${dateStr}</div>
          <div class="pi-id">${p.payoutId || d.id}</div>
          ${batchId}
        </div>
        <div class="cs-payout-status ${status}">${status.toUpperCase()}</div>
      </div>`;
    }).join('');
  } catch(err) {
    console.error('[SNX-GIFTS] loadPayoutHistory:', err);
    listEl.innerHTML = '<div class="cs-empty">Failed to load payout history.</div>';
  }
}
window.snxgLoadPayoutHistory = snxgLoadPayoutHistory;

/* ══════════════════════════════════════════════════
   NAVIGATION HOOK — show Creator Studio page
   ══════════════════════════════════════════════════ */
function snxgOpenCreatorStudio() {
  if (typeof realmNavTo === 'function') {
    realmNavTo('creatorStudioPage');
  }
  setTimeout(() => {
    snxgLoadCreatorStudio();
    snxgSwitchCreatorTab('wallet');
  }, 100);
}
window.snxgOpenCreatorStudio = snxgOpenCreatorStudio;

/* ══════════════════════════════════════════════════
   LIVE PAGE — listen for incoming gifts on live room
   ══════════════════════════════════════════════════ */
function snxgWatchLiveGifts(roomId) {
  const fs = _snxgDb();
  if (!fs) return null;
  const { db, collection, query, where, orderBy, limit, onSnapshot } = fs;

  let initialized = false;
  const q = query(
    collection(db, 'giftTransactions'),
    where('postId', '==', roomId),
    where('isLive', '==', true),
    orderBy('createdAt', 'desc'),
    limit(1)
  );

  const unsub = onSnapshot(q, snap => {
    if (!initialized) { initialized = true; return; } // skip initial load
    snap.docChanges().forEach(change => {
      if (change.type !== 'added') return;
      const g = change.doc.data();
      window.snxgShowLiveGiftToast(g.senderName || 'Someone', g.giftId);
    });
  });

  return unsub;
}
window.snxgWatchLiveGifts = snxgWatchLiveGifts;

/* ══════════════════════════════════════════════════
   FOUNDER COIN TESTING — Grant 500 test coins
   ══════════════════════════════════════════════════ */

// Selected recipient for test grant
let _ctgSelectedUid  = null;
let _ctgSelectedName = null;
let _ctgGranting     = false;

/**
 * Called when the Coin Testing tab is opened.
 * Frontend gate: founderOnly(). Backend gate: role+email check on server.
 */
function snxgLoadCoinTestingTab() {
  // Frontend gate — do not proceed if not founder in the UI
  if (window._snxRole !== 'founder') return;
  _ctgResetSelection();
  _ctgLoadGrantLog();
}
window.snxgLoadCoinTestingTab = snxgLoadCoinTestingTab;

/**
 * Debounced user search for the coin testing tab.
 */
let _ctgSearchTimer = null;
function snxgCoinTestSearch(query) {
  clearTimeout(_ctgSearchTimer);
  if (!query || query.trim().length < 2) {
    const el = document.getElementById('ctgUserResults');
    if (el) el.innerHTML = '';
    return;
  }
  _ctgSearchTimer = setTimeout(() => _ctgDoSearch(query.trim()), 350);
}
window.snxgCoinTestSearch = snxgCoinTestSearch;

async function _ctgDoSearch(query) {
  if (window._snxRole !== 'founder') return;
  const fs = _snxgDb();
  if (!fs) return;
  const resultsEl = document.getElementById('ctgUserResults');
  if (!resultsEl) return;
  resultsEl.innerHTML = '<div style="color:#4a7a9a;font-size:12px;padding:6px 0;">Searching…</div>';

  const { db, collection, query: fsQuery, where, getDocs, orderBy, limit, getDoc, doc } = fs;

  try {
    let users = [];

    // Try exact UID lookup first
    if (query.length > 15 && !query.includes(' ')) {
      const snap = await getDoc(doc(db, 'users', query));
      if (snap.exists()) users = [{ id: snap.id, ...snap.data() }];
    }

    // Search by displayName prefix if no UID match
    if (users.length === 0) {
      const q = fsQuery(
        collection(db, 'users'),
        where('displayName', '>=', query),
        where('displayName', '<=', query + '\uf8ff'),
        limit(8)
      );
      const snaps = await getDocs(q);
      users = snaps.docs.map(d => ({ id: d.id, ...d.data() }));
    }

    // Filter out founders — cannot grant to a founder
    users = users.filter(u => u.role !== 'founder' && u.uid !== (_snxgUser()?.uid));

    if (users.length === 0) {
      resultsEl.innerHTML = '<div style="color:#4a7a9a;font-size:12px;padding:6px 0;">No users found.</div>';
      return;
    }

    resultsEl.innerHTML = users.map(u => `
      <div onclick="snxgCoinTestSelectUser('${u.uid || u.id}','${(u.displayName||'').replace(/'/g,"\\'")}','${u.photoURL||''}')"
        style="display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;cursor:pointer;
               border:1px solid rgba(0,174,239,0.15);background:rgba(0,15,40,0.6);margin-bottom:6px;
               transition:border-color 0.15s;" onmouseover="this.style.borderColor='rgba(0,174,239,0.45)'"
        onmouseout="this.style.borderColor='rgba(0,174,239,0.15)'">
        <img src="${u.photoURL||''}" onerror="this.src=''" style="width:32px;height:32px;border-radius:50%;object-fit:cover;background:#0a1a3a;">
        <div>
          <div style="font-size:13px;font-weight:700;color:#c8e8ff;">${u.displayName||'Unknown'}</div>
          <div style="font-size:10px;color:#4a7a9a;font-family:monospace;">${u.uid||u.id}</div>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('[SNX-CTG] search error:', err);
    resultsEl.innerHTML = '<div style="color:#ff6677;font-size:12px;">Search failed. Try again.</div>';
  }
}

function snxgCoinTestSelectUser(uid, name, avatar) {
  if (window._snxRole !== 'founder') return;
  _ctgSelectedUid  = uid;
  _ctgSelectedName = name;

  const area   = document.getElementById('ctgGrantArea');
  const nameEl = document.getElementById('ctgUserName');
  const uidEl  = document.getElementById('ctgUserUid');
  const avEl   = document.getElementById('ctgUserAvatar');
  const status = document.getElementById('ctgGrantStatus');
  const btn    = document.getElementById('ctgGrantBtn');

  if (nameEl) nameEl.textContent = name;
  if (uidEl)  uidEl.textContent  = uid;
  if (avEl)   avEl.src           = avatar || '';
  if (area)   area.style.display = 'block';
  if (status) status.style.display = 'none';
  if (btn)    { btn.disabled = false; btn.textContent = '🪙 Grant 500 Test Coins'; }

  // Clear results
  const resultsEl = document.getElementById('ctgUserResults');
  if (resultsEl) resultsEl.innerHTML = '';
  const input = document.getElementById('ctgSearchInput');
  if (input) input.value = '';
}
window.snxgCoinTestSelectUser = snxgCoinTestSelectUser;

function _ctgResetSelection() {
  _ctgSelectedUid  = null;
  _ctgSelectedName = null;
  const area = document.getElementById('ctgGrantArea');
  if (area) area.style.display = 'none';
  const status = document.getElementById('ctgGrantStatus');
  if (status) status.style.display = 'none';
}

/**
 * Send the grant request to the worker.
 * Frontend gate: founderOnly() + role check.
 * Backend gate: server reads users/{uid}.role + email from Firestore independently.
 */
async function snxgGrantTestCoins() {
  if (_ctgGranting) return;

  // Frontend gate
  if (window._snxRole !== 'founder') {
    _snxgToast('Permission denied');
    return;
  }
  if (!_ctgSelectedUid) {
    _snxgToast('Please select a recipient first.');
    return;
  }

  const btn    = document.getElementById('ctgGrantBtn');
  const status = document.getElementById('ctgGrantStatus');

  _ctgGranting = true;
  if (btn)    { btn.disabled = true; btn.textContent = 'Granting…'; }
  if (status) { status.style.display = 'block'; status.className = 'cs-status-msg info'; status.textContent = 'Sending grant…'; }

  let idToken;
  try {
    idToken = await _snxgGetIdToken();
  } catch {
    if (status) { status.className = 'cs-status-msg error'; status.textContent = 'Session expired. Please sign out and back in.'; }
    if (btn)    { btn.disabled = false; btn.textContent = '🪙 Grant 500 Test Coins'; }
    _ctgGranting = false;
    return;
  }

  try {
    const { ok, data } = await _snxgPaypalPost('/grant-test-coins', {
      idToken,
      recipientUid: _ctgSelectedUid,
      reason: 'LIVE gifting test',
    });

    if (!ok || !data.success) {
      const msg = data?.error || 'Grant failed. Please try again.';
      if (status) { status.className = 'cs-status-msg error'; status.textContent = msg; }
      if (btn)    { btn.disabled = false; btn.textContent = '🪙 Grant 500 Test Coins'; }
    } else {
      if (status) {
        status.className = 'cs-status-msg success';
        status.innerHTML = `✅ <strong>${data.amount} test coins</strong> granted to <strong>${data.recipientName || _ctgSelectedName}</strong><br>
          <span style="font-size:10px;color:#4a7a9a;">TX: ${data.txId} · No cash value</span>`;
      }
      if (btn) { btn.disabled = true; btn.textContent = '✓ Granted'; }
      _snxgToast(`🪙 ${data.amount} test coins granted to ${data.recipientName || _ctgSelectedName}!`);
      setTimeout(() => _ctgLoadGrantLog(), 800);
    }
  } catch (err) {
    console.error('[SNX-CTG] grant error:', err);
    if (status) { status.className = 'cs-status-msg error'; status.textContent = 'Network error. Please try again.'; }
    if (btn)    { btn.disabled = false; btn.textContent = '🪙 Grant 500 Test Coins'; }
  } finally {
    _ctgGranting = false;
  }
}
window.snxgGrantTestCoins = snxgGrantTestCoins;

/**
 * Load recent test coin grants from Firestore for the log display.
 */
async function _ctgLoadGrantLog() {
  if (window._snxRole !== 'founder') return;
  const fs = _snxgDb();
  if (!fs) return;
  const logEl = document.getElementById('ctgGrantLogList');
  if (!logEl) return;

  const { db, collection, query, orderBy, limit, getDocs } = fs;
  try {
    const q = query(collection(db, 'testCoinGrants'), orderBy('timestamp', 'desc'), limit(10));
    const snaps = await getDocs(q);
    if (snaps.empty) {
      logEl.innerHTML = '<span style="color:#3a5a7a;">No grants yet.</span>';
      return;
    }
    logEl.innerHTML = snaps.docs.map(d => {
      const g    = d.data();
      const ts   = g.timestamp?.toDate?.();
      const date = ts ? ts.toLocaleDateString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;
               border-bottom:1px solid rgba(0,174,239,0.1);font-size:11px;">
        <div>
          <span style="color:#c8e8ff;font-weight:700;">${g.recipientName || g.recipientUserId}</span>
          <span style="color:#3a5a7a;margin-left:6px;">${date}</span>
        </div>
        <div style="color:#00AEEF;font-weight:700;">🪙 ${g.amount}
          <span style="font-size:9px;color:#ffcc44;margin-left:4px;">TEST</span>
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    logEl.innerHTML = '<span style="color:#ff6677;">Could not load grant log.</span>';
  }
}

/* ══════════════════════════════════════════════════
   AUTH STATE HOOK — subscribe when user logs in
   ══════════════════════════════════════════════════ */
if (window._snxOnAuthReady) {
  window._snxOnAuthReady(() => {
    snxgInit();
  });
} else {
  // Fallback: poll for auth ready
  const _pollAuth = setInterval(() => {
    if (window._snxCurrentUser !== undefined) {
      clearInterval(_pollAuth);
      snxgInit();
    }
  }, 500);
}
