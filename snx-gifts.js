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

// PayPal Worker base URL — yellow-term-11e6 handles all PayPal and coin routes.
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
  { id: 'black_cat',         name: 'Black Cat',         art: '🐱',   coins: 10,   premium: false, enabled: true },
  { id: 'shadow_lightning',  name: 'Shadow Lightning',  art: '⚡',   coins: 25,   premium: false, enabled: true },
  { id: 'blue_flame',        name: 'Blue Flame',        art: '🔵🔥',  coins: 50,   premium: false, enabled: true },
  { id: 'wolf',              name: 'Wolf',              art: '🐺',   coins: 100,  premium: false, enabled: true },
  { id: 'grim_reaper',       name: 'Grim Reaper',       art: '💀',   coins: 200,  premium: true,  enabled: true },
  { id: 'stay_legendary',    name: 'STAY LEGENDARY',    art: '🌑',   coins: 300,  premium: true,  enabled: true },
  // ── Premium Animated Gifts (750–5000 coins) ──────────────────────────────
  { id: 'shadow_eclipse',    name: 'Shadow Eclipse',    art: '🌑',   coins: 750,  premium: true,  enabled: true },
  { id: 'nexus_lightning',   name: 'Nexus Lightning',   art: '⚡',   coins: 1000, premium: true,  enabled: true },
  { id: 'shadow_inferno',    name: 'Shadow Inferno',    art: '🔥',   coins: 1250, premium: true,  enabled: true },
  { id: 'legendary_crown',   name: 'Legendary Crown',   art: '👑',   coins: 1500, premium: true,  enabled: true },
  { id: 'shadow_cat',        name: 'Shadow Cat',        art: '🐈‍⬛',  coins: 1750, premium: true,  enabled: true },
  { id: 'shadow_dragon',     name: 'Shadow Dragon',     art: '🐉',   coins: 2000, premium: true,  enabled: true },
  { id: 'nexus_diamond',     name: 'Nexus Diamond',     art: '💎',   coins: 2500, premium: true,  enabled: true },
  { id: 'galaxy_portal',     name: 'Galaxy Portal',     art: '🌌',   coins: 3000, premium: true,  enabled: true },
  { id: 'reapers_gift',      name: "Reaper's Gift",     art: '☠️',   coins: 3500, premium: true,  enabled: true },
  { id: 'shadow_wolf',       name: 'Shadow Wolf',       art: '🐺',   coins: 4000, premium: true,  enabled: true },
  { id: 'eclipse_nexus',     name: 'Eclipse Nexus',     art: '🌑⚡',  coins: 5000, premium: true,  enabled: true },
  { id: 'legendary_lion',    name: 'Legendary Lion',    art: '🦁',   coins: 2250, premium: true,  enabled: true },
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
  console.log('[SHADOW COINS] snxgInit — auth.currentUser:', user ? user.uid : 'null/undefined');
  if (!user) {
    console.warn('[SHADOW COINS] snxgInit: no authenticated user — skipping wallet subscription');
    return;
  }
  const fs = _snxgDb();
  console.log('[SHADOW COINS] snxgInit — _snxFirestore defined:', fs !== null);
  _snxgSubscribeWallet(user.uid);
  _snxgRenderCoinPill();
  // Patch in-memory catalog prices from Firestore so the gift tray
  // always shows the current Founder-set prices.
  snxgLoadCatalogPrices();
}
window.snxgInit = snxgInit;

/* ══════════════════════════════════════════════════
   CATALOG PRICE SYNC — patches SNX_GIFT_CATALOG
   with current Firestore prices so the gift tray
   always reflects Founder price edits.
   ══════════════════════════════════════════════════ */
async function snxgLoadCatalogPrices() {
  const fs = _snxgDb();
  if (!fs) return;
  const { db, collection, getDocs } = fs;
  try {
    const snaps = await getDocs(collection(db, 'giftCatalog'));
    snaps.forEach(d => {
      const data  = d.data();
      const price = typeof data.coins === 'number' ? data.coins
                  : typeof data.coinPrice === 'number' ? data.coinPrice
                  : null;
      if (price !== null && price > 0) {
        const local = SNX_GIFT_CATALOG.find(g => g.id === d.id);
        if (local) local.coins = price;
      }
    });
    // Re-render affordability after prices may have changed
    _snxgRefreshGiftAffordability();
  } catch (_) {
    // Non-fatal — tray falls back to local defaults
  }
}
window.snxgLoadCatalogPrices = snxgLoadCatalogPrices;

/* ══════════════════════════════════════════════════
   WALLET SUBSCRIPTION — real-time coin balance
   ══════════════════════════════════════════════════ */
function _snxgSubscribeWallet(uid) {
  const fs = _snxgDb();
  if (!fs) {
    console.error('[SHADOW COINS] _snxgSubscribeWallet: window._snxFirestore is null — retrying in 1 s');
    // Retry once Firebase has had a chance to initialise
    setTimeout(() => _snxgSubscribeWallet(uid), 1000);
    return;
  }
  const { db, doc, getDoc, onSnapshot } = fs;

  if (_snxgWalletUnsub) { try { _snxgWalletUnsub(); } catch(_) {} }

  const walletPath = `wallets/${uid}`;
  console.log('[SHADOW COINS] Auth UID:', uid);
  console.log('[SHADOW COINS] Firebase path:', walletPath);

  // Helper shared by snapshot callback and getDoc fallback
  function _applyBalance(data) {
    data = data || {};
    // Always coerce to a finite non-negative integer so the nav polling
    // (_updateAllCoinDisplays) passes typeof === 'number' check.
    const raw = data.shadowCoins;
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    _snxgCoinBalance = (Number.isFinite(parsed) && parsed >= 0) ? Math.floor(parsed) : 0;
    console.log('[SHADOW COINS] Balance value (assigned):', _snxgCoinBalance);
    window._snxgCoinBalance = _snxgCoinBalance; // expose to non-module polling in index.html
    _snxgRenderCoinPill();
    _snxgRefreshGiftAffordability();
    // Sync all nav coin displays — always force-update so any DOM reset is corrected
    if (typeof window._snxgSyncNavCoins === 'function') {
      window._snxgSyncNavCoins(_snxgCoinBalance);
    }
  }

  const walletRef = doc(db, 'wallets', uid);
  _snxgWalletUnsub = onSnapshot(walletRef, snap => {
    const exists = snap.exists();
    const data   = exists ? snap.data() : {};
    console.log('[SHADOW COINS] Document exists:', exists);
    console.log('[SHADOW COINS] Document data:', JSON.stringify(data));
    console.log('[SHADOW COINS] Balance field (shadowCoins):', data.shadowCoins);
    _applyBalance(data);
  }, err => {
    console.error('[SHADOW COINS] Firebase error:', err.code, err.message);
    // Real-time subscription failed — fall back to a one-time getDoc so the
    // balance is still displayed even if onSnapshot cannot maintain a listener.
    getDoc(doc(db, 'wallets', uid)).then(snap => {
      console.log('[SHADOW COINS] getDoc fallback — document exists:', snap.exists());
      _applyBalance(snap.exists() ? snap.data() : {});
      // Retry the live subscription after a short delay so real-time updates
      // resume as soon as connectivity / permissions are restored.
      setTimeout(() => _snxgSubscribeWallet(uid), 5000);
    }).catch(e => {
      console.error('[SHADOW COINS] getDoc fallback also failed:', e.message);
    });
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
  // Always reset the send button when the tray closes so it is ready for the next open.
  const sendBtn = document.getElementById('giftConfirmSend');
  if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send 🎁'; }
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
  if (gift.id === 'stay_legendary')  return `<span style="filter:drop-shadow(0 0 8px rgba(0,174,239,0.9));">${gift.art}</span>`;
  if (gift.id === 'grim_reaper')     return `<span style="filter:drop-shadow(0 0 6px rgba(80,0,200,0.7));">${gift.art}</span>`;
  if (gift.id === 'wolf')            return `<span style="filter:drop-shadow(0 0 5px rgba(0,174,239,0.6));">${gift.art}</span>`;
  if (gift.id === 'shadow_eclipse')  return `<span style="filter:drop-shadow(0 0 10px rgba(80,0,160,0.9)) drop-shadow(0 0 20px rgba(0,0,0,0.8));">${gift.art}</span>`;
  if (gift.id === 'nexus_lightning') return `<span style="filter:drop-shadow(0 0 12px rgba(0,200,255,1)) drop-shadow(0 0 24px rgba(0,120,255,0.8));">${gift.art}</span>`;
  if (gift.id === 'shadow_inferno')  return `<span style="filter:drop-shadow(0 0 12px rgba(255,80,0,0.9)) drop-shadow(0 0 22px rgba(180,0,0,0.7));">${gift.art}</span>`;
  if (gift.id === 'legendary_crown') return `<span style="filter:drop-shadow(0 0 14px rgba(255,200,0,1)) drop-shadow(0 0 30px rgba(200,100,0,0.8));">${gift.art}</span>`;
  if (gift.id === 'shadow_dragon')   return `<span style="filter:drop-shadow(0 0 12px rgba(100,0,200,0.9)) drop-shadow(0 0 24px rgba(40,0,80,0.8));">${gift.art}</span>`;
  if (gift.id === 'nexus_diamond')   return `<span style="filter:drop-shadow(0 0 14px rgba(0,230,255,1)) drop-shadow(0 0 28px rgba(80,0,255,0.7));">${gift.art}</span>`;
  if (gift.id === 'galaxy_portal')   return `<span style="filter:drop-shadow(0 0 14px rgba(120,0,255,0.9)) drop-shadow(0 0 30px rgba(0,80,200,0.7));">${gift.art}</span>`;
  if (gift.id === 'reapers_gift')    return `<span style="filter:drop-shadow(0 0 12px rgba(0,200,0,0.8)) drop-shadow(0 0 24px rgba(0,60,0,0.9));">${gift.art}</span>`;
  if (gift.id === 'shadow_wolf')     return `<span style="filter:drop-shadow(0 0 12px rgba(0,174,239,0.8)) drop-shadow(0 0 24px rgba(0,40,100,0.7));">${gift.art}</span>`;
  if (gift.id === 'shadow_cat')      return `<span style="filter:drop-shadow(0 0 12px rgba(0,180,255,1)) drop-shadow(0 0 26px rgba(0,0,80,0.9));">${gift.art}</span>`;
  if (gift.id === 'eclipse_nexus')   return `<span style="filter:drop-shadow(0 0 16px rgba(0,200,255,1)) drop-shadow(0 0 36px rgba(80,0,200,0.9)) drop-shadow(0 0 60px rgba(0,100,255,0.6));">${gift.art}</span>`;
  if (gift.id === 'legendary_lion')  return `<span style="filter:drop-shadow(0 0 14px rgba(255,160,0,0.95)) drop-shadow(0 0 28px rgba(200,80,0,0.75));">${gift.art}</span>`;
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
  // Also reset the send button so it is never left in a stuck disabled state.
  const sendBtn = document.getElementById('giftConfirmSend');
  if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send 🎁'; }
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

  const txId              = _snxgGenTxId();
  const senderWalletRef   = doc(db, 'wallets',         senderId);
  const recipientWalletRef = doc(db, 'wallets',        creatorId);  // recipient's spendable balance
  const creatorEarnRef    = doc(db, 'creatorEarnings', creatorId);
  const recipientXPRef    = doc(db, 'shadowXP',        creatorId);  // recipient's Social Credit
  // Use txId as the document ID — this makes the transaction idempotent.
  // If the same txId is committed twice (network retry), Firestore will
  // reject the second write on the giftTxRef with 'already-exists', but
  // since the wallet deduction already happened, the retry loop will fail
  // at the balance check (insufficient_coins).  The client _snxgSending lock
  // prevents double-clicks within the same tab; txId uniqueness protects
  // against multi-tab or network-retry duplicates.
  const giftTxRef         = doc(db, 'giftTransactions', txId);

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

      // ── READ 3: recipient wallet (needed to compute new balance before writing) ──
      const recipientWalletSnap = await tx.get(recipientWalletRef);
      const recipientWalletData = recipientWalletSnap.exists() ? recipientWalletSnap.data() : {};
      const recipientCurrentCoins = typeof recipientWalletData.shadowCoins === 'number' ? recipientWalletData.shadowCoins : 0;
      const recipientNewBalance   = recipientCurrentCoins + verifiedCreatorCoins;
      console.log('[GIFT DEBUG] recipient wallet exists:', recipientWalletSnap.exists(), '| current balance:', recipientCurrentCoins, '→', recipientNewBalance);

      // ── READ 4: recipient Shadow XP / Social Credit ────────────────────────
      const recipientXPSnap  = await tx.get(recipientXPRef);
      const recipientXPData  = recipientXPSnap.exists() ? recipientXPSnap.data() : {};
      const recipientCurrentXP = typeof recipientXPData.experience === 'number' ? recipientXPData.experience : 0;
      const recipientNewXP     = recipientCurrentXP + verifiedCoinPrice;  // 1 Social Credit per coin gifted
      console.log('[GIFT DEBUG] recipient XP exists:', recipientXPSnap.exists(), '| current XP:', recipientCurrentXP, '→', recipientNewXP);

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

      // ── WRITE 2: credit creator earnings (monetization ledger) ────────────
      tx.set(creatorEarnRef, {
        uid:            creatorId,
        pendingCoins:   newPending,
        availableCoins: newAvailable,
        lifetimeCoins:  newLifetime,
        platformCoins:  newPlatform,
        lastGiftAt:     serverTimestamp(),
      }, { merge: true });

      // ── WRITE 2b: credit recipient's spendable wallet ─────────────────────
      // This makes gifted coins immediately available in the recipient's Shadow
      // Coin balance (wallets/{uid}.shadowCoins), matching the same field that
      // the test-coin grant and coin-purchase flows credit.
      // Rule: giftCreditOnly — only shadowCoins and lastGiftReceivedAt change,
      //       new shadowCoins > existing shadowCoins (never a deduction).
      if (recipientWalletSnap.exists()) {
        tx.update(recipientWalletRef, {
          shadowCoins:        recipientNewBalance,
          lastGiftReceivedAt: serverTimestamp(),
        });
      } else {
        // Recipient has no wallet yet — create one.
        tx.set(recipientWalletRef, {
          uid:                creatorId,
          shadowCoins:        recipientNewBalance,
          lastGiftReceivedAt: serverTimestamp(),
        });
      }

      // ── WRITE 2c: credit recipient's Shadow Social Credit (Shadow XP) ──────
      // Social Credit = verifiedCoinPrice XP (1 per coin gifted).
      // Rule: only experience and lastGiftXPAt may change; new value > existing.
      if (recipientXPSnap.exists()) {
        tx.update(recipientXPRef, {
          experience:   recipientNewXP,
          lastGiftXPAt: serverTimestamp(),
        });
      } else {
        // Recipient has no XP doc yet — create one at level 1.
        tx.set(recipientXPRef, {
          uid:          creatorId,
          experience:   recipientNewXP,
          level:        1,
          lastGiftXPAt: serverTimestamp(),
        });
      }
      console.log('[GIFT DEBUG] Social Credit write: shadowXP/' + creatorId + '.experience', recipientCurrentXP, '→', recipientNewXP);

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
        transactionType: 'GIFT',
        status:          'completed',
        createdAt:       serverTimestamp(),
      });
    });

    console.log('[GIFT DEBUG] transaction committed ✓');

    // ── Only after commit: update UI ──
    // Restore send button BEFORE closing the tray so it is in a clean state
    // for the next open.  (snxgCloseGiftTray also resets it, but being explicit
    // here prevents any stuck-button state if the tray close path changes later.)
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send 🎁'; }
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
// All gift IDs that use the full-screen premium overlay animation.
// Every gift except stay_legendary (which has its own dedicated system) is listed here.
const _SNX_PREMIUM_ANIM_IDS = new Set([
  // Base gifts (upgraded to premium overlay)
  'black_cat', 'shadow_lightning', 'blue_flame', 'wolf', 'grim_reaper',
  // Original premium animated gifts
  'shadow_eclipse', 'nexus_lightning', 'shadow_inferno', 'legendary_crown',
  'shadow_cat',     'shadow_dragon',   'nexus_diamond',  'galaxy_portal',
  'reapers_gift',   'shadow_wolf',     'eclipse_nexus',
  // New animated gifts
  'legendary_lion',
]);

function _snxgPlayGiftAnimation(gift, senderName) {
  if (gift.id === 'stay_legendary') {
    snxgPlayStayLegendary(senderName);
    return;
  }
  // All other gifts route through the premium overlay system
  _snxgPlayPremiumAnimation(gift, senderName);
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

  // HiDPI / retina fix — render at device pixel resolution for sharp output on mobile
  const dpr = Math.min(window.devicePixelRatio || 1, 2);  // cap at 2× to protect perf
  const lw  = window.innerWidth;
  const lh  = window.innerHeight;
  canvas.width  = Math.round(lw * dpr);
  canvas.height = Math.round(lh * dpr);
  canvas.style.width  = lw + 'px';
  canvas.style.height = lh + 'px';
  ctx.scale(dpr, dpr);

  // Seed particles
  _sloParticles.length = 0;
  for (let i = 0; i < 80; i++) {
    _sloParticles.push({
      x: Math.random() * lw,
      y: Math.random() * lh,
      r: 1 + Math.random() * 3,
      vx: (Math.random() - 0.5) * 1.5,
      vy: -(0.5 + Math.random() * 1.5),
      alpha: 0.4 + Math.random() * 0.6,
      color: Math.random() > 0.4 ? '#00AEEF' : '#3366ff',
    });
  }

  function tick() {
    // use logical dimensions (lw/lh) — ctx is already scaled by dpr
    ctx.clearRect(0, 0, lw, lh);
    for (const p of _sloParticles) {
      p.x += p.vx;
      p.y += p.vy;
      p.alpha -= 0.003;
      if (p.y < -10 || p.alpha <= 0) {
        p.x = Math.random() * lw;
        p.y = lh + 5;
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
  if (canvas) {
    const ctx = canvas.getContext('2d');
    // clear at physical size since we don't have lw/lh here
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}


/* ══════════════════════════════════════════════════
   PREMIUM GIFT ANIMATIONS — full-screen overlays
   ══════════════════════════════════════════════════ */

// Config per gift: { bg, particleColors, title, titleColor, tagline, duration }
const _SNX_PREMIUM_CONFIGS = {

  // ── Base gifts — upgraded to full-screen legendary overlay ──────────────────

  black_cat: {
    bg: 'radial-gradient(ellipse at center, #0a0018 0%, #020008 70%)',
    particleColors: ['#9933ff', '#cc66ff', '#3300aa', '#ffffff', '#00aaff'],
    title: 'BLACK CAT',
    titleColor: 'linear-gradient(90deg, #9933ff, #cc66ff, #00aaff, #9933ff)',
    tagline: '— Nine Lives of Shadow —',
    duration: 5500,
    blackCrows: true,
  },

  shadow_lightning: {
    bg: 'radial-gradient(ellipse at center, #1a1400 0%, #060500 70%)',
    particleColors: ['#ffee00', '#ffcc00', '#ff9900', '#ffffff'],
    title: 'SHADOW LIGHTNING',
    titleColor: 'linear-gradient(90deg, #ffee00, #ffffff, #ffcc00, #ffee00)',
    tagline: '— Strike from the Dark —',
    duration: 4000,
    lightning: true,
  },

  blue_flame: {
    bg: 'radial-gradient(ellipse at center, #001a3a 0%, #000510 70%)',
    particleColors: ['#0088ff', '#00ccff', '#0044cc', '#44aaff', '#ffffff'],
    title: 'BLUE FLAME',
    titleColor: 'linear-gradient(90deg, #0088ff, #00ccff, #44aaff, #0088ff)',
    tagline: '— Burns Coldest —',
    duration: 4500,
    flames: true,
  },

  wolf: {
    bg: 'radial-gradient(ellipse at center, #0a1020 0%, #020508 70%)',
    particleColors: ['#aaccee', '#778899', '#ddeeff', '#ffffff', '#5577aa'],
    title: 'WOLF',
    titleColor: 'linear-gradient(90deg, #aaccee, #ffffff, #778899, #aaccee)',
    tagline: '— Howl at the Moon —',
    duration: 4500,
    wolf: true,
  },

  grim_reaper: {
    bg: 'radial-gradient(ellipse at center, #001800 0%, #000300 70%)',
    particleColors: ['#00dd44', '#009922', '#003300', '#55ff99', '#ffffff'],
    title: 'GRIM REAPER',
    titleColor: 'linear-gradient(90deg, #00dd44, #55ff99, #009922, #00dd44)',
    tagline: '— The Final Gift —',
    duration: 5000,
  },

  // ── Original premium animated gifts ────────────────────────────────────────

  shadow_eclipse: {
    bg: 'radial-gradient(ellipse at center, #1a004a 0%, #05000f 70%)',
    particleColors: ['#6600cc', '#aa44ff', '#330066', '#ffffff'],
    title: 'SHADOW ECLIPSE',
    titleColor: 'linear-gradient(90deg, #aa44ff, #6600cc, #cc88ff, #aa44ff)',
    tagline: '— Dark Energy Unleashed —',
    duration: 5000,
  },
  nexus_lightning: {
    bg: 'radial-gradient(ellipse at center, #001a3a 0%, #000a1a 70%)',
    particleColors: ['#00ccff', '#0088ff', '#44eeff', '#ffffff'],
    title: 'NEXUS LIGHTNING',
    titleColor: 'linear-gradient(90deg, #00ccff, #44eeff, #0088ff, #00ccff)',
    tagline: '— Electric Force —',
    duration: 5000,
    lightning: true,
  },
  shadow_inferno: {
    bg: 'radial-gradient(ellipse at center, #2a0800 0%, #0a0000 70%)',
    particleColors: ['#ff4400', '#ff8800', '#cc2200', '#ffaa00'],
    title: 'SHADOW INFERNO',
    titleColor: 'linear-gradient(90deg, #ff4400, #ff8800, #ffaa00, #ff4400)',
    tagline: '— Consume Everything —',
    duration: 5500,
    flames: true,
  },
  legendary_crown: {
    bg: 'radial-gradient(ellipse at center, #2a1800 0%, #080400 70%)',
    particleColors: ['#ffcc00', '#ffaa00', '#ff8800', '#ffffff'],
    title: 'LEGENDARY CROWN',
    titleColor: 'linear-gradient(90deg, #ffcc00, #ffffff, #ffaa00, #ffcc00)',
    tagline: '— Rarest of the Rare —',
    duration: 6000,
  },
  shadow_cat: {
    bg: 'radial-gradient(ellipse at center, #000a1a 0%, #000005 75%)',
    particleColors: ['#00aaff', '#0044cc', '#001a4a', '#88ccff', '#ffffff'],
    title: 'SHADOW CAT',
    titleColor: 'linear-gradient(90deg, #00aaff, #88ccff, #0066ff, #00aaff)',
    tagline: '— The Darkness Purrs —',
    duration: 7500,
    lightning: true,
    shadowCat: true,
  },
  shadow_dragon: {
    bg: 'radial-gradient(ellipse at center, #1a0040 0%, #060012 70%)',
    particleColors: ['#8800ff', '#cc44ff', '#440088', '#ff88ff'],
    title: 'SHADOW DRAGON',
    titleColor: 'linear-gradient(90deg, #8800ff, #cc44ff, #aa00ff, #8800ff)',
    tagline: '— The Dragon Awakens —',
    duration: 7000,
    dragon: true,
    shadowDragon: true,
  },
  nexus_diamond: {
    bg: 'radial-gradient(ellipse at center, #001830 0%, #000610 70%)',
    particleColors: ['#00eeff', '#88ddff', '#ffffff', '#4488ff'],
    title: 'NEXUS DIAMOND',
    titleColor: 'linear-gradient(90deg, #00eeff, #ffffff, #88ddff, #00eeff)',
    tagline: '— Crystalline Perfection —',
    duration: 5500,
  },
  galaxy_portal: {
    bg: 'radial-gradient(ellipse at center, #0a0030 0%, #020008 70%)',
    particleColors: ['#8844ff', '#4400cc', '#ff44ff', '#aaaaff'],
    title: 'GALAXY PORTAL',
    titleColor: 'linear-gradient(90deg, #8844ff, #ff44ff, #aaaaff, #8844ff)',
    tagline: '— The Universe Opens —',
    duration: 6000,
  },
  reapers_gift: {
    bg: 'radial-gradient(ellipse at center, #001a00 0%, #000400 70%)',
    particleColors: ['#00cc44', '#008822', '#004400', '#44ff88'],
    title: "REAPER'S GIFT",
    titleColor: 'linear-gradient(90deg, #00cc44, #44ff88, #008822, #00cc44)',
    tagline: '— Death Delivers —',
    duration: 5500,
  },
  shadow_wolf: {
    bg: 'radial-gradient(ellipse at center, #001830 0%, #000508 70%)',
    particleColors: ['#00aaff', '#0044cc', '#88ccff', '#ffffff'],
    title: 'SHADOW WOLF',
    titleColor: 'linear-gradient(90deg, #00aaff, #88ccff, #0066ff, #00aaff)',
    tagline: '— The Pack Howls —',
    duration: 7000,
    wolf: true,
    shadowWolf: true,
  },
  eclipse_nexus: {
    bg: 'radial-gradient(ellipse at center, #0a0030 0%, #000008 70%)',
    particleColors: ['#00ccff', '#8800ff', '#ffffff', '#ff44ff', '#ffcc00'],
    title: 'ECLIPSE NEXUS',
    titleColor: 'linear-gradient(90deg, #00ccff, #8800ff, #ffffff, #ff44ff, #00ccff)',
    tagline: '— Ultimate Rarity —',
    duration: 7000,
    lightning: true,
    flames: true,
  },

  legendary_lion: {
    bg: 'linear-gradient(180deg, #1a0e00 0%, #2d1500 30%, #1a0e00 70%, #0a0800 100%)',
    particleColors: ['#c8781e', '#e8a83a', '#f0c050', '#ffffff', '#8b4a00'],
    title: 'LEGENDARY LION',
    titleColor: 'linear-gradient(90deg, #f0c050, #ffffff, #e8a83a, #f0c050)',
    tagline: '— King of the Mountain —',
    duration: 6500,
    legendaryLion: true,
  },
};

// Track active premium RAF per overlay ID to allow cleanup
const _snxPremRafs = {};

function _snxgPlayPremiumAnimation(gift, senderName) {
  const cfg = _SNX_PREMIUM_CONFIGS[gift.id];
  if (!cfg) return;  // fallback safety

  const overlayId = 'snxPremOverlay_' + gift.id;

  // Remove any existing overlay for this gift (e.g. rapid re-send)
  const old = document.getElementById(overlayId);
  if (old) {
    if (_snxPremRafs[overlayId]) { cancelAnimationFrame(_snxPremRafs[overlayId]); delete _snxPremRafs[overlayId]; }
    old.remove();
  }

  // Build overlay DOM
  const overlay = document.createElement('div');
  overlay.id = overlayId;
  overlay.className = 'snxp-overlay';
  overlay.innerHTML = `
    <div class="snxp-bg" style="background:${cfg.bg};"></div>
    <canvas class="snxp-canvas"></canvas>
    <div class="snxp-content">
      <span class="snxp-emblem">${gift.art}</span>
      <span class="snxp-title" style="background:${cfg.titleColor};">${cfg.title}</span>
      <span class="snxp-tagline">${cfg.tagline}</span>
      <div class="snxp-sender">Sent by <strong>${senderName}</strong></div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Trigger open animation on next frame
  requestAnimationFrame(() => overlay.classList.add('active'));

  // Start canvas particle system — HiDPI / retina fix for sharp mobile rendering
  const canvas = overlay.querySelector('.snxp-canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);  // cap at 2× to protect perf
  const lw  = window.innerWidth;
  const lh  = window.innerHeight;
  canvas.width  = Math.round(lw * dpr);
  canvas.height = Math.round(lh * dpr);
  canvas.style.width  = lw + 'px';
  canvas.style.height = lh + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const particles = [];
  const count = window.innerWidth < 500 ? 60 : 100;  // fewer on mobile
  for (let i = 0; i < count; i++) {
    particles.push(_snxpMakeParticle(lw, lh, cfg.particleColors));
  }

  // Extra lightning streaks if configured
  const bolts = [];
  if (cfg.lightning) {
    for (let i = 0; i < 6; i++) {
      bolts.push({ x: Math.random() * lw, y: 0, h: 60 + Math.random() * 150,
                   timer: Math.random() * 60, interval: 10 + Math.floor(Math.random() * 20),
                   color: cfg.particleColors[0] });
    }
  }

  // ── Per-gift animated character state ───────────────────────────────────────
  let _frame = 0;

  // ── SHADOW CAT state ────────────────────────────────────────────────────────
  const _scCrows = [];
  const _scGroundFlames = [];
  let _scCatX = -120;          // cat starts off left edge
  let _scCatPhase = 0;         // 0=run-in, 1=stop+look, 2=jump-flames, 3=run-out, 4=burst
  let _scCatPhaseEnter = 0;    // frame when current phase started
  let _scCatY = 0;             // vertical offset from baseline
  let _scCatVY = 0;
  let _scCatDir = 1;           // 1=right, -1=left
  let _scBurstAlpha = 0;

  if (cfg.shadowCat) {
    const crowCount = window.innerWidth < 500 ? 5 : 8;
    for (let i = 0; i < crowCount; i++) {
      // Each crow has its own elliptical orbit of varying size and speed
      const orbitW = 110 + Math.random() * 90;
      const orbitH = orbitW * (0.3 + Math.random() * 0.25);
      _scCrows.push({
        angle:    (i / crowCount) * Math.PI * 2 + Math.random() * 0.5,
        speed:    (0.018 + Math.random() * 0.016) * (Math.random() > 0.5 ? 1 : -1),
        orbitW, orbitH,
        flap:     Math.random() * Math.PI * 2,
        flapSpd:  0.22 + Math.random() * 0.12,
        size:     13 + Math.random() * 7,
        yOffset:  (Math.random() - 0.5) * 60,  // vertical spread in scene
        zLayer:   Math.random(),                // 0=back, 1=front
      });
    }
    const fCount = window.innerWidth < 500 ? 8 : 14;
    for (let i = 0; i < fCount; i++) {
      _scGroundFlames.push({
        x:     (Math.random() - 0.5) * 340,
        phase: Math.random() * Math.PI * 2,
        h:     28 + Math.random() * 36,
        w:     7  + Math.random() * 9,
        speed: 0.06 + Math.random() * 0.05,
      });
    }
    _scCatY = 0;
  }

  // ── SHADOW WOLF state ───────────────────────────────────────────────────────
  let _wfX = -160;
  let _wfPhase = 0;         // 0=run-in, 1=look, 2=run-through-flames, 3=howl, 4=run-out
  let _wfPhaseEnter = 0;    // frame when current phase started
  let _wfDir = 1;
  const _wfGroundFlames = [];
  const _wfShadowTrail = [];

  if (cfg.wolf || cfg.shadowWolf) {
    const fCount = window.innerWidth < 500 ? 7 : 12;
    for (let i = 0; i < fCount; i++) {
      _wfGroundFlames.push({
        x:     (Math.random() - 0.5) * 380,
        phase: Math.random() * Math.PI * 2,
        h:     22 + Math.random() * 30,
        w:     6  + Math.random() * 8,
        speed: 0.07 + Math.random() * 0.05,
      });
    }
  }

  // ── SHADOW DRAGON state ─────────────────────────────────────────────────────
  let _drX = lw + 200;
  let _drY = 0;
  let _drPhase = 0;         // 0=fly-in, 1=hover+breathe, 2=fly-out
  let _drPhaseEnter = 0;    // frame when current phase started
  let _drDir = -1;          // starts flying left
  let _drBodyWave = 0;
  let _drFireLen = 0;
  let _drWingFlap = 0;

  // ── LEGENDARY LION state ────────────────────────────────────────────────────
  let _llX = -200;             // lion starts off left edge
  let _llY = 0;                // vertical bob offset
  let _llPhase = 0;            // 0=run across, done when off right edge
  const _llDustPuffs = [];     // dust particles under feet

  // Pre-build mountain ridge points (stable per animation)
  const _llMtPts = [];
  if (cfg.legendaryLion) {
    const peakCount = 6;
    for (let i = 0; i < peakCount; i++) {
      _llMtPts.push({
        x:     (i / (peakCount - 1)) * lw,
        peakY: lh * (0.34 + Math.random() * 0.18),
      });
    }
  }

  // ── BLACK CROWS (standalone gift) state ─────────────────────────────────────
  const _bcFlocks = [];
  if (cfg.blackCrows) {
    const flockCount = window.innerWidth < 500 ? 3 : 4;
    for (let f = 0; f < flockCount; f++) {
      const birds = [];
      const flockY  = 80 + f * (lh * 0.18);
      const flockDir = f % 2 === 0 ? 1 : -1;
      const startX   = flockDir > 0 ? -200 : lw + 200;
      const bCount = 3 + Math.floor(Math.random() * 4);
      for (let b = 0; b < bCount; b++) {
        birds.push({
          x:       startX + (Math.random() - 0.5) * 60,
          y:       flockY  + (Math.random() - 0.5) * 40,
          flap:    Math.random() * Math.PI * 2,
          flapSpd: 0.2 + Math.random() * 0.12,
          size:    14 + Math.random() * 8,
          speed:   (1.8 + Math.random() * 1.2) * flockDir,
          waveOff: Math.random() * Math.PI * 2,
        });
      }
      _bcFlocks.push({ birds, dir: flockDir, delay: f * 45 });
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  HELPER: draw a single crow at canvas-local (0,0), facing right
  //  s = size scale, wingOpen = 0..1
  // ══════════════════════════════════════════════════════════════════
  function _drawCrow(ctx, s, wingOpen, glowColor) {
    // Body
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.55, s * 0.28, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#080812';
    ctx.fill();
    // Tail feathers
    ctx.beginPath();
    ctx.moveTo(-s * 0.5, 0);
    ctx.bezierCurveTo(-s * 0.7, s * 0.1, -s * 0.85, s * 0.18, -s * 0.9, s * 0.08);
    ctx.bezierCurveTo(-s * 0.85, -s * 0.04, -s * 0.65, -s * 0.06, -s * 0.5, 0);
    ctx.fillStyle = '#060610';
    ctx.fill();
    // Head
    ctx.beginPath();
    ctx.arc(s * 0.42, -s * 0.16, s * 0.24, 0, Math.PI * 2);
    ctx.fillStyle = '#0a0a16';
    ctx.fill();
    // Beak
    ctx.beginPath();
    ctx.moveTo(s * 0.62, -s * 0.16);
    ctx.lineTo(s * 0.88, -s * 0.09);
    ctx.lineTo(s * 0.62, -s * 0.06);
    ctx.closePath();
    ctx.fillStyle = '#1a1a2a';
    ctx.fill();
    // Left wing (up)
    const wuL = wingOpen * s * 1.0;
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.06);
    ctx.bezierCurveTo(-s * 0.15, -wuL * 0.9, -s * 0.55, -wuL, -s * 0.75, -wuL * 0.4);
    ctx.bezierCurveTo(-s * 0.55, s * 0.04, -s * 0.15, s * 0.08, 0, -s * 0.06);
    ctx.fillStyle = '#07070f';
    ctx.fill();
    // Right wing (down mirror)
    const wuR = (1 - wingOpen) * s * 0.6;
    ctx.beginPath();
    ctx.moveTo(0, s * 0.02);
    ctx.bezierCurveTo(-s * 0.1, wuR * 0.8, -s * 0.45, wuR, -s * 0.6, wuR * 0.3);
    ctx.bezierCurveTo(-s * 0.4, s * 0.1, -s * 0.1, s * 0.12, 0, s * 0.02);
    ctx.fillStyle = '#09090f';
    ctx.fill();
    // Eye
    ctx.beginPath();
    ctx.arc(s * 0.46, -s * 0.2, s * 0.075, 0, Math.PI * 2);
    ctx.fillStyle = glowColor || '#00ccff';
    ctx.globalAlpha = 0.95;
    ctx.fill();
  }

  // ══════════════════════════════════════════════════════════════════
  //  HELPER: draw 2D cat body at (0,0), legs animated by legPhase
  //  scale = overall size, facing right
  // ══════════════════════════════════════════════════════════════════
  function _drawCat(ctx, scale, legPhase, tailPhase, headTilt, eyeColor, crouching) {
    const s = scale;
    const crouch = crouching ? 0.75 : 1.0;

    // Shadow under cat
    const shad = ctx.createRadialGradient(0, s * 0.55 * crouch, 2, 0, s * 0.55 * crouch, s * 0.7);
    shad.addColorStop(0,   'rgba(0,0,20,0.35)');
    shad.addColorStop(1,   'rgba(0,0,20,0)');
    ctx.beginPath();
    ctx.ellipse(0, s * 0.55 * crouch, s * 0.65, s * 0.12, 0, 0, Math.PI * 2);
    ctx.fillStyle = shad;
    ctx.globalAlpha = 0.5;
    ctx.fill();
    ctx.globalAlpha = 1;

    // LEGS — 4 legs with walking cycle
    const legColors = ['#0a0a1e', '#0c0c22'];
    const legPairs = [
      { bx: -s * 0.22, frontLeg: true  },
      { bx:  s * 0.18, frontLeg: false },
    ];
    legPairs.forEach((pair, pi) => {
      // front and back leg for each side
      [0, 1].forEach(li => {
        const phase = legPhase + (pi === 0 ? 0 : Math.PI) + (li === 0 ? 0 : Math.PI * 0.5);
        const swing = Math.sin(phase) * s * 0.22;
        const stretch = Math.abs(Math.cos(phase)) * s * 0.08;
        const lx = pair.bx + (li === 0 ? -s * 0.08 : s * 0.08);
        const lyTop = s * 0.28 * crouch;
        const lyBot = s * 0.52 * crouch + stretch;
        ctx.beginPath();
        ctx.moveTo(lx, lyTop);
        ctx.bezierCurveTo(lx + swing * 0.4, lyTop + (lyBot - lyTop) * 0.5,
                          lx + swing,       lyBot - s * 0.06,
                          lx + swing,       lyBot);
        // paw
        ctx.arc(lx + swing, lyBot, s * 0.06, 0, Math.PI * 2);
        ctx.fillStyle = legColors[li];
        ctx.globalAlpha = 0.9;
        ctx.fill();
        ctx.strokeStyle = '#0d0d22';
        ctx.lineWidth = s * 0.04;
        ctx.stroke();
      });
    });

    // TAIL
    const tailCurve = Math.sin(tailPhase) * s * 0.4;
    const tailBase = { x: -s * 0.45, y: s * 0.1 * crouch };
    ctx.beginPath();
    ctx.moveTo(tailBase.x, tailBase.y);
    ctx.bezierCurveTo(
      tailBase.x - s * 0.3, tailBase.y - s * 0.1 + tailCurve,
      tailBase.x - s * 0.5, tailBase.y - s * 0.35 + tailCurve * 0.8,
      tailBase.x - s * 0.35, tailBase.y - s * 0.6 + tailCurve
    );
    ctx.strokeStyle = '#0e0e20';
    ctx.lineWidth = s * 0.1;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 1;
    ctx.stroke();
    // tail tip highlight
    ctx.beginPath();
    ctx.arc(tailBase.x - s * 0.35, tailBase.y - s * 0.6 + tailCurve, s * 0.07, 0, Math.PI * 2);
    ctx.fillStyle = '#1a1a40';
    ctx.fill();

    // BODY
    const bodyGrad = ctx.createRadialGradient(0, 0, s * 0.05, 0, -s * 0.05, s * 0.45);
    bodyGrad.addColorStop(0,   '#14142e');
    bodyGrad.addColorStop(0.6, '#0a0a1c');
    bodyGrad.addColorStop(1,   '#060610');
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.42, s * 0.28 * crouch, 0, 0, Math.PI * 2);
    ctx.fillStyle = bodyGrad;
    ctx.globalAlpha = 1;
    ctx.fill();

    // FUR highlight along back
    ctx.beginPath();
    ctx.ellipse(-s * 0.05, -s * 0.14 * crouch, s * 0.32, s * 0.08, -0.2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(30,30,70,0.4)';
    ctx.fill();

    // HEAD
    const hx = s * 0.38;
    const hy = -s * 0.22 * crouch + Math.sin(headTilt) * s * 0.06;
    const headGrad = ctx.createRadialGradient(hx, hy, 0, hx, hy, s * 0.28);
    headGrad.addColorStop(0,   '#16162e');
    headGrad.addColorStop(1,   '#080818');
    ctx.beginPath();
    ctx.arc(hx, hy, s * 0.27, 0, Math.PI * 2);
    ctx.fillStyle = headGrad;
    ctx.fill();

    // EARS
    [[hx - s * 0.14, hy - s * 0.22], [hx + s * 0.14, hy - s * 0.22]].forEach(([ex, ey], ei) => {
      ctx.beginPath();
      ctx.moveTo(ex - s * 0.1, ey + s * 0.05);
      ctx.lineTo(ex,           ey - s * 0.16);
      ctx.lineTo(ex + s * 0.1, ey + s * 0.05);
      ctx.closePath();
      ctx.fillStyle = '#0c0c20';
      ctx.fill();
      // inner ear
      ctx.beginPath();
      ctx.moveTo(ex - s * 0.06, ey + s * 0.03);
      ctx.lineTo(ex,            ey - s * 0.1);
      ctx.lineTo(ex + s * 0.06, ey + s * 0.03);
      ctx.closePath();
      ctx.fillStyle = 'rgba(100,0,120,0.3)';
      ctx.fill();
    });

    // EYES
    const eyeGlow = eyeColor || '#00eeff';
    [[-s * 0.1, -s * 0.04], [s * 0.1, -s * 0.04]].forEach(([edx, edy]) => {
      const eg = ctx.createRadialGradient(hx + edx, hy + edy, 0, hx + edx, hy + edy, s * 0.14);
      eg.addColorStop(0,   eyeGlow);
      eg.addColorStop(0.3, 'rgba(0,220,255,0.55)');
      eg.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.ellipse(hx + edx, hy + edy, s * 0.1, s * 0.07, 0, 0, Math.PI * 2);
      ctx.fillStyle = eg;
      ctx.globalAlpha = 0.95;
      ctx.fill();
      // pupil
      ctx.beginPath();
      ctx.ellipse(hx + edx, hy + edy, s * 0.04, s * 0.06, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#000';
      ctx.globalAlpha = 1;
      ctx.fill();
    });

    // NOSE
    ctx.beginPath();
    ctx.arc(hx + s * 0.16, hy + s * 0.04, s * 0.04, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(180,80,160,0.6)';
    ctx.globalAlpha = 0.7;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // ══════════════════════════════════════════════════════════════════
  //  HELPER: draw 2D wolf at (0,0), legs animated, facing right
  // ══════════════════════════════════════════════════════════════════
  function _drawWolf(ctx, scale, legPhase, tailPhase, headTilt, howling) {
    const s = scale;

    // Shadow
    const shad = ctx.createRadialGradient(0, s * 0.55, 2, 0, s * 0.55, s * 0.85);
    shad.addColorStop(0,   'rgba(0,20,60,0.4)');
    shad.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.ellipse(0, s * 0.55, s * 0.8, s * 0.14, 0, 0, Math.PI * 2);
    ctx.fillStyle = shad;
    ctx.globalAlpha = 0.55;
    ctx.fill();
    ctx.globalAlpha = 1;

    // LEGS — 4 legs running cycle
    const legDefs = [
      { bx: -s * 0.28, phase: 0 },
      { bx: -s * 0.08, phase: Math.PI },
      { bx:  s * 0.08, phase: Math.PI * 0.5 },
      { bx:  s * 0.28, phase: Math.PI * 1.5 },
    ];
    legDefs.forEach(leg => {
      const ph  = legPhase + leg.phase;
      const swF = Math.sin(ph) * s * 0.28;
      const swB = Math.cos(ph) * s * 0.1;
      const yT  = s * 0.22;
      const yB  = s * 0.55;
      // upper leg
      ctx.beginPath();
      ctx.moveTo(leg.bx, yT);
      ctx.lineTo(leg.bx + swF * 0.5, yT + (yB - yT) * 0.45);
      ctx.strokeStyle = '#1a2040';
      ctx.lineWidth = s * 0.1;
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.95;
      ctx.stroke();
      // lower leg
      ctx.beginPath();
      ctx.moveTo(leg.bx + swF * 0.5, yT + (yB - yT) * 0.45);
      ctx.lineTo(leg.bx + swF, yB + swB);
      ctx.strokeStyle = '#151a36';
      ctx.lineWidth = s * 0.08;
      ctx.stroke();
      // paw
      ctx.beginPath();
      ctx.ellipse(leg.bx + swF, yB + swB, s * 0.07, s * 0.045, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#0e1228';
      ctx.globalAlpha = 1;
      ctx.fill();
    });

    // TAIL
    const tc = Math.sin(tailPhase) * s * 0.5;
    ctx.beginPath();
    ctx.moveTo(-s * 0.5, s * 0.05);
    ctx.bezierCurveTo(-s * 0.7, -s * 0.1 + tc, -s * 0.85, -s * 0.3 + tc * 0.7, -s * 0.75, -s * 0.5 + tc);
    ctx.strokeStyle = '#1e2250';
    ctx.lineWidth = s * 0.13;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 1;
    ctx.stroke();
    // tail fur highlight
    ctx.beginPath();
    ctx.moveTo(-s * 0.5, s * 0.04);
    ctx.bezierCurveTo(-s * 0.68, -s * 0.08 + tc, -s * 0.82, -s * 0.28 + tc * 0.7, -s * 0.72, -s * 0.48 + tc);
    ctx.strokeStyle = 'rgba(80,100,180,0.3)';
    ctx.lineWidth = s * 0.06;
    ctx.stroke();

    // BODY
    const bodyGrad = ctx.createRadialGradient(0, -s * 0.05, s * 0.05, 0, -s * 0.1, s * 0.55);
    bodyGrad.addColorStop(0,   '#2a3060');
    bodyGrad.addColorStop(0.5, '#1a2048');
    bodyGrad.addColorStop(1,   '#0e1230');
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.52, s * 0.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = bodyGrad;
    ctx.globalAlpha = 1;
    ctx.fill();

    // Fur ridgeline
    ctx.beginPath();
    ctx.moveTo(-s * 0.4, -s * 0.18);
    ctx.bezierCurveTo(-s * 0.1, -s * 0.32, s * 0.2, -s * 0.28, s * 0.42, -s * 0.12);
    ctx.strokeStyle = 'rgba(100,120,220,0.25)';
    ctx.lineWidth = s * 0.07;
    ctx.stroke();

    // NECK
    ctx.beginPath();
    ctx.moveTo(s * 0.38, -s * 0.12);
    ctx.lineTo(s * 0.5,  -s * 0.22 + (howling ? -s * 0.15 : 0));
    ctx.strokeStyle = '#202450';
    ctx.lineWidth = s * 0.22;
    ctx.lineCap = 'round';
    ctx.stroke();

    // HEAD
    const hx = s * 0.52;
    const hy = -s * 0.28 + (howling ? -s * 0.2 : 0) + Math.sin(headTilt) * s * 0.06;
    // snout elongation
    const snoutLen = howling ? s * 0.12 : s * 0.32;
    const snoutH   = howling ? s * 0.16 : s * 0.14;

    const headGrad = ctx.createRadialGradient(hx, hy, 0, hx, hy, s * 0.32);
    headGrad.addColorStop(0,   '#2e3468');
    headGrad.addColorStop(1,   '#141836');
    ctx.beginPath();
    ctx.ellipse(hx, hy, s * 0.3, s * 0.26, howling ? -0.4 : 0, 0, Math.PI * 2);
    ctx.fillStyle = headGrad;
    ctx.fill();

    // Snout
    ctx.beginPath();
    ctx.ellipse(hx + snoutLen * 0.5, hy + (howling ? s * 0.05 : s * 0.03), snoutLen * 0.6, snoutH * 0.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#1a2042';
    ctx.fill();

    // EARS
    const earTilt = howling ? -0.6 : 0.15;
    [[-s * 0.12, -s * 0.22], [s * 0.1, -s * 0.26]].forEach(([edx, edy]) => {
      ctx.save();
      ctx.translate(hx + edx, hy + edy);
      ctx.rotate(earTilt);
      ctx.beginPath();
      ctx.moveTo(-s * 0.1, s * 0.07);
      ctx.lineTo(0,         -s * 0.2);
      ctx.lineTo(s * 0.1,   s * 0.07);
      ctx.closePath();
      ctx.fillStyle = '#202454';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-s * 0.06, s * 0.04);
      ctx.lineTo(0,          -s * 0.13);
      ctx.lineTo(s * 0.06,   s * 0.04);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,60,160,0.4)';
      ctx.fill();
      ctx.restore();
    });

    // EYES
    const eyeAlpha = howling ? 0.5 : 1;
    [[-s * 0.12, -s * 0.04], [s * 0.08, -s * 0.04]].forEach(([edx, edy]) => {
      const eg = ctx.createRadialGradient(hx + edx, hy + edy, 0, hx + edx, hy + edy, s * 0.12);
      eg.addColorStop(0,   '#88aaff');
      eg.addColorStop(0.4, 'rgba(0,100,255,0.6)');
      eg.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.ellipse(hx + edx, hy + edy, s * 0.1, s * 0.08, 0, 0, Math.PI * 2);
      ctx.fillStyle = eg;
      ctx.globalAlpha = eyeAlpha;
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(hx + edx, hy + edy, s * 0.04, s * 0.06, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#000';
      ctx.globalAlpha = 1;
      ctx.fill();
    });

    // Nose
    ctx.beginPath();
    ctx.ellipse(hx + snoutLen * 0.9, hy + (howling ? s * 0.02 : s * 0.02), s * 0.06, s * 0.045, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#0a0a1c';
    ctx.globalAlpha = 1;
    ctx.fill();

    // Howl mouth
    if (howling) {
      ctx.beginPath();
      ctx.arc(hx + snoutLen * 0.5, hy + s * 0.1, s * 0.1, 0, Math.PI);
      ctx.fillStyle = '#000';
      ctx.fill();
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  HELPER: draw lion at canvas-local (0,0), always faces right
  //  s        = scale (logical pixels)
  //  legPhase = running animation phase (radians)
  //  tailPhase= tail sway phase
  //  headBob  = vertical head bob amount (-1..1)
  //  maneWave = mane sway phase
  // ══════════════════════════════════════════════════════════════════
  function _drawLion(ctx, s, legPhase, tailPhase, headBob, maneWave) {

    // Ground shadow
    const shad = ctx.createRadialGradient(0, s * 0.58, 2, 0, s * 0.58, s * 0.9);
    shad.addColorStop(0,   'rgba(0,0,0,0.45)');
    shad.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.ellipse(0, s * 0.58, s * 0.82, s * 0.13, 0, 0, Math.PI * 2);
    ctx.fillStyle = shad;
    ctx.globalAlpha = 0.5;
    ctx.fill();
    ctx.globalAlpha = 1;

    // LEGS — 4 legs with realistic running gait
    const legDefs = [
      { bx: -s * 0.22, phase: 0 },
      { bx: -s * 0.06, phase: Math.PI },
      { bx:  s * 0.10, phase: Math.PI * 0.5 },
      { bx:  s * 0.26, phase: Math.PI * 1.5 },
    ];
    const yHip  = s * 0.18;
    const yPaw  = s * 0.58;
    legDefs.forEach(leg => {
      const ph   = legPhase + leg.phase;
      const swF  = Math.sin(ph) * s * 0.30;
      const swB  = Math.cos(ph) * s * 0.10;
      const knee = leg.bx + swF * 0.45;
      const kY   = yHip + (yPaw - yHip) * 0.48;
      // upper leg
      ctx.beginPath();
      ctx.moveTo(leg.bx, yHip);
      ctx.lineTo(knee, kY);
      ctx.strokeStyle = '#7a4a10';
      ctx.lineWidth   = s * 0.12;
      ctx.lineCap     = 'round';
      ctx.globalAlpha = 1;
      ctx.stroke();
      // lower leg
      ctx.beginPath();
      ctx.moveTo(knee, kY);
      ctx.lineTo(leg.bx + swF, yPaw + swB);
      ctx.strokeStyle = '#5c3608';
      ctx.lineWidth   = s * 0.09;
      ctx.stroke();
      // paw
      ctx.beginPath();
      ctx.ellipse(leg.bx + swF, yPaw + swB, s * 0.09, s * 0.055, 0, 0, Math.PI * 2);
      ctx.fillStyle   = '#3d2005';
      ctx.globalAlpha = 1;
      ctx.fill();
    });

    // TAIL — thick, tufted; curves up and sways
    const tc = Math.sin(tailPhase) * s * 0.45;
    // main tail
    ctx.beginPath();
    ctx.moveTo(-s * 0.5, s * 0.05);
    ctx.bezierCurveTo(
      -s * 0.72, -s * 0.08 + tc * 0.5,
      -s * 0.88, -s * 0.28 + tc * 0.75,
      -s * 0.80, -s * 0.52 + tc
    );
    ctx.strokeStyle = '#8c5a18';
    ctx.lineWidth   = s * 0.14;
    ctx.lineCap     = 'round';
    ctx.globalAlpha = 1;
    ctx.stroke();
    // tail tuft
    const ttx = -s * 0.80;
    const tty = -s * 0.52 + tc;
    const tuffGrad = ctx.createRadialGradient(ttx, tty, 0, ttx, tty, s * 0.18);
    tuffGrad.addColorStop(0,   '#3a1e00');
    tuffGrad.addColorStop(0.5, '#5c3200');
    tuffGrad.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.arc(ttx, tty, s * 0.18, 0, Math.PI * 2);
    ctx.fillStyle   = tuffGrad;
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;

    // BODY
    const bodyGrad = ctx.createRadialGradient(0, -s * 0.04, s * 0.04, 0, -s * 0.08, s * 0.54);
    bodyGrad.addColorStop(0,   '#c8781e');
    bodyGrad.addColorStop(0.45, '#9a5210');
    bodyGrad.addColorStop(1,   '#6b3608');
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.54, s * 0.29, 0, 0, Math.PI * 2);
    ctx.fillStyle   = bodyGrad;
    ctx.globalAlpha = 1;
    ctx.fill();

    // Belly lighter patch
    const bellyGrad = ctx.createRadialGradient(s * 0.1, s * 0.12, 0, s * 0.1, s * 0.12, s * 0.28);
    bellyGrad.addColorStop(0,   'rgba(220,165,80,0.35)');
    bellyGrad.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.ellipse(s * 0.1, s * 0.14, s * 0.28, s * 0.18, 0, 0, Math.PI * 2);
    ctx.fillStyle   = bellyGrad;
    ctx.globalAlpha = 1;
    ctx.fill();

    // Spine ridge fur lines
    for (let i = 0; i < 4; i++) {
      const rx = -s * 0.3 + i * s * 0.2;
      ctx.beginPath();
      ctx.moveTo(rx, -s * 0.22);
      ctx.lineTo(rx + s * 0.04, -s * 0.32);
      ctx.strokeStyle = 'rgba(200,130,30,0.4)';
      ctx.lineWidth   = s * 0.03;
      ctx.stroke();
    }

    // NECK
    ctx.beginPath();
    ctx.moveTo(s * 0.36, -s * 0.10);
    ctx.lineTo(s * 0.50, -s * 0.24 + headBob * s * 0.04);
    ctx.strokeStyle = '#a06020';
    ctx.lineWidth   = s * 0.26;
    ctx.lineCap     = 'round';
    ctx.stroke();

    // HEAD position
    const hx = s * 0.54;
    const hy = -s * 0.30 + headBob * s * 0.05;

    // ── MANE — drawn before head so head overlaps it ──────────────────────────
    const maneSpikes = 14;
    for (let i = 0; i < maneSpikes; i++) {
      const ang = (i / maneSpikes) * Math.PI * 2 + maneWave * 0.06;
      const mLen = s * (0.34 + Math.sin(maneWave + i * 0.7) * 0.06);
      const mx1  = hx + Math.cos(ang) * s * 0.26;
      const my1  = hy + Math.sin(ang) * s * 0.22;
      const mx2  = hx + Math.cos(ang) * mLen;
      const my2  = hy + Math.sin(ang) * mLen * 0.85;
      ctx.beginPath();
      ctx.moveTo(mx1, my1);
      ctx.lineTo(mx2, my2);
      const maneAlpha = 0.7 + Math.sin(maneWave + i) * 0.15;
      // alternate dark/light strands for depth
      ctx.strokeStyle = i % 2 === 0 ? '#3a1e00' : '#6b3a08';
      ctx.lineWidth   = s * (0.055 + Math.sin(maneWave + i * 0.5) * 0.01);
      ctx.lineCap     = 'round';
      ctx.globalAlpha = maneAlpha;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Mane base fill (dark collar ring)
    const maneGrad = ctx.createRadialGradient(hx, hy, s * 0.20, hx, hy, s * 0.38);
    maneGrad.addColorStop(0,   'rgba(40,18,0,0)');
    maneGrad.addColorStop(0.5, 'rgba(40,18,0,0.55)');
    maneGrad.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.arc(hx, hy, s * 0.38, 0, Math.PI * 2);
    ctx.fillStyle   = maneGrad;
    ctx.globalAlpha = 1;
    ctx.fill();

    // HEAD
    const headGrad = ctx.createRadialGradient(hx, hy, 0, hx, hy, s * 0.30);
    headGrad.addColorStop(0,   '#d48828');
    headGrad.addColorStop(0.6, '#a06020');
    headGrad.addColorStop(1,   '#7a4010');
    ctx.beginPath();
    ctx.ellipse(hx, hy, s * 0.28, s * 0.24, 0, 0, Math.PI * 2);
    ctx.fillStyle   = headGrad;
    ctx.globalAlpha = 1;
    ctx.fill();

    // SNOUT / muzzle
    const muzzGrad = ctx.createRadialGradient(hx + s * 0.15, hy + s * 0.05, 0, hx + s * 0.15, hy + s * 0.05, s * 0.20);
    muzzGrad.addColorStop(0,   '#e0a850');
    muzzGrad.addColorStop(1,   '#b07030');
    ctx.beginPath();
    ctx.ellipse(hx + s * 0.16, hy + s * 0.06, s * 0.18, s * 0.14, 0, 0, Math.PI * 2);
    ctx.fillStyle   = muzzGrad;
    ctx.globalAlpha = 1;
    ctx.fill();

    // NOSE
    ctx.beginPath();
    ctx.ellipse(hx + s * 0.30, hy + s * 0.02, s * 0.055, s * 0.042, 0, 0, Math.PI * 2);
    ctx.fillStyle   = '#3a1a08';
    ctx.fill();

    // EARS
    [[-s * 0.16, -s * 0.20], [s * 0.06, -s * 0.24]].forEach(([edx, edy]) => {
      ctx.save();
      ctx.translate(hx + edx, hy + edy);
      ctx.beginPath();
      ctx.moveTo(-s * 0.09, s * 0.08);
      ctx.lineTo(0,          -s * 0.18);
      ctx.lineTo(s * 0.09,   s * 0.08);
      ctx.closePath();
      ctx.fillStyle = '#c87820';
      ctx.globalAlpha = 1;
      ctx.fill();
      // inner ear
      ctx.beginPath();
      ctx.moveTo(-s * 0.05, s * 0.04);
      ctx.lineTo(0,          -s * 0.10);
      ctx.lineTo(s * 0.05,   s * 0.04);
      ctx.closePath();
      ctx.fillStyle = 'rgba(180,80,30,0.5)';
      ctx.fill();
      ctx.restore();
    });

    // EYES — amber with dark slit pupil
    [[-s * 0.10, -s * 0.04], [s * 0.08, -s * 0.05]].forEach(([edx, edy]) => {
      const eg = ctx.createRadialGradient(hx + edx, hy + edy, 0, hx + edx, hy + edy, s * 0.10);
      eg.addColorStop(0,   '#ffe066');
      eg.addColorStop(0.5, 'rgba(200,120,0,0.8)');
      eg.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.ellipse(hx + edx, hy + edy, s * 0.09, s * 0.07, 0, 0, Math.PI * 2);
      ctx.fillStyle   = eg;
      ctx.globalAlpha = 1;
      ctx.fill();
      // slit pupil
      ctx.beginPath();
      ctx.ellipse(hx + edx, hy + edy, s * 0.025, s * 0.06, 0, 0, Math.PI * 2);
      ctx.fillStyle   = '#000';
      ctx.globalAlpha = 1;
      ctx.fill();
      // eye highlight
      ctx.beginPath();
      ctx.arc(hx + edx - s * 0.025, hy + edy - s * 0.025, s * 0.018, 0, Math.PI * 2);
      ctx.fillStyle   = 'rgba(255,255,200,0.7)';
      ctx.fill();
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  HELPER: draw dragon at (0,0), facing right if dir=1
  // ══════════════════════════════════════════════════════════════════
  function _drawDragon(ctx, scale, wingPhase, bodyWave, breathing) {
    const s = scale;

    // TAIL — serpentine
    const tc1 = Math.sin(bodyWave) * s * 0.35;
    const tc2 = Math.sin(bodyWave + 0.8) * s * 0.2;
    ctx.beginPath();
    ctx.moveTo(-s * 0.45, s * 0.05);
    ctx.bezierCurveTo(-s * 0.7, s * 0.1 + tc1, -s * 0.95, -s * 0.1 + tc1, -s * 1.1, s * 0.2 + tc2);
    ctx.strokeStyle = '#4400aa';
    ctx.lineWidth = s * 0.14;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-s * 0.45, s * 0.04);
    ctx.bezierCurveTo(-s * 0.68, s * 0.09 + tc1, -s * 0.92, -s * 0.1 + tc1, -s * 1.08, s * 0.18 + tc2);
    ctx.strokeStyle = 'rgba(140,0,255,0.3)';
    ctx.lineWidth = s * 0.06;
    ctx.stroke();

    // HIND LEGS
    [[-s * 0.22, 0], [-s * 0.08, 0]].forEach(([lx, lphOff]) => {
      const lph = bodyWave * 2 + lphOff;
      const sw  = Math.sin(lph) * s * 0.2;
      ctx.beginPath();
      ctx.moveTo(lx, s * 0.18);
      ctx.lineTo(lx + sw, s * 0.42);
      ctx.strokeStyle = '#3a0088';
      ctx.lineWidth = s * 0.1;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(lx + sw, s * 0.44, s * 0.07, s * 0.04, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#300070';
      ctx.fill();
    });

    // WINGS
    const wO = (Math.sin(wingPhase) + 1) * 0.5;  // 0..1
    const wingSpan = s * 1.6;
    // Back wing (behind body)
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.08);
    ctx.bezierCurveTo(-s * 0.3, -s * 0.2 - wingSpan * wO * 0.6,
                      -s * 0.7, -s * 0.3 - wingSpan * wO,
                      -s * 1.0, -s * 0.05 - wingSpan * wO * 0.3);
    ctx.bezierCurveTo(-s * 0.7, s * 0.2, -s * 0.3, s * 0.15, 0, s * 0.04);
    ctx.fillStyle = '#220055';
    ctx.fill();
    // Wing membrane veins
    for (let v = 0; v < 3; v++) {
      const vt = (v + 1) / 4;
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.04 + s * 0.08 * vt);
      ctx.lineTo(-s * (0.5 + vt * 0.5), -s * 0.15 - wingSpan * wO * vt * 0.7);
      ctx.strokeStyle = 'rgba(100,0,200,0.4)';
      ctx.lineWidth = s * 0.02;
      ctx.stroke();
    }
    ctx.restore();

    // Front wing
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(s * 0.1, -s * 0.1);
    ctx.bezierCurveTo(s * 0.35, -s * 0.25 - wingSpan * wO * 0.55,
                      s * 0.75, -s * 0.35 - wingSpan * wO * 0.95,
                      s * 1.05, -s * 0.08 - wingSpan * wO * 0.28);
    ctx.bezierCurveTo(s * 0.72, s * 0.18, s * 0.32, s * 0.14, s * 0.08, s * 0.05);
    ctx.fillStyle = '#2d006e';
    ctx.fill();
    // Veins
    for (let v = 0; v < 3; v++) {
      const vt = (v + 1) / 4;
      ctx.beginPath();
      ctx.moveTo(s * 0.1, 0);
      ctx.lineTo(s * (0.5 + vt * 0.55), -s * 0.2 - wingSpan * wO * vt * 0.65);
      ctx.strokeStyle = 'rgba(160,40,255,0.45)';
      ctx.lineWidth = s * 0.022;
      ctx.stroke();
    }
    ctx.restore();

    // BODY
    const bodyGrad = ctx.createLinearGradient(-s * 0.5, -s * 0.25, s * 0.5, s * 0.25);
    bodyGrad.addColorStop(0,   '#3a0090');
    bodyGrad.addColorStop(0.5, '#220055');
    bodyGrad.addColorStop(1,   '#110030');
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.52, s * 0.28, 0, 0, Math.PI * 2);
    ctx.fillStyle = bodyGrad;
    ctx.globalAlpha = 1;
    ctx.fill();

    // Belly scales
    const scaleGrad = ctx.createLinearGradient(0, -s * 0.1, 0, s * 0.2);
    scaleGrad.addColorStop(0,   'rgba(80,0,180,0.5)');
    scaleGrad.addColorStop(1,   'rgba(40,0,100,0.2)');
    ctx.beginPath();
    ctx.ellipse(s * 0.08, s * 0.08, s * 0.32, s * 0.15, 0.2, 0, Math.PI * 2);
    ctx.fillStyle = scaleGrad;
    ctx.fill();

    // FRONT ARMS
    [[ s * 0.24, 0], [s * 0.12, 0]].forEach(([lx, lphOff]) => {
      const lph = bodyWave * 2 + Math.PI + lphOff;
      const sw  = Math.sin(lph) * s * 0.16;
      ctx.beginPath();
      ctx.moveTo(lx, s * 0.08);
      ctx.lineTo(lx + sw, s * 0.36);
      ctx.strokeStyle = '#2e006a';
      ctx.lineWidth = s * 0.09;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(lx + sw, s * 0.38, s * 0.065, s * 0.04, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#250058';
      ctx.fill();
    });

    // NECK
    ctx.beginPath();
    ctx.moveTo(s * 0.4, -s * 0.1);
    ctx.bezierCurveTo(s * 0.55, -s * 0.2 + Math.sin(bodyWave * 0.7) * s * 0.06,
                      s * 0.6,  -s * 0.3,
                      s * 0.58, -s * 0.4);
    ctx.strokeStyle = '#3a0088';
    ctx.lineWidth = s * 0.22;
    ctx.lineCap = 'round';
    ctx.stroke();

    // HEAD
    const hx = s * 0.6;
    const hy = -s * 0.46 + Math.sin(bodyWave * 0.5) * s * 0.04;
    ctx.beginPath();
    ctx.ellipse(hx, hy, s * 0.28, s * 0.2, 0.2, 0, Math.PI * 2);
    ctx.fillStyle = '#3a0095';
    ctx.fill();

    // Horns
    [[hx - s * 0.1, hy - s * 0.17], [hx + s * 0.06, hy - s * 0.2]].forEach(([hox, hoy]) => {
      ctx.beginPath();
      ctx.moveTo(hox - s * 0.04, hoy + s * 0.06);
      ctx.lineTo(hox + s * 0.02, hoy - s * 0.18);
      ctx.lineTo(hox + s * 0.06, hoy + s * 0.04);
      ctx.closePath();
      ctx.fillStyle = '#7700cc';
      ctx.fill();
    });

    // Snout
    ctx.beginPath();
    ctx.ellipse(hx + s * 0.28, hy + s * 0.04, s * 0.2, s * 0.1, 0.15, 0, Math.PI * 2);
    ctx.fillStyle = '#2e0075';
    ctx.fill();

    // EYES
    [[-s * 0.06, -s * 0.06], [s * 0.1, -s * 0.04]].forEach(([edx, edy]) => {
      const eg = ctx.createRadialGradient(hx + edx, hy + edy, 0, hx + edx, hy + edy, s * 0.12);
      eg.addColorStop(0,   '#ff66ff');
      eg.addColorStop(0.35,'rgba(200,0,255,0.7)');
      eg.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.ellipse(hx + edx, hy + edy, s * 0.1, s * 0.08, 0, 0, Math.PI * 2);
      ctx.fillStyle = eg;
      ctx.globalAlpha = breathing ? 1 : 0.85;
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(hx + edx, hy + edy, s * 0.035, s * 0.055, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#000';
      ctx.globalAlpha = 1;
      ctx.fill();
    });

    // FIRE BREATH
    if (breathing > 0) {
      const fx = hx + s * 0.46;
      const fy = hy + s * 0.06;
      for (let fl = 0; fl < 5; fl++) {
        const fLen = breathing * (s * 1.0 + fl * s * 0.3) * (0.7 + Math.random() * 0.3);
        const fOff = (Math.random() - 0.5) * s * 0.18;
        const fGrad = ctx.createLinearGradient(fx, fy, fx + fLen, fy + fOff);
        fGrad.addColorStop(0,   'rgba(255,200,50,0.9)');
        fGrad.addColorStop(0.3, 'rgba(255,80,0,0.7)');
        fGrad.addColorStop(0.7, 'rgba(180,0,100,0.4)');
        fGrad.addColorStop(1,   'rgba(100,0,200,0)');
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.bezierCurveTo(fx + fLen * 0.3, fy + fOff * 0.5,
                          fx + fLen * 0.7, fy + fOff,
                          fx + fLen,       fy + fOff * 1.5);
        ctx.strokeStyle = fGrad;
        ctx.lineWidth = (s * 0.22) * (1 - fl * 0.15) * (0.6 + Math.random() * 0.4);
        ctx.lineCap = 'round';
        ctx.globalAlpha = 0.85 - fl * 0.12;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  HELPER: draw ground flames across bottom of scene
  // ══════════════════════════════════════════════════════════════════
  function _drawGroundFlames(ctx, flames, cx, baseY, color1, color2) {
    for (const f of flames) {
      const flicker = Math.sin(_frame * f.speed + f.phase) * 0.35 + 0.65;
      const rx = cx + f.x;
      const fh = f.h * flicker;
      const fw = f.w * (0.85 + Math.sin(_frame * f.speed * 1.3 + f.phase) * 0.15);
      const grad = ctx.createLinearGradient(rx, baseY, rx, baseY - fh);
      grad.addColorStop(0,   color1 || 'rgba(0,140,255,0.95)');
      grad.addColorStop(0.45,'rgba(0,60,200,0.6)');
      grad.addColorStop(1,   'rgba(0,0,40,0)');
      ctx.beginPath();
      ctx.ellipse(rx, baseY, fw * 0.5, fh * 0.55, 0, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.globalAlpha = 0.75 * flicker;
      ctx.fill();
      // smoke wisp
      if (_frame % 3 === 0) {
        const smokeY = baseY - fh - Math.random() * 10;
        const sg = ctx.createRadialGradient(rx, smokeY, 0, rx, smokeY, fw * 2);
        sg.addColorStop(0,   'rgba(20,20,60,0.18)');
        sg.addColorStop(1,   'rgba(0,0,0,0)');
        ctx.beginPath();
        ctx.arc(rx, smokeY, fw * 2, 0, Math.PI * 2);
        ctx.fillStyle = sg;
        ctx.globalAlpha = 0.22;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ══════════════════════════════════════════════════════════════════
  //  HELPER: draw jagged lightning bolt from (x1,y1) to (x2,y2)
  // ══════════════════════════════════════════════════════════════════
  function _drawBolt(ctx, x1, y1, x2, y2, color, width, alpha, segs) {
    const n = segs || 6;
    const dx = (x2 - x1) / n;
    const dy = (y2 - y1) / n;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    let lx = x1, ly = y1;
    for (let i = 0; i < n; i++) {
      lx += dx + (Math.random() - 0.5) * 22;
      ly += dy + (Math.random() - 0.5) * 10;
      ctx.lineTo(lx, ly);
    }
    ctx.strokeStyle = color || '#00ccff';
    ctx.lineWidth   = width || 2;
    ctx.globalAlpha = alpha !== undefined ? alpha : 0.85;
    ctx.shadowColor = color || '#00ccff';
    ctx.shadowBlur  = 10;
    ctx.stroke();
    ctx.shadowBlur  = 0;
    ctx.globalAlpha = 1;
  }

  // ════════════════════════════════════════════════════════
  //  MAIN TICK
  // ════════════════════════════════════════════════════════
  function tick() {
    // ctx already scaled by dpr — use logical dimensions (lw/lh) for all drawing
    ctx.clearRect(0, 0, lw, lh);
    _frame++;
    const cx = lw * 0.5;
    const cy = lh * 0.5;
    const isMobile = lw < 500;
    const scale = isMobile ? 0.72 : 1.0;

    // ── Background particles ──────────────────────────────
    for (const p of particles) {
      p.x  += p.vx;
      p.y  += p.vy;
      p.alpha -= 0.004;
      if (p.y < -10 || p.alpha <= 0) {
        Object.assign(p, _snxpMakeParticle(lw, lh, cfg.particleColors));
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // ── General lightning bolts (nexus_lightning, eclipse_nexus, etc.) ──
    for (const b of bolts) {
      b.timer--;
      if (b.timer <= 0) {
        b.timer = b.interval + Math.floor(Math.random() * 15);
        b.x = Math.random() * lw;
        b.h = 60 + Math.random() * 150;
        _drawBolt(ctx, b.x, 0, b.x + (Math.random() - 0.5) * 40, b.h, b.color, 1.5, 0.8, 5);
      }
    }

    // ════════════════════════════════════════
    //  SHADOW CAT  full animated scene
    // ════════════════════════════════════════
    if (cfg.shadowCat) {
      const baseY  = cy + lh * 0.18;
      const fps60  = cfg.duration / 1000 * 60;

      // Ground flames — always present
      _drawGroundFlames(ctx, _scGroundFlames, cx, baseY + 10, 'rgba(0,140,255,0.9)', null);

      // Scene phases (each ~20% of total duration at 60fps)
      const phaseLen = fps60 / 5;

      // Phase 0: cat runs in from left
      if (_scCatPhase === 0) {
        _scCatX += 5.5 * scale;
        if (_scCatX >= cx - 60 * scale) { _scCatPhase = 1; _scCatPhaseEnter = _frame; }
        _scCatDir = 1;
      }
      // Phase 1: stops, looks around (head tilts) — pause ~50 frames then leap
      else if (_scCatPhase === 1) {
        if (_frame - _scCatPhaseEnter >= 50) { _scCatPhase = 2; _scCatPhaseEnter = _frame; }
      }
      // Phase 2: crouches and leaps through the flames
      else if (_scCatPhase === 2) {
        _scCatX  += 3.2 * scale;
        _scCatVY -= 0.9;
        _scCatY  += _scCatVY;
        if (_scCatY < -lh * 0.12) _scCatVY = 1.2;
        if (_scCatY >= 0 && _scCatVY > 0) { _scCatY = 0; _scCatVY = 0; _scCatPhase = 3; }
        _scCatDir = 1;
      }
      // Phase 3: lands and runs right, off screen
      else if (_scCatPhase === 3) {
        _scCatX += 6.5 * scale;
        _scCatDir = 1;
        if (_scCatX > lw * 0.85) { _scCatPhase = 4; _scBurstAlpha = 0; }
      }
      // Phase 4: energy burst fills screen
      else if (_scCatPhase === 4) {
        _scBurstAlpha = Math.min(1, _scBurstAlpha + 0.04);
        // flash + glow burst
        const bGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, lw * 0.8);
        bGrad.addColorStop(0,   `rgba(0,200,255,${_scBurstAlpha * 0.55})`);
        bGrad.addColorStop(0.4, `rgba(0,80,200,${_scBurstAlpha * 0.3})`);
        bGrad.addColorStop(1,   'rgba(0,0,0,0)');
        ctx.beginPath();
        ctx.arc(cx, cy, lw * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = bGrad;
        ctx.globalAlpha = 1;
        ctx.fill();
        // radial lightning burst
        if (_frame % 3 === 0) {
          for (let r = 0; r < 6; r++) {
            const ba = (r / 6) * Math.PI * 2 + _frame * 0.04;
            _drawBolt(ctx, cx, cy,
              cx + Math.cos(ba) * lw * 0.5,
              cy + Math.sin(ba) * lh * 0.5,
              '#00eeff', 1.5, 0.7 * _scBurstAlpha, 7);
          }
        }
      }

      // Draw periodic lightning around the scene
      if ((_scCatPhase >= 1) && _frame % 22 === 0) {
        _drawBolt(ctx,
          cx + (Math.random() - 0.5) * lw * 0.7, cy - lh * 0.3,
          cx + (Math.random() - 0.5) * lw * 0.5, cy + lh * 0.1,
          '#00ccff', 2, 0.9, 6);
      }

      // Draw BACK-LAYER crows (zLayer < 0.5) before cat
      const sortedCrows = [..._scCrows].sort((a, b) => a.zLayer - b.zLayer);
      for (const crow of sortedCrows) {
        if (crow.zLayer >= 0.5) continue;
        crow.angle += crow.speed;
        crow.flap  += crow.flapSpd;
        const bx = cx + Math.cos(crow.angle) * crow.orbitW;
        const by = (cy - lh * 0.04)
                   + Math.sin(crow.angle) * crow.orbitH
                   + crow.yOffset;
        const flip = crow.speed > 0 ? (Math.cos(crow.angle) < 0 ? -1 : 1)
                                     : (Math.cos(crow.angle) < 0 ? 1 : -1);
        const wO = (Math.sin(crow.flap) + 1) * 0.5;
        const scaleFactor = (0.6 + crow.zLayer * 0.5) * scale;
        ctx.save();
        ctx.translate(bx, by);
        ctx.scale(flip * scaleFactor, scaleFactor);
        ctx.globalAlpha = 0.65 + crow.zLayer * 0.25;
        _drawCrow(ctx, crow.size, wO, '#0088cc');
        ctx.restore();
      }

      // Draw CAT
      if (_scCatPhase < 4) {
        const legPh    = _frame * 0.28;
        const tailPh   = _frame * 0.12;
        const headTilt = _scCatPhase === 1
          ? Math.sin(_frame * 0.07) * 0.5   // looking around
          : Math.sin(_frame * 0.18) * 0.15;
        const crouching = _scCatPhase === 2 && _scCatY < -10;
        const catScale  = 38 * scale;

        ctx.save();
        ctx.translate(_scCatX, baseY + _scCatY);
        ctx.scale(_scCatDir, 1);
        // glow aura around cat
        const aura = ctx.createRadialGradient(0, 0, 10, 0, 0, 80 * scale);
        aura.addColorStop(0,   'rgba(0,140,255,0.18)');
        aura.addColorStop(1,   'rgba(0,0,50,0)');
        ctx.beginPath();
        ctx.arc(0, 0, 80 * scale, 0, Math.PI * 2);
        ctx.fillStyle = aura;
        ctx.globalAlpha = 1;
        ctx.fill();
        _drawCat(ctx, catScale, legPh, tailPh, headTilt, '#00eeff', crouching);
        ctx.restore();
      }

      // Draw FRONT-LAYER crows (zLayer >= 0.5) after cat
      for (const crow of sortedCrows) {
        if (crow.zLayer < 0.5) continue;
        // front-layer crows were skipped in back-layer loop, advance them now
        crow.angle += crow.speed;
        crow.flap  += crow.flapSpd;
        const bx = cx + Math.cos(crow.angle) * crow.orbitW;
        const by = (cy - lh * 0.04)
                   + Math.sin(crow.angle) * crow.orbitH
                   + crow.yOffset;
        const flip = crow.speed > 0 ? (Math.cos(crow.angle) < 0 ? -1 : 1)
                                     : (Math.cos(crow.angle) < 0 ? 1 : -1);
        const wO = (Math.sin(crow.flap) + 1) * 0.5;
        const scaleFactor = (0.6 + crow.zLayer * 0.5) * scale;
        ctx.save();
        ctx.translate(bx, by);
        ctx.scale(flip * scaleFactor, scaleFactor);
        ctx.globalAlpha = 0.75 + crow.zLayer * 0.2;
        _drawCrow(ctx, crow.size, wO, '#00aaff');
        ctx.restore();
      }
    }
    // ── End Shadow Cat ────────────────────────────────────

    // ════════════════════════════════════════
    //  SHADOW WOLF  full animated scene
    // ════════════════════════════════════════
    if (cfg.wolf || cfg.shadowWolf) {
      const baseY = cy + lh * 0.2;
      const wolfScale = 44 * scale;

      // Scene progression
      // Phase 0: wolf runs in from left (0→cx-80)
      // Phase 1: wolf looks at viewer — pauses
      // Phase 2: wolf runs through flames (cx-80 → cx+80)
      // Phase 3: wolf stops, tilts head back, howls
      // Phase 4: wolf runs off right edge
      if (_wfPhase === 0) {
        _wfX += 5.8 * scale;
        _wfDir = 1;
        if (_wfX >= cx - 80 * scale) { _wfPhase = 1; _wfPhaseEnter = _frame; }
      } else if (_wfPhase === 1) {
        // pause ~40 frames, look at viewer
        if (_frame - _wfPhaseEnter >= 40) { _wfPhase = 2; _wfPhaseEnter = _frame; }
      } else if (_wfPhase === 2) {
        _wfX  += 4.2 * scale;
        _wfDir = 1;
        if (_wfX >= cx + 80 * scale) { _wfPhase = 3; _wfPhaseEnter = _frame; }
      } else if (_wfPhase === 3) {
        // howl for ~60 frames
        if (_frame - _wfPhaseEnter >= 60) { _wfPhase = 4; _wfPhaseEnter = _frame; }
      } else if (_wfPhase === 4) {
        _wfX += 7 * scale;
        _wfDir = 1;
      }

      // Ground flames — blue/white for wolf
      for (const f of _wfGroundFlames) {
        const flicker = Math.sin(_frame * f.speed + f.phase) * 0.35 + 0.65;
        const rx = cx + f.x;
        const fh = f.h * flicker;
        const fw = f.w;
        const color1 = cfg.shadowWolf ? 'rgba(0,140,255,0.9)' : 'rgba(60,80,220,0.85)';
        const grad = ctx.createLinearGradient(rx, baseY + 10, rx, baseY + 10 - fh);
        grad.addColorStop(0,   color1);
        grad.addColorStop(0.5, 'rgba(0,40,180,0.5)');
        grad.addColorStop(1,   'rgba(0,0,40,0)');
        ctx.beginPath();
        ctx.ellipse(rx, baseY + 10, fw * 0.5, fh * 0.55, 0, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.globalAlpha = 0.7 * flicker;
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Shadow particle trail
      if (_wfPhase !== 1 && _wfPhase !== 3 && _frame % 4 === 0) {
        _wfShadowTrail.push({
          x: _wfX - _wfDir * 30 * scale,
          y: baseY,
          alpha: 0.5,
          r: 18 * scale,
        });
      }
      for (let i = _wfShadowTrail.length - 1; i >= 0; i--) {
        const t = _wfShadowTrail[i];
        t.alpha -= 0.035;
        t.r     += 1.5;
        if (t.alpha <= 0) { _wfShadowTrail.splice(i, 1); continue; }
        const tg = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, t.r);
        tg.addColorStop(0,   `rgba(0,60,200,${t.alpha})`);
        tg.addColorStop(1,   'rgba(0,0,0,0)');
        ctx.beginPath();
        ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
        ctx.fillStyle = tg;
        ctx.globalAlpha = 1;
        ctx.fill();
      }

      // Lightning following wolf
      if (_wfPhase >= 2 && _frame % 20 === 0) {
        _drawBolt(ctx,
          _wfX - _wfDir * 50 * scale, baseY - wolfScale * 0.8,
          _wfX - _wfDir * 120 * scale, baseY - wolfScale * 0.2,
          '#aaccff', 2, 0.8, 5);
      }

      // Draw wolf
      const howling  = _wfPhase === 3;
      const legSpeed = (_wfPhase === 1 || _wfPhase === 3) ? 0 : _frame * 0.32;
      const tailPh   = _frame * 0.14;
      const headTilt = _wfPhase === 1
        ? Math.sin(_frame * 0.08) * 0.3   // looking at viewer
        : Math.sin(_frame * 0.15) * 0.1;

      ctx.save();
      ctx.translate(_wfX, baseY);
      ctx.scale(_wfDir, 1);
      // aura
      const waura = ctx.createRadialGradient(0, 0, 10, 0, 0, 90 * scale);
      waura.addColorStop(0,   'rgba(0,80,200,0.18)');
      waura.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.arc(0, 0, 90 * scale, 0, Math.PI * 2);
      ctx.fillStyle = waura;
      ctx.globalAlpha = 1;
      ctx.fill();
      _drawWolf(ctx, wolfScale, legSpeed, tailPh, headTilt, howling);
      ctx.restore();

      // Howl energy rings
      if (howling && _frame % 8 === 0) {
        const rx = _wfX;
        const ry = baseY - wolfScale * 0.7;
        for (let r = 0; r < 3; r++) {
          ctx.beginPath();
          ctx.arc(rx, ry, (20 + r * 30) * scale + (_frame % 30) * scale, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(100,160,255,0.4)';
          ctx.lineWidth = 2;
          ctx.globalAlpha = 0.5 - r * 0.12;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }
    // ── End Shadow Wolf ───────────────────────────────────

    // ════════════════════════════════════════
    //  SHADOW DRAGON  full animated scene
    // ════════════════════════════════════════
    if (cfg.dragon || cfg.shadowDragon) {
      const dragonScale = 52 * scale;
      const centerY     = cy - lh * 0.06;

      // Phase 0: dragon flies in from right
      // Phase 1: hover at center, breathe fire, lightning
      // Phase 2: fly off left
      if (_drPhase === 0) {
        _drX  -= 5.2 * scale;
        _drDir = -1;
        if (_drX <= cx + 80 * scale) { _drPhase = 1; _drPhaseEnter = _frame; }
      } else if (_drPhase === 1) {
        // hover: slow vertical oscillation
        _drY = Math.sin(_frame * 0.04) * 18 * scale;
        // start a fire breath ~30 frames in, then again at ~90 frames
        const frameInPhase = _frame - _drPhaseEnter;
        if ((frameInPhase === 30 || frameInPhase === 90) && _drFireLen === 0) _drFireLen = 0.01;
        if (_drFireLen > 0) {
          _drFireLen = Math.min(1, _drFireLen + 0.055);
          if (_drFireLen >= 1) { _drFireLen = 0; }
        }
        if (frameInPhase >= 130) { _drPhase = 2; _drPhaseEnter = _frame; }
      } else if (_drPhase === 2) {
        _drX  -= 6.5 * scale;
        _drDir = -1;
      }

      _drBodyWave += 0.055;
      _drWingFlap += 0.12;

      // Wing glow aura
      const daura = ctx.createRadialGradient(_drX, centerY + _drY, 20, _drX, centerY + _drY, 160 * scale);
      daura.addColorStop(0,   'rgba(80,0,200,0.22)');
      daura.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.arc(_drX, centerY + _drY, 160 * scale, 0, Math.PI * 2);
      ctx.fillStyle = daura;
      ctx.globalAlpha = 1;
      ctx.fill();

      // Lightning surrounding dragon
      if (_drPhase >= 1 && _frame % 15 === 0) {
        const la = Math.random() * Math.PI * 2;
        _drawBolt(ctx,
          _drX + Math.cos(la) * 60 * scale, centerY + _drY + Math.sin(la) * 40 * scale,
          _drX + Math.cos(la) * 150 * scale, centerY + _drY + Math.sin(la) * 100 * scale,
          '#cc44ff', 1.5, 0.85, 5);
      }

      ctx.save();
      ctx.translate(_drX, centerY + _drY);
      ctx.scale(_drDir, 1);
      _drawDragon(ctx, dragonScale, _drWingFlap, _drBodyWave, _drFireLen);
      ctx.restore();
    }
    // ── End Shadow Dragon ─────────────────────────────────

    // ════════════════════════════════════════
    //  BLACK CROWS  standalone gift
    // ════════════════════════════════════════
    if (cfg.blackCrows) {
      for (const flock of _bcFlocks) {
        if (_frame < flock.delay) continue;
        for (const bird of flock.birds) {
          bird.x    += bird.speed;
          bird.flap += bird.flapSpd;
          bird.y    += Math.sin(_frame * 0.04 + bird.waveOff) * 0.8;  // undulating flight
          // reset when off screen
          if (bird.speed > 0 && bird.x > lw + 100) bird.x = -100;
          if (bird.speed < 0 && bird.x < -100)     bird.x = lw + 100;

          const wO = (Math.sin(bird.flap) + 1) * 0.5;
          const flip = bird.speed > 0 ? 1 : -1;
          ctx.save();
          ctx.translate(bird.x, bird.y);
          ctx.scale(flip * scale, scale);
          ctx.globalAlpha = 0.9;
          _drawCrow(ctx, bird.size, wO, '#0099ff');
          ctx.restore();
        }
      }
    }
    // ── End Black Crows ───────────────────────────────────

    // ════════════════════════════════════════
    //  LEGENDARY LION  — mountain run scene
    // ════════════════════════════════════════
    if (cfg.legendaryLion) {
      // Lion runs at 60% of screen height (on the ridge)
      const baseY = lh * 0.60;

      // ── Atmospheric sky gradient (distant haze) ───────────────
      const skyGrad = ctx.createLinearGradient(0, 0, 0, baseY);
      skyGrad.addColorStop(0,    'rgba(80,30,0,0.55)');
      skyGrad.addColorStop(0.5,  'rgba(140,60,0,0.30)');
      skyGrad.addColorStop(1,    'rgba(0,0,0,0)');
      ctx.fillStyle   = skyGrad;
      ctx.globalAlpha = 1;
      ctx.fillRect(0, 0, lw, baseY);

      // ── Far mountain range (parallax layer 1 — slowest) ───────
      const mPara1 = (_frame * 0.18) % lw;
      const drawFarMtns = (offsetX) => {
        ctx.beginPath();
        ctx.moveTo(offsetX, baseY);
        const segW = lw / 5;
        for (let i = 0; i <= 6; i++) {
          const px = offsetX + i * segW;
          const py = baseY - lh * (0.28 + Math.sin(i * 1.3 + 0.5) * 0.10);
          i === 0 ? ctx.moveTo(px, baseY) : ctx.lineTo(px, py);
        }
        ctx.lineTo(offsetX + 6 * segW, baseY);
        ctx.closePath();
        const fmGrad = ctx.createLinearGradient(0, baseY - lh * 0.38, 0, baseY);
        fmGrad.addColorStop(0,   'rgba(60,25,5,0.75)');
        fmGrad.addColorStop(1,   'rgba(20,8,0,0.85)');
        ctx.fillStyle   = fmGrad;
        ctx.globalAlpha = 0.7;
        ctx.fill();
      };
      drawFarMtns(-mPara1);
      if (lw - mPara1 < lw) drawFarMtns(lw - mPara1);
      ctx.globalAlpha = 1;

      // ── Mid mountain range (parallax layer 2) ─────────────────
      const mPara2 = (_frame * 0.35) % lw;
      const drawMidMtns = (offsetX) => {
        ctx.beginPath();
        ctx.moveTo(offsetX, baseY);
        const segW = lw / 4;
        for (let i = 0; i <= 5; i++) {
          const px = offsetX + i * segW;
          const py = baseY - lh * (0.18 + Math.sin(i * 1.9 + 1.1) * 0.09);
          i === 0 ? ctx.moveTo(px, baseY) : ctx.lineTo(px, py);
        }
        ctx.lineTo(offsetX + 5 * segW, baseY);
        ctx.closePath();
        const mmGrad = ctx.createLinearGradient(0, baseY - lh * 0.27, 0, baseY);
        mmGrad.addColorStop(0,   'rgba(45,18,3,0.85)');
        mmGrad.addColorStop(1,   'rgba(15,5,0,0.90)');
        ctx.fillStyle   = mmGrad;
        ctx.globalAlpha = 0.85;
        ctx.fill();
      };
      drawMidMtns(-mPara2);
      if (lw - mPara2 < lw) drawMidMtns(lw - mPara2);
      ctx.globalAlpha = 1;

      // ── Ground ridge beneath the lion ─────────────────────────
      const ridgeGrad = ctx.createLinearGradient(0, baseY - 8, 0, baseY + lh * 0.06);
      ridgeGrad.addColorStop(0,   '#3d1a00');
      ridgeGrad.addColorStop(0.4, '#1e0a00');
      ridgeGrad.addColorStop(1,   '#080200');
      ctx.fillStyle   = ridgeGrad;
      ctx.globalAlpha = 1;
      ctx.fillRect(0, baseY - 8, lw, lh - baseY + 8);

      // ── Ambient warm sun glow from top-right ──────────────────
      const sunGlow = ctx.createRadialGradient(lw * 0.8, lh * 0.12, 0, lw * 0.8, lh * 0.12, lw * 0.65);
      sunGlow.addColorStop(0,   'rgba(255,140,20,0.22)');
      sunGlow.addColorStop(0.5, 'rgba(200,80,0,0.08)');
      sunGlow.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.arc(lw * 0.8, lh * 0.12, lw * 0.65, 0, Math.PI * 2);
      ctx.fillStyle   = sunGlow;
      ctx.globalAlpha = 1;
      ctx.fill();

      // ── Move lion ─────────────────────────────────────────────
      const lionSpeed = isMobile ? 3.8 : 5.2;
      _llX += lionSpeed;

      // Vertical body bob — natural running bounce
      _llY = Math.sin(_frame * 0.32) * 5 * scale;

      // ── Dust puffs — spawn under paws every ~10 frames ───────
      if (_frame % 10 === 0 && _llX > 0 && _llX < lw + 100) {
        const dustCount = isMobile ? 1 : 2;
        for (let d = 0; d < dustCount; d++) {
          _llDustPuffs.push({
            x:     _llX + (Math.random() - 0.5) * 30 * scale,
            y:     baseY + 4,
            r:     4 + Math.random() * 5,
            alpha: 0.45,
            vx:    (Math.random() - 0.6) * 1.2,
            vy:    -(0.4 + Math.random() * 0.5),
          });
        }
      }

      // Draw and age dust puffs
      for (let i = _llDustPuffs.length - 1; i >= 0; i--) {
        const dp = _llDustPuffs[i];
        dp.x     += dp.vx;
        dp.y     += dp.vy;
        dp.r     += 0.8;
        dp.alpha -= 0.022;
        if (dp.alpha <= 0) { _llDustPuffs.splice(i, 1); continue; }
        const dpGrad = ctx.createRadialGradient(dp.x, dp.y, 0, dp.x, dp.y, dp.r);
        dpGrad.addColorStop(0,   `rgba(160,80,20,${dp.alpha})`);
        dpGrad.addColorStop(1,   'rgba(0,0,0,0)');
        ctx.beginPath();
        ctx.arc(dp.x, dp.y, dp.r, 0, Math.PI * 2);
        ctx.fillStyle   = dpGrad;
        ctx.globalAlpha = 1;
        ctx.fill();
      }

      // ── Draw the lion ──────────────────────────────────────────
      const lionScale = isMobile ? 38 * scale : 52;
      const legPh     = _frame * 0.30;
      const tailPh    = _frame * 0.13;
      const headBob   = Math.sin(_frame * 0.30);
      const maneWv    = _frame * 0.18;

      ctx.save();
      ctx.translate(_llX, baseY + _llY);

      // Warm sunlit aura around lion
      const laura = ctx.createRadialGradient(0, -lionScale * 0.2, 5, 0, -lionScale * 0.2, lionScale * 1.6);
      laura.addColorStop(0,   'rgba(220,110,20,0.18)');
      laura.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.arc(0, -lionScale * 0.2, lionScale * 1.6, 0, Math.PI * 2);
      ctx.fillStyle   = laura;
      ctx.globalAlpha = 1;
      ctx.fill();

      _drawLion(ctx, lionScale, legPh, tailPh, headBob, maneWv);
      ctx.restore();
    }
    // ── End Legendary Lion ────────────────────────────────

    ctx.globalAlpha = 1;
    _snxPremRafs[overlayId] = requestAnimationFrame(tick);
  }
  tick();

  // Auto-dismiss
  setTimeout(() => {
    overlay.classList.remove('active');
    if (_snxPremRafs[overlayId]) { cancelAnimationFrame(_snxPremRafs[overlayId]); delete _snxPremRafs[overlayId]; }
    setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 400);
  }, cfg.duration);
}

function _snxpMakeParticle(w, h, colors) {
  return {
    x: Math.random() * w,
    y: h + Math.random() * 20,
    r: 1 + Math.random() * 3.5,
    vx: (Math.random() - 0.5) * 2,
    vy: -(0.6 + Math.random() * 2),
    alpha: 0.5 + Math.random() * 0.5,
    color: colors[Math.floor(Math.random() * colors.length)],
  };
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

// Exposed so the live.html gift-watch listener can call it when a new gift arrives.
// Accepts an optional giftName + giftArt fallback so the popup still works even
// if the giftId doesn't match the local catalog (e.g. a catalog update was deployed
// between when the gift was sent and when the host's page loaded).
window.snxgShowLiveGiftToast = function(senderName, giftId, fallbackName, fallbackArt) {
  let gift = SNX_GIFT_CATALOG.find(g => g.id === giftId);
  if (!gift) {
    // Catalog lookup failed — build a minimal gift object from the stored transaction data.
    if (!fallbackName && !fallbackArt) {
      console.warn('[SNX GIFT] catalog miss for giftId:', giftId, '— no fallback data, skipping popup');
      return;
    }
    gift = { id: giftId, name: fallbackName || giftId, art: fallbackArt || '🎁', coins: 0 };
    console.warn('[SNX GIFT] catalog miss for giftId:', giftId, '— using fallback art:', gift.art);
  }
  // Always show the live toast banner, then trigger the full animation overlay.
  // stay_legendary uses its own dedicated system; all other gifts use the premium overlay.
  _snxgShowLiveGiftToast(senderName, gift);
  _snxgPlayGiftAnimation(gift, senderName);   // routes to snxgPlayStayLegendary or _snxgPlayPremiumAnimation
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

  if (tab === 'history')  snxgLoadGiftHistory();
  if (tab === 'payouts')  snxgLoadPayoutHistory();
  if (tab === 'exchange') snxgLoadExchangeTab();
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
  if (window._snxRole !== 'founder') return;
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

    // Fetch current Firestore prices so the panel shows live values
    const catalogSnaps = await getDocs(collection(db, 'giftCatalog'));
    const firestorePrices = {};
    catalogSnaps.forEach(d => {
      const data  = d.data();
      const price = typeof data.coins === 'number' ? data.coins
                  : typeof data.coinPrice === 'number' ? data.coinPrice
                  : null;
      if (price !== null && price > 0) firestorePrices[d.id] = price;
    });

    listEl.innerHTML = SNX_GIFT_CATALOG.map(gift => {
      const currentPrice = firestorePrices[gift.id] ?? gift.coins;
      return `
      <div class="ag-gift-row" id="agRow_${gift.id}">
        <div class="ag-gift-art">${gift.art}</div>
        <div class="ag-gift-info">
          <div class="ag-name">${gift.name}</div>
          <div class="ag-price" id="agPrice_${gift.id}">🪙 ${currentPrice.toLocaleString()} coins · ${gift.premium ? '⭐ PREMIUM' : 'Standard'}</div>
        </div>
        <div class="ag-gift-actions" style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">
          <button class="ag-gift-toggle ${gift.enabled ? 'enabled' : 'disabled'}">${gift.enabled ? 'Enabled' : 'Disabled'}</button>
          <button class="ag-edit-price-btn"
            style="font-size:11px;padding:4px 10px;border-radius:7px;background:rgba(0,174,239,0.12);border:1px solid rgba(0,174,239,0.35);color:#00AEEF;cursor:pointer;white-space:nowrap;"
            onclick="snxgAdminTogglePriceEdit('${gift.id}', ${currentPrice})">✏️ Edit Price</button>
          <div id="agPriceEdit_${gift.id}" style="display:none;align-items:center;gap:6px;margin-top:2px;">
            <span style="font-size:11px;color:#9bbdd8;">🪙</span>
            <input type="number" id="agPriceInput_${gift.id}" min="1" max="999999"
              value="${currentPrice}"
              style="width:80px;background:rgba(0,15,40,0.8);border:1px solid rgba(0,174,239,0.4);border-radius:6px;padding:4px 7px;color:#d8eeff;font-size:13px;font-weight:700;outline:none;"
              onkeydown="if(event.key==='Enter')snxgAdminSaveGiftPrice('${gift.id}',this)">
            <button onclick="snxgAdminSaveGiftPrice('${gift.id}',document.getElementById('agPriceInput_${gift.id}'))"
              style="font-size:11px;padding:4px 10px;border-radius:7px;background:rgba(0,174,239,0.18);border:1px solid rgba(0,174,239,0.5);color:#00AEEF;cursor:pointer;font-weight:700;">Save</button>
            <button onclick="snxgAdminTogglePriceEdit('${gift.id}', null)"
              style="font-size:11px;padding:4px 8px;border-radius:7px;background:transparent;border:1px solid rgba(100,130,160,0.35);color:#6a90b8;cursor:pointer;">✕</button>
          </div>
        </div>
      </div>`;
    }).join('');

  } catch(err) {
    console.error('[SNX-GIFTS] adminLoadGifts:', err);
    listEl.innerHTML = '<div class="cs-empty">Failed to load gifts.</div>';
  }
}
window.snxgAdminLoadGifts = snxgAdminLoadGifts;

function snxgAdminTogglePriceEdit(giftId, currentPrice) {
  const editEl = document.getElementById('agPriceEdit_' + giftId);
  if (!editEl) return;
  const isOpen = editEl.style.display !== 'none';
  editEl.style.display = isOpen ? 'none' : 'flex';
  if (!isOpen) {
    // Populate input with current price when opening
    const input = document.getElementById('agPriceInput_' + giftId);
    if (input && currentPrice !== null) input.value = currentPrice;
    if (input) input.focus();
  }
}
window.snxgAdminTogglePriceEdit = snxgAdminTogglePriceEdit;

async function snxgAdminSaveGiftPrice(giftId, inputEl) {
  if (window._snxRole !== 'founder') {
    _snxgToast('⛔ Only the Founder can edit gift prices.');
    return;
  }
  const fs = _snxgDb();
  if (!fs) return;

  const newPrice = Math.floor(Number(inputEl.value));
  if (!Number.isFinite(newPrice) || newPrice < 1) {
    _snxgToast('⚠️ Price must be a positive number (minimum 1 coin).');
    inputEl.focus();
    return;
  }

  const { db, doc, setDoc } = fs;
  const saveBtn = inputEl.nextElementSibling;  // Save button
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  try {
    // Write the new price to Firestore — this is what the gift transaction reads.
    await setDoc(doc(db, 'giftCatalog', giftId), { coins: newPrice }, { merge: true });

    // Patch the in-memory catalog so the gift tray reflects the new price immediately.
    const local = SNX_GIFT_CATALOG.find(g => g.id === giftId);
    if (local) local.coins = newPrice;

    // Update the displayed price in the admin list
    const priceEl = document.getElementById('agPrice_' + giftId);
    if (priceEl) {
      const gift = SNX_GIFT_CATALOG.find(g => g.id === giftId);
      const badge = gift?.premium ? '⭐ PREMIUM' : 'Standard';
      priceEl.textContent = `🪙 ${newPrice.toLocaleString()} coins · ${badge}`;
    }

    // Close the edit row
    snxgAdminTogglePriceEdit(giftId, null);

    _snxgToast(`✅ Price updated to 🪙 ${newPrice.toLocaleString()} coins.`);
    console.log('[SNX-GIFTS] Gift price updated:', giftId, '→', newPrice, 'coins');
  } catch(err) {
    console.error('[SNX-GIFTS] adminSaveGiftPrice:', err);
    _snxgToast('❌ Failed to save price: ' + (err.message || 'unknown error'));
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  }
}
window.snxgAdminSaveGiftPrice = snxgAdminSaveGiftPrice;

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
   EXCHANGE TAB — convert earned coins → shadow coins
   ══════════════════════════════════════════════════ */

/**
 * Load the exchange tab: fetch current availableCoins (earned) and shadowCoins balances
 * and display them so the user can see how much they have to convert.
 */
async function snxgLoadExchangeTab() {
  const user = _snxgUser();
  if (!user) return;
  const fs = _snxgDb();
  if (!fs) return;

  const { db, doc, getDoc } = fs;
  const earnedEl = document.getElementById('csExchangeEarnedBal');
  const shadowEl = document.getElementById('csExchangeShadowBal');
  const btn      = document.getElementById('csExchangeBtn');
  const note     = document.getElementById('csExchangeNote');

  if (earnedEl) earnedEl.textContent = '…';
  if (shadowEl) shadowEl.textContent = '…';
  if (note) note.style.display = 'none';

  try {
    const [earnSnap, walletSnap] = await Promise.all([
      getDoc(doc(db, 'creatorEarnings', user.uid)),
      getDoc(doc(db, 'wallets',         user.uid)),
    ]);

    const earn   = earnSnap.exists()   ? earnSnap.data()   : {};
    const wallet = walletSnap.exists() ? walletSnap.data() : {};

    const available   = typeof earn.availableCoins   === 'number' ? Math.floor(earn.availableCoins)   : 0;
    const _rawSC      = wallet.shadowCoins;
    const shadowCoins = Math.floor(Number.isFinite(Number(_rawSC)) ? Number(_rawSC) : 0);

    if (earnedEl) earnedEl.textContent = available.toLocaleString();
    if (shadowEl) shadowEl.textContent = shadowCoins.toLocaleString();

    // Disable convert button if nothing to convert
    if (btn) btn.disabled = (available <= 0);
    if (available <= 0 && note) {
      note.className    = 'cs-status-msg info';
      note.textContent  = 'You have no earned coins available to convert yet. Earn coins by receiving gifts!';
      note.style.display = 'block';
    }
  } catch (err) {
    console.error('[SNX-EXCHANGE] loadExchangeTab error:', err);
    if (earnedEl) earnedEl.textContent = '—';
    if (shadowEl) shadowEl.textContent = '—';
    if (note) {
      note.className = 'cs-status-msg error';
      note.textContent = 'Could not load balances. Please try again.';
      note.style.display = 'block';
    }
  }
}
window.snxgLoadExchangeTab = snxgLoadExchangeTab;

/**
 * Set the conversion amount input to the user's full available balance.
 */
function snxgExchangeSetMax() {
  const earnedEl = document.getElementById('csExchangeEarnedBal');
  const input    = document.getElementById('csExchangeAmount');
  if (!earnedEl || !input) return;
  const available = parseInt(earnedEl.textContent.replace(/,/g, ''), 10) || 0;
  input.value = available > 0 ? available : '';
}
window.snxgExchangeSetMax = snxgExchangeSetMax;

/**
 * Atomically convert earned coins → shadow coins.
 *
 * Security:
 *  - Reads both balances inside a Firestore transaction (server-authoritative).
 *  - Verifies actual availableCoins on the server before deducting.
 *  - Both writes (deduct earned, credit shadow) succeed together or neither does.
 *  - In-flight lock (_snxgConverting) prevents double-clicks within the same tab.
 *  - Firestore transaction serialization prevents concurrent multi-tab races.
 */
let _snxgConverting = false;

async function snxgConvertEarnedCoins() {
  if (_snxgConverting) return;

  const user = _snxgUser();
  if (!user) { _snxgToast('Please sign in first.'); return; }

  const fs = _snxgDb();
  if (!fs) { _snxgToast('Firebase not ready. Please reload.'); return; }

  const input  = document.getElementById('csExchangeAmount');
  const btn    = document.getElementById('csExchangeBtn');
  const note   = document.getElementById('csExchangeNote');

  const rawVal = input ? parseInt(input.value, 10) : NaN;
  if (!rawVal || rawVal <= 0 || !Number.isFinite(rawVal)) {
    if (note) { note.className = 'cs-status-msg error'; note.textContent = 'Enter a valid number of coins to convert.'; note.style.display = 'block'; }
    return;
  }
  const amount = Math.floor(rawVal);  // integer only

  _snxgConverting = true;
  if (btn)  { btn.disabled = true; btn.textContent = '🔄 Converting…'; }
  if (note) { note.className = 'cs-status-msg info'; note.textContent = 'Processing conversion…'; note.style.display = 'block'; }

  const { db, doc, runTransaction, serverTimestamp } = fs;

  const earnRef   = doc(db, 'creatorEarnings', user.uid);
  const walletRef = doc(db, 'wallets',         user.uid);

  // Conversion rate: 1 earned coin = 1 shadow coin (1:1)
  const CONVERSION_RATE = 1;

  try {
    await runTransaction(db, async (tx) => {

      // ── READ 1: earned coins (server-authoritative) ──
      const earnSnap = await tx.get(earnRef);
      const earn     = earnSnap.exists() ? earnSnap.data() : {};
      const available = typeof earn.availableCoins === 'number' ? earn.availableCoins : 0;

      // ── READ 2: wallet ──
      const walletSnap    = await tx.get(walletRef);
      const walletData    = walletSnap.exists() ? walletSnap.data() : {};
      const currentShadow = typeof walletData.shadowCoins === 'number' ? walletData.shadowCoins : 0;

      console.log('[COIN EXCHANGE]', {
        userUID:          user.uid,
        eligibleBalance:  available,
        exchangeAmount:   amount,
        conversionRate:   `${CONVERSION_RATE}:1`,
        shadowCoinsBefore: currentShadow,
        earnedDocExists:  earnSnap.exists(),
        walletDocExists:  walletSnap.exists(),
        firebasePath_earn:   `creatorEarnings/${user.uid}`,
        firebasePath_wallet: `wallets/${user.uid}`,
      });

      if (amount > available) {
        throw new Error('insufficient_earned');
      }
      if (available <= 0) {
        throw new Error('insufficient_earned');
      }

      const newAvailable = available - amount;                      // may be 0, never negative
      const newShadow    = currentShadow + (amount * CONVERSION_RATE);  // always increases

      // ── WRITE 1: deduct availableCoins from creatorEarnings ──
      // Use update() — only change availableCoins and lastConversionAt.
      // All other fields (pendingCoins, lifetimeCoins, platformCoins, uid) remain unchanged.
      // The doc must exist here because we verified available > 0 above.
      tx.update(earnRef, {
        availableCoins:   newAvailable,
        lastConversionAt: serverTimestamp(),
      });

      // ── WRITE 2: credit shadowCoins in wallet ──
      if (walletSnap.exists()) {
        tx.update(walletRef, {
          shadowCoins:      newShadow,
          lastConversionAt: serverTimestamp(),
        });
      } else {
        // Wallet doesn't exist yet — create it.
        tx.set(walletRef, {
          uid:              user.uid,
          shadowCoins:      newShadow,
          lastConversionAt: serverTimestamp(),
        });
      }
    });

    // Transaction committed — update the UI
    console.log('[SNX-EXCHANGE] ✅ converted', amount, 'earned coins →', amount * CONVERSION_RATE, 'shadow coins | uid:', user.uid);

    if (note) {
      note.className = 'cs-status-msg success';
      note.textContent = `✅ Converted ${amount.toLocaleString()} coins! Your Shadow Coin balance has been updated.`;
      note.style.display = 'block';
    }
    if (input) input.value = '';
    _snxgToast(`🔄 ${amount.toLocaleString()} Shadow Coins added to your balance!`);

    // Refresh the displayed balances
    await snxgLoadExchangeTab();

  } catch (err) {
    console.error('[COIN EXCHANGE] ❌ Transaction result: FAILED', {
      userUID:       user.uid,
      exchangeAmount: amount,
      firebaseError: err.code || 'no-code',
      errorMessage:  err.message,
    });

    let msg;
    if (err.message === 'insufficient_earned') {
      msg = 'Not enough earned coins to convert. Earn more by receiving gifts!';
    } else if (err.code === 'permission-denied') {
      msg = 'Conversion blocked (permission-denied). Please reload and try again.';
    } else if (err.code === 'unavailable' || err.code === 'deadline-exceeded') {
      msg = 'Network issue — conversion was not completed. Please try again.';
    } else if (err.code === 'aborted') {
      msg = 'Transaction conflict — please try again.';
    } else {
      msg = `Conversion failed [${err.code || 'error'}]: ${(err.message || '').slice(0, 80)}`;
    }

    if (note) { note.className = 'cs-status-msg error'; note.textContent = msg; note.style.display = 'block'; }
  } finally {
    _snxgConverting = false;
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Convert to Shadow Coins'; }
  }
}
window.snxgConvertEarnedCoins = snxgConvertEarnedCoins;

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
   FOUNDER COIN TESTING — Grant up to 50,000 test coins
   ══════════════════════════════════════════════════ */

// Selected recipient for test grant
let _ctgSelectedUid  = null;
let _ctgSelectedName = null;
let _ctgGranting     = false;

/**
 * Called when the Coin Testing tab is opened.
 * Loads the current testCoinGrantsEnabled state from siteSettings/config and
 * updates the toggle UI. Frontend gate: founderOnly().
 */
function snxgLoadCoinTestingTab() {
  if (window._snxRole !== 'founder') return;
  _ctgResetSelection();
  _ctgLoadGrantLog();
  _ctgLoadEnabledState();
}
window.snxgLoadCoinTestingTab = snxgLoadCoinTestingTab;

/**
 * Read siteSettings/config.testCoinGrantsEnabled from Firestore and update the toggle.
 */
async function _ctgLoadEnabledState() {
  if (window._snxRole !== 'founder') return;
  const fs = _snxgDb();
  if (!fs) return;
  const statusEl = document.getElementById('ctgEnabledStatus');
  const toggleEl = document.getElementById('ctgEnabledToggle');
  try {
    const snap = await fs.getDoc(fs.doc(fs.db, 'siteSettings', 'config'));
    const enabled = snap.exists() && snap.data().testCoinGrantsEnabled === true;
    if (toggleEl) toggleEl.checked = enabled;
    if (statusEl) {
      statusEl.textContent = enabled ? '✅ ON — grants are allowed' : '🔴 OFF — grants are blocked';
      statusEl.style.color  = enabled ? '#39FF14' : '#ff6677';
    }
  } catch (err) {
    console.error('[SNX-CTG] Could not read testCoinGrantsEnabled:', err);
    if (statusEl) statusEl.textContent = 'Could not load setting.';
  }
}

/**
 * Founder-only: save testCoinGrantsEnabled to siteSettings/config.
 * Called by the toggle checkbox onchange handler.
 */
async function snxgSetTestCoinGrantsEnabled(enabled) {
  if (window._snxRole !== 'founder') return;
  const fs = _snxgDb();
  if (!fs) return;
  const statusEl = document.getElementById('ctgEnabledStatus');
  const toggleEl = document.getElementById('ctgEnabledToggle');
  try {
    if (statusEl) { statusEl.textContent = 'Saving…'; statusEl.style.color = '#4a7a9a'; }
    await fs.setDoc(fs.doc(fs.db, 'siteSettings', 'config'), { testCoinGrantsEnabled: enabled }, { merge: true });
    if (statusEl) {
      statusEl.textContent = enabled ? '✅ ON — grants are allowed' : '🔴 OFF — grants are blocked';
      statusEl.style.color  = enabled ? '#39FF14' : '#ff6677';
    }
    _snxgToast(enabled ? '✅ Test Coin Grants enabled' : '🔴 Test Coin Grants disabled');
  } catch (err) {
    console.error('[SNX-CTG] Failed to save testCoinGrantsEnabled:', err);
    // Revert the toggle to its previous state
    if (toggleEl) toggleEl.checked = !enabled;
    if (statusEl) { statusEl.textContent = 'Save failed. Try again.'; statusEl.style.color = '#ff6677'; }
    _snxgToast('Failed to save setting. Please try again.');
  }
}
window.snxgSetTestCoinGrantsEnabled = snxgSetTestCoinGrantsEnabled;

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
  const balEl  = document.getElementById('ctgUserBalance');
  const status = document.getElementById('ctgGrantStatus');
  const btn    = document.getElementById('ctgGrantBtn');

  if (nameEl) nameEl.textContent = name;
  if (uidEl)  uidEl.textContent  = uid;
  if (avEl)   avEl.src           = avatar || '';
  if (area)   area.style.display = 'block';
  if (status) status.style.display = 'none';
  if (btn)    { btn.disabled = false; btn.textContent = '🪙 Grant Test Coins'; }
  if (balEl)  balEl.textContent = '…';

  // Clear results
  const resultsEl = document.getElementById('ctgUserResults');
  if (resultsEl) resultsEl.innerHTML = '';
  const input = document.getElementById('ctgSearchInput');
  if (input) input.value = '';

  // Fetch recipient's current wallet balance — bypass cache so we always see the live value
  const fs = _snxgDb();
  if (fs) {
    const { db, doc, getDocFromServer, getDoc } = fs;
    const _readWallet = getDocFromServer || getDoc;  // getDocFromServer forces a fresh server read
    _readWallet(doc(db, 'wallets', uid)).then(snap => {
      if (balEl) {
        const _raw = snap.exists() ? snap.data().shadowCoins : 0;
        const coins = Number(_raw);
        balEl.textContent = (Number.isFinite(coins) && coins >= 0) ? Math.floor(coins).toLocaleString() : '0';
      }
    }).catch(() => {
      if (balEl) balEl.textContent = '—';
    });
  }
}
window.snxgCoinTestSelectUser = snxgCoinTestSelectUser;

function _ctgResetSelection() {
  _ctgSelectedUid  = null;
  _ctgSelectedName = null;
  const area = document.getElementById('ctgGrantArea');
  if (area) area.style.display = 'none';
  const status = document.getElementById('ctgGrantStatus');
  if (status) status.style.display = 'none';
  const balEl = document.getElementById('ctgUserBalance');
  if (balEl) balEl.textContent = '…';
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

  // Read and validate the amount input
  const amountInput = document.getElementById('ctgCoinAmount');
  const rawAmount   = amountInput ? parseInt(amountInput.value, 10) : 500;
  const MAX_GRANT   = 50000;

  if (!rawAmount || isNaN(rawAmount) || rawAmount < 1) {
    _snxgToast('Please enter a valid coin amount (minimum 1).');
    return;
  }
  if (rawAmount > MAX_GRANT) {
    _snxgToast(`Maximum grant is ${MAX_GRANT.toLocaleString()} coins per grant.`);
    const status = document.getElementById('ctgGrantStatus');
    if (status) {
      status.style.display = 'block';
      status.className = 'cs-status-msg error';
      status.textContent = `Amount exceeds the maximum of ${MAX_GRANT.toLocaleString()} coins per grant.`;
    }
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
    if (btn)    { btn.disabled = false; btn.textContent = '🪙 Grant Test Coins'; }
    _ctgGranting = false;
    return;
  }

  try {
    const { ok, data } = await _snxgPaypalPost('/grant-test-coins', {
      idToken,
      recipientUid: _ctgSelectedUid,
      amount:       rawAmount,
      reason: 'LIVE gifting test',
    });

    if (!ok || !data.success) {
      const msg = data?.error || 'Grant failed. Please try again.';
      if (status) { status.className = 'cs-status-msg error'; status.textContent = msg; }
      if (btn)    { btn.disabled = false; btn.textContent = '🪙 Grant Test Coins'; }
    } else {
      if (btn) { btn.disabled = true; btn.textContent = '✓ Granted'; }
      _snxgToast(`🪙 ${data.amount} test coins granted to ${data.recipientName || _ctgSelectedName}!`);
      setTimeout(() => _ctgLoadGrantLog(), 800);

      // Verify the balance was written to Firestore and update the UI
      const recipUid = _ctgSelectedUid;
      const fs = _snxgDb();
      const verifyAndShow = (confirmedBalance) => {
        const _fb = Number(confirmedBalance);
        const _db = Number(data.newBalance);
        const newTotal = Number.isFinite(_fb) && _fb >= 0
          ? Math.floor(_fb)
          : (Number.isFinite(_db) && _db >= 0 ? Math.floor(_db) : 0);
        // Update the balance display in the recipient card
        const balEl = document.getElementById('ctgUserBalance');
        if (balEl) balEl.textContent = (typeof newTotal === 'number' ? newTotal : 0).toLocaleString();
        if (status) {
          status.className = 'cs-status-msg success';
          status.innerHTML = `✅ <strong>${data.amount} test coins</strong> granted to <strong>${data.recipientName || _ctgSelectedName}</strong>`
            + (typeof newTotal === 'number' ? `<br><span style="font-size:11px;color:#c8e8ff;">New balance: <strong>${newTotal.toLocaleString()} 🪙</strong></span>` : '')
            + `<br><span style="font-size:10px;color:#4a7a9a;">TX: ${data.txId} · No cash value</span>`;
        }
      };

      if (fs) {
        // Re-read the wallet from Firestore server (bypass cache) to confirm the write landed
        const { db, doc, getDocFromServer, getDoc } = fs;
        const _readWallet = getDocFromServer || getDoc;  // prefer server read to bypass stale cache
        _readWallet(doc(db, 'wallets', recipUid)).then(snap => {
          const confirmed = snap.exists() ? snap.data().shadowCoins : data.newBalance;
          verifyAndShow(confirmed);
        }).catch(() => {
          verifyAndShow(data.newBalance);
        });
      } else {
        verifyAndShow(data.newBalance);
      }
    }
  } catch (err) {
    console.error('[SNX-CTG] grant error:', err);
    if (status) { status.className = 'cs-status-msg error'; status.textContent = 'Network error. Please try again.'; }
    if (btn)    { btn.disabled = false; btn.textContent = '🪙 Grant Test Coins'; }
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
// Initialise as soon as auth is resolved.
//
// Both this module and the page's inline Firebase module are ES modules, so
// they execute concurrently after the document is parsed.  The inline module
// sets window._snxOnAuthReady synchronously at its top level (before any
// await), so it is usually available by the time this module's top-level code
// runs.  If it is not yet available, the polling fallback is used instead.
//
// The polling fallback previously checked `window._snxCurrentUser !== undefined`
// which could fire too early (before auth resolved) on browsers where the
// property happened to be set to undefined by another script.  The correct
// check is `window._snxAuthResolved === true` which is only set by the page's
// inline module AFTER onAuthStateChanged has fired and the user object is
// fully populated.
if (typeof window._snxOnAuthReady === 'function') {
  window._snxOnAuthReady(() => {
    snxgInit();
  });
} else {
  // Fallback: poll until the inline Firebase module sets _snxAuthResolved.
  const _pollAuth = setInterval(() => {
    if (window._snxAuthResolved === true) {
      clearInterval(_pollAuth);
      snxgInit();
    }
  }, 200);
}
