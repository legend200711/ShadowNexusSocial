/**
 * Shadow Nexus Live — live.js
 *
 * Firebase split architecture:
 *
 *  MAIN Firebase (horr-a08f4) — Firestore:
 *    - Auth / user profiles
 *    - Feed posts, stories, notifications
 *    - Live chat messages  (liveRooms/{roomId}/liveMessages)
 *    - Likes counter       (liveRooms/{roomId}.likes)
 *
 *  LIVE Firebase (Shadow Nexus Live) — Realtime Database:
 *    - Room status         (liveRooms/{roomId})
 *    - WebRTC offer/answer (liveConnections/{roomId}/{viewerUid})
 *    - ICE candidates      (liveConnections/{roomId}/{viewerUid}/creatorCandidates | viewerCandidates)
 *
 *  CREATOR:
 *    1. Captures local camera + mic via getUserMedia.
 *    2. Creates liveRooms/{roomId} in RTDB (status: 'live').
 *    3. Watches liveConnections/{roomId} for new viewer "request" nodes.
 *    4. For each viewer: creates a fresh RTCPeerConnection + SDP offer
 *       written to liveConnections/{roomId}/{viewerUid}, then waits for
 *       that viewer's answer + ICE. Streams directly via WebRTC.
 *       (A separate peer per viewer lets the host stream to many viewers
 *       and lets a returning viewer get a brand-new offer.)
 *
 *  VIEWER:
 *    1. Reads liveRooms/{roomId} from RTDB to confirm stream is live.
 *    2. Writes a "request" to liveConnections/{roomId}/{viewerUid} in RTDB.
 *    3. Waits for the host to write a fresh SDP offer to that same node.
 *    4. Creates RTCPeerConnection, sends answer + ICE back to its node.
 *    5. Receives creator tracks via WebRTC ontrack.
 *
 *  Chat + Likes:
 *    Stored in Firestore sub-collections under liveRooms/{roomId}.
 */

'use strict';

/* ── Main Firebase imports (Firestore + Auth) ──
   IMPORTANT: version 10.8.0 is the SAME version index.html uses, so
   the browser serves these modules from its HTTP cache instantly when a
   user navigates from the main site to the live page. Using a different
   version (e.g. 10.12.0) forces a full re-download of all four SDK
   modules — the #1 cause of the 10-second loading delay. */
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, browserLocalPersistence, setPersistence, getIdToken
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
  getFirestore,
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, orderBy, limit, onSnapshot,
  serverTimestamp, increment, where, deleteField, arrayUnion
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

/* ── Realtime Database imports (signaling + room status) ── */
import {
  getDatabase,
  ref, set, get, update, remove, push, onValue, off, onDisconnect,
  runTransaction,
  serverTimestamp as rtdbTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';

/* ════════════════════════════════════════════════════
   MAIN Firebase — live.html is a standalone page.
   index.html is NOT loaded here — no conflict exists.
   ════════════════════════════════════════════════════ */
const _CFG = {
  apiKey:            'AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y',
  authDomain:        'horr-a08f4.firebaseapp.com',
  databaseURL:       'https://horr-a08f4-default-rtdb.firebaseio.com',
  projectId:         'horr-a08f4',
  storageBucket:     'horr-a08f4.firebasestorage.app',
  messagingSenderId: '933810617818',
  appId:             '1:933810617818:web:efb24f123337dd987c14e3',
};

const _app    = initializeApp(_CFG);
const _auth   = getAuth(_app);
/* ── Ensure the live page reads the same persisted session that
   index.html wrote. browserLocalPersistence is the default for web
   but we set it explicitly so onAuthStateChanged can resolve the
   cached token from localStorage WITHOUT a network round-trip to
   securetoken.googleapis.com — saving 2-5s on the loading spinner. ── */
setPersistence(_auth, browserLocalPersistence).catch(() => {});
const _db     = getFirestore(_app);
const _liveDB = getDatabase(_app);

/* ── WebRTC ICE config ── */
/* iceCandidatePoolSize pre-allocates ICE candidates so the viewer's
   connection can start gathering them immediately when the RTCPeerConnection
   is created — BEFORE the offer/answer round-trip finishes. This shaves
   hundreds of milliseconds off the time-to-first-frame for viewers. */
const _ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // TURN over UDP, TCP and TLS/443. The TCP + TLS/443 relays are the key
    // to surviving restrictive firewalls & mobile carrier NAT that silently
    // drop UDP after ~30-60 s — the cause of streams going black after a
    // minute. Multiple transports give the browser a working fallback.
    { urls: 'turn:openrelay.metered.ca:80',                 username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:80?transport=tcp',   username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',                username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp',  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
  iceCandidatePoolSize: 10,
};

/* ── ICE recovery watchdog ───────────────────────────────────────────
   Attaches to any RTCPeerConnection. Two layers of protection:

   Layer 1 — ICE state events: when ICE drops to `disconnected` we give
   it 3 s to self-heal, then call restartIce().  A hard `failed` gets an
   immediate restartIce() attempt.

   Layer 2 — byte-counter polling (every 5 s): stays running even when
   the ICE state is `connected`. If inbound/outbound bytes stop flowing
   for >8 s (the NAT mapping expiry window) we call restartIce() before
   the browser ever reports a state change.  This is the fix for the
   "goes black after ~60 s" symptom on mobile carrier networks. */
function _attachIceWatchdog(pc, label) {
  if (!pc) return;

  // ── Layer 1: ICE state events ──
  pc._iceWatchTimer = null;
  pc.addEventListener('iceconnectionstatechange', () => {
    const st = pc.iceConnectionState;
    if (st === 'disconnected') {
      if (pc._iceWatchTimer) clearTimeout(pc._iceWatchTimer);
      pc._iceWatchTimer = setTimeout(() => {
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
          console.warn(`[WebRTC][${label||'pc'}] ICE stalled — restartIce()`);
          try { pc.restartIce && pc.restartIce(); } catch (_) {}
        }
      }, 3000);
    } else if (st === 'failed') {
      console.warn(`[WebRTC][${label||'pc'}] ICE failed — restartIce()`);
      if (pc._iceWatchTimer) { clearTimeout(pc._iceWatchTimer); pc._iceWatchTimer = null; }
      try { pc.restartIce && pc.restartIce(); } catch (_) {}
    } else if (st === 'connected' || st === 'completed') {
      if (pc._iceWatchTimer) { clearTimeout(pc._iceWatchTimer); pc._iceWatchTimer = null; }
    }
  });

  // ── Layer 2: byte-counter polling — detects frozen streams that keep
  //    ICE "connected" while silently delivering 0 bytes (NAT expiry). ──
  let _lastBytes    = 0;
  let _frozenTicks  = 0;          // consecutive ticks with no new bytes
  const _FROZEN_TICKS_LIMIT = 2;  // 2 × 5 s = 10 s of zero traffic → restart
  const _STATS_INTERVAL_MS  = 5000;

  const _statTimer = setInterval(async () => {
    // Don't run if the connection is already being handled by state events
    const iceState = pc.iceConnectionState;
    if (iceState === 'disconnected' || iceState === 'failed' ||
        iceState === 'closed'       || pc.signalingState === 'closed') {
      clearInterval(_statTimer);
      return;
    }
    if (iceState !== 'connected' && iceState !== 'completed') return;

    try {
      const stats = await pc.getStats();
      let totalBytes = 0;
      stats.forEach(r => {
        // Sum both inbound (viewer) and outbound (host sender) bytes
        if (r.type === 'inbound-rtp'  && r.bytesReceived) totalBytes += r.bytesReceived;
        if (r.type === 'outbound-rtp' && r.bytesSent)     totalBytes += r.bytesSent;
      });

      if (totalBytes === _lastBytes) {
        _frozenTicks++;
        if (_frozenTicks >= _FROZEN_TICKS_LIMIT) {
          _frozenTicks = 0;
          console.warn(`[WebRTC][${label||'pc'}] Byte counter frozen — restartIce()`);
          try { pc.restartIce && pc.restartIce(); } catch (_) {}
        }
      } else {
        _frozenTicks = 0;
        _lastBytes   = totalBytes;
      }
    } catch (_) { /* getStats() can throw on closed connections */ }
  }, _STATS_INTERVAL_MS);

  // Clean up the interval when the connection closes
  pc.addEventListener('iceconnectionstatechange', () => {
    if (pc.iceConnectionState === 'closed') clearInterval(_statTimer);
  });
}

/* ── State ── */
let _user         = null;   // Firebase Auth user
let _userData     = null;   // Firestore user doc data
let _mode         = null;   // 'creator' | 'viewer'
let _roomId       = null;
let _feedPostId   = null;   // ID of the live post created in 'posts' collection
let _localStream  = null;
let _camOn        = true;
let _micOn        = true;
let _facingMode   = 'user';

/* ── Performance: send-lock prevents double-send on rapid taps ── */
let _chatSending  = false;
/* ── Performance: rAF handle for layout batching ── */
let _layoutRafId  = null;
/* ── Performance: track if update-check has already run this session ── */
let _updateChecked = false;

// WebRTC — VIEWER side (single peer connection to the host)
let _rtcPc           = null;   // RTCPeerConnection
let _rtcSignalUnsub  = null;   // RTDB listener unsubscribe (off ref)
let _rtcSignalRef    = null;   // RTDB ref being listened to

// WebRTC — CREATOR side: a separate peer connection per viewer.
// Each viewer joins via liveConnections/{roomId}/{viewerUid}, so the
// host can stream to many viewers and reconnecting / returning viewers
// get a fresh offer instead of a stale answer that never connects.
let _creatorViewerPeers = {};   // { [viewerUid]: { pc, appliedCandKeys:Set, unsub } }
let _creatorConnUnsub   = null; // listener on liveConnections/{roomId}

// Auto-reconnect for viewers
let _viewerReconnectTimer   = null;
let _viewerReconnectAttempt = 0;
const _MAX_RECONNECT_ATTEMPTS = 5;

let _chatUnsub        = null;
let _viewerCountRef   = null;   // RTDB ref (liveViewers/{roomId}) the host watches with onValue
let _viewerCountUnsub = null;   // off() handle returned by that onValue
let _viewerPresenceRef = null;  // RTDB ref for this viewer's per-user presence seat
let _viewerPresenceOdc = null;  // onDisconnect handle for the presence seat
let _viewerPresenceJoined = false; // true once the presence seat is live (cleared on leave/reconnect)
let _roomWatchRef     = null;   // saved RTDB ref so we can call off() on it
let _toastTimer       = null;
let _viewerLeftFlag   = false;  // guard: prevent double-decrement on mobile
let _creatorEndedFlag = false;  // guard: prevent beforeunload re-running endLive cleanup

/* ══════════════════════════════════════════════════
   GUEST BOX CONFIGURATION — change here to update max
   ══════════════════════════════════════════════════ */
const _MAX_GUESTS = 8;   // Maximum simultaneous guest boxes (up to 8 supported)

/* ── Guest Box State ── */
let _guestLayout       = 'host-full'; // current layout: 'host-full' (right stack) or 'host-full-left' (left stack)
let _guestBoxSize      = 'sm';        // 'sm' | 'md' | 'lg'
let _savedLayout       = null;     // creator's saved favourite layout (localStorage)
let _savedBoxSize      = null;     // creator's saved favourite box size
let _guestPeers        = {};       // uid → { pc, stream, cell, name }
let _guestReqUnsub     = null;     // RTDB listener for incoming requests (host)
let _guestStatusUnsub  = null;     // RTDB listener for request status (viewer)
let _layoutPanelOpen   = false;
let _guestStream       = null;     // viewer's own guest media stream
let _guestCamOn        = true;     // viewer's guest cam state
let _guestMicOn        = true;     // viewer's guest mic state
let _shownReqUids      = new Set(); // host: tracks UIDs already shown in request queue
let _viewerGuestUnsub  = null;     // viewer: RTDB listener for liveGuests presence
let _layoutSyncUnsub   = null;     // viewer/guest: RTDB listener for layout sync
let _guestPc           = null;     // viewer-in-box: their own guest RTCPeerConnection (for disconnect cleanup)
let _guestSigUnsub     = null;     // viewer-in-box: unsubscribe for host-ICE signaling onValue listener
let _hostSigUnsubs     = {};       // host: uid → onValue unsubscribe for per-guest signaling listener

/* ── Featured Guest state ── */
let _featuredGuestUid  = null;     // UID of the currently featured guest (null = host is featured)

/* ── Speaker-focus state ── */
let _speakerUid           = null;   // UID of the current active speaker
let _speakerCheckInterval = null;   // setInterval handle for audio-level polling
let _dragState            = null;   // { uid, startX, startY, origLeft, origTop } for drag layout

/* ── Drag positions ── */
const _dragPositions = {};  // uid → { left, top } in px (absolute)

/* ── Disconnect / heartbeat state ── */
let _guestHeartbeatInterval = null;  // guest: periodic presence keep-alive writer
let _hostWatchdogInterval   = null;  // host: periodic sweep for stale guest presence entries
const _HEARTBEAT_INTERVAL_MS = 8000; // every 8 s the guest writes a timestamp
const _STALE_THRESHOLD_MS    = 18000; // >18 s without heartbeat → guest is gone

// Host presence heartbeat — re-asserts { online: true, live: true } on RTDB
// every few seconds so a late-firing onDisconnect from the main app
// (index.html) can't wipe our "live" status while we're still streaming.
let _hostPresenceInterval = null;

/* ── DOM refs (resolved after DOMContentLoaded) ── */
let D = {};

/* ═══════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  D = {
    loading:         document.getElementById('liveLoading'),
    setup:           document.getElementById('liveSetup'),
    stage:           document.getElementById('liveStage'),
    ended:           document.getElementById('liveEndedOverlay'),
    toast:           document.getElementById('liveToast'),
    unmutePrompt:    document.getElementById('liveUnmutePrompt'),

    setupPreview:    document.getElementById('setupPreview'),
    setupPreviewOff: document.getElementById('setupPreviewOff'),
    setupTitle:      document.getElementById('setupTitleInput'),
    setupCamBtn:     document.getElementById('setupBtnCam'),
    setupMicBtn:     document.getElementById('setupBtnMic'),
    setupFlipBtn:    document.getElementById('setupBtnFlip'),
    goLiveBtn:       document.getElementById('btnGoLive'),

    liveVideo:       document.getElementById('liveVideo'),
    camOffOverlay:   document.getElementById('liveCamOffOverlay'),
    topBar:          document.getElementById('liveTopBar'),
    liveBadge:       document.getElementById('liveBadge'),
    creatorName:     document.getElementById('liveCreatorName'),
    creatorAvatar:   document.getElementById('liveCreatorAvatar'),
    viewerCount:     document.getElementById('liveViewerCount'),
    likeCount:       document.getElementById('liveLikeCount'),
    connBanner:      document.getElementById('liveConnBanner'),
    connTitle:       document.getElementById('liveConnTitle'),
    connSub:         document.getElementById('liveConnSub'),

    // Creator controls
    btnCam:          document.getElementById('btnToggleCam'),
    btnMic:          document.getElementById('btnToggleMic'),
    btnFlip:         document.getElementById('btnFlipCam'),
    btnFS:           document.getElementById('btnFullscreen'),
    btnEnd:          document.getElementById('btnEndLive'),
    btnShareCreator: document.getElementById('btnShareLiveCreator'),

    // Viewer controls
    profileBtn:      document.getElementById('btnCreatorProfile'),
    btnShare:        document.getElementById('btnShareLive'),

    // Chat
    chatMessages:    document.getElementById('liveChatMessages'),
    chatInput:       document.getElementById('liveChatInput'),
    chatSend:        document.getElementById('liveChatSend'),

    // Ended overlay
    endedTitle:      document.getElementById('endedTitle'),
    endedSub:        document.getElementById('endedSub'),
    endedBackBtn:    document.getElementById('endedBackBtn'),

    // Guest box system
    guestGrid:           document.getElementById('guestGrid'),
    guestRequestQueue:   document.getElementById('guestRequestQueue'),
    btnRequestBox:       document.getElementById('btnRequestBox'),
    btnRequestBoxLabel:  document.getElementById('btnRequestBoxLabel'),
    btnGuestCam:         document.getElementById('btnGuestCam'),
    btnGuestCamLabel:    document.getElementById('btnGuestCamLabel'),
    btnGuestMic:         document.getElementById('btnGuestMic'),
    btnGuestMicLabel:    document.getElementById('btnGuestMicLabel'),
    btnLeaveBox:         document.getElementById('btnLeaveBox'),
    btnLayoutSettings:   document.getElementById('btnLayoutSettings'),
    layoutSettingsPanel: document.getElementById('layoutSettingsPanel'),
  };

  // Disable Go Live until Firebase auth resolves
  if (D.goLiveBtn) { D.goLiveBtn.disabled = true; }

  // Wire up static buttons
  D.setupCamBtn  && D.setupCamBtn.addEventListener('click', toggleSetupCam);
  D.setupMicBtn  && D.setupMicBtn.addEventListener('click', toggleSetupMic);
  D.setupFlipBtn && D.setupFlipBtn.addEventListener('click', flipSetupCamera);
  D.goLiveBtn    && D.goLiveBtn.addEventListener('click', startLive);

  D.btnCam  && D.btnCam.addEventListener('click',   () => toggleLiveCam());
  D.btnMic  && D.btnMic.addEventListener('click',   () => toggleLiveMic());
  D.btnFlip && D.btnFlip.addEventListener('click',  () => flipLiveCamera());
  D.btnFS   && D.btnFS.addEventListener('click',    toggleFullscreen);
  D.btnEnd  && D.btnEnd.addEventListener('click',   endLive);

  D.btnShare         && D.btnShare.addEventListener('click',         shareLive);
  D.btnShareCreator  && D.btnShareCreator.addEventListener('click',  shareLive);
  D.chatSend  && D.chatSend.addEventListener('click',  sendChat);
  D.chatInput && D.chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  D.endedBackBtn && D.endedBackBtn.addEventListener('click', () => {
    window.location.href = 'index.html';
  });

  document.getElementById('liveCloseBtn') &&
    document.getElementById('liveCloseBtn').addEventListener('click', onCloseBtn);

  // Guest box button wiring
  D.btnRequestBox     && D.btnRequestBox.addEventListener('click', _viewerRequestBox);
  D.btnGuestCam       && D.btnGuestCam.addEventListener('click', _toggleGuestCam);
  D.btnGuestMic       && D.btnGuestMic.addEventListener('click', _toggleGuestMic);
  D.btnLeaveBox       && D.btnLeaveBox.addEventListener('click', _guestLeaveBox);
  D.btnLayoutSettings && D.btnLayoutSettings.addEventListener('click', _toggleLayoutPanel);

  // Live Settings panel wiring (host only)
  const _btnLiveSettings = document.getElementById('btnLiveSettings');
  if (_btnLiveSettings) {
    _btnLiveSettings.addEventListener('click', () => {
      const panel = document.getElementById('liveSettingsPanel');
      if (!panel) return;
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
    });
  }
  document.getElementById('toggleAISafety') &&
    document.getElementById('toggleAISafety').addEventListener('change', e => {
      _aiSafetySetEnabled(e.target.checked);
    });
  document.getElementById('toggleShadowBot') &&
    document.getElementById('toggleShadowBot').addEventListener('change', e => {
      _shadowBotSetEnabled(e.target.checked);
    });
  document.getElementById('toggleLiveTimer') &&
    document.getElementById('toggleLiveTimer').addEventListener('change', e => {
      _liveTimerSetEnabled(e.target.checked);
    });

  document.getElementById('toggleInternetQuality') &&
    document.getElementById('toggleInternetQuality').addEventListener('change', e => {
      _iqSetEnabled(e.target.checked);
    });

  document.getElementById('toggleCompactControls') &&
    document.getElementById('toggleCompactControls').addEventListener('change', e => {
      _setCompactControls(e.target.checked);
    });

  // Layout option buttons
  document.querySelectorAll('.layout-option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.layout-option-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _guestLayout = btn.dataset.layout;
      _applyGuestLayout();
      // Broadcast layout change to all viewers and guests
      _broadcastLayout();
      // Sidebar body class
      _applySidebarBodyClass();
    });
  });

  // Box size buttons
  document.querySelectorAll('.layout-size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.layout-size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _guestBoxSize = btn.dataset.size;
      _applyGuestLayout();
      // Broadcast size change to all viewers and guests
      _broadcastLayout();
    });
  });

  // "Return to Host View" button in layout panel
  const _btnClearFeatured = document.getElementById('btnClearFeatured');
  if (_btnClearFeatured) _btnClearFeatured.addEventListener('click', _clearFeaturedGuest);

  D.stage && D.stage.addEventListener('click', e => {
    // Selectors that should never trigger a like or a controls-hide
    const ignore = ['.live-ctrl-btn','#btnEndLive','.live-chat-input','.live-chat-send',
                    '.live-close-btn','.live-creator-pill','.live-badge',
                    '.layout-settings-panel','.layout-option-btn','.layout-size-btn',
                    '.live-settings-panel','#liveSettingsPanel','.lsp-row','.lsp-toggle','.lsp-slider',
                    '.live-viewer-actions','.live-request-box-btn','.live-leave-box-btn',
                    '.live-like-btn','.live-profile-btn','.live-share-btn',
                    '.live-stats-ribbon','.live-top-bar','.snx-confirm-overlay'];
    if (ignore.some(s => e.target.closest(s))) return;

    if (_mode === 'creator') {
      // Close layout panel on tap-away
      if (_layoutPanelOpen) { _closeLayoutPanel(); return; }
      // Close settings panel on tap-away
      const sp = document.getElementById('liveSettingsPanel');
      if (sp && sp.style.display !== 'none') { sp.style.display = 'none'; return; }
      D.stage.classList.toggle('live-controls-hidden');
    } else if (_mode === 'viewer') {
      // Viewer taps anywhere on video → send a Like
      sendLike(e.clientX, e.clientY);
    }
  });

  onAuthStateChanged(_auth, async user => {
    if (!user) {
      _hideLoading();
      window.location.href = 'index.html';
      return;
    }
    _user = user;

    // ── Proactive token refresh — prevents permission-denied on Firestore/RTDB ──
    // Forces the SDK to fetch a fresh ID token so the live page never hits
    // permission-denied from a stale token (60-min TTL).
    try { await getIdToken(user, true); } catch(_) {}
    // Clear any previous refresh timer, then schedule recurring refreshes every 55 min
    if (window._snxLiveTokenTimer) clearInterval(window._snxLiveTokenTimer);
    window._snxLiveTokenTimer = setInterval(async () => {
      if (_auth.currentUser) {
        try { await getIdToken(_auth.currentUser, true); } catch(_) {}
      }
    }, 55 * 60 * 1000);

    // TIKTOK-STYLE INSTANT VIDEO: For viewer mode, start the video
    // connection IMMEDIATELY without waiting for _loadUserData() (a
    // Firestore round-trip that adds 200-500ms of delay). The viewer's
    // video stream only needs uid + roomId, not their profile data.
    // The profile data loads in the background and is ready for
    // chat/profile features by the time the user interacts.
    const hash = location.hash;
    const isViewerMode = hash.startsWith('#watch=');

    if (isViewerMode) {
      // Start the viewer stream NOW — don't wait for user data
      _resolveMode();
      // Load user data in the background (for chat name, avatar, etc.)
      _loadUserData().then(() => {
        _checkForUpdate();
      });
    } else {
      // Creator mode: needs user data for the setup screen
      _loadUserData().then(() => {
        if (D.goLiveBtn) { D.goLiveBtn.disabled = false; }
        _resolveMode();
        _checkForUpdate();
      });
    }
  });
});

/* ── Load Firestore user doc ── */
async function _loadUserData() {
  try {
    const snap = await getDoc(doc(_db, 'users', _user.uid));
    _userData = snap.exists() ? snap.data() : { displayName: _user.email?.split('@')[0] || 'Guest', username: '' };
  } catch (_) {
    _userData = { displayName: _user.email?.split('@')[0] || 'Guest', username: '' };
  }
}

/* ── Decide mode from URL hash ── */
async function _resolveMode() {
  const hash = location.hash;
  localStorage.removeItem('snx_live_intent');
  // Clean up pre-warm sessionStorage (we read it in _startViewerWebRTC
  // via the RTDB get() check, so we don't need the sessionStorage itself)

  if (hash.startsWith('#watch=')) {
    _roomId = hash.slice(7);   // roomId is plain [a-zA-Z0-9_] — no decoding needed
    _mode   = 'viewer';
    document.body.classList.add('is-viewer');
    await _startViewer();
  } else {
    _mode = 'creator';
    document.body.classList.add('is-creator');
    await _startCreatorSetup();
  }
}

/* ═══════════════════════════════════════════════════
   CREATOR SETUP
   ═══════════════════════════════════════════════════ */
async function _startCreatorSetup() {
  _hideLoading();
  if (D.setup) D.setup.style.display = 'block';

  try {
    _localStream = await navigator.mediaDevices.getUserMedia({
      // Default: 720p 30fps — safe for 5G/4G (adaptive quality shifts tiers automatically)
      video: {
        facingMode:  _facingMode,
        width:       { ideal: 1280 },
        height:      { ideal: 720  },
        frameRate:   { ideal: 30, max: 30 },
      },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (D.setupPreview) {
      D.setupPreview.srcObject = _localStream;
      D.setupPreview.play().catch(() => {});
    }
    _updateSetupPreviewState(true);
  } catch (err) {
    try {
      _localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      _camOn = false;
      _updateSetupPreviewState(false);
      toast('Camera is audio only');
    } catch (e) {
      _showSetupPermError('Camera & mic access denied. Allow Camera + Microphone in your browser settings, then refresh.');
    }
  }
}

function _showSetupPermError(msg) {
  toast(msg);
  const existing = document.getElementById('_snxSetupPermError');
  if (existing) { existing.textContent = msg; return; }
  const banner = document.createElement('div');
  banner.id = '_snxSetupPermError';
  banner.style.cssText = [
    'width:100%', 'background:rgba(180,0,30,0.18)', 'border:1px solid rgba(255,50,70,0.55)',
    'border-radius:10px', 'padding:12px 14px', 'font-size:13px', 'color:#ff8899',
    'line-height:1.5', 'text-align:center',
  ].join(';');
  banner.textContent = msg;
  const input = document.getElementById('setupTitleInput');
  if (input && input.parentNode) {
    input.parentNode.insertBefore(banner, input);
  } else if (D.goLiveBtn && D.goLiveBtn.parentNode) {
    D.goLiveBtn.parentNode.insertBefore(banner, D.goLiveBtn);
  }
  if (D.goLiveBtn) {
    D.goLiveBtn.disabled = true;
    D.goLiveBtn.title = 'Camera & mic access required';
  }
}

function _updateSetupPreviewState(hasVideo) {
  if (!D.setupPreviewOff) return;
  D.setupPreviewOff.classList.toggle('visible', !hasVideo);
  if (D.setupPreview) D.setupPreview.style.display = hasVideo ? 'block' : 'none';
}

function toggleSetupCam() {
  _camOn = !_camOn;
  if (_localStream) {
    _localStream.getVideoTracks().forEach(t => t.enabled = _camOn);
  }
  _updateSetupPreviewState(_camOn && !!(_localStream?.getVideoTracks().length));
  if (D.setupCamBtn) {
    D.setupCamBtn.querySelector('.setup-ctrl-icon').textContent = '📷';
    D.setupCamBtn.classList.toggle('off', !_camOn);
    D.setupCamBtn.querySelector('span:last-child').textContent  = _camOn ? 'Cam' : 'Cam Off';
  }
}

function toggleSetupMic() {
  _micOn = !_micOn;
  if (_localStream) {
    _localStream.getAudioTracks().forEach(t => t.enabled = _micOn);
  }
  if (D.setupMicBtn) {
    D.setupMicBtn.querySelector('.setup-ctrl-icon').textContent = _micOn ? '🎤' : '🔇';
    D.setupMicBtn.classList.toggle('off', !_micOn);
    D.setupMicBtn.querySelector('span:last-child').textContent  = _micOn ? 'Mic' : 'Mic Off';
  }
}

async function flipSetupCamera() {
  _facingMode = _facingMode === 'user' ? 'environment' : 'user';
  if (_localStream) {
    _localStream.getTracks().forEach(t => t.stop());
  }
  try {
    _localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: _facingMode, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: _micOn ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
    });
    if (D.setupPreview) {
      D.setupPreview.srcObject = _localStream;
      D.setupPreview.play().catch(() => {});
    }
    _camOn = true;
    _updateSetupPreviewState(true);
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════
   START LIVE (creator)
   ═══════════════════════════════════════════════════ */
async function startLive() {
  if (!_user) {
    toast('Please wait…');
    return;
  }
  if (_user.isAnonymous) {
    toast('Sign in to go live.');
    return;
  }
  if (!_localStream || !_localStream.getTracks().length) {
    toast('Camera or mic not available. Check permissions and refresh.');
    return;
  }

  const titleVal = (D.setupTitle?.value || '').trim();
  if (D.goLiveBtn) { D.goLiveBtn.disabled = true; D.goLiveBtn.textContent = 'Going Live…'; }

  // Sanitize uid — strip any chars forbidden in RTDB keys (. # $ / [ ])
  const _safeUid = _user.uid.replace(/[.#$/\[\]]/g, '_');
  _roomId = `${_safeUid}_${Date.now().toString(36)}`;

  const creatorData = {
    roomId:       _roomId,
    hostId:       _user.uid,
    hostName:     _userData.displayName || _user.email?.split('@')[0] || 'Creator',
    hostUsername: _userData.username || '',
    hostAvatar:   _userData.avatar || _userData.profilePicture || '',
    title:        titleVal || 'Shadow Nexus LIVE',
    status:       'live',
    isLive:       true,
    viewers:      0,
    likes:        0,
    createdAt:    Date.now(),
  };

  /* ── INSTANT VISUAL FEEDBACK: Show the stage + local video IMMEDIATELY.
     The camera stream is already running (from _startCreatorSetup), so
     there is zero reason to wait for any Firestore/RTDB write before the
     user sees themselves on screen. This eliminates the multi-second
     delay where the button said "Going Live…" but the screen was blank. */
  _creatorEndedFlag = false;
  window.addEventListener('beforeunload', _creatorBeforeUnload);
  window.addEventListener('pagehide',     _creatorBeforeUnload);

  if (D.setup) D.setup.style.display = 'none';
  _showStage();
  _attachLocalVideoToStage();
  _populateCreatorInfo(creatorData);

  toast('🔴 You are LIVE!');

  /* ── Kill any previous stuck live session IN THE BACKGROUND.
     This does a Firestore read + multiple RTDB/Firestore writes, which
     previously took 3-5 seconds SEQUENTIALLY before the stage appeared.
     Now it runs fire-and-forget so it never blocks the user's view.
     The writes to the NEW room below are independent of this cleanup,
     so they can run in parallel. */
  (async () => {
    try {
      const userSnap = await getDoc(doc(_db, 'users', _user.uid));
      const prevRoomId = userSnap.exists() ? userSnap.data().liveRoomId : null;
      if (prevRoomId && prevRoomId !== _roomId) {
        // Update old room status + remove connections (RTDB, fast)
        update(ref(_liveDB, `liveRooms/${prevRoomId}`), { status: 'ended', isLive: false, endedAt: Date.now() }).catch(()=>{});
        remove(ref(_liveDB, `liveConnections/${prevRoomId}`)).catch(()=>{});
        // Delete old Firestore liveRooms docs
        deleteDoc(doc(_db, 'liveRooms', _user.uid)).catch(()=>{});
        deleteDoc(doc(_db, 'liveRooms', prevRoomId)).catch(()=>{});
      } else {
        // No previous room, but still clean up the uid-keyed doc just in case
        deleteDoc(doc(_db, 'liveRooms', _user.uid)).catch(()=>{});
      }
      // Clean up orphaned feed posts with type='live' (non-critical, background)
      const orphanQ = query(
        collection(_db, 'posts'),
        where('uid', '==', _user.uid),
        where('type', '==', 'live')
      );
      getDocs(orphanQ).then(orphanSnap => {
        orphanSnap.forEach(d => { deleteDoc(d.ref).catch(()=>{}); });
      }).catch(()=>{});
    } catch (_) {}
  })();

  /* ── Write room to LIVE Realtime Database (CRITICAL PATH).
     This is the one write that MUST succeed for viewers to discover the
     stream, but it's a single RTDB set (~80ms) and we don't block the
     stage on it — the stage is already shown above. We just need this
     to complete before the WebRTC listener starts watching for viewers. */
  // Clear any stale viewer presence from a previous crashed session for this roomId
  try { remove(ref(_liveDB, `liveViewers/${_roomId}`)).catch(() => {}); } catch(_) {}

  let _roomWriteOk = true;
  try {
    await set(ref(_liveDB, `liveRooms/${_roomId}`), creatorData);
  } catch (e) {
    _roomWriteOk = false;
    toast('Could not start live. Please try again.');
    if (D.goLiveBtn) { D.goLiveBtn.disabled = false; D.goLiveBtn.textContent = 'Start Live'; }
    return;
  }

  /* ── Mirror room to Firestore (NON-CRITICAL — fire and forget).
     The Live Hub reads from Firestore, but this write doesn't block the
     host's stream. It can complete in the background. */
  setDoc(doc(_db, 'liveRooms', _user.uid), {
    ...creatorData,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }).catch(()=>{});

  await _startCreatorWebRTC();

  _subscribeChat();
  _subscribeViewerCount();
  _showCreatorShareBar();

  // ── Start listening for guest box requests ──
  _hostListenForGuestRequests();

  // ── Attach resize observer so guest grid re-layouts on any screen change ──
  _attachGuestGridResizeObserver();

  // ── Publish host's own presence to liveGuests (fire-and-forget) ──
  (async () => {
    try {
      const hostGuestRef = ref(_liveDB, `liveGuests/${_roomId}/_host_`);
      await set(hostGuestRef, {
        uid:      _user.uid,
        name:     creatorData.hostName,
        avatar:   creatorData.hostAvatar,
        isHost:   true,
        camOn:    _camOn,
        micOn:    _micOn,
        joinedAt: Date.now(),
        hb:       Date.now(),
      });
      try { onDisconnect(ref(_liveDB, `liveGuests/${_roomId}`)).remove(); } catch(_){}
    } catch (_) {}
  })();

  // ── Notify add-on modules (co-host, etc.) that live has started ──
  window.dispatchEvent(new CustomEvent('snxLiveReady', { detail: {
    db: _db, liveDB: _liveDB, auth: _auth,
    user: _user, userData: _userData,
    roomId: _roomId, isHost: true,
  }}));

  // ── Start optional systems (respects their individual ON/OFF state) ──
  _liveTimerOnLiveStart();
  _shadowBotOnLiveStart();
  _aiSafetyOnLiveStart();
  _iqOnLiveStart();
  // ── Host video health watchdog (keeps #liveVideo alive at all times) ──
  _startHostVideoHealth();

  // ── Non-critical side-work (fire-and-forget, doesn't block) ──
  // Also set Firestore status to "online" so the inbox/chat presence
  // (which falls back to Firestore status) shows the host as online/LIVE
  // even if the RTDB listener hasn't synced yet.
  updateDoc(doc(_db, 'users', _user.uid), { isLive: true, liveRoomId: _roomId, status: 'online', lastSeen: Date.now() }).catch(()=>{});

  // ── RTDB users/{uid} presence: mark as online + live (fire-and-forget) ──
  (async () => {
    try {
      const _uPresRef = ref(_liveDB, 'users/' + _user.uid);
      await set(_uPresRef, { online: true, live: true, lastSeen: rtdbTimestamp() });
      onDisconnect(_uPresRef).set({ online: false, live: false, lastSeen: rtdbTimestamp() });
      if (_hostPresenceInterval) clearInterval(_hostPresenceInterval);
      _hostPresenceInterval = setInterval(() => {
        try {
          set(_uPresRef, { online: true, live: true, lastSeen: rtdbTimestamp() });
          // Also refresh Firestore status so inbox/chat presence (Firestore fallback)
          // keeps showing the host as online while they are live.
          updateDoc(doc(_db, 'users', _user.uid), { status: 'online', lastSeen: Date.now() }).catch(() => {});
        } catch (_) {}
      }, 10000);
    } catch (_) {}
  })();

  // ── Story + follower notifications (fire-and-forget, non-blocking) ──
  _createLiveStory(creatorData);
  _notifyFollowersLive(creatorData);
}

function _attachLocalVideoToStage() {
  if (!D.liveVideo || !_localStream) return;
  D.liveVideo.srcObject = _localStream;
  D.liveVideo.play().catch(() => {});
  D.camOffOverlay && D.camOffOverlay.classList.toggle('visible', !_camOn);
}

/* ── HOST main-video health watchdog ─────────────────────────────────────
   Runs every 4 s once the host is live.  Keeps #liveVideo alive through:
     • tab backgrounding / iOS screen-lock (play() interrupted)
     • camera flip replacing _localStream (srcObject drift)
     • frozen currentTime with ICE still "connected" (rare DTLS stall)
   Deliberately separate from the guest watchdog so guest activity never
   starves the host's own video health checks.                            */
let _hostVideoHealthTimer = null;
function _startHostVideoHealth() {
  if (_hostVideoHealthTimer) return;
  let _lastTime = -1;
  let _frozenTicks = 0;
  _hostVideoHealthTimer = setInterval(() => {
    const v = D.liveVideo;
    if (!v || !_localStream) return;
    // 1. Re-attach stream if srcObject drifted (e.g. after camera flip)
    if (v.srcObject !== _localStream) {
      v.srcObject = _localStream;
      v.play().catch(() => {});
      _lastTime = -1;
      _frozenTicks = 0;
      return;
    }
    // 2. Kick play() if the element was paused (background tab, screen lock)
    if (v.paused) {
      v.play().catch(() => {});
      _lastTime = -1;
      _frozenTicks = 0;
      return;
    }
    // 3. Detect frozen currentTime (video element running but no new frames)
    if (v.currentTime === _lastTime && v.currentTime > 0) {
      _frozenTicks++;
      if (_frozenTicks >= 2) {
        // Two consecutive 4-second ticks with no progress → force restart
        _frozenTicks = 0;
        v.srcObject = null;
        v.srcObject = _localStream;
        v.play().catch(() => {});
      }
    } else {
      _frozenTicks = 0;
      _lastTime = v.currentTime;
    }
  }, 4000);
}
function _stopHostVideoHealth() {
  if (_hostVideoHealthTimer) { clearInterval(_hostVideoHealthTimer); _hostVideoHealthTimer = null; }
}

/* ── Share bar: big visible URL strip shown on the live stage ──
   Creator sees their exact watch link immediately so they can copy
   and send it without going through the share modal.              */
function _showCreatorShareBar() {
  const old = document.getElementById('_snxCreatorShareBar');
  if (old) old.remove();

  const url = _buildLiveUrl();

  const bar = document.createElement('div');
  bar.id = '_snxCreatorShareBar';
  bar.style.cssText = [
    'position:absolute', 'top:64px', 'left:50%',
    'transform:translateX(-50%)',
    'z-index:50', 'max-width:calc(100vw - 24px)', 'width:420px',
    'background:rgba(0,10,30,0.93)',
    'border:1.5px solid rgba(0,174,239,0.7)',
    'border-radius:12px', 'padding:10px 14px',
    'display:flex', 'align-items:center', 'gap:10px',
    'backdrop-filter:blur(8px)',
  ].join(';');

  bar.innerHTML = `
    <div style="flex:1;min-width:0;">
      <div style="font-size:10px;color:#6a90b8;margin-bottom:3px;letter-spacing:.5px;text-transform:uppercase;">Your watch link — share this!</div>
      <div id="_snxShareUrlText" style="font-size:12px;color:#00AEEF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace;">${url}</div>
    </div>
    <button id="_snxCopyShareUrl" style="
      flex-shrink:0;padding:8px 14px;border-radius:8px;
      background:rgba(0,174,239,0.2);border:1px solid rgba(0,174,239,0.6);
      color:#00AEEF;font-size:12px;font-weight:700;cursor:pointer;
      white-space:nowrap;
    ">📋 Copy</button>
    <button id="_snxDismissShareBar" style="
      flex-shrink:0;width:28px;height:28px;border-radius:50%;
      background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);
      color:#aaa;font-size:14px;cursor:pointer;
    ">✕</button>
  `;

  // Copy button
  bar.querySelector('#_snxCopyShareUrl').addEventListener('click', () => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url)
        .then(() => toast('✅ Link copied! Send it to your viewers.'))
        .catch(() => window.prompt('Copy your watch link:', url));
    } else {
      window.prompt('Copy your watch link:', url);
    }
  });

  // Dismiss
  bar.querySelector('#_snxDismissShareBar').addEventListener('click', () => bar.remove());

  // Auto-dismiss after 60 s
  setTimeout(() => bar.remove(), 60000);

  const stage = document.getElementById('liveStage');
  const videoWrap = stage?.querySelector('.live-video-wrap');
  (videoWrap || stage || document.body).appendChild(bar);
}

function _populateCreatorInfo(data) {
  if (D.creatorName)   D.creatorName.textContent  = data.hostName;
  if (D.creatorAvatar) {
    if (data.hostAvatar) {
      D.creatorAvatar.style.backgroundImage = `url('${data.hostAvatar}')`;
      D.creatorAvatar.textContent = '';
    } else {
      D.creatorAvatar.textContent = (data.hostName || '?')[0].toUpperCase();
    }
  }
}

/* ── Subscribe to viewer count + likes from LIVE RTDB
      Also mirrors viewer count to Firestore liveRooms doc so the Live Hub
      stays in real-time sync without an extra Firestore write on every tick. ── */
function _subscribeViewerCount() {
  /* ══════════════════════════════════════════════════════════════════════
     HOST-side viewer count — single source of truth.

     Strategy:
       • Watch liveViewers/{roomId} with onValue so every join/leave by
         any viewer fires this callback in real time.
       • Count only seats where active === true AND uid !== host uid
         (the host never writes a seat, but defensive check prevents
         double-counting if anything ever changes).
       • Write the canonical count back to liveRooms/{roomId}/viewers so
         every viewer's room-watch listener picks it up instantly.
       • Mirror to Firestore uid-keyed doc so Live Hub cards stay fresh.
       • Uses off() on the stored ref for clean teardown on endLive().
     ══════════════════════════════════════════════════════════════════════ */
  const presenceRoot = ref(_liveDB, `liveViewers/${_roomId}`);
  _viewerCountRef    = presenceRoot;
  let _lastMirroredViewers = -1;

  _viewerCountUnsub = onValue(presenceRoot, snap => {
    let count = 0;
    if (snap.exists()) {
      const seats = snap.val() || {};
      for (const [uid, seat] of Object.entries(seats)) {
        // Exclude the host's own uid and any inactive / malformed seats
        if (uid === _user?.uid) continue;
        if (seat && seat.active === true) count++;
      }
    }
    // Update host UI immediately
    if (D.viewerCount) D.viewerCount.textContent = '👁 ' + count;
    // Broadcast canonical count to all viewers via liveRooms
    set(ref(_liveDB, `liveRooms/${_roomId}/viewers`), count).catch(() => {});
    // Mirror to Firestore for Live Hub cards (throttled by value change)
    if (count !== _lastMirroredViewers && _roomId && _user) {
      _lastMirroredViewers = count;
      updateDoc(doc(_db, 'liveRooms', _user.uid), { viewers: count }).catch(() => {});
    }
  });

  // ── Also subscribe to likes so the host's like counter updates live ──
  const likesRef = ref(_liveDB, `liveRooms/${_roomId}/likes`);
  onValue(likesRef, snap => {
    if (D.likeCount) D.likeCount.textContent = '❤️ ' + (snap.val() || 0);
  });
}

/* ═══════════════════════════════════════════════════
   CREATOR CONTROLS — Cam / Mic / Flip / End
   ═══════════════════════════════════════════════════ */
function toggleLiveCam() {
  _camOn = !_camOn;
  if (_localStream) _localStream.getVideoTracks().forEach(t => t.enabled = _camOn);
  if (D.btnCam) { D.btnCam.textContent = _camOn ? '📷' : '🚫'; D.btnCam.classList.toggle('off', !_camOn); }
  if (D.camOffOverlay) D.camOffOverlay.classList.toggle('visible', !_camOn);
  // Broadcast host cam state to viewers
  if (_roomId) try { update(ref(_liveDB, `liveGuests/${_roomId}/_host_`), { camOn: _camOn }); } catch(_) {}
}

function toggleLiveMic() {
  _micOn = !_micOn;
  if (_localStream) _localStream.getAudioTracks().forEach(t => t.enabled = _micOn);
  if (D.btnMic) { D.btnMic.textContent = _micOn ? '🎤' : '🔇'; D.btnMic.classList.toggle('off', !_micOn); }
  toast(_micOn ? 'Mic on' : 'Mic muted');
  // Broadcast host mic state to viewers
  if (_roomId) try { update(ref(_liveDB, `liveGuests/${_roomId}/_host_`), { micOn: _micOn }); } catch(_) {}
}

async function flipLiveCamera() {
  _facingMode = _facingMode === 'user' ? 'environment' : 'user';
  const oldStream = _localStream;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: _facingMode, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: _micOn ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
    });
    if (oldStream) oldStream.getTracks().forEach(t => t.stop());
    _localStream = newStream;
    if (D.liveVideo) {
      D.liveVideo.srcObject = newStream;
      D.liveVideo.play().catch(() => {});
    }
    if (_localStream.getVideoTracks()[0]) {
      const newVideoTrack = _localStream.getVideoTracks()[0];
      // Replace the video track on every active viewer peer connection.
      for (const viewerUid of Object.keys(_creatorViewerPeers)) {
        const peer = _creatorViewerPeers[viewerUid];
        if (!peer || !peer.pc) continue;
        const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
          await sender.replaceTrack(newVideoTrack).catch(() => {});
        }
      }
      // Replace the video track on every active guest-box peer connection so
      // the host's cell in each guest's box doesn't go black after a flip.
      for (const guestUid of Object.keys(_guestPeers)) {
        const peer = _guestPeers[guestUid];
        if (!peer || !peer.pc) continue;
        const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
          await sender.replaceTrack(newVideoTrack).catch(() => {});
        }
      }
    }
  } catch (e) {
    toast('Could not flip camera.');
  }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

/* ── Creator page unload guard — only fires if endLive() was NOT called ── */
function _creatorBeforeUnload() {
  if (_creatorEndedFlag || !_roomId) return;
  // Can't do async work in beforeunload; onDisconnect handles the RTDB cleanup.
  // Synchronously close every viewer peer so streams drop immediately.
  _teardownAllCreatorViewerPeers();
  if (_localStream) { _localStream.getTracks().forEach(t => t.stop()); _localStream = null; }
  // Best-effort: remove viewer presence seats (fire-and-forget, may not complete)
  try { remove(ref(_liveDB, `liveViewers/${_roomId}`)).catch(() => {}); } catch(_) {}
}

async function endLive() {
  if (_creatorEndedFlag) return;   // prevent double-call
  _creatorEndedFlag = true;

  // Cancel the onDisconnect trigger — we are ending cleanly ourselves
  if (_roomId) {
    try { await onDisconnect(ref(_liveDB, `liveRooms/${_roomId}`)).cancel(); } catch (_) {}
  }

  window.removeEventListener('beforeunload', _creatorBeforeUnload);
  window.removeEventListener('pagehide',     _creatorBeforeUnload);

  // Stop adaptive quality monitor
  _stopAdaptiveQuality();

  // Close all guest peer connections
  _teardownAllGuestPeers();
  if (_guestReqUnsub) { try { _guestReqUnsub(); } catch(_){} _guestReqUnsub = null; }

  // Close ALL per-viewer peer connections + the viewer-watcher.
  _teardownAllCreatorViewerPeers();
  if (_chatUnsub)        { _chatUnsub();         _chatUnsub        = null; }
  if (_viewerCountRef && _viewerCountUnsub) { off(_viewerCountRef); _viewerCountRef = null; _viewerCountUnsub = null; }

  /* ── Remove WebRTC signaling from LIVE RTDB ── */
  if (_roomId) {
    try { await remove(ref(_liveDB, `liveConnections/${_roomId}`)); } catch (_) {}
  }

  if (_localStream) { _localStream.getTracks().forEach(t => t.stop()); _localStream = null; }

  /* ── Mark room as ended in LIVE RTDB ── */
  const _endedRoomId = _roomId;
  try {
    await update(ref(_liveDB, `liveRooms/${_endedRoomId}`), {
      status:  'ended',
      isLive:  false,
      endedAt: Date.now(),
    });
  } catch (_) {}

  /* ── Clear live status from main Firestore user doc ── */
  try {
    await updateDoc(doc(_db, 'users', _user.uid), {
      isLive:     deleteField(),
      liveRoomId: deleteField(),
      status:     'online',
      lastSeen:   Date.now(),
    });
  } catch (_) {}

  // ── RTDB users/{uid} presence: mark live ended, keep online = true ──
  // Stop the host presence heartbeat first.
  if (_hostPresenceInterval) { clearInterval(_hostPresenceInterval); _hostPresenceInterval = null; }
  try {
    // Cancel the onDisconnect we registered at startLive — we are ending cleanly
    await onDisconnect(ref(_liveDB, 'users/' + _user.uid)).cancel();
  } catch (_) {}
  try {
    await set(ref(_liveDB, 'users/' + _user.uid), { live: false, online: true, lastSeen: rtdbTimestamp() });
  } catch (_) {}

  /* ── Delete live feed post from main Firestore (safety net for old data) ── */
  if (_feedPostId) {
    try { await deleteDoc(doc(_db, 'posts', _feedPostId)); } catch (_) {}
    _feedPostId = null;
  }

  /* ── Mark share posts as ended in main Firestore ── */
  try {
    const shareQ = query(
      collection(_db, 'posts'),
      where('liveRoomId', '==', _endedRoomId),
      where('type', '==', 'live_share')
    );
    const shareSnap = await getDocs(shareQ);
    shareSnap.forEach(async shareDoc => {
      try { await updateDoc(shareDoc.ref, { isLive: false }); } catch (_) {}
    });
  } catch (_) {}

  /* ── Delete Firestore liveRooms doc (keyed by uid) so it disappears from Live Hub ── */
  try { await deleteDoc(doc(_db, 'liveRooms', _user.uid)); } catch (_) {}
  /* ── Also delete by roomId in case old data used roomId as key ── */
  try { await deleteDoc(doc(_db, 'liveRooms', _endedRoomId)); } catch (_) {}

  /* ── Clean up viewer presence seats for this room ── */
  try { await remove(ref(_liveDB, `liveViewers/${_endedRoomId}`)); } catch (_) {}

  /* ── Schedule RTDB room deletion after 5 min (cleans up ended marker) ── */
  setTimeout(async () => {
    try { await remove(ref(_liveDB, `liveRooms/${_endedRoomId}`)); } catch (_) {}
  }, 5 * 60 * 1000);

  _deleteLiveStory();

  // ── Stop optional systems ──
  _liveTimerOnLiveEnd();
  _shadowBotOnLiveEnd();
  _aiSafetyOnLiveEnd();
  _iqOnLiveEnd();
  _stopHostVideoHealth();

  // ── Co-host cleanup (no-op if cohost.js is not loaded) ──
  if (typeof window._cohostCleanup === 'function') { try { window._cohostCleanup(); } catch(_){} }

  _showEndedOverlay(true);
}

/* ═══════════════════════════════════════════════════
   LIVE FEED POST — Firestore 'posts' collection
   ═══════════════════════════════════════════════════ */
async function _createLiveFeedPost(creatorData) {
  if (!_user || !_roomId) return;
  try {
    const postRef = await addDoc(collection(_db, 'posts'), {
      type:          'live',
      uid:           _user.uid,
      authorUid:     _user.uid,
      authorName:    creatorData.hostName     || '',
      authorHandle:  creatorData.hostUsername || '',
      authorAvatar:  creatorData.hostAvatar   || '',
      liveRoomId:    _roomId,
      isLive:        true,
      title:         creatorData.title        || 'Shadow Nexus LIVE',
      text:          (creatorData.hostName || 'Someone') + ' is Live now 🔴',
      timestamp:     Date.now(),
      createdAt:     Date.now(),
      likes:         0,
      comments:      [],
    });
    _feedPostId = postRef.id;
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════
   LIVE STORY — Firestore 'stories' collection
   ═══════════════════════════════════════════════════ */
function _liveStoryId() {
  return `live_${_user.uid}`;
}

async function _createLiveStory(creatorData) {
  if (!_user || !_roomId) return;
  const now = Date.now();
  const expiresAt = now + 12 * 60 * 60 * 1000;
  try {
    await setDoc(doc(_db, 'stories', _liveStoryId()), {
      uid:          _user.uid,
      authorName:   creatorData.hostName     || '',
      authorHandle: creatorData.hostUsername || '',
      authorAvatar: creatorData.hostAvatar   || '',
      type:         'live',
      liveRoomId:   _roomId,
      title:        creatorData.title        || 'Shadow Nexus LIVE',
      createdAt:    now,
      expiresAt,
    });
  } catch (_) {}
}

async function _deleteLiveStory() {
  if (!_user) return;
  try {
    await deleteDoc(doc(_db, 'stories', _liveStoryId()));
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════
   FOLLOWER LIVE NOTIFICATIONS — Firestore 'notifications'
   ═══════════════════════════════════════════════════ */
async function _notifyFollowersLive(creatorData) {
  if (!_user) return;
  try {
    const snap = await getDoc(doc(_db, 'users', _user.uid));
    if (!snap.exists()) return;
    const followers = snap.data().followers || [];
    if (!followers.length) return;

    const notif = {
      id:         `live_${_user.uid}_${Date.now()}`,
      type:       'live',
      fromUid:    _user.uid,
      fromName:   creatorData.hostName    || '',
      fromAvatar: creatorData.hostAvatar  || '',
      roomId:     _roomId,
      roomTitle:  creatorData.title       || 'Shadow Nexus LIVE',
      title:      '🔴 ' + (creatorData.hostName || 'Someone') + ' is Live',
      body:       `${creatorData.hostName || 'Someone'} is live: ${creatorData.title || 'Shadow Nexus LIVE'}`,
      url:        'live.html#watch=' + _roomId,
      ts:         Date.now(),
      read:       false,
    };

    const batches = followers.map(async fUid => {
      try { await addDoc(collection(_db, 'notifications', fUid, 'items'), notif); } catch (_) {}
      try { await updateDoc(doc(_db, 'users', fUid), { pushQueue: arrayUnion(notif) }); } catch (_) {}
    });

    await Promise.allSettled(batches);
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════
   VIEWER — join a live stream
   ═══════════════════════════════════════════════════ */
async function _startViewer() {
  let roomData = null;

  // ── Show the stage + "Connecting…" banner immediately so the viewer
  //    isn't staring at the generic full-screen spinner while we do the
  //    room fetch + WebRTC handshake. The video replaces the banner the
  //    instant the first frame arrives. ──
  _hideLoading();
  _showStage();
  _showConnBanner('Connecting\u2026', '');

  /* OPTIMISED: Instead of polling with sequential get() calls (which added
     up to 4+ seconds of delay), we use an onValue listener on the room ref
     that fires the INSTANT the room data appears. We race it against a
     single get() (in case the room already exists) and a 10s timeout.
     This eliminates all polling delays — the room data is consumed the
     moment it's available, typically in one Firebase round-trip (~150ms). */
  const _roomRef = ref(_liveDB, `liveRooms/${_roomId}`);
  try {
    roomData = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
      // Reduced from 10s to 6s — the onValue + get() race consumes the room
      // data the instant it's available (~150ms typical), so this is purely
      // a safety net for when the room truly doesn't exist. Failing faster
      // lets the user see the "ended" overlay sooner instead of waiting.
      const to = setTimeout(() => {
        try { off(_roomRef, listener); } catch(_) {}
        finish(null);
      }, 6000);
      const listener = onValue(_roomRef, snap => {
        if (snap.exists()) {
          const d = snap.val();
          if (d.status === 'live') {
            clearTimeout(to);
            try { off(_roomRef, listener); } catch(_) {}
            finish(d);
          } else if (d.status === 'ended') {
            clearTimeout(to);
            try { off(_roomRef, listener); } catch(_) {}
            _showEndedOverlay(false, 'Stream ended', 'This live stream has already ended.');
            finish('ENDED');
          }
        }
      });
      // Also do a single get() in case the room already exists (race condition guard)
      get(_roomRef).then(snap => {
        if (!settled && snap.exists()) {
          const d = snap.val();
          if (d.status === 'live') {
            clearTimeout(to);
            try { off(_roomRef, listener); } catch(_) {}
            finish(d);
          } else if (d.status === 'ended') {
            clearTimeout(to);
            try { off(_roomRef, listener); } catch(_) {}
            _showEndedOverlay(false, 'Stream ended', 'This live stream has already ended.');
            finish('ENDED');
          }
        }
      }).catch(() => {});
    });
  } catch (e) {
    toast('Could not connect. Please try again.');
    return;
  }

  if (roomData === 'ENDED') return;  // already showed the ended overlay
  if (!roomData) {
    _showEndedOverlay(false, 'Stream ended', 'This live stream has ended or does not exist.');
    return;
  }

  // Stage is already shown; keep the "Connecting…" banner up until the
  // first video frame arrives (the ontrack handler hides it).
  _showConnBanner('Connecting…', '');

  // TIKTOK-STYLE: Start the WebRTC video connection FIRST — it's the only
  // thing that matters for the video to appear. All the social features
  // (chat, guest grid, layout sync, viewer count, creator info) run in the
  // background and don't block the video from loading.
  const _webrtcPromise = _startViewerWebRTC(roomData);

  // Non-critical setup (runs in background, doesn't block video)
  _populateCreatorInfo(roomData);
  _setupViewerControls(roomData);
  _subscribeChat();

  // ── Notify add-on modules that viewer has joined ──
  window.dispatchEvent(new CustomEvent('snxLiveReady', { detail: {
    db: _db, liveDB: _liveDB, auth: _auth,
    user: _user, userData: _userData,
    roomId: _roomId, isHost: false,
  }}));

  /* ── Subscribe to live guest presence (shows guest boxes to viewers) ── */
  _startViewerGuestGrid();

  /* ── Subscribe to host layout changes so everyone sees the same layout ── */
  _startLayoutSync();

  /* ── Attach resize observer so guest grid re-layouts on any screen change ── */
  _attachGuestGridResizeObserver();

  /* ── Viewer presence seat ────────────────────────────────────────────
     Each viewer holds exactly ONE seat at:
       liveViewers/{roomId}/{uid}  = { joinedAt, active: true }

     Rules:
       • Viewers only — the host never writes a seat (host UID is never
         stored here so the host-side onValue count skips it naturally).
       • Idempotent set() — replacing an existing seat for the same UID
         does NOT inflate the count; it just updates the timestamp.
       • onDisconnect(remove) fires if the tab closes / network drops,
         so the host's onValue listener recomputes and the count heals.
       • On a clean leave (_viewerLeave) we cancel the onDisconnect
         first (to avoid a redundant remove) then delete the seat
         ourselves and let the host's listener recount.
       • _viewerPresenceJoined is cleared in _viewerLeave so a reconnect
         after a network drop correctly re-registers the seat.
  ── */
  (async () => {
    // Guard: never run for the host, never run without a valid user
    if (!_user || _mode === 'creator') return;
    // Guard: if already joined this session, skip (prevents double-write
    // on spurious re-entry of _startViewer while the seat is still live)
    if (_viewerPresenceJoined) return;
    try {
      _viewerPresenceRef = ref(_liveDB, `liveViewers/${_roomId}/${_user.uid}`);
      // Register onDisconnect BEFORE the set() so a disconnect that
      // occurs between set() and the next await is still caught.
      _viewerPresenceOdc = onDisconnect(_viewerPresenceRef);
      await _viewerPresenceOdc.remove();
      // Write the presence seat — idempotent; replaces any stale seat
      // from a previous session for this UID in this room.
      await set(_viewerPresenceRef, { joinedAt: Date.now(), active: true });
      _viewerPresenceJoined = true;
      // NOTE: The host's _subscribeViewerCount() already watches
      // liveViewers/{roomId} with onValue, so it will recount and push
      // the updated number to liveRooms/{roomId}/viewers automatically.
      // We do NOT do a manual get()+set() here — that one-shot snapshot
      // races with other viewers and can produce stale counts.
    } catch (_) {}
  })();

  /* ── Watch for stream ending + viewer/like counts via LIVE RTDB ──
     _startLayoutSync() already subscribes to liveRooms/{roomId}; we
     reuse that same path here to avoid a second concurrent listener. ── */
  let _roomWatchSeenFirst = false;
  _roomWatchRef = ref(_liveDB, `liveRooms/${_roomId}`);
  onValue(_roomWatchRef, snap => {
    const d = snap.val() || {};
    // Update counts (partial DOM update — only if value changed)
    const vText = '👁 ' + (d.viewers || 0);
    const lText = '❤️ ' + (d.likes   || 0);
    if (D.viewerCount && D.viewerCount.textContent !== vText) D.viewerCount.textContent = vText;
    if (D.likeCount   && D.likeCount.textContent   !== lText) D.likeCount.textContent   = lText;
    // Sync layout changes from host
    if (d.guestLayout  && d.guestLayout  !== _guestLayout)  { _guestLayout  = d.guestLayout;  _applyGuestLayout(); }
    if (d.guestBoxSize && d.guestBoxSize !== _guestBoxSize)  { _guestBoxSize = d.guestBoxSize; _applyGuestLayout(); }
    // Sync featured guest changes from host
    const incomingFeatured = d.featuredGuestUid || null;
    if (incomingFeatured !== _featuredGuestUid) { _featuredGuestUid = incomingFeatured; _applyGuestLayout(); }
    if (!_roomWatchSeenFirst) {
      _roomWatchSeenFirst = true;
      return;
    }
    if (!snap.exists() || d.status === 'ended') {
      _showEndedOverlay(false, 'Stream ended', `${roomData.hostName} has ended the live stream.`);
    }
  });

  // Now await the WebRTC connection (it's already been running in parallel)
  await _webrtcPromise;

  window.addEventListener('beforeunload', _viewerLeave);
  window.addEventListener('pagehide',     _viewerLeave);

  // ── Auto-reconnect on network restore ──
  // If the device was offline briefly and comes back, try reconnecting immediately
  // instead of waiting for the exponential back-off timer.
  window.addEventListener('online', () => {
    if (_viewerLeftFlag) return;
    const state = _rtcPc?.connectionState;
    if (state === 'disconnected' || state === 'failed' || !_rtcPc) {
      // Reset attempt counter so we get a fresh fast reconnect
      _viewerReconnectAttempt = 0;
      if (_viewerReconnectTimer) { clearTimeout(_viewerReconnectTimer); _viewerReconnectTimer = null; }
      _scheduleViewerReconnect(roomData);
    }
  }, { once: false });
}

async function _viewerLeave() {
  if (_viewerLeftFlag || !_roomId) return;
  _viewerLeftFlag = true;

  // Cancel any pending reconnect
  if (_viewerReconnectTimer) { clearTimeout(_viewerReconnectTimer); _viewerReconnectTimer = null; }

  // If viewer was in a guest box, clean up that state first
  if (_guestStream || _guestPc) {
    // Direct cleanup without confirmation (page is unloading)
    if (_guestPc) { try { _guestPc.close(); } catch(_){} _guestPc = null; }
    if (_user && _roomId) {
      try { remove(ref(_liveDB, `liveGuests/${_roomId}/${_user.uid}`)); }      catch(_) {}
      try { remove(ref(_liveDB, `guestSignaling/${_roomId}/${_user.uid}`)); }  catch(_) {}
    }
    if (_guestStream) { try { _guestStream.getTracks().forEach(t => t.stop()); } catch(_){} _guestStream = null; }
  }

  // Tear down viewer guest grid listener
  if (_viewerGuestUnsub) {
    try { _viewerGuestUnsub(); } catch(_) {}
    _viewerGuestUnsub = null;
  }

  // Tear down layout sync listener
  if (_layoutSyncUnsub) {
    try { _layoutSyncUnsub(); } catch(_) {}
    _layoutSyncUnsub = null;
  }

  // Tear down room-watch listener
  if (_roomWatchRef) { try { off(_roomWatchRef); } catch(_) {} _roomWatchRef = null; }

  // Clean up any pending box request (RTDB + Firestore)
  if (_user && _roomId) {
    try { await remove(ref(_liveDB, `guestRequests/${_roomId}/${_user.uid}`)); } catch(_) {}
    const requestId = `${_roomId}_${_user.uid}`;
    try { await deleteDoc(doc(_db, 'boxRequests', requestId)); } catch(_) {}
  }
  if (_guestStatusUnsub) { try { _guestStatusUnsub(); } catch(_){} _guestStatusUnsub = null; }

  if (_rtcPc)  { try { _rtcPc.close(); } catch (_) {} _rtcPc = null; }
  if (_rtcSignalRef && _rtcSignalUnsub) { off(_rtcSignalRef); _rtcSignalRef = null; _rtcSignalUnsub = null; }

  /* ── Remove this viewer's per-viewer signaling node so the host
     tears down the corresponding peer connection and a returning
     viewer gets a clean slate. ── */
  if (_user && _roomId) {
    try { await remove(ref(_liveDB, `liveConnections/${_roomId}/${_user.uid}`)); } catch(_) {}
  }
  // Detach the "wait for offer" listener if it's still attached.
  if (_tmpViewerWaitRef && _tmpViewerWaitListener) {
    try { off(_tmpViewerWaitRef, _tmpViewerWaitListener); } catch(_) {}
    _tmpViewerWaitRef = null; _tmpViewerWaitListener = null;
  }

  /* ── Remove viewer presence seat ──────────────────────────────────
     1. Cancel the onDisconnect so RTDB doesn't double-remove after we
        explicitly delete the seat ourselves.
     2. Delete the seat — this triggers the host's liveViewers onValue
        listener which automatically recounts and updates liveRooms.
     3. Clear _viewerPresenceJoined so a subsequent reconnect can
        re-register a fresh seat without being blocked by the guard.
  ── */
  if (_viewerPresenceOdc) {
    try { await _viewerPresenceOdc.cancel(); } catch(_) {}
    _viewerPresenceOdc = null;
  }
  _viewerPresenceJoined = false;  // allow re-registration on reconnect
  if (_viewerPresenceRef && _user) {
    try { await remove(_viewerPresenceRef); } catch (_) {}
    _viewerPresenceRef = null;
    // The host's _subscribeViewerCount onValue listener automatically
    // recounts when the seat node disappears — no manual get()+set() needed.
  }
}

function _setupViewerControls(roomData) {
  if (D.profileBtn) {
    D.profileBtn.style.display = 'flex';
    // Navigate inside the app — never open an external browser tab
    D.profileBtn.onclick = () => {
      window.location.href = 'index.html#profile=' + encodeURIComponent(roomData.hostId);
    };
  }
}

/* ═══════════════════════════════════════════════════
   WebRTC — CREATOR
   Uses LIVE Realtime Database for signaling.
   ═══════════════════════════════════════════════════ */
async function _startCreatorWebRTC() {
  if (!_localStream) {
    toast('Camera or mic not available.');
    return;
  }

  /* ── Per-viewer signaling ────────────────────────────────────────────
     Each viewer connects via its own node:
       liveConnections/{roomId}/{viewerUid}
         ├── request    { createdAt }            — viewer asks for an offer
         ├── offer       { type, sdp }           — host writes a fresh offer
         ├── answer      { type, sdp }           — viewer writes its answer
         ├── creatorCandidates/{key} { ... }     — host ICE candidates
         └── viewerCandidates/{key}  { ... }     — viewer ICE candidates

     The host keeps a separate RTCPeerConnection per viewer so it can
     stream to many viewers AND so a viewer that leaves and comes back
     gets a brand-new offer (the old "single shared node" design left a
     stale answer in RTDB that the host ignored on the second connect,
     which is exactly why returning viewers saw a black "Waiting for
     stream…" screen).
  ─────────────────────────────────────────────────────────────────── */

  const connRootRef = ref(_liveDB, `liveConnections/${_roomId}`);

  // Register onDisconnect so the room ends if the host drops.
  try {
    await onDisconnect(ref(_liveDB, `liveRooms/${_roomId}`)).update({
      status: 'ended', isLive: false, endedAt: Date.now(),
    });
  } catch (_) {}

  // Watch for viewers appearing under liveConnections/{roomId}.
  _creatorConnUnsub = onValue(connRootRef, async snap => {
    const viewers = snap.val() || {};
    // Tear down peers for viewers that have left (node removed).
    for (const viewerUid of Object.keys(_creatorViewerPeers)) {
      if (!viewers[viewerUid]) {
        _teardownCreatorViewerPeer(viewerUid);
      }
    }
    // Handle viewers that have requested an offer.
    for (const viewerUid of Object.keys(viewers)) {
      const vData = viewers[viewerUid];
      // A viewer with a request but no offer needs a fresh peer.
      if (!vData || !vData.request || vData.offer) continue;
      // If we already have a peer for this viewer but they re-requested
      // (their node was reset via set()), tear it down and rebuild.
      if (_creatorViewerPeers[viewerUid]) {
        _teardownCreatorViewerPeer(viewerUid);
      }
      _handleViewerConnection(viewerUid).catch(() => {});
    }
  });

  toast('Live now');
}

/* ─────────────────────────────────────────────────────────────────────
   Host: create a fresh peer connection + offer for one viewer.
   ───────────────────────────────────────────────────────────────────── */
async function _handleViewerConnection(viewerUid) {
  if (!_localStream || !_roomId) return;
  // Tear down any previous peer for this viewer (shouldn't exist, but be safe).
  _teardownCreatorViewerPeer(viewerUid);
  // Reserve the slot immediately so the watcher doesn't double-handle
  // this viewer while we're still creating the offer.
  _creatorViewerPeers[viewerUid] = { pc: null, appliedCandKeys: new Set(), unsub: null };

  const pc = new RTCPeerConnection(_ICE_SERVERS);
  _attachIceWatchdog(pc, `host→viewer:${viewerUid}`);

  // Add tracks (sendonly) and constrain video encoding.
  _localStream.getTracks().forEach(track => pc.addTrack(track, _localStream));
  pc.getTransceivers().forEach(tc => {
    tc.direction = 'sendonly';
    if (tc.sender && tc.sender.track && tc.sender.track.kind === 'video') {
      const params = tc.sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate            = 3_000_000;
      params.encodings[0].maxFramerate          = 30;
      params.encodings[0].scaleResolutionDownBy = 1;
      tc.sender.setParameters(params).catch(() => {});
    }
  });

  const appliedCandKeys = new Set();
  const pendingCands    = [];
  let   offerWritten    = false;

  const viewerConnRef = ref(_liveDB, `liveConnections/${_roomId}/${viewerUid}`);

  // Buffer ICE until the offer is written so none are lost.
  pc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    if (!offerWritten) { pendingCands.push(e.candidate.toJSON()); return; }
    try { await push(ref(_liveDB, `liveConnections/${_roomId}/${viewerUid}/creatorCandidates`), e.candidate.toJSON()); }
    catch (_) {}
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      _startAdaptiveQuality(pc);
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      // Viewer's peer failed/closed — clean it up.
      if (_creatorViewerPeers[viewerUid] && _creatorViewerPeers[viewerUid].pc === pc) {
        _teardownCreatorViewerPeer(viewerUid);
      }
    }
  };

  // Create + set local description (offer) with a 10s timeout.
  let offer;
  try {
    offer = await Promise.race([
      pc.createOffer(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('createOffer timed out after 5s')), 5000)),
    ]);
  } catch (e) {
    _teardownCreatorViewerPeer(viewerUid);
    return;
  }
  try { await pc.setLocalDescription(offer); }
  catch (e) { _teardownCreatorViewerPeer(viewerUid); return; }

  // Write the per-viewer offer.
  try {
    await update(viewerConnRef, {
      offer: { type: offer.type, sdp: offer.sdp },
    });
    offerWritten = true;
  } catch (e) {
    _teardownCreatorViewerPeer(viewerUid);
    return;
  }

  // Flush buffered candidates.
  if (pendingCands.length) {
    for (const cand of pendingCands) {
      try { await push(ref(_liveDB, `liveConnections/${_roomId}/${viewerUid}/creatorCandidates`), cand); } catch (_) {}
    }
    pendingCands.length = 0;
  }

  // Watch this viewer's node for its answer + ICE candidates.
  const unsub = onValue(viewerConnRef, async snap => {
    if (!snap.exists()) return;
    const d = snap.val();
    if (d.answer && pc.remoteDescription === null) {
      try { await pc.setRemoteDescription(new RTCSessionDescription(d.answer)); }
      catch (_) {}
    }
    if (pc.remoteDescription && d.viewerCandidates) {
      for (const [key, cand] of Object.entries(d.viewerCandidates)) {
        if (appliedCandKeys.has(key)) continue;
        appliedCandKeys.add(key);
        try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
      }
    }
  });

  _creatorViewerPeers[viewerUid] = { pc, appliedCandKeys, unsub };
}

/* ─────────────────────────────────────────────────────────────────────
   Host: tear down one viewer's peer connection + listener.
   ───────────────────────────────────────────────────────────────────── */
function _teardownCreatorViewerPeer(viewerUid) {
  const peer = _creatorViewerPeers[viewerUid];
  if (!peer) return;
  if (peer.unsub) { try { peer.unsub(); } catch (_) {} }
  if (peer.pc)    { try { peer.pc.close(); } catch (_) {} }
  delete _creatorViewerPeers[viewerUid];
}

/* ─────────────────────────────────────────────────────────────────────
   Host: tear down ALL viewer peer connections + the main listener.
   ───────────────────────────────────────────────────────────────────── */
function _teardownAllCreatorViewerPeers() {
  for (const viewerUid of Object.keys(_creatorViewerPeers)) {
    _teardownCreatorViewerPeer(viewerUid);
  }
  if (_creatorConnUnsub) { try { _creatorConnUnsub(); } catch (_) {} _creatorConnUnsub = null; }
}

/* ═══════════════════════════════════════════════════
   WebRTC — VIEWER
   Uses LIVE Realtime Database for signaling.
   ═══════════════════════════════════════════════════ */
async function _startViewerWebRTC(roomData) {
  // Reset the first-frame banner flag for this (re)connection attempt.
  // Declared here (function scope) so the reset on line 1 works without
  // hitting the temporal dead zone from the later let.
  let _frameBannerHidden = false;
  let _playRetries        = 0;
  _showConnBanner('Connecting\u2026', '');

  if (!_user || !_user.uid) {
    _showConnBanner('Connecting\u2026', '');
    return;
  }

  const viewerUid   = _user.uid;
  const viewerConnRef = ref(_liveDB, `liveConnections/${_roomId}/${viewerUid}`);

  // ── CONNECTION REUSE: If we already have a healthy RTCPeerConnection
  //    with an active video track, don't tear it down and start over.
  //    This prevents redundant connection attempts when the viewer
  //    re-enters the live room or a spurious reconnect is scheduled
  //    while the stream is still playing. Only tear down if the
  //    connection is dead (disconnected/failed/closed) or has no track.
  if (_rtcPc) {
    const state = _rtcPc.connectionState;
    const hasVideoTrack = _rtcPc.getReceivers ? _rtcPc.getReceivers().some(r => r.track && r.track.kind === 'video' && r.track.readyState === 'live') : false;
    if ((state === 'connected' || state === 'connecting') && hasVideoTrack && D.liveVideo && D.liveVideo.srcObject) {
      // The stream is already playing — keep the existing connection and
      // just make sure the banner is hidden.
      _hideBannerOnFirstFrame();
      return;
    }
    // Otherwise tear down the dead/stale connection before creating a new one.
    try { _rtcPc.close(); } catch (_) {}
    _rtcPc = null;
  }
  if (_rtcSignalRef && _rtcSignalUnsub) {
    try { off(_rtcSignalRef); } catch (_) {}
    _rtcSignalRef = null; _rtcSignalUnsub = null;
  }

  // TIKTOK-STYLE: Create the RTCPeerConnection FIRST (local, synchronous)
  // so ICE candidate gathering starts immediately. Then fire the set()
  // request and onDisconnect() in parallel — don't block on onDisconnect
  // since it's just a safety net, not on the critical path.
  _rtcPc = new RTCPeerConnection(_ICE_SERVERS);
  _attachIceWatchdog(_rtcPc, 'viewer→host');

  // ── PRE-WARM CHECK: If index.html already started the signaling
  //    handshake (pre-warm), the host may have already written an offer
  //    to our RTDB node. Check for it FIRST — if there's already an
  //    offer, we skip the "write request → wait for host" cycle entirely.
  //    This is what makes the video appear almost instantly on click. ──
  let _prewarmedOffer = null;
  try {
    const existingSnap = await get(viewerConnRef);
    if (existingSnap.exists() && existingSnap.val().offer) {
      _prewarmedOffer = existingSnap.val();
    }
  } catch (_) {}

  if (!_prewarmedOffer) {
    // No pre-warmed offer — write a fresh request as usual.
    // ── 1. Write a fresh "request" so the host creates a per-viewer offer ──
    try {
      await set(viewerConnRef, {
        request:            { createdAt: Date.now() },
        offer:              null,
        answer:             null,
        creatorCandidates:  null,
        viewerCandidates:   null,
      });
    } catch (e) {
      _showConnBanner('Connecting\u2026', '');
      return;
    }
  }
  // else: The pre-warm already wrote the request and the host already
  // responded with an offer. We'll use it directly below.

  // If the host drops, remove our signaling node so a returning host
  // gets a clean slate (avoids stale-offer confusion). Fire-and-forget
  // — don't block the critical path on this safety net.
  try { onDisconnect(viewerConnRef).remove(); } catch (_) {}

  // ── AGGRESSIVE PLAYBACK: Retry play() up to 3 times. On mobile browsers,
  //    the first play() call can be interrupted or deferred. We retry with
  //    a small delay to ensure the video starts decoding ASAP. ──
  function _kickoffPlayback() {
    if (!D.liveVideo || !D.liveVideo.srcObject) return;
    const p = D.liveVideo.play();
    if (p && typeof p.then === 'function') {
      p.catch(() => {
        if (_playRetries < 3) {
          _playRetries++;
          setTimeout(_kickoffPlayback, 300);
        }
      });
    }
  }

  // ── FIRST-FRAME DETECTION: Hide the "Connecting…" banner ONLY when the
  //    video has an actual frame to show — not when the track merely
  //    arrives. This eliminates the black screen gap between connection
  //    and first frame render.
  //
  //    Strategy (ordered by speed):
  //    1. requestVideoFrameCallback — fires the moment a frame is painted
  //    2. 'loadeddata' event — fires when the first frame is available
  //    3. 'playing' event — fires when playback actually starts
  //    4. Polling readyState — fallback for older browsers
  //    5. 10s safety timeout — if nothing works, hide the banner anyway ──
  function _hideBannerOnFirstFrame() {
    if (_frameBannerHidden) return;
    const v = D.liveVideo;
    if (!v) return;

    // Check if already playing (race condition — track arrived fast)
    if (v.readyState >= 2 && !v.paused && v.currentTime > 0) {
      _frameBannerHidden = true;
      _hideConnBanner();
      return;
    }

    // Method 1: requestVideoFrameCallback (Chrome 83+) — fires when a frame
    // is actually painted to the screen. This is the earliest possible signal.
    if ('requestVideoFrameCallback' in v) {
      v.requestVideoFrameCallback(() => {
        if (_frameBannerHidden) return;
        _frameBannerHidden = true;
        _hideConnBanner();
      });
    }

    // Method 2: 'loadeddata' — fires when the first frame of the media
    // has finished loading. Not as precise as rVFC but widely supported.
    v.addEventListener('loadeddata', () => {
      if (_frameBannerHidden) return;
      // Double-check: loadeddata can fire without an actual frame on some
      // browsers. Verify readyState >= 2 (HAVE_CURRENT_DATA).
      if (v.readyState >= 2) {
        _frameBannerHidden = true;
        _hideConnBanner();
      }
    }, { once: true });

    // Method 3: 'playing' — fires when playback has actually started.
    v.addEventListener('playing', () => {
      if (_frameBannerHidden) return;
      _frameBannerHidden = true;
      _hideConnBanner();
    }, { once: true });

    // Method 4: Poll readyState for 8 seconds (fallback for browsers that
    // don't fire the events above reliably).
    let _pollCount = 0;
    const _pollInterval = setInterval(() => {
      _pollCount++;
      if (_frameBannerHidden) { clearInterval(_pollInterval); return; }
      if (v.readyState >= 2 && !v.paused && v.currentTime > 0) {
        _frameBannerHidden = true;
        _hideConnBanner();
        clearInterval(_pollInterval);
      } else if (_pollCount > 30) { // 30 × 200ms = 6 seconds
        // Safety: if no frame after 6s, hide the banner to avoid
        // leaving the user stuck on "Connecting…" forever.
        _frameBannerHidden = true;
        _hideConnBanner();
        clearInterval(_pollInterval);
      }
    }, 200);

    // Method 5: Absolute safety timeout at 7s (reduced from 10s).
    // The first-frame detection methods above should fire within 1-2s of
    // the video track arriving. This is just a backstop for edge cases.
    setTimeout(() => {
      if (!_frameBannerHidden) {
        _frameBannerHidden = true;
        _hideConnBanner();
      }
    }, 7000);
  }

  _rtcPc.ontrack = (e) => {
    if (!D.liveVideo) return;
    const stream = e.streams[0] || new MediaStream([e.track]);
    D.liveVideo.srcObject = stream;
    D.liveVideo.muted = true;
    // Buffer / mobile optimisation: low-latency mode where supported
    if ('playsInline' in D.liveVideo) D.liveVideo.playsInline = true;
    if (typeof D.liveVideo.disableRemotePlayback !== 'undefined') D.liveVideo.disableRemotePlayback = true;
    // Prefer low-latency (Chrome hint)
    try { D.liveVideo.setPreferredQuality && D.liveVideo.setPreferredQuality('auto'); } catch(_) {}
    // Kick off playback the instant the track arrives. Use a retry loop
    // because the first play() can be interrupted by the browser on some
    // mobile devices. We retry up to 3 times with a small delay.
    _kickoffPlayback();
    _showUnmutePrompt();
    // ── DON'T hide the banner yet! The track arrived but no frame is
    //    rendered yet — the viewer would see a black screen. We hide the
    //    banner ONLY when the first frame is actually painted. ──
    _hideBannerOnFirstFrame();

    // ── If the guest grid is already showing a host cell, attach the stream now ──
    const hostCell = D.guestGrid?.querySelector('.vgc-cell.host-cell');
    if (hostCell && !hostCell.querySelector('video')) {
      _attachHostVideoToCell(hostCell);
    }
  };

  _rtcPc.onconnectionstatechange = () => {
    const state = _rtcPc.connectionState;
    if (state === 'connected') {
      // DON'T hide the banner here — 'connected' means the ICE transport
      // is up, but the video hasn't rendered a frame yet. Let the
      // first-frame handler (_hideBannerOnFirstFrame) hide the banner
      // only when there's actually something to see. This prevents the
      // black screen gap between "connected" and "first frame".
      _viewerReconnectAttempt = 0; // reset on successful connection
    } else if (state === 'disconnected' || state === 'failed') {
      _showConnBanner('Reconnecting\u2026', '');
      _scheduleViewerReconnect(roomData);
    }
  };

  /* ── 2. Wait for the host to write a fresh offer to our node ──
     PRE-WARM OPTIMISATION: If we already got the offer from the pre-warm
     check above, skip the wait entirely. This is the key to instant video:
     the offer was already waiting in RTDB before the user even clicked.
     Otherwise, we set up the onValue listener IMMEDIATELY and race it
     against a single get(), so the offer is consumed the very instant the
     host writes it — no blocking round-trip. */
  let offerSnap = null;
  // If the pre-warm already got the offer, use it immediately — don't wait.
  if (_prewarmedOffer) {
    offerSnap = { exists: () => true, val: () => _prewarmedOffer };
  }
  const waitRef = viewerConnRef;
  if (!offerSnap) try {
    offerSnap = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (snap) => { if (!settled) { settled = true; resolve(snap); } };
      // 5s overall timeout (reduced from 8s — fail fast, then reconnect).
      // With the pre-warm from index.html, the offer is often already
      // waiting in RTDB before this code runs, so the timeout rarely fires.
      // When it does, failing fast lets the reconnect logic kick in sooner.
      const to = setTimeout(() => { _tmpViewerWaitRef = null; _tmpViewerWaitListener = null; resolve(null); }, 5000);
      const waitListener = onValue(waitRef, snap => {
        if (snap.exists() && snap.val().offer) {
          clearTimeout(to);
          try { off(waitRef, waitListener); } catch (_) {}
          finish(snap);
        }
      });
      // Store so we can clean up on early return / error.
      _tmpViewerWaitRef = waitRef;
      _tmpViewerWaitListener = waitListener;
      // In case the host already wrote the offer before the listener attached,
      // also do a single get() and resolve if it already has an offer. This
      // covers the rare race where the listener missed the initial event.
      get(waitRef).then(snap => {
        if (!settled && snap.exists() && snap.val().offer) {
          clearTimeout(to);
          try { off(waitRef, waitListener); } catch (_) {}
          finish(snap);
        }
      }).catch(() => {});
    });
  } catch (e) {
    _showConnBanner('Connecting\u2026', '');
    return;
  }

  // Detach the wait listener if it's still attached.
  // (The pre-warm path skips this entirely since offerSnap is already set.)
  if (_tmpViewerWaitRef && _tmpViewerWaitListener) {
    try { off(_tmpViewerWaitRef, _tmpViewerWaitListener); } catch (_) {}
    _tmpViewerWaitRef = null; _tmpViewerWaitListener = null;
  }

  if (!offerSnap || !offerSnap.exists() || !offerSnap.val().offer) {
    // No offer in time — schedule a reconnect attempt.
    _scheduleViewerReconnect(roomData);
    return;
  }

  const offer = offerSnap.val().offer;
  try {
    await _rtcPc.setRemoteDescription(new RTCSessionDescription(offer));
  } catch (e) {
    _showConnBanner('Connecting\u2026', '');
    return;
  }

  /* ── Wire ICE handler BEFORE createAnswer so viewer candidates aren't lost ── */
  const _viewerPendingCands = [];
  let   _viewerAnswerWritten = false;

  _rtcPc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    if (!_viewerAnswerWritten) {
      _viewerPendingCands.push(e.candidate.toJSON());
      return;
    }
    try {
      await push(ref(_liveDB, `liveConnections/${_roomId}/${viewerUid}/viewerCandidates`), e.candidate.toJSON());
    } catch (_) {}
  };

  const answer = await _rtcPc.createAnswer();
  await _rtcPc.setLocalDescription(answer);

  /* ── Write answer to our per-viewer node in RTDB ── */
  try {
    await update(viewerConnRef, {
      answer: { type: answer.type, sdp: answer.sdp },
    });
    _viewerAnswerWritten = true;
  } catch (e) {
    _showConnBanner('Connecting\u2026', '');
    return;
  }

  /* ── Flush any viewer ICE candidates buffered before the answer was written ── */
  if (_viewerPendingCands.length) {
    for (const cand of _viewerPendingCands) {
      try { await push(ref(_liveDB, `liveConnections/${_roomId}/${viewerUid}/viewerCandidates`), cand); } catch (_) {}
    }
    _viewerPendingCands.length = 0;
  }

  /* ── Apply existing creator ICE candidates ── */
  let _appliedCreatorCandKeys = new Set();
  const existingCands = offerSnap.val().creatorCandidates || {};
  for (const [key, cand] of Object.entries(existingCands)) {
    _appliedCreatorCandKeys.add(key);
    try { await _rtcPc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
  }

  /* ── Listen for new creator ICE candidates on our node ── */
  _rtcSignalRef   = viewerConnRef;
  _rtcSignalUnsub = onValue(viewerConnRef, async snap => {
    if (!snap.exists()) return;
    const d = snap.val();
    if (d.creatorCandidates) {
      for (const [key, cand] of Object.entries(d.creatorCandidates)) {
        if (_appliedCreatorCandKeys.has(key)) continue;
        _appliedCreatorCandKeys.add(key);
        try { await _rtcPc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
      }
    }
  });

  _showConnBanner('Connecting\u2026', '');

  // ── Safety: the first-frame handler (_hideBannerOnFirstFrame) will hide
  //    the banner as soon as a frame is actually rendered. This 1.5s
  //    timeout is just a backstop in case the events fire too fast. ──
}

// Temp holders for the viewer's "wait for offer" listener so it can be
// detached cleanly once the host writes the per-viewer offer.
let _tmpViewerWaitRef      = null;
let _tmpViewerWaitListener = null;
/* ═══════════════════════════════════════════════════
   STREAM QUALITY PROFILES
   Phone sends 720p 30fps 3000 kbps CBR by default.
   Auto-quality shifts between tiers based on
   bandwidth and packet-loss measured every 10 s.
   ═══════════════════════════════════════════════════ */

/**
 * Sender-side quality tiers (used by _startAdaptiveQuality).
 *
 * Tier selection on the SENDER is driven by packet-loss rate
 * (what the creator's upload path can sustain). The viewer's
 * playback simply receives whatever the sender transmits —
 * because this is a direct P2P WebRTC stream there is only one
 * encoded copy, so "viewer quality switching" means the sender
 * adapts to network conditions automatically.
 *
 *  Tier  | Resolution | maxBitrate | scaleDown | Condition
 *  ------+------------+------------+-----------+-------------------
 *  HIGH  | 1080p      | 6 000 kbps |     1     | loss < 3 %
 *  MED   | 720p       | 3 000 kbps |     1     | loss 3–10 %  (default)
 *  LOW   | 480p       | 1 500 kbps |  ~1.5     | loss 10–20 %
 *  MIN   | ~240p      |   600 kbps |     3     | loss > 20 %
 */
const _QUALITY_TIERS = [
  { name: 'HIGH', maxBitrate: 6_000_000, scaleDown: 1,   lossThreshold: 0.03  },
  { name: 'MED',  maxBitrate: 3_000_000, scaleDown: 1,   lossThreshold: 0.10  },
  { name: 'LOW',  maxBitrate: 1_500_000, scaleDown: 1.5, lossThreshold: 0.20  },
  { name: 'MIN',  maxBitrate:   600_000, scaleDown: 3,   lossThreshold: Infinity },
];

let _adaptiveQualityTimer    = null;
let _adaptiveQualityTierIdx  = 1; // start at MED (720p / 3000 kbps)

function _startAdaptiveQuality(pc) {
  if (_adaptiveQualityTimer) return; // already running

  let _prevPacketsSent = 0;
  let _prevPacketsLost = 0;

  _adaptiveQualityTimer = setInterval(async () => {
    if (!pc || pc.connectionState !== 'connected') {
      clearInterval(_adaptiveQualityTimer);
      _adaptiveQualityTimer = null;
      return;
    }

    try {
      const stats = await pc.getStats();
      let totalSent = 0, totalLost = 0, totalBytesSent = 0;

      stats.forEach(report => {
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          totalSent      += report.packetsSent  || 0;
          totalLost      += report.packetsLost  || 0;
          totalBytesSent += report.bytesSent    || 0;
        }
      });

      const deltaSent = totalSent - _prevPacketsSent;
      const deltaLost = totalLost - _prevPacketsLost;
      _prevPacketsSent = totalSent;
      _prevPacketsLost = totalLost;

      if (deltaSent < 10) return; // not enough data yet

      const lossRate = deltaSent > 0 ? Math.max(0, deltaLost) / deltaSent : 0;

      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (!sender) return;

      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) return;

      // Determine which tier we should be in
      let targetIdx = _QUALITY_TIERS.length - 1; // default: lowest
      for (let i = 0; i < _QUALITY_TIERS.length; i++) {
        if (lossRate < _QUALITY_TIERS[i].lossThreshold) { targetIdx = i; break; }
      }

      // Only change tier when moving down immediately, or when improving
      // after two consecutive good intervals (hysteresis to avoid flapping)
      if (targetIdx === _adaptiveQualityTierIdx) return;

      // Allow instant degradation; require loss to be below prev tier threshold
      // for at least one check before upgrading (simple 1-step hysteresis)
      if (targetIdx > _adaptiveQualityTierIdx) {
        // degrading → apply immediately
      } else {
        // upgrading → only move one tier at a time
        targetIdx = _adaptiveQualityTierIdx - 1;
        if (lossRate >= _QUALITY_TIERS[targetIdx].lossThreshold) return;
      }

      _adaptiveQualityTierIdx = targetIdx;
      const tier = _QUALITY_TIERS[targetIdx];

      params.encodings[0].maxBitrate           = tier.maxBitrate;
      params.encodings[0].scaleResolutionDownBy = tier.scaleDown;
      await sender.setParameters(params).catch(() => {});
      console.log(`[AdaptiveQuality] → ${tier.name} (loss:${(lossRate*100).toFixed(1)}%  bitrate:${tier.maxBitrate/1000}kbps)`);

    } catch(_) {}
  }, 10_000);
}

function _stopAdaptiveQuality() {
  if (_adaptiveQualityTimer) {
    clearInterval(_adaptiveQualityTimer);
    _adaptiveQualityTimer   = null;
    _adaptiveQualityTierIdx = 1; // reset to MED for next session
  }
}

/* ═══════════════════════════════════════════════════
   VIEWER AUTO-RECONNECT
   ═══════════════════════════════════════════════════ */

/**
 * Schedule a WebRTC reconnect attempt with exponential back-off.
 * Clears the old peer connection before creating a new one so listeners
 * and ICE candidates don't pile up.
 */
function _scheduleViewerReconnect(roomData) {
  if (_viewerLeftFlag) return;  // viewer already left
  if (_viewerReconnectAttempt >= _MAX_RECONNECT_ATTEMPTS) {
    _showConnBanner('Stream unavailable', 'Could not reconnect. The stream may have ended.');
    return;
  }

  if (_viewerReconnectTimer) clearTimeout(_viewerReconnectTimer);

  const delay = Math.min(500 * Math.pow(1.6, _viewerReconnectAttempt), 10000);
  _viewerReconnectAttempt++;
  console.log(`[WebRTC] Reconnect attempt ${_viewerReconnectAttempt} in ${delay}ms`);

  _viewerReconnectTimer = setTimeout(async () => {
    _viewerReconnectTimer = null;
    if (_viewerLeftFlag) return;

    // Tear down old peer connection + signal listener
    if (_rtcPc) { try { _rtcPc.close(); } catch(_){} _rtcPc = null; }
    if (_rtcSignalRef && _rtcSignalUnsub) {
      try { off(_rtcSignalRef); } catch(_) {}
      _rtcSignalRef = null; _rtcSignalUnsub = null;
    }
    // Detach the "wait for offer" listener if still attached.
    if (_tmpViewerWaitRef && _tmpViewerWaitListener) {
      try { off(_tmpViewerWaitRef, _tmpViewerWaitListener); } catch(_) {}
      _tmpViewerWaitRef = null; _tmpViewerWaitListener = null;
    }
    // Remove our previous per-viewer signaling node so the host drops the
    // stale peer and the fresh request (written by _startViewerWebRTC)
    // triggers a brand-new offer.
    if (_user && _roomId) {
      try { await remove(ref(_liveDB, `liveConnections/${_roomId}/${_user.uid}`)); } catch(_) {}
    }
    // Cancel the old presence-seat onDisconnect so a stale remove()
    // doesn't fire after the reconnect writes a fresh seat.
    // Clear _viewerPresenceJoined so _startViewer can re-register the seat.
    if (_viewerPresenceOdc) {
      try { await _viewerPresenceOdc.cancel(); } catch(_) {}
      _viewerPresenceOdc = null;
    }
    _viewerPresenceJoined = false;

    // Verify stream is still live before attempting
    try {
      const snap = await get(ref(_liveDB, `liveRooms/${_roomId}`));
      if (!snap.exists() || snap.val().status !== 'live') {
        _showEndedOverlay(false, 'Stream ended', `${roomData.hostName} has ended the live stream.`);
        return;
      }
    } catch(_) {}

    // Re-run the WebRTC viewer setup
    await _startViewerWebRTC(roomData);
  }, delay);
}

/* ═══════════════════════════════════════════════════
   CHAT — Firestore sub-collection
   ═══════════════════════════════════════════════════ */
function _subscribeChat() {
  if (!_roomId) return;
  // Unsubscribe any previous listener before creating a new one
  if (_chatUnsub) { try { _chatUnsub(); } catch(_){} _chatUnsub = null; }
  const q = query(
    collection(_db, 'liveRooms', _roomId, 'liveMessages'),
    orderBy('createdAt', 'asc'),
    limit(100)   // reduced: keeps DOM lean and memory lower
  );
  _chatUnsub = onSnapshot(q, snap => {
    // Batch all 'added' changes into a single DocumentFragment
    const frag = document.createDocumentFragment();
    let hasNew = false;
    snap.docChanges().forEach(ch => {
      if (ch.type === 'added') {
        const el = _buildChatMsgEl(ch.doc.data());
        if (el) { frag.appendChild(el); hasNew = true; }
      }
    });
    if (!hasNew) return;
    const cm = D.chatMessages;
    if (!cm) return;

    // Measure scroll position BEFORE appending (avoids forced reflow after paint)
    const atBottom = cm.scrollHeight - cm.scrollTop - cm.clientHeight < 120;
    cm.appendChild(frag);

    // Trim old messages (keep max 70 visible) — do after append
    while (cm.children.length > 70) {
      cm.removeChild(cm.firstChild);
    }

    // Auto-scroll only if already near bottom
    if (atBottom) cm.scrollTop = cm.scrollHeight;
  }, () => {});
}

function _buildChatMsgEl(data) {
  const hostUid  = _roomId ? _roomId.split('_')[0] : null;
  const isHost   = !!(hostUid && data.userId === hostUid);
  const isSystem = data.type === 'system';

  const el = document.createElement('div');
  el.className = 'live-chat-msg' + (isSystem ? ' system' : '');
  if (!isSystem) {
    const author = document.createElement('span');
    author.className = 'live-chat-author' + (isHost ? ' is-host' : '');
    author.textContent = data.userName || 'Guest';
    const text = document.createElement('span');
    text.className = 'live-chat-text';
    text.textContent = data.text || '';
    el.appendChild(author);
    el.appendChild(text);
  } else {
    const text = document.createElement('span');
    text.className = 'live-chat-text';
    text.textContent = data.text || '';
    el.appendChild(text);
  }
  return el;
}

function _appendChatMsg(data) {
  if (!D.chatMessages) return;
  const el = _buildChatMsgEl(data);
  if (!el) return;
  const cm = D.chatMessages;
  const atBottom = cm.scrollHeight - cm.scrollTop - cm.clientHeight < 120;
  cm.appendChild(el);
  while (cm.children.length > 70) cm.removeChild(cm.firstChild);
  if (atBottom) cm.scrollTop = cm.scrollHeight;
}

/* ── Live chat AI safety rules (mirrors index.html _RULES) ── */
const _LIVE_RULES = [
  { category: 'Threats',           severity: 'block', patterns: [
      /\bi('?ll| will|'m going to|m gonna|gonna|will)\s+(kill|hurt|murder|destroy|beat|shoot|stab|end)\s+(you|u|them|him|her)/i,
      /\b(kill\s*your?self|kys|go\s*die|i\s*will\s*find\s*you|watch\s*your\s*back|you('re|\s+are)\s+dead|dead\s*man|dead\s*girl|die\s*bitch)\b/i,
      /\b(bomb|shoot up|blow up|attack)\s*(the\s*)?(school|place|building|event)/i,
  ]},
  { category: 'Hate Speech',       severity: 'block', patterns: [
      /\b(f+u+c+k+\s*(all\s*)?(blacks?|whites?|jews?|muslims?|christians?|gays?|lesbians?|trans|latinos?|asians?|mexicans?|arabs?))\b/i,
      /\b(all\s+(blacks?|whites?|jews?|muslims?|gays?|lesbians?|trans|latinos?|asians?)\s+should\s+(die|be\s+killed|disappear|burn))\b/i,
      /\b(white\s*power|white\s*supremac|ethnic\s*cleans|n[i1]+gg[e3]r|ch[i1]nk|sp[i1]c|k[i1]ke|f[a4]gg[o0]t|tr[a4]nny)\b/i,
  ]},
  { category: 'Doxxing',           severity: 'block', patterns: [
      /\b(here('?s|\s+is)\s+(your|his|her|their)\s+(address|phone|number|location|ip\s*address|home|school|work))\b/i,
      /\b(i\s*(know|found)\s+where\s+you\s+(live|work|go\s+to\s+school))\b/i,
  ]},
  { category: 'Self-Harm Promotion', severity: 'block', patterns: [
      /\b(how\s+to\s+(properly\s+)?(cut|harm|hurt)\s+(yourself|myself)|best\s+way\s+to\s+(overdose|die|end\s+(it|your\s+life)))\b/i,
      /\b(just\s+(do\s+it|end\s+it|kill\s+yourself|hurt\s+yourself)\s+(already|please|nobody\s+cares))\b/i,
  ]},
  { category: 'Harassment',        severity: 'warn',  patterns: [
      /\b(shut\s*(the\s*f[uck*@]+\s*)?up\s+(you\s+)?(stupid|dumb|idiot|ugly|fat|loser|worthless|pathetic|disgusting)\b)/i,
      /\b(nobody\s+(likes?|cares\s*about)\s+you|you\s+(are|r|re)\s+(worthless|pathetic|trash|garbage|a\s+loser|disgusting|nothing))\b/i,
  ]},
  { category: 'Spam',              severity: 'warn',  patterns: [
      /(.)\1{19,}/,
      /(\b\w+\b)(\s+\1){7,}/i,
  ]},
];

function _liveScanText(text) {
  if (!text) return null;
  for (const rule of _LIVE_RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(text)) return rule;
    }
  }
  return null;
}

async function sendChat() {
  if (!_user || !_roomId) return;
  // Guard against double-send (rapid taps / Enter+click combo)
  if (_chatSending) return;

  const text = (D.chatInput?.value || '').trim();
  if (!text || text.length > 200) return;

  // ── AI Safety scan ──
  const hit = _liveScanText(text);
  if (hit) {
    const isMod = _userData?.role === 'founder' ||
                  _userData?.role === 'administrator' ||
                  _userData?.role === 'moderator';
    if (hit.severity === 'block' && !isMod) {
      toast(`🚫 Blocked · ${hit.category}: Keep it safe.`);
      return;   // hard block — do NOT clear input, let user edit
    }
    toast(`⚠️ Warning · ${hit.category}: Please keep the community safe.`);
  }

  // Clear input immediately so typing feels instant
  if (D.chatInput) {
    D.chatInput.value = '';
    D.chatInput.focus();
  }

  _chatSending = true;
  try {
    await addDoc(collection(_db, 'liveRooms', _roomId, 'liveMessages'), {
      userId:    _user.uid,
      userName:  _userData.displayName || 'Guest',
      text,
      type:      'chat',
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    toast('Could not send message.');
  } finally {
    _chatSending = false;
  }
}

/* ═══════════════════════════════════════════════════
   LIKES — LIVE RTDB
   ═══════════════════════════════════════════════════ */
let _hasLiked    = false;
let _likeCoolEnd = 0;   // timestamp when the tap cooldown expires

async function sendLike(clientX, clientY) {
  if (!_user || !_roomId) return;
  // Short tap cooldown (800 ms) to prevent accidental rapid-fire likes
  const now = Date.now();
  if (now < _likeCoolEnd) return;
  _likeCoolEnd = now + 800;

  // Spawn floating hearts at the tap position (or near the right edge as fallback)
  _spawnHeartBurst(clientX, clientY);

  // Only increment the like counter once per 5-second window per user
  if (_hasLiked) return;
  _hasLiked = true;

  // Fire-and-forget RTDB increment (keeps UI instant)
  (async () => {
    try {
      const likesRef = ref(_liveDB, `liveRooms/${_roomId}/likes`);
      const snap = await get(likesRef);
      await set(likesRef, (snap.val() || 0) + 1);
    } catch (_) {}
  })();

  setTimeout(() => { _hasLiked = false; }, 5000);
}

function _spawnHeartBurst(clientX, clientY) {
  const stage = D.stage;
  if (!stage) return;
  const rect = stage.getBoundingClientRect();

  // Spawn 3 hearts with slight random offsets for a burst effect
  const baseX = (clientX != null) ? (clientX - rect.left) : rect.width  * 0.75;
  const baseY = (clientY != null) ? (clientY - rect.top)  : rect.height * 0.65;

  const hearts = ['❤️', '💕', '❤️'];
  hearts.forEach((emoji, i) => {
    const el = document.createElement('div');
    el.className = 'like-burst';
    el.textContent = emoji;
    el.style.left     = (baseX + (Math.random() - 0.5) * 50) + 'px';
    el.style.top      = (baseY + (Math.random() - 0.5) * 30) + 'px';
    el.style.bottom   = '';   // use top instead of bottom so position is tap-relative
    el.style.position = 'absolute';
    el.style.animationDelay = (i * 80) + 'ms';
    stage.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  });
}

/* ═══════════════════════════════════════════════════
   UI HELPERS
   ═══════════════════════════════════════════════════ */
function _hideLoading() {
  if (D.loading) D.loading.style.display = 'none';
}

function _showStage() {
  if (D.stage) D.stage.classList.add('active');
}

let _connBannerPendingTimer = null;
let _connBannerPendingTitle  = '';
let _connBannerPendingSub    = '';

function _showConnBanner(title, sub) {
  if (!D.connBanner) return;
  // Don't show the banner if the video is already playing
  const v = D.liveVideo;
  if (v && v.srcObject && !v.paused && v.readyState >= 2) return;
  // Cancel any pending hide
  if (_connBannerPendingTimer) { clearTimeout(_connBannerPendingTimer); _connBannerPendingTimer = null; }
  // Grace period: delay showing the banner by 400ms. If the video arrives
  // within 400ms (fast connections), the banner never flashes on screen.
  _connBannerPendingTitle = title;
  _connBannerPendingSub   = sub;
  _connBannerPendingTimer = setTimeout(() => {
    _connBannerPendingTimer = null;
    // Re-check: video may have arrived during the grace period
    const v2 = D.liveVideo;
    if (v2 && v2.srcObject && !v2.paused && v2.readyState >= 2) return;
    if (D.connTitle) D.connTitle.textContent = _connBannerPendingTitle;
    if (D.connSub)   D.connSub.textContent   = _connBannerPendingSub;
    D.connBanner.classList.add('visible');
  }, 400);
}

function _hideConnBanner() {
  if (_connBannerPendingTimer) { clearTimeout(_connBannerPendingTimer); _connBannerPendingTimer = null; }
  if (D.connBanner) D.connBanner.classList.remove('visible');
}



function _showUnmutePrompt() {
  const p = D.unmutePrompt;
  if (!p) return;
  p.style.display = 'block';
  const _unmute = () => {
    if (D.liveVideo) D.liveVideo.muted = false;
    p.style.display = 'none';
    p.removeEventListener('click', _unmute);
    if (D.stage) D.stage.removeEventListener('click', _unmute);
  };
  p.addEventListener('click', _unmute);
  if (D.stage) D.stage.addEventListener('click', _unmute, { once: true });
}

function _showEndedOverlay(wasCreator, title, sub) {
  if (!D.ended) return;
  if (D.endedTitle) D.endedTitle.textContent = title || 'Stream ended';
  if (D.endedSub)   D.endedSub.textContent   = sub   || (wasCreator
    ? 'Your live stream has ended. Thanks for going live!'
    : 'The creator has ended this live stream.');
  D.ended.classList.add('visible');
  // Cancel pending reconnect so we don't try to reconnect to an ended stream
  if (_viewerReconnectTimer) { clearTimeout(_viewerReconnectTimer); _viewerReconnectTimer = null; }
  if (_rtcPc)  { try { _rtcPc.close(); } catch (_) {} _rtcPc = null; }
  if (_rtcSignalRef && _rtcSignalUnsub) { off(_rtcSignalRef); _rtcSignalRef = null; _rtcSignalUnsub = null; }
  if (_tmpViewerWaitRef && _tmpViewerWaitListener) {
    try { off(_tmpViewerWaitRef, _tmpViewerWaitListener); } catch(_) {}
    _tmpViewerWaitRef = null; _tmpViewerWaitListener = null;
  }
  // Remove our per-viewer signaling node (viewer side) so a future
  // reconnect starts clean.
  if (!wasCreator && _user && _roomId) {
    try { remove(ref(_liveDB, `liveConnections/${_roomId}/${_user.uid}`)); } catch(_) {}
  }
  // Viewer side: clean up presence seat so the count self-heals when
  // the stream ends or the host navigates away.
  if (!wasCreator && _viewerPresenceRef && !_viewerLeftFlag) {
    if (_viewerPresenceOdc) {
      try { _viewerPresenceOdc.cancel(); } catch(_) {}
      _viewerPresenceOdc = null;
    }
    _viewerPresenceJoined = false;
    try { remove(_viewerPresenceRef); } catch(_) {}
    _viewerPresenceRef = null;
  }
  // Creator side: tear down all viewer peers.
  if (wasCreator) _teardownAllCreatorViewerPeers();
  if (_chatUnsub) { _chatUnsub(); _chatUnsub = null; }
}

function onCloseBtn() {
  if (_mode === 'creator') {
    endLive();
  } else {
    _viewerLeave();
    window.location.href = 'index.html';
  }
}

/* ═══════════════════════════════════════════════════
   SHARE
   ═══════════════════════════════════════════════════ */
function shareLive() {
  if (!_roomId) { toast('Start your live first.'); return; }
  _openShareModal();
}

function _buildLiveUrl() {
  const base = window.location.origin + window.location.pathname.replace('live.html', '');
  return base + 'live.html#watch=' + _roomId;
}

function _openShareModal() {
  const old = document.getElementById('_snxShareModal');
  if (old) old.remove();

  const url      = _buildLiveUrl();
  const name     = _userData?.displayName || 'Someone';
  const shareMsg = `${name} is Live Now 🔴 — Watch: ${url}`;

  const modal = document.createElement('div');
  modal.id    = '_snxShareModal';
  modal.style.cssText = `
    position:fixed;inset:0;z-index:9999;
    display:flex;align-items:flex-end;justify-content:center;
    background:rgba(0,0,0,0.65);backdrop-filter:blur(4px);
  `;

  modal.innerHTML = `
    <div style="
      background:#0d2444;border:1px solid rgba(0,174,239,0.3);
      border-radius:20px 20px 0 0;padding:24px 20px 36px;
      width:100%;max-width:520px;
    ">
      <div style="text-align:center;font-size:16px;font-weight:800;color:#fff;margin-bottom:18px;">
        📤 Share Live Stream
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;">
        <button id="_snxShareCopyLink" style="
          background:rgba(0,174,239,0.12);border:1px solid rgba(0,174,239,0.4);
          border-radius:12px;padding:14px 18px;color:#00AEEF;font-size:14px;
          font-weight:700;cursor:pointer;text-align:left;display:flex;align-items:center;gap:12px;
        ">🔗 Copy Live Link</button>
        <button id="_snxShareToFeed" style="
          background:rgba(0,174,239,0.12);border:1px solid rgba(0,174,239,0.4);
          border-radius:12px;padding:14px 18px;color:#00AEEF;font-size:14px;
          font-weight:700;cursor:pointer;text-align:left;display:flex;align-items:center;gap:12px;
        ">📣 Share to Feed</button>
        <button id="_snxShareNative" style="
          background:rgba(0,174,239,0.12);border:1px solid rgba(0,174,239,0.4);
          border-radius:12px;padding:14px 18px;color:#00AEEF;font-size:14px;
          font-weight:700;cursor:pointer;text-align:left;display:flex;align-items:center;gap:12px;
        ">📲 Share to Friends / Apps</button>
      </div>
      <button id="_snxShareClose" style="
        margin-top:18px;width:100%;background:rgba(255,255,255,0.06);
        border:1px solid rgba(255,255,255,0.12);border-radius:12px;
        padding:12px;color:#6a90b8;font-size:14px;cursor:pointer;
      ">Cancel</button>
    </div>`;

  document.body.appendChild(modal);

  modal.querySelector('#_snxShareCopyLink').addEventListener('click', () => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url)
        .then(() => { toast('🔗 Live link copied!'); })
        .catch(() => { window.prompt('Copy this link:', url); });
    } else {
      window.prompt('Copy this link:', url);
    }
    _closeShareModal();
  });

  modal.querySelector('#_snxShareToFeed').addEventListener('click', async () => {
    _closeShareModal();
    try {
      await addDoc(collection(_db, 'posts'), {
        type:         'live_share',
        uid:          _user.uid,
        authorUid:    _user.uid,
        authorName:   _userData?.displayName || '',
        authorHandle: _userData?.username    || '',
        authorAvatar: _userData?.avatar      || '',
        liveRoomId:   _roomId,
        isLive:       true,
        text:         shareMsg,
        timestamp:    Date.now(),
        createdAt:    Date.now(),
        likes:        0,
        comments:     [],
      });
      toast('📣 Shared to Feed!');
    } catch (e) {
      toast('Could not share.');
    }
  });

  modal.querySelector('#_snxShareNative').addEventListener('click', () => {
    _closeShareModal();
    if (navigator.share) {
      navigator.share({
        title: '🔴 Watch me live on Shadow Nexus!',
        text:  shareMsg,
        url,
      }).catch(() => {});
    } else {
      window.prompt('Copy this link to share:', url);
    }
  });

  modal.querySelector('#_snxShareClose').addEventListener('click', _closeShareModal);
  modal.addEventListener('click', e => { if (e.target === modal) _closeShareModal(); });
}

function _closeShareModal() {
  const m = document.getElementById('_snxShareModal');
  if (m) m.remove();
}

function toast(msg, duration = 3200) {
  if (!D.toast) return;
  clearTimeout(_toastTimer);
  D.toast.textContent = msg;
  D.toast.classList.add('visible');
  _toastTimer = setTimeout(() => D.toast.classList.remove('visible'), duration);
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── One-time version/update check ──
   Asks the SW if a newer version is waiting. If one is available, notify
   once via toast with a manual refresh prompt. Never polls again in the
   same session (guarded by _updateChecked). ── */
function _checkForUpdate() {
  if (_updateChecked) return;
  _updateChecked = true;
  if (!('serviceWorker' in navigator)) return;

  // When a new SW takes over (after SKIP_WAITING), reload the page to apply updates.
  // Only reload when the user explicitly clicked the update bar — not on first install.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (sessionStorage.getItem('snx-sw-user-update')) {
      sessionStorage.removeItem('snx-sw-user-update');
      window.location.reload();
    }
  });

  navigator.serviceWorker.ready.then(reg => {
    // Trigger a background network check — does NOT block the page
    reg.update().then(() => {
      _showUpdateBarIfWaiting(reg);
    }).catch(() => {});

    // Also handle the case where a SW update event fires during this session
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          _showUpdateBarIfWaiting(reg);
        }
      });
    });
  }).catch(() => {});
}

function _showUpdateBarIfWaiting(reg) {
  if (!reg.waiting) return;
  // Already shown once? Don't show again
  if (document.getElementById('_snxUpdateBar')) return;

  const bar = document.createElement('div');
  bar.id = '_snxUpdateBar';
  bar.style.cssText = [
    'position:fixed','bottom:72px','left:50%','transform:translateX(-50%)',
    'z-index:9999','background:rgba(0,20,60,0.97)',
    'border:1px solid rgba(0,174,239,0.7)','border-radius:10px',
    'padding:10px 18px','font-size:13px','color:#00AEEF',
    'cursor:pointer','white-space:nowrap',
    'box-shadow:0 4px 18px rgba(0,0,0,0.5)',
  ].join(';');
  bar.textContent = '🔄 New version available — tap to refresh';
  bar.addEventListener('click', () => {
    bar.textContent = 'Updating…';
    // Signal the controllerchange handler that this reload is user-initiated
    sessionStorage.setItem('snx-sw-user-update', '1');
    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    // Reload will be triggered by the controllerchange event above
  });
  document.body.appendChild(bar);
  // Auto-dismiss after 15s — user can update later
  setTimeout(() => bar.remove(), 15000);
}

/* ── Confirmation dialog — Promise-based modal ──
   _snxConfirm({ icon, title, sub, okLabel, okClass })
   Resolves true (confirmed) or false (cancelled). */
function _snxConfirm({ icon = '❓', title = 'Are you sure?', sub = '', okLabel = 'Confirm', okClass = '' } = {}) {
  return new Promise(resolve => {
    // Remove any stale overlay
    document.getElementById('_snxConfirmOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = '_snxConfirmOverlay';
    overlay.className = 'snx-confirm-overlay';
    overlay.innerHTML = `
      <div class="snx-confirm-box">
        <div class="snx-confirm-icon">${icon}</div>
        <div class="snx-confirm-title">${_esc(title)}</div>
        ${sub ? `<div class="snx-confirm-sub">${_esc(sub)}</div>` : ''}
        <div class="snx-confirm-actions">
          <button class="snx-confirm-cancel">Cancel</button>
          <button class="snx-confirm-ok${okClass ? ' ' + okClass : ''}">${_esc(okLabel)}</button>
        </div>
      </div>
    `;

    const close = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector('.snx-confirm-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('.snx-confirm-ok').addEventListener('click',     () => close(true));
    // Tap backdrop to cancel
    overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });

    document.body.appendChild(overlay);
  });
}

/* ═══════════════════════════════════════════════════════════════
   VIEWER GUEST GRID — real-time presence display for followers
   ─────────────────────────────────────────────────────────────
   Watches liveGuests/{roomId} in RTDB.
   Each entry: { uid, name, avatar, camOn, micOn, isHost? }
   Renders placeholder cards (no live video) so all viewers see
   who is in each box and their cam/mic status in real time.
   ═══════════════════════════════════════════════════════════════ */

/* ── HOST: Broadcast current layout + size to all viewers via RTDB ── */
function _broadcastLayout() {
  if (!_roomId) return;
  try {
    update(ref(_liveDB, `liveRooms/${_roomId}`), {
      guestLayout:  _guestLayout,
      guestBoxSize: _guestBoxSize,
    });
  } catch(_) {}
}

/* ── VIEWER / GUEST: Subscribe to layout changes broadcast by the host ──
   For pure viewers the _roomWatchRef onValue already handles layout sync
   (see _startViewer).  For guests who joined a box mid-stream, the
   _roomWatchRef is also already running, so we just mark the unsub as a
   no-op to keep the cleanup code paths consistent. ── */
function _startLayoutSync() {
  if (!_roomId) return;
  // Detach any previous dedicated listener
  if (_layoutSyncUnsub) { try { _layoutSyncUnsub(); } catch(_) {} _layoutSyncUnsub = null; }

  // If _roomWatchRef is already listening (viewer path), reuse it — no new listener needed.
  if (_roomWatchRef) {
    // Provide a no-op unsub so cleanup code paths work unchanged
    _layoutSyncUnsub = () => {};
    return;
  }

  // Guest-only path (joined as guest without _roomWatchRef running):
  // subscribe to the room node for layout changes only.
  const roomRef = ref(_liveDB, `liveRooms/${_roomId}`);
  _layoutSyncUnsub = onValue(roomRef, snap => {
    if (!snap.exists()) return;
    const d = snap.val();
    let changed = false;
    if (d.guestLayout  && d.guestLayout  !== _guestLayout)  { _guestLayout  = d.guestLayout;  changed = true; }
    if (d.guestBoxSize && d.guestBoxSize !== _guestBoxSize)  { _guestBoxSize = d.guestBoxSize; changed = true; }
    const incomingFeatured = d.featuredGuestUid || null;
    if (incomingFeatured !== _featuredGuestUid) { _featuredGuestUid = incomingFeatured; changed = true; }
    if (changed) _applyGuestLayout();
  });
}

function _startViewerGuestGrid() {
  if (!_roomId) return;
  const guestsRef = ref(_liveDB, `liveGuests/${_roomId}`);

  _viewerGuestUnsub = onValue(guestsRef, snap => {
    const grid = D.guestGrid;
    if (!grid) return;

    // Build current set of UIDs from RTDB snapshot
    const incoming = {};
    if (snap.exists()) {
      snap.forEach(child => {
        const g = child.val();
        if (g && g.uid) incoming[child.key] = g;
      });
    }

    // ── Remove cards for guests who left — animate out then remove ──
    grid.querySelectorAll('.vgc-cell').forEach(card => {
      if (!incoming[card.dataset.guestKey] && !card.classList.contains('removing')) {
        // Animated exit in ≤220ms — never leaves empty ghost boxes
        card.classList.add('removing');
        setTimeout(() => {
          card.remove();
          _applyGuestLayout(); // re-layout after DOM node is fully gone
        }, 220);
      }
    });

    // ── Add or update cards for current guests ──
    const orderedKeys = Object.keys(incoming).sort((a, b) => {
      // _host_ always first, then by joinedAt
      if (a === '_host_') return -1;
      if (b === '_host_') return  1;
      return (incoming[a].joinedAt || 0) - (incoming[b].joinedAt || 0);
    });

    orderedKeys.forEach(key => {
      const g = incoming[key];
      let card = grid.querySelector(`.vgc-cell[data-guest-key="${key}"]`);

      if (!card) {
        // ── Create new card ──
        card = document.createElement('div');
        card.className = 'guest-cell vgc-cell' + (g.isHost ? ' host-cell' : '');
        card.dataset.guestKey = key;
        card.dataset.uid      = g.uid;

        // Avatar circle
        const avatarWrap = document.createElement('div');
        avatarWrap.className = 'vgc-avatar';
        if (g.avatar) {
          avatarWrap.style.backgroundImage = `url('${_esc(g.avatar)}')`;
        } else {
          avatarWrap.textContent = (g.name || '?')[0].toUpperCase();
        }
        card.appendChild(avatarWrap);

        // Camera-off overlay
        const camOffEl = document.createElement('div');
        camOffEl.className = 'vgc-cam-off';
        camOffEl.innerHTML = '<span>📷</span><span>Camera off</span>';
        card.appendChild(camOffEl);

        // Name label
        const nameEl = document.createElement('div');
        nameEl.className = 'guest-cell-name vgc-name';
        nameEl.textContent = g.isHost ? (g.name + ' (Host)') : (g.name || 'Guest');
        card.appendChild(nameEl);

        // Status icons bar
        const statusBar = document.createElement('div');
        statusBar.className = 'vgc-status';
        statusBar.innerHTML = `
          <span class="vgc-icon-cam">${g.camOn !== false ? '📷' : '🚫'}</span>
          <span class="vgc-icon-mic">${g.micOn !== false ? '🎤' : '🔇'}</span>
          ${g.isHost ? '<span class="vgc-host-badge">HOST</span>' : ''}
        `;
        card.appendChild(statusBar);

        // Insert: host always first
        if (g.isHost) {
          grid.insertBefore(card, grid.firstChild);
          // ── Attach host video stream to the host cell so it never disappears ──
          // For viewers, the host video arrives via WebRTC on #liveVideo.
          // Re-use that stream in the host cell so the grid always shows the host feed.
          _attachHostVideoToCell(card);
        } else {
          grid.appendChild(card);
        }

        // If this is the current viewer's own cell and they have a live guest stream,
        // attach the stream so they see their own live video (not just the avatar).
        if (_guestStream && g.uid === _user?.uid) {
          _attachGuestSelfStream(_guestStream);
        }
      } else {
        // ── Update existing card ──
        const camIcon = card.querySelector('.vgc-icon-cam');
        const micIcon = card.querySelector('.vgc-icon-mic');
        const camOff  = card.querySelector('.vgc-cam-off');
        if (camIcon) camIcon.textContent = g.camOn !== false ? '📷' : '🚫';
        if (micIcon) micIcon.textContent = g.micOn !== false ? '🎤' : '🔇';
        if (camOff)  camOff.classList.toggle('vgc-cam-off--visible', g.camOn === false);
        // Ensure host video is attached if not yet (e.g. stream arrived after card was built)
        if (g.isHost && !card.querySelector('video')) {
          _attachHostVideoToCell(card);
        }
      }
    });

    // ── Show/hide grid based on whether any guests are present ──
    const guestCount = orderedKeys.filter(k => !incoming[k].isHost).length;
    grid.dataset.count = guestCount.toString();
    if (guestCount > 0) {
      grid.classList.add('has-guests');
    } else {
      grid.classList.remove('has-guests');
    }
    _applyGuestLayout();
  });
}

/* ── Attach the host's live video stream into a viewer-side host cell ──
   The host stream arrives via WebRTC on #liveVideo. We create a <video>
   element in the host cell that reads from the same MediaStream so the
   host camera is always visible, even when the guest grid is shown.

   ── BLACK-SCREEN FIX ──
   The host cell video MUST start muted so autoplay is allowed by every
   browser (Chrome / Safari / Firefox block unmuted autoplay without a
   user gesture, which left the host cell stuck on a black screen). The
   avatar + "Camera is loading…" placeholder stays visible until the
   first frame is actually painted, so the cell never goes black while
   the stream is still connecting. Audio is un-muted on the first user
   tap (same gesture that unmutes the main video). */
function _attachHostVideoToCell(cell) {
  const _tryAttach = (attempts) => {
    const liveVid = D.liveVideo;
    if (!liveVid) return;
    const stream = liveVid.srcObject;
    if (!stream) {
      // Host stream not yet arrived — retry up to 30 times (3 seconds)
      if (attempts > 0) setTimeout(() => _tryAttach(attempts - 1), 100);
      return;
    }
    // Don't add a second video if one already exists
    if (cell.querySelector('video')) return;

    const vid = document.createElement('video');
    vid.autoplay    = true;
    vid.muted       = true;    // MUST start muted for autoplay to work
    vid.playsInline = true;
    vid.srcObject   = stream;
    // Insert before the name label so it sits behind the overlay elements
    const nameEl = cell.querySelector('.vgc-name, .guest-cell-name');
    cell.insertBefore(vid, nameEl || null);

    // Keep the avatar visible until the first frame actually paints, so
    // the cell never shows a black gap while the stream is still loading.
    const _hideAvatar = () => {
      const avatar = cell.querySelector('.vgc-avatar');
      if (avatar) avatar.style.display = 'none';
      const camOff = cell.querySelector('.vgc-cam-off');
      if (camOff) camOff.classList.remove('vgc-cam-off--visible');
    };

    // First-frame detection — hide the avatar ONLY when a frame is painted.
    let _frameShown = false;
    const _onFrame = () => {
      if (_frameShown) return;
      if (vid.readyState >= 2 && !vid.paused && vid.currentTime > 0) {
        _frameShown = true;
        _hideAvatar();
      }
    };
    if ('requestVideoFrameCallback' in vid) {
      vid.requestVideoFrameCallback(() => { _onFrame(); });
    }
    vid.addEventListener('loadeddata', _onFrame, { once: true });
    vid.addEventListener('playing',   () => { _frameShown = true; _hideAvatar(); }, { once: true });
    // Polling fallback for browsers that don't fire the events reliably.
    let _poll = 0;
    const _pollInt = setInterval(() => {
      if (_frameShown) { clearInterval(_pollInt); return; }
      _onFrame();
      if (++_poll > 30) {  // 30 × 200ms = 6s safety
        _frameShown = true; _hideAvatar(); clearInterval(_pollInt);
      }
    }, 200);

    // Kick off playback with a retry loop (mobile play() can be deferred).
    const _kick = (n) => {
      const p = vid.play();
      if (p && typeof p.then === 'function') {
        p.catch(() => { if (n > 0) setTimeout(() => _kick(n - 1), 300); });
      }
    };
    _kick(3);

    // Un-mute the host cell on the first user gesture (tap anywhere on
    // the stage), mirroring the main video's unmute flow.
    const _unmuteHostCell = () => {
      vid.muted = false;
      if (D.stage) D.stage.removeEventListener('click', _unmuteHostCell);
    };
    if (D.stage) D.stage.addEventListener('click', _unmuteHostCell, { once: true });

    // ── Viewer-side host cell health monitor ──
    // If the viewer's main WebRTC stream is replaced (e.g. after a reconnect),
    // D.liveVideo.srcObject will point to a new MediaStream.  Re-sync the
    // host cell video every 6 s so it never goes black after reconnect.
    // Also kicks play() if the element was paused by the browser (iOS bg tab).
    let _hcSyncLastTime = -1;
    let _hcSyncFrozenTicks = 0;
    const _hostCellSync = setInterval(() => {
      if (!cell.isConnected) { clearInterval(_hostCellSync); return; }
      const lv = D.liveVideo;
      if (!lv) return;
      const newStream = lv.srcObject;
      // Re-sync if the underlying stream was replaced (e.g. viewer reconnect)
      if (newStream && vid.srcObject !== newStream) {
        vid.srcObject = newStream;
        vid.play().catch(() => {});
        _hcSyncLastTime = -1; _hcSyncFrozenTicks = 0;
        return;
      }
      if (vid.paused && vid.srcObject) {
        vid.play().catch(() => {});
        _hcSyncLastTime = -1;
        return;
      }
      // Detect frozen currentTime on the host cell clone video
      if (vid.srcObject && vid.currentTime === _hcSyncLastTime && vid.currentTime > 0) {
        if (++_hcSyncFrozenTicks >= 2) {
          _hcSyncFrozenTicks = 0;
          // Re-clone from liveVideo srcObject to unblock the decoder
          const s = lv.srcObject;
          if (s) { vid.srcObject = null; vid.srcObject = s; vid.play().catch(() => {}); }
        }
      } else {
        _hcSyncFrozenTicks = 0;
        _hcSyncLastTime = vid.currentTime;
      }
    }, 4000);
  };
  _tryAttach(30);
}

/* ═══════════════════════════════════════════════════════════════
   GUEST BOX SYSTEM
   ─────────────────────────────────────────────────────────────
   RTDB paths used:
     guestRequests/{roomId}/{viewerUid}  → { uid, name, avatar, status:'pending'|'accepted'|'declined' }
     guestSignaling/{roomId}/{viewerUid} → { offer, answer, guestCandidates:{}, hostCandidates:{} }

   Flow:
     Viewer:  taps "Request a Box"
              → writes guestRequests/{roomId}/{uid}  status:'pending'
              → watches status node for 'accepted' / 'declined'

     Host:    listens to guestRequests/{roomId}
              → sees pending card → Accept / Decline
              Accept → writes status:'accepted'  + initiates WebRTC offer
              Decline → removes request node

     WebRTC:  host is offerer, guest is answerer (like creator/viewer main flow)
   ═══════════════════════════════════════════════════════════════ */

/* ── VIEWER: Request a Box ── */
// Expose for co-host accept auto-request (cohost.js calls window._viewerRequestBox())
window._viewerRequestBox = async function() { return _viewerRequestBox(); };

// Flag: true while the viewer is actively in a guest box (prevents double-request)
let _guestBoxActive = false;

async function _viewerRequestBox() {
  console.log('[BoxRequest] Request button clicked');

  // ── Guard: user must be logged in ──
  if (!_user) {
    console.warn('[BoxRequest] User not authenticated');
    toast('❌ Please sign in to request a box.');
    return;
  }

  // ── Guard: anonymous users are blocked by Firestore rules ──
  if (_user.isAnonymous) {
    toast('❌ Sign in with an account to request a box.');
    return;
  }

  // ── Guard: user data must be loaded ──
  if (!_userData) {
    toast('Loading your profile… Please try again.');
    return;
  }

  // ── Guard: must have a valid room ──
  if (!_roomId) {
    console.warn('[BoxRequest] Missing liveId (roomId is null)');
    toast('❌ No live stream found. Try refreshing.');
    return;
  }

  const btn = D.btnRequestBox;

  // ── Guard: already actively in a guest box ──
  // Use explicit flag rather than btn.display so re-invites work correctly
  if (_guestBoxActive) {
    console.log('[BoxRequest] Viewer already in a guest box');
    return;
  }

  // ── Guard: already has a pending request ──
  if (btn && btn.classList.contains('pending')) {
    console.log('[BoxRequest] Viewer already has a pending request');
    toast('Your request is already pending…');
    return;
  }

  // ── Resolve hostId from RTDB room ──
  let hostId = null;
  try {
    const roomSnap = await get(ref(_liveDB, `liveRooms/${_roomId}`));
    if (roomSnap.exists()) {
      hostId = roomSnap.val().hostId || null;
    }
  } catch (e) {
    console.error('[BoxRequest] Could not read liveRoom to get hostId:', e);
    toast('❌ Firebase connection error. Please try again.');
    return;
  }

  if (!hostId) {
    console.warn('[BoxRequest] Missing hostId — cannot send request');
    toast('❌ Could not find stream host. Try refreshing.');
    return;
  }

  console.log('[BoxRequest] Creating request — liveId:', _roomId, 'hostId:', hostId, 'viewerId:', _user.uid);

  const viewerName   = _userData.displayName || _user.email?.split('@')[0] || 'Guest';
  const viewerAvatar = _userData.avatar || _userData.profilePicture || '';
  const requestId    = `${_roomId}_${_user.uid}`;

  // BUG-2 FIX: delete any stale doc from a previous session BEFORE writing the new one.
  // This ensures the new doc gets a fresh serverTimestamp() so the stale-doc guard in
  // the onSnapshot listener won't reject it, and the host's 'modified' listener fires.
  try { await deleteDoc(doc(_db, 'boxRequests', requestId)); } catch(_) {}

  // ── Write to Firestore boxRequests ──
  try {
    await setDoc(doc(_db, 'boxRequests', requestId), {
      liveId:             _roomId,
      hostId,
      viewerId:           _user.uid,
      viewerName,
      viewerProfileImage: viewerAvatar,
      status:             'pending',
      createdAt:          serverTimestamp(),
    });
    console.log('[BoxRequest] Firestore write successful — requestId:', requestId);
  } catch (e) {
    console.error('[BoxRequest] Firestore write failed:', e.code, e.message);
    if (e.code === 'permission-denied') {
      // Try refreshing the token — stale ID tokens are the most common cause
      if (_auth.currentUser) {
        try { await getIdToken(_auth.currentUser, true); } catch(_) {}
      }
      toast('❌ Session error — please try again.');
    } else {
      toast('❌ Could not send request. Please try again.');
    }
    return;
  }

  // ── Write to RTDB guestRequests (for real-time WebRTC signaling flow) ──
  const rtdbReqRef = ref(_liveDB, `guestRequests/${_roomId}/${_user.uid}`);
  try {
    await set(rtdbReqRef, {
      uid:       _user.uid,
      name:      viewerName,
      avatar:    viewerAvatar,
      requestId,
      status:    'pending',
      ts:        Date.now(),
    });
    console.log('[BoxRequest] RTDB guestRequest written');
  } catch (e) {
    console.error('[BoxRequest] RTDB write failed:', e.code, e.message);
    // Non-fatal — Firestore is the source of truth for the host notification
  }

  // ── Update button to show pending state ──
  if (btn) {
    btn.classList.add('pending');
  }
  if (D.btnRequestBoxLabel) D.btnRequestBoxLabel.textContent = 'Waiting…';
  toast('📺 Request sent to host!');

  // ── Watch Firestore boxRequest status for host response ──
  if (_guestStatusUnsub) { try { _guestStatusUnsub(); } catch(_){} _guestStatusUnsub = null; }

  const reqDocRef = doc(_db, 'boxRequests', requestId);
  _guestStatusUnsub = onSnapshot(reqDocRef, async snap => {
    // BUG-2 FIX: ignore docs that don't exist or are in a terminal state we already handled.
    // A stale doc from a previous session (status:'accepted'|'declined') must not auto-trigger
    // _guestJoinAsViewer again when this is a brand-new request attempt.
    if (!snap.exists()) return;
    const data   = snap.data();
    const status = data.status;
    // Ignore stale doc: only react if the doc was created in THIS request session
    // (createdAt within the last 60 s). Older docs are from a previous session.
    if (data.createdAt) {
      const createdMs = data.createdAt.toMillis ? data.createdAt.toMillis() : data.createdAt;
      if (Date.now() - createdMs > 60000) return;
    }
    console.log('[BoxRequest] Status update received:', status);

    if (status === 'accepted') {
      if (btn) {
        btn.classList.remove('pending');
        btn.style.display = 'none';
      }
      _guestBoxActive = true;  // set flag before joining so double-taps are blocked
      toast('✅ Accepted! Joining as guest…');
      _guestStatusUnsub && _guestStatusUnsub();
      _guestStatusUnsub = null;
      await _guestJoinAsViewer();

    } else if (status === 'declined') {
      if (btn) {
        btn.classList.remove('pending');
      }
      if (D.btnRequestBoxLabel) D.btnRequestBoxLabel.textContent = 'Request a Box';
      toast('Request declined.');
      _guestStatusUnsub && _guestStatusUnsub();
      _guestStatusUnsub = null;
      // Clean up Firestore doc so it doesn't block a future request
      try { await deleteDoc(reqDocRef); } catch(_) {}
    }
  }, err => {
    console.error('[BoxRequest] Snapshot listener error:', err.code, err.message);
    if (err.code === 'permission-denied') {
      if (_auth.currentUser) {
        getIdToken(_auth.currentUser, true).catch(() => {});
      }
      toast('❌ Session error — please try again.');
    }
    // On listener error reset pending state so the user can try again
    if (btn) btn.classList.remove('pending');
    if (D.btnRequestBoxLabel) D.btnRequestBoxLabel.textContent = 'Request a Box';
  });
}

/* ── VIEWER: Guest cam toggle ── */
function _toggleGuestCam() {
  if (!_guestStream) return;
  _guestCamOn = !_guestCamOn;
  _guestStream.getVideoTracks().forEach(t => { t.enabled = _guestCamOn; });
  if (D.btnGuestCam) D.btnGuestCam.classList.toggle('off', !_guestCamOn);
  if (D.btnGuestCamLabel) D.btnGuestCamLabel.textContent = _guestCamOn ? 'Cam' : 'Cam Off';
  const icon = D.btnGuestCam && D.btnGuestCam.querySelector('span:first-child');
  if (icon) icon.textContent = _guestCamOn ? '📷' : '🚫';
  // Broadcast cam state so host and other viewers see the change
  if (_user && _roomId) try { update(ref(_liveDB, `liveGuests/${_roomId}/${_user.uid}`), { camOn: _guestCamOn }); } catch(_) {}
}

/* ── VIEWER: Guest mic toggle ── */
function _toggleGuestMic() {
  if (!_guestStream) return;
  _guestMicOn = !_guestMicOn;
  _guestStream.getAudioTracks().forEach(t => { t.enabled = _guestMicOn; });
  if (D.btnGuestMic) D.btnGuestMic.classList.toggle('off', !_guestMicOn);
  if (D.btnGuestMicLabel) D.btnGuestMicLabel.textContent = _guestMicOn ? 'Mic' : 'Mic Off';
  const icon = D.btnGuestMic && D.btnGuestMic.querySelector('span:first-child');
  if (icon) icon.textContent = _guestMicOn ? '🎤' : '🔇';
  toast(_guestMicOn ? 'Mic on' : 'Mic muted');
  // Broadcast mic state so host and other viewers see the change
  if (_user && _roomId) try { update(ref(_liveDB, `liveGuests/${_roomId}/${_user.uid}`), { micOn: _guestMicOn }); } catch(_) {}
}

/* ── VIEWER: Leave the guest box voluntarily ── */
async function _guestLeaveBox() {
  // Guard: only a viewer who is currently in a box can leave
  if (!_guestStream && !_guestPc) return;

  const confirmed = await _snxConfirm({
    icon:     '🚪',
    title:    'Leave guest box?',
    sub:      'You will return to watching the live stream.',
    okLabel:  'Leave Box',
    okClass:  '',
  });
  if (!confirmed) return;

  _guestDoLeave();
}

// Module-level refs for teardown of the remove-signal listener and dc timer.
// These must survive _guestJoinAsViewer calls so a new join properly tears down the old ones.
let _guestRemovedRef   = null;   // RTDB ref for removedByHost listener
let _guestRemovedUnsub = null;   // onValue unsubscribe for removedByHost
let _guestDcTimer      = null;   // connection-state disconnect/failed timer

/* ── Internal: perform the guest leave cleanup (called from Leave Box or removedByHost signal) ── */
function _guestDoLeave() {
  // BUG-9 FIX: cancel any pending disconnect/failed timer so it can't fire _guestDoLeave twice
  if (_guestDcTimer) { clearTimeout(_guestDcTimer); _guestDcTimer = null; }

  // BUG-7 FIX: un-subscribe removedByHost listener so it can't trigger after leave
  if (_guestRemovedUnsub) {
    try { _guestRemovedUnsub(); } catch(_) {}
    _guestRemovedUnsub = null;
  }
  if (_guestRemovedRef) {
    try { off(_guestRemovedRef); } catch(_) {}
    _guestRemovedRef = null;
  }

  // Stop heartbeat immediately — no more presence keep-alive
  if (_guestHeartbeatInterval) {
    clearInterval(_guestHeartbeatInterval);
    _guestHeartbeatInterval = null;
  }

  // Tear down the host-ICE signaling listener first
  if (_guestSigUnsub) {
    try { _guestSigUnsub(); } catch(_) {}
    _guestSigUnsub = null;
  }

  // Close peer connection — triggers onconnectionstatechange, but _guestPc is
  // nulled BEFORE close() so the state handler sees null and skips cleanup.
  const pcToClose = _guestPc;
  _guestPc = null;
  if (pcToClose) {
    try { pcToClose.close(); } catch(_) {}
  }

  // Reset active-box flag so the viewer can request again
  _guestBoxActive = false;

  // Remove own presence from RTDB so grid updates for everyone instantly.
  // Also cancel the onDisconnect hook so RTDB doesn't attempt a redundant delete.
  if (_user && _roomId) {
    const presRef = ref(_liveDB, `liveGuests/${_roomId}/${_user.uid}`);
    try { onDisconnect(presRef).cancel(); } catch(_) {}
    try { remove(presRef); } catch(_) {}
    // Clean up signaling data
    try { remove(ref(_liveDB, `guestSignaling/${_roomId}/${_user.uid}`)); } catch(_) {}
    try { remove(ref(_liveDB, `guestRequests/${_roomId}/${_user.uid}`)); } catch(_) {}
    // Clean up Firestore boxRequest
    const requestId = `${_roomId}_${_user.uid}`;
    try { deleteDoc(doc(_db, 'boxRequests', requestId)); } catch(_) {}
  }

  // Stop local guest media tracks
  if (_guestStream) {
    try { _guestStream.getTracks().forEach(t => t.stop()); } catch(_) {}
    _guestStream = null;
  }

  // Hide guest controls, restore Request a Box button
  if (D.btnGuestCam)  D.btnGuestCam.style.display  = 'none';
  if (D.btnGuestMic)  D.btnGuestMic.style.display  = 'none';
  if (D.btnLeaveBox)  D.btnLeaveBox.style.display   = 'none';
  if (D.btnRequestBox) {
    D.btnRequestBox.style.display = '';
    D.btnRequestBox.classList.remove('pending');
  }
  if (D.btnRequestBoxLabel) D.btnRequestBoxLabel.textContent = 'Request a Box';

  toast('You left the guest box.');
}

/* ── VIEWER: Join as a guest box (answerer) ── */
async function _guestJoinAsViewer() {
  if (!_user || !_roomId) return;

  // BUG-3/BUG-8 FIX: tear down any existing guest session before starting a new one.
  // This prevents stale peer connections and duplicate listeners when a guest rejoins
  // after being removed then invited again.
  if (_guestPc || _guestStream) {
    console.log('[GuestBox] Tearing down previous session before rejoining');
    if (_guestSigUnsub)    { try { _guestSigUnsub(); }    catch(_){} _guestSigUnsub = null; }
    if (_guestRemovedUnsub){ try { _guestRemovedUnsub(); } catch(_){} _guestRemovedUnsub = null; }
    if (_guestRemovedRef)  { try { off(_guestRemovedRef); } catch(_){} _guestRemovedRef = null; }
    if (_guestDcTimer)     { clearTimeout(_guestDcTimer); _guestDcTimer = null; }
    if (_guestHeartbeatInterval) { clearInterval(_guestHeartbeatInterval); _guestHeartbeatInterval = null; }
    const oldPc = _guestPc; _guestPc = null;
    if (oldPc) { try { oldPc.close(); } catch(_){} }
    if (_guestStream) { try { _guestStream.getTracks().forEach(t=>t.stop()); } catch(_){} _guestStream = null; }
  }

  let guestStream;
  try {
    guestStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: true,
    });
  } catch (e) {
    console.error('[GuestBox] getUserMedia failed:', e.name, e.message);
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      toast('❌ Camera & mic access denied. Allow in browser settings.');
    } else if (e.name === 'NotFoundError') {
      toast('❌ No camera/mic found on this device.');
    } else {
      toast('❌ Could not access camera. Please try again.');
    }
    _guestBoxActive = false;
    return;
  }

  // Store stream so cam/mic toggles work
  _guestStream = guestStream;
  _guestCamOn  = true;
  _guestMicOn  = true;

  const sigRef = ref(_liveDB, `guestSignaling/${_roomId}/${_user.uid}`);
  // BUG-5 FIX: increase from 5 s → 12 s; slow connections need more time for the host
  // to write the initial offer after accepting.
  const MAX_WAIT = 12000;

  // BUG-4 FIX: off(ref, callback) is NOT valid for onValue listeners — only
  // off(ref) works. We use the returned unsubscribe function from onValue instead.
  const _waitForOffer = () => new Promise((resolve, reject) => {
    let _done = false;
    const _unsub = onValue(sigRef, snap => {
      if (!snap.exists() || !snap.val().offer) return;
      if (_done) return;
      _done = true;
      _unsub();
      resolve(snap.val());
    });
    setTimeout(() => {
      if (_done) return;
      _done = true;
      _unsub();
      reject(new Error('offer timeout'));
    }, MAX_WAIT);
  });

  let sigData;
  try {
    sigData = await _waitForOffer();
  } catch (e) {
    // BUG-15 FIX: show a more helpful message and reset state so the user can retry
    console.warn('[GuestBox] Offer wait timed out — host may be slow or offline');
    toast('⏱ Host is slow to respond. Tap "Request a Box" to try again.');
    guestStream.getTracks().forEach(t => t.stop());
    _guestStream = null;
    _guestBoxActive = false;
    if (D.btnRequestBox) { D.btnRequestBox.style.display = ''; D.btnRequestBox.classList.remove('pending'); }
    if (D.btnRequestBoxLabel) D.btnRequestBoxLabel.textContent = 'Request a Box';
    return;
  }

  const guestPc = new RTCPeerConnection(_ICE_SERVERS);
  _attachIceWatchdog(guestPc, 'guestbox→host');

  // Add local tracks
  guestStream.getTracks().forEach(t => guestPc.addTrack(t, guestStream));

  const _pendingCands = [];
  let _answerWritten = false;

  guestPc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    if (!_answerWritten) { _pendingCands.push(e.candidate.toJSON()); return; }
    try { await push(ref(_liveDB, `guestSignaling/${_roomId}/${_user.uid}/guestCandidates`), e.candidate.toJSON()); } catch(_) {}
  };

  try {
    await guestPc.setRemoteDescription(new RTCSessionDescription(sigData.offer));
  } catch(e) {
    toast('❌ Connection error. Please request a box again.');
    guestPc.close(); guestStream.getTracks().forEach(t=>t.stop());
    _guestStream = null; _guestBoxActive = false;
    if (D.btnRequestBox) { D.btnRequestBox.style.display = ''; D.btnRequestBox.classList.remove('pending'); }
    if (D.btnRequestBoxLabel) D.btnRequestBoxLabel.textContent = 'Request a Box';
    return;
  }

  const answer = await guestPc.createAnswer();
  await guestPc.setLocalDescription(answer);

  try {
    await update(sigRef, { answer: { type: answer.type, sdp: answer.sdp } });
    _answerWritten = true;
  } catch(e) {
    toast('❌ Connection error. Please request a box again.');
    guestPc.close(); guestStream.getTracks().forEach(t=>t.stop());
    _guestStream = null; _guestBoxActive = false;
    if (D.btnRequestBox) { D.btnRequestBox.style.display = ''; D.btnRequestBox.classList.remove('pending'); }
    if (D.btnRequestBoxLabel) D.btnRequestBoxLabel.textContent = 'Request a Box';
    return;
  }

  // Flush pending candidates
  for (const c of _pendingCands) {
    try { await push(ref(_liveDB, `guestSignaling/${_roomId}/${_user.uid}/guestCandidates`), c); } catch(_) {}
  }
  _pendingCands.length = 0;

  // Apply existing host candidates
  const appliedHostCands = new Set();
  const hc = sigData.hostCandidates || {};
  for (const [k, c] of Object.entries(hc)) {
    appliedHostCands.add(k);
    try { await guestPc.addIceCandidate(new RTCIceCandidate(c)); } catch(_) {}
  }

  // BUG-14 FIX: if a previous _guestSigUnsub exists, call the unsubscribe function
  // directly — NOT off(sigRef) which would detach ALL onValue listeners on that ref.
  if (_guestSigUnsub) { try { _guestSigUnsub(); } catch(_) {} _guestSigUnsub = null; }

  // Listen for host candidates AND ICE-restart offers from the host.
  // When the host calls restartIce() and writes a new offer to RTDB, the
  // guest must respond with a fresh answer to complete the ICE handshake.
  let _lastAppliedOfferSdp = sigData.offer?.sdp || null;
  let _iceAnswerInFlight = false;
  _guestSigUnsub = onValue(sigRef, async snap => {
    if (!snap.exists()) return;
    const d = snap.val();

    // ── Handle ICE-restart offers from the host ──
    if (d.offer && d.offer.sdp !== _lastAppliedOfferSdp && !_iceAnswerInFlight) {
      _iceAnswerInFlight = true;
      try {
        await guestPc.setRemoteDescription(new RTCSessionDescription(d.offer));
        _lastAppliedOfferSdp = d.offer.sdp;
        appliedHostCands.clear(); // fresh candidate set for new ICE session
        const restartAnswer = await guestPc.createAnswer();
        await guestPc.setLocalDescription(restartAnswer);
        await update(sigRef, { answer: { type: restartAnswer.type, sdp: restartAnswer.sdp } });
        console.log('[GuestBox] ICE-restart answer sent to host');
      } catch (e) {
        console.warn('[GuestBox] ICE-restart answer failed:', e.message);
      } finally {
        _iceAnswerInFlight = false;
      }
    }

    // ── Apply incoming host ICE candidates ──
    if (d.hostCandidates) {
      for (const [k, c] of Object.entries(d.hostCandidates)) {
        if (appliedHostCands.has(k)) continue;
        appliedHostCands.add(k);
        try { await guestPc.addIceCandidate(new RTCIceCandidate(c)); } catch(_) {}
      }
    }
  });

  // Store peer connection so disconnect/cleanup code can reach it
  _guestPc = guestPc;

  // ── Publish own presence to RTDB so everyone (incl. self) sees this box ──
  const guestName   = _userData?.displayName || _user.email?.split('@')[0] || 'Guest';
  const guestAvatar = _userData?.avatar || _userData?.profilePicture || '';
  const guestPresenceRef = ref(_liveDB, `liveGuests/${_roomId}/${_user.uid}`);
  try {
    await set(guestPresenceRef, {
      uid:      _user.uid,
      name:     guestName,
      avatar:   guestAvatar,
      camOn:    true,
      micOn:    true,
      joinedAt: Date.now(),
      hb:       Date.now(),   // initial heartbeat timestamp
    });
  } catch(_) {}

  // ── onDisconnect: RTDB automatically removes this guest's presence
  //    if the client disconnects (tab close, network loss, app kill).
  //    Fires within ~2 seconds of connection drop per Firebase RTDB guarantee.
  try { onDisconnect(guestPresenceRef).remove(); } catch(_) {}

  // ── Heartbeat: keep hb timestamp fresh so host watchdog detects live guests ──
  if (_guestHeartbeatInterval) clearInterval(_guestHeartbeatInterval);
  _guestHeartbeatInterval = setInterval(() => {
    if (!_user || !_roomId || !_guestStream) { clearInterval(_guestHeartbeatInterval); return; }
    try { update(guestPresenceRef, { hb: Date.now() }); } catch(_) {}
  }, _HEARTBEAT_INTERVAL_MS);

  // ── Subscribe to full guest grid (viewer sees all boxes including own) ──
  // If already subscribed (joined as viewer before requesting a box), it
  // is already running — the new RTDB entry above will trigger a re-render.
  // If not yet subscribed, start now.
  if (!_viewerGuestUnsub) {
    _startViewerGuestGrid();
  }

  // ── Subscribe to layout sync if not already running ──
  if (!_layoutSyncUnsub) {
    _startLayoutSync();
  }

  // ── Attach live stream to own cell once RTDB grid renders it ──
  // Poll for the cell (RTDB listener may not have fired yet)
  _attachGuestSelfStream(guestStream);

  // Show cam/mic/leave toggle buttons now that the viewer is in a box
  if (D.btnGuestCam) D.btnGuestCam.style.display = 'flex';
  if (D.btnGuestMic) D.btnGuestMic.style.display = 'flex';
  if (D.btnLeaveBox) D.btnLeaveBox.style.display  = 'flex';

  // BUG-7 FIX: store listener refs at module level so _guestDoLeave can tear them down.
  // ── Listen for host-remove signal on own signaling node ──
  // Host sets removedByHost:true when it removes this guest.
  // Guest client responds by cleaning up immediately.
  _guestRemovedRef   = ref(_liveDB, `guestSignaling/${_roomId}/${_user.uid}/removedByHost`);
  _guestRemovedUnsub = onValue(_guestRemovedRef, snap => {
    if (!snap.exists() || !snap.val()) return;
    // Unsubscribe immediately before any async work to prevent double-fire
    if (_guestRemovedUnsub) { try { _guestRemovedUnsub(); } catch(_){} _guestRemovedUnsub = null; }
    try { off(_guestRemovedRef); } catch(_) {} _guestRemovedRef = null;
    toast('The host removed you from the guest box.');
    _guestDoLeave();
  });

  // BUG-8/BUG-9 FIX: use module-level _guestDcTimer and check _guestPc === guestPc
  // so that a stale onconnectionstatechange from a previous session can't fire
  // _guestDoLeave for the new session.
  // Handle peer disconnect:
  //  - `disconnected` is transient — _attachIceWatchdog fires restartIce()
  //    after 3 s and we write an ICE-restart offer.  Give 15 s for the
  //    renegotiation + new ICE path to complete before giving up.
  //  - `failed` → the ICE watchdog already attempted restartIce(). Give it
  //    an additional 6 s (for the renegotiation round-trip) before calling
  //    _guestDoLeave, so the video element is never torn down prematurely.
  //  - `closed` → the host explicitly closed us; clean up immediately.
  guestPc.onconnectionstatechange = () => {
    // Guard: ignore events from a stale pc that was already replaced
    if (_guestPc !== guestPc) return;
    const st = guestPc.connectionState;
    if (st === 'disconnected') {
      if (!_guestDcTimer) {
        _guestDcTimer = setTimeout(() => {
          _guestDcTimer = null;
          if (_guestPc !== guestPc) return; // replaced by a newer session
          if (guestPc.connectionState !== 'connected' && (_guestStream || _guestPc)) {
            _guestDoLeave();
          }
        }, 15000); // 15 s: 3 s ICE watchdog + renegotiation round-trip
      }
    } else if (st === 'failed') {
      // Give the ICE-restart renegotiation a chance to recover.
      if (!_guestDcTimer) {
        _guestDcTimer = setTimeout(() => {
          _guestDcTimer = null;
          if (_guestPc !== guestPc) return;
          if (guestPc.connectionState !== 'connected' && (_guestStream || _guestPc)) {
            _guestDoLeave();
          }
        }, 6000); // 6 s grace for ICE restart renegotiation
      }
    } else if (st === 'closed') {
      if (_guestDcTimer) { clearTimeout(_guestDcTimer); _guestDcTimer = null; }
      // Only clean up if this is still the active peer connection
      if (_guestPc === guestPc && (_guestStream || _guestPc)) {
        _guestDoLeave();
      }
    } else if (st === 'connected') {
      if (_guestDcTimer) { clearTimeout(_guestDcTimer); _guestDcTimer = null; }
    }
  };
}

/* ── Attach the guest's own live stream to their cell in the RTDB-driven grid ──
   The RTDB onValue callback may render the cell asynchronously; retry until found.

   ── BLACK-SCREEN FIX ──
   Keep the avatar visible until the first frame actually paints, so the
   self-preview cell never shows a black gap while the stream is loading. */
function _attachGuestSelfStream(stream) {
  const uid = _user?.uid;
  if (!uid || !stream) return;

  const _tryAttach = (attempts) => {
    const grid = D.guestGrid;
    if (!grid) return;
    // Find own cell by uid (rendered by _startViewerGuestGrid)
    const cell = grid.querySelector(`.vgc-cell[data-uid="${uid}"]`);
    if (cell) {
      // Replace avatar with live video
      let vid = cell.querySelector('video');
      if (!vid) {
        vid = document.createElement('video');
        vid.autoplay = true;
        vid.muted    = true;   // mute self-preview
        vid.playsInline = true;
        // Insert before name label
        const nameEl = cell.querySelector('.vgc-name, .guest-cell-name');
        cell.insertBefore(vid, nameEl || null);
      }
      vid.srcObject = stream;

      // Keep the avatar visible until the first frame paints (no black gap).
      let _frameShown = false;
      const _hideAvatar = () => {
        if (_frameShown) return;
        if (vid.readyState >= 2 && !vid.paused && vid.currentTime > 0) {
          _frameShown = true;
          const camOff = cell.querySelector('.vgc-cam-off');
          if (camOff) camOff.classList.remove('vgc-cam-off--visible');
        }
      };
      if ('requestVideoFrameCallback' in vid) {
        vid.requestVideoFrameCallback(() => { _hideAvatar(); });
      }
      vid.addEventListener('loadeddata', _hideAvatar, { once: true });
      vid.addEventListener('playing',   () => { _frameShown = true; const camOff = cell.querySelector('.vgc-cam-off'); if (camOff) camOff.classList.remove('vgc-cam-off--visible'); }, { once: true });
      // Polling fallback (6s safety)
      let _poll = 0;
      const _pollInt = setInterval(() => {
        if (_frameShown) { clearInterval(_pollInt); return; }
        _hideAvatar();
        if (++_poll > 30) { _frameShown = true; const camOff = cell.querySelector('.vgc-cam-off'); if (camOff) camOff.classList.remove('vgc-cam-off--visible'); clearInterval(_pollInt); }
      }, 200);

      vid.play().catch(() => {});
      return; // done
    }
    // Cell not yet rendered — retry up to 20 times (2 seconds total)
    if (attempts > 0) {
      setTimeout(() => _tryAttach(attempts - 1), 100);
    }
  };

  _tryAttach(20);
}

/* ── HOST: Listen for incoming guest requests (Firestore + RTDB) ── */
function _hostListenForGuestRequests() {
  if (!_roomId || !_user) return;
  console.log('[BoxRequest] Host listening for guest requests on roomId:', _roomId);

  // Reset the seen-UID tracker when starting a new listen session
  _shownReqUids.clear();

  // Start the stale-guest watchdog — cleans up ghost boxes every 10 s
  _startHostGuestWatchdog();

  // ── Primary listener: Firestore boxRequests ──
  const fsReqQuery = query(
    collection(_db, 'boxRequests'),
    where('liveId',  '==', _roomId),
    where('hostId',  '==', _user.uid),
    where('status',  '==', 'pending')
  );

  const fsUnsub = onSnapshot(fsReqQuery, snap => {
    snap.docChanges().forEach(change => {
      // BUG-1 HOST FIX: also handle 'modified' — when a previously-removed guest
      // re-requests a box, setDoc overwrites the same requestId doc (status: 'pending'),
      // which fires 'modified' not 'added'.  We must show the card for both types.
      if (change.type === 'added' || change.type === 'modified') {
        const d = change.doc.data();
        if (d.status !== 'pending') return; // only show pending requests
        console.log('[BoxRequest] Request received by host from viewer:', d.viewerId, 'name:', d.viewerName);
        if (!_shownReqUids.has(d.viewerId)) {
          _shownReqUids.add(d.viewerId);
          _hostShowRequestCard({
            uid:        d.viewerId,
            name:       d.viewerName,
            avatar:     d.viewerProfileImage || '',
            requestId:  change.doc.id,
            status:     'pending',
          });
        }
      }
    });
  }, err => {
    console.error('[BoxRequest] Firestore boxRequests listener error:', err.code, err.message);
  });

  // ── Fallback: RTDB guestRequests (only fires on child_added, not all value changes) ──
  const rtdbReqsRef = ref(_liveDB, `guestRequests/${_roomId}`);
  // Use onChildAdded (via onValue snapshot forEach for new items only)
  // To avoid duplicates we check _shownReqUids which is shared with the Firestore path
  const rtdbUnsub = onValue(rtdbReqsRef, snap => {
    if (!snap.exists()) return;
    snap.forEach(child => {
      const req = child.val();
      if (req.status === 'pending' && !_shownReqUids.has(req.uid)) {
        _shownReqUids.add(req.uid);
        _hostShowRequestCard(req);
      }
    });
  });

  // Combine both unsubs into _guestReqUnsub
  _guestReqUnsub = () => {
    try { fsUnsub(); }   catch(_) {}
    try { off(rtdbReqsRef); } catch(_) {}
    _shownReqUids.clear();
  };
}

/* ── HOST: Show a request card ── */
function _hostShowRequestCard(req) {
  const queue = D.guestRequestQueue;
  if (!queue) return;

  // Prevent duplicate cards
  if (queue.querySelector(`[data-uid="${req.uid}"]`)) return;

  const card = document.createElement('div');
  card.className = 'guest-request-card';
  card.dataset.uid = req.uid;

  const avatarEl = document.createElement('div');
  avatarEl.className = 'guest-req-avatar';
  if (req.avatar) {
    avatarEl.style.backgroundImage = `url('${req.avatar}')`;
  } else {
    avatarEl.textContent = (req.name || '?')[0].toUpperCase();
  }

  const nameWrap = document.createElement('div');
  nameWrap.style.cssText = 'flex:1;min-width:0;';
  nameWrap.innerHTML = `
    <div class="guest-req-name">${_esc(req.name || 'Guest')}</div>
    <div class="guest-req-sub">wants to join your box</div>
  `;

  const actions = document.createElement('div');
  actions.className = 'guest-req-actions';

  const acceptBtn = document.createElement('button');
  acceptBtn.className = 'guest-req-accept';
  acceptBtn.textContent = 'Accept';
  acceptBtn.addEventListener('click', () => {
    card.remove();
    _hostAcceptGuest(req);  // req carries requestId
  });

  const declineBtn = document.createElement('button');
  declineBtn.className = 'guest-req-decline';
  declineBtn.textContent = 'Decline';
  declineBtn.addEventListener('click', () => {
    card.remove();
    _hostDeclineGuest(req.uid, req.requestId);
  });

  actions.appendChild(acceptBtn);
  actions.appendChild(declineBtn);
  card.appendChild(avatarEl);
  card.appendChild(nameWrap);
  card.appendChild(actions);
  queue.appendChild(card);

  // Auto-dismiss after 30 seconds
  setTimeout(() => {
    if (card.parentNode) {
      card.remove();
      _hostDeclineGuest(req.uid, req.requestId);
    }
  }, 30000);
}

/* ── HOST: Accept guest ── */
async function _hostAcceptGuest(req) {
  if (!_roomId || !_localStream) return;
  // Wrap entire accept flow in a top-level try/catch so a failure for one
  // guest (bad network, ICE error, race condition) cannot crash the entire
  // livestream or prevent other guests from joining.
  try {
    await _hostAcceptGuestImpl(req);
  } catch (e) {
    console.error('[BoxRequest] Guest accept failed (isolated):', e && e.message);
    toast('⚠️ Could not connect guest — please try again.');
  }
}
async function _hostAcceptGuestImpl(req) {
  if (!_roomId || !_localStream) return;

  const guestUid  = req.uid;
  const requestId = req.requestId || `${_roomId}_${guestUid}`;
  const sigRef    = ref(_liveDB, `guestSignaling/${_roomId}/${guestUid}`);

  // BUG-1/BUG-3 FIX: if this guest already has a peer entry (e.g. re-invited after remove),
  // cleanly tear it down before setting up a new one.  Without this, the old
  // _guestPeers[guestUid] check blocked the host from ever accepting the same guest twice.
  if (_guestPeers[guestUid]) {
    console.log('[BoxRequest] Guest was already in peers map — tearing down old connection before re-accept:', guestUid);
    _hostDoRemoveGuest(guestUid);
    // Brief yield so the remove animation starts before the new offer writes
    await new Promise(r => setTimeout(r, 50));
  }

  // ── Cap: respect _MAX_GUESTS limit ──
  if (Object.keys(_guestPeers).length >= _MAX_GUESTS) {
    toast(`⚠️ Guest box full — max ${_MAX_GUESTS} guests.`);
    _hostDeclineGuest(req.uid, requestId);
    return;
  }

  console.log('[BoxRequest] Host accepting guest:', guestUid, 'name:', req.name);

  // ── Update Firestore boxRequest status to "accepted" ──
  try {
    await updateDoc(doc(_db, 'boxRequests', requestId), { status: 'accepted' });
    console.log('[BoxRequest] Firestore boxRequest status → accepted');
  } catch (e) {
    console.error('[BoxRequest] Could not update Firestore boxRequest (accepted):', e.code, e.message);
  }

  // ── Update RTDB guestRequest status to "accepted" ──
  try { await update(ref(_liveDB, `guestRequests/${_roomId}/${guestUid}`), { status: 'accepted' }); } catch(_) {}

  // BUG-6 FIX: clear any stale signaling data from a previous session for this guest
  // before writing the new offer so the guest's waitForOffer sees only the fresh offer.
  try { await remove(sigRef); } catch(_) {}

  console.log('[BoxRequest] Guest added to box — starting WebRTC signaling for:', guestUid);

  // Create peer connection for this guest
  const guestPc = new RTCPeerConnection(_ICE_SERVERS);
  _attachIceWatchdog(guestPc, `host→guestbox:${guestUid}`);

  // BUG-10/11 FIX: store stream as soon as ontrack fires; if the cell was already
  // added (e.g. track fires twice or a second ontrack), update its srcObject in-place
  // rather than calling _hostAddGuestCell twice (which is blocked by duplicate guard
  // and would silently drop the stream).
  let _trackStream = null;
  guestPc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    // Update the stream ref on the peer entry if it already exists
    if (_guestPeers[guestUid]) {
      _guestPeers[guestUid].stream = stream;
      const cell = _guestPeers[guestUid].cell;
      if (cell) {
        const vid = cell.querySelector('video');
        if (vid && vid.srcObject !== stream) {
          vid.srcObject = stream;
          vid.play().catch(() => {});
        }
      }
    }
    _trackStream = stream;
    _hostAddGuestCell(guestUid, req.name || 'Guest', req.avatar || '', stream, guestPc);
  };

  const _pendingHostCands = [];
  let _offerWritten = false;

  let _iceRestartInFlight = false;

  guestPc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    if (!_offerWritten) { _pendingHostCands.push(e.candidate.toJSON()); return; }
    try { await push(ref(_liveDB, `guestSignaling/${_roomId}/${guestUid}/hostCandidates`), e.candidate.toJSON()); } catch(_) {}
  };

  /* ── ICE-restart renegotiation ───────────────────────────────────────
     When _attachIceWatchdog calls restartIce(), the browser fires
     onnegotiationneeded with a new offer.  We must write that offer to
     RTDB so the guest can respond with a new answer, completing the
     ICE restart.  Without this, restartIce() collects new candidates
     but the SDP handshake never finishes and the stream stays frozen. */
  guestPc.onnegotiationneeded = async () => {
    if (!_offerWritten) return; // initial offer path handles this separately
    if (_iceRestartInFlight) return;
    if (guestPc.signalingState !== 'stable') return;
    if (!_guestPeers[guestUid]) return; // peer was already removed
    _iceRestartInFlight = true;
    try {
      const restartOffer = await guestPc.createOffer({ iceRestart: true });
      await guestPc.setLocalDescription(restartOffer);
      // Write restart offer to RTDB — also reset guestCandidates/hostCandidates
      // so the guest flushes its old candidate set and applies the new ones.
      await set(sigRef, {
        offer:           { type: restartOffer.type, sdp: restartOffer.sdp },
        guestCandidates: {},
        hostCandidates:  {},
      });
      console.log(`[GuestBox] ICE-restart offer written for guest ${guestUid}`);
    } catch (e) {
      console.warn(`[GuestBox] ICE-restart renegotiation failed for ${guestUid}:`, e.message);
    } finally {
      _iceRestartInFlight = false;
    }
  };

  const offer = await guestPc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
  await guestPc.setLocalDescription(offer);

  try {
    await set(sigRef, { offer: { type: offer.type, sdp: offer.sdp }, guestCandidates: {}, hostCandidates: {} });
    _offerWritten = true;
  } catch(e) { toast('Could not connect guest.'); guestPc.close(); return; }

  // Flush pending host candidates
  for (const c of _pendingHostCands) {
    try { await push(ref(_liveDB, `guestSignaling/${_roomId}/${guestUid}/hostCandidates`), c); } catch(_) {}
  }
  _pendingHostCands.length = 0;

  // Watch for guest answer + ICE — store unsub so _hostDoRemoveGuest can clean up
  // Track the last answer SDP we already applied so re-fires don't cause errors.
  let _lastAppliedAnswerSdp = null;
  const appliedGuestCands = new Set();
  const _hostGuestSigUnsub = onValue(sigRef, async snap => {
    if (!snap.exists()) return;
    const d = snap.val();
    // Apply answer if we haven't yet OR if it changed (ICE-restart brings a new answer)
    if (d.answer && d.answer.sdp !== _lastAppliedAnswerSdp) {
      // Only set remote desc when the signaling state allows it
      if (guestPc.signalingState === 'have-local-offer') {
        try {
          await guestPc.setRemoteDescription(new RTCSessionDescription(d.answer));
          _lastAppliedAnswerSdp = d.answer.sdp;
          // Reset applied candidates so we process the new ICE candidate set
          appliedGuestCands.clear();
        } catch(_) {}
      }
    }
    if (guestPc.remoteDescription && d.guestCandidates) {
      for (const [k, c] of Object.entries(d.guestCandidates)) {
        if (appliedGuestCands.has(k)) continue;
        appliedGuestCands.add(k);
        try { await guestPc.addIceCandidate(new RTCIceCandidate(c)); } catch(_) {}
      }
    }
  });
  _hostSigUnsubs[guestUid] = _hostGuestSigUnsub;

  // Store peer
  _guestPeers[guestUid] = { pc: guestPc, name: req.name, avatar: req.avatar };

  // ── Publish guest presence to RTDB so viewers can see the new box ──
  try {
    await set(ref(_liveDB, `liveGuests/${_roomId}/${guestUid}`), {
      uid:       guestUid,
      name:      req.name  || 'Guest',
      avatar:    req.avatar || '',
      camOn:     true,
      micOn:     true,
      joinedAt:  Date.now(),
    });
  } catch(_) {}

  toast(`✅ ${req.name || 'Guest'} joined!`);
}

/* ── HOST: Decline guest ── */
async function _hostDeclineGuest(guestUid, requestId) {
  const reqId = requestId || `${_roomId}_${guestUid}`;
  console.log('[BoxRequest] Host declining guest:', guestUid);

  // ── Update Firestore boxRequest status to "declined" ──
  try {
    await updateDoc(doc(_db, 'boxRequests', reqId), { status: 'declined' });
    console.log('[BoxRequest] Firestore boxRequest status → declined, viewer will be notified');
  } catch (e) {
    console.error('[BoxRequest] Could not update Firestore boxRequest (declined):', e.code, e.message);
  }

  // ── Update RTDB status → declined, then remove ──
  try { await update(ref(_liveDB, `guestRequests/${_roomId}/${guestUid}`), { status: 'declined' }); } catch(_) {}
  setTimeout(async () => {
    try { await remove(ref(_liveDB, `guestRequests/${_roomId}/${guestUid}`)); } catch(_) {}
    // Clean up Firestore doc after 5s (viewer has had time to see the declined status)
    try { await deleteDoc(doc(_db, 'boxRequests', reqId)); } catch(_) {}
  }, 5000);
}

/* ── HOST: Add a guest cell to the video grid ── */
function _hostAddGuestCell(uid, name, avatar, stream, pc) {
  const grid = D.guestGrid;
  if (!grid) return;

  // If grid doesn't yet have host, add host cell first
  if (!grid.querySelector('.host-cell')) {
    _addHostCellToGrid();
  }

  // Prevent duplicate guest cells
  if (grid.querySelector(`[data-uid="${uid}"]`)) return;

  grid.classList.add('has-guests');
  grid.dataset.count = (Object.keys(_guestPeers).length).toString();

  const cell = document.createElement('div');
  cell.className = 'guest-cell';
  cell.dataset.uid = uid;

  // ── "Reconnecting..." overlay — shown when this guest's ICE drops ──
  const reconnEl = document.createElement('div');
  reconnEl.className = 'guest-cell-reconnecting';
  reconnEl.innerHTML = '<div class="gcr-spinner"></div><span>Reconnecting\u2026</span>';
  cell.appendChild(reconnEl);

  const vid = document.createElement('video');
  vid.autoplay = true;
  vid.muted = false;
  vid.playsInline = true;
  vid.srcObject = stream;
  // Retry play() up to 3 times — mobile browsers can defer the first play()
  const _kickVid = (n) => { const p = vid.play(); if (p && p.catch) p.catch(() => { if (n > 0) setTimeout(() => _kickVid(n-1), 300); }); };
  _kickVid(3);
  cell.appendChild(vid);

  const nameEl = document.createElement('div');
  nameEl.className = 'guest-cell-name';
  nameEl.textContent = name || 'Guest';
  cell.appendChild(nameEl);

  // Host can feature a guest (★ button) to make them the large video
  const featureBtn = document.createElement('button');
  featureBtn.className = 'guest-cell-feature';
  featureBtn.textContent = '★';
  featureBtn.title = 'Feature this guest (make large)';
  featureBtn.dataset.uid = uid;
  featureBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_featuredGuestUid === uid) {
      _clearFeaturedGuest();
    } else {
      _setFeaturedGuest(uid);
    }
  });
  cell.appendChild(featureBtn);

  // Host can remove a guest by tapping ✕
  const removeBtn = document.createElement('button');
  removeBtn.className = 'guest-cell-remove';
  removeBtn.textContent = '✕';
  removeBtn.title = 'Remove guest';
  removeBtn.addEventListener('click', () => {
    _hostRemoveGuest(uid);
  });
  cell.appendChild(removeBtn);

  grid.appendChild(cell);

  // Store stream ref
  if (_guestPeers[uid]) _guestPeers[uid].stream = stream;
  if (_guestPeers[uid]) _guestPeers[uid].cell   = cell;

  _applyGuestLayout();

  // ── Disconnect / reconnect handler for this guest cell ──
  // Layers of defence:
  //  • `disconnected` → show overlay; _attachIceWatchdog fires restartIce()
  //    at 3 s AND onnegotiationneeded triggers a full ICE-restart renegotiation.
  //    Give 15 s for the new ICE path + renegotiation round-trip to complete.
  //  • `failed` → _attachIceWatchdog already tried restartIce() and a new
  //    offer was written to RTDB via onnegotiationneeded.  Give 8 s for that
  //    renegotiation to finish before removing the cell.
  //  • `connected` → clear overlay and cancel any pending removal timer.
  let _dcTimer  = null;
  let _dcFailed = false;
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === 'disconnected') {
      // Show "Reconnecting..." overlay immediately
      cell.classList.add('is-reconnecting');
      // 15 s: 3 s ICE watchdog + onnegotiationneeded round-trip to RTDB + ICE path rebuild
      if (!_dcTimer) {
        _dcTimer = setTimeout(() => {
          _dcTimer = null;
          if (pc.connectionState !== 'connected' && _guestPeers[uid]) {
            _hostDoRemoveGuest(uid);
          }
        }, 15000);
      }
    } else if (state === 'failed') {
      if (_dcTimer) { clearTimeout(_dcTimer); _dcTimer = null; }
      if (_dcFailed) return; // avoid double-firing
      _dcFailed = true;
      cell.classList.add('is-reconnecting');
      // 8 s grace: onnegotiationneeded was already fired — allow the
      // ICE-restart renegotiation round-trip to complete.
      _dcTimer = setTimeout(() => {
        _dcTimer = null;
        if (_guestPeers[uid]) _hostDoRemoveGuest(uid);
      }, 8000);
    } else if (state === 'closed') {
      if (_dcTimer) { clearTimeout(_dcTimer); _dcTimer = null; }
      if (_guestPeers[uid]) _hostDoRemoveGuest(uid);
    } else if (state === 'connected') {
      // Recovered — hide reconnecting overlay, cancel pending removal
      cell.classList.remove('is-reconnecting');
      _dcFailed = false;
      if (_dcTimer) { clearTimeout(_dcTimer); _dcTimer = null; }
      // Re-attach stream to video element in case it was replaced
      const p = _guestPeers[uid];
      if (p && p.stream && vid.srcObject !== p.stream) {
        vid.srcObject = p.stream;
        vid.play().catch(() => {});
      }
    }
  };

  // ── Guest cell video health monitor ──
  // Polls every 4 s — kicks play() if paused and detects frozen currentTime.
  // Also ensures the host's video (not the guest's) doesn't interfere with
  // this cell's srcObject after reconnection.
  let _gcLastTime = -1;
  let _gcFrozenTicks = 0;
  const _hostCellHealthTimer = setInterval(() => {
    const p = _guestPeers[uid];
    if (!p || !p.cell) { clearInterval(_hostCellHealthTimer); return; }
    if (!vid.srcObject) return;
    if (vid.paused) {
      vid.play().catch(() => {});
      _gcLastTime = -1;
      return;
    }
    // Detect frozen currentTime (stream stall while ICE shows "connected")
    if (vid.currentTime === _gcLastTime && vid.currentTime > 0) {
      if (++_gcFrozenTicks >= 2) {
        _gcFrozenTicks = 0;
        const s = p.stream || vid.srcObject;
        if (s) { vid.srcObject = null; vid.srcObject = s; vid.play().catch(() => {}); }
      }
    } else {
      _gcFrozenTicks = 0;
      _gcLastTime = vid.currentTime;
    }
  }, 4000);
}

/* ── HOST: Add own video as the host cell in the grid ── */
function _addHostCellToGrid() {
  const grid = D.guestGrid;
  if (!grid || grid.querySelector('.host-cell')) return;

  const cell = document.createElement('div');
  cell.className = 'guest-cell host-cell';

  const vid = document.createElement('video');
  vid.autoplay = true;
  vid.muted = true;   // mute self-preview
  vid.playsInline = true;
  if (_localStream) { vid.srcObject = _localStream; vid.play().catch(()=>{}); }
  // Mirror host camera (same as main #liveVideo)
  vid.style.transform = 'scaleX(-1)';
  cell.appendChild(vid);

  // ── Health monitor: re-attach _localStream if the video element goes
  //    blank (e.g. screen lock, browser tab backgrounding on iOS).
  //    Runs every 3 s; cleans up when the host cell is removed.
  //    Also detects frozen currentTime (stream stall with no pause event). ──
  let _hcLastTime = -1;
  let _hcFrozenTicks = 0;
  const _selfVidHealth = setInterval(() => {
    if (!cell.isConnected) { clearInterval(_selfVidHealth); return; }
    if (!_localStream) return;
    // Re-attach if srcObject drifted (camera flip / new track)
    if (vid.srcObject !== _localStream) {
      vid.srcObject = _localStream;
      vid.play().catch(() => {});
      _hcLastTime = -1; _hcFrozenTicks = 0;
      return;
    }
    // Kick play() if paused
    if (vid.paused) { vid.play().catch(() => {}); _hcLastTime = -1; return; }
    // Detect frozen currentTime (browser silently stopped delivering frames)
    if (vid.currentTime === _hcLastTime && vid.currentTime > 0) {
      if (++_hcFrozenTicks >= 2) {
        _hcFrozenTicks = 0;
        vid.srcObject = null;
        vid.srcObject = _localStream;
        vid.play().catch(() => {});
      }
    } else {
      _hcFrozenTicks = 0;
      _hcLastTime = vid.currentTime;
    }
  }, 3000);

  const nameEl = document.createElement('div');
  nameEl.className = 'guest-cell-name';
  nameEl.textContent = (_userData?.displayName || 'Host') + ' (You)';
  cell.appendChild(nameEl);

  grid.insertBefore(cell, grid.firstChild);
}

/* ── HOST: Remove a guest (with confirmation) ── */
async function _hostRemoveGuest(uid) {
  const peer = _guestPeers[uid];
  const guestName = peer?.name || 'this guest';

  const confirmed = await _snxConfirm({
    icon:    '✕',
    title:   `Remove ${guestName}?`,
    sub:     'They will be disconnected from the guest box.',
    okLabel: 'Remove',
    okClass: '',
  });
  if (!confirmed) return;

  _hostDoRemoveGuest(uid);
}

/* ── Internal: perform the host-side guest removal ── */
function _hostDoRemoveGuest(uid) {
  // If the removed guest was featured, clear the featured state
  if (_featuredGuestUid === uid) {
    _featuredGuestUid = null;
    document.querySelectorAll('.guest-cell-feature').forEach(btn => btn.classList.remove('featured-active'));
    _broadcastFeaturedGuest();
  }
  // ── Signal the guest client to disconnect gracefully ──
  // Write removedByHost flag BEFORE closing the peer so the guest's listener fires
  try {
    set(ref(_liveDB, `guestSignaling/${_roomId}/${uid}/removedByHost`), true);
  } catch(_) {}

  // Tear down host-side signaling listener for this guest
  if (_hostSigUnsubs[uid]) {
    try { _hostSigUnsubs[uid](); } catch(_) {}
    delete _hostSigUnsubs[uid];
  }

  const peer = _guestPeers[uid];
  if (peer) {
    if (peer.pc) { try { peer.pc.close(); } catch(_){} }
    // Animate cell out (≤260ms) then remove — gives immediate visual feedback
    if (peer.cell && !peer.cell.classList.contains('removing')) {
      peer.cell.classList.add('removing');
      // Update count + re-layout immediately so remaining boxes rearrange without waiting
      delete _guestPeers[uid];
      const grid = D.guestGrid;
      if (grid) {
        const updatedCount = Object.keys(_guestPeers).length;
        grid.dataset.count = updatedCount.toString();
        if (updatedCount === 0) {
          grid.classList.remove('has-guests');
          // NOTE: Do NOT touch D.liveVideo here — the host video must keep
          // playing regardless of whether guests are present or not.
        }
        _applyGuestLayout();
      }
      setTimeout(() => {
        try { peer.cell.remove(); } catch(_){}
        // Final layout pass once the DOM node is gone
        _applyGuestLayout();
      }, 260);
    } else {
      delete _guestPeers[uid];
      if (peer.cell) { try { peer.cell.remove(); } catch(_){} }
    }
  } else {
    // peer already cleaned up; just delete key if present
    delete _guestPeers[uid];
  }
  // Allow this UID to send a new request in a future session
  _shownReqUids.delete(uid);
  try { remove(ref(_liveDB, `guestRequests/${_roomId}/${uid}`)); }  catch(_) {}
  // BUG-12 FIX: increase from 3 s → 8 s so slow-connection guests have enough time
  // to read the removedByHost flag before the signaling node is deleted.
  setTimeout(() => {
    try { remove(ref(_liveDB, `guestSignaling/${_roomId}/${uid}`)); } catch(_) {}
  }, 8000);
  // Remove guest presence so viewers' grids update instantly
  try { remove(ref(_liveDB, `liveGuests/${_roomId}/${uid}`)); } catch(_) {}
  // Clean up Firestore boxRequest
  const requestId = `${_roomId}_${uid}`;
  try { deleteDoc(doc(_db, 'boxRequests', requestId)); } catch(_) {}

  const grid = D.guestGrid;
  if (!grid) return;
  const guestCount = Object.keys(_guestPeers).length;
  grid.dataset.count = guestCount.toString();

  if (guestCount === 0) {
    // Remove host cell too, show plain main video
    grid.querySelector('.host-cell')?.remove();
    grid.classList.remove('has-guests');
    // NOTE: Do NOT touch D.liveVideo — removing all guests must never interrupt the host stream.
  }
  _applyGuestLayout();
}

/* ── HOST: Start the stale-guest watchdog ──
   Runs every 10 s and evicts any guest whose heartbeat (hb) timestamp
   is older than _STALE_THRESHOLD_MS.  Protects against ghosts from
   hard-crashes / silent network drops that don't trigger onDisconnect. */
function _startHostGuestWatchdog() {
  if (!_roomId) return;
  if (_hostWatchdogInterval) clearInterval(_hostWatchdogInterval);

  _hostWatchdogInterval = setInterval(async () => {
    if (!_roomId) return;
    try {
      // ── 1. Heartbeat staleness check ──
      const snap = await get(ref(_liveDB, `liveGuests/${_roomId}`));
      if (snap.exists()) {
        const now = Date.now();
        snap.forEach(child => {
          const g = child.val();
          if (g.isHost) return;   // never evict host entry
          const uid = child.key;
          // BUG-16 FIX: guests without a heartbeat field are either very new (joinedAt
          // within last 30 s) or from an older build.  Give them grace instead of silently
          // skipping forever — check joinedAt age so new guests aren't wrongly evicted.
          if (!g.hb) {
            const age = g.joinedAt ? (now - g.joinedAt) : (_STALE_THRESHOLD_MS + 1);
            if (age < _STALE_THRESHOLD_MS) return; // recently joined — wait for first hb
            // else: old entry with no heartbeat at all — treat as stale, fall through
          } else if (now - g.hb <= _STALE_THRESHOLD_MS) {
            return; // heartbeat is fresh — guest is alive
          }
          // Stale guest: evict
          console.log('[GuestWatchdog] Stale guest detected, evicting:', uid);
          try { remove(ref(_liveDB, `liveGuests/${_roomId}/${uid}`)); } catch(_) {}
          if (_guestPeers[uid]) {
            _hostDoRemoveGuest(uid);
          }
        });
      }

      // ── 2. Per-guest outbound byte-freeze check ──
      // If the host has stopped sending bytes to a connected guest for 2
      // consecutive ticks (20 s) it likely means the DTLS/SRTP path died
      // while ICE stayed "connected" — trigger restartIce() to re-path.
      for (const [uid, peer] of Object.entries(_guestPeers)) {
        if (!peer.pc) continue;
        const iceState = peer.pc.iceConnectionState;
        if (iceState === 'closed' || iceState === 'failed') continue;
        if (!peer._wdBytes) peer._wdBytes = { last: 0, frozen: 0 };
        try {
          const stats = await peer.pc.getStats();
          let sent = 0;
          stats.forEach(r => { if (r.type === 'outbound-rtp' && r.bytesSent) sent += r.bytesSent; });
          if (sent === peer._wdBytes.last) {
            peer._wdBytes.frozen++;
            if (peer._wdBytes.frozen >= 2) {
              peer._wdBytes.frozen = 0;
              console.warn('[GuestWatchdog] Frozen outbound to guest', uid, '— restartIce()');
              try { peer.pc.restartIce && peer.pc.restartIce(); } catch(_) {}
            }
          } else {
            peer._wdBytes.frozen = 0;
            peer._wdBytes.last   = sent;
          }
        } catch(_) {}
      }

      // ── 3. Host self-video health ──
      // If _localStream exists but the main video is paused (iOS background),
      // kick play() so the host stays broadcasting while the app is in the bg.
      if (_localStream && D.liveVideo && D.liveVideo.paused) {
        D.liveVideo.play().catch(() => {});
      }
    } catch(_) {}
  }, 10000); // check every 10 s
}

/* ── Tear down all guest peers (called on endLive) ── */
function _teardownAllGuestPeers() {
  // Stop the stale-guest watchdog
  if (_hostWatchdogInterval) { clearInterval(_hostWatchdogInterval); _hostWatchdogInterval = null; }

  // Tear down all host-side signaling listeners
  for (const uid of Object.keys(_hostSigUnsubs)) {
    try { _hostSigUnsubs[uid](); } catch(_) {}
  }
  _hostSigUnsubs = {};

  for (const uid of Object.keys(_guestPeers)) {
    const p = _guestPeers[uid];
    if (p.pc)   { try { p.pc.close(); }   catch(_){} }
    if (p.cell) { try { p.cell.remove(); } catch(_){} }
  }
  _guestPeers = {};
  if (D.guestGrid) {
    D.guestGrid.innerHTML = '';
    D.guestGrid.classList.remove('has-guests');
    D.guestGrid.dataset.count = '0';
  }
  // Clean up all signaling + requests + guest presence for this room (RTDB)
  if (_roomId) {
    try { remove(ref(_liveDB, `guestRequests/${_roomId}`)); }  catch(_) {}
    try { remove(ref(_liveDB, `guestSignaling/${_roomId}`)); } catch(_) {}
    try { remove(ref(_liveDB, `liveGuests/${_roomId}`)); }     catch(_) {}
  }
  // Clean up all pending Firestore boxRequests for this room
  if (_roomId) {
    getDocs(query(
      collection(_db, 'boxRequests'),
      where('liveId', '==', _roomId)
    )).then(snap => {
      snap.forEach(d => { try { deleteDoc(d.ref); } catch(_) {} });
    }).catch(() => {});
  }
}

/* ═══════════════════════════════════════════════════════════════════
   LAYOUT ENGINE  —  supports 1–9 guests + host (up to 10 total cells)
   ═══════════════════════════════════════════════════════════════════ */

function _applyGuestLayout() {
  // Coalesce rapid back-to-back calls into a single rAF paint
  if (_layoutRafId) return;
  _layoutRafId = requestAnimationFrame(() => {
    _layoutRafId = null;
    _doApplyGuestLayout();
  });
}

/* ── Wire a ResizeObserver so guest boxes re-layout when the
   stage (or window) resizes — covers orientation changes, split-
   screen, keyboard appearing, etc.  Called once from startLive /
   _startViewer after the stage is shown. ── */
function _attachGuestGridResizeObserver() {
  const grid = D.guestGrid;
  if (!grid || !window.ResizeObserver) return;
  const container = grid.parentElement || grid;
  const ro = new ResizeObserver(() => { _applyGuestLayout(); });
  ro.observe(container);
  window.addEventListener('orientationchange', () => {
    setTimeout(_applyGuestLayout, 150);
  }, { passive: true });
}

/* ── Page-visibility watchdog ──────────────────────────────────────────
   iOS and Android pause ALL video elements when the tab is backgrounded
   or the screen locks.  When the user returns, we kick every video that
   is paused so streams resume instantly — otherwise the host cell and
   guest cells stay frozen until the user taps the screen.              */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return; // only act on foreground
  // Kick every <video> in the stage (host video, guest cells, host cell)
  const vids = document.querySelectorAll('.live-stage video, .guest-grid video');
  vids.forEach(v => {
    if (v.paused && v.srcObject) {
      v.play().catch(() => {});
    }
  });
  // Also kick the main #liveVideo in case it's outside .live-stage
  if (D.liveVideo && D.liveVideo.paused && D.liveVideo.srcObject) {
    D.liveVideo.play().catch(() => {});
  }
});

/* ─────────────────────────────────────────────────────────────────
   _doApplyGuestLayout  —  the single source of truth for all
   geometry.  All explicit pixel / percentage assignments live here;
   CSS provides only the flex skeleton and default resets.

   Safe-zone: all layouts reserve a bottom margin so that guest boxes
   never overlap the chat panel or the controls bar.

   Auto-layout map (guestCount = guests, host NOT counted):
     1  → 2 participants: 50/50 split (portrait) or 60/40 (landscape)
     2  → 3 participants: host top 60% + 2 guests side-by-side below
     3  → 4 participants: 2×2 equal grid
     4  → 5 participants: host top row + 4 equal bottom strip
     5  → 6 participants: 2 rows × 3 cols equal
     6  → 7 participants: host 50% + 6 guests in 2×3
     7  → 8 participants: 2 rows × 4 cols equal
     8  → 9 participants: 3 rows × 3 cols equal
     9  → 10 participants: host prominent + 9 guests
   ───────────────────────────────────────────────────────────────── */

/* ── Helper: compute the UI safe zone bottom margin (controls + chat input) ── */
function _getUISafeBottom(stageH) {
  /* Creator: bottom bar + chat-input row height.
     Compact mode has a smaller bar.
     Viewer: chat input row height only — the action column is to the
     right so it doesn't add vertical height we need to clear.
     We add 8px padding so content never kisses the edge. */
  if (_mode === 'creator') {
    const barH = document.body.classList.contains('controls-compact') ? 44 : 56;
    return Math.max(barH + 52, Math.floor(stageH * 0.17));
  }
  // Viewer: reserve enough for the chat input row (≈56px) plus safe-area inset
  const safeAreaBottom = parseFloat(
    getComputedStyle(document.documentElement)
      .getPropertyValue('--safe-area-inset-bottom') || '0'
  ) || 0;
  return Math.max(56 + safeAreaBottom, Math.floor(stageH * 0.13));
}

function _doApplyGuestLayout() {
  const grid = D.guestGrid;
  if (!grid) return;

  // ── Smooth transition flash ──
  grid.classList.add('layout-transitioning');
  requestAnimationFrame(() => grid.classList.remove('layout-transitioning'));

  // ── Shared setup for both modes ──
  grid.dataset.layout = _guestLayout;
  grid.classList.remove('box-sm', 'box-md', 'box-lg');
  grid.classList.add('box-' + _guestBoxSize);

  // ── Resolve guestCount based on mode ──
  let guestCount;
  if (_mode === 'viewer') {
    guestCount = parseInt(grid.dataset.count || '0', 10);
  } else {
    guestCount = Object.keys(_guestPeers).length;
    grid.dataset.count = guestCount.toString();
  }

  if (guestCount === 0) {
    grid.classList.remove('has-guests');
    _applySidebarBodyClass();
    return;
  }
  grid.classList.add('has-guests');

  // ── Update guest-count indicator in layout panel ──
  _updateLayoutPanelCounter(guestCount);

  // ── Clear any previously JS-set inline styles on all cells ──
  grid.querySelectorAll('.guest-cell').forEach(c => {
    c.style.width        = '';
    c.style.height       = '';
    c.style.position     = '';
    c.style.inset        = '';
    c.style.top          = '';
    c.style.right        = '';
    c.style.bottom       = '';
    c.style.left         = '';
    c.style.flex         = '';
    c.style.zIndex       = '';
    c.style.borderRadius = '';
    c.style.transform    = '';
    c.style.opacity      = '';
  });
  // Reset grid flex properties
  grid.style.flexDirection = '';
  grid.style.flexWrap      = '';
  grid.style.alignContent  = '';
  grid.style.alignItems    = '';
  grid.style.paddingBottom = '';

  // ── Dispatch to the two supported layouts (with featured-guest override) ──

  // If a guest is featured and is still present, use featured layout
  if (_featuredGuestUid && grid.querySelector(`[data-uid="${_featuredGuestUid}"]`)) {
    _applyFeaturedGuestLayout(grid, guestCount);
    return;
  }

  // Default dispatch: right stack or left stack
  if (_guestLayout === 'host-full-left') {
    _applyHostFullLeftLayout(grid, guestCount);
  } else {
    // Default: 'host-full' (right stack) — also handles any legacy saved layout values
    _applyHostFullLayout(grid, guestCount);
  }
}

/* ─────────────────────────────────────────────────────────────────
   AUTO LAYOUT  —  smart geometry for every count 1–9
   Each case is tuned to keep host video as the main focus and
   keep all cells within the visible stage without clipping.
   ───────────────────────────────────────────────────────────────── */
function _applyAutoLayout(grid, guestCount, totalCells) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;   // height available for video cells
  const isLandscape = stageW >= stageH;
  // Height ratios are expressed as fraction of usableH so cells never cover UI
  const uH = (pct) => ((usableH / stageH) * pct).toFixed(4) + '%';
  const hostCell   = grid.querySelector('.host-cell');
  const guestCells = Array.from(grid.querySelectorAll('.guest-cell:not(.host-cell)'));

  // Apply bottom padding so flex rows stop before the UI zone
  grid.style.paddingBottom = safeBottom + 'px';
  grid.style.alignContent  = 'flex-start';

  switch (guestCount) {

    /* ── 1 guest: side-by-side split ── */
    case 1: {
      grid.style.flexDirection = 'row';
      grid.style.flexWrap      = 'nowrap';
      grid.style.alignItems    = 'flex-start';
      if (hostCell)      { hostCell.style.width = '50%';  hostCell.style.height = usableH + 'px'; }
      if (guestCells[0]) { guestCells[0].style.width = '50%'; guestCells[0].style.height = usableH + 'px'; }
      break;
    }

    /* ── 2 guests ── */
    case 2: {
      if (isLandscape) {
        // Landscape: host 60% left, 2 guests stacked in 40% right
        grid.style.flexDirection = 'row';
        grid.style.flexWrap      = 'wrap';
        if (hostCell) { hostCell.style.width = '60%'; hostCell.style.height = usableH + 'px'; }
        guestCells.forEach(c => { c.style.width = '40%'; c.style.height = (usableH / 2) + 'px'; });
      } else {
        // Portrait: host top 60%, 2 guests side-by-side below 40%
        grid.style.flexDirection = 'row';
        grid.style.flexWrap      = 'wrap';
        const hostH  = Math.floor(usableH * 0.60);
        const guestH = usableH - hostH;
        if (hostCell) { hostCell.style.width = '100%'; hostCell.style.height = hostH + 'px'; }
        guestCells.forEach(c => { c.style.width = '50%'; c.style.height = guestH + 'px'; });
      }
      break;
    }

    /* ── 3 guests: 2×2 equal grid (host + 3 = 4 cells) ── */
    case 3: {
      _applyEqualGridUsable(grid, 4, stageW, usableH);
      break;
    }

    /* ── 4 guests: host prominent top + 4 equal bottom ── */
    case 4: {
      grid.style.flexDirection = 'row';
      grid.style.flexWrap      = 'wrap';
      const hostH4  = Math.floor(usableH * 0.55);
      const guestH4 = usableH - hostH4;
      if (hostCell) { hostCell.style.width = '100%'; hostCell.style.height = hostH4 + 'px'; }
      guestCells.forEach(c => { c.style.width = '25%'; c.style.height = guestH4 + 'px'; });
      break;
    }

    /* ── 5 guests: 2 rows × 3 cols (6 cells) ── */
    case 5: {
      _applyEqualGridUsable(grid, 6, stageW, usableH);
      break;
    }

    /* ── 6 guests: host prominent + 6 guests ── */
    case 6: {
      if (isLandscape) {
        // Landscape: host 50% left × full usable height, 6 guests in 2 col strips right
        grid.style.flexDirection = 'row';
        grid.style.flexWrap      = 'wrap';
        const g6H = usableH / 3;
        if (hostCell) { hostCell.style.width = '50%'; hostCell.style.height = usableH + 'px'; }
        guestCells.forEach((c, i) => {
          c.style.width  = '25%';
          c.style.height = g6H + 'px';
        });
      } else {
        // Portrait: host top 40%, 6 guests in 2 rows of 3 below
        grid.style.flexDirection = 'row';
        grid.style.flexWrap      = 'wrap';
        const hostH6  = Math.floor(usableH * 0.42);
        const guestH6 = (usableH - hostH6) / 2;
        if (hostCell) { hostCell.style.width = '100%'; hostCell.style.height = hostH6 + 'px'; }
        guestCells.forEach(c => { c.style.width = '33.33%'; c.style.height = guestH6 + 'px'; });
      }
      break;
    }

    /* ── 7 guests: 2 rows × 4 cols (8 cells) ── */
    case 7: {
      _applyEqualGridUsable(grid, 8, stageW, usableH);
      break;
    }

    /* ── 8 guests: 3×3 equal (9 cells) ── */
    case 8: {
      _applyEqualGridUsable(grid, 9, stageW, usableH);
      break;
    }

    /* ── 9 guests: host prominent + 9 guests ── */
    case 9: {
      if (isLandscape) {
        grid.style.flexDirection = 'row';
        grid.style.flexWrap      = 'wrap';
        const g9H = usableH / 3;
        if (hostCell) { hostCell.style.width = '34%'; hostCell.style.height = usableH + 'px'; }
        guestCells.forEach(c => { c.style.width = '22%'; c.style.height = g9H + 'px'; });
      } else {
        grid.style.flexDirection = 'row';
        grid.style.flexWrap      = 'wrap';
        const hostH9  = Math.floor(usableH * 0.35);
        const guestH9 = (usableH - hostH9) / 3;
        if (hostCell) { hostCell.style.width = '100%'; hostCell.style.height = hostH9 + 'px'; }
        guestCells.forEach(c => { c.style.width = '33.33%'; c.style.height = guestH9 + 'px'; });
      }
      break;
    }

    default: {
      _applyEqualGridUsable(grid, totalCells, stageW, usableH);
    }
  }
}

/* ─────────────────────────────────────────────────────────────────
   NAMED LAYOUT HELPERS
   ───────────────────────────────────────────────────────────────── */

/* ── Equal grid (named mode): calculate optimal rows/cols then set dimensions ── */
function _applyEqualGrid(grid, totalCells) {
  const stageW   = grid.offsetWidth  || window.innerWidth;
  const stageH   = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH  = stageH - safeBottom;
  _applyEqualGridUsable(grid, totalCells, stageW, usableH);
}

/* ── Equal grid using a pre-computed usable height (used by auto layout) ── */
function _applyEqualGridUsable(grid, totalCells, stageW, usableH) {
  // Pick cols to minimise wasted space given aspect ratio
  const cols        = Math.ceil(Math.sqrt(totalCells * (stageW / Math.max(1, usableH))));
  const colsClamped = Math.max(1, Math.min(totalCells, cols));
  const rows        = Math.ceil(totalCells / colsClamped);
  const w           = (100 / colsClamped).toFixed(4) + '%';
  const h           = Math.floor(usableH / rows) + 'px';
  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'wrap';
  grid.style.alignContent  = 'flex-start';
  grid.style.paddingBottom = '';   // equal grid uses its own height calc
  grid.querySelectorAll('.guest-cell').forEach(cell => {
    cell.style.width  = w;
    cell.style.height = h;
  });
}

/* ── Split: side-by-side equal strips ── */
function _applySplitLayout(grid, guestCount) {
  const stageH   = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH  = stageH - safeBottom;
  const cells    = Array.from(grid.querySelectorAll('.guest-cell'));
  const n        = cells.length;
  if (n === 0) return;
  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'nowrap';
  grid.style.alignItems    = 'flex-start';
  grid.style.paddingBottom = safeBottom + 'px';
  const w = (100 / n).toFixed(4) + '%';
  cells.forEach(c => { c.style.width = w; c.style.height = usableH + 'px'; });
}

/* ═══════════════════════════════════════════════════════════════════
   LAYOUT 1 — RIGHT STACK
   Host video fills the full screen. Up to 8 guest boxes are stacked
   in a single vertical column on the right side, anchored from just
   below the top-bar down to just above the bottom controls bar.
   All 8 boxes are auto-sized to fill the available height evenly.
   No box is cut off, none overlap, host stays fully visible.
   ═══════════════════════════════════════════════════════════════════ */
function _applyHostFullLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const hostCell   = grid.querySelector('.host-cell');

  // Host fills the full stage
  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = '100%';
    hostCell.style.height   = '100%';
    hostCell.style.flex     = 'none';
    hostCell.style.zIndex   = '4';
  }

  const cappedCount = Math.min(guestCount, _MAX_GUESTS);
  if (cappedCount === 0) return;

  // Reserve room for top bar (approx 52px) and comments area below it
  const topReserve  = 56;
  const gap         = 4;
  const availH      = stageH - safeBottom - topReserve - gap;
  // Tile height: divide available height evenly among all guests
  const tileH       = Math.max(44, Math.floor((availH - gap * (cappedCount - 1)) / cappedCount));
  // Tile width: 4:3 ratio, clamped to 22% of stage width max (keeps host visible)
  const maxTileW    = Math.max(64, Math.floor(stageW * 0.22));
  const tileW       = Math.min(Math.floor(tileH * (4 / 3)), maxTileW);
  const rightMargin = gap;

  Array.from(grid.querySelectorAll('.guest-cell:not(.host-cell)')).slice(0, cappedCount).forEach((cell, i) => {
    cell.style.position     = 'absolute';
    cell.style.width        = tileW + 'px';
    cell.style.height       = tileH + 'px';
    cell.style.right        = rightMargin + 'px';
    cell.style.top          = (topReserve + i * (tileH + gap)) + 'px';
    cell.style.left         = 'auto';
    cell.style.bottom       = 'auto';
    cell.style.flex         = 'none';
    cell.style.zIndex       = '6';
    cell.style.borderRadius = '10px';
    cell.style.overflow     = 'hidden';
  });
}

/* ── Host Big: host takes most of the width, guests in a vertical strip ── */
function _applyHostBigLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;
  const hostCell   = grid.querySelector('.host-cell');
  const guestCells = Array.from(grid.querySelectorAll('.guest-cell:not(.host-cell)'));

  // Strip width: clamp to avoid tiny guest tiles
  const stripW = Math.max(80, Math.min(200, Math.floor(stageW * 0.22)));
  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'nowrap';
  grid.style.alignItems    = 'flex-start';
  grid.style.paddingBottom = safeBottom + 'px';

  if (hostCell) {
    hostCell.style.flex   = '1';
    hostCell.style.height = usableH + 'px';
  }

  // Stack guests in the strip — if more than 5, split into 2 sub-columns
  const subCols = guestCount > 5 ? 2 : 1;
  const gH      = Math.floor(usableH / Math.ceil(guestCount / subCols)) + 'px';
  const gW      = (stripW / subCols) + 'px';
  guestCells.forEach(c => {
    c.style.width  = gW;
    c.style.height = gH;
    c.style.flex   = 'none';
  });
}

/* ── Float layout: cascade guest boxes from top-right, responsive.
   Tiles are capped so they never enter the UI safe zone.          ── */
function _applyFloatLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;
  const hostCell   = grid.querySelector('.host-cell');

  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = '100%';
    hostCell.style.height   = '100%';
  }

  // Scale tile size down for more guests
  const base    = Math.max(55, Math.min(160, Math.floor(stageW * 0.20)));
  const tileW   = guestCount > 5 ? Math.floor(base * 0.75) : base;
  const tileH   = Math.floor(tileW * 0.75);
  const gap     = Math.max(4, Math.floor(stageW * 0.012));
  const cols    = Math.max(1, Math.floor((stageW - gap) / (tileW + gap)));
  // Max rows that fit in the usable zone
  const maxRows = Math.max(1, Math.floor((usableH - gap) / (tileH + gap)));

  let i = 0;
  grid.querySelectorAll('.guest-cell:not(.host-cell)').forEach(cell => {
    const col = i % cols;
    const row = Math.min(Math.floor(i / cols), maxRows - 1);
    cell.style.position = 'absolute';
    cell.style.width    = tileW + 'px';
    cell.style.height   = tileH + 'px';
    cell.style.right    = (gap + col * (tileW + gap)) + 'px';
    cell.style.top      = (gap + row * (tileH + gap)) + 'px';
    cell.style.bottom   = 'auto';
    cell.style.left     = 'auto';
    i++;
  });
}

/* ── Stacked layout: host fills the stage; guests stack in a vertical strip
   along the right edge, growing from bottom to top as more guests join.
   Guests never overlap the UI safe zone at the bottom.                     ── */
function _applyStackedLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const hostCell   = grid.querySelector('.host-cell');

  // Host fills the full stage behind the guest strip
  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = '100%';
    hostCell.style.height   = '100%';
    hostCell.style.flex     = 'none';
  }

  // Strip geometry — adaptive to guest count and screen size
  const topReserve = 8;                                                  // top gap
  const usableH    = stageH - safeBottom - topReserve;
  const maxTileH   = Math.max(60, Math.floor(stageH * 0.15));
  const tileH      = Math.max(48, Math.min(maxTileH, Math.floor(usableH / Math.max(1, guestCount))));
  const tileW      = Math.floor(tileH * (4 / 3));
  const clampedW   = Math.min(tileW, Math.max(56, Math.floor(stageW * 0.22)));
  const gap        = 4;

  // Stack bottom-to-top: first guest at bottom, newest above
  Array.from(grid.querySelectorAll('.guest-cell:not(.host-cell)')).forEach((cell, i) => {
    const fromBottom = safeBottom + topReserve + i * (tileH + gap);
    cell.style.position     = 'absolute';
    cell.style.width        = clampedW + 'px';
    cell.style.height       = tileH + 'px';
    cell.style.right        = gap + 'px';
    cell.style.bottom       = fromBottom + 'px';
    cell.style.top          = 'auto';
    cell.style.left         = 'auto';
    cell.style.flex         = 'none';
    cell.style.zIndex       = '6';
    cell.style.borderRadius = '10px';
  });
}

/* ═══════════════════════════════════════════════════════════════════
   LAYOUT 2 — LEFT STACK
   Host video fills the full screen. Up to 8 guest boxes are stacked
   in a single vertical column on the left side, anchored from just
   below the top-bar down to just above the bottom controls bar.
   All 8 boxes are auto-sized to fill the available height evenly.
   No box is cut off, none overlap, host stays fully visible.
   ═══════════════════════════════════════════════════════════════════ */
function _applyHostFullLeftLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const hostCell   = grid.querySelector('.host-cell');

  // Host fills the full stage
  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = '100%';
    hostCell.style.height   = '100%';
    hostCell.style.flex     = 'none';
    hostCell.style.zIndex   = '4';
  }

  const cappedCount = Math.min(guestCount, _MAX_GUESTS);
  if (cappedCount === 0) return;

  const topReserve  = 56;
  const gap         = 4;
  const availH      = stageH - safeBottom - topReserve - gap;
  const tileH       = Math.max(44, Math.floor((availH - gap * (cappedCount - 1)) / cappedCount));
  const maxTileW    = Math.max(64, Math.floor(stageW * 0.22));
  const tileW       = Math.min(Math.floor(tileH * (4 / 3)), maxTileW);
  const leftMargin  = gap;

  Array.from(grid.querySelectorAll('.guest-cell:not(.host-cell)')).slice(0, cappedCount).forEach((cell, i) => {
    cell.style.position     = 'absolute';
    cell.style.width        = tileW + 'px';
    cell.style.height       = tileH + 'px';
    cell.style.left         = leftMargin + 'px';
    cell.style.top          = (topReserve + i * (tileH + gap)) + 'px';
    cell.style.right        = 'auto';
    cell.style.bottom       = 'auto';
    cell.style.flex         = 'none';
    cell.style.zIndex       = '6';
    cell.style.borderRadius = '10px';
    cell.style.overflow     = 'hidden';
  });
}

/* ═══════════════════════════════════════════════════════════════════
   FEATURED GUEST LAYOUT
   One guest is featured in the large video area (like a host swap).
   The featured cell fills most of the screen. All remaining guests
   (including the host cell) stack on the side using the current
   layout side preference (right or left).
   ═══════════════════════════════════════════════════════════════════ */
function _applyFeaturedGuestLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const featuredCell = grid.querySelector(`[data-uid="${_featuredGuestUid}"]`);
  if (!featuredCell) { _featuredGuestUid = null; _applyHostFullLayout(grid, guestCount); return; }

  // Mark featured cell visually (removes border/shadow via CSS)
  grid.querySelectorAll('.guest-cell').forEach(c => c.classList.remove('featured-cell'));
  featuredCell.classList.add('featured-cell');

  // Featured guest fills the whole screen (like host)
  featuredCell.style.position     = 'absolute';
  featuredCell.style.inset        = '0';
  featuredCell.style.width        = '100%';
  featuredCell.style.height       = '100%';
  featuredCell.style.flex         = 'none';
  featuredCell.style.zIndex       = '4';
  featuredCell.style.borderRadius = '0';
  featuredCell.style.overflow     = 'hidden';

  // Collect all other cells (host + non-featured guests) for the side stack
  const sideCells = Array.from(grid.querySelectorAll('.guest-cell'))
    .filter(c => c !== featuredCell);
  const sideCount = sideCells.length;

  if (sideCount === 0) return;

  const topReserve  = 56;
  const gap         = 4;
  const availH      = stageH - safeBottom - topReserve - gap;
  const cappedSide  = Math.min(sideCount, _MAX_GUESTS);
  const tileH       = Math.max(44, Math.floor((availH - gap * (cappedSide - 1)) / cappedSide));
  const maxTileW    = Math.max(64, Math.floor(stageW * 0.22));
  const tileW       = Math.min(Math.floor(tileH * (4 / 3)), maxTileW);

  // Side to stack on — mirrors current layout preference
  const useLeft = (_guestLayout === 'host-full-left');

  sideCells.slice(0, cappedSide).forEach((cell, i) => {
    cell.style.position     = 'absolute';
    cell.style.width        = tileW + 'px';
    cell.style.height       = tileH + 'px';
    cell.style.top          = (topReserve + i * (tileH + gap)) + 'px';
    cell.style.left         = useLeft ? gap + 'px' : 'auto';
    cell.style.right        = useLeft ? 'auto' : gap + 'px';
    cell.style.bottom       = 'auto';
    cell.style.flex         = 'none';
    cell.style.zIndex       = '6';
    cell.style.borderRadius = '10px';
    cell.style.overflow     = 'hidden';
  });
}

/* ── Set a featured guest — makes their box the large video ── */
function _setFeaturedGuest(uid) {
  _featuredGuestUid = uid;
  // Update star button highlights
  document.querySelectorAll('.guest-cell-feature').forEach(btn => {
    btn.classList.toggle('featured-active', btn.dataset.uid === uid);
  });
  _applyGuestLayout();
  _broadcastFeaturedGuest();
  toast('Featured guest set — tap ★ again or "Return to Host View" to switch back');
}

/* ── Clear featured guest — return host to the large view ── */
function _clearFeaturedGuest() {
  _featuredGuestUid = null;
  document.querySelectorAll('.guest-cell-feature').forEach(btn => btn.classList.remove('featured-active'));
  document.querySelectorAll('.guest-cell.featured-cell').forEach(c => c.classList.remove('featured-cell'));
  _applyGuestLayout();
  _broadcastFeaturedGuest();
}

/* ── Broadcast featured guest UID so viewers see the same large video ── */
function _broadcastFeaturedGuest() {
  if (!_roomId) return;
  try {
    update(ref(_liveDB, `liveRooms/${_roomId}`), {
      featuredGuestUid: _featuredGuestUid || null,
    });
  } catch(_) {}
}

/* ── Layout 3: Host Full + Bottom Filmstrip ── */
function _applyBottomStripLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const stripH     = Math.max(52, Math.min(100, Math.floor(stageH * 0.14)));
  const hostCell   = grid.querySelector('.host-cell');

  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = '100%';
    hostCell.style.height   = '100%';
  }

  const tileW   = Math.floor((stageW - (guestCount + 1) * 4) / guestCount);
  const bottom  = safeBottom + 4;
  grid.querySelectorAll('.guest-cell:not(.host-cell)').forEach((cell, i) => {
    cell.style.position = 'absolute';
    cell.style.width    = tileW + 'px';
    cell.style.height   = stripH + 'px';
    cell.style.left     = (i * (tileW + 4)) + 'px';
    cell.style.bottom   = bottom + 'px';
    cell.style.top      = 'auto';
    cell.style.right    = 'auto';
  });
}

/* ── Layout 4: Host Full + Top Filmstrip ── */
function _applyTopStripLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const stripH     = Math.max(52, Math.min(100, Math.floor(stageH * 0.14)));
  const hostCell   = grid.querySelector('.host-cell');

  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = '100%';
    hostCell.style.height   = '100%';
  }

  const tileW = Math.floor((stageW - (guestCount + 1) * 4) / guestCount);
  grid.querySelectorAll('.guest-cell:not(.host-cell)').forEach((cell, i) => {
    cell.style.position = 'absolute';
    cell.style.width    = tileW + 'px';
    cell.style.height   = stripH + 'px';
    cell.style.left     = (i * (tileW + 4)) + 'px';
    cell.style.top      = '4px';
    cell.style.bottom   = 'auto';
    cell.style.right    = 'auto';
  });
}

/* ── Layout 4b: Left Side Vertical Strip ── */
function _applyLeftStripLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const hostCell   = grid.querySelector('.host-cell');

  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = '100%';
    hostCell.style.height   = '100%';
    hostCell.style.flex     = 'none';
  }

  const topReserve = 8;
  const usableH    = stageH - safeBottom - topReserve;
  const maxTileH   = Math.max(60, Math.floor(stageH * 0.15));
  const tileH      = Math.max(48, Math.min(maxTileH, Math.floor(usableH / Math.max(1, guestCount))));
  const tileW      = Math.min(Math.floor(tileH * (4 / 3)), Math.floor(stageW * 0.22));
  const gap        = 4;

  Array.from(grid.querySelectorAll('.guest-cell:not(.host-cell)')).forEach((cell, i) => {
    const fromBottom = safeBottom + topReserve + i * (tileH + gap);
    cell.style.position     = 'absolute';
    cell.style.width        = tileW + 'px';
    cell.style.height       = tileH + 'px';
    cell.style.left         = gap + 'px';
    cell.style.bottom       = fromBottom + 'px';
    cell.style.top          = 'auto';
    cell.style.right        = 'auto';
    cell.style.flex         = 'none';
    cell.style.zIndex       = '6';
    cell.style.borderRadius = '10px';
  });
}

/* ── Layout 5b: 2×2 Fixed Grid ── */
function _applyFixedGrid(grid, cols, rows) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;
  const w          = (100 / cols).toFixed(4) + '%';
  const h          = Math.floor(usableH / rows) + 'px';
  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'wrap';
  grid.style.alignContent  = 'flex-start';
  grid.style.paddingBottom = safeBottom + 'px';
  grid.querySelectorAll('.guest-cell').forEach(cell => {
    cell.style.width  = w;
    cell.style.height = h;
  });
}

/* ── Layout 16: Honeycomb ── */
function _applyHoneycombLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;
  const total      = guestCount + 1;
  const cols       = Math.ceil(Math.sqrt(total * 1.1));
  const hexW       = Math.floor((stageW - 8) / cols);
  const hexH       = Math.floor(hexW * 0.866); // cos(30°) ≈ 0.866
  const gap        = 4;

  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'wrap';
  grid.style.alignContent  = 'flex-start';
  grid.style.paddingBottom = safeBottom + 'px';

  grid.querySelectorAll('.guest-cell').forEach((cell, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const offset = (row % 2 === 1) ? (hexW / 2) : 0;
    cell.style.position = 'absolute';
    cell.style.width    = (hexW - gap) + 'px';
    cell.style.height   = (hexH - gap) + 'px';
    cell.style.left     = (col * hexW + offset) + 'px';
    cell.style.top      = (row * (hexH * 0.75)) + 'px';
    cell.style.zIndex   = '5';
  });
}

/* ── Layout 17: Circular ── */
function _applyCircularLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const cx         = stageW / 2;
  const cy         = (stageH - safeBottom) / 2;
  const tileSize   = Math.max(56, Math.min(140, Math.floor(Math.min(stageW, stageH - safeBottom) * 0.22)));
  const radius     = Math.max(tileSize, Math.min(stageW * 0.38, (stageH - safeBottom) * 0.35));

  grid.style.position = 'relative';

  // Place host in center
  const hostCell = grid.querySelector('.host-cell');
  if (hostCell) {
    const hostSize = Math.floor(tileSize * 1.6);
    hostCell.style.position = 'absolute';
    hostCell.style.width    = hostSize + 'px';
    hostCell.style.height   = hostSize + 'px';
    hostCell.style.left     = (cx - hostSize / 2) + 'px';
    hostCell.style.top      = (cy - hostSize / 2) + 'px';
    hostCell.style.zIndex   = '4';
    hostCell.style.borderRadius = '50%';
  }

  // Distribute guests evenly around the circle
  Array.from(grid.querySelectorAll('.guest-cell:not(.host-cell)')).forEach((cell, i) => {
    const angle = (i / guestCount) * 2 * Math.PI - Math.PI / 2;
    const x     = cx + radius * Math.cos(angle) - tileSize / 2;
    const y     = cy + radius * Math.sin(angle) - tileSize / 2;
    cell.style.position = 'absolute';
    cell.style.width    = tileSize + 'px';
    cell.style.height   = tileSize + 'px';
    cell.style.left     = x + 'px';
    cell.style.top      = y + 'px';
    cell.style.zIndex   = '6';
  });
}

/* ── Layout 18: Floating Bubble (alias of float with rounded cells) ── */
// (reuses _applyFloatLayout — CSS gives circular border-radius for bubble feel)

/* ── Layout 10: Picture-in-Picture ── */
function _applyPipLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const hostCell   = grid.querySelector('.host-cell');

  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = '100%';
    hostCell.style.height   = '100%';
  }

  const pipW    = Math.max(90, Math.min(200, Math.floor(stageW * 0.26)));
  const pipH    = Math.floor(pipW * 0.75);
  const gap     = 12;
  const maxCols = Math.max(1, Math.floor((stageW - gap) / (pipW + gap)));
  const maxRows = Math.max(1, Math.floor((stageH - safeBottom - gap) / (pipH + gap)));

  let i = 0;
  grid.querySelectorAll('.guest-cell:not(.host-cell)').forEach(cell => {
    const col = i % maxCols;
    const row = Math.min(Math.floor(i / maxCols), maxRows - 1);
    cell.style.position = 'absolute';
    cell.style.width    = pipW + 'px';
    cell.style.height   = pipH + 'px';
    cell.style.right    = (gap + col * (pipW + gap)) + 'px';
    cell.style.bottom   = (safeBottom + gap + row * (pipH + gap)) + 'px';
    cell.style.top      = 'auto';
    cell.style.left     = 'auto';
    i++;
  });
}

/* ── Layout 9: Host Focus — host always full-screen, guests tiny overlay ── */
function _applyHostFocusLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const hostCell   = grid.querySelector('.host-cell');

  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = '100%';
    hostCell.style.height   = '100%';
    hostCell.style.zIndex   = '4';
  }

  const tileW   = Math.max(52, Math.min(110, Math.floor(stageW * 0.13)));
  const tileH   = Math.floor(tileW * 0.75);
  const gap     = 5;
  const cols    = Math.max(1, Math.floor((stageW * 0.5) / (tileW + gap)));
  const maxRows = Math.max(1, Math.floor((stageH - safeBottom * 1.2) / (tileH + gap)));

  let i = 0;
  grid.querySelectorAll('.guest-cell:not(.host-cell)').forEach(cell => {
    const col = i % cols;
    const row = Math.min(Math.floor(i / cols), maxRows - 1);
    cell.style.position     = 'absolute';
    cell.style.width        = tileW + 'px';
    cell.style.height       = tileH + 'px';
    cell.style.right        = (gap + col * (tileW + gap)) + 'px';
    cell.style.top          = (gap + row * (tileH + gap)) + 'px';
    cell.style.bottom       = 'auto';
    cell.style.left         = 'auto';
    cell.style.zIndex       = '6';
    cell.style.borderRadius = '8px';
    cell.style.opacity      = '0.88';
    i++;
  });
}

/* ── Layout 8: Speaker Focus ── */
function _applySpeakerLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;
  const cells      = Array.from(grid.querySelectorAll('.guest-cell'));
  const hostCell   = grid.querySelector('.host-cell');

  // Active speaker gets 70% of width, others share the strip
  const speakerCell = grid.querySelector('.guest-cell.speaker-active') || hostCell;
  const otherCells  = cells.filter(c => c !== speakerCell);

  const stripW  = otherCells.length > 0 ? Math.max(70, Math.min(140, Math.floor(stageW * 0.20))) : 0;
  const mainW   = stageW - stripW;
  const mainH   = usableH;

  if (speakerCell) {
    speakerCell.style.position = 'absolute';
    speakerCell.style.left     = '0';
    speakerCell.style.top      = '0';
    speakerCell.style.width    = mainW + 'px';
    speakerCell.style.height   = mainH + 'px';
    speakerCell.style.zIndex   = '5';
  }

  const gH = otherCells.length > 0 ? Math.floor(usableH / otherCells.length) : 0;
  otherCells.forEach((cell, i) => {
    cell.style.position     = 'absolute';
    cell.style.right        = '0';
    cell.style.top          = (i * gH) + 'px';
    cell.style.width        = stripW + 'px';
    cell.style.height       = gH + 'px';
    cell.style.left         = 'auto';
    cell.style.zIndex       = '4';
    cell.style.borderRadius = '0';
  });

  // Start/restart audio level polling
  _startSpeakerDetection();
}

/* ── Layout 24: Theater Mode ── */
function _applyTheaterLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;
  const hostH      = Math.floor(usableH * 0.72);
  const guestH     = usableH - hostH;
  const hostCell   = grid.querySelector('.host-cell');

  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'wrap';
  grid.style.alignContent  = 'flex-start';
  grid.style.paddingBottom = safeBottom + 'px';

  if (hostCell) {
    hostCell.style.width  = '100%';
    hostCell.style.height = hostH + 'px';
    hostCell.style.flex   = 'none';
  }

  const gW = (100 / guestCount).toFixed(4) + '%';
  grid.querySelectorAll('.guest-cell:not(.host-cell)').forEach(cell => {
    cell.style.width  = gW;
    cell.style.height = guestH + 'px';
    cell.style.flex   = 'none';
  });
}

/* ── Layout 25: Audience Mode — host full, guests hidden ── */
function _applyAudienceLayout(grid, guestCount) {
  const hostCell = grid.querySelector('.host-cell');
  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = '100%';
    hostCell.style.height   = '100%';
    hostCell.style.zIndex   = '4';
  }
  // Guest cells hidden via CSS (opacity: 0)
  grid.querySelectorAll('.guest-cell:not(.host-cell)').forEach(cell => {
    cell.style.position = 'absolute';
    cell.style.width    = '0';
    cell.style.height   = '0';
    cell.style.overflow = 'hidden';
    cell.style.opacity  = '0';
  });
}

/* ── Layout 11: Vertical Stack ── */
function _applyVerticalStackLayout(grid, guestCount) {
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;
  const total      = guestCount + 1;
  const h          = Math.floor(usableH / total);

  grid.style.flexDirection = 'column';
  grid.style.flexWrap      = 'nowrap';
  grid.style.alignItems    = 'stretch';
  grid.style.paddingBottom = safeBottom + 'px';

  grid.querySelectorAll('.guest-cell').forEach(cell => {
    cell.style.width  = '100%';
    cell.style.height = h + 'px';
    cell.style.flex   = 'none';
  });
}

/* ── Layout 12: Horizontal Stack ── */
function _applyHorizontalStackLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;
  const total      = guestCount + 1;
  const w          = Math.floor(stageW / total);

  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'nowrap';
  grid.style.alignItems    = 'flex-start';
  grid.style.paddingBottom = safeBottom + 'px';

  grid.querySelectorAll('.guest-cell').forEach(cell => {
    cell.style.width  = w + 'px';
    cell.style.height = usableH + 'px';
    cell.style.flex   = 'none';
  });
}

/* ── Layout 13: Split Screen (Host + 1 Guest, equal 50/50) ── */
function _applySplit2Layout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;
  const cells      = Array.from(grid.querySelectorAll('.guest-cell'));

  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'wrap';
  grid.style.alignContent  = 'flex-start';
  grid.style.paddingBottom = safeBottom + 'px';

  // Host + first guest: equal halves
  const mainCells = cells.slice(0, 2);
  mainCells.forEach(c => { c.style.width = '50%'; c.style.height = usableH + 'px'; c.style.flex = 'none'; });

  // Any extra guests: small thumbnails in a bottom row
  const extraCells = cells.slice(2);
  if (extraCells.length > 0) {
    const extraH = Math.min(80, Math.floor(usableH * 0.25));
    const extraW = (100 / extraCells.length).toFixed(4) + '%';
    extraCells.forEach(c => { c.style.width = extraW; c.style.height = extraH + 'px'; c.style.flex = 'none'; });
    // Shrink main cells to make room
    const mainH = usableH - extraH;
    mainCells.forEach(c => { c.style.height = mainH + 'px'; });
  }
}

/* ── Layout 14: Triple Split (Host + 2 Guests) ── */
function _applyTripleLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;
  const cells      = Array.from(grid.querySelectorAll('.guest-cell'));
  const isLandscape = stageW >= stageH;

  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'wrap';
  grid.style.alignContent  = 'flex-start';
  grid.style.paddingBottom = safeBottom + 'px';

  if (isLandscape) {
    // Three equal vertical strips
    const w = (100 / 3).toFixed(4) + '%';
    cells.slice(0, 3).forEach(c => { c.style.width = w; c.style.height = usableH + 'px'; c.style.flex = 'none'; });
  } else {
    // Host top 55%, two guests 45% split side by side
    const hostH  = Math.floor(usableH * 0.55);
    const guestH = usableH - hostH;
    if (cells[0]) { cells[0].style.width = '100%'; cells[0].style.height = hostH + 'px'; cells[0].style.flex = 'none'; }
    cells.slice(1, 3).forEach(c => { c.style.width = '50%'; c.style.height = guestH + 'px'; c.style.flex = 'none'; });
  }
  // Extra guests: small strip below
  const extra = cells.slice(3);
  if (extra.length > 0) {
    const eH = Math.min(70, Math.floor(usableH * 0.15));
    const eW = (100 / extra.length).toFixed(4) + '%';
    extra.forEach(c => { c.style.width = eW; c.style.height = eH + 'px'; c.style.flex = 'none'; });
  }
}

/* ── Layout 15: Quad Split ── */
function _applyQuadLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;
  const cells      = Array.from(grid.querySelectorAll('.guest-cell'));

  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'wrap';
  grid.style.alignContent  = 'flex-start';
  grid.style.paddingBottom = safeBottom + 'px';

  // First 4 cells: 2×2
  const quadH = Math.floor(usableH / 2);
  cells.slice(0, 4).forEach(c => { c.style.width = '50%'; c.style.height = quadH + 'px'; c.style.flex = 'none'; });
  // Extra cells: equal strip below
  const extra = cells.slice(4);
  if (extra.length > 0) {
    const eH = Math.min(70, usableH - quadH * 2 + Math.floor(usableH * 0.1));
    const eW = (100 / extra.length).toFixed(4) + '%';
    extra.forEach(c => { c.style.width = eW; c.style.height = Math.max(48, eH) + 'px'; c.style.flex = 'none'; });
  }
}

/* ── Layout 26: Stage Mode ── */
function _applyStageLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;
  const hostH      = Math.floor(usableH * 0.65);
  const guestH     = usableH - hostH;
  const hostCell   = grid.querySelector('.host-cell');

  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'wrap';
  grid.style.alignContent  = 'flex-start';
  grid.style.paddingBottom = safeBottom + 'px';

  // Host: centered top area
  if (hostCell) {
    hostCell.style.width     = '60%';
    hostCell.style.height    = hostH + 'px';
    hostCell.style.flex      = 'none';
    hostCell.style.marginLeft = '20%'; // center via margin
  }

  const gW = (100 / guestCount).toFixed(4) + '%';
  grid.querySelectorAll('.guest-cell:not(.host-cell)').forEach(cell => {
    cell.style.width  = gW;
    cell.style.height = guestH + 'px';
    cell.style.flex   = 'none';
    cell.style.marginLeft = ''; // clear any center margin
  });
}

/* ── Layout 21: Podcast Layout ── */
function _applyPodcastLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;
  const isLandscape = stageW >= stageH;
  const total      = guestCount + 1;

  grid.style.flexDirection = isLandscape ? 'row' : 'column';
  grid.style.flexWrap      = 'nowrap';
  grid.style.alignItems    = 'flex-start';
  grid.style.paddingBottom = safeBottom + 'px';

  if (isLandscape) {
    // Equal side-by-side columns
    const w = Math.floor(stageW / total);
    grid.querySelectorAll('.guest-cell').forEach(cell => {
      cell.style.width  = w + 'px';
      cell.style.height = usableH + 'px';
      cell.style.flex   = 'none';
    });
  } else {
    // Stacked portrait rows — host taller
    const hostH  = Math.floor(usableH * 0.5);
    const guestH = Math.floor((usableH - hostH) / guestCount);
    const hostCell = grid.querySelector('.host-cell');
    if (hostCell) { hostCell.style.width = '100%'; hostCell.style.height = hostH + 'px'; hostCell.style.flex = 'none'; }
    grid.querySelectorAll('.guest-cell:not(.host-cell)').forEach(cell => {
      cell.style.width  = '100%';
      cell.style.height = guestH + 'px';
      cell.style.flex   = 'none';
    });
  }
}

/* ── Layout 22: Interview Layout (host left 60%, guest right 40%) ── */
function _applyInterviewLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;
  const hostCell   = grid.querySelector('.host-cell');
  const guestCells = Array.from(grid.querySelectorAll('.guest-cell:not(.host-cell)'));
  const isLandscape = stageW >= stageH;

  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'wrap';
  grid.style.alignContent  = 'flex-start';
  grid.style.paddingBottom = safeBottom + 'px';

  if (isLandscape) {
    const hostW = Math.floor(stageW * 0.55);
    if (hostCell) { hostCell.style.width = hostW + 'px'; hostCell.style.height = usableH + 'px'; hostCell.style.flex = 'none'; }
    const gW = Math.floor((stageW - hostW) / guestCount);
    guestCells.forEach(c => { c.style.width = gW + 'px'; c.style.height = usableH + 'px'; c.style.flex = 'none'; });
  } else {
    const hostH  = Math.floor(usableH * 0.55);
    const guestH = Math.floor((usableH - hostH) / Math.max(1, guestCount));
    if (hostCell) { hostCell.style.width = '100%'; hostCell.style.height = hostH + 'px'; hostCell.style.flex = 'none'; }
    const gW = (100 / guestCount).toFixed(4) + '%';
    guestCells.forEach(c => { c.style.width = gW; c.style.height = guestH + 'px'; c.style.flex = 'none'; });
  }
}

/* ── Layout 23: Gaming Layout ── */
function _applyGamingLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;
  const camH       = Math.max(52, Math.min(120, Math.floor(stageH * 0.15)));
  const camW       = Math.floor(camH * (4 / 3));
  const gap        = 6;
  const hostCell   = grid.querySelector('.host-cell');

  // Host (gameplay) fills the stage
  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = '100%';
    hostCell.style.height   = '100%';
    hostCell.style.zIndex   = '3';
  }

  // Cameras in a row along the bottom-right
  grid.querySelectorAll('.guest-cell:not(.host-cell)').forEach((cell, i) => {
    cell.style.position     = 'absolute';
    cell.style.width        = camW + 'px';
    cell.style.height       = camH + 'px';
    cell.style.right        = (gap + i * (camW + gap)) + 'px';
    cell.style.bottom       = (safeBottom + gap) + 'px';
    cell.style.top          = 'auto';
    cell.style.left         = 'auto';
    cell.style.zIndex       = '7';
    cell.style.borderRadius = '8px';
  });
}

/* ── Layout 19: TikTok Style ── */
function _applyTikTokLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;
  const hostCell   = grid.querySelector('.host-cell');
  const guestCells = Array.from(grid.querySelectorAll('.guest-cell:not(.host-cell)'));

  // Host takes full left half (or full screen on portrait)
  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = guestCount > 0 ? Math.floor(stageW * 0.55) + 'px' : '100%';
    hostCell.style.height   = usableH + 'px';
    hostCell.style.top      = '0';
    hostCell.style.left     = '0';
    hostCell.style.zIndex   = '4';
  }

  // Guests stack vertically in right 45%
  const gW  = Math.floor(stageW * 0.42);
  const gH  = guestCells.length > 0 ? Math.floor(usableH / guestCells.length) : 0;
  guestCells.forEach((cell, i) => {
    cell.style.position = 'absolute';
    cell.style.width    = gW + 'px';
    cell.style.height   = gH + 'px';
    cell.style.right    = '0';
    cell.style.top      = (i * gH) + 'px';
    cell.style.left     = 'auto';
    cell.style.bottom   = 'auto';
    cell.style.zIndex   = '5';
  });
}

/* ── Layout 20: Discord Style ── */
function _applyDiscordLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const thumbH     = Math.max(52, Math.min(96, Math.floor(stageH * 0.12)));
  const thumbW     = Math.floor(thumbH * (4 / 3));
  const gap        = 5;
  const hostCell   = grid.querySelector('.host-cell');

  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = '100%';
    hostCell.style.height   = '100%';
    hostCell.style.zIndex   = '3';
  }

  // Thumbnail strip — centered at top
  const totalW = guestCount * (thumbW + gap) - gap;
  const startX = Math.max(0, Math.floor((stageW - totalW) / 2));
  grid.querySelectorAll('.guest-cell:not(.host-cell)').forEach((cell, i) => {
    cell.style.position     = 'absolute';
    cell.style.width        = thumbW + 'px';
    cell.style.height       = thumbH + 'px';
    cell.style.left         = (startX + i * (thumbW + gap)) + 'px';
    cell.style.top          = gap + 'px';
    cell.style.right        = 'auto';
    cell.style.bottom       = 'auto';
    cell.style.zIndex       = '6';
    cell.style.borderRadius = '8px';
  });
}

/* ── Layout 27: Diamond Layout ── */
function _applyDiamondLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const cx         = stageW / 2;
  const cy         = (stageH - safeBottom) / 2;
  const tileSize   = Math.max(60, Math.min(160, Math.floor(Math.min(stageW, stageH) * 0.22)));
  const spacing    = Math.max(tileSize + 10, Math.floor(Math.min(stageW, stageH - safeBottom) * 0.35));

  // Positions for diamond pattern: top, left, right, bottom, center, then ring
  const positions = [
    [cx, cy - spacing],               // top
    [cx - spacing, cy],               // left
    [cx + spacing, cy],               // right
    [cx, cy + spacing * 0.8],         // bottom (above safe zone)
    [cx - spacing / 2, cy - spacing / 2], // upper-left
    [cx + spacing / 2, cy - spacing / 2], // upper-right
    [cx - spacing / 2, cy + spacing / 2], // lower-left
    [cx + spacing / 2, cy + spacing / 2], // lower-right
    [cx, cy],                         // center
  ];

  const allCells = Array.from(grid.querySelectorAll('.guest-cell'));
  allCells.forEach((cell, i) => {
    const pos = positions[i] || [cx, cy];
    const clampedY = Math.min(pos[1], stageH - safeBottom - tileSize - 4);
    cell.style.position = 'absolute';
    cell.style.width    = tileSize + 'px';
    cell.style.height   = tileSize + 'px';
    cell.style.left     = (pos[0] - tileSize / 2) + 'px';
    cell.style.top      = (clampedY - tileSize / 2) + 'px';
    cell.style.zIndex   = '5';
  });
}

/* ── Layout 28: Corner Layout ── */
function _applyCornerLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const tileW      = Math.max(80, Math.min(180, Math.floor(stageW * 0.22)));
  const tileH      = Math.floor(tileW * 0.75);
  const gap        = 8;
  const hostCell   = grid.querySelector('.host-cell');

  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = '100%';
    hostCell.style.height   = '100%';
    hostCell.style.zIndex   = '3';
  }

  // Four corners: TL, TR, BL, BR, then middle-edges
  const corners = [
    { left: gap,                              top: gap,                    right: 'auto', bottom: 'auto' },
    { right: gap,                             top: gap,                    left: 'auto',  bottom: 'auto' },
    { left: gap,                              bottom: safeBottom + gap,    right: 'auto', top: 'auto'    },
    { right: gap,                             bottom: safeBottom + gap,    left: 'auto',  top: 'auto'    },
    { left: Math.floor(stageW / 2 - tileW / 2), top: gap,                  right: 'auto', bottom: 'auto' },
    { left: Math.floor(stageW / 2 - tileW / 2), bottom: safeBottom + gap,  right: 'auto', top: 'auto'    },
    { left: gap, top: Math.floor((stageH - safeBottom) / 2 - tileH / 2),   right: 'auto', bottom: 'auto' },
    { right: gap, top: Math.floor((stageH - safeBottom) / 2 - tileH / 2),  left: 'auto',  bottom: 'auto' },
  ];

  grid.querySelectorAll('.guest-cell:not(.host-cell)').forEach((cell, i) => {
    const pos = corners[i % corners.length];
    cell.style.position = 'absolute';
    cell.style.width    = tileW + 'px';
    cell.style.height   = tileH + 'px';
    cell.style.left     = typeof pos.left   === 'number' ? pos.left + 'px'   : pos.left;
    cell.style.right    = typeof pos.right  === 'number' ? pos.right + 'px'  : pos.right;
    cell.style.top      = typeof pos.top    === 'number' ? pos.top + 'px'    : pos.top;
    cell.style.bottom   = typeof pos.bottom === 'number' ? pos.bottom + 'px' : pos.bottom;
    cell.style.zIndex   = '6';
  });
}

/* ── Layout 29: Sidebar Layout ── */
function _applySidebarLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;
  const sideW      = Math.min(200, Math.floor(stageW * 0.28));
  const hostCell   = grid.querySelector('.host-cell');
  const guestCells = Array.from(grid.querySelectorAll('.guest-cell:not(.host-cell)'));

  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'nowrap';
  grid.style.alignItems    = 'flex-start';
  grid.style.paddingBottom = safeBottom + 'px';
  grid.style.paddingLeft   = sideW + 'px'; // leave room for chat sidebar (CSS-positioned)

  if (hostCell) {
    hostCell.style.flex   = '1';
    hostCell.style.height = usableH + 'px';
  }

  const gH = Math.floor(usableH / Math.max(1, guestCells.length));
  guestCells.forEach(c => {
    c.style.width  = Math.floor(stageW * 0.22) + 'px';
    c.style.height = gH + 'px';
    c.style.flex   = 'none';
  });
}

/* ── Layout 30: Drag-and-Drop Layout ── */
function _applyDragLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const stageH     = grid.offsetHeight || window.innerHeight;
  const safeBottom = _getUISafeBottom(stageH);
  const usableH    = stageH - safeBottom;
  const tileW      = Math.max(80, Math.min(200, Math.floor(stageW * 0.25)));
  const tileH      = Math.floor(tileW * 0.75);
  const gap        = 10;
  const hostCell   = grid.querySelector('.host-cell');

  // Host fills stage
  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = '100%';
    hostCell.style.height   = '100%';
    hostCell.style.zIndex   = '3';
  }

  // Place each guest at its saved drag position, or default cascade
  let i = 0;
  grid.querySelectorAll('.guest-cell:not(.host-cell)').forEach(cell => {
    const uid  = cell.dataset.uid;
    const saved = uid && _dragPositions[uid];
    const defLeft = gap + (i % 3) * (tileW + gap);
    const defTop  = gap + Math.floor(i / 3) * (tileH + gap);
    const clampedTop = Math.min(defTop, usableH - tileH - gap);

    cell.style.position = 'absolute';
    cell.style.width    = tileW + 'px';
    cell.style.height   = tileH + 'px';
    cell.style.left     = (saved ? saved.left : defLeft) + 'px';
    cell.style.top      = (saved ? saved.top  : clampedTop) + 'px';
    cell.style.right    = 'auto';
    cell.style.bottom   = 'auto';
    cell.style.zIndex   = '6';
    cell.style.cursor   = 'grab';

    // Ensure drag hint tooltip element exists
    if (!cell.querySelector('.guest-cell-drag-hint')) {
      const hint = document.createElement('div');
      hint.className = 'guest-cell-drag-hint';
      hint.textContent = 'Drag to move';
      cell.appendChild(hint);
    }

    // Attach drag listener once
    if (!cell._dragAttached) {
      cell._dragAttached = true;
      cell.addEventListener('pointerdown', _onDragStart, { passive: false });
    }
    i++;
  });
}

/* ═════════════════════════════════════════════════════════════════
   SMART FEATURES
   ═════════════════════════════════════════════════════════════════ */

/* ── Speaker Detection: poll audio levels of all peer connections ── */
function _startSpeakerDetection() {
  if (_speakerCheckInterval) return; // already running
  _speakerCheckInterval = setInterval(_checkActiveSpeaker, 1200);
}

function _stopSpeakerDetection() {
  if (_speakerCheckInterval) {
    clearInterval(_speakerCheckInterval);
    _speakerCheckInterval = null;
  }
}

async function _checkActiveSpeaker() {
  if (!D.guestGrid || _guestLayout !== 'speaker') {
    _stopSpeakerDetection();
    return;
  }

  let maxLevel = 0;
  let loudestUid = null;

  // Check each guest peer connection audio levels
  for (const [uid, peer] of Object.entries(_guestPeers || {})) {
    if (!peer.pc) continue;
    try {
      const stats = await peer.pc.getStats();
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          const level = report.audioLevel || 0;
          if (level > maxLevel) { maxLevel = level; loudestUid = uid; }
        }
      });
    } catch (_) {}
  }

  // Check host's own audio if we're the creator
  if (_mode === 'creator' && _localStream) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = ctx.createAnalyser();
      const src = ctx.createMediaStreamSource(_localStream);
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(data);
      const peak = Math.max(...data) / 128 - 1;
      ctx.close();
      if (Math.abs(peak) > maxLevel) { maxLevel = Math.abs(peak); loudestUid = 'host'; }
    } catch (_) {}
  }

  const newSpeaker = loudestUid && maxLevel > 0.02 ? loudestUid : (_speakerUid || 'host');
  if (newSpeaker !== _speakerUid) {
    _speakerUid = newSpeaker;
    _updateSpeakerHighlight();
    _applyGuestLayout(); // re-layout so speaker cell gets promoted
  }
}

function _updateSpeakerHighlight() {
  if (!D.guestGrid) return;
  D.guestGrid.querySelectorAll('.guest-cell').forEach(cell => {
    const uid = cell.dataset.uid;
    const isActive = (uid === _speakerUid) || (_speakerUid === 'host' && cell.classList.contains('host-cell'));
    cell.classList.toggle('speaker-active', isActive);

    // Speaker badge
    let badge = cell.querySelector('.guest-cell-speaker-badge');
    if (isActive) {
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'guest-cell-speaker-badge';
        badge.textContent = 'Speaking';
        cell.appendChild(badge);
      }
    } else {
      if (badge) badge.remove();
    }
  });
}

/* ── Sidebar body class helper ── */
function _applySidebarBodyClass() {
  document.body.classList.toggle('layout-sidebar', _guestLayout === 'sidebar');
}

/* ── Drag-and-Drop event handlers ── */
function _onDragStart(e) {
  if (_guestLayout !== 'drag') return;
  const cell = e.currentTarget;
  const rect = cell.getBoundingClientRect();
  const gridRect = D.guestGrid.getBoundingClientRect();

  _dragState = {
    cell,
    startClientX: e.clientX,
    startClientY: e.clientY,
    origLeft: rect.left - gridRect.left,
    origTop:  rect.top  - gridRect.top,
  };

  cell.style.cursor  = 'grabbing';
  cell.style.zIndex  = '20';
  cell.setPointerCapture(e.pointerId);

  cell.addEventListener('pointermove', _onDragMove, { passive: false });
  cell.addEventListener('pointerup',   _onDragEnd);
  e.preventDefault();
}

function _onDragMove(e) {
  if (!_dragState) return;
  const { cell, startClientX, startClientY, origLeft, origTop } = _dragState;
  const grid     = D.guestGrid;
  const stageW   = grid.offsetWidth;
  const stageH   = grid.offsetHeight;
  const safeBot  = _getUISafeBottom(stageH);
  const newLeft  = origLeft + (e.clientX - startClientX);
  const newTop   = origTop  + (e.clientY - startClientY);
  const maxLeft  = stageW - cell.offsetWidth;
  const maxTop   = stageH - safeBot - cell.offsetHeight;

  const clampedLeft = Math.max(0, Math.min(maxLeft, newLeft));
  const clampedTop  = Math.max(0, Math.min(maxTop,  newTop));

  cell.style.left = clampedLeft + 'px';
  cell.style.top  = clampedTop  + 'px';
  e.preventDefault();
}

function _onDragEnd(e) {
  if (!_dragState) return;
  const { cell } = _dragState;
  cell.style.cursor = 'grab';
  cell.style.zIndex = '6';

  // Persist position
  const uid = cell.dataset.uid;
  if (uid) {
    _dragPositions[uid] = {
      left: parseFloat(cell.style.left) || 0,
      top:  parseFloat(cell.style.top)  || 0,
    };
  }

  cell.removeEventListener('pointermove', _onDragMove);
  cell.removeEventListener('pointerup',   _onDragEnd);
  _dragState = null;
}

/* ── Save / Load favourite layout ── */
const _LS_KEY_LAYOUT   = 'snx_fav_layout';
const _LS_KEY_BOXSIZE  = 'snx_fav_boxsize';

function _saveLayoutFavourite() {
  _savedLayout  = _guestLayout;
  _savedBoxSize = _guestBoxSize;
  try {
    localStorage.setItem(_LS_KEY_LAYOUT,  _savedLayout);
    localStorage.setItem(_LS_KEY_BOXSIZE, _savedBoxSize);
  } catch (_) {}
  toast('Layout saved ★');
  _refreshLoadBtn();
}

function _loadLayoutFavourite() {
  const layout  = _savedLayout  || localStorage.getItem(_LS_KEY_LAYOUT);
  const boxSize = _savedBoxSize || localStorage.getItem(_LS_KEY_BOXSIZE);
  if (!layout) { toast('No saved layout yet'); return; }

  _guestLayout  = layout;
  _guestBoxSize = boxSize || 'sm';

  // Sync active state in panel
  document.querySelectorAll('.layout-option-btn').forEach(b => b.classList.toggle('active', b.dataset.layout === _guestLayout));
  document.querySelectorAll('.layout-size-btn').forEach(b => b.classList.toggle('active', b.dataset.size === _guestBoxSize));

  _applyGuestLayout();
  _broadcastLayout();
  _applySidebarBodyClass();
  toast('Favourite layout loaded');
}

function _refreshLoadBtn() {
  const btn = document.getElementById('btnLoadLayout');
  if (!btn) return;
  const has = !!(localStorage.getItem(_LS_KEY_LAYOUT));
  btn.classList.toggle('has-saved', has);
  btn.title = has ? `Load saved: ${localStorage.getItem(_LS_KEY_LAYOUT)}` : 'No saved layout';
}

/* ── Restore saved layout preference on page load ──
   Only 'host-full' and 'host-full-left' are supported now.
   Any other legacy saved value is remapped to 'host-full'. */
(function _restoreLayoutPreference() {
  try {
    const l = localStorage.getItem(_LS_KEY_LAYOUT);
    const s = localStorage.getItem(_LS_KEY_BOXSIZE);
    if (l) {
      const validLayouts = ['host-full', 'host-full-left'];
      const mapped = validLayouts.includes(l) ? l : 'host-full';
      _guestLayout  = mapped;
      _savedLayout  = mapped;
      _savedBoxSize = s || 'sm';
    }
  } catch (_) {}
})();

/* ── Update the guest count indicator inside the layout panel ── */
function _updateLayoutPanelCounter(guestCount) {
  const el = document.getElementById('_guestCountIndicator');
  if (el) {
    el.textContent = `${guestCount} / ${_MAX_GUESTS} guest${guestCount === 1 ? '' : 's'}`;
    el.style.color = guestCount >= _MAX_GUESTS ? '#ff6677' : '#00AEEF';
  }
}

/* ── Toggle layout panel ── */
function _toggleLayoutPanel() {
  _layoutPanelOpen ? _closeLayoutPanel() : _openLayoutPanel();
}

function _openLayoutPanel() {
  if (!D.layoutSettingsPanel) return;
  D.layoutSettingsPanel.style.display = 'block';
  _layoutPanelOpen = true;
  if (D.btnLayoutSettings) D.btnLayoutSettings.classList.add('has-guests');
  // Refresh counter whenever panel opens
  const guestCount = _mode === 'creator'
    ? Object.keys(_guestPeers).length
    : parseInt(D.guestGrid?.dataset.count || '0', 10);
  _updateLayoutPanelCounter(guestCount);
}

function _closeLayoutPanel() {
  if (!D.layoutSettingsPanel) return;
  D.layoutSettingsPanel.style.display = 'none';
  _layoutPanelOpen = false;
}

/* ═══════════════════════════════════════════════════════════════════
   LIVE TIMER
   — Tracks how long the live has been running.
   — Controlled by the host via the Settings panel toggle.
   — Displays in the top bar (host only).
   ═══════════════════════════════════════════════════════════════════ */

let _liveTimerEnabled  = false;   // host's preference (ON/OFF toggle)
let _liveTimerInterval = null;    // setInterval handle
let _liveTimerStart    = 0;       // Date.now() when live started

function _liveTimerSetEnabled(on) {
  _liveTimerEnabled = on;
  const badge = document.getElementById('liveTimerDisplay');
  if (!badge) return;
  if (on) {
    badge.classList.add('visible');
    // If the live is already running, start counting.
    // If _liveTimerStart was never set (live started before timer was enabled),
    // initialize it now so the counter starts from 0 rather than showing a huge number.
    if (_roomId) {
      if (!_liveTimerStart) _liveTimerStart = Date.now();
      _liveTimerRun();
    }
  } else {
    badge.classList.remove('visible');
    if (_liveTimerInterval) { clearInterval(_liveTimerInterval); _liveTimerInterval = null; }
    const txt = document.getElementById('liveTimerText');
    if (txt) txt.textContent = '00:00:00';
  }
}

function _liveTimerOnLiveStart() {
  _liveTimerStart = Date.now();
  if (_liveTimerEnabled) _liveTimerRun();
}

function _liveTimerOnLiveEnd() {
  if (_liveTimerInterval) { clearInterval(_liveTimerInterval); _liveTimerInterval = null; }
  const badge = document.getElementById('liveTimerDisplay');
  if (badge) badge.classList.remove('visible');
  const txt = document.getElementById('liveTimerText');
  if (txt) txt.textContent = '00:00:00';
}

function _liveTimerRun() {
  if (_liveTimerInterval) clearInterval(_liveTimerInterval);
  const txt = document.getElementById('liveTimerText');
  if (!txt) return;

  const tick = () => {
    const secs = Math.floor((Date.now() - _liveTimerStart) / 1000);
    const h    = Math.floor(secs / 3600);
    const m    = Math.floor((secs % 3600) / 60);
    const s    = secs % 60;
    txt.textContent =
      String(h).padStart(2, '0') + ':' +
      String(m).padStart(2, '0') + ':' +
      String(s).padStart(2, '0');
  };
  tick();
  _liveTimerInterval = setInterval(tick, 1000);
}


/* ═══════════════════════════════════════════════════════════════════
   AI SAFETY SYSTEM
   — Monitors incoming live chat from Firestore in real time.
   — Detects spam, harassment, threats, hate speech, doxxing.
   — Shows a PRIVATE popup to the host only.
   — Host chooses: Ignore / Warn user / Remove comment / Remove guest.
   — Does NOT auto-punish users without host approval.
   — Completely separate from the existing client-side send-time scanner.
   ═══════════════════════════════════════════════════════════════════ */

let _aiSafetyEnabled   = false;    // host toggle
let _aiSafetyChatUnsub = null;     // Firestore listener handle
let _aiSafetySeenIds   = new Set(); // already-processed message IDs

/* Enable / disable the system */
function _aiSafetySetEnabled(on) {
  _aiSafetyEnabled = on;
  const badge = document.getElementById('aiSafetyBadge');
  if (badge) badge.classList.toggle('visible', on);
  if (on) {
    if (_roomId) _aiSafetyStartMonitor();
  } else {
    _aiSafetyStopMonitor();
  }
}

/* Called when live starts — starts monitor if already enabled */
function _aiSafetyOnLiveStart() {
  if (_aiSafetyEnabled && _roomId) _aiSafetyStartMonitor();
}

/* Called when live ends — clean up */
function _aiSafetyOnLiveEnd() {
  _aiSafetyStopMonitor();
  _aiSafetySeenIds.clear();
  const badge = document.getElementById('aiSafetyBadge');
  if (badge) badge.classList.remove('visible');
}

function _aiSafetyStopMonitor() {
  if (_aiSafetyChatUnsub) {
    try { _aiSafetyChatUnsub(); } catch(_) {}
    _aiSafetyChatUnsub = null;
  }
}

function _aiSafetyStartMonitor() {
  _aiSafetyStopMonitor();
  if (!_roomId || _mode !== 'creator') return;

  // Subscribe to live messages — last 50, ordered newest last
  // We only alert on messages we haven't seen yet (added after system enabled)
  const messagesRef = collection(_db, 'liveRooms', _roomId, 'liveMessages');
  const q = query(messagesRef, orderBy('createdAt', 'desc'), limit(50));

  let _firstSnapshot = true;

  _aiSafetyChatUnsub = onSnapshot(q, snap => {
    // Skip the very first snapshot (historical messages already on screen)
    if (_firstSnapshot) {
      _firstSnapshot = false;
      // Seed seen IDs so we don't alert on any existing messages
      snap.docs.forEach(d => _aiSafetySeenIds.add(d.id));
      return;
    }

    snap.docChanges().forEach(change => {
      if (change.type !== 'added') return;
      const docId = change.doc.id;
      if (_aiSafetySeenIds.has(docId)) return;
      _aiSafetySeenIds.add(docId);

      const data = change.doc.data();
      // Skip system messages and own messages
      if (data.type === 'system') return;
      if (data.userId === _user?.uid) return;

      const hit = _liveScanText(data.text || '');
      if (!hit) return;

      // Show private warning popup to host
      _aiSafetyShowWarning(hit, data, docId);
    });
  }, () => {});
}

/* Show the private warning popup to the host */
function _aiSafetyShowWarning(rule, msgData, docId) {
  // Don't stack: dismiss existing one first
  const old = document.getElementById('_snxSafetyOverlay');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.id = '_snxSafetyOverlay';
  overlay.className = 'snx-safety-overlay';

  const userName  = msgData.userName || 'Unknown User';
  const msgText   = msgData.text     || '';
  const msgUserId = msgData.userId   || '';

  // Severity icon
  const icon = rule.severity === 'block' ? '🚫' : '⚠️';

  overlay.innerHTML = `
    <div class="snx-safety-box">
      <div class="snx-safety-header">
        <div class="snx-safety-icon">${icon}</div>
        <div class="snx-safety-title-block">
          <div class="snx-safety-title">AI Safety Alert</div>
          <div class="snx-safety-category">${rule.category} · ${rule.severity === 'block' ? 'High Risk' : 'Warning'}</div>
        </div>
      </div>
      <div class="snx-safety-body">
        <div class="snx-safety-label">Flagged Message</div>
        <div class="snx-safety-text">${_escapeHtml(msgText)}</div>
      </div>
      <div class="snx-safety-user-row">
        <span style="font-size:16px">👤</span>
        <div class="snx-safety-user-name">${_escapeHtml(userName)}</div>
        <span style="font-size:10px;color:#4a7a9a;">user</span>
      </div>
      <div class="snx-safety-actions">
        <button class="snx-safety-btn snx-safety-btn-ignore" data-action="ignore">Ignore</button>
        <button class="snx-safety-btn snx-safety-btn-warn"   data-action="warn">Warn User</button>
        <button class="snx-safety-btn snx-safety-btn-del"    data-action="delete">Remove Comment</button>
        <button class="snx-safety-btn snx-safety-btn-kick"   data-action="kick">Remove Guest</button>
      </div>
    </div>
  `;

  overlay.querySelectorAll('.snx-safety-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      overlay.remove();
      const action = btn.dataset.action;

      if (action === 'ignore') {
        // Host chose to ignore — no action
        return;
      }

      if (action === 'warn') {
        // Send a system warning message visible to everyone in chat
        try {
          await addDoc(collection(_db, 'liveRooms', _roomId, 'liveMessages'), {
            userId:    _user.uid,
            userName:  'Safety Bot',
            text:      `⚠️ Please keep the community safe and respectful.`,
            type:      'system',
            createdAt: serverTimestamp(),
          });
        } catch(_) {}
        toast('⚠️ Warning sent to chat.');
        return;
      }

      if (action === 'delete') {
        // Delete the flagged message from Firestore
        try {
          await deleteDoc(doc(_db, 'liveRooms', _roomId, 'liveMessages', docId));
          toast('🗑 Comment removed.');
        } catch(_) {
          toast('Could not remove comment.');
        }
        return;
      }

      if (action === 'kick') {
        // Host must confirm before removing a guest
        if (!msgUserId) { toast('Cannot identify user to remove.'); return; }
        const confirmed = await _snxConfirm({
          icon:    '🚫',
          title:   `Remove ${userName} from this live?`,
          sub:     `They will be disconnected and cannot rejoin. This action cannot be undone.`,
          okLabel: 'Remove',
          okClass: '',
        });
        if (!confirmed) return;

        // Remove from guest boxes if present
        if (_guestPeers[msgUserId]) {
          _hostDoRemoveGuest(msgUserId);
        }
        // Delete the flagged message as well
        try {
          await deleteDoc(doc(_db, 'liveRooms', _roomId, 'liveMessages', docId));
        } catch(_) {}
        toast('🚫 Guest removed.');
      }
    });
  });

  document.body.appendChild(overlay);

  // Auto-dismiss after 30 s if host doesn't respond
  setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 30000);
}

/* Tiny HTML escape for user content injected into innerHTML */
function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


/* ═══════════════════════════════════════════════════════════════════
   SHADOW BOT ASSISTANT
   — Friendly welcome and positive messages.
   — Completely separate from AI Safety System.
   — Posts as a "Shadow Bot" system message to live chat.
   — Limits: max 2 messages per hour. Only during active live.
   ═══════════════════════════════════════════════════════════════════ */

let _shadowBotEnabled      = false;    // host toggle
let _shadowBotTimer1       = null;     // first message timer
let _shadowBotTimer2       = null;     // second message timer (if needed)
let _shadowBotMsgCount     = 0;        // messages sent this hour window
let _shadowBotHourReset    = null;     // hourly counter reset timer
let _shadowBotActive       = false;    // true only when live is running

const _SHADOW_BOT_MESSAGES = [
  'Welcome to Shadow Nexus Live! 🌑',
  'Thanks for being here — keep the chat positive! ✨',
  'Great to see everyone here on Shadow Nexus Live! 🔴',
  "You're all amazing — thanks for watching! 🙌",
  'This live is powered by the Shadow Nexus community. Welcome! 💙',
  'Enjoying the stream? Share it with a friend! 📤',
];

function _shadowBotSetEnabled(on) {
  _shadowBotEnabled = on;
  const badge = document.getElementById('shadowBotBadge');
  if (badge) badge.classList.toggle('visible', on);
  if (on) {
    if (_shadowBotActive) _shadowBotSchedule();
  } else {
    _shadowBotClearTimers();
  }
}

function _shadowBotOnLiveStart() {
  _shadowBotActive   = true;
  _shadowBotMsgCount = 0;
  if (_shadowBotEnabled) _shadowBotSchedule();
}

function _shadowBotOnLiveEnd() {
  _shadowBotActive = false;
  _shadowBotClearTimers();
  const badge = document.getElementById('shadowBotBadge');
  if (badge) badge.classList.remove('visible');
}

function _shadowBotClearTimers() {
  if (_shadowBotTimer1)    { clearTimeout(_shadowBotTimer1);    _shadowBotTimer1    = null; }
  if (_shadowBotTimer2)    { clearTimeout(_shadowBotTimer2);    _shadowBotTimer2    = null; }
  if (_shadowBotHourReset) { clearTimeout(_shadowBotHourReset); _shadowBotHourReset = null; }
}

function _shadowBotSchedule() {
  _shadowBotClearTimers();
  if (!_shadowBotEnabled || !_shadowBotActive || !_roomId || _mode !== 'creator') return;

  // First message: 45–75 seconds after live starts (or bot is enabled)
  const delay1 = 45000 + Math.random() * 30000;   // 45–75 s
  // Second message: 30–40 minutes later
  const delay2 = delay1 + (30 * 60 * 1000) + Math.random() * (10 * 60 * 1000);

  _shadowBotTimer1 = setTimeout(() => _shadowBotPost(), delay1);

  // Only schedule second message if we haven't hit the hourly cap
  _shadowBotTimer2 = setTimeout(() => {
    if (_shadowBotMsgCount < 2) _shadowBotPost();
  }, delay2);

  // Reset counter every 60 minutes so the bot can post again next hour
  _shadowBotHourReset = setTimeout(() => {
    _shadowBotMsgCount = 0;
    if (_shadowBotEnabled && _shadowBotActive) _shadowBotSchedule();
  }, 60 * 60 * 1000);
}

async function _shadowBotPost() {
  if (!_shadowBotEnabled || !_shadowBotActive || !_roomId || _mode !== 'creator') return;
  if (_shadowBotMsgCount >= 2) return;   // hard cap: max 2 per hour

  _shadowBotMsgCount++;

  // Pick a random message, avoid repeating the last one
  const msg = _SHADOW_BOT_MESSAGES[
    Math.floor(Math.random() * _SHADOW_BOT_MESSAGES.length)
  ];

  try {
    await addDoc(collection(_db, 'liveRooms', _roomId, 'liveMessages'), {
      userId:    'shadow_bot',
      userName:  'Shadow Bot',
      text:      msg,
      type:      'system',
      createdAt: serverTimestamp(),
    });
  } catch(_) {}
}


/* ═══════════════════════════════════════════════════════════════════
   AUTOMATIC INTERNET QUALITY
   — Host-only feature.  Separate from existing adaptive quality.
   — Detects connection type via Network Information API.
   — Monitors upload packet-loss, latency (RTT), and buffering every 8 s.
   — Maps network conditions to four tiers: Excellent / Good / Fair / Poor.
   — Adjusts bitrate + resolution on the outbound video sender.
   — Shows a top-bar badge and toasts the host when tier changes.
   — Prevents disconnection by pre-emptively reducing quality.
   — Auto-recovers when conditions improve.
   — Does NOT touch chat, posts, comments, Firebase, or viewer code.
   ═══════════════════════════════════════════════════════════════════ */

// ── State ────────────────────────────────────────────────────────────
let _iqEnabled       = false;    // toggled by the host
let _iqLiveActive    = false;    // true only while stream is running
let _iqTimer         = null;     // monitoring interval handle
let _iqCurrentTier   = null;     // 'excellent' | 'good' | 'fair' | 'poor'
let _iqUpgradePending = false;   // hysteresis: require two good reads to upgrade
let _iqPrevSent      = 0;
let _iqPrevLost      = 0;
let _iqPrevBytes     = 0;
let _iqPrevTs        = 0;

// ── Quality tiers ────────────────────────────────────────────────────
// Each tier: { id, label, icon, maxBitrate (bps), scaleDown, lossMax, rttMax }
const _IQ_TIERS = {
  excellent: { id: 'excellent', label: '1080p',   icon: '📶', maxBitrate: 5_500_000, scaleDown: 1,   lossMax: 0.02, rttMax: 80  },
  good:      { id: 'good',      label: '720p',    icon: '📶', maxBitrate: 3_000_000, scaleDown: 1,   lossMax: 0.08, rttMax: 150 },
  fair:      { id: 'fair',      label: '480p',    icon: '📶', maxBitrate: 1_200_000, scaleDown: 1.5, lossMax: 0.18, rttMax: 300 },
  poor:      { id: 'poor',      label: '360p',    icon: '⚠️', maxBitrate:   550_000, scaleDown: 2.5, lossMax: 1,    rttMax: Infinity },
};

// ── Network type → initial tier hint ─────────────────────────────────
const _IQ_TYPE_HINT = { '5g': 'excellent', '4g': 'good', 'wifi': 'good', 'ethernet': 'excellent' };

// ── Public lifecycle hooks ───────────────────────────────────────────

function _iqSetEnabled(on) {
  _iqEnabled = on;
  if (!on) {
    _iqStop();
    _iqHideBadge();
    return;
  }
  // If live is already running, start on the first active viewer peer.
  if (_iqLiveActive) {
    const firstPeer = Object.values(_creatorViewerPeers)[0];
    if (firstPeer && firstPeer.pc) _iqStart(firstPeer.pc);
  }
}

function _iqOnLiveStart() {
  _iqLiveActive = true;
  // Per-viewer adaptive quality already starts in _handleViewerConnection;
  // if IQ is enabled, also start the badge monitor on the first peer.
  if (_iqEnabled) {
    const firstPeer = Object.values(_creatorViewerPeers)[0];
    if (firstPeer && firstPeer.pc) _iqStart(firstPeer.pc);
  }
}

function _iqOnLiveEnd() {
  _iqLiveActive = false;
  _iqStop();
  _iqHideBadge();
}


/* ═══════════════════════════════════════════════════════════════════
   COMPACT CONTROLS  (creator only)
   When enabled: bottom bar shrinks and buttons use smaller size.
   Preference is saved to localStorage so it persists across sessions.
   ═══════════════════════════════════════════════════════════════════ */
function _setCompactControls(on) {
  if (on) {
    document.body.classList.add('controls-compact');
  } else {
    document.body.classList.remove('controls-compact');
  }
  try { localStorage.setItem('snx_compact_controls', on ? '1' : '0'); } catch(_) {}
  // Re-run layout so guest grid safe-zone updates
  _applyGuestLayout();
}

// Restore preference on load
(function() {
  try {
    const saved = localStorage.getItem('snx_compact_controls');
    if (saved === '1') {
      document.body.classList.add('controls-compact');
      const chk = document.getElementById('toggleCompactControls');
      if (chk) chk.checked = true;
    }
  } catch(_) {}
})();


// ── Core: start monitoring ───────────────────────────────────────────

function _iqStart(pc) {
  if (_iqTimer) return; // already running

  // Detect initial tier from Network Information API if available
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) {
    const etype = (conn.effectiveType || '').toLowerCase(); // 'slow-2g'|'2g'|'3g'|'4g'
    const type  = (conn.type || '').toLowerCase();          // 'wifi'|'cellular'|'ethernet'|…
    let hint = null;
    if (type === 'ethernet' || type === 'wifi') {
      hint = conn.downlink >= 10 ? 'excellent' : 'good';
    } else if (etype === '4g') {
      hint = 'good';
    } else if (etype === '3g') {
      hint = 'fair';
    } else if (etype === '2g' || etype === 'slow-2g') {
      hint = 'poor';
    }
    if (hint) _iqApplyTier(pc, hint, false);
  }

  // Reset counters
  _iqPrevSent  = 0;
  _iqPrevLost  = 0;
  _iqPrevBytes = 0;
  _iqPrevTs    = 0;
  _iqUpgradePending = false;

  _iqTimer = setInterval(() => _iqTick(pc), 8_000);

  // Also listen for connection-type changes
  if (conn) {
    conn.addEventListener('change', () => _iqOnConnectionChange(pc));
  }
}

// ── Monitoring tick (runs every 8 s) ─────────────────────────────────

async function _iqTick(pc) {
  if (!pc || pc.connectionState !== 'connected') return;
  if (!_iqEnabled || !_iqLiveActive) return;

  try {
    const stats = await pc.getStats();

    let sent  = 0, lost  = 0, bytes = 0, rtt = 0, rttCount = 0;
    let roundTripMs = null;

    stats.forEach(r => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') {
        sent  += r.packetsSent  || 0;
        lost  += r.packetsLost  || 0;
        bytes += r.bytesSent    || 0;
      }
      if (r.type === 'remote-inbound-rtp' && r.kind === 'video') {
        if (r.roundTripTime != null) { rtt += r.roundTripTime; rttCount++; }
      }
      // candidate-pair for RTT fallback
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
        if (!rttCount) { rtt = r.currentRoundTripTime; rttCount = 1; }
      }
    });

    const now      = Date.now();
    const deltaSent = sent  - _iqPrevSent;
    const deltaLost = lost  - _iqPrevLost;
    const deltaBytes = bytes - _iqPrevBytes;
    const deltaSec   = _iqPrevTs ? (now - _iqPrevTs) / 1000 : 8;

    _iqPrevSent  = sent;
    _iqPrevLost  = lost;
    _iqPrevBytes = bytes;
    _iqPrevTs    = now;

    if (deltaSent < 5) return; // too few packets to be meaningful

    const lossRate = Math.max(0, deltaLost) / deltaSent;
    const kbps     = (deltaBytes * 8 / 1000) / deltaSec;
    roundTripMs    = rttCount ? (rtt / rttCount) * 1000 : null;

    const targetTier = _iqPickTier(lossRate, roundTripMs, kbps);
    _iqMaybeChangeTier(pc, targetTier, lossRate, roundTripMs);

  } catch(_) {}
}

// ── Pick the best tier based on current network metrics ──────────────

function _iqPickTier(lossRate, rttMs, kbps) {
  const rtt = rttMs != null ? rttMs : 0;
  if (lossRate <= _IQ_TIERS.excellent.lossMax && rtt <= _IQ_TIERS.excellent.rttMax && kbps >= 4000) return 'excellent';
  if (lossRate <= _IQ_TIERS.good.lossMax      && rtt <= _IQ_TIERS.good.rttMax      && kbps >= 1500) return 'good';
  if (lossRate <= _IQ_TIERS.fair.lossMax      && rtt <= _IQ_TIERS.fair.rttMax      && kbps >= 600)  return 'fair';
  return 'poor';
}

// ── Change-tier logic with hysteresis ────────────────────────────────

function _iqMaybeChangeTier(pc, targetTier, lossRate, rttMs) {
  const order = ['excellent', 'good', 'fair', 'poor'];
  const curIdx = order.indexOf(_iqCurrentTier ?? 'good');
  const tarIdx = order.indexOf(targetTier);

  if (tarIdx === curIdx) { _iqUpgradePending = false; return; }

  if (tarIdx > curIdx) {
    // Degrading → apply immediately (protect stream first)
    _iqUpgradePending = false;
    _iqApplyTier(pc, targetTier, true);
  } else {
    // Improving → require two consecutive good reads (hysteresis)
    if (!_iqUpgradePending) {
      _iqUpgradePending = true;
      return;
    }
    _iqUpgradePending = false;
    // Improve one step at a time
    const nextTier = order[curIdx - 1];
    _iqApplyTier(pc, nextTier, true);
  }
}

// ── Apply a quality tier to the sender ───────────────────────────────

async function _iqApplyTier(pc, tierId, notify) {
  if (_iqCurrentTier === tierId) return;
  const prev = _iqCurrentTier;
  _iqCurrentTier = tierId;
  const tier = _IQ_TIERS[tierId];

  // Apply to the video sender
  try {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate            = tier.maxBitrate;
      params.encodings[0].scaleResolutionDownBy = tier.scaleDown;
      await sender.setParameters(params).catch(() => {});
    }
  } catch(_) {}

  // Also align the existing adaptive-quality module's tier index so they don't fight
  const legacyMap = { excellent: 0, good: 1, fair: 2, poor: 3 };
  _adaptiveQualityTierIdx = legacyMap[tierId] ?? 1;

  _iqShowBadge(tierId, tier);
  if (notify && prev !== null) _iqNotify(prev, tierId, tier);

  console.log(`[IQ] → ${tierId.toUpperCase()} (${tier.label} / ${tier.maxBitrate/1000} kbps)`);
}

// ── Handle Network Information API change event ───────────────────────

function _iqOnConnectionChange(pc) {
  if (!_iqEnabled || !_iqLiveActive) return;
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return;
  const etype = (conn.effectiveType || '').toLowerCase();
  let hint = null;
  if      (etype === '4g')                   hint = 'good';
  else if (etype === '3g')                   hint = 'fair';
  else if (etype === '2g' || etype === 'slow-2g') hint = 'poor';
  if (hint) _iqMaybeChangeTier(pc, hint, null, null);
}

// ── Badge ─────────────────────────────────────────────────────────────

function _iqShowBadge(tierId, tier) {
  const badge = document.getElementById('iqBadge');
  if (!badge) return;
  badge.className = `iq-visible iq-${tierId}`;
  badge.textContent = `${tier.icon} ${tier.label}`;
}

function _iqHideBadge() {
  const badge = document.getElementById('iqBadge');
  if (!badge) return;
  badge.className = '';
  badge.textContent = '';
  _iqCurrentTier = null;
}

// ── Toast notification to streamer ───────────────────────────────────

function _iqNotify(prevId, nextId, tier) {
  const order = ['excellent', 'good', 'fair', 'poor'];
  const improved = order.indexOf(nextId) < order.indexOf(prevId);
  const msg = improved
    ? `📶 Quality improved → ${tier.label}`
    : `⚠️ Quality reduced → ${tier.label} (weak signal)`;
  toast(msg, 3500);
}

// ── Stop & cleanup ────────────────────────────────────────────────────

function _iqStop() {
  if (_iqTimer) { clearInterval(_iqTimer); _iqTimer = null; }
  _iqPrevSent  = 0;
  _iqPrevLost  = 0;
  _iqPrevBytes = 0;
  _iqPrevTs    = 0;
  _iqUpgradePending = false;
  // Remove network-change listener
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) conn.removeEventListener('change', _iqOnConnectionChange);
}
