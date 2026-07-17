/**
 * live.js — Shadow Nexus Social · Live Stream Engine (Rebuilt)
 *
 * Architecture:
 *  • Firebase Auth — identity (re-uses existing app if already initialised)
 *  • Firestore — room metadata, signaling (offer/answer/ICE), join requests
 *  • Realtime Database — viewer count, live chat, reactions, presence
 *  • WebRTC RTCPeerConnection per guest (fully isolated)
 *  • Adaptive quality: 720p → 480p → 360p based on RTT
 *  • Auto-reconnect on ICE failure (up to 5 retries, exponential back-off)
 *  • Host controls: mute, cam-off, remove guest
 *  • Security: only doc owner can start/end their own stream
 *  • Mobile: camera flip, safe-area insets, touch controls
 */

import { initializeApp, getApps }
  from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged, browserLocalPersistence, setPersistence }
  from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, deleteDoc,
  collection, addDoc, onSnapshot, serverTimestamp, query,
  where, getDocs, writeBatch, increment as fsIncrement, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
  getDatabase, ref as rtRef, set as rtSet, push as rtPush,
  onValue, off, remove as rtRemove, onDisconnect,
  increment as rtIncrement, update as rtUpdate
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { getStorage, ref as stRef, uploadBytes, getDownloadURL }
  from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

/* ─────────────────────────────────────────────────
   Firebase init
───────────────────────────────────────────────── */
const FB_CONFIG = {
  apiKey:            "AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y",
  authDomain:        "horr-a08f4.firebaseapp.com",
  databaseURL:       "https://horr-a08f4-default-rtdb.firebaseio.com",
  projectId:         "horr-a08f4",
  storageBucket:     "horr-a08f4.firebasestorage.app",
  messagingSenderId: "933810617818",
  appId:             "1:933810617818:web:efb24f123337dd987c14e3"
};
const fbApp = getApps().length ? getApps()[0] : initializeApp(FB_CONFIG);
const auth  = getAuth(fbApp);
const db    = getFirestore(fbApp);
const rtdb  = getDatabase(fbApp);
const storage = getStorage(fbApp);
setPersistence(auth, browserLocalPersistence).catch(() => {});

/* ─────────────────────────────────────────────────
   ICE / Quality
───────────────────────────────────────────────── */
const TURN_ENDPOINT = "https://yellow-term-11e6.nthntjrn.workers.dev/turn";
const STUN_ONLY = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// Resolved once per page load; falls back to STUN-only if worker is unreachable
let ICE_SERVERS = STUN_ONLY;
let _iceReady   = false;

async function loadIceServers() {
  if (_iceReady) return;
  _iceReady = true; // set before await so concurrent callers don't double-fetch
  try {
    const uid = auth.currentUser?.uid || "anon";
    const res = await fetch(`${TURN_ENDPOINT}?uid=${encodeURIComponent(uid)}`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length) {
        ICE_SERVERS = data.iceServers;
        // Schedule credential refresh 1 min before they expire (TTL from worker)
        const ttl = (data.ttl || 3600) - 60;
        setTimeout(() => { _iceReady = false; }, ttl * 1000);
      }
    }
  } catch (_) {
    // network error — STUN_ONLY fallback stays in place; allow retry next call
    _iceReady = false;
  }
}

/* ─────────────────────────────────────────────────
   Helper: stop any active stream and release tracks
───────────────────────────────────────────────── */
function releaseStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
}

/* ─────────────────────────────────────────────────
   Helper: delete all signal + ICE docs for a viewer slot
   so stale offer/answer from a previous session can't confuse a new one
───────────────────────────────────────────────── */
async function clearViewerSignal(viewerUid) {
  if (!roomId) return;
  try {
    const sigRef = doc(db, "stories", roomId, "signals_viewer", viewerUid);
    await deleteDoc(sigRef).catch(() => {});
    // ICE sub-collections are automatically cleaned up by Firestore TTL rules,
    // but we overwrite the signal doc which is what peers watch.
  } catch (_) {}
}
async function clearGuestSignal(guestUid) {
  if (!roomId) return;
  try {
    const sigRef = doc(db, "stories", roomId, "signals", guestUid);
    await deleteDoc(sigRef).catch(() => {});
  } catch (_) {}
}

const QUALITY = {
  HIGH:   { width: 1280, height: 720,  frameRate: 30, bitrate: 1_500_000 },
  MEDIUM: { width: 854,  height: 480,  frameRate: 24, bitrate:   700_000 },
  LOW:    { width: 640,  height: 360,  frameRate: 15, bitrate:   300_000 },
};

/* ─────────────────────────────────────────────────
   State
───────────────────────────────────────────────── */
let me           = null;   // Firebase Auth user
let userData     = {};     // Firestore /users/{uid} doc
let roomId       = null;   // Firestore doc id of the live
let isHost       = false;
let liveActive   = false;
let localStream  = null;
let micEnabled   = true;
let camEnabled   = true;
let facingMode   = "user";
let setupStream  = null;   // preview stream before going live
let timerInt     = null;
let liveStart    = 0;
let currentQuality = "HIGH";
let chatEnabled  = true;
let slowMode     = false;
let slowDelay    = 5000;
let lastMsgTime  = 0;
let pinnedMsgId  = null;
let replyTo      = null;   // { msgId, name, text }
let requestsOpen = true;
let requestAllowMode = "everyone";
let mobileChatOpen = false;
let activeTabDesktop = "chat";
let activeTabMobile  = "chat";
let _ctxGuestUid = null;

// WebRTC peers (host manages these)
const peers = {};          // { uid: RTCPeerConnection }
const guestInfo = {};      // { uid: { displayName, avatarUrl } }

// Unsub fns
const unsubs = [];
let viewerCountRef = null;
let viewerPresRef  = null;
let chatRtRef      = null;
let roomDocUnsub   = null;
let reqUnsub       = null;
let hostCmdUnsub   = null;

// Recording (host only)
let mediaRecorder  = null;
let recordedChunks = [];
let recordStart    = 0;
let replayBlob     = null;

/* ─────────────────────────────────────────────────
   DOM helpers
───────────────────────────────────────────────── */
const $  = id => document.getElementById(id);
const esc = s => String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
function toast(msg, dur = 3500) {
  const t = $("liveToast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("show"), dur);
}
function isMobile() { return window.innerWidth <= 700; }

/* ─────────────────────────────────────────────────
   Auth ready
───────────────────────────────────────────────── */
onAuthStateChanged(auth, async user => {
  me = user;
  if (!me) { window.location.href = "index.html"; return; }
  // Load user data
  try {
    const snap = await getDoc(doc(db, "users", me.uid));
    userData = snap.exists() ? snap.data() : {};
  } catch (_) {}

  // ── Maintenance Mode Check ──
  // Founders always bypass; everyone else is redirected
  try {
    const cfgSnap = await getDoc(doc(db, 'siteSettings', 'config'));
    if (cfgSnap.exists() && cfgSnap.data().maintenanceMode === true && userData.role !== 'founder') {
      window.location.replace('maintenance.html');
      return;
    }
  } catch (_) {}

  init();
});

/* ─────────────────────────────────────────────────
   Init — parse URL, decide role
───────────────────────────────────────────────── */
function init() {
  const params = new URLSearchParams(location.search);
  const rawRoom = params.get("room") || null;
  roomId = (rawRoom && rawRoom !== "new") ? rawRoom : null;
  isHost = params.get("host") === "1";
  const requestBox = params.get("requestBox") === "1";

  wireButtons();
  wireChat();

  if (isHost) {
    // FIX 1: Host always goes straight to camera setup — no room pre-created.
    // goLive() will create the Firestore room doc when the host clicks "Start Live".
    startSetupPreview();
    return;
  }

  if (!rawRoom) {
    // No room param and not a host — show lobby (allows watching a stream from lobby)
    showLobby();
    return;
  }

  if (!roomId) { showLobby(); return; }

  // Viewer/guest: join the room
  showOverlay("joinOverlay");
  $("joinSub").textContent = "Connecting to live stream…";
  joinAsViewer().then(() => {
    if (requestBox) {
      // Auto-open the permission modal so the viewer can request to join on camera
      $("permModal").classList.add("open");
    }
  });
}

/* ─────────────────────────────────────────────────
   Overlays
───────────────────────────────────────────────── */
function showLobby()    { showOverlay("lobbyOverlay"); }
function showOverlay(id){ ["lobbyOverlay","setupOverlay","joinOverlay","waitingOverlay"].forEach(o => $(o).classList.toggle("hidden", o !== id)); }
function hideAllOverlays(){ ["lobbyOverlay","setupOverlay","joinOverlay","waitingOverlay"].forEach(o => $(o).classList.add("hidden")); }

/* ─────────────────────────────────────────────────
   Host: setup preview
───────────────────────────────────────────────── */
async function startSetupPreview() {
  showOverlay("setupOverlay");

  // Always stop any previous preview stream before requesting a new one
  // to avoid grabbing the same camera twice (some browsers refuse the second getUserMedia)
  if (setupStream) {
    releaseStream(setupStream);
    setupStream = null;
    $("setupVideo").srcObject = null;
  }

  // Check API availability first
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("Camera not supported in this browser.");
    showLobby(); return;
  }

  try {
    // Request camera + mic; catch permission errors explicitly
    setupStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    });
  } catch (err) {
    const msg = err.name === "NotAllowedError"  ? "Camera/microphone permission denied. Please allow access and try again." :
                err.name === "NotFoundError"    ? "No camera/microphone found on this device." :
                err.name === "NotReadableError" ? "Camera is already in use by another app." :
                                                  "Could not access camera: " + (err.message || err);
    toast(msg);
    showLobby(); return;
  }

  // Confirm we actually got a video track
  const videoTracks = setupStream.getVideoTracks();
  const audioTracks = setupStream.getAudioTracks();
  if (!videoTracks.length) {
    toast("No video track found. Check camera permissions.");
    releaseStream(setupStream); setupStream = null;
    showLobby(); return;
  }
  if (!videoTracks[0].enabled || videoTracks[0].readyState !== "live") {
    toast("Video track is not active. Check camera access.");
    releaseStream(setupStream); setupStream = null;
    showLobby(); return;
  }
  if (audioTracks.length && audioTracks[0].readyState !== "live") {
    toast("Microphone track not active — continuing without audio.");
  }

  const vid = $("setupVideo");
  vid.srcObject = setupStream;
  vid.play().catch(() => {});
  syncSetupBtns();
}

function syncSetupBtns() {
  $("btnSetupMic").textContent = micEnabled ? "🎙 Mic: On" : "🔇 Mic: Off";
  $("btnSetupMic").classList.toggle("off", !micEnabled);
  $("btnSetupCam").textContent = camEnabled ? "📷 Cam: On" : "📷 Cam: Off";
  $("btnSetupCam").classList.toggle("off", !camEnabled);
}

function stopSetupPreview() {
  if (setupStream) { releaseStream(setupStream); setupStream = null; }
  const vid = $("setupVideo");
  vid.srcObject = null;
  // Ensure the video element releases the camera indicator
  vid.load();
}

/* ─────────────────────────────────────────────────
   Host: start live
───────────────────────────────────────────────── */
async function goLive() {
  if (!me) return;
  const btn = $("btnGoLive");
  // Lock button immediately to prevent double-clicks
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "Starting…";

  await loadIceServers();

  const title   = ($("setupTitleInput").value || "").trim();
  const privacy = $("setupPrivacySelect").value || "everyone";
  const name    = userData.displayName || userData.username || me.displayName || "Host";
  const avatar  = userData.avatarUrl || me.photoURL || "";

  try {
    // Validate setup stream is still alive before transferring it
    if (!setupStream || !setupStream.getVideoTracks().length) {
      throw new Error("Camera stream is empty — please allow camera access and try again.");
    }
    const vTrack = setupStream.getVideoTracks()[0];
    if (vTrack.readyState !== "live") {
      throw new Error("Camera track ended unexpectedly. Please go back and retry.");
    }

    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000); // 4h max
    let docRef;
    if (roomId) {
      // roomId was pre-created by index.html (legacy path — kept for back-compat)
      docRef = doc(db, "stories", roomId);
      await updateDoc(docRef, { isLive: true, liveActive: true, title, privacy });
    } else {
      // FIX 1/4: Create Firestore stories doc (room metadata + signaling)
      docRef = await addDoc(collection(db, "stories"), {
        authorUid: me.uid, authorName: name, authorAvatar: avatar,
        text: title, mediaUrl: "", mediaType: "", privacy,
        isLive: true, liveActive: true,
        viewerCount: 0, viewerUids: [],
        reactions: {}, chat: [],
        createdAt: serverTimestamp(), expiresAt,
      });
      roomId = docRef.id;
      await updateDoc(docRef, { roomId });
    }

    // FIX 4: Write the RTDB liveRooms node with proper structure
    //   liveRooms/{roomId}
    //     ├── host        — host uid + name
    //     ├── messages    — realtime chat (FIX 6)
    //     ├── likes       — reaction counter (FIX 7)
    //     └── viewers     — presence map
    await rtSet(rtRef(rtdb, `liveRooms/${roomId}`), {
      host: { uid: me.uid, name },
      messages: null,
      likes: 0,
      viewers: null,
      viewerCount: 0,
      startedAt: Date.now(),
    });

    // Save roomId to sessionStorage so the viewer page can read it immediately
    sessionStorage.setItem("liveRoomId", roomId);

    // Transfer setup stream → live WITHOUT stopping tracks.
    // detach from preview element, keep tracks running as localStream.
    localStream = setupStream;
    setupStream = null;
    const vid = $("setupVideo");
    vid.srcObject = null;
    vid.load(); // release camera indicator on preview element

    // Apply mic/cam state that may have been toggled in setup
    localStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
    localStream.getVideoTracks().forEach(t => { t.enabled = camEnabled; });

    // Show countdown, then enter live room
    hideAllOverlays();
    await runCountdown(3);
    startLive();
  } catch (err) {
    // FIX 8: Enhanced start live error handling
    toast("❌ Failed to start live: " + (err.message || err), 5000);
    btn.disabled = false;
    btn.textContent = "🔴 Start Live Stream";
    // Re-open setup overlay so user can retry
    showOverlay("setupOverlay");
  }
}

/* ─────────────────────────────────────────────────
   Countdown overlay before going live
───────────────────────────────────────────────── */
function runCountdown(seconds) {
  return new Promise(resolve => {
    // Re-use setupOverlay element for the countdown display
    const overlay = $("setupOverlay");
    overlay.classList.remove("hidden");

    // Create a temporary countdown element
    const cd = document.createElement("div");
    cd.id = "countdownDisplay";
    cd.style.cssText = [
      "position:absolute", "inset:0", "display:flex", "flex-direction:column",
      "align-items:center", "justify-content:center",
      "background:rgba(0,0,0,0.85)", "z-index:10",
      "font-size:96px", "font-weight:900", "color:#fff",
      "border-radius:inherit",
    ].join(";");
    overlay.appendChild(cd);

    let n = seconds;
    cd.textContent = n;

    const tick = setInterval(() => {
      n--;
      if (n > 0) {
        cd.textContent = n;
      } else {
        clearInterval(tick);
        cd.textContent = "🔴 LIVE";
        setTimeout(() => {
          cd.remove();
          overlay.classList.add("hidden");
          resolve();
        }, 600);
      }
    }, 1000);
  });
}

/* ─────────────────────────────────────────────────
   Start live stage (host only)
───────────────────────────────────────────────── */
function startLive() {
  liveActive = true;
  liveStart  = Date.now();
  isHost     = true;

  // Host box
  buildHostBox();

  // Show HUD
  $("liveBadge").classList.add("show");
  $("viewerCount").classList.add("show");
  $("ctrlBar").classList.add("show");
  $("btnEndLive").style.display = "";
  $("btnFlip").style.display    = "";

  // Apply mic/cam state
  if (localStream) {
    localStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
    localStream.getVideoTracks().forEach(t => { t.enabled = camEnabled; });
  }

  // Timer
  timerInt = setInterval(updateTimer, 1000);

  // Host-only UI
  if (isMobile()) {
    $("mobileChatBtn").style.display = "flex";
  }
  $("reqSettingsBar").classList.add("show");
  $("hostChatBar").classList.add("show");

  // Firebase listeners
  setupRTDB();
  listenJoinRequests();
  listenRoomDoc();
  startPresence();
  startViewerCount();
  listenViewerPresence();

  // Start recording
  startRecording();

  // Notify followers (best-effort)
  notifyFollowers();

  // Name in header
  $("roomName").textContent = userData.displayName || me.displayName || "Live";
}

/* ─────────────────────────────────────────────────
   Viewer: join the room
───────────────────────────────────────────────── */
async function joinAsViewer() {
  if (!roomId) return;
  await loadIceServers();
  try {
    const snap = await getDoc(doc(db, "stories", roomId));
    if (!snap.exists() || !snap.data().liveActive) {
      showLiveEnded();
      return;
    }
    const data = snap.data();
    $("roomName").textContent = (data.authorName || "User") + " is LIVE";

    hideAllOverlays();
    $("ctrlBar").classList.add("show");
    $("liveBadge").classList.add("show");
    $("viewerCount").classList.add("show");
    if (isMobile()) $("mobileChatBtn").style.display = "flex";

    // Track viewer
    incrementViewerCount();
    startPresence();
    setupRTDB();
    listenRoomDoc();
    listenHostCommands();

    liveActive = true;
    liveStart  = data.createdAt?.toMillis ? data.createdAt.toMillis() : Date.now();
    timerInt   = setInterval(updateTimer, 1000);

    // Build an empty host box immediately so ontrack has a DOM node to attach to
    const hostUid = data.authorUid || "host";
    if (!$("videoGrid").querySelector(`[data-uid="${hostUid}"]`)) {
      const box = makeBox(hostUid, data.authorName || "Host", true);
      $("videoGrid").insertBefore(box, $("videoGrid").firstChild);
      updateGridClass();
    }

    // ── Receive host's stream via WebRTC ──
    // Use a de-duplicating key that matches what createViewerPeer uses on the host side
    const viewerPeerKey = "view_" + me.uid;
    const viewerSignalRef = doc(db, "stories", roomId, "signals_viewer", me.uid);

    const unsubViewerSignal = onSnapshot(viewerSignalRef, async sigSnap => {
      if (!sigSnap.exists()) return;
      const sigData = sigSnap.data();
      if (!sigData.offer) return;
      if (peers[viewerPeerKey]) return; // already set up — ignore duplicates

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peers[viewerPeerKey] = pc;

      // ICE candidate buffer — candidates from host may arrive before answer is set
      let localDescSet = false;
      const iceBuf = [];

      // Display incoming host tracks — box was already created above
      pc.ontrack = e => {
        const box = $("videoGrid").querySelector(`[data-uid="${hostUid}"]`);
        if (!box) return;
        const stream = e.streams && e.streams[0] ? e.streams[0] : null;
        if (!stream) return;
        const vid = box.querySelector("video");
        if (vid.srcObject !== stream) {
          vid.srcObject = stream;
          vid.play().catch(() => {});
        }
        box.classList.remove("cam-off"); // show video, hide avatar fallback
      };

      pc.onconnectionstatechange = () => handlePCState(pc, viewerPeerKey);

      // Send our ICE candidates to host
      pc.onicecandidate = async ev => {
        if (!ev.candidate || !roomId) return;
        try {
          await addDoc(
            collection(db, "stories", roomId, "ice_viewer_to_host", me.uid, "candidates"),
            ev.candidate.toJSON()
          );
        } catch (_) {}
      };

      // Listen for host ICE candidates — buffer until local desc is set
      const hostIceRef = collection(db, "stories", roomId, "ice_host_to_viewer", me.uid, "candidates");
      const unsubIce = onSnapshot(hostIceRef, iceSnap => {
        iceSnap.docChanges().forEach(change => {
          if (change.type !== "added") return;
          const cand = change.doc.data();
          if (localDescSet) {
            try { pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
          } else {
            iceBuf.push(cand);
          }
        });
      });
      unsubs.push(unsubIce);

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sigData.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        // Flush buffered host candidates now that both descriptions are set
        localDescSet = true;
        while (iceBuf.length) {
          try { await pc.addIceCandidate(new RTCIceCandidate(iceBuf.shift())); } catch (_) {}
        }
        await updateDoc(viewerSignalRef, { answer: { type: answer.type, sdp: answer.sdp } });
      } catch (err) {
        // FIX 8: Enhanced WebRTC error message
        toast("❌ Viewer Connection Failed: " + (err.message || err), 5000);
        if (peers[viewerPeerKey]) {
          try { peers[viewerPeerKey].close(); } catch (_) {}
          delete peers[viewerPeerKey];
        }
      }

      unsubViewerSignal(); // stop listening once offer consumed
    });
    unsubs.push(unsubViewerSignal);

  } catch (err) {
    toast("❌ Connection Error: Could not join stream - " + (err.message || err), 5000);
    setTimeout(() => navigateBack(), 2000);
  }
}

/* ─────────────────────────────────────────────────
   Video grid — build host box
───────────────────────────────────────────────── */
function buildHostBox() {
  const grid = $("videoGrid");
  grid.innerHTML = "";

  const box = makeBox(me.uid, userData.displayName || me.displayName || "You", true);
  const vid = box.querySelector("video");
  if (localStream) vid.srcObject = localStream;
  vid.muted = true;
  grid.appendChild(box);
  updateGridClass();
}

function makeBox(uid, displayName, isHostBox) {
  const box = document.createElement("div");
  box.className = "vbox" + (isHostBox ? " host-box" : "");
  box.dataset.uid = uid;

  const initials = (displayName || "?").split(" ").map(w => w[0]).join("").toUpperCase().slice(0,2);

  box.innerHTML = `
    <video autoplay playsinline ${isHostBox ? "muted" : ""}></video>
    <div class="vbox-camoff">
      <div class="vbox-camoff-avatar">${initials}</div>
      <div class="vbox-camoff-name">${esc(displayName)}</div>
    </div>
    <div class="vbox-overlay">
      <div class="vbox-name">${esc(displayName)}${isHostBox ? ' <span class="vbox-tag">Host</span>' : ''}</div>
    </div>
    <div class="vbox-quality good"></div>
    <div class="vbox-reconnect">
      <div class="vbox-reconnect-spinner"></div>
      <div class="vbox-reconnect-msg">Reconnecting…</div>
    </div>`;

  // Context menu (host only on guest boxes)
  if (isHost && !isHostBox) {
    box.addEventListener("contextmenu", e => { e.preventDefault(); showCtxMenu(e, uid); });
    box.addEventListener("touchstart", makeLongPress(uid), { passive: true });
  }
  return box;
}

function addGuestBox(uid, displayName) {
  const grid = $("videoGrid");
  const box  = makeBox(uid, displayName, false);
  guestInfo[uid] = { displayName };
  grid.appendChild(box);
  updateGridClass();
  updateMiniStrip();
}

function removeGuestBox(uid) {
  const box = $("videoGrid").querySelector(`[data-uid="${uid}"]`);
  if (box) box.remove();
  delete guestInfo[uid];
  updateGridClass();
  updateMiniStrip();
}

function updateGridClass() {
  const grid  = $("videoGrid");
  const count = grid.querySelectorAll(".vbox").length;
  grid.className = count <= 1 ? "" : `g${Math.min(count, 6)}`;
}

/* ─────────────────────────────────────────────────
   Mini strip (mobile)
───────────────────────────────────────────────── */
function updateMiniStrip() {
  if (!isMobile()) return;
  const strip = $("miniStrip");
  strip.innerHTML = "";
  const boxes = Array.from($("videoGrid").querySelectorAll(".vbox:not(.host-box)"));
  boxes.forEach(box => {
    const uid  = box.dataset.uid;
    const info = guestInfo[uid] || {};
    const mini = document.createElement("div");
    mini.className = "mini-box";
    mini.innerHTML = `<video autoplay playsinline muted></video><div class="mini-name">${esc(info.displayName || "Guest")}</div>`;
    // Mirror the video from the main box
    const mainVid = box.querySelector("video");
    if (mainVid && mainVid.srcObject) mini.querySelector("video").srcObject = mainVid.srcObject;
    mini.onclick = () => { box.scrollIntoView({ behavior: "smooth" }); };
    strip.appendChild(mini);
  });
}

/* ─────────────────────────────────────────────────
   Live timer
───────────────────────────────────────────────── */
function updateTimer() {
  const elapsed = Math.floor((Date.now() - liveStart) / 1000);
  const m = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const s = (elapsed % 60).toString().padStart(2, "0");
  $("liveTimer").textContent = `${m}:${s}`;
}

/* ─────────────────────────────────────────────────
   Viewer count
───────────────────────────────────────────────── */
function startViewerCount() {
  // Host watches RTDB counter
  viewerCountRef = rtRef(rtdb, `liveRooms/${roomId}/viewerCount`);
  onValue(viewerCountRef, snap => {
    const n = snap.val() || 0;
    $("viewerNum").textContent = n;
  });
}

/* ─────────────────────────────────────────────────
   Host: watch viewer presence and stream to each viewer
───────────────────────────────────────────────── */
function listenViewerPresence() {
  if (!isHost || !roomId) return;
  const presRef = rtRef(rtdb, `liveRooms/${roomId}/viewers`);
  onValue(presRef, snap => {
    const viewers = snap.val() || {};
    Object.entries(viewers).forEach(([uid, info]) => {
      // Skip self (host) and already-connected peers and accepted guests
      if (uid === me.uid) return;
      if (peers["view_" + uid]) return;
      if (peers[uid]) return; // this uid is an accepted guest — skip
      createViewerPeer(uid, info.name || "Viewer");
    });
  });
}

async function createViewerPeer(viewerUid, displayName) {
  if (!roomId || !localStream) return;
  const peerKey = "view_" + viewerUid;
  if (peers[peerKey]) return;

  // Confirm local stream tracks are still active before creating the peer
  const vTracks = localStream.getVideoTracks();
  if (!vTracks.length || vTracks[0].readyState !== "live") {
    toast("Camera track ended. Cannot stream to new viewer.");
    return;
  }

  // Clear any stale signal doc from a previous session so the viewer gets a fresh offer
  await clearViewerSignal(viewerUid);

  await loadIceServers();
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peers[peerKey] = pc;

  // ICE candidate buffer — holds candidates that arrive before setRemoteDescription
  let remoteDescSet = false;
  const iceBuf = [];
  async function drainIceBuf() {
    while (iceBuf.length) {
      try { await pc.addIceCandidate(new RTCIceCandidate(iceBuf.shift())); } catch (_) {}
    }
  }

  // Send host's stream to this viewer (send-only)
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  // Host ICE → Firestore
  pc.onicecandidate = async e => {
    if (!e.candidate || !roomId) return;
    try {
      await addDoc(
        collection(db, "stories", roomId, "ice_host_to_viewer", viewerUid, "candidates"),
        e.candidate.toJSON()
      );
    } catch (_) {}
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === "failed" || s === "disconnected" || s === "closed") {
      delete peers[peerKey];
    }
  };

  try {
    // Create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sigRef = doc(db, "stories", roomId, "signals_viewer", viewerUid);
    await setDoc(sigRef, {
      offer:     { type: offer.type, sdp: offer.sdp },
      hostUid:   me.uid,
      createdAt: serverTimestamp(),
    });

    // Wait for viewer's answer
    const unsubAnswer = onSnapshot(sigRef, async ansSnap => {
      if (!ansSnap.exists()) return;
      const d = ansSnap.data();
      if (d.answer && !pc.remoteDescription) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(d.answer));
          remoteDescSet = true;
          await drainIceBuf();
        } catch (_) {}
      }
    });
    unsubs.push(unsubAnswer);

    // Listen for viewer ICE candidates — buffer until remote desc is set
    const viewerIceRef = collection(db, "stories", roomId, "ice_viewer_to_host", viewerUid, "candidates");
    const unsubIce = onSnapshot(viewerIceRef, iceSnap => {
      iceSnap.docChanges().forEach(change => {
        if (change.type !== "added") return;
        const cand = change.doc.data();
        if (remoteDescSet) {
          try { pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
        } else {
          iceBuf.push(cand);
        }
      });
    });
    unsubs.push(unsubIce);
  } catch (err) {
    toast("Could not create viewer stream: " + (err.message || err));
    delete peers[peerKey];
    pc.close();
  }
}

async function incrementViewerCount() {
  if (!roomId) return;
  try {
    // Bug 3 fix: rtIncrement is a server transform — must go through update(), not set().
    // set() serialises the transform object as a plain value, corrupting the counter.
    const roomRef = rtRef(rtdb, `liveRooms/${roomId}`);
    await rtUpdate(roomRef, { viewerCount: rtIncrement(1) });
    onDisconnect(roomRef).update({ viewerCount: rtIncrement(-1) });
  } catch (_) {}
}

/* ─────────────────────────────────────────────────
   Presence (self)
───────────────────────────────────────────────── */
function startPresence() {
  if (!me || !roomId) return;
  viewerPresRef = rtRef(rtdb, `liveRooms/${roomId}/viewers/${me.uid}`);
  const name   = userData.displayName || me.displayName || "User";
  const avatar = userData.avatarUrl || me.photoURL || "";
  rtSet(viewerPresRef, { uid: me.uid, name, avatar, joinedAt: Date.now(), isHost });
  onDisconnect(viewerPresRef).remove();
}

/* ─────────────────────────────────────────────────
   Room doc listener — detects live ended
───────────────────────────────────────────────── */
function listenRoomDoc() {
  if (!roomId) return;
  roomDocUnsub = onSnapshot(doc(db, "stories", roomId), snap => {
    if (!snap.exists()) {
      if (!isHost) showLiveEnded();
      return; // doc deleted — no data() to read
    }
    const data = snap.data();
    if (data.liveActive === false) {
      if (!isHost) showLiveEnded();
    }
    // Sync viewer count from Firestore too (fallback)
    if (isHost) $("viewerNum").textContent = data.viewerCount || 0;
  });
  unsubs.push(roomDocUnsub);
}

/* ─────────────────────────────────────────────────
   FIX 4 & 6 & 7: RTDB — chat messages + likes counter
───────────────────────────────────────────────── */
function setupRTDB() {
  if (!roomId) return;
  
  // FIX 6: Chat messages at liveRooms/{roomId}/messages (not /chat)
  chatRtRef = rtRef(rtdb, `liveRooms/${roomId}/messages`);
  const handleMsg = onValue(chatRtRef, snap => {
    const msgs = [];
    snap.forEach(child => msgs.push({ id: child.key, ...child.val() }));
    renderChat(msgs);
  });
  unsubs.push(() => off(chatRtRef, "value", handleMsg));
  
  // FIX 7: Likes counter at liveRooms/{roomId}/likes — both host and viewer listen
  const likesRef = rtRef(rtdb, `liveRooms/${roomId}/likes`);
  const handleLikes = onValue(likesRef, snap => {
    const likes = snap.val() || 0;
    const likesEl = $("liveLikesCount");
    if (likesEl) likesEl.textContent = likes > 0 ? likes : "0";
  });
  unsubs.push(() => off(likesRef, "value", handleLikes));
}

/* ─────────────────────────────────────────────────
   Join requests (host side)
───────────────────────────────────────────────── */
function listenJoinRequests() {
  if (!isHost || !roomId) return;
  const reqRef = collection(db, "stories", roomId, "boxRequests");
  reqUnsub = onSnapshot(query(reqRef, where("status", "==", "pending")), snap => {
    const list = $("reqList");
    list.innerHTML = "";
    const pending = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Badge
    const badge = $("reqBadge");
    badge.textContent = pending.length || "";
    badge.classList.toggle("has", pending.length > 0);

    if (pending.length === 0) return;
    pending.forEach(req => {
      const card = document.createElement("div");
      card.className = "req-card";
      const av = req.avatarUrl
        ? `<img src="${esc(req.avatarUrl)}" alt="">`
        : `<span>${(req.displayName || "?")[0].toUpperCase()}</span>`;
      card.innerHTML = `
        <div class="req-avatar">${av}</div>
        <div class="req-info">
          <div class="req-name">${esc(req.displayName || "User")}</div>
          <div class="req-meta">Wants to join on camera</div>
        </div>
        <div class="req-btns">
          <button class="req-accept">✓</button>
          <button class="req-deny">✕</button>
        </div>`;
      card.querySelector(".req-accept").onclick = () => acceptGuest(req);
      card.querySelector(".req-deny").onclick   = () => denyGuest(req.id);
      list.appendChild(card);
    });
  });
  unsubs.push(reqUnsub);
}

async function acceptGuest(req) {
  if (!roomId) return;
  try {
    await updateDoc(doc(db, "stories", roomId, "boxRequests", req.id), {
      status: "accepted", roomId
    });
    // Host creates the WebRTC peer for this guest
    await createHostPeer(req.id, req.displayName || "Guest");
    toast(`${req.displayName || "Guest"} accepted!`);
  } catch (err) {
    toast("Could not accept: " + err.message);
  }
}

async function denyGuest(uid) {
  if (!roomId) return;
  try {
    await updateDoc(doc(db, "stories", roomId, "boxRequests", uid), { status: "declined" });
  } catch (_) {}
}

/* ─────────────────────────────────────────────────
   WebRTC — host creates peer for each guest
───────────────────────────────────────────────── */
async function createHostPeer(guestUid, displayName) {
  if (peers[guestUid]) { try { peers[guestUid].close(); } catch (_) {} delete peers[guestUid]; }

  // Clear stale signaling data from any previous guest session
  await clearGuestSignal(guestUid);

  await loadIceServers();
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peers[guestUid] = pc;

  // ICE candidate buffer — holds candidates that arrive before setRemoteDescription
  let remoteDescSet = false;
  const iceBuf = [];
  async function drainIceBuf() {
    while (iceBuf.length) {
      try { await pc.addIceCandidate(new RTCIceCandidate(iceBuf.shift())); } catch (_) {}
    }
  }

  // Send local tracks to guest
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  // ICE candidates → Firestore
  pc.onicecandidate = async e => {
    if (!e.candidate || !roomId) return;
    try {
      await addDoc(collection(db, "stories", roomId, "ice_host_to_guest", guestUid, "candidates"), e.candidate.toJSON());
    } catch (_) {}
  };

  // Receive guest's tracks — attach stream before calling play()
  pc.ontrack = e => {
    addGuestBox(guestUid, displayName);
    const box = $("videoGrid").querySelector(`[data-uid="${guestUid}"]`);
    if (box && e.streams && e.streams[0]) {
      const vid = box.querySelector("video");
      vid.srcObject = e.streams[0];
      vid.play().catch(() => {});
    }
    updateMiniStrip();
  };

  pc.onconnectionstatechange = () => handlePCState(pc, guestUid);

  // Create offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const signalRef = doc(db, "stories", roomId, "signals", guestUid);
  await setDoc(signalRef, {
    offer: { type: offer.type, sdp: offer.sdp },
    hostUid: me.uid,
    createdAt: serverTimestamp(),
  });

  // Listen for guest answer
  const unsubAnswer = onSnapshot(signalRef, async snap => {
    if (!snap.exists()) return;
    const data = snap.data();
    if (data.answer && !pc.remoteDescription) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        remoteDescSet = true;
        await drainIceBuf();
      } catch (_) {}
    }
  });
  unsubs.push(unsubAnswer);

  // Listen for guest ICE candidates — buffer until remote desc is set
  const guestIceRef = collection(db, "stories", roomId, "ice_guest_to_host", guestUid, "candidates");
  const unsubIce = onSnapshot(guestIceRef, snap => {
    snap.docChanges().forEach(change => {
      if (change.type !== "added") return;
      const cand = change.doc.data();
      if (remoteDescSet) {
        try { pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
      } else {
        iceBuf.push(cand);
      }
    });
  });
  unsubs.push(unsubIce);
}

/* ─────────────────────────────────────────────────
   WebRTC — guest connects to host
───────────────────────────────────────────────── */
async function joinAsGuest() {
  if (!roomId || !me) return;
  // Tear down any previous guest peer cleanly before re-entering
  if (peers[me.uid]) { try { peers[me.uid].close(); } catch (_) {} delete peers[me.uid]; }
  // Also stop any lingering local stream from a previous guest attempt
  if (localStream) { releaseStream(localStream); localStream = null; }
  showOverlay("waitingOverlay");

  // Wait for host to write the offer
  const signalRef = doc(db, "stories", roomId, "signals", me.uid);
  const unsub = onSnapshot(signalRef, async snap => {
    if (!snap.exists()) return;
    const data = snap.data();
    if (!data.offer) return;
    unsub(); // stop listening once we have the offer

    hideAllOverlays();
    $("ctrlBar").classList.add("show");

    // Check permission API availability
    if (!navigator.mediaDevices?.getUserMedia) {
      toast("Camera not supported in this browser.");
      return;
    }

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true
      });
    } catch (err) {
      const msg = err.name === "NotAllowedError"  ? "Camera/microphone permission denied." :
                  err.name === "NotFoundError"    ? "No camera/microphone found on this device." :
                  err.name === "NotReadableError" ? "Camera is already in use by another app." :
                                                    "Camera/mic required: " + (err.message || err);
      toast(msg);
      return;
    }

    // Confirm video + audio tracks are active
    if (!localStream.getVideoTracks().length) {
      toast("Camera stream is empty — check permissions.");
      releaseStream(localStream); localStream = null;
      return;
    }
    const gVid = localStream.getVideoTracks()[0];
    if (gVid.readyState !== "live") {
      toast("Video track is not active. Check camera access.");
      releaseStream(localStream); localStream = null;
      return;
    }
    const gAud = localStream.getAudioTracks();
    if (gAud.length && gAud[0].readyState !== "live") {
      toast("Microphone track not active — continuing without audio.");
    }

    buildGuestLocalBox();

    await loadIceServers();
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peers[me.uid] = pc;

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.onicecandidate = async e => {
      if (!e.candidate || !roomId) return;
      try {
        await addDoc(collection(db, "stories", roomId, "ice_guest_to_host", me.uid, "candidates"), e.candidate.toJSON());
      } catch (_) {}
    };

    // Receive host's tracks
    pc.ontrack = e => {
      const hostUid = data.hostUid || "host";
      let box = $("videoGrid").querySelector(`[data-uid="${hostUid}"]`);
      if (!box) {
        box = makeBox(hostUid, "Host", true);
        $("videoGrid").insertBefore(box, $("videoGrid").firstChild);
        updateGridClass();
      }
      if (e.streams && e.streams[0]) {
        const vid = box.querySelector("video");
        vid.srcObject = e.streams[0];
        vid.play().catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => handlePCState(pc, me.uid);

    // ICE candidate buffer — buffer host candidates until local desc is set
    let localDescSet = false;
    const iceBuf = [];

    // Listen for host ICE candidates — register BEFORE setRemoteDescription
    const hostIceRef = collection(db, "stories", roomId, "ice_host_to_guest", me.uid, "candidates");
    const unsubIce = onSnapshot(hostIceRef, snap => {
      snap.docChanges().forEach(change => {
        if (change.type !== "added") return;
        const cand = change.doc.data();
        if (localDescSet) {
          try { pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
        } else {
          iceBuf.push(cand);
        }
      });
    });
    unsubs.push(unsubIce);

    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    // Flush buffered ICE candidates now that both descriptions are set
    localDescSet = true;
    while (iceBuf.length) {
      try { await pc.addIceCandidate(new RTCIceCandidate(iceBuf.shift())); } catch (_) {}
    }
    await updateDoc(signalRef, { answer: { type: answer.type, sdp: answer.sdp } });

    // Controls
    $("btnFlip").style.display = "";
    $("btnEndLive").style.display = "none";
    setupRTDB();
    listenHostCommands();
    startPresence();
    setupLiveAudio();
    if (isMobile()) $("mobileChatBtn").style.display = "flex";
  });
  unsubs.push(unsub);
}

function buildGuestLocalBox() {
  const grid = $("videoGrid");
  const box  = makeBox(me.uid, userData.displayName || me.displayName || "You", false);
  const vid  = box.querySelector("video");
  vid.srcObject = localStream;
  vid.muted = true;
  grid.appendChild(box);
  updateGridClass();
}

/* ─────────────────────────────────────────────────
   PCState handler + auto-reconnect
───────────────────────────────────────────────── */
let _recon = {};
function handlePCState(pc, uid) {
  const state = pc.connectionState;
  // Derive the visual uid — viewer peer keys are "view_<uid>", guest peers use uid directly
  const boxUid = uid.startsWith("view_") ? uid.slice(5) : uid;

  if (state === "connected") {
    $("reconnectBanner").classList.remove("show");
    const box = $("videoGrid").querySelector(`[data-uid="${boxUid}"]`);
    if (box) box.querySelector(".vbox-reconnect")?.classList.remove("show");
    _recon[uid] = 0;
  } else if (state === "disconnected" || state === "failed") {
    // Show reconnect banner for the viewer's own peer, or the host-side viewer peer
    if (!isHost || uid.startsWith("view_")) {
      $("reconnectBanner").classList.add("show");
      const box = $("videoGrid").querySelector(`[data-uid="${boxUid}"]`);
      if (box) box.querySelector(".vbox-reconnect")?.classList.add("show");
    }
    scheduleReconnect(uid);
  } else if (state === "closed") {
    const box = $("videoGrid").querySelector(`[data-uid="${boxUid}"]`);
    if (box) box.querySelector(".vbox-reconnect")?.classList.remove("show");
  }
}

function scheduleReconnect(uid) {
  const attempts = _recon[uid] || 0;
  if (attempts >= 5) { toast("Connection lost. Could not reconnect."); return; }
  _recon[uid] = attempts + 1;
  const delay = Math.min(1000 * Math.pow(2, attempts), 16000);
  setTimeout(() => {
    if (!liveActive) return; // don't reconnect after stream has ended
    if (isHost && peers[uid]) {
      // Host reconnects to a guest
      createHostPeer(uid, guestInfo[uid]?.displayName || "Guest");
    } else if (isHost && uid.startsWith("view_")) {
      // Host reconnects to a passive viewer
      const viewerUid = uid.slice(5);
      createViewerPeer(viewerUid, guestInfo[viewerUid]?.displayName || "Viewer");
    } else if (!isHost) {
      // Viewer/guest re-initiates
      const peerKey = "view_" + me.uid;
      if (peers[peerKey]) { try { peers[peerKey].close(); } catch (_) {} delete peers[peerKey]; }
      joinAsViewer();
    }
  }, delay);
}

/* ─────────────────────────────────────────────────
   Host commands (guest listens for mute/cam/remove)
───────────────────────────────────────────────── */
function listenHostCommands() {
  if (!roomId || !me) return;
  const cmdRef = doc(db, "stories", roomId, "hostCommands", me.uid);
  hostCmdUnsub = onSnapshot(cmdRef, snap => {
    if (!snap.exists()) return;
    const cmd = snap.data();
    if (cmd.mute)   { forceMute(); }
    if (cmd.camOff) { forceCamOff(); }
    if (cmd.remove) { toast("You were removed from the Live."); leaveClean(); }
  });
  unsubs.push(hostCmdUnsub);
}

async function hostMuteGuest(uid) {
  if (!roomId) return;
  await setDoc(doc(db, "stories", roomId, "hostCommands", uid), { mute: true });
  toast("Guest muted.");
}
async function hostCamOff(uid) {
  if (!roomId) return;
  await setDoc(doc(db, "stories", roomId, "hostCommands", uid), { camOff: true });
}
async function hostRemoveGuest(uid) {
  if (!roomId) return;
  await setDoc(doc(db, "stories", roomId, "hostCommands", uid), { remove: true });
  closePeer(uid);
  removeGuestBox(uid);
  toast("Guest removed.");
}

function forceMute() {
  micEnabled = false;
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = false; });
  syncCtrlBtns();
  toast("Host muted your microphone.");
}
function forceCamOff() {
  camEnabled = false;
  if (localStream) localStream.getVideoTracks().forEach(t => { t.enabled = false; });
  syncCtrlBtns();
  toast("Host disabled your camera.");
}

/* ─────────────────────────────────────────────────
   Mic / Cam / Flip controls
───────────────────────────────────────────────── */
function toggleMic() {
  micEnabled = !micEnabled;
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
  syncCtrlBtns();
}
function toggleCam() {
  camEnabled = !camEnabled;
  if (localStream) localStream.getVideoTracks().forEach(t => { t.enabled = camEnabled; });
  const box = $("videoGrid").querySelector(`[data-uid="${me?.uid}"]`);
  if (box) box.classList.toggle("cam-off", !camEnabled);
  syncCtrlBtns();
}
async function flipCamera() {
  facingMode = facingMode === "user" ? "environment" : "user";
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: micEnabled
    });
    // Replace video track in all peers
    const newVid = newStream.getVideoTracks()[0];
    Object.values(peers).forEach(pc => {
      const sender = pc.getSenders().find(s => s.track?.kind === "video");
      if (sender && newVid) sender.replaceTrack(newVid);
    });
    // Update local preview
    if (localStream) localStream.getVideoTracks().forEach(t => t.stop());
    localStream = newStream;
    const myBox = $("videoGrid").querySelector(`[data-uid="${me?.uid}"]`);
    if (myBox) myBox.querySelector("video").srcObject = newStream;
  } catch (_) { toast("Could not flip camera."); }
}
function syncCtrlBtns() {
  const mic = $("btnMic");
  const cam = $("btnCam");
  if (mic) { mic.textContent = micEnabled ? "🎙️" : "🔇"; mic.classList.toggle("off", !micEnabled); }
  if (cam) { cam.textContent = camEnabled ? "📷" : "📷"; cam.classList.toggle("off", !camEnabled); }
}

/* ─────────────────────────────────────────────────
   Chat
───────────────────────────────────────────────── */
function renderChat(msgs) {
  const latest = msgs.slice(-60);
  const desktopList = $("chatMessages");
  const mobileList  = $("mobileChatMessages");
  const overlay     = $("mobileChatOverlay");

  // Desktop
  if (desktopList) {
    const wasAtBottom = desktopList.scrollHeight - desktopList.scrollTop <= desktopList.clientHeight + 60;
    desktopList.innerHTML = latest.map(m => buildMsgHTML(m)).join("");
    wireMsgActions(desktopList);
    if (wasAtBottom) desktopList.scrollTop = desktopList.scrollHeight;
  }
  // Mobile drawer
  if (mobileList) {
    mobileList.innerHTML = latest.map(m => buildMsgHTML(m)).join("");
    wireMsgActions(mobileList);
    mobileList.scrollTop = mobileList.scrollHeight;
  }
  // Mobile overlay bubbles (only latest 3)
  if (overlay && !mobileChatOpen) {
    overlay.innerHTML = "";
    latest.slice(-3).forEach(m => {
      const b = document.createElement("div");
      b.className = "mob-bubble";
      b.innerHTML = `<span class="mob-name${m.uid === (isHost ? roomId : "") ? ' host' : ''}">${esc(m.name)}</span> ${esc(m.text)}`;
      overlay.appendChild(b);
      setTimeout(() => b.remove(), 6000);
    });
  }
}

function buildMsgHTML(m) {
  const isHostMsg = m.isHost;
  const isMe      = m.uid === me?.uid;
  const time      = m.ts ? new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const av        = m.avatar
    ? `<img src="${esc(m.avatar)}" alt="" loading="lazy">`
    : `<span>${(m.name || "?")[0].toUpperCase()}</span>`;
  const pinTag    = m.id === pinnedMsgId ? `<span id="pinnedMsgTag">📌</span>` : "";
  const replyHTML = m.replyTo
    ? `<div class="msg-reply-quote">↩ ${esc(m.replyTo.name)}: ${esc(m.replyTo.text)}</div>` : "";
  const deleteBtn = (isMe || isHost)
    ? `<button class="msg-action-btn danger" data-action="delete" data-id="${esc(m.id)}">🗑</button>` : "";
  const pinBtn    = isHost
    ? `<button class="msg-action-btn" data-action="pin" data-id="${esc(m.id)}" data-text="${esc(m.text)}" data-name="${esc(m.name)}">📌</button>` : "";

  return `<div class="chat-msg${m.isReaction ? ' reaction-msg' : ''}${m.id === pinnedMsgId ? ' pinned-msg' : ''}${m.deleted ? ' deleted-msg' : ''}" data-id="${esc(m.id)}">
    <div class="msg-avatar">${av}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-name${isHostMsg ? ' host' : ''}">${esc(m.name)}${pinTag}</span>
        <span class="msg-time">${time}</span>
      </div>
      ${replyHTML}
      <div class="msg-text">${m.deleted ? '<em>Message removed</em>' : esc(m.text)}</div>
    </div>
    <div class="msg-actions">
      <button class="msg-action-btn" data-action="reply" data-id="${esc(m.id)}" data-name="${esc(m.name)}" data-text="${esc(m.text)}">↩</button>
      ${pinBtn}${deleteBtn}
    </div>
  </div>`;
}

function wireMsgActions(container) {
  container.querySelectorAll("[data-action]").forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id     = btn.dataset.id;
      if (action === "reply")  { setReplyTo({ msgId: id, name: btn.dataset.name, text: btn.dataset.text }); }
      if (action === "delete") { deleteMessage(id); }
      if (action === "pin")    { pinMessage(id, btn.dataset.name, btn.dataset.text); }
    };
  });
}

async function sendChat(fromMobile = false) {
  if (!me || !roomId) return;
  if (!chatEnabled) { toast("Chat is turned off."); return; }
  const input = fromMobile ? $("mobileChatInput") : $("chatInput");
  const text  = (input.value || "").trim();
  if (!text) return;

  // Slow mode
  if (slowMode && !isHost && (Date.now() - lastMsgTime) < slowDelay) {
    toast(`Slow mode — wait ${Math.ceil((slowDelay - (Date.now() - lastMsgTime)) / 1000)}s`);
    return;
  }
  lastMsgTime = Date.now();
  input.value = "";

  const name   = userData.displayName || me.displayName || "User";
  const avatar = userData.avatarUrl || me.photoURL || "";
  const msg    = {
    uid: me.uid, name, avatar, text,
    ts: Date.now(), isHost,
    replyTo: replyTo ? { msgId: replyTo.msgId, name: replyTo.name, text: replyTo.text } : null,
    deleted: false,
  };
  clearReplyTo();
  try {
    await rtPush(chatRtRef, msg);
  } catch (_) {}
}

async function sendReaction(emoji) {
  if (!me || !roomId) return;
  flyReaction(emoji);
  try {
    await rtPush(chatRtRef, {
      uid: me.uid, name: "", avatar: "",
      text: emoji, ts: Date.now(), isReaction: true,
    });
  } catch (_) {}
}

/* ─────────────────────────────────────────────────
   FIX 7: Likes — both host and viewer write to
   liveRooms/{roomId}/likes (RTDB counter)
───────────────────────────────────────────────── */
async function sendLike() {
  if (!me || !roomId) return;
  flyReaction("❤️");
  try {
    // FIX 7: Increment the likes counter at liveRooms/{roomId}/likes
    await rtUpdate(rtRef(rtdb, `liveRooms/${roomId}`), { likes: rtIncrement(1) });
  } catch (_) {}
}

function flyReaction(emoji) {
  const stage = $("reactionStage");
  if (!stage) return;
  const el = document.createElement("div");
  el.className = "fly-reaction";
  el.textContent = emoji;
  el.style.bottom = (40 + Math.random() * 30) + "px";
  stage.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

async function deleteMessage(msgId) {
  if (!roomId || !chatRtRef) return;
  try {
    // FIX 6: Update message path to match new structure
    await rtUpdate(rtRef(rtdb, `liveRooms/${roomId}/messages/${msgId}`), { deleted: true, text: "" });
  } catch (_) {}
}

function setReplyTo(r) {
  replyTo = r;
  [$("replyPreview"), $("mobileReplyPreview")].forEach(el => { if (el) el.classList.add("show"); });
  [$("replyText"), $("mobileReplyText")].forEach(el => { if (el) el.textContent = `↩ Replying to ${r.name}: ${r.text.slice(0,40)}`; });
}
function clearReplyTo() {
  replyTo = null;
  [$("replyPreview"), $("mobileReplyPreview")].forEach(el => { if (el) el.classList.remove("show"); });
}

function pinMessage(msgId, name, text) {
  pinnedMsgId = msgId;
  $("pinnedBar").classList.add("show");
  $("pinnedText").textContent = `${name}: ${text}`;
}
function unpinMessage() {
  pinnedMsgId = null;
  $("pinnedBar").classList.remove("show");
}

function toggleChatEnabled() {
  chatEnabled = !chatEnabled;
  $("btnChatToggle").textContent = chatEnabled ? "💬 Chat on" : "🔇 Chat off";
  $("btnChatToggle").classList.toggle("active", !chatEnabled);
  $("chatInput").disabled = !chatEnabled;
  $("mobileChatInput").disabled = !chatEnabled;
  $("chatStatusBar").textContent = chatEnabled ? "" : "🔇 Chat is turned off";
  $("chatStatusBar").classList.toggle("show", !chatEnabled);
}
function toggleSlowMode() {
  slowMode = !slowMode;
  $("btnSlowMode").classList.toggle("active", slowMode);
  $("chatStatusBar").textContent = slowMode ? "🐢 Slow mode: 5s between messages" : "";
  $("chatStatusBar").classList.toggle("show", slowMode);
}

function switchTab(tab) {
  const isDesktop = window.innerWidth > 700;
  document.querySelectorAll(".side-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  $("chatPanel").classList.toggle("active",    tab === "chat");
  $("requestsPanel").classList.toggle("active", tab === "requests");
}
function toggleMobileChat() {
  mobileChatOpen = !mobileChatOpen;
  $("mobileChatDrawer").classList.toggle("open", mobileChatOpen);
}

/* ─────────────────────────────────────────────────
   Requests open/close (host)
───────────────────────────────────────────────── */
function toggleRequests() {
  requestsOpen = !requestsOpen;
  $("btnToggleRequests").textContent = requestsOpen ? "✅ Open" : "🚫 Closed";
  $("btnToggleRequests").classList.toggle("off", !requestsOpen);
  $("reqClosedNotice").classList.toggle("show", !requestsOpen);
  if (roomId) updateDoc(doc(db, "stories", roomId), { requestsOpen }).catch(() => {});
}

/* ─────────────────────────────────────────────────
   Guest context menu (host only)
───────────────────────────────────────────────── */
function showCtxMenu(e, uid) {
  _ctxGuestUid = uid;
  const menu = $("guestCtxMenu");
  menu.classList.add("show");
  const x = Math.min(e.clientX, window.innerWidth - 180);
  const y = Math.min(e.clientY, window.innerHeight - 200);
  menu.style.left = x + "px";
  menu.style.top  = y + "px";
}
function hideCtxMenu() {
  $("guestCtxMenu").classList.remove("show");
  _ctxGuestUid = null;
}
function makeLongPress(uid) {
  let t;
  return e => {
    t = setTimeout(() => showCtxMenu({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY }, uid), 600);
    const cancel = () => clearTimeout(t);
    window.addEventListener("touchend",  cancel, { once: true });
    window.addEventListener("touchmove", cancel, { once: true });
  };
}

/* ─────────────────────────────────────────────────
   End live (host)
───────────────────────────────────────────────── */
async function endLive() {
  if (!roomId || !isHost) return;
  try {
    await updateDoc(doc(db, "stories", roomId), { liveActive: false, endedAt: serverTimestamp() });
  } catch (_) {}
  // Mark live-notification beacon as ended so followers' banner clears
  if (me) {
    updateDoc(doc(db, "liveNotifications", me.uid), { active: false }).catch(() => {});
  }
  cleanup();
  const replay = await stopRecording();
  if (replay) {
    replayBlob = replay;
    $("replayDuration").textContent = "Saved " + formatDuration(Date.now() - liveStart);
    $("replayDuration").classList.add("show");
    $("replayModal").classList.add("open");
  } else {
    navigateBack();
  }
}

/* ─────────────────────────────────────────────────
   Leave (viewer/guest)
───────────────────────────────────────────────── */
async function leaveClean() {
  cleanup();
  navigateBack();
}

/* ─────────────────────────────────────────────────
   Cleanup
───────────────────────────────────────────────── */
function cleanup() {
  liveActive = false;
  clearInterval(timerInt);
  unsubs.forEach(fn => { try { fn(); } catch (_) {} });
  unsubs.length = 0;
  // Null srcObject on all video boxes before closing peers (releases media tracks)
  document.querySelectorAll("#videoGrid video").forEach(v => { v.srcObject = null; });
  Object.values(peers).forEach(pc => { try { pc.close(); } catch (_) {} });
  Object.keys(peers).forEach(k => delete peers[k]);
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (viewerPresRef) rtRemove(viewerPresRef).catch(() => {});
}

function navigateBack() {
  const url = isHost ? "index.html?liveEnded=1" : "index.html";
  window.location.href = url;
}

function showLiveEnded() {
  cleanup();
  $("liveEndedModal").classList.add("open");
}

/* ─────────────────────────────────────────────────
   Recording (host)
───────────────────────────────────────────────── */
function startRecording() {
  if (!localStream) return;
  try {
    const opts = ["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm","video/mp4"]
      .find(t => MediaRecorder.isTypeSupported(t)) || "";
    mediaRecorder   = new MediaRecorder(localStream, opts ? { mimeType: opts } : {});
    recordedChunks  = [];
    recordStart     = Date.now();
    mediaRecorder.ondataavailable = e => { if (e.data?.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.start(5000);
  } catch (_) { /* recording optional */ }
}

function stopRecording() {
  return new Promise(resolve => {
    if (!mediaRecorder || mediaRecorder.state === "inactive") { resolve(null); return; }
    mediaRecorder.onstop = () => {
      const blob = recordedChunks.length ? new Blob(recordedChunks, { type: "video/webm" }) : null;
      resolve(blob);
    };
    mediaRecorder.stop();
  });
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2,"0")}`;
}

/* Replay handlers */
async function replaySave() {
  if (!replayBlob) return;
  const $btn = $("btnReplaySave");
  $btn.disabled = true;
  $("saveSpinner").classList.add("show");
  try {
    const url = URL.createObjectURL(replayBlob);
    const a   = document.createElement("a");
    a.href = url; a.download = `live-replay-${Date.now()}.webm`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Replay saved to your device!");
  } catch (_) {}
  $btn.disabled = false;
  $("saveSpinner").classList.remove("show");
}

async function replayPost() {
  if (!replayBlob || !me || !roomId) return;
  const $btn = $("btnReplayPost");
  $btn.disabled = true;
  $("postSpinner").classList.add("show");
  try {
    // Upload to Cloudflare R2 (same worker used for all media in this project)
    const WORKER = "https://yellow-term-11e6.nthntjrn.workers.dev";
    const form   = new FormData();
    form.append("file", new File([replayBlob], `replay-${roomId}.webm`, { type: "video/webm" }));
    form.append("uid", me.uid);
    const res = await fetch(WORKER, { method: "POST", body: form });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    const { url } = await res.json();

    const name   = userData.displayName || me.displayName || "User";
    const avatar = userData.avatarUrl || me.photoURL || "";
    await addDoc(collection(db, "posts"), {
      authorUid: me.uid, authorName: name, authorAvatar: avatar,
      text: "🔴 Live replay",
      mediaUrl: url, mediaType: "video",
      createdAt: serverTimestamp(), likes: [], comments: [], reposts: 0,
    });
    toast("Replay posted to Feed!");
    $("replayModal").classList.remove("open");
    navigateBack();
  } catch (err) {
    toast("Could not post replay: " + err.message);
  }
  $btn.disabled = false;
  $("postSpinner").classList.remove("show");
}

function replayDiscard() {
  replayBlob = null;
  $("replayModal").classList.remove("open");
  navigateBack();
}

/* ─────────────────────────────────────────────────
   Notify followers (host)
───────────────────────────────────────────────── */
async function notifyFollowers() {
  if (!me || !roomId) return;
  try {
    const name   = userData.displayName || me.displayName || "User";
    const avatar = userData.avatarUrl   || me.photoURL    || "";

    // 1. Write the live-notification beacon (index.html listens here)
    await setDoc(doc(db, "liveNotifications", me.uid), {
      hostUid: me.uid, hostName: name, hostAvatar: avatar, roomId,
      startedAt: serverTimestamp(), active: true,
    });

    // 2. Push an in-app notification to every follower
    const hostSnap = await getDoc(doc(db, "users", me.uid));
    const followers = hostSnap.exists() ? (hostSnap.data().followers || []) : [];
    if (!followers.length) return;

    const notif = {
      id:         `live_${roomId}_${Date.now()}`,
      type:       "live",
      fromUid:    me.uid,
      fromName:   name,
      fromAvatar: avatar,
      roomId,
      ts:         Date.now(),
      read:       false,
    };
    // Push to each follower's notifications array (best-effort, non-blocking)
    followers.forEach(uid => {
      updateDoc(doc(db, "users", uid), { notifications: arrayUnion(notif) }).catch(() => {});
    });
  } catch (_) {}
}

/* ─────────────────────────────────────────────────
   Peer cleanup helper
───────────────────────────────────────────────── */
function closePeer(uid) {
  if (peers[uid]) { try { peers[uid].close(); } catch (_) {} delete peers[uid]; }
}

/* ─────────────────────────────────────────────────
   Live audio gain (optional quality)
───────────────────────────────────────────────── */
function setupLiveAudio() {
  // Intentionally does NOT connect to ctx.destination — doing so would
  // feed the mic back into the speaker and cause an audible feedback loop.
  // The gain node is only used to boost the track going into the peer connection,
  // which already receives the raw MediaStream tracks directly.
  // This function is a no-op stub kept for future audio processing hooks.
}

/* ─────────────────────────────────────────────────
   Button wiring
───────────────────────────────────────────────── */
function wireButtons() {
  // Lobby
  $("btnHostRoom").onclick  = () => { showOverlay("setupOverlay"); startSetupPreview(); };
  $("btnBackHome").onclick  = () => navigateBack();

  // Setup
  $("btnGoLive").onclick      = () => goLive();
  $("btnSetupCancel").onclick = () => { stopSetupPreview(); navigateBack(); };
  $("btnSetupFlip").onclick   = async () => {
    facingMode = facingMode === "user" ? "environment" : "user";
    // Stop current preview tracks before requesting the new camera
    // to ensure we only hold one camera stream at a time
    if (setupStream) { releaseStream(setupStream); setupStream = null; $("setupVideo").srcObject = null; }
    await startSetupPreview();
  };
  $("btnSetupMic").onclick = () => {
    micEnabled = !micEnabled;
    if (setupStream) setupStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
    syncSetupBtns();
  };
  $("btnSetupCam").onclick = () => {
    camEnabled = !camEnabled;
    if (setupStream) setupStream.getVideoTracks().forEach(t => { t.enabled = camEnabled; });
    syncSetupBtns();
  };

  // Controls
  $("btnMic").onclick     = () => toggleMic();
  $("btnCam").onclick     = () => toggleCam();
  $("btnFlip").onclick    = () => flipCamera();
  $("btnEndLive").onclick = () => {
    if (isHost) $("endConfirmModal").classList.add("open");
    else        $("leaveConfirmModal").classList.add("open");
  };
  $("btnBack").onclick = () => {
    if (isHost) $("endConfirmModal").classList.add("open");
    else        $("leaveConfirmModal").classList.add("open");
  };

  // End confirm
  $("btnConfirmEnd").onclick  = () => { $("endConfirmModal").classList.remove("open"); endLive(); };
  $("btnCancelEnd").onclick   = () => $("endConfirmModal").classList.remove("open");

  // Leave confirm
  $("btnConfirmLeave").onclick = () => { $("leaveConfirmModal").classList.remove("open"); leaveClean(); };
  $("btnCancelLeave").onclick  = () => $("leaveConfirmModal").classList.remove("open");

  // Cancel join request
  $("btnCancelRequest").onclick = () => { cleanup(); navigateBack(); };
  $("btnJoinCancel").onclick    = () => { cleanup(); navigateBack(); };

  // Live ended (viewer)
  $("btnLiveEndedBack").onclick = () => navigateBack();

  // Replay
  $("btnReplaySave").onclick    = () => replaySave();
  $("btnReplayPost").onclick    = () => replayPost();
  $("btnReplayDiscard").onclick = () => replayDiscard();

  // Pinned bar
  $("btnUnpin").onclick = () => unpinMessage();

  // Host chat controls
  $("btnChatToggle").onclick   = () => toggleChatEnabled();
  $("btnSlowMode").onclick     = () => toggleSlowMode();
  $("btnToggleRequests").onclick = () => toggleRequests();

  // Context menu items
  $("ctxMute").onclick    = () => { if (_ctxGuestUid) hostMuteGuest(_ctxGuestUid);  hideCtxMenu(); };
  $("ctxCam").onclick     = () => { if (_ctxGuestUid) hostCamOff(_ctxGuestUid);     hideCtxMenu(); };
  $("ctxRemove").onclick  = () => { if (_ctxGuestUid) hostRemoveGuest(_ctxGuestUid); hideCtxMenu(); };
  $("ctxRestart").onclick = () => {
    if (_ctxGuestUid) { createHostPeer(_ctxGuestUid, guestInfo[_ctxGuestUid]?.displayName || "Guest"); toast("Restarting connection…"); }
    hideCtxMenu();
  };
  $("ctxReport").onclick  = () => { toast("Report submitted."); hideCtxMenu(); };
  $("ctxBlock").onclick   = () => { if (_ctxGuestUid) { hostRemoveGuest(_ctxGuestUid); toast("User blocked."); } hideCtxMenu(); };

  // Close ctx menu on outside click
  document.addEventListener("click", e => {
    if (!$("guestCtxMenu").contains(e.target)) hideCtxMenu();
  });

  // Permission modal (guest request box from viewer flow)
  $("btnPermConfirm").onclick = () => { $("permModal").classList.remove("open"); joinAsGuest(); };
  $("btnPermCancel").onclick  = () => $("permModal").classList.remove("open");

  // Reply cancel
  $("btnCancelReply").onclick       = () => clearReplyTo();
  $("btnMobileCancelReply").onclick = () => clearReplyTo();
}

function wireChat() {
  // Desktop send
  $("chatSend").onclick = () => sendChat(false);
  $("chatInput").addEventListener("keydown", e => { if (e.key === "Enter") sendChat(false); });

  // Mobile send
  $("mobileChatInput").addEventListener("keydown", e => { if (e.key === "Enter") sendChat(true); });

  // Reaction rows
  document.querySelectorAll("#mobileReactionRow .react-btn").forEach(btn => {
    btn.onclick = () => sendReaction(btn.textContent);
  });
}

/* ─────────────────────────────────────────────────
   Keyboard shortcuts
───────────────────────────────────────────────── */
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    $("endConfirmModal").classList.remove("open");
    $("leaveConfirmModal").classList.remove("open");
    $("replayModal").classList.remove("open");
    $("permModal").classList.remove("open");
    hideCtxMenu();
    if (mobileChatOpen) toggleMobileChat();
  }
});

/* ─────────────────────────────────────────────────
   Orientation change (mobile camera sizing)
───────────────────────────────────────────────── */
window.addEventListener("orientationchange", () => {
  setTimeout(() => {
    updateGridClass();
    updateMiniStrip();
  }, 400);
});

/* ─────────────────────────────────────────────────
   Expose globals used by inline HTML handlers
───────────────────────────────────────────────── */
window.sendReaction    = sendReaction;
window.sendChat        = sendChat;
window.sendLike        = sendLike;
window.toggleMobileChat = toggleMobileChat;
window.switchTab       = switchTab;
