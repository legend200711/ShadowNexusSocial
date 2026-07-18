/**
 * Shadow Nexus Live — live.js  v4
 *
 * Auth model
 *   VIEWER  → anonymous Firebase auth (no account needed)
 *   HOST    → Shadow Nexus Social account session, shared automatically
 *             via Firebase browserLocalPersistence.  When a user is
 *             already signed in on index.html the live page picks up
 *             the same session — no second login required.
 *
 * Session handoff from index.html
 *   index.html sets localStorage key  snx_live_intent = 'golive'
 *   when the user clicks 🔴 GO LIVE.  The live page reads this once
 *   on boot to skip the viewer path and jump straight to setup.
 *
 * Security
 *   - Only signed-in (non-anonymous) accounts can start a stream
 *   - createRoom() enforces this + prevents duplicate streams per user
 *   - endRoom() is only callable by the original host
 */

import {
  onAuthReady, ensureAnonAuth, loadMyProfile,
  createRoom, getRoom, joinRoom, leaveRoom, endRoom, watchRoom,
  sendMessage, watchMessages, sendLike, watchLikes,
  publishGuestOffer, publishGuestAnswer, publishGuestIce,
  watchGuestOffer, watchGuestAnswer, watchGuestIce,
  watchGuestList, removeGuestSignal,
  _auth, _db
} from './firebase-live.js';

import {
  signInWithEmailAndPassword
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';

import {
  getDoc, doc,
  collection, query, where, orderBy, onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

import {
  getLocalStream, stopLocalStream,
  toggleCamera, toggleMic, flipCamera,
  isCamEnabled, isMicEnabled,
  HostPeerManager, GuestPeerManager,
  probeNetwork, MAX_GUESTS
} from './webrtc.js';

/* ═══════════════════════════════════════════════
   CONSTANTS
════════════════════════════════════════════════ */
const SPAM_WINDOW = 5000;
const SPAM_MAX    = 5;

/* ═══════════════════════════════════════════════
   STATE
════════════════════════════════════════════════ */
const S = {
  // Identity
  firebaseUser:  null,   // Firebase auth user (anon or full)
  profile:       null,   // SNS profile { uid, displayName, username, avatar, followers, role } or null
  viewerName:    '',     // name for anonymous viewers

  // Room
  roomId:        null,
  roomData:      null,
  role:          null,   // 'host' | 'guest' | 'viewer'
  isLive:        false,

  // WebRTC
  hostPeer:      null,
  guestPeer:     null,
  guestStreams:  {},

  // Timers / subs
  timerRef:      null,
  startTime:     null,
  unsubRoom:     null,
  unsubMsgs:     null,
  unsubGuests:   null,
  unsubLikes:    null,
  unsubIce:      {},

  // Chat
  spamLog:       [],
  chatLog:       [],

  // Setup
  setupStream:   null,
  setupCamOn:    true,
  setupMicOn:    true,
};

/* ═══════════════════════════════════════════════
   DOM
════════════════════════════════════════════════ */
const el   = id => document.getElementById(id);
const dom  = {
  // Loading
  loadingScreen:     el('loadingScreen'),
  loadHint:          el('loadHint'),

  // Discovery
  discLiveList:      el('discLiveList'),
  discLiveCount:     el('discLiveCount'),
  discEmpty:         el('discEmpty'),
  // Auth gate
  authGate:          el('authGate'),
  authViewer:        el('authViewer'),
  authAccount:       el('authAccount'),
  viewerName:        el('viewerName'),
  viewerErr:         el('viewerErr'),
  btnWatchNow:       el('btnWatchNow'),
  btnSwitchToAcct:   el('btnSwitchToAccount'),
  acctEmail:         el('acctEmail'),
  acctPassword:      el('acctPassword'),
  acctErr:           el('acctErr'),
  btnSignInAcct:     el('btnSignInAcct'),
  btnBackToViewer:   el('btnBackToViewer'),
  // App shell
  app:               el('app'),
  // Top bar
  barAvatar:         el('barAvatar'),
  barUserName:       el('barUserName'),
  barUserHandle:     el('barUserHandle'),
  barAccount:        el('barAccount'),
  barTimer:          el('barTimer'),
  barLivePill:       el('barLivePill'),
  // Screens
  screenHome:        el('screenHome'),
  screenSetup:       el('screenSetup'),
  screenLive:        el('screenLive'),
  screenGuest:       el('screenGuestJoin'),
  // Home
  btnStartLive:      el('btnStartLive'),
  heroAnonMsg:       el('heroAnonMsg'),
  heroSignInLink:    el('heroSignInLink'),
  // Setup — creator identity bar
  cibAvatar:         el('cibAvatar'),
  cibName:           el('cibName'),
  cibHandle:         el('cibHandle'),
  cibFollow:         el('cibFollow'),
  // Setup
  camPreview:        el('camPreview'),
  camPreviewOff:     el('camPreviewOff'),
  setupToggleCam:    el('setupToggleCam'),
  setupToggleMic:    el('setupToggleMic'),
  setupFlipCam:      el('setupFlipCam'),
  setupTitle:        el('setupTitle'),
  setupCategory:     el('setupCategory'),
  setupGuestPerm:    el('setupGuestPerm'),
  setupChat:         el('setupChat'),
  setupNetDot:       el('setupNetDot'),
  setupNetLabel:     el('setupNetLabel'),
  btnGoLive:         el('btnGoLive'),
  btnSetupBack:      el('btnSetupBack'),
  // Live room
  videoArena:        el('videoArena'),
  hudHostAvatar:     el('hudHostAvatar'),
  hudHostName:       el('hudHostName'),
  hudHostHandle:     el('hudHostHandle'),
  hudStreamTitleText:el('hudStreamTitleText'),
  hudViewers:        el('hudViewers'),
  hudLikes:          el('hudLikes'),
  hudTimer:          el('hudTimer'),
  hostToolbar:       el('hostToolbar'),
  guestToolbar:      el('guestToolbar'),
  viewerToolbar:     el('viewerToolbar'),
  guestPanel:        el('guestPanel'),
  guestPanelList:    el('guestPanelList'),
  tbCam:             el('tbCam'),
  tbMic:             el('tbMic'),
  tbFlip:            el('tbFlip'),
  tbInvite:          el('tbInvite'),
  tbGuests:          el('tbGuests'),
  tbFullscreen:      el('tbFullscreen'),
  tbEnd:             el('tbEnd'),
  gtCam:             el('gtCam'),
  gtMic:             el('gtMic'),
  gtFlip:            el('gtFlip'),
  gtFullscreen:      el('gtFullscreen'),
  gtLeave:           el('gtLeave'),
  vtLike:            el('vtLike'),
  vtShare:           el('vtShare'),
  vtFullscreen:      el('vtFullscreen'),
  vtReport:          el('vtReport'),
  vtLeave:           el('vtLeave'),
  chatPanel:         el('chatPanel'),
  btnChatToggle:     el('btnChatToggle'),
  chatLikeBtn:       el('chatLikeBtn'),
  chatLikeCount:     el('chatLikeCount'),
  chatViewerNum:     el('chatViewerNum'),
  chatList:          el('chatList'),
  chatInput:         el('chatInput'),
  chatEmoji:         el('chatEmoji'),
  chatSend:          el('chatSend'),
  emojiPicker:       el('emojiPicker'),
  reactionBurst:     el('reactionBurst'),
  // Dialogs
  endDialog:         el('endDialog'),
  dialogTitle:       el('dialogTitle'),
  dialogMsg:         el('dialogMsg'),
  btnDialogCancel:   el('btnDialogCancel'),
  btnDialogConfirm:  el('btnDialogConfirm'),
  inviteDialog:      el('inviteDialog'),
  inviteCodeDisplay: el('inviteCodeDisplay'),
  btnCopyCode:       el('btnCopyCode'),
  btnCloseInvite:    el('btnCloseInvite'),
  // Guest join
  guestCodeInput:    el('guestCodeInput'),
  guestToggleCam:    el('guestToggleCam'),
  guestToggleMic:    el('guestToggleMic'),
  btnGuestJoin:      el('btnGuestJoin'),
  btnGuestBack:      el('btnGuestBack'),
  // Misc
  toastWrap:         el('toastWrap'),
  stormCanvas:       el('stormCanvas'),
};

/* ═══════════════════════════════════════════════
   GUEST REGISTRY (host-side per-guest state)
════════════════════════════════════════════════ */
// uid → { name, avatar, micMuted, camOff }
const _guestRegistry = {};

/* ═══════════════════════════════════════════════
   BOOT
════════════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', boot);

async function boot() {
  initStorm();

  // ── Intent flag written by index.html when the user clicks GO LIVE ──
  const _goLiveIntent = localStorage.getItem('snx_live_intent') === 'golive';
  if (_goLiveIntent) localStorage.removeItem('snx_live_intent');

  // Extract deep-link room ID from hash, e.g. live.html#watch=AB12CD
  const _deepLink = (() => {
    const h = location.hash.replace('#', '');
    if (h.startsWith('watch=')) return h.split('=')[1].toUpperCase().trim();
    return null;
  })();

  setHint('Connecting to Shadow Nexus…');

  onAuthReady(async firebaseUser => {
    hideEl(dom.loadingScreen);

    if (firebaseUser && !firebaseUser.isAnonymous) {
      // ── Full SNS account — session carried over from index.html ──
      S.firebaseUser = firebaseUser;
      setHint('Loading your profile…');
      S.profile = await loadMyProfile();

      if (S.profile) {
        updateTopBarAccount(S.profile);
        showHostUI();
        showApp();
        startDiscovery();   // start live-room watcher

        if (_deepLink) {
          history.replaceState(null, '', location.pathname);
          showScreen('home');
          await handleJoinAsViewer(_deepLink);
        } else if (_goLiveIntent) {
          showScreen('home');
          await openSetup();
        } else {
          showScreen('home');
        }
        return;
      }
    }

    // ── Anonymous / no account ──
    // Silently get anonymous auth so Firestore rules pass,
    // then show the discovery screen directly — no login prompt.
    await ensureAnonViewer();
    startDiscovery();  // auth now ready, start live-room watcher

    if (_deepLink) {
      history.replaceState(null, '', location.pathname);
      await handleJoinAsViewer(_deepLink);
      return;
    }

    if (_goLiveIntent) {
      // Tried to go live but no session — redirect back to SNS to sign in
      toast('Sign in to Shadow Nexus Social first to go live.', 'info');
      setTimeout(() => { window.location.href = 'index.html'; }, 2200);
    }

    showScreen('home');
  });

  setTimeout(() => hideEl(dom.loadingScreen), 4000);
  wireAll();
  setupBackButton();
}

/* Silently sign in anonymously — no UI shown, viewer goes straight to discovery */
async function ensureAnonViewer() {
  await ensureAnonAuth();
  S.firebaseUser = _auth.currentUser;
  const savedName = sessionStorage.getItem('snx_live_viewer') || 'Viewer';
  S.viewerName = savedName;
  updateTopBarViewer(savedName);
  showViewerUI();
  showApp();
}

/* ═══════════════════════════════════════════════
   LIVE DISCOVERY — real-time watcher
   Renders creator cards in screenHome's disc-live-list.
════════════════════════════════════════════════ */
const CAT_LABELS_DISC = {
  general: '🌑 General', music: '🎵 Music', gaming: '🎮 Gaming',
  talk: '💬 Talk', art: '🎨 Art', vibes: '⚡ Vibes',
};

let _discUnsub = null;

function startDiscovery() {
  if (_discUnsub) return;   // already running

  const q = query(
    collection(_db, 'liveRooms'),
    where('status', '==', 'live'),
    orderBy('createdAt', 'desc')
  );

  _discUnsub = onSnapshot(q, snap => {
    const rooms = [];
    snap.forEach(d => rooms.push(d.data()));
    rooms.sort((a, b) => (b.viewers || 0) - (a.viewers || 0));
    renderDiscovery(rooms);
  }, () => renderDiscovery([]));
}

function renderDiscovery(rooms) {
  const list     = dom.discLiveList;
  const countEl  = dom.discLiveCount;
  const emptyEl  = dom.discEmpty;
  if (!list) return;

  const n = rooms.length;
  if (countEl) countEl.textContent = n > 0 ? n + (n === 1 ? ' live' : ' live') : '';

  // Remove stale cards
  const current = new Set(rooms.map(r => r.roomId));
  list.querySelectorAll('.disc-live-card').forEach(c => {
    if (!current.has(c.dataset.rid)) c.remove();
  });

  if (n === 0) {
    if (emptyEl) emptyEl.style.display = '';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  rooms.forEach((room, i) => {
    let card = list.querySelector(`[data-rid="${room.roomId}"]`);
    if (!card) {
      card = buildDiscCard(room);
      const siblings = [...list.querySelectorAll('.disc-live-card')];
      if (i < siblings.length) list.insertBefore(card, siblings[i]);
      else                     list.appendChild(card);
    } else {
      // Live-update viewer count
      const vEl = card.querySelector('.disc-card-viewers');
      if (vEl) vEl.innerHTML = `
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
        ${room.viewers || 0} watching`;
    }
  });
}

function buildDiscCard(room) {
  const av     = room.hostAvatar   || '';
  const name   = room.hostName     || room.hostUsername || 'Creator';
  const handle = room.hostUsername ? '@' + room.hostUsername : '';
  const title  = room.title        || 'Shadow Nexus LIVE';
  const views  = room.viewers      || 0;
  const cat    = CAT_LABELS_DISC[room.category] || '🌑 General';
  const init   = (name[0] || '?').toUpperCase();
  const roomId = room.roomId || '';

  const card = document.createElement('a');
  card.className   = 'disc-live-card';
  card.dataset.rid = roomId;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Watch ${name} live`);

  const avHtml = av
    ? `<img src="${esc(av)}" alt="${esc(name)}" />`
    : esc(init);

  card.innerHTML = `
    <div class="disc-card-av-wrap">
      <div class="disc-card-av">${avHtml}</div>
      <span class="disc-card-badge">● LIVE</span>
    </div>
    <div class="disc-card-info">
      <div class="disc-card-name-row">
        <span class="disc-card-name">${esc(name)}</span>
        ${handle ? `<span class="disc-card-handle">${esc(handle)}</span>` : ''}
      </div>
      <div class="disc-card-title">"${esc(title)}"</div>
      <div class="disc-card-meta">
        <span class="disc-card-viewers">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          ${views} watching
        </span>
        <span class="disc-card-cat">${esc(cat)}</span>
      </div>
    </div>
    <button class="disc-card-watch-btn" data-rid="${esc(roomId)}">WATCH LIVE</button>
  `;

  // Click anywhere on the card or the button — join as viewer
  card.addEventListener('click', e => {
    e.preventDefault();
    handleJoinAsViewer(roomId);
  });

  return card;
}

function setHint(t) { if (dom.loadHint) dom.loadHint.textContent = t; }

/* ═══════════════════════════════════════════════
   AUTH — VIEWER (anonymous)
════════════════════════════════════════════════ */
async function handleWatchNow() {
  const name = dom.viewerName.value.trim();
  if (!name || name.length < 2) {
    dom.viewerErr.textContent = 'Enter at least 2 characters.';
    return;
  }
  dom.btnWatchNow.disabled = true;

  try {
    await ensureAnonAuth();
    S.firebaseUser = _auth.currentUser;
    S.viewerName   = name;
    sessionStorage.setItem('snx_live_viewer', name);

    hideEl(dom.authGate);
    updateTopBarViewer(name);
    showViewerUI();
    showApp();
    showScreen('home');

    // Auto-join deep-linked room if present
    const pendingRoom = sessionStorage.getItem('snx_live_deeplink');
    if (pendingRoom) {
      sessionStorage.removeItem('snx_live_deeplink');
      await handleJoinAsViewer(pendingRoom);
    }
  } catch (e) {
    dom.viewerErr.textContent = 'Error: ' + e.message;
    dom.btnWatchNow.disabled  = false;
  }
}

/* ═══════════════════════════════════════════════
   AUTH — ACCOUNT (email/password, for hosting)
════════════════════════════════════════════════ */
function showAccountLogin() {
  hideEl(dom.authViewer);
  showEl(dom.authAccount);
  dom.acctEmail.focus();
}

function showViewerLogin() {
  hideEl(dom.authAccount);
  showEl(dom.authViewer);
}

async function handleSignInAccount() {
  const email    = dom.acctEmail.value.trim();
  const password = dom.acctPassword.value;
  if (!email || !password) {
    dom.acctErr.textContent = 'Enter your email and password.';
    return;
  }

  dom.btnSignInAcct.disabled     = true;
  dom.btnSignInAcct.textContent  = 'Signing in…';
  dom.acctErr.textContent        = '';

  try {
    await signInWithEmailAndPassword(_auth, email, password);
    S.firebaseUser = _auth.currentUser;

    // Load the SNS profile
    S.profile = await loadMyProfile();
    if (!S.profile) {
      throw new Error('Account found but no Shadow Nexus profile exists. Please sign in at shadownexus.social first.');
    }

    hideEl(dom.authGate);
    updateTopBarAccount(S.profile);
    showHostUI();
    showApp();
    showScreen('home');

    // Auto-join deep-linked room if present
    const pendingRoom = sessionStorage.getItem('snx_live_deeplink');
    if (pendingRoom) {
      sessionStorage.removeItem('snx_live_deeplink');
      await handleJoinAsViewer(pendingRoom);
    }
  } catch (e) {
    let msg = e.message;
    if (msg.includes('user-not-found') || msg.includes('wrong-password') || msg.includes('invalid-credential')) {
      msg = 'Incorrect email or password.';
    } else if (msg.includes('too-many-requests')) {
      msg = 'Too many attempts. Try again later.';
    }
    dom.acctErr.textContent        = msg;
    dom.btnSignInAcct.disabled     = false;
    dom.btnSignInAcct.textContent  = 'SIGN IN & GO LIVE';
  }
}

/* ═══════════════════════════════════════════════
   UI STATE — HOST vs VIEWER
════════════════════════════════════════════════ */
function showHostUI() {
  showEl(dom.btnStartLive);
  hideEl(dom.heroAnonMsg);
}

function showViewerUI() {
  hideEl(dom.btnStartLive);
  showEl(dom.heroAnonMsg);
}

function updateTopBarAccount(profile) {
  setAvatarEl(dom.barAvatar, profile.avatar, profile.displayName);
  dom.barUserName.textContent   = profile.displayName;
  dom.barUserHandle.textContent = profile.username ? '@' + profile.username : '';
  showEl(dom.barAccount);
}

function updateTopBarViewer(name) {
  setAvatarEl(dom.barAvatar, '', name);
  dom.barUserName.textContent   = name;
  dom.barUserHandle.textContent = 'Viewer';
  showEl(dom.barAccount);
}

/* ═══════════════════════════════════════════════
   SCREEN NAVIGATION
════════════════════════════════════════════════ */
function showApp()       { showEl(dom.app); }

function showScreen(name) {
  const map = {
    home:  dom.screenHome,
    setup: dom.screenSetup,
    live:  dom.screenLive,
    guest: dom.screenGuest,
  };
  Object.values(map).forEach(s => hideEl(s));
  showEl(map[name]);
}

/* ═══════════════════════════════════════════════
   HOST SETUP
════════════════════════════════════════════════ */
async function openSetup() {
  if (!S.profile) {
    // User is anonymous — show account login
    showEl(dom.authGate);
    showAccountLogin();
    return;
  }

  // Populate creator identity bar
  setAvatarEl(dom.cibAvatar, S.profile.avatar, S.profile.displayName);
  dom.cibName.textContent   = S.profile.displayName;
  dom.cibHandle.textContent = S.profile.username ? '@' + S.profile.username : '';
  dom.cibFollow.textContent = S.profile.followers.length
    ? S.profile.followers.length + ' followers'
    : '';

  showScreen('setup');
  await startSetupCamera();
  checkNet();
}

async function startSetupCamera() {
  S.setupCamOn = true;
  S.setupMicOn = true;
  try {
    S.setupStream = await getLocalStream(true, true);
    dom.camPreview.srcObject = S.setupStream;
    hideEl(dom.camPreviewOff);
    setToggle(dom.setupToggleCam, true);
    setToggle(dom.setupToggleMic, true);
  } catch (e) {
    showEl(dom.camPreviewOff);
    toast('Camera denied — check browser permissions.', 'warn');
  }
}

function stopSetupCamera() {
  if (S.setupStream) { S.setupStream.getTracks().forEach(t => t.stop()); S.setupStream = null; }
}

function handleSetupToggleCam() {
  S.setupCamOn = !S.setupCamOn;
  S.setupStream?.getVideoTracks().forEach(t => t.enabled = S.setupCamOn);
  setToggle(dom.setupToggleCam, S.setupCamOn);
  S.setupCamOn ? hideEl(dom.camPreviewOff) : showEl(dom.camPreviewOff);
}

function handleSetupToggleMic() {
  S.setupMicOn = !S.setupMicOn;
  S.setupStream?.getAudioTracks().forEach(t => t.enabled = S.setupMicOn);
  setToggle(dom.setupToggleMic, S.setupMicOn);
}

async function handleSetupFlip() {
  const ns = await flipCamera();
  if (!ns) return;
  S.setupStream = ns;
  dom.camPreview.srcObject = ns;
}

async function handleGoLive() {
  if (!S.profile) { toast('Sign in with your SNS account to go live.', 'error'); return; }

  dom.btnGoLive.disabled = true;

  try {
    stopSetupCamera();
    const stream     = await getLocalStream(S.setupCamOn, S.setupMicOn);
    S.setupStream    = null;

    const title      = dom.setupTitle.value.trim()    || 'Shadow Nexus LIVE';
    const category   = dom.setupCategory.value        || 'general';
    const guestPerm  = dom.setupGuestPerm.value       || 'invite_only';
    const chatMode   = dom.setupChat.value            || 'open';

    const roomId = await createRoom(S.profile, title, category, guestPerm, chatMode);
    S.roomId     = roomId;
    S.role       = 'host';

    await enterLiveRoom(roomId, 'host', stream);
    showScreen('live');
    toast('🔴 You are live! Room: ' + roomId, 'success');
  } catch (e) {
    if (e.message.startsWith('DUPLICATE:')) {
      const existingId = e.message.split(':')[1];
      toast('You already have an active stream (' + existingId + '). End it first.', 'warn');
    } else {
      toast('Could not go live: ' + e.message, 'error');
    }
    console.error(e);
    dom.btnGoLive.disabled = false;
  }
}

/* ═══════════════════════════════════════════════
   VIEWER — INSTANT JOIN (no code, no wait)
════════════════════════════════════════════════ */
async function handleJoinAsViewer(roomId) {
  // Ensure auth — silently sign in if needed (viewers need no account)
  if (!S.firebaseUser) {
    await ensureAnonViewer();
  }

  try {
    const room = await getRoom(roomId);
    if (!room)                  { toast('Stream not found.',       'error'); return; }
    if (room.status === 'ended'){ toast('This stream has ended.',  'warn');  return; }

    S.roomId = roomId;
    S.role   = 'viewer';

    const name = S.profile?.displayName || S.viewerName || 'Viewer';
    await joinRoom(roomId, name);
    await enterLiveRoom(roomId, 'viewer', null);
    showScreen('live');
  } catch (e) {
    toast('Could not join: ' + e.message, 'error');
    console.error(e);
  }
}

/* ═══════════════════════════════════════════════
   GUEST JOIN (on-screen with code)
════════════════════════════════════════════════ */
async function handleGuestJoin() {
  const code = dom.guestCodeInput.value.trim().toUpperCase();
  if (code.length < 4) { toast('Enter a valid room code.', 'warn'); return; }

  dom.btnGuestJoin.disabled    = true;
  dom.btnGuestJoin.textContent = 'Joining…';

  try {
    const room = await getRoom(code);
    if (!room) throw new Error('Room not found.');
    if (room.status === 'ended') throw new Error('Stream has ended.');

    const camOn  = dom.guestToggleCam.classList.contains('active');
    const micOn  = dom.guestToggleMic.classList.contains('active');
    const stream = await getLocalStream(camOn, micOn);

    S.roomId = code;
    S.role   = 'guest';

    const name = S.profile?.displayName || S.viewerName || 'Guest';
    await joinRoom(code, name);
    await enterLiveRoom(code, 'guest', stream);
    showScreen('live');
    toast('Joined as a guest!', 'success');
  } catch (e) {
    toast('Could not join: ' + e.message, 'error');
    console.error(e);
  } finally {
    dom.btnGuestJoin.disabled    = false;
    dom.btnGuestJoin.textContent = 'JOIN AS GUEST';
  }
}

/* ═══════════════════════════════════════════════
   ENTER LIVE ROOM
════════════════════════════════════════════════ */
async function enterLiveRoom(roomId, role, localStream) {
  S.isLive = true;

  // Top bar
  showEl(dom.barLivePill);
  if (role === 'host') {
    S.startTime = Date.now();
    showEl(dom.barTimer);
    startTimer();
  }

  // Toolbars
  hideEl(dom.hostToolbar); hideEl(dom.guestToolbar); hideEl(dom.viewerToolbar);
  if (role === 'host')   showEl(dom.hostToolbar);
  if (role === 'guest')  showEl(dom.guestToolbar);
  if (role === 'viewer') showEl(dom.viewerToolbar);

  // Local video box
  if (localStream && role !== 'viewer') {
    const selfId = role === 'host' ? 'vbox-self' : 'vbox-guest-self';
    const senderProfile = S.profile || { displayName: S.viewerName, avatar: '' };
    addVideoBox(selfId, localStream, senderProfile.displayName, senderProfile.avatar, true, role === 'host');
    updateArenaLayout();
  }

  // Room data + HUD
  const room = await getRoom(roomId);
  S.roomData = room;
  if (room) {
    populateLiveHUD(room);
    dom.chatViewerNum.textContent = room.viewers ?? 0;
  }

  // Watch room
  S.unsubRoom = watchRoom(roomId, data => {
    if (!data) return;
    S.roomData = data;
    dom.chatViewerNum.textContent = data.viewers ?? 0;
    dom.hudViewers.textContent    = data.viewers ?? 0;
    if (data.status === 'ended' && role !== 'host') {
      toast('The host ended the stream.', 'info');
      doLeave(false);
    }
  });

  // Chat
  S.chatLog   = [];
  S.unsubMsgs = watchMessages(roomId, msgs => onNewMessages(msgs));

  // Likes
  S.unsubLikes = watchLikes(roomId, count => updateLikeUI(count));

  // WebRTC
  if (role === 'host')  setupHostWebRTC(roomId);
  if (role === 'guest') setupGuestWebRTC(roomId);
}

function populateLiveHUD(room) {
  setAvatarEl(dom.hudHostAvatar, room.hostAvatar, room.hostName);
  dom.hudHostName.textContent   = room.hostName    || '—';
  dom.hudHostHandle.textContent = room.hostUsername ? '@' + room.hostUsername : '';
  dom.hudViewers.textContent    = room.viewers ?? 0;
  if (dom.hudLikes) dom.hudLikes.textContent = room.likes ?? 0;
  // Stream title strip
  if (dom.hudStreamTitleText && room.title) {
    dom.hudStreamTitleText.textContent = room.title;
    dom.hudStreamTitleText.closest?.('.hud-stream-title')?.removeAttribute('hidden');
  }
}

function updateLikeUI(count) {
  if (dom.hudLikes)      dom.hudLikes.textContent     = count;
  if (dom.chatLikeCount) dom.chatLikeCount.textContent = count;
}

async function handleLike() {
  if (!S.roomId) return;
  try {
    await sendLike(S.roomId);
    // Toggle liked class on both buttons
    dom.chatLikeBtn?.classList.add('liked');
    dom.vtLike?.classList.add('liked');
    // Float hearts burst
    handleReaction('❤️');
  } catch (e) {
    toast('Could not send like.', 'warn');
  }
}

/* ═══════════════════════════════════════════════
   HOST WEBRTC
════════════════════════════════════════════════ */
function setupHostWebRTC(roomId) {
  S.hostPeer = new HostPeerManager({
    onGuestStream: async (stream, uid) => {
      S.guestStreams[uid] = stream;
      // Resolve guest name from liveUsers doc
      let guestName = 'Guest';
      let guestAvatar = '';
      try {
        const snap = await getDoc(doc(_db, 'liveUsers', uid));
        if (snap.exists()) { guestName = snap.data().name || guestName; guestAvatar = snap.data().avatar || ''; }
      } catch (_) {}
      // Register guest for management panel
      _guestRegistry[uid] = { name: guestName, avatar: guestAvatar, micMuted: false };
      addVideoBox('vbox-' + uid, stream, guestName, guestAvatar, false, false);
      updateArenaLayout();
      // Refresh guest panel if open
      if (dom.guestPanel && !dom.guestPanel.classList.contains('hidden')) renderGuestPanel();
      toast(esc(guestName) + ' joined as a guest!', 'info');
    },
    onGuestLeave: (uid) => {
      removeVideoBox('vbox-' + uid);
      delete S.guestStreams[uid];
      delete _guestRegistry[uid];
      updateArenaLayout();
      if (dom.guestPanel && !dom.guestPanel.classList.contains('hidden')) renderGuestPanel();
    },
    onIceForGuest: (uid, cand) => publishGuestIce(roomId, uid, 'host', cand),
    onStateChange: (s, uid)    => console.log('[Host]', uid, s),
  });

  S.unsubGuests = watchGuestList(roomId, async uids => {
    for (const uid of uids) {
      if (uid === S.firebaseUser?.uid) continue;
      if (S.guestStreams[uid])         continue;
      watchGuestOffer(roomId, uid, async offer => {
        const answerSdp = await S.hostPeer.handleGuestOffer(uid, offer.sdp);
        if (!answerSdp) return;
        await publishGuestAnswer(roomId, uid, answerSdp);
        S.unsubIce[uid] = watchGuestIce(roomId, uid, 'guest', c => S.hostPeer.addGuestIce(uid, c));
      });
    }
  });
}

/* ═══════════════════════════════════════════════
   GUEST WEBRTC
════════════════════════════════════════════════ */
async function setupGuestWebRTC(roomId) {
  const uid = S.firebaseUser?.uid;
  S.guestPeer = new GuestPeerManager({
    onHostStream: stream => {
      addVideoBox('vbox-host', stream, S.roomData?.hostName || 'Host', S.roomData?.hostAvatar || '', false, true);
      updateArenaLayout();
    },
    onIceForHost: cand => publishGuestIce(roomId, uid, 'guest', cand),
    onStateChange: s    => console.log('[Guest] conn:', s),
  });

  const offerSdp = await S.guestPeer.createOffer();
  await publishGuestOffer(roomId, uid, offerSdp);
  watchGuestAnswer(roomId, uid, async ans => await S.guestPeer.handleHostAnswer(ans.sdp));
  S.unsubIce['host'] = watchGuestIce(roomId, uid, 'host', c => S.guestPeer.addHostIce(c));
  S.guestPeer.onReconnectOffer(sdp => publishGuestOffer(roomId, uid, sdp));
}

/* ═══════════════════════════════════════════════
   VIDEO BOXES
════════════════════════════════════════════════ */
/**
 * Add a video box for a participant.
 * Includes: profile picture, username, mic icon, camera-off overlay,
 * Blue Nexus glow border, speaking ring via AudioContext analysis.
 */
function addVideoBox(id, stream, name, avatar, isSelf, isHost) {
  if (document.getElementById(id)) {
    const v = document.querySelector(`#${id} .vbox-video`);
    if (v) v.srcObject = stream;
    return;
  }

  const box         = document.createElement('div');
  box.id            = id;
  box.className     = 'vbox';

  const video       = document.createElement('video');
  video.autoplay    = true;
  video.playsInline = true;
  video.muted       = isSelf;
  video.srcObject   = stream;
  video.className   = 'vbox-video' + (isSelf ? ' mirror' : '');

  const initial     = (name || '?')[0].toUpperCase();

  // Camera-off placeholder with glow avatar
  const camOff      = document.createElement('div');
  camOff.className  = 'vbox-cam-off hidden';
  camOff.id         = id + '-camoff';
  const camOffAv    = avatar
    ? `<img src="${esc(avatar)}" class="vbox-cam-off-img" alt="${esc(name)}" />`
    : `<div class="vbox-cam-off-letter">${initial}</div>`;
  camOff.innerHTML  = camOffAv + `<span class="vbox-cam-off-name">${esc(name)}</span>`;

  // Nameplate: profile picture + username + mic icon
  const plate       = document.createElement('div');
  plate.className   = 'vbox-nameplate';
  plate.id          = id + '-plate';
  const plateAv     = avatar
    ? `<img src="${esc(avatar)}" class="vbox-np-avatar-img" alt="${esc(name)}" />`
    : `<div class="vbox-avatar">${initial}</div>`;
  plate.innerHTML   = plateAv
    + `<div class="vbox-info">`
    + `<div class="vbox-name">${esc(name)}</div>`
    + `<span class="vbox-mic-icon" id="${id}-mic">🎤</span>`
    + `</div>`;

  // Host decorations
  if (isHost) {
    const crown       = document.createElement('div');
    crown.className   = 'vbox-host-crown';
    crown.textContent = '👑';
    box.appendChild(crown);

    const badge       = document.createElement('div');
    badge.className   = 'vbox-live-badge';
    badge.textContent = 'LIVE';
    box.appendChild(badge);
  }

  box.appendChild(video);
  box.appendChild(camOff);
  box.appendChild(plate);
  dom.videoArena.appendChild(box);

  // Speaking indicator via Web Audio API (audio tracks only, not for self-muted)
  if (stream && !isSelf) {
    startSpeakingDetector(id, stream, box);
  }
}

/**
 * Web Audio API speaking detector.
 * Polls audio level and toggles the .speaking class on the vbox.
 */
function startSpeakingDetector(boxId, stream, boxEl) {
  try {
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) return;

    const ctx      = new (window.AudioContext || window.webkitAudioContext)();
    const source   = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let speaking = false;
    let frameId;

    function tick() {
      frameId = requestAnimationFrame(tick);
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg   = sum / data.length;
      const isSpeaking = avg > 8;   // threshold
      if (isSpeaking !== speaking) {
        speaking = isSpeaking;
        boxEl.classList.toggle('speaking', speaking);
      }
    }
    tick();

    // Clean up when box is removed
    const obs = new MutationObserver(() => {
      if (!document.getElementById(boxId)) {
        cancelAnimationFrame(frameId);
        ctx.close().catch(() => {});
        obs.disconnect();
      }
    });
    obs.observe(dom.videoArena, { childList: true });
  } catch (_) { /* AudioContext not supported — silently skip */ }
}

function removeVideoBox(id) {
  document.getElementById(id)?.remove();
}

/**
 * Smart arena layout — exact grid for each count:
 *  1 person  → 1×1  (full screen)
 *  2 people  → 1×2  (side by side)
 *  3 people  → 2 cols, first spans both
 *  4 people  → 2×2
 *  5 people  → 2 rows × 3 cols, last spans 2
 *  6 people  → 2×3
 *  7 people  → 2 rows, last spans 2
 *  8 people  → 2×4
 */
function updateArenaLayout() {
  const boxes = dom.videoArena.querySelectorAll('.vbox');
  const n     = boxes.length;
  if (!n) return;

  // Reset all spans first
  boxes.forEach(b => { b.style.gridColumn = ''; b.style.gridRow = ''; });

  switch (n) {
    case 1:
      dom.videoArena.style.gridTemplateColumns = '1fr';
      dom.videoArena.style.gridTemplateRows    = '1fr';
      break;
    case 2:
      dom.videoArena.style.gridTemplateColumns = '1fr 1fr';
      dom.videoArena.style.gridTemplateRows    = '1fr';
      break;
    case 3:
      dom.videoArena.style.gridTemplateColumns = '1fr 1fr';
      dom.videoArena.style.gridTemplateRows    = '1fr 1fr';
      boxes[0].style.gridColumn = 'span 2';
      break;
    case 4:
      dom.videoArena.style.gridTemplateColumns = '1fr 1fr';
      dom.videoArena.style.gridTemplateRows    = '1fr 1fr';
      break;
    case 5:
      dom.videoArena.style.gridTemplateColumns = '1fr 1fr 1fr';
      dom.videoArena.style.gridTemplateRows    = '1fr 1fr';
      boxes[4].style.gridColumn = 'span 3';
      break;
    case 6:
      dom.videoArena.style.gridTemplateColumns = '1fr 1fr 1fr';
      dom.videoArena.style.gridTemplateRows    = '1fr 1fr';
      break;
    case 7:
      dom.videoArena.style.gridTemplateColumns = '1fr 1fr 1fr 1fr';
      dom.videoArena.style.gridTemplateRows    = '1fr 1fr';
      boxes[6].style.gridColumn = 'span 2';
      break;
    case 8:
    default:
      dom.videoArena.style.gridTemplateColumns = '1fr 1fr 1fr 1fr';
      dom.videoArena.style.gridTemplateRows    = '1fr 1fr';
      break;
  }
}

/* Update mic icon for a video box */
function setVboxMicIcon(boxId, micOn) {
  const micEl = el(boxId + '-mic');
  if (!micEl) return;
  micEl.textContent = micOn ? '🎤' : '🔇';
  micEl.classList.toggle('muted', !micOn);
}

/* ═══════════════════════════════════════════════
   HOST TOOLBAR ACTIONS
════════════════════════════════════════════════ */
function handleTbCam() {
  const on = toggleCamera(!isCamEnabled());
  setTb(dom.tbCam, on);
  const co = el('vbox-self-camoff');
  if (co) on ? co.classList.add('hidden') : co.classList.remove('hidden');
  // Update mic icon to reflect camera state
  setVboxMicIcon('vbox-self', isMicEnabled());
}

function handleTbMic() {
  const on = toggleMic(!isMicEnabled());
  setTb(dom.tbMic, on);
  setVboxMicIcon('vbox-self', on);
}

async function handleTbFlip() {
  const ns = await flipCamera();
  if (!ns) return;
  const v  = el('vbox-self')?.querySelector('.vbox-video') ||
             el('vbox-guest-self')?.querySelector('.vbox-video');
  if (v) v.srcObject = ns;
}

function handleTbInvite() {
  if (!S.roomId) return;
  dom.inviteCodeDisplay.textContent = S.roomId;
  showEl(dom.inviteDialog);
}

function handleCopyCode() {
  navigator.clipboard?.writeText(S.roomId).then(() => toast('Code copied!', 'success'));
}

function handleTbEnd() {
  dom.dialogTitle.textContent = 'End your live stream?';
  dom.dialogMsg.textContent   = 'Your viewers will leave the Shadow Realm.';
  showEl(dom.endDialog);
}

/* ═══════════════════════════════════════════════
   HOST — GUEST MANAGEMENT PANEL
════════════════════════════════════════════════ */
function handleTbGuests() {
  if (!dom.guestPanel) return;
  dom.guestPanel.classList.toggle('hidden');
  renderGuestPanel();
}

function renderGuestPanel() {
  if (!dom.guestPanelList) return;
  const uids = Object.keys(_guestRegistry);
  if (!uids.length) {
    dom.guestPanelList.innerHTML = '<p class="guest-panel-empty">No guests yet.</p>';
    return;
  }
  dom.guestPanelList.innerHTML = '';
  uids.forEach(uid => {
    const g   = _guestRegistry[uid];
    const row = document.createElement('div');
    row.className = 'gp-row';

    const avEl = document.createElement('div');
    avEl.className = 'gp-avatar';
    if (g.avatar) {
      avEl.style.backgroundImage = `url('${esc(g.avatar)}')`;
      avEl.style.backgroundSize  = 'cover';
    } else {
      avEl.textContent = (g.name || '?')[0].toUpperCase();
    }

    const nameEl = document.createElement('div');
    nameEl.className   = 'gp-name';
    nameEl.textContent = g.name || 'Guest';

    const actions = document.createElement('div');
    actions.className = 'gp-actions';

    // Mute/unmute button
    const muteBtn = document.createElement('button');
    muteBtn.className   = 'gp-btn mute-btn';
    muteBtn.title       = g.micMuted ? 'Unmute' : 'Mute';
    muteBtn.textContent = g.micMuted ? '🔇' : '🎤';
    muteBtn.addEventListener('click', () => {
      // Signal guest to mute (via Firestore flag) — best-effort
      g.micMuted = !g.micMuted;
      muteBtn.textContent = g.micMuted ? '🔇' : '🎤';
      muteBtn.title       = g.micMuted ? 'Unmute' : 'Mute';
      setVboxMicIcon('vbox-' + uid, !g.micMuted);
      toast((g.micMuted ? 'Muted ' : 'Unmuted ') + esc(g.name), 'info');
    });

    // Kick/remove button
    const kickBtn = document.createElement('button');
    kickBtn.className   = 'gp-btn kick-btn';
    kickBtn.title       = 'Remove from stream';
    kickBtn.textContent = '✕';
    kickBtn.addEventListener('click', async () => {
      try {
        // Remove their signaling data — peer will disconnect
        await removeGuestSignal(S.roomId, uid);
        removeVideoBox('vbox-' + uid);
        delete _guestRegistry[uid];
        delete S.guestStreams[uid];
        updateArenaLayout();
        renderGuestPanel();
        toast(esc(g.name) + ' was removed.', 'info');
      } catch (e) {
        toast('Could not remove guest.', 'warn');
      }
    });

    actions.appendChild(muteBtn);
    actions.appendChild(kickBtn);
    row.appendChild(avEl);
    row.appendChild(nameEl);
    row.appendChild(actions);
    dom.guestPanelList.appendChild(row);
  });
}

/* ═══════════════════════════════════════════════
   GUEST / VIEWER TOOLBAR ACTIONS
════════════════════════════════════════════════ */
function handleGtCam() {
  const on = toggleCamera(!isCamEnabled());
  setTb(dom.gtCam, on);
  const co = el('vbox-guest-self-camoff');
  if (co) on ? co.classList.add('hidden') : co.classList.remove('hidden');
}

function handleGtMic() {
  const on = toggleMic(!isMicEnabled());
  setTb(dom.gtMic, on);
  setVboxMicIcon('vbox-guest-self', on);
}

function handleGtLeave() {
  dom.dialogTitle.textContent = 'Leave the stream?';
  dom.dialogMsg.textContent   = 'You will be removed from the video feed.';
  showEl(dom.endDialog);
}

function handleVtShare() {
  if (navigator.share) {
    navigator.share({ title: 'Shadow Nexus Live', text: 'Join me!', url: location.href }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(location.href);
    toast('Link copied!', 'success');
  }
}

function handleVtReport() { toast('Report submitted. Thank you.', 'info'); }
function handleVtLeave()  { doLeave(false); }

/* ═══════════════════════════════════════════════
   END / LEAVE STREAM
════════════════════════════════════════════════ */
async function confirmEnd() {
  hideEl(dom.endDialog);
  if (S.role === 'host') { await endRoom(S.roomId); }
  else                   { await leaveRoom(S.roomId); }
  doLeave(S.role === 'host');
}

function cancelEnd() { hideEl(dom.endDialog); }

function doLeave(wasHost) {
  S.isLive = false;

  if (S.timerRef) { clearInterval(S.timerRef); S.timerRef = null; }

  [S.unsubRoom, S.unsubMsgs, S.unsubGuests, S.unsubLikes].forEach(fn => { try { fn?.(); } catch (_) {} });
  Object.values(S.unsubIce).forEach(fn => { try { fn?.(); } catch (_) {} });
  S.unsubRoom = S.unsubMsgs = S.unsubGuests = S.unsubLikes = null;
  S.unsubIce  = {};

  S.hostPeer?.closeAll();  S.hostPeer  = null;
  S.guestPeer?.close();    S.guestPeer = null;

  stopLocalStream();

  dom.videoArena.innerHTML = '';
  dom.chatList.innerHTML   = '';
  S.chatLog    = [];
  S.guestStreams = {};
  // Reset guest registry and hide panel
  Object.keys(_guestRegistry).forEach(k => delete _guestRegistry[k]);
  if (dom.guestPanel) hideEl(dom.guestPanel);
  S.roomId     = null;
  S.role       = null;

  hideEl(dom.barLivePill);
  hideEl(dom.barTimer);
  dom.barTimer.textContent  = '00:00';
  dom.hudTimer.textContent  = '00:00';
  if (dom.hudLikes)      dom.hudLikes.textContent     = '0';
  if (dom.chatLikeCount) dom.chatLikeCount.textContent = '0';
  if (dom.btnGoLive)     dom.btnGoLive.disabled        = false;
  dom.chatLikeBtn?.classList.remove('liked');
  dom.vtLike?.classList.remove('liked');

  showScreen('home');
  toast(wasHost ? 'Stream ended.' : 'You left the stream.', 'info');
}

/* ═══════════════════════════════════════════════
   CHAT
════════════════════════════════════════════════ */
function onNewMessages(msgs) {
  const prev = S.chatLog.length;
  if (msgs.length <= prev) return;
  S.chatLog = msgs;
  msgs.slice(prev).forEach(m => appendChatMsg(m));
}

function appendChatMsg(msg) {
  const li       = document.createElement('li');
  li.className   = 'chat-msg';

  const isHost   = msg.userId === S.roomData?.hostId;
  const initial  = (msg.username || '?')[0].toUpperCase();
  const ts       = msg.timestamp?.toDate ? fmtTime(msg.timestamp.toDate()) : '';
  const avatarEl = msg.avatar
    ? `<img src="${esc(msg.avatar)}" class="chat-ava-img" alt="${esc(msg.username)}" />`
    : `<div class="chat-ava">${initial}</div>`;

  li.innerHTML = `
    ${avatarEl}
    <div class="chat-body">
      <span class="chat-user${isHost ? ' is-host' : ''}">${esc(msg.username)}</span>
      <span class="chat-ts">${ts}</span>
      <div class="chat-text">${esc(msg.message)}</div>
    </div>`;

  dom.chatList.appendChild(li);
  dom.chatList.scrollTop = dom.chatList.scrollHeight;
}

async function handleSendChat() {
  const text = dom.chatInput.value.trim();
  if (!text || !S.roomId) return;

  const now = Date.now();
  S.spamLog = S.spamLog.filter(t => now - t < SPAM_WINDOW);
  if (S.spamLog.length >= SPAM_MAX) { toast('Slow down!', 'warn'); return; }
  S.spamLog.push(now);

  dom.chatInput.value = '';
  hideEl(dom.emojiPicker);
  try { await sendMessage(S.roomId, text); }
  catch (e) { toast('Failed to send.', 'error'); }
}

/* ═══════════════════════════════════════════════
   REACTIONS
════════════════════════════════════════════════ */
function handleReaction(emoji) {
  if (S.roomId) sendMessage(S.roomId, emoji).catch(() => {});
  for (let i = 0; i < 6; i++) {
    const e          = document.createElement('div');
    e.className      = 'burst-emoji';
    e.textContent    = emoji;
    e.style.left     = (15 + Math.random() * 70) + '%';
    e.style.bottom   = '80px';
    e.style.animationDelay    = (i * 0.1) + 's';
    e.style.animationDuration = (1.8 + Math.random() * 0.8) + 's';
    dom.reactionBurst.appendChild(e);
    e.addEventListener('animationend', () => e.remove(), { once: true });
  }
}

/* ═══════════════════════════════════════════════
   TIMER
════════════════════════════════════════════════ */
function startTimer() {
  S.timerRef = setInterval(() => {
    const s = Math.floor((Date.now() - S.startTime) / 1000);
    const t = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
    dom.barTimer.textContent = t;
    dom.hudTimer.textContent = t;
  }, 1000);
}

/* ═══════════════════════════════════════════════
   NETWORK
════════════════════════════════════════════════ */
async function checkNet() {
  const q      = await probeNetwork();
  const labels = { good: 'Good ✓', medium: 'OK ⚠', poor: 'Weak ⚠', unknown: 'Checking…' };
  if (dom.setupNetDot)   dom.setupNetDot.className    = 'net-dot ' + q;
  if (dom.setupNetLabel) dom.setupNetLabel.textContent = labels[q] || 'Checking…';
}

/* ═══════════════════════════════════════════════
   FULLSCREEN
════════════════════════════════════════════════ */
function goFullscreen(target) {
  if (!document.fullscreenElement)
    (target.requestFullscreen || target.webkitRequestFullscreen || (() => {})).call(target);
  else
    (document.exitFullscreen   || document.webkitExitFullscreen  || (() => {})).call(document);
}

/* ═══════════════════════════════════════════════
   ANDROID BACK BUTTON
════════════════════════════════════════════════ */
function setupBackButton() {
  history.pushState(null, '', location.href);
  window.addEventListener('popstate', () => {
    if (S.isLive) {
      history.pushState(null, '', location.href);
      dom.dialogTitle.textContent = S.role === 'host' ? 'End your live stream?' : 'Leave the stream?';
      dom.dialogMsg.textContent   = S.role === 'host' ? 'Your viewers will be removed.' : 'You will leave the stream.';
      showEl(dom.endDialog);
    }
  });
}

/* ═══════════════════════════════════════════════
   STORM CANVAS
════════════════════════════════════════════════ */
function initStorm() {
  const canvas = dom.stormCanvas;
  if (!canvas) return;
  const ctx    = canvas.getContext('2d');
  let W, H;

  const resize = () => { W = canvas.width = innerWidth; H = canvas.height = innerHeight; };
  resize();
  window.addEventListener('resize', resize, { passive: true });

  function bolt(x1, y1, x2, y2, r, d) {
    if (!d) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); return; }
    const mx = (x1 + x2) / 2 + (Math.random() - 0.5) * r;
    const my = (y1 + y2) / 2 + (Math.random() - 0.5) * r;
    bolt(x1, y1, mx, my, r / 2, d - 1);
    bolt(mx, my, x2, y2, r / 2, d - 1);
    if (d > 1 && Math.random() < 0.3) {
      ctx.globalAlpha = 0.4;
      bolt(mx, my, mx + (Math.random() - .5) * r * 2, my + Math.random() * r * 2, r / 3, d - 2);
      ctx.globalAlpha = 1;
    }
  }

  function flash() {
    ctx.clearRect(0, 0, W, H);
    const nb = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < nb; i++) {
      const x1 = Math.random() * W;
      const x2 = x1 + (Math.random() - .5) * 150;
      ctx.strokeStyle = `rgba(${40 + ~~(Math.random() * 30)},${100 + ~~(Math.random() * 80)},255,${0.45 + Math.random() * 0.5})`;
      ctx.lineWidth   = 0.8 + Math.random() * 1.6;
      ctx.shadowColor = '#2979ff';
      ctx.shadowBlur  = 14 + Math.random() * 14;
      bolt(x1, 0, x2, H * (0.3 + Math.random() * 0.55), 72, 6);
    }
    // flame glow at bottom
    const g = ctx.createLinearGradient(0, H * 0.8, 0, H);
    g.addColorStop(0, 'rgba(41,121,255,0)');
    g.addColorStop(1, 'rgba(41,121,255,0.04)');
    ctx.fillStyle = g;
    ctx.fillRect(0, H * 0.8, W, H * 0.2);
    setTimeout(() => ctx.clearRect(0, 0, W, H), 55 + Math.random() * 90);
  }

  (function sched() { setTimeout(() => { flash(); sched(); }, 700 + Math.random() * 2800); })();
}

/* ═══════════════════════════════════════════════
   TOAST
════════════════════════════════════════════════ */
function toast(msg, type = 'info') {
  const t    = document.createElement('div');
  t.className = `snx-toast ${type}`;
  t.textContent = msg;
  dom.toastWrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 380); }, 3200);
}

/* ═══════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════ */
function showEl(e) { e?.classList.remove('hidden'); }
function hideEl(e) { e?.classList.add('hidden'); }
function setToggle(btn, on) { btn.classList.toggle('active', on); btn.classList.toggle('off', !on); }
function setTb(btn, on)     { btn.classList.toggle('active', on); btn.classList.toggle('off', !on); }
function pad(n)  { return String(n).padStart(2, '0'); }
function esc(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtTime(d) { return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0'); }

/** Set an avatar element to either an image or a coloured initial. */
function setAvatarEl(container, src, name) {
  if (!container) return;
  if (src) {
    container.style.backgroundImage = `url('${esc(src)}')`;
    container.style.backgroundSize  = 'cover';
    container.textContent            = '';
  } else {
    container.style.backgroundImage = 'none';
    container.textContent            = (name || '?')[0].toUpperCase();
  }
}

/* ═══════════════════════════════════════════════
   WIRE EVENTS
════════════════════════════════════════════════ */
function wireAll() {
  // Auth — viewer
  dom.btnWatchNow?.addEventListener('click', handleWatchNow);
  dom.viewerName?.addEventListener('keydown', e => { if (e.key === 'Enter') handleWatchNow(); });
  dom.btnSwitchToAcct?.addEventListener('click', showAccountLogin);

  // Auth — account
  dom.btnSignInAcct?.addEventListener('click', handleSignInAccount);
  dom.acctPassword?.addEventListener('keydown', e => { if (e.key === 'Enter') handleSignInAccount(); });
  dom.btnBackToViewer?.addEventListener('click', showViewerLogin);

  // Hero sign-in link — redirect to the main SNS site to sign in first,
  // then return to live.html with the GO LIVE intent.
  dom.heroSignInLink?.addEventListener('click', e => {
    e.preventDefault();
    localStorage.setItem('snx_live_intent', 'golive');
    window.location.href = 'index.html';
  });

  // Home
  dom.btnStartLive?.addEventListener('click', openSetup);

  // Setup
  dom.setupToggleCam?.addEventListener('click', handleSetupToggleCam);
  dom.setupToggleMic?.addEventListener('click', handleSetupToggleMic);
  dom.setupFlipCam?.addEventListener('click',   handleSetupFlip);
  dom.btnGoLive?.addEventListener('click',      handleGoLive);
  dom.btnSetupBack?.addEventListener('click',   () => { stopSetupCamera(); showScreen('home'); });

  // Host toolbar
  dom.tbCam?.addEventListener('click',        handleTbCam);
  dom.tbMic?.addEventListener('click',        handleTbMic);
  dom.tbFlip?.addEventListener('click',       handleTbFlip);
  dom.tbInvite?.addEventListener('click',     handleTbInvite);
  dom.tbGuests?.addEventListener('click',     handleTbGuests);
  dom.tbFullscreen?.addEventListener('click', () => goFullscreen(dom.screenLive));
  dom.tbEnd?.addEventListener('click',        handleTbEnd);

  // Guest toolbar
  dom.gtCam?.addEventListener('click',        handleGtCam);
  dom.gtMic?.addEventListener('click',        handleGtMic);
  dom.gtFlip?.addEventListener('click',       handleTbFlip);
  dom.gtFullscreen?.addEventListener('click', () => goFullscreen(dom.screenLive));
  dom.gtLeave?.addEventListener('click',      handleGtLeave);

  // Viewer toolbar
  dom.vtLike?.addEventListener('click',       handleLike);
  dom.vtShare?.addEventListener('click',      handleVtShare);
  dom.vtFullscreen?.addEventListener('click', () => goFullscreen(dom.screenLive));
  dom.vtReport?.addEventListener('click',     handleVtReport);
  dom.vtLeave?.addEventListener('click',      handleVtLeave);

  // Chat toggle (mobile/fullscreen)
  dom.btnChatToggle?.addEventListener('click', () => {
    dom.chatPanel?.classList.toggle('collapsed');
  });

  // Close guest panel when clicking outside it
  dom.screenLive?.addEventListener('click', e => {
    if (dom.guestPanel && !dom.guestPanel.contains(e.target) && e.target !== dom.tbGuests && !dom.tbGuests?.contains(e.target)) {
      if (!dom.guestPanel.classList.contains('hidden')) hideEl(dom.guestPanel);
    }
  });

  // Like button in chat panel
  dom.chatLikeBtn?.addEventListener('click', handleLike);

  // Chat
  dom.chatSend?.addEventListener('click', handleSendChat);
  dom.chatInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendChat(); }
  });
  dom.chatEmoji?.addEventListener('click', () => dom.emojiPicker?.classList.toggle('hidden'));
  dom.emojiPicker?.querySelectorAll('span').forEach(s => {
    s.addEventListener('click', () => {
      dom.chatInput.value += s.textContent;
      dom.chatInput.focus();
      hideEl(dom.emojiPicker);
    });
  });

  // Reactions
  document.querySelectorAll('.react-btn').forEach(btn => {
    btn.addEventListener('click', () => handleReaction(btn.dataset.emoji));
  });

  // Dialogs
  dom.btnDialogCancel?.addEventListener('click',  cancelEnd);
  dom.btnDialogConfirm?.addEventListener('click', confirmEnd);
  dom.btnCopyCode?.addEventListener('click',      handleCopyCode);
  dom.btnCloseInvite?.addEventListener('click',   () => hideEl(dom.inviteDialog));

  // Guest join screen
  dom.btnGuestJoin?.addEventListener('click', handleGuestJoin);
  dom.btnGuestBack?.addEventListener('click', () => showScreen('home'));
  dom.guestCodeInput?.addEventListener('keydown', e => { if (e.key === 'Enter') handleGuestJoin(); });

  dom.guestToggleCam?.addEventListener('click', () => {
    dom.guestToggleCam.classList.toggle('active');
    dom.guestToggleCam.classList.toggle('off');
  });
  dom.guestToggleMic?.addEventListener('click', () => {
    dom.guestToggleMic.classList.toggle('active');
    dom.guestToggleMic.classList.toggle('off');
  });

  // Close emoji on outside click
  document.addEventListener('click', e => {
    if (!dom.emojiPicker?.contains(e.target) && e.target !== dom.chatEmoji) hideEl(dom.emojiPicker);
  });

  // Network
  window.addEventListener('online',  checkNet);
  window.addEventListener('offline', () => {
    if (dom.setupNetDot) { dom.setupNetDot.className = 'net-dot poor'; dom.setupNetLabel.textContent = 'No connection'; }
  });
}
