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
  getAuth, onAuthStateChanged, browserLocalPersistence, setPersistence
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
    { urls: 'turn:openrelay.metered.ca:80',   username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
  iceCandidatePoolSize: 10,
};

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
let _viewerCountRef   = null;   // RTDB ref for viewer count listener
let _viewerCountUnsub = null;
let _viewerCountOdcRef = null;  // RTDB path we registered onDisconnect on, so we can cancel it on a clean leave
let _roomWatchRef     = null;   // saved RTDB ref so we can call off() on it
let _toastTimer       = null;
let _viewerLeftFlag   = false;  // guard: prevent double-decrement on mobile
let _creatorEndedFlag = false;  // guard: prevent beforeunload re-running endLive cleanup

/* ══════════════════════════════════════════════════
   GUEST BOX CONFIGURATION — change here to update max
   ══════════════════════════════════════════════════ */
const _MAX_GUESTS = 9;   // Maximum simultaneous guest boxes (1–9 supported)

/* ── Guest Box State ── */
let _guestLayout       = 'auto';   // current layout preference
let _guestBoxSize      = 'sm';     // 'sm' | 'md' | 'lg'
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
    likeBtn:         document.getElementById('btnLike'),
    likeBtnCount:    document.getElementById('likeBtnCount'),
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

  D.likeBtn          && D.likeBtn.addEventListener('click',          sendLike);
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

  // Layout option buttons
  document.querySelectorAll('.layout-option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.layout-option-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _guestLayout = btn.dataset.layout;
      _applyGuestLayout();
      // Broadcast layout change to all viewers and guests
      _broadcastLayout();
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

  D.stage && D.stage.addEventListener('click', e => {
    if (_mode !== 'creator') return;
    const ignore = ['.live-ctrl-btn','#btnEndLive','.live-chat-input','.live-chat-send',
                    '.live-close-btn','.live-creator-pill','.live-badge',
                    '.layout-settings-panel','.layout-option-btn','.layout-size-btn',
                    '.live-settings-panel','#liveSettingsPanel','.lsp-row','.lsp-toggle','.lsp-slider'];
    if (ignore.some(s => e.target.closest(s))) return;
    // Close layout panel on tap-away
    if (_layoutPanelOpen) { _closeLayoutPanel(); return; }
    // Close settings panel on tap-away
    const sp = document.getElementById('liveSettingsPanel');
    if (sp && sp.style.display !== 'none') { sp.style.display = 'none'; return; }
    D.stage.classList.toggle('live-controls-hidden');
  });

  onAuthStateChanged(_auth, user => {
    if (!user) {
      _hideLoading();
      window.location.href = 'index.html';
      return;
    }
    _user = user;

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
      a
