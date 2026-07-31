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
 *    - WebRTC offer/answer (liveConnections/{roomId})
 *    - ICE candidates      (liveConnections/{roomId}/creatorCandidates | viewerCandidates)
 *
 *  CREATOR:
 *    1. Captures local camera + mic via getUserMedia.
 *    2. Creates liveRooms/{roomId} in RTDB (status: 'live').
 *    3. Creates RTCPeerConnection, writes SDP offer to liveConnections/{roomId} in RTDB.
 *    4. Waits for viewer answer + ICE, then streams directly via WebRTC.
 *
 *  VIEWER:
 *    1. Reads liveRooms/{roomId} from RTDB to confirm stream is live.
 *    2. Reads SDP offer from liveConnections/{roomId} in RTDB.
 *    3. Creates RTCPeerConnection, sends answer + ICE back to RTDB.
 *    4. Receives creator tracks via WebRTC ontrack.
 *
 *  Chat + Likes:
 *    Stored in Firestore sub-collections under liveRooms/{roomId}.
 */

'use strict';

/* ── Main Firebase imports (Firestore + Auth) ── */
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore,
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, orderBy, limit, onSnapshot,
  serverTimestamp, increment, where, deleteField, arrayUnion
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

/* ── Realtime Database imports (signaling + room status) ── */
import {
  getDatabase,
  ref, set, get, update, remove, push, onValue, off, onDisconnect,
  serverTimestamp as rtdbTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

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
const _db     = getFirestore(_app);
const _liveDB = getDatabase(_app);

/* ── WebRTC ICE config ── */
const _ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80',   username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
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

// WebRTC — viewer
let _rtcPc           = null;   // RTCPeerConnection (viewer)
let _rtcSignalUnsub  = null;   // RTDB listener unsubscribe
let _rtcSignalRef    = null;   // RTDB ref being listened to
let _viewerId        = null;   // unique ID for this viewer session (regenerated on each join)
let _viewerSignalRef = null;   // liveConnections/{roomId}/viewers/{viewerId}
let _blackScreenTimer = null;  // interval handle for video health check
let _reconnecting    = false;  // guard against parallel reconnect attempts

// WebRTC — creator
let _creatorViewerListeners = {};  // { viewerId: teardownFn } — one teardown per viewer slot
let _creatorViewerPcs       = {};  // { viewerId: RTCPeerConnection } — for track replacement

let _chatUnsub        = null;
let _viewerCountRef   = null;   // RTDB ref for viewer count listener
let _viewerCountUnsub = null;
let _toastTimer       = null;
let _viewerLeftFlag   = false;  // guard: prevent double-decrement on mobile
let _creatorEndedFlag = false;  // guard: prevent beforeunload re-running endLive cleanup

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

  D.stage && D.stage.addEventListener('click', e => {
    if (_mode !== 'creator') return;
    const ignore = ['.live-ctrl-btn','#btnEndLive','.live-chat-input','.live-chat-send',
                    '.live-close-btn','.live-creator-pill','.live-badge'];
    if (ignore.some(s => e.target.closest(s))) return;
    D.stage.classList.toggle('live-controls-hidden');
  });

  onAuthStateChanged(_auth, user => {
    if (!user) {
      _hideLoading();
      window.location.href = 'index.html';
      return;
    }
    _user = user;
    _loadUserData().then(() => {
      if (D.goLiveBtn) { D.goLiveBtn.disabled = false; }
      _resolveMode();
    });
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
      video: { facingMode: _facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
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
      video: { facingMode: _facingMode }, audio: _micOn,
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

  // ── Kill any previous stuck live session for this user ──
  try {
    const userSnap = await getDoc(doc(_db, 'users', _user.uid));
    const prevRoomId = userSnap.exists() ? userSnap.data().liveRoomId : null;
    if (prevRoomId) {
      await update(ref(_liveDB, `liveRooms/${prevRoomId}`), { status: 'ended', isLive: false, endedAt: Date.now() });
      await remove(ref(_liveDB, `liveConnections/${prevRoomId}`));
      await updateDoc(doc(_db, 'users', _user.uid), { isLive: deleteField(), liveRoomId: deleteField() });
    }
    // Always delete the uid-keyed Firestore liveRooms doc (and legacy roomId-keyed one)
    try { await deleteDoc(doc(_db, 'liveRooms', _user.uid)); } catch (_) {}
    if (prevRoomId) {
      try { await deleteDoc(doc(_db, 'liveRooms', prevRoomId)); } catch (_) {}
    }
    // Also clean up any orphaned feed posts with type='live' for this user
    try {
      const orphanQ = query(
        collection(_db, 'posts'),
        where('uid', '==', _user.uid),
        where('type', '==', 'live')
      );
      const orphanSnap = await getDocs(orphanQ);
      orphanSnap.forEach(async d => { try { await deleteDoc(d.ref); } catch(_) {} });
    } catch (_) {}
  } catch (_) {}

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

  /* ── Write room to LIVE Realtime Database ── */
  try {
    await set(ref(_liveDB, `liveRooms/${_roomId}`), creatorData);
  } catch (e) {
    toast('Could not start live. Please try again.');
    if (D.goLiveBtn) { D.goLiveBtn.disabled = false; D.goLiveBtn.textContent = 'Start Live'; }
    return;
  }

  /* ── Mirror room to Firestore so Live Hub can query it.
        Keyed by uid so only ONE doc per user ever exists —
        reconnecting simply overwrites the previous entry.   ── */
  try {
    await setDoc(doc(_db, 'liveRooms', _user.uid), {
      ...creatorData,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  } catch (_) {}

  /* ── Guard: prevent accidental cleanup if page unloads during live ── */
  _creatorEndedFlag = false;
  window.addEventListener('beforeunload', _creatorBeforeUnload);
  window.addEventListener('pagehide',     _creatorBeforeUnload);

  if (D.setup) D.setup.style.display = 'none';
  _showStage();
  _attachLocalVideoToStage();
  _populateCreatorInfo(creatorData);

  await _startCreatorWebRTC();

  _subscribeChat();
  _subscribeViewerCount();
  _showCreatorShareBar();

  toast('🔴 You are LIVE!');

  // ── Non-critical side-work ──
  try {
    await updateDoc(doc(_db, 'users', _user.uid), { isLive: true, liveRoomId: _roomId });
  } catch (_) {}
  // _createLiveFeedPost intentionally omitted — live sessions must not create
  // feed posts; they appear only in the story bar and Live Hub.
  _createLiveStory(creatorData);
  _notifyFollowersLive(creatorData);
}

function _attachLocalVideoToStage() {
  if (!D.liveVideo || !_localStream) return;
  D.liveVideo.srcObject = _localStream;
  D.liveVideo.play().catch(() => {});
  D.camOffOverlay && D.camOffOverlay.classList.toggle('visible', !_camOn);
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
  _viewerCountRef = ref(_liveDB, `liveRooms/${_roomId}`);
  let _lastMirroredViewers = -1;
  _viewerCountUnsub = onValue(_viewerCountRef, snap => {
    const d = snap.val() || {};
    if (D.viewerCount) D.viewerCount.textContent = '👁 ' + (d.viewers || 0);
    if (D.likeCount)   D.likeCount.textContent   = '❤️ ' + (d.likes   || 0);
    // Mirror viewer count to Firestore (uid-keyed doc) so Live Hub cards update in real time
    const v = d.viewers || 0;
    if (v !== _lastMirroredViewers && _roomId && _user) {
      _lastMirroredViewers = v;
      updateDoc(doc(_db, 'liveRooms', _user.uid), { viewers: v }).catch(() => {});
    }
  });
}

/* ═══════════════════════════════════════════════════
   CREATOR CONTROLS — Cam / Mic / Flip / End
   ═══════════════════════════════════════════════════ */
function toggleLiveCam() {
  _camOn = !_camOn;
  if (_localStream) _localStream.getVideoTracks().forEach(t => { t.enabled = _camOn; });
  // Propagate to all per-viewer senders
  for (const pc of Object.values(_creatorViewerPcs)) {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender && sender.track) sender.track.enabled = _camOn;
  }
  if (D.btnCam) { D.btnCam.textContent = _camOn ? '📷' : '🚫'; D.btnCam.classList.toggle('off', !_camOn); }
  if (D.camOffOverlay) D.camOffOverlay.classList.toggle('visible', !_camOn);
}

function toggleLiveMic() {
  _micOn = !_micOn;
  if (_localStream) _localStream.getAudioTracks().forEach(t => { t.enabled = _micOn; });
  // Propagate to all per-viewer senders
  for (const pc of Object.values(_creatorViewerPcs)) {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
    if (sender && sender.track) sender.track.enabled = _micOn;
  }
  if (D.btnMic) { D.btnMic.textContent = _micOn ? '🎤' : '🔇'; D.btnMic.classList.toggle('off', !_micOn); }
  toast(_micOn ? 'Mic on' : 'Mic muted');
}

async function flipLiveCamera() {
  _facingMode = _facingMode === 'user' ? 'environment' : 'user';
  const oldStream = _localStream;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: _facingMode }, audio: _micOn,
    });
    if (oldStream) oldStream.getTracks().forEach(t => t.stop());
    _localStream = newStream;
    // Ensure tracks are enabled per current toggle state
    newStream.getVideoTracks().forEach(t => { t.enabled = _camOn; });
    newStream.getAudioTracks().forEach(t => { t.enabled = _micOn; });
    if (D.liveVideo) {
      D.liveVideo.srcObject = newStream;
      D.liveVideo.play().catch(() => {});
    }
    // Replace video track in all active per-viewer peer connections
    const newVideoTrack = newStream.getVideoTracks()[0];
    if (newVideoTrack) {
      for (const pc of Object.values(_creatorViewerPcs)) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(newVideoTrack).catch(() => {});
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
  for (const teardown of Object.values(_creatorViewerListeners)) {
    if (typeof teardown === 'function') teardown();
  }
  _creatorViewerListeners = {};
  _creatorViewerPcs = {};
  if (_localStream) { _localStream.getTracks().forEach(t => t.stop()); _localStream = null; }
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

  // Close all per-viewer peer connections and signaling listeners
  for (const teardown of Object.values(_creatorViewerListeners)) {
    if (typeof teardown === 'function') teardown();
  }
  _creatorViewerListeners = {};
  _creatorViewerPcs = {};

  if (_rtcSignalRef && _rtcSignalUnsub) { off(_rtcSignalRef); _rtcSignalRef = null; _rtcSignalUnsub = null; }
  if (_chatUnsub)        { _chatUnsub();         _chatUnsub        = null; }
  if (_viewerCountRef && _viewerCountUnsub) { off(_viewerCountRef); _viewerCountRef = null; _viewerCountUnsub = null; }

  /* ── Remove all WebRTC signaling from LIVE RTDB ── */
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
    });
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

  /* ── Schedule RTDB room deletion after 5 min (cleans up ended marker) ── */
  setTimeout(async () => {
    try { await remove(ref(_liveDB, `liveRooms/${_endedRoomId}`)); } catch (_) {}
  }, 5 * 60 * 1000);

  _deleteLiveStory();
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

  const _MAX_RETRIES = 8;
  const _RETRY_MS    = 2000;

  for (let attempt = 0; attempt < _MAX_RETRIES; attempt++) {
    try {
      const snap = await get(ref(_liveDB, `liveRooms/${_roomId}`));
      if (snap.exists() && snap.val().status === 'live') {
        roomData = snap.val();
        break;
      }
      if (snap.exists() && snap.val().status === 'ended') {
        _hideLoading();
        _showEndedOverlay(false, 'Stream ended', 'This live stream has already ended.');
        return;
      }
    } catch (e) {
      _hideLoading();
      toast('Could not connect. Please try again.');
      return;
    }
    if (attempt === 0) {
      _hideLoading();
      _showStage();
      _showConnBanner('Waiting for stream…', '');
    }
    await new Promise(r => setTimeout(r, _RETRY_MS));
  }

  if (!roomData) {
    _showEndedOverlay(false, 'Stream ended', 'This live stream has ended or does not exist.');
    return;
  }

  _hideLoading();
  _showStage();
  _hideConnBanner();
  _populateCreatorInfo(roomData);
  _setupViewerControls(roomData);
  _subscribeChat();

  /* ── Increment viewer count in LIVE RTDB ── */
  try {
    const viewersRef = ref(_liveDB, `liveRooms/${_roomId}/viewers`);
    const currentSnap = await get(viewersRef);
    await set(viewersRef, (currentSnap.val() || 0) + 1);
  } catch (_) {}

  /* ── Watch for stream ending via LIVE RTDB ── */
  let _roomWatchSeenFirst = false;
  const roomWatchRef = ref(_liveDB, `liveRooms/${_roomId}`);
  onValue(roomWatchRef, snap => {
    const d = snap.val() || {};
    if (D.viewerCount) D.viewerCount.textContent = '👁 ' + (d.viewers || 0);
    if (D.likeCount)   D.likeCount.textContent   = '❤️ ' + (d.likes   || 0);
    if (!_roomWatchSeenFirst) {
      _roomWatchSeenFirst = true;
      return;
    }
    if (!snap.exists() || d.status === 'ended') {
      _showEndedOverlay(false, 'Stream ended', `${roomData.hostName} has ended the live stream.`);
    }
  });

  await _startViewerWebRTC(roomData);

  window.addEventListener('beforeunload', _viewerLeave);
  window.addEventListener('pagehide',     _viewerLeave);
}

async function _viewerLeave() {
  if (_viewerLeftFlag || !_roomId) return;
  _viewerLeftFlag = true;

  // Stop black-screen watchdog and tear down peer connection + signaling
  _teardownViewerPc();

  // Clear video element
  if (D.liveVideo) {
    try { D.liveVideo.pause(); } catch (_) {}
    try {
      if (D.liveVideo.srcObject) {
        D.liveVideo.srcObject.getTracks().forEach(t => t.stop());
        D.liveVideo.srcObject = null;
      }
    } catch (_) {}
  }

  /* ── Decrement viewer count in LIVE RTDB ── */
  try {
    const viewersRef = ref(_liveDB, `liveRooms/${_roomId}/viewers`);
    const snap = await get(viewersRef);
    const cur = snap.val() || 0;
    await set(viewersRef, Math.max(0, cur - 1));
  } catch (_) {}

  // Reset the flag so this viewer can rejoin without refreshing
  _viewerLeftFlag = false;
}

function _setupViewerControls(roomData) {
  if (D.profileBtn) {
    D.profileBtn.style.display = 'flex';
    D.profileBtn.onclick = () => {
      window.open('index.html#profile=' + roomData.hostId, '_blank');
    };
  }
}

/* ═══════════════════════════════════════════════════
   WebRTC — CREATOR
   Per-viewer signaling: liveConnections/{roomId}/viewers/{viewerId}
   Creator watches for new viewer join requests and creates a fresh
   RTCPeerConnection + offer for each one.
   ═══════════════════════════════════════════════════ */
async function _startCreatorWebRTC() {
  if (!_localStream) {
    toast('Camera or mic not available.');
    return;
  }

  // Register onDisconnect so room is marked ended if creator disconnects
  try {
    await onDisconnect(ref(_liveDB, `liveRooms/${_roomId}`)).update({
      status: 'ended', isLive: false, endedAt: Date.now(),
    });
  } catch (_) {}

  // Watch for viewer join requests under liveConnections/{roomId}/viewers/
  const viewersRootRef = ref(_liveDB, `liveConnections/${_roomId}/viewers`);
  _rtcSignalRef   = viewersRootRef;
  _rtcSignalUnsub = onValue(viewersRootRef, async snap => {
    if (!snap.exists()) return;
    const viewers = snap.val() || {};
    for (const [vid, vData] of Object.entries(viewers)) {
      // Only respond to join requests we haven't handled yet (or that were reset)
      if (vData.status !== 'join') continue;
      if (_creatorViewerListeners[vid]) continue;  // already handling this viewer
      _handleViewerJoin(vid);
    }
  });

  toast('Live now');
}

/** Create a fresh per-viewer RTCPeerConnection and complete the offer/answer exchange. */
async function _handleViewerJoin(viewerId) {
  if (!_localStream) return;

  const viewerRef = ref(_liveDB, `liveConnections/${_roomId}/viewers/${viewerId}`);

  // Mark as handling so we don't double-start
  _creatorViewerListeners[viewerId] = true;

  // Clean up any stale data from a previous session for this viewer
  try { await update(viewerRef, { offer: null, answer: null, creatorCandidates: null, viewerCandidates: null }); } catch (_) {}

  // Create a fresh peer connection for this viewer
  const pc = new RTCPeerConnection(_ICE_SERVERS);
  _creatorViewerPcs[viewerId] = pc;

  // Ensure tracks are live and match current cam/mic state
  _localStream.getVideoTracks().forEach(t => { t.enabled = _camOn; });
  _localStream.getAudioTracks().forEach(t => { t.enabled = _micOn; });

  // Add local tracks (send-only)
  _localStream.getTracks().forEach(track => pc.addTrack(track, _localStream));
  pc.getTransceivers().forEach(tc => { tc.direction = 'sendonly'; });

  const pendingCands = [];
  let offerWritten = false;

  pc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    if (!offerWritten) { pendingCands.push(e.candidate.toJSON()); return; }
    try { await push(ref(_liveDB, `liveConnections/${_roomId}/viewers/${viewerId}/creatorCandidates`), e.candidate.toJSON()); }
    catch (_) {}
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    console.log(`[WebRTC creator→${viewerId}] state: ${state}`);
    if (state === 'disconnected' || state === 'failed') {
      // Viewer disconnected — clean up this peer connection and slot
      _cleanupViewerPc(viewerId);
    }
  };

  // Create offer
  let offer;
  try {
    offer = await Promise.race([
      pc.createOffer(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('offer timeout')), 10000)),
    ]);
  } catch (e) {
    console.warn('[WebRTC creator] createOffer failed for viewer', viewerId, e);
    delete _creatorViewerListeners[viewerId];
    delete _creatorViewerPcs[viewerId];
    return;
  }

  try { await pc.setLocalDescription(offer); }
  catch (e) { delete _creatorViewerListeners[viewerId]; delete _creatorViewerPcs[viewerId]; return; }

  // Write offer to this viewer's slot
  try {
    await update(viewerRef, {
      status:            'offered',
      offer:             { type: offer.type, sdp: offer.sdp },
      creatorCandidates: {},
    });
    offerWritten = true;
  } catch (e) {
    delete _creatorViewerListeners[viewerId];
    delete _creatorViewerPcs[viewerId];
    return;
  }

  // Flush buffered ICE candidates
  for (const cand of pendingCands) {
    try { await push(ref(_liveDB, `liveConnections/${_roomId}/viewers/${viewerId}/creatorCandidates`), cand); } catch (_) {}
  }
  pendingCands.length = 0;

  // Listen for viewer answer + ICE candidates
  const appliedViewerCandKeys = new Set();
  const answerListener = onValue(viewerRef, async snap => {
    if (!snap.exists()) return;
    const d = snap.val();

    if (d.answer && pc.remoteDescription === null) {
      try { await pc.setRemoteDescription(new RTCSessionDescription(d.answer)); }
      catch (err) { console.warn('[WebRTC creator] setRemoteDescription failed', err); }
    }

    if (pc.remoteDescription && d.viewerCandidates) {
      for (const [key, cand] of Object.entries(d.viewerCandidates)) {
        if (appliedViewerCandKeys.has(key)) continue;
        appliedViewerCandKeys.add(key);
        try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
      }
    }
  });

  // Store the teardown fn so endLive() / _cleanupViewerPc() can close everything.
  // answerListener is the unsubscribe fn returned by onValue() in Firebase v9 modular.
  _creatorViewerListeners[viewerId] = () => {
    try { answerListener(); } catch (_) {}  // unsubscribe the onValue listener
    try { off(viewerRef); } catch (_) {}    // belt-and-braces: remove all listeners
    try { pc.close(); } catch (_) {}
    delete _creatorViewerPcs[viewerId];
  };
}

/** Tear down a per-viewer connection and clean up signaling. */
function _cleanupViewerPc(viewerId) {
  if (_creatorViewerListeners[viewerId] && typeof _creatorViewerListeners[viewerId] === 'function') {
    _creatorViewerListeners[viewerId]();
  }
  delete _creatorViewerListeners[viewerId];
  delete _creatorViewerPcs[viewerId];
  try {
    remove(ref(_liveDB, `liveConnections/${_roomId}/viewers/${viewerId}`)).catch(() => {});
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════
   WebRTC — VIEWER
   Per-viewer signaling: liveConnections/{roomId}/viewers/{viewerId}
   Each join creates a brand-new viewerId + RTCPeerConnection.
   ═══════════════════════════════════════════════════ */
async function _startViewerWebRTC(roomData) {
  _showConnBanner('Waiting for stream…', '');

  // Generate a fresh viewer ID for this session (ensures clean slate on rejoin)
  _viewerId = `${_user.uid}_${Date.now().toString(36)}`;
  _viewerSignalRef = ref(_liveDB, `liveConnections/${_roomId}/viewers/${_viewerId}`);

  // Tear down any previous peer connection first
  _teardownViewerPc();

  _rtcPc = new RTCPeerConnection(_ICE_SERVERS);

  _rtcPc.ontrack = (e) => {
    if (!D.liveVideo) return;
    const stream = e.streams[0] || new MediaStream([e.track]);
    // Always replace old stream with fresh one
    if (D.liveVideo.srcObject) {
      try {
        D.liveVideo.srcObject.getTracks().forEach(t => t.stop());
      } catch (_) {}
    }
    D.liveVideo.srcObject = null;
    D.liveVideo.srcObject = stream;
    D.liveVideo.muted = true;
    D.liveVideo.load();
    D.liveVideo.play().catch(() => {});
    _showUnmutePrompt();
    _hideConnBanner();
    // Kick off the black-screen watchdog
    _startBlackScreenWatchdog();
  };

  _rtcPc.onconnectionstatechange = () => {
    const state = _rtcPc ? _rtcPc.connectionState : 'closed';
    console.log('[WebRTC viewer] state:', state);
    if (state === 'connected') {
      _hideConnBanner();
      _reconnecting = false;
    } else if (state === 'disconnected' || state === 'failed') {
      _showConnBanner('Reconnecting…', '');
      _scheduleViewerReconnect(roomData);
    }
  };

  const pendingCands = [];
  let answerWritten = false;

  _rtcPc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    if (!answerWritten) { pendingCands.push(e.candidate.toJSON()); return; }
    try {
      await push(ref(_liveDB, `liveConnections/${_roomId}/viewers/${_viewerId}/viewerCandidates`), e.candidate.toJSON());
    } catch (_) {}
  };

  // Signal the creator that we want to connect (status = 'join')
  try {
    await set(_viewerSignalRef, { status: 'join', uid: _user.uid, joinedAt: Date.now() });
  } catch (e) {
    _showConnBanner('Could not connect. Retrying…', '');
    setTimeout(() => _startViewerWebRTC(roomData), 3000);
    return;
  }

  // Wait for creator to write an offer into our slot
  let offer = null;
  await new Promise((resolve) => {
    const waitRef = _viewerSignalRef;
    let resolved = false;
    const unsub = onValue(waitRef, snap => {
      if (!snap.exists()) return;
      const d = snap.val();
      if (d.offer && d.status === 'offered') {
        offer = d.offer;
        if (!resolved) { resolved = true; try { unsub(); } catch (_) {} resolve(); }
      }
    });
    // Timeout after 15s
    setTimeout(() => {
      if (!resolved) { resolved = true; try { unsub(); } catch (_) {} resolve(); }
    }, 15000);
  });

  if (!offer) {
    _showConnBanner('Waiting for stream…', '');
    // Retry: write a fresh join request in 3s
    setTimeout(() => {
      if (_mode === 'viewer' && _roomId) _startViewerWebRTC(roomData);
    }, 3000);
    return;
  }

  // Set remote description (creator's offer)
  try {
    await _rtcPc.setRemoteDescription(new RTCSessionDescription(offer));
  } catch (e) {
    _showConnBanner('Waiting for stream…', '');
    return;
  }

  // Create answer
  let answer;
  try {
    answer = await _rtcPc.createAnswer();
    await _rtcPc.setLocalDescription(answer);
  } catch (e) {
    _showConnBanner('Waiting for stream…', '');
    return;
  }

  // Write answer back to our slot
  try {
    await update(_viewerSignalRef, {
      status: 'answered',
      answer: { type: answer.type, sdp: answer.sdp },
    });
    answerWritten = true;
  } catch (e) {
    _showConnBanner('Waiting for stream…', '');
    return;
  }

  // Flush buffered viewer ICE candidates
  for (const cand of pendingCands) {
    try { await push(ref(_liveDB, `liveConnections/${_roomId}/viewers/${_viewerId}/viewerCandidates`), cand); } catch (_) {}
  }
  pendingCands.length = 0;

  // Apply any creator ICE candidates that arrived with the offer snapshot
  let snap;
  try { snap = await get(_viewerSignalRef); } catch (_) {}
  const appliedCreatorCandKeys = new Set();
  if (snap && snap.exists() && snap.val().creatorCandidates) {
    for (const [key, cand] of Object.entries(snap.val().creatorCandidates)) {
      appliedCreatorCandKeys.add(key);
      try { await _rtcPc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
    }
  }

  // Listen for new creator ICE candidates
  _rtcSignalRef   = _viewerSignalRef;
  _rtcSignalUnsub = onValue(_viewerSignalRef, async candSnap => {
    if (!candSnap.exists()) return;
    const d = candSnap.val();
    if (d.creatorCandidates) {
      for (const [key, cand] of Object.entries(d.creatorCandidates)) {
        if (appliedCreatorCandKeys.has(key)) continue;
        appliedCreatorCandKeys.add(key);
        try { await _rtcPc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
      }
    }
  });
}

/** Tear down viewer RTCPeerConnection and signaling listener without touching viewer count. */
function _teardownViewerPc() {
  if (_blackScreenTimer) { clearInterval(_blackScreenTimer); _blackScreenTimer = null; }
  if (_rtcSignalUnsub) {
    // In Firebase v9 modular SDK, onValue returns an unsubscribe fn; call it directly.
    // Fall back to off(ref) for safety.
    try { _rtcSignalUnsub(); } catch (_) {}
    if (_rtcSignalRef) { try { off(_rtcSignalRef); } catch (_) {} }
    _rtcSignalRef = null; _rtcSignalUnsub = null;
  }
  if (_rtcPc) {
    try { _rtcPc.ontrack = null; _rtcPc.onicecandidate = null; _rtcPc.onconnectionstatechange = null; }
    catch (_) {}
    try { _rtcPc.close(); } catch (_) {}
    _rtcPc = null;
  }
  // Remove old viewer slot from RTDB
  if (_viewerSignalRef) {
    try { remove(_viewerSignalRef).catch(() => {}); } catch (_) {}
    _viewerSignalRef = null;
  }
}

/** Schedule a reconnect attempt after disconnection; guards against parallel calls. */
function _scheduleViewerReconnect(roomData) {
  if (_reconnecting) return;
  _reconnecting = true;
  setTimeout(async () => {
    if (_mode !== 'viewer' || !_roomId) { _reconnecting = false; return; }
    // Verify the room is still live before attempting
    try {
      const snap = await get(ref(_liveDB, `liveRooms/${_roomId}`));
      if (!snap.exists() || snap.val().status === 'ended') {
        _reconnecting = false;
        return; // room watcher will show ended overlay
      }
    } catch (_) {}
    await _startViewerWebRTC(roomData);
    _reconnecting = false;
  }, 2500);
}

/**
 * Periodically check whether the video element is connected but showing a
 * black frame (video.readyState < 2 or paused) and force-restart playback.
 */
function _startBlackScreenWatchdog() {
  if (_blackScreenTimer) clearInterval(_blackScreenTimer);
  _blackScreenTimer = setInterval(() => {
    if (!D.liveVideo) return;
    const v = D.liveVideo;
    // If we have an active stream but video is stalled / paused / black
    if (v.srcObject && !v.paused && v.readyState >= 2) return; // healthy
    if (!v.srcObject) return; // no stream yet
    if (v.paused || v.readyState < 2) {
      console.log('[WebRTC viewer] Black screen detected — forcing play()');
      v.load();
      v.play().catch(() => {});
    }
  }, 4000);
}

/* ═══════════════════════════════════════════════════
   CHAT — Firestore sub-collection
   ═══════════════════════════════════════════════════ */
function _subscribeChat() {
  if (!_roomId) return;
  const q = query(
    collection(_db, 'liveRooms', _roomId, 'liveMessages'),
    orderBy('createdAt', 'asc'),
    limit(150)
  );
  _chatUnsub = onSnapshot(q, snap => {
    snap.docChanges().forEach(ch => {
      if (ch.type === 'added') _appendChatMsg(ch.doc.data());
    });
  }, () => {});
}

function _appendChatMsg(data) {
  if (!D.chatMessages) return;
  const hostUid  = _roomId ? _roomId.split('_')[0] : null;
  const isHost   = !!(hostUid && data.userId === hostUid);
  const isSystem = data.type === 'system';

  const el = document.createElement('div');
  el.className = 'live-chat-msg' + (isSystem ? ' system' : '');
  if (!isSystem) {
    el.innerHTML = `<span class="live-chat-author${isHost ? ' is-host' : ''}">${_esc(data.userName || 'Guest')}</span>
                    <span class="live-chat-text">${_esc(data.text)}</span>`;
  } else {
    el.innerHTML = `<span class="live-chat-text">${_esc(data.text)}</span>`;
  }
  D.chatMessages.appendChild(el);
  D.chatMessages.scrollTop = D.chatMessages.scrollHeight;

  while (D.chatMessages.children.length > 80) {
    D.chatMessages.removeChild(D.chatMessages.firstChild);
  }
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

  if (D.chatInput) D.chatInput.value = '';

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
  }
}

/* ═══════════════════════════════════════════════════
   LIKES — LIVE RTDB
   ═══════════════════════════════════════════════════ */
let _hasLiked = false;

async function sendLike() {
  if (!_user || !_roomId || _hasLiked) return;
  _hasLiked = true;
  if (D.likeBtn)      D.likeBtn.classList.add('liked');
  if (D.likeBtnCount) D.likeBtnCount.textContent = '❤️';

  _spawnHeartBurst();

  try {
    const likesRef = ref(_liveDB, `liveRooms/${_roomId}/likes`);
    const snap = await get(likesRef);
    await set(likesRef, (snap.val() || 0) + 1);
  } catch (_) {}

  setTimeout(() => {
    _hasLiked = false;
    if (D.likeBtn) D.likeBtn.classList.remove('liked');
  }, 5000);
}

function _spawnHeartBurst() {
  const stage = D.stage;
  if (!stage) return;
  const el = document.createElement('div');
  el.className = 'like-burst';
  el.textContent = '❤️';
  const rect = stage.getBoundingClientRect();
  el.style.left     = (rect.width  * 0.75 + (Math.random() - 0.5) * 60) + 'px';
  el.style.bottom   = (80 + Math.random() * 60) + 'px';
  el.style.position = 'absolute';
  stage.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
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

function _showConnBanner(title, sub) {
  if (!D.connBanner) return;
  if (D.connTitle) D.connTitle.textContent = title;
  if (D.connSub)   D.connSub.textContent   = sub;
  D.connBanner.classList.add('visible');
}

function _hideConnBanner() {
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
  // Viewer side: clean up PC and watchdog
  if (_mode === 'viewer') {
    _teardownViewerPc();
  }
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

function toast(msg) {
  if (!D.toast) return;
  clearTimeout(_toastTimer);
  D.toast.textContent = msg;
  D.toast.classList.add('visible');
  _toastTimer = setTimeout(() => D.toast.classList.remove('visible'), 3200);
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
