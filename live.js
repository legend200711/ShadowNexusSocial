/**
 * live.js — Shadow Nexus Social · 8-Box WebRTC Live Streaming Engine
 *
 * Architecture
 * ─────────────────────────────────────────────────────────────────
 *  • Firebase Firestore — signaling (offer/answer/ICE) + room metadata
 *  • Firebase Realtime Database — viewer count, chat, reactions
 *  • WebRTC PeerConnection per guest (fully isolated — one crash ≠ all crash)
 *  • Adaptive bitrate: degrades 720p → 480p → 360p → audio-only based on RTT / loss
 *  • Auto-reconnect on ICE failure (exponential back-off, max 8 retries)
 *  • Per-box reconnect overlay + connection status indicator
 *  • Per-box controls: refresh, mute, cam-restart, remove (host-only remove)
 *  • Active-speaker detection via Web Audio API (VAD)
 *  • Host controls: mute, cam-off, remove, lock room, restart guest connection
 *  • Mobile: camera rotation, battery/perf throttle, active-speaker mode
 *  • Network speed detection (navigator.connection + speed probe)
 *  • WiFi ↔ 5G/4G network-switch handler — no reconnect, just quality recheck
 *  • Audio-priority mode: voice preserved when video must be sacrificed
 *  • Guest self-recovery: guest can re-initiate own peer on disconnect
 *  • Camera/mic error overlays — never a blank black box
 */

import { initializeApp, getApps }
  from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged, browserLocalPersistence, setPersistence }
  from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, deleteDoc,
  collection, addDoc, onSnapshot, serverTimestamp, query, orderBy, limit,
  getDocs, where, writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
  getDatabase, ref, set, push, onValue, off, remove, increment as rtIncrement, onDisconnect
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

// ─────────────────────────────────────────────────────────────────
// Firebase init (re-use existing app if already initialised)
// ─────────────────────────────────────────────────────────────────
const FB_CONFIG = {
  apiKey:            "AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y",
  authDomain:        "horr-a08f4.firebaseapp.com",
  databaseURL:       "https://horr-a08f4-default-rtdb.firebaseio.com",
  projectId:         "horr-a08f4",
  storageBucket:     "horr-a08f4.firebasestorage.app",
  messagingSenderId: "933810617818",
  appId:             "1:933810617818:web:efb24f123337dd987c14e3"
};
const fbApp  = getApps().length ? getApps()[0] : initializeApp(FB_CONFIG);
const auth   = getAuth(fbApp);
const db     = getFirestore(fbApp);

// ── Persist auth token in localStorage so the user stays signed in after close ──
setPersistence(auth, browserLocalPersistence).catch(() => {});
const rtdb   = getDatabase(fbApp);

// ─────────────────────────────────────────────────────────────────
// ICE servers (STUN + fallback TURN)
// ─────────────────────────────────────────────────────────────────
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302"   },
  { urls: "stun:stun1.l.google.com:19302"  },
  { urls: "stun:stun2.l.google.com:19302"  }
  // Add TURN credentials here when available:
  // { urls: "turn:your-turn-server:3478", username: "user", credential: "pass" }
];

// ─────────────────────────────────────────────────────────────────
// Quality presets — applied to the local sender encodings
// VERY_LOW = audio-priority: video at minimum, audio preserved
// ─────────────────────────────────────────────────────────────────
const QUALITY = {
  HIGH:      { width: 1280, height: 720,  frameRate: 30, bitrate: 1_500_000, audioBitrate: 64_000 },
  MEDIUM:    { width: 854,  height: 480,  frameRate: 24, bitrate:   700_000, audioBitrate: 48_000 },
  LOW:       { width: 640,  height: 360,  frameRate: 15, bitrate:   300_000, audioBitrate: 32_000 },
  VERY_LOW:  { width: 320,  height: 240,  frameRate: 10, bitrate:   100_000, audioBitrate: 24_000 },
};
const QUALITY_THRESHOLDS = {
  rttHigh:        250,   // ms  → drop to MEDIUM
  rttCritical:    450,   // ms  → drop to LOW
  rttExtreme:     800,   // ms  → drop to VERY_LOW (audio priority)
  lossHigh:       0.05,  // 5%  → drop to MEDIUM
  lossCritical:   0.12,  // 12% → drop to LOW
  lossExtreme:    0.25,  // 25% → drop to VERY_LOW
};

// Network tier → quality cap (so a weak mobile signal never wastes bandwidth)
const NETWORK_QUALITY_CAP = {
  "4g":         "HIGH",
  "3g":         "MEDIUM",
  "2g":         "LOW",
  "slow-2g":    "VERY_LOW",
  "wifi":       "HIGH",     // non-standard but some browsers report it
  "ethernet":   "HIGH",
  "bluetooth":  "LOW",
  unknown:      "HIGH",
};

// ─────────────────────────────────────────────────────────────────
// Runtime state
// ─────────────────────────────────────────────────────────────────
let currentUser     = null;
let myDisplayName   = "Guest";
let myPhotoURL      = null;  // populated from auth + Firestore after login
let myVerified      = false; // populated from Firestore after login
let roomId          = null;
let isHost          = false;
let roomLocked      = false;
let liveActive      = false;
let localStream     = null;
let micEnabled      = true;
let camEnabled      = true;
let facingMode      = "user";
let currentQuality  = "HIGH";
let _networkTier    = "HIGH";   // derived from navigator.connection
let _connMonInterval = null;    // heartbeat for self-recovery (guest)

// ── Replay / Recording state ──
let _mediaRecorder   = null;   // MediaRecorder instance (host only)
let _recordedChunks  = [];     // collected Blob chunks
let _recordingStart  = 0;      // Date.now() when recording started
let _replayBlob      = null;   // final Blob after recording stops

// ── Join-request gating (host-side) ──
let requestsOpen    = true;          // host can close/open requests
let requestAllowMode = "everyone";   // "everyone"|"followers"|"friends"|"family"

// ── Viewer-side cooldown (after being denied) ──
let _reqCooldownTimer = null;        // setTimeout handle

// ── Chat state ──
let chatEnabled       = true;   // host can turn off chat entirely
let slowMode          = false;  // host can enable slow mode (1 msg per 5s)
let slowModeDelay     = 5000;   // ms between messages in slow mode
let _lastMsgTime      = 0;      // timestamp of last sent message (for slow mode)
let pinnedMsgId       = null;   // docId of pinned message
let chatMutedUsers    = {};     // { uid: true } — users muted from chat by host
let _replyTo          = null;   // { msgId, name, text } — current reply-to state
let _chatSettingsUnsub = null;  // guard: only one settings listener at a time

// ── AutoMod violation state per-user ──
// { uid: { warnCount: number, lastWarnTs: number, offenses: string[], removedFromBox: boolean } }
const _violationState = {};
// How many warnings before the user is removed from the Live box (medium escalation)
const _AUTOMOD_WARN_BEFORE_REMOVE = 1; // 1 warning → next medium offense removes from box

// guests[uid] = { pc, stream, displayName, muted, camOff, retries, quality, _qualityInterval }
const guests = {};

// Firestore unsub handles
const _unsubs = [];

// RTDB refs
let roomRtRef   = null;
let viewerRef   = null;
let chatRtRef   = null;
let presenceRef = null;

// ─────────────────────────────────────────────────────────────────
// Network speed / tier detection
// ─────────────────────────────────────────────────────────────────
function detectNetworkTier() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return "HIGH";
  const ect = conn.effectiveType || "unknown";
  return NETWORK_QUALITY_CAP[ect] || NETWORK_QUALITY_CAP[conn.type] || "HIGH";
}

function capQualityByNetwork(target) {
  const order = ["VERY_LOW", "LOW", "MEDIUM", "HIGH"];
  const capIdx = order.indexOf(_networkTier);
  const tgtIdx = order.indexOf(target);
  return tgtIdx > capIdx ? _networkTier : target;
}

function initNetworkListener() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return;
  conn.addEventListener("change", () => {
    const prev = _networkTier;
    _networkTier = detectNetworkTier();
    if (prev !== _networkTier) {
      toast(`Network changed → ${_networkTier === "HIGH" ? "Fast" : _networkTier === "MEDIUM" ? "Average" : _networkTier === "LOW" ? "Slow" : "Very Slow"} connection`);
      // Re-evaluate quality for all peers without triggering a full reconnect
      Object.keys(guests).forEach(uid => {
        const g = guests[uid];
        if (g && g.quality) {
          const capped = capQualityByNetwork(g.quality);
          if (capped !== g.quality) {
            g.quality = capped;
            applyQualityToSender(g.pc, capped).catch(() => {});
            updateQualityDot(uid, capped);
          }
        }
      });
    }
  });
}

// DOM shorthand
const $  = id => document.getElementById(id);
const el = (tag, cls, inner) => {
  const e = document.createElement(tag);
  if (cls)   e.className = cls;
  if (inner !== undefined) e.innerHTML = inner;
  return e;
};

// ─────────────────────────────────────────────────────────────────
// Entry point — wait for auth
// ─────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }
  currentUser = user;
  myPhotoURL  = user.photoURL || null;

  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists()) {
      const d = snap.data();
      myDisplayName = d.displayName || d.username || "User";
      myVerified    = d.verified || d.isVerified || false;
      myPhotoURL    = d.photoURL || d.avatarUrl || user.photoURL || null;
    }
  } catch (_) { /* best-effort */ }

  initUI();
  // Start global presence (shows this user as online to others)
  startGlobalPresence();
  // Start listening for Live invites from other hosts
  listenForIncomingInvites();
});

// ─────────────────────────────────────────────────────────────────
// Fullscreen helpers
// ─────────────────────────────────────────────────────────────────
function enterFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
  if (req) req.call(el).catch(() => {});
}

function exitFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
  if (exit && (document.fullscreenElement || document.webkitFullscreenElement)) {
    exit.call(document).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────
// UI init
// ─────────────────────────────────────────────────────────────────
function initUI() {
  _networkTier = detectNetworkTier();
  initNetworkListener();
  buildVideoGrid();
  attachButtonHandlers();
  attachKeyboardHandlers();
  showLobby();

  const params = new URLSearchParams(location.search);
  if (params.has("room")) {
    // roomId can be a Firestore doc id (long) or a legacy 6-char code
    const code = params.get("room").trim().slice(0, 60);
    if (params.get("host") === "1") {
      startAsHost(code);
    } else {
      // Viewer arriving from the Feed — enter as viewer and show "Request to Join"
      enterAsViewer(code);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Viewer enters a live room from the Feed — watches without a box
// until they tap "Request to Join"
// ─────────────────────────────────────────────────────────────────
async function enterAsViewer(code) {
  roomId = code;
  liveActive = true;
  $("roomTitle").textContent = `🔴 Live`;
  hideAll();
  showCtrlBar();
  // Hide host-only controls
  $("btnGoLive").style.display  = "none";
  $("btnEndLive").style.display = "none";
  setupRTDB();
  listenViewerCount();
  listenChat();
  listenForHostCommands();
  listenForRoomRequestState();  // watch requestsOpen flag so button hides if host closes requests
  // Show the "Request to Join" button so the viewer can request a box
  showRequestJoinBtn();

  // Push a sentinel history entry so the device/browser back button can be
  // intercepted by the popstate handler below rather than navigating away raw.
  history.pushState({ liveViewer: true, roomId: code }, "");
}

// ─────────────────────────────────────────────────────────────────
// Viewer: watch requestsOpen so we can show/hide the request button live
// ─────────────────────────────────────────────────────────────────
function listenForRoomRequestState() {
  if (!roomId) return;
  const roomRef = doc(db, "liveRooms", roomId);
  const unsub   = onSnapshot(roomRef, snap => {
    if (!snap.exists()) return;
    const data = snap.data();
    const open = data.requestsOpen !== false; // default true
    const btn  = $("request-join-btn");
    const notice = $("req-closed-notice");
    if (!isHost) {
      // Update the viewer-side btn label/state
      if (!open) {
        if (btn) {
          btn.textContent = "🚫 Requests closed";
          btn.classList.add("waiting"); // reuse disabled style
        }
        if (notice) notice.classList.add("visible");
      } else {
        if (btn?.classList.contains("waiting") && btn.textContent.includes("closed")) {
          // restore if host re-opens
          showRequestJoinBtn();
        }
        if (notice) notice.classList.remove("visible");
      }
    }
  });
  _unsubs.push(unsub);
}

// ─────────────────────────────────────────────────────────────────
// Build video grid — only creates the host box at start; guest boxes
// are added dynamically as guests are accepted.
// ─────────────────────────────────────────────────────────────────
function buildVideoGrid() {
  const grid = $("video-grid");
  grid.innerHTML = "";
  // Remove all layout classes
  grid.className = "grid-1";
}

// ─────────────────────────────────────────────────────────────────
// Create a fully-wired video box element (used by assignSlot)
// ─────────────────────────────────────────────────────────────────
function makeVideoBox(uid, displayName, isHostBox, muteLocal) {
  const box = el("div", `video-box${isHostBox ? " host-box" : ""}`, "");
  box.dataset.uid = uid;

  // Video element
  const vid = document.createElement("video");
  vid.autoplay    = true;
  vid.playsInline = true;
  vid.muted       = !!muteLocal; // mute own preview to avoid echo
  box.appendChild(vid);

  // Cam-off placeholder
  const ph = el("div", "cam-placeholder",
    `<div class="cam-placeholder-avatar">🌑</div><div class="cam-placeholder-name">${esc(displayName)}</div>`);
  box.appendChild(ph);

  // Error overlay
  const errOv = el("div", "box-error-overlay",
    `<div class="box-error-icon">⚠️</div><div class="box-error-msg">No video</div>`);
  box.appendChild(errOv);

  // Reconnecting overlay
  const reconOv = el("div", "box-reconnect-overlay",
    `<div class="box-recon-spinner"></div><div class="box-recon-msg">Reconnecting…</div>`);
  box.appendChild(reconOv);

  // Name / badge overlay
  const ov = el("div", "box-overlay",
    `<div class="box-badges"></div>
     <div class="box-host-tag" style="${isHostBox ? "" : "display:none;"}">HOST</div>
     <div class="box-name">${esc(displayName)}</div>`);
  box.appendChild(ov);

  // Connection status bar
  const statusBar = el("div", "box-status-bar",
    `<span class="box-conn-dot good"></span><span class="box-conn-label">Good</span>`);
  box.appendChild(statusBar);

  // Per-box control buttons
  const boxCtrls = el("div", "box-controls", "");
  const btnRefresh = el("button", "box-ctrl-btn", "🔄");
  btnRefresh.title = "Refresh box";
  btnRefresh.addEventListener("click", e => { e.stopPropagation(); refreshBox(box.dataset.uid, box); });

  const btnBoxMute = el("button", "box-ctrl-btn", "🎤");
  btnBoxMute.title = "Mute/Unmute";
  btnBoxMute.addEventListener("click", e => { e.stopPropagation(); toggleBoxMute(box.dataset.uid, btnBoxMute); });

  const btnBoxCam = el("button", "box-ctrl-btn", "📷");
  btnBoxCam.title = "Restart camera";
  btnBoxCam.addEventListener("click", e => { e.stopPropagation(); restartBoxCam(box.dataset.uid); });

  const btnBoxRemove = el("button", "box-ctrl-btn box-ctrl-remove", "❌");
  btnBoxRemove.title = "Remove guest (host only)";
  btnBoxRemove.addEventListener("click", e => { e.stopPropagation(); removeBoxGuest(box.dataset.uid); });

  // Hide remove button on host's own box
  if (isHostBox) btnBoxRemove.style.display = "none";

  boxCtrls.appendChild(btnRefresh);
  boxCtrls.appendChild(btnBoxMute);
  boxCtrls.appendChild(btnBoxCam);
  boxCtrls.appendChild(btnBoxRemove);
  box.appendChild(boxCtrls);

  // Quality dot
  const qd = el("div", "quality-dot good");
  box.appendChild(qd);

  // Mobile tap-to-enlarge
  if (isMobile()) {
    box.addEventListener("click", e => {
      if (e.target.closest(".box-controls")) return; // don't expand when tapping controls
      if (box.classList.contains("expanded")) {
        box.classList.remove("expanded");
      } else {
        // Collapse any other expanded box first
        document.querySelectorAll(".video-box.expanded").forEach(b => b.classList.remove("expanded"));
        box.classList.add("expanded");
      }
    });
  }

  // Long-press / right-click for host context menu
  addContextMenuTrigger(box);

  return box;
}

// ─────────────────────────────────────────────────────────────────
// Update CSS grid class based on active participant count
// ─────────────────────────────────────────────────────────────────
function applyGridLayout() {
  const grid = $("video-grid");
  const count = grid.querySelectorAll(".video-box:not(.empty-slot)").length;
  const n = Math.max(1, Math.min(count, 8));
  grid.className = `grid-${n}`;
}

// ─────────────────────────────────────────────────────────────────
// Slot helpers
// ─────────────────────────────────────────────────────────────────
function slotFor(uid) {
  return document.querySelector(`.video-box[data-uid="${CSS.escape(uid)}"]`);
}
function assignSlot(uid, displayName, stream, isHostSlot) {
  // Reuse existing slot if the uid is already present
  let slot = slotFor(uid);
  if (!slot) {
    // Create a new box — mute local preview (host slot or own guest slot)
    const muteLocal = isHostSlot || (currentUser && uid === currentUser.uid);
    slot = makeVideoBox(uid, displayName, !!isHostSlot, muteLocal);
    $("video-grid").appendChild(slot);
  }
  slot.classList.remove("empty-slot", "box-error");

  const vid  = slot.querySelector("video");
  const name = slot.querySelector(".box-name");

  if (stream) { vid.srcObject = stream; vid.play().catch(() => {}); }
  name.textContent = displayName;
  slot.querySelector(".cam-placeholder-name").textContent = displayName;
  setBoxStatus(slot, "good");
  applyGridLayout();
  return slot;
}

function clearSlot(uid) {
  const slot = slotFor(uid);
  if (!slot) return;
  // Don't remove the host's own box — it persists for the duration of the stream
  const isMyHostBox = slot.classList.contains("host-box") && isHost && uid === currentUser?.uid;
  const vid = slot.querySelector("video");
  vid.srcObject = null;
  if (isMyHostBox) {
    // Just clear the stream, keep the box
    return;
  }
  // Animate out then remove
  slot.style.transition = "opacity 0.2s, transform 0.2s";
  slot.style.opacity    = "0";
  slot.style.transform  = "scale(0.88)";
  setTimeout(() => {
    slot.remove();
    applyGridLayout();
  }, 210);
}

// ─────────────────────────────────────────────────────────────────
// Per-box status helpers
// ─────────────────────────────────────────────────────────────────
// status: "good" | "weak" | "reconnecting" | "error"
function setBoxStatus(slotOrUid, status, errorMsg) {
  const slot = typeof slotOrUid === "string" ? slotFor(slotOrUid) : slotOrUid;
  if (!slot) return;

  const dot   = slot.querySelector(".box-conn-dot");
  const label = slot.querySelector(".box-conn-label");
  const errOv = slot.querySelector(".box-error-overlay");
  const reconOv = slot.querySelector(".box-reconnect-overlay");
  const errMsg  = slot.querySelector(".box-error-msg");

  // Reset classes
  if (dot) dot.className = `box-conn-dot ${status === "reconnecting" ? "reconnecting" : status === "weak" ? "weak" : status === "error" ? "error" : "good"}`;
  if (label) label.textContent = { good: "Good", weak: "Weak", reconnecting: "Reconnecting", error: "Error" }[status] || "Good";

  slot.classList.toggle("box-reconnecting", status === "reconnecting");
  slot.classList.toggle("box-error",        status === "error");

  if (reconOv) reconOv.classList.toggle("visible", status === "reconnecting");
  if (errOv)   errOv.classList.toggle("visible",   status === "error");
  if (errMsg && errorMsg) errMsg.textContent = errorMsg;
}

// ─────────────────────────────────────────────────────────────────
// Per-box control actions
// ─────────────────────────────────────────────────────────────────

// 🔄 Refresh a box — if it's your own box, re-acquire media; if guest (host), restart peer
function refreshBox(uid, boxEl) {
  if (!uid) return;
  if (uid === currentUser.uid) {
    // Re-acquire our own stream
    restartLocalStream();
  } else if (isHost) {
    // Host restarts peer for this guest
    reconnectPeer(uid);
    toast(`Restarting connection for ${guests[uid]?.displayName || uid}…`);
  }
}

// 🎤 Toggle mute on a box
function toggleBoxMute(uid, btn) {
  if (!uid) return;
  if (uid === currentUser.uid) {
    toggleMic();
  } else if (isHost) {
    hostMuteGuest(uid);
  }
}

// 📷 Restart camera for a box
function restartBoxCam(uid) {
  if (!uid) return;
  if (uid === currentUser.uid) {
    restartLocalCam();
  } else if (isHost) {
    hostDisableCam(uid);
    toast(`Toggling camera for ${guests[uid]?.displayName || uid}…`);
  }
}

// ❌ Remove a guest box (host only)
function removeBoxGuest(uid) {
  if (!uid || uid === currentUser.uid) return;
  if (!isHost) return;
  if (confirm(`Remove ${guests[uid]?.displayName || "this guest"} from the Live?`)) {
    hostRemoveGuest(uid);
  }
}

// Restart our own local stream (camera/mic recovery)
async function restartLocalStream() {
  const slot = slotFor(currentUser.uid);
  setBoxStatus(slot, "reconnecting");
  try {
    const old = localStream;
    old?.getTracks().forEach(t => t.stop());
    localStream = null;
    await acquireLocalStream();
    // Replace tracks in all peer connections
    const newVid = localStream.getVideoTracks()[0];
    const newAud = localStream.getAudioTracks()[0];
    Object.values(guests).forEach(g => {
      g.pc.getSenders().forEach(s => {
        if (s.track?.kind === "video" && newVid) s.replaceTrack(newVid).catch(() => {});
        if (s.track?.kind === "audio" && newAud) s.replaceTrack(newAud).catch(() => {});
      });
    });
    if (slot) {
      const vid = slot.querySelector("video");
      vid.srcObject = localStream;
      vid.play().catch(() => {});
    }
    setBoxStatus(slot, "good");
    toast("Camera restarted ✓");
  } catch (e) {
    setBoxStatus(slot, "error", "Camera unavailable.");
  }
}

// Restart camera only (keep audio)
async function restartLocalCam() {
  const slot = slotFor(currentUser.uid);
  setBoxStatus(slot, "reconnecting");
  try {
    const qual = QUALITY[currentQuality];
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: qual.width }, height: { ideal: qual.height }, frameRate: { ideal: qual.frameRate }, facingMode },
      audio: false
    });
    const newVid = newStream.getVideoTracks()[0];
    // Stop old video track
    localStream?.getVideoTracks().forEach(t => t.stop());
    // Replace in localStream
    if (localStream) {
      localStream.getVideoTracks().forEach(t => localStream.removeTrack(t));
      localStream.addTrack(newVid);
    }
    // Replace in all peers
    Object.values(guests).forEach(g => {
      const s = g.pc.getSenders().find(s => s.track?.kind === "video");
      if (s) s.replaceTrack(newVid).catch(() => {});
    });
    if (slot) {
      const vid = slot.querySelector("video");
      vid.srcObject = localStream;
      vid.play().catch(() => {});
    }
    setBoxStatus(slot, "good");
    toast("Camera restarted ✓");
  } catch (e) {
    setBoxStatus(slot, "error", "Camera unavailable.");
  }
}

// ─────────────────────────────────────────────────────────────────
// Button handlers
// ─────────────────────────────────────────────────────────────────
function attachButtonHandlers() {
  $("btnBack").onclick          = handleBack;
  $("btnExitLive").onclick      = handleBack;
  $("btnGoLive").onclick        = handleGoLive;
  $("btnEndLive").onclick       = handleEndLive;
  $("btnMic").onclick           = toggleMic;
  $("btnCam").onclick           = toggleCam;
  $("btnFlip").onclick          = flipCamera;
  $("btnLock").onclick          = toggleLock;

  // End Live confirmation modal buttons
  $("elcBtnEnd").onclick        = async () => { $("endLiveConfirm").classList.remove("open"); await endLive(); };
  $("elcBtnCancel").onclick     = () => { $("endLiveConfirm").classList.remove("open"); };

  // Replay modal buttons (host post-live choices)
  $("replayBtnSave")?.addEventListener("click",    handleReplaySave);
  $("replayBtnPost")?.addEventListener("click",    handleReplayPost);
  $("replayBtnDiscard")?.addEventListener("click", handleReplayDiscard);

  // Leave confirm overlay (viewer / guest exit — no browser confirm())
  $("leaveBtnYes")?.addEventListener("click", confirmLeave);
  $("leaveBtnNo")?.addEventListener("click",  () => $("leaveConfirm").classList.remove("open"));

  $("btnHostRoom").onclick      = () => startAsHost();
  // btnJoinRoom removed — public discovery is via the Feed
  $("btnBackHome").onclick      = () => {
    exitFullscreen();
    if (window.history.length > 1) { window.history.back(); } else { window.location.href = "index.html"; }
  };
  $("btnJoinCancel").onclick    = () => { hideOverlay("join-overlay"); showLobby(); };
  $("btnCancelRequest").onclick = cancelJoinRequest;
  $("chat-send").onclick        = sendChat;
  $("chat-input").addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });

  // Reply cancel buttons
  $("chat-reply-cancel")?.addEventListener("click", clearReplyTo);
  $("chat-reply-cancel-mobile")?.addEventListener("click", clearReplyTo);

  // Pinned bar — click scrolls to pinned msg, X unpins (host only)
  $("chat-pinned-bar")?.addEventListener("click", scrollToPinnedMsg);
  $("chat-unpin-btn")?.addEventListener("click", e => { e.stopPropagation(); unpinMessage(); });

  // Host chat control buttons (wired, safe to call even for guests — guarded inside)
  $("btn-chat-toggle")?.addEventListener("click", toggleChatEnabled);
  $("btn-slow-mode")?.addEventListener("click",   toggleSlowMode);

  // Request to Join button (viewer flow)
  $("request-join-btn").onclick = handleRequestToJoin;

  // Invite overlay buttons
  $("inviteBtnAccept")?.addEventListener("click",  acceptLiveInvite);
  $("inviteBtnDecline")?.addEventListener("click", declineLiveInvite);

  // Privacy selector (host-only, inside people panel)
  $("invite-privacy-select")?.addEventListener("change", e => saveInvitePrivacy(e.target.value));

  // Permission pre-check modal (viewer perm gate before camera access)
  $("permBtnConfirm")?.addEventListener("click", confirmPermAndJoin);
  $("permBtnCancel")?.addEventListener("click",  hidePermCheckModal);

  // Request-settings bar (host-only)
  $("btn-toggle-requests")?.addEventListener("click", toggleRequestsOpen);
  $("btnRequests")?.addEventListener("click",         toggleRequestsOpen);
  $("req-allow-select")?.addEventListener("change",   e => setRequestAllowMode(e.target.value));

  // Report Live button (viewers/guests)
  _attachReportLiveBtn();

  // Dismiss context menu + per-request safety menus on outside click
  document.addEventListener("click", e => {
    if (!e.target.closest("#guest-ctx-menu")) hideCtxMenu();
    if (!e.target.closest(".req-safety-menu") && !e.target.closest(".req-more")) {
      document.querySelectorAll(".req-safety-menu.open").forEach(m => m.classList.remove("open"));
    }
    // Close report modal on backdrop click
    if (e.target.id === "report-live-modal") closeReportModal();
    // Close mod logs modal on backdrop click
    if (e.target.id === "mod-logs-modal") closeModLogs();
  });
}

function attachKeyboardHandlers() {
  document.addEventListener("keydown", e => {
    if (!liveActive) return;
    if (e.altKey && e.key === "m") toggleMic();
    if (e.altKey && e.key === "v") toggleCam();
  });

  // ── Device / browser back button — intercept while a viewer is in a live ──
  // When the user presses the phone back button or browser back, the sentinel
  // state we pushed in enterAsViewer() pops off first, firing this handler.
  // We show the leave-confirm overlay instead of silently navigating away.
  window.addEventListener("popstate", e => {
    if (liveActive && !isHost) {
      // Re-push the sentinel so that pressing "Stay" doesn't leave the page
      // on the next back-press without going through the overlay again.
      history.pushState({ liveViewer: true, roomId }, "");
      $("leaveConfirm").classList.add("open");
    }
  });
}

// ─────────────────────────────────────────────────────────────────
// Overlay helpers
// ─────────────────────────────────────────────────────────────────
function showLobby()      { hideAll(); $("lobby-overlay").classList.remove("hidden"); hideRequestJoinBtn(); }
function showJoinOverlay(){ hideAll(); $("join-overlay").classList.remove("hidden"); }
function hideOverlay(id)  { $(id).classList.add("hidden"); }
function hideAll()        { ["lobby-overlay","join-overlay","waiting-overlay"].forEach(hideOverlay); }

// ─────────────────────────────────────────────────────────────────
// Request to Join button helpers (shown to viewers watching the live)
// ─────────────────────────────────────────────────────────────────
function showRequestJoinBtn() {
  const btn = $("request-join-btn");
  if (!btn || isHost) return;
  btn.textContent = "🎥 Join Live Box";
  btn.classList.remove("waiting", "cooldown");
  btn.classList.add("visible");
}
function hideRequestJoinBtn() {
  $("request-join-btn")?.classList.remove("visible", "waiting", "cooldown");
}
function setRequestJoinWaiting() {
  const btn = $("request-join-btn");
  if (!btn) return;
  btn.textContent = "⏳ Waiting for host…";
  btn.classList.add("waiting");
}
function setRequestJoinCooldown(seconds) {
  const btn = $("request-join-btn");
  if (!btn) return;
  let remaining = seconds;
  btn.classList.remove("waiting");
  btn.classList.add("visible", "cooldown");
  const tick = () => {
    btn.textContent = `⏳ Try again in ${remaining}s`;
    if (remaining <= 0) {
      btn.classList.remove("cooldown");
      btn.textContent = "🎥 Join Live Box";
      return;
    }
    remaining--;
    _reqCooldownTimer = setTimeout(tick, 1000);
  };
  tick();
}

// Handle viewer tapping "Request to Join" — show perm-check modal first
function handleRequestToJoin() {
  if (!roomId || isHost || !liveActive) return;
  const btn = $("request-join-btn");
  if (btn?.classList.contains("waiting") || btn?.classList.contains("cooldown")) return;
  // Show permission pre-check modal before acquiring camera/mic
  showPermCheckModal();
}

// Show / hide the perm-check modal
function showPermCheckModal() {
  $("perm-check-modal")?.classList.add("visible");
}
function hidePermCheckModal() {
  $("perm-check-modal")?.classList.remove("visible");
}
function confirmPermAndJoin() {
  hidePermCheckModal();
  hideRequestJoinBtn();
  requestToJoin(roomId);
}

// ─────────────────────────────────────────────────────────────────
// Generate a random 6-char room code
// ─────────────────────────────────────────────────────────────────
function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({length:6}, () => chars[Math.floor(Math.random()*chars.length)]).join("");
}

// ─────────────────────────────────────────────────────────────────
// Host flow
// ─────────────────────────────────────────────────────────────────
async function startAsHost(code) {
  isHost = true;
  roomId = code || genRoomCode();
  $("roomTitle").textContent = `🔴 Live`;
  hideAll();
  await acquireLocalStream();
  assignSlot(currentUser.uid, myDisplayName + " (you)", localStream, true);
  showCtrlBar();
  _showHostRequestControls();
  toast(`🔴 Live started — your followers can join from the Feed!`);
  listenForJoinRequests();
  setupRTDB();
  startHostStreamGuard();
  markPresenceLive(roomId);
}

// Show host-only request controls (settings bar + ctrl-bar button)
function _showHostRequestControls() {
  const bar = $("req-settings-bar");
  if (bar) bar.style.display = "flex";
  const btn = $("btnRequests");
  if (btn) btn.style.display = "";
  _syncRequestsOpenUI();
  // Show host chat controls bar
  _syncHostChatBar();
}

// Sync all UI to match requestsOpen / requestAllowMode
function _syncRequestsOpenUI() {
  const toggleBtn = $("btn-toggle-requests");
  const ctrlBtn   = $("btnRequests");
  const notice    = $("req-closed-notice");
  if (toggleBtn) {
    toggleBtn.textContent = requestsOpen ? "✅ Requests on" : "🚫 Requests off";
    toggleBtn.classList.toggle("off", !requestsOpen);
  }
  if (ctrlBtn) {
    ctrlBtn.innerHTML = (requestsOpen ? "👥" : "🚫") + `<span class="ctrl-tooltip">${requestsOpen ? "Requests on" : "Requests off"}</span>`;
    ctrlBtn.classList.toggle("active", !requestsOpen);
  }
  if (notice) notice.classList.toggle("visible", !requestsOpen);
  // Persist to Firestore so viewers can read the state
  if (roomId && liveActive) {
    updateDoc(doc(db, "liveRooms", roomId), {
      requestsOpen,
      requestAllowMode,
    }).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────
// Go Live button (host must press to officially start broadcast)
// ─────────────────────────────────────────────────────────────────
async function handleGoLive() {
  if (!isHost) return;
  if (!localStream) await acquireLocalStream();
  liveActive = true;
  $("btnGoLive").style.display  = "none";
  $("btnEndLive").style.display = "";
  $("live-badge").classList.add("visible");
  $("viewer-count").style.display = "flex";

  // Write WebRTC room metadata so guests can signal
  await setDoc(doc(db, "liveRooms", roomId), {
    host:             currentUser.uid,
    hostName:         myDisplayName,
    hostPhotoURL:     myPhotoURL || "",
    roomId,
    live:             true,
    locked:           false,
    requestsOpen:     true,
    requestAllowMode: "everyone",
    createdAt:        serverTimestamp(),
    viewerCount:      0
  });

  // Ensure the stories doc (feed bubble) reflects the live as active.
  // index.html:startLiveStream() already created it with liveActive:true,
  // but we patch the avatar + name here in case they loaded after the doc
  // was written, and we confirm liveActive:true so the bubble always shows.
  try {
    await updateDoc(doc(db, "stories", roomId), {
      liveActive   : true,
      authorName   : myDisplayName,
      authorAvatar : myPhotoURL || "",
    });
  } catch (_) { /* doc may not exist for manually-created rooms — ignore */ }

  listenForJoinRequests();
  listenViewerCount();
  _showHostRequestControls();
  markPresenceLive(roomId);
  // Start recording the host's local stream
  _startRecording();
  toast("🔴 You are now Live! Your followers can see you on their Feed.");
}

function handleEndLive() {
  if (!isHost) return;
  $("endLiveConfirm").classList.add("open");
}

// Guard to prevent double-navigation if both "liveEnded" command and
// live:false room doc change fire in the same session.
let _liveEndNavigating = false;

// ─────────────────────────────────────────────────────────────────
// MediaRecorder helpers — record host's local stream for replay
// ─────────────────────────────────────────────────────────────────
function _startRecording() {
  if (!localStream || !window.MediaRecorder) return;
  _recordedChunks = [];
  _replayBlob     = null;
  _recordingStart = Date.now();
  try {
    // Prefer a format the browser supports; fall back to default
    const mimeType = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    ].find(m => MediaRecorder.isTypeSupported(m)) || "";
    _mediaRecorder = new MediaRecorder(localStream, mimeType ? { mimeType } : {});
    _mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) _recordedChunks.push(e.data);
    };
    _mediaRecorder.start(1000); // collect a chunk every second
  } catch (_) {
    _mediaRecorder = null; // recording not supported — silently skip
  }
}

function _stopRecording() {
  return new Promise(resolve => {
    if (!_mediaRecorder || _mediaRecorder.state === "inactive") {
      resolve(null); return;
    }
    _mediaRecorder.onstop = () => {
      const mimeType = _mediaRecorder.mimeType || "video/webm";
      _replayBlob = _recordedChunks.length
        ? new Blob(_recordedChunks, { type: mimeType })
        : null;
      _mediaRecorder = null;
      resolve(_replayBlob);
    };
    _mediaRecorder.stop();
  });
}

function _fmtDuration(ms) {
  const s  = Math.floor(ms / 1000);
  const m  = Math.floor(s / 60);
  const h  = Math.floor(m / 60);
  const ss = String(s % 60).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ─────────────────────────────────────────────────────────────────
// Replay modal helpers
// ─────────────────────────────────────────────────────────────────
function _showReplayModal() {
  const dur = $("replayDuration");
  if (dur) {
    const elapsed = _recordingStart ? Date.now() - _recordingStart : 0;
    if (elapsed > 0) {
      dur.textContent = `⏱ Duration: ${_fmtDuration(elapsed)}`;
      dur.classList.add("visible");
    } else {
      dur.classList.remove("visible");
    }
  }
  // Enable / disable Save & Post based on whether we have a recording
  const hasBlobOrRecording = _replayBlob || (_recordedChunks.length > 0);
  $("replayBtnSave").classList.toggle("disabled", !hasBlobOrRecording);
  $("replayBtnPost").classList.toggle("disabled", !hasBlobOrRecording);

  $("replayModal").classList.add("open");
}

function _closeReplayModal() {
  $("replayModal").classList.remove("open");
  _replayBlob     = null;
  _recordedChunks = [];
}

async function handleReplaySave() {
  if (!_replayBlob) { _replayToFeed(); return; }
  const btn = $("replayBtnSave");
  const sp  = $("replaySaveSpinner");
  btn.classList.add("disabled");
  if (sp) sp.classList.add("visible");
  try {
    // Trigger a browser download so it's saved to the device
    const url = URL.createObjectURL(_replayBlob);
    const a   = document.createElement("a");
    const ext = _replayBlob.type.includes("mp4") ? "mp4" : "webm";
    a.href     = url;
    a.download = `shadow-nexus-live-${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast("✅ Replay saved to your device.");
    await new Promise(r => setTimeout(r, 800));
  } catch (e) {
    toast("⚠️ Could not save replay: " + (e.message || e));
  }
  _closeReplayModal();
  _replayToFeed();
}

async function handleReplayPost() {
  if (!_replayBlob) { _replayToFeed(); return; }
  const btn = $("replayBtnPost");
  const sp  = $("replayPostSpinner");
  btn.classList.add("disabled");
  $("replayBtnSave").classList.add("disabled");
  $("replayBtnDiscard").classList.add("disabled");
  if (sp) sp.classList.add("visible");
  toast("📤 Uploading replay…");
  try {
    // Upload to the Cloudflare R2 worker the project already uses
    const ext      = _replayBlob.type.includes("mp4") ? "mp4" : "webm";
    const fileName = `replays/${currentUser.uid}_${Date.now()}.${ext}`;
    const resp     = await fetch("https://upload.shadow-nexus.workers.dev/upload", {
      method: "POST",
      headers: {
        "Content-Type": _replayBlob.type || "video/webm",
        "X-File-Name":  fileName,
      },
      body: _replayBlob,
    });
    if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
    const { url: videoUrl } = await resp.json();

    // Create a Firestore post doc so it appears in the Feed
    const elapsed = _recordingStart ? Date.now() - _recordingStart : 0;
    await addDoc(collection(db, "posts"), {
      uid:          currentUser.uid,
      displayName:  myDisplayName,
      photoURL:     myPhotoURL || "",
      type:         "video",
      mediaUrl:     videoUrl,
      text:         `🔴 Live Replay — ${_fmtDuration(elapsed)}`,
      isReplay:     true,
      privacy:      "public",
      likes:        [],
      comments:     [],
      createdAt:    serverTimestamp(),
    });
    toast("✅ Replay posted to the Feed!");
    await new Promise(r => setTimeout(r, 1000));
  } catch (e) {
    toast("⚠️ Could not post replay: " + (e.message || e));
    // Re-enable buttons so host can try again or discard
    btn.classList.remove("disabled");
    $("replayBtnSave").classList.remove("disabled");
    $("replayBtnDiscard").classList.remove("disabled");
    if (sp) sp.classList.remove("visible");
    return; // stay on the modal — don't navigate away on error
  }
  _closeReplayModal();
  _replayToFeed();
}

function handleReplayDiscard() {
  _closeReplayModal();
  _replayToFeed();
}

function _replayToFeed() {
  // Return to Feed and signal it to show the "Live ended" confirmation toast.
  // Use replace() so the host cannot navigate back to the dead live.html session.
  window.location.replace("index.html?liveEnded=1");
}

async function endLive() {
  liveActive = false;
  stopGuestConnectionMonitor();

  // ── 1. Stop recording — collect the final blob before closing streams ──
  const blob = await _stopRecording();
  if (blob) _replayBlob = blob;

  // ── 2. Notify every connected guest (box) that the stream has ended ──
  const guestUids = Object.keys(guests);
  await Promise.all(guestUids.map(uid =>
    setDoc(doc(db, "liveRooms", roomId, "commands", uid), { cmd: "liveEnded" }).catch(() => {})
  ));

  // ── 3. Close all peer connections ──
  guestUids.forEach(uid => closePeer(uid));

  if (roomId) {
    // ── 4a. Mark liveActive:false in stories — removes Feed bubble for everyone ──
    try { await updateDoc(doc(db, "stories", roomId), { liveActive: false, endedAt: serverTimestamp() }); }
    catch (_) { /* best-effort — may not exist for manually-created rooms */ }

    // ── 4b. Delete the Firestore liveRooms doc so viewers on live.html also get notified ──
    try { await deleteDoc(doc(db, "liveRooms", roomId)); }
    catch (_) { /* best-effort */ }

    // ── 4c. Clear all pending boxRequests so no ghost requests linger ──
    try {
      const reqSnap = await getDocs(collection(db, "liveRooms", roomId, "boxRequests"));
      if (!reqSnap.empty) {
        const batch = writeBatch(db);
        reqSnap.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    } catch (_) { /* best-effort */ }

    // ── 4d. Remove the RTDB room node — clears viewer count and chat ──
    try { await remove(ref(rtdb, `liveRooms/${roomId}`)); }
    catch (_) { /* best-effort */ }
  }

  // ── 5. Clear own RTDB presence / viewer entry ──
  if (presenceRef) { set(presenceRef, null).catch(() => {}); }
  markPresenceLive(null);

  // ── 6. Unsubscribe all Firestore listeners so nothing re-fires after we leave ──
  _unsubs.forEach(u => u()); _unsubs.length = 0;
  if (_chatSettingsUnsub) { _chatSettingsUnsub(); _chatSettingsUnsub = null; }

  // ── 7. Stop VAD ──
  _vadRunning = false;
  if (_vadCtx) { try { _vadCtx.close(); } catch (_) {} _vadCtx = null; }

  // ── 8. Stop ALL local media tracks — camera & microphone fully off ──
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  // ── 9. Reset live UI chrome ──
  $("live-badge").classList.remove("visible");
  $("btnGoLive").style.display  = "";
  $("btnEndLive").style.display = "none";
  $("btnExitLive").classList.remove("visible");
  $("btn-report-live")?.classList.remove("visible");
  $("btn-mod-logs")?.classList.remove("visible");
  hideRequestJoinBtn();
  exitFullscreen();

  // ── 10. Show replay choice modal (or go straight to Feed if no recording) ──
  _showReplayModal();
}

// ─────────────────────────────────────────────────────────────────
// Guest join flow
// ─────────────────────────────────────────────────────────────────
function handleJoinConfirm() {
  const code = $("room-code-input").value.trim().toUpperCase().slice(0, 6);
  if (code.length < 4) { toast("Enter a valid room code"); return; }
  requestToJoin(code);
}

async function requestToJoin(code) {
  const alreadyViewing = liveActive && roomId === code;
  roomId = code;
  $("roomTitle").textContent = `🔴 Live`;

  if (alreadyViewing) {
    // Viewer is already watching — show in-page waiting state instead of full overlay
    setRequestJoinWaiting();
    toast("⏳ Requesting to join… waiting for host.");
  } else {
    hideAll();
    $("waiting-overlay").classList.remove("hidden");
    $("waitingSub").textContent = `Waiting for host approval…`;
  }

  try {
    if (!localStream) await acquireLocalStream();
  } catch (e) {
    if (alreadyViewing) {
      showRequestJoinBtn();
      toast(getMediaErrorMessage(e));
    } else {
      $("waitingSub").textContent = getMediaErrorMessage(e);
    }
    return;
  }

  if (!alreadyViewing) setupRTDB();

  await setDoc(doc(db, "liveRooms", roomId, "requests", currentUser.uid), {
    uid:         currentUser.uid,
    displayName: myDisplayName,
    photoURL:    currentUser.photoURL || null,
    verified:    false,  // enriched from Firestore profile below (best-effort)
    status:      "pending",
    requestedAt: serverTimestamp()
  });
  // Best-effort enrich with verified flag from profile
  try {
    const snap = await getDoc(doc(db, "users", currentUser.uid));
    if (snap.exists() && (snap.data().verified || snap.data().isVerified)) {
      updateDoc(doc(db, "liveRooms", roomId, "requests", currentUser.uid), { verified: true }).catch(() => {});
    }
  } catch (_) { /* best-effort */ }

  const reqRef = doc(db, "liveRooms", roomId, "requests", currentUser.uid);
  const unsub  = onSnapshot(reqRef, snap => {
    if (!snap.exists()) return;
    const status = snap.data().status;
    if (status === "accepted") {
      unsub();
      if (!alreadyViewing) hideOverlay("waiting-overlay");
      joinAsGuest();
    } else if (status === "denied") {
      unsub();
      localStream?.getTracks().forEach(t => t.stop());
      localStream = null;
      if (alreadyViewing) {
        // 60-second cooldown before they can re-request
        setRequestJoinCooldown(60);
        toast("❌ Host declined your request. You can try again in 60s.");
      } else {
        // Came from overlay — go back to viewing state with cooldown
        hideOverlay("waiting-overlay");
        showCtrlBar();
        $("btnGoLive").style.display  = "none";
        $("btnEndLive").style.display = "none";
        setupRTDB();
        listenViewerCount();
        listenChat();
        listenForHostCommands();
        listenForRoomRequestState();
        setRequestJoinCooldown(60);
        toast("❌ Host declined your request. You can try again in 60s.");
      }
    }
  });
  _unsubs.push(unsub);
}

async function cancelJoinRequest() {
  if (roomId && currentUser) {
    deleteDoc(doc(db, "liveRooms", roomId, "requests", currentUser.uid)).catch(() => {});
  }
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  hideOverlay("waiting-overlay");
  showLobby();
}

async function joinAsGuest() {
  liveActive = true;
  hideRequestJoinBtn();
  assignSlot(currentUser.uid, myDisplayName + " (you)", localStream, false);
  showCtrlBar();
  await initiateGuestPeerConnection(currentUser.uid);
  if (!$("viewer-count").style.display || $("viewer-count").style.display === "none") listenViewerCount();
  listenChat();
  listenForHostCommands();
  startGuestConnectionMonitor();
}

// ─────────────────────────────────────────────────────────────────
// Guest self-recovery heartbeat — checks own PC every 8 s
// If connection is lost/failed and we have retries left, re-initiate
// ─────────────────────────────────────────────────────────────────
function startGuestConnectionMonitor() {
  if (_connMonInterval) clearInterval(_connMonInterval);
  _connMonInterval = setInterval(async () => {
    if (!liveActive) { clearInterval(_connMonInterval); return; }
    const g = guests[currentUser.uid];
    if (!g) return;
    const state = g.pc?.connectionState;
    const ice   = g.pc?.iceConnectionState;
    // Transient weak signal → just update status dot, no reconnect yet
    if (ice === "disconnected") {
      setBoxStatus(currentUser.uid, "weak");
      toast("🟡 Weak connection — keeping you in the Live…");
      return;
    }
    // Full failure → attempt self-recovery
    if ((state === "failed" || state === "disconnected") && g.retries < 8) {
      g.retries++;
      const delay = Math.min(1000 * 2 ** g.retries, 20000);
      setBoxStatus(currentUser.uid, "reconnecting");
      showReconnectBanner();
      toast(`Connection lost. Reconnecting… (${g.retries}/8)`);
      setTimeout(async () => {
        try {
          // Try ICE restart first (faster, no new offer needed)
          const offer = await g.pc.createOffer({ iceRestart: true });
          await g.pc.setLocalDescription(offer);
          await setDoc(doc(db, "liveRooms", roomId, "signals", currentUser.uid), {
            offer: offer.toJSON(), ts: serverTimestamp()
          });
        } catch (_) {
          // Full re-initiate as fallback
          try {
            g.pc.close();
          } catch (_) {}
          delete guests[currentUser.uid];
          await initiateGuestPeerConnection(currentUser.uid);
        }
      }, delay);
    }
  }, 8000);
}

function stopGuestConnectionMonitor() {
  if (_connMonInterval) { clearInterval(_connMonInterval); _connMonInterval = null; }
}

// ─────────────────────────────────────────────────────────────────
// Host stream guard — ensures host box stays alive even when guests churn
// ─────────────────────────────────────────────────────────────────
function startHostStreamGuard() {
  setInterval(() => {
    if (!liveActive || !isHost) return;
    const mySlot = slotFor(currentUser.uid);
    if (!mySlot) return;
    // If our own local video element lost its stream, re-attach it
    const vid = mySlot.querySelector("video");
    if (localStream && (!vid.srcObject || vid.srcObject !== localStream)) {
      vid.srcObject = localStream;
      vid.play().catch(() => {});
    }
    // If local video tracks are all ended, restart stream
    const vTracks = localStream?.getVideoTracks() || [];
    if (vTracks.length > 0 && vTracks.every(t => t.readyState === "ended")) {
      restartLocalStream().catch(() => {});
    }
  }, 6000);
}

// ─────────────────────────────────────────────────────────────────
// Host: listen for join requests
// ─────────────────────────────────────────────────────────────────
function listenForJoinRequests() {
  const qRef = collection(db, "liveRooms", roomId, "requests");
  const unsub = onSnapshot(qRef, snap => {
    snap.docChanges().forEach(change => {
      if (change.type === "added") {
        const req = change.doc.data();
        if (req.status === "pending") {
          // Auto-deny if requests are closed or allow-mode blocks this user
          if (!requestsOpen) {
            denyGuest(req.uid);
            return;
          }
          renderJoinRequest(req);
        }
      }
      if (change.type === "removed") {
        removeRequestCard(change.doc.id);
      }
    });
    const pending = snap.docs.filter(d => d.data().status === "pending").length;
    const badge = $("req-badge");
    if (badge) { badge.textContent = pending || ""; badge.classList.toggle("has-items", pending > 0); }
  });
  _unsubs.push(unsub);
}

function renderJoinRequest(req) {
  const list = $("req-list") || $("requests-panel");
  if (!list || list.querySelector(`[data-uid="${req.uid}"]`)) return;

  const card = el("div", "request-card");
  card.dataset.uid = req.uid;
  card.style.position = "relative";

  const avatarHtml = req.photoURL
    ? `<img src="${esc(req.photoURL)}" alt="">`
    : `👤`;
  const verifyHtml = req.verified ? `<span class="verify-badge">✔️</span>` : "";
  const timeAgo    = req.requestedAt?.seconds
    ? _formatTimeAgo(req.requestedAt.seconds * 1000)
    : "just now";

  card.innerHTML = `
    <div class="request-avatar">${avatarHtml}</div>
    <div class="request-info">
      <div class="request-name">${esc(req.displayName)} ${verifyHtml}</div>
      <div class="request-meta">Wants to join · ${timeAgo}</div>
    </div>
    <div class="request-btns">
      <button class="req-accept">✓ Accept</button>
      <button class="req-deny">✕ Decline</button>
      <button class="req-more" title="More options">⋯</button>
    </div>
    <div class="req-safety-menu">
      <div class="req-safety-item danger ctx-req-report">⚠️ Report</div>
      <div class="req-safety-item danger ctx-req-block">🚫 Block</div>
    </div>`;

  card.querySelector(".req-accept").onclick = () => acceptGuest(req);
  card.querySelector(".req-deny").onclick   = () => denyGuest(req.uid);
  card.querySelector(".req-more").onclick   = e => {
    e.stopPropagation();
    const menu = card.querySelector(".req-safety-menu");
    // Close any other open safety menus first
    document.querySelectorAll(".req-safety-menu.open").forEach(m => { if (m !== menu) m.classList.remove("open"); });
    menu.classList.toggle("open");
  };
  card.querySelector(".ctx-req-report").onclick = () => {
    reportUser(req.uid, req.displayName);
    denyGuest(req.uid);
  };
  card.querySelector(".ctx-req-block").onclick = () => {
    blockUser(req.uid, req.displayName);
    denyGuest(req.uid);
  };
  list.appendChild(card);

  // On mobile the side panel is hidden — show a persistent toast with quick actions
  if (isMobile()) {
    showJoinRequestToast(req);
  }
}

// Format timestamp as "X min ago" etc.
function _formatTimeAgo(ms) {
  const diff = Date.now() - ms;
  if (diff < 60_000)  return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

// Mobile-only: shows a toast with Accept/Deny inline so host can act without opening the drawer
function showJoinRequestToast(req) {
  const existing = document.getElementById("join-req-toast");
  if (existing) existing.remove();

  const t = el("div", "", "");
  t.id = "join-req-toast";
  t.style.cssText = `
    position:fixed; bottom:calc(104px + env(safe-area-inset-bottom,0px));
    left:50%; transform:translateX(-50%);
    background:rgba(5,12,28,0.97); border:1px solid rgba(0,174,239,0.45);
    color:#fff; font-size:13px; padding:10px 14px; border-radius:14px;
    z-index:750; display:flex; align-items:center; gap:10px;
    box-shadow:0 4px 24px rgba(0,0,0,0.7); backdrop-filter:blur(10px);
    white-space:nowrap; animation:msgIn 0.18s ease;
  `;
  t.innerHTML = `
    <span>👤 <b>${esc(req.displayName)}</b> wants to join</span>
    <button id="jrt-accept" style="background:var(--neon-green);color:#000;border:none;border-radius:8px;padding:5px 12px;font-size:12px;font-weight:800;cursor:pointer;">✓</button>
    <button id="jrt-deny"   style="background:rgba(255,51,85,0.2);color:#ff5566;border:1px solid rgba(255,51,85,0.3);border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;">✕</button>
  `;
  t.querySelector("#jrt-accept").onclick = () => { acceptGuest(req); t.remove(); };
  t.querySelector("#jrt-deny").onclick   = () => { denyGuest(req.uid); t.remove(); };
  document.body.appendChild(t);
  // Auto-dismiss after 12 s if host doesn't interact
  setTimeout(() => t.remove(), 12000);
}

function removeRequestCard(uid) {
  document.querySelector(`.request-card[data-uid="${uid}"]`)?.remove();
}

// ─────────────────────────────────────────────────────────────────
// Host: toggle requests open/closed
// ─────────────────────────────────────────────────────────────────
function toggleRequestsOpen() {
  if (!isHost) return;
  requestsOpen = !requestsOpen;
  _syncRequestsOpenUI();
  toast(requestsOpen ? "👥 Guest requests are now open." : "🚫 Guest requests closed.");
}

function setRequestAllowMode(mode) {
  requestAllowMode = mode;
  _syncRequestsOpenUI();
}

async function acceptGuest(req) {
  if (Object.keys(guests).length >= 7) { toast("Max 7 guests reached."); return; }
  if (roomLocked) { toast("Room is locked."); return; }
  if (!requestsOpen) { toast("Requests are currently closed."); return; }
  removeRequestCard(req.uid);
  await updateDoc(doc(db, "liveRooms", roomId, "requests", req.uid), { status: "accepted" });
  createHostPeer(req.uid, req.displayName);
}

async function denyGuest(uid) {
  removeRequestCard(uid);
  await updateDoc(doc(db, "liveRooms", roomId, "requests", uid), { status: "denied" });
}

// ─────────────────────────────────────────────────────────────────
// Safety: report / block a user (writes to Firestore safety collections)
// ─────────────────────────────────────────────────────────────────
async function reportUser(uid, displayName) {
  if (!currentUser || !uid) return;
  try {
    await addDoc(collection(db, "reports"), {
      reportedUid:  uid,
      reportedName: displayName,
      reporterUid:  currentUser.uid,
      context:      "live_request",
      roomId:       roomId || null,
      ts:           serverTimestamp(),
    });
    toast(`⚠️ ${displayName} reported.`);
  } catch (_) {
    toast("Could not send report. Try again.");
  }
}

async function blockUser(uid, displayName) {
  if (!currentUser || !uid) return;
  try {
    await setDoc(doc(db, "users", currentUser.uid, "blocked", uid), {
      uid,
      displayName,
      blockedAt: serverTimestamp(),
    });
    // Also deny any open requests from this user
    if (roomId && isHost) denyGuest(uid);
    toast(`🚫 ${displayName} blocked.`);
  } catch (_) {
    toast("Could not block user. Try again.");
  }
}

// ─────────────────────────────────────────────────────────────────
// WebRTC — Host creates a peer per guest (fully isolated try/catch)
// ─────────────────────────────────────────────────────────────────
async function createHostPeer(guestUid, displayName) {
  // Each peer is wrapped in its own try/catch so one failure never affects others
  try {
    const pc = newPC();
    guests[guestUid] = { pc, stream: null, displayName, muted: false, camOff: false, retries: 0, quality: "HIGH" };

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    const sigRef = doc(db, "liveRooms", roomId, "signals", guestUid);
    pc.onicecandidate = async e => {
      if (e.candidate) {
        await addDoc(collection(db, "liveRooms", roomId, "signals", guestUid, "hostIce"), { c: e.candidate.toJSON() });
      }
    };

    pc.ontrack = e => {
      try {
        guests[guestUid].stream = e.streams[0];
        const slot = slotFor(guestUid) || assignSlot(guestUid, displayName, e.streams[0], false);
        if (slot) {
          const vid = slot.querySelector("video");
          vid.srcObject = e.streams[0];
          vid.play().catch(() => {});
        }
        updateMiniStrip();
      } catch (_) {} // isolate
    };

    pc.onconnectionstatechange = () => { try { handlePCState(pc, guestUid); } catch (_) {} };
    pc.oniceconnectionstatechange = () => { try { monitorIceState(pc, guestUid); } catch (_) {} };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await setDoc(sigRef, { offer: offer.toJSON(), guestName: displayName, ts: serverTimestamp() });

    const unsubAns = onSnapshot(sigRef, async snap => {
      try {
        if (!snap.exists()) return;
        const data = snap.data();
        if (data.answer && pc.signalingState === "have-local-offer") {
          await pc.setRemoteDescription(data.answer).catch(() => {});
          unsubAns();
        }
      } catch (_) {}
    });
    _unsubs.push(unsubAns);

    const iceRef  = collection(db, "liveRooms", roomId, "signals", guestUid, "guestIce");
    const unsubIce = onSnapshot(iceRef, snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type === "added") {
          pc.addIceCandidate(ch.doc.data().c).catch(() => {});
        }
      });
    });
    _unsubs.push(unsubIce);

    assignSlot(guestUid, displayName, null, false);
    startQualityMonitor(guestUid);
  } catch (err) {
    // This guest's peer failed to set up — clear only their slot
    toast(`Could not connect ${displayName}. Try restarting their box.`);
    const slot = slotFor(guestUid);
    if (slot) setBoxStatus(slot, "error", "Connection failed.");
    delete guests[guestUid];
  }
}

// ─────────────────────────────────────────────────────────────────
// WebRTC — Guest creates peer and responds to host offer (isolated)
// ─────────────────────────────────────────────────────────────────
async function initiateGuestPeerConnection(guestUid) {
  try {
    const pc = newPC();
    guests[guestUid] = { pc, stream: localStream, displayName: myDisplayName, muted: false, camOff: false, retries: 0, quality: "HIGH" };

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    const sigRef = doc(db, "liveRooms", roomId, "signals", guestUid);

    pc.onicecandidate = async e => {
      if (e.candidate) {
        await addDoc(collection(db, "liveRooms", roomId, "signals", guestUid, "guestIce"), { c: e.candidate.toJSON() });
      }
    };

    pc.ontrack = e => {
      try {
        const slot = document.querySelector(".video-box.host-box");
        if (slot) { const vid = slot.querySelector("video"); vid.srcObject = e.streams[0]; vid.play().catch(() => {}); }
      } catch (_) {}
    };

    pc.onconnectionstatechange = () => { try { handlePCState(pc, guestUid); } catch (_) {} };
    pc.oniceconnectionstatechange = () => { try { monitorIceState(pc, guestUid); } catch (_) {} };

    const unsubOffer = onSnapshot(sigRef, async snap => {
      try {
        if (!snap.exists()) return;
        const data = snap.data();
        if (data.offer && pc.signalingState === "stable") {
          await pc.setRemoteDescription(data.offer).catch(() => {});
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await updateDoc(sigRef, { answer: answer.toJSON() });
          unsubOffer();
        }
      } catch (_) {}
    });
    _unsubs.push(unsubOffer);

    const iceRef   = collection(db, "liveRooms", roomId, "signals", guestUid, "hostIce");
    const unsubIce = onSnapshot(iceRef, snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type === "added") {
          pc.addIceCandidate(ch.doc.data().c).catch(() => {});
        }
      });
    });
    _unsubs.push(unsubIce);

    listenChat();
  } catch (err) {
    const mySlot = slotFor(guestUid);
    if (mySlot) setBoxStatus(mySlot, "error", "Connection failed.");
    toast("Connection failed. Try refreshing.");
  }
}

// ─────────────────────────────────────────────────────────────────
// Create a configured RTCPeerConnection
// bundlePolicy + rtcpMuxPolicy reduce media lines → less overhead on weak links
// ─────────────────────────────────────────────────────────────────
function newPC() {
  return new RTCPeerConnection({
    iceServers:           ICE_SERVERS,
    iceCandidatePoolSize: 10,
    bundlePolicy:         "max-bundle",
    rtcpMuxPolicy:        "require",
  });
}

// ─────────────────────────────────────────────────────────────────
// ICE / connection state monitoring + auto-reconnect (per-box isolated)
// ─────────────────────────────────────────────────────────────────
function handlePCState(pc, uid) {
  const state = pc.connectionState;
  const g = guests[uid];
  if (!g) return;

  if (state === "connecting" || state === "checking") {
    setBoxStatus(uid, "reconnecting");
  }

  if (state === "failed" || state === "disconnected") {
    const MAX_RETRIES = 8;
    if (g.retries < MAX_RETRIES) {
      g.retries++;
      const delay = Math.min(1000 * 2 ** (g.retries - 1), 20000);
      setBoxStatus(uid, "reconnecting");
      showReconnectBanner();
      if (uid === currentUser?.uid) {
        toast(`Connection lost. Reconnecting… (${g.retries}/${MAX_RETRIES})`);
      } else {
        toast(`🔄 Reconnecting ${g.displayName}… (${g.retries}/${MAX_RETRIES})`);
      }
      setTimeout(() => reconnectPeer(uid), delay);
    } else {
      // Max retries reached — show error but do NOT crash other boxes
      setBoxStatus(uid, "error", "Connection lost. Tap 🔄 to retry.");
      // Only clear slot for guest peers, not our own box
      if (uid !== currentUser?.uid) closePeer(uid);
      toast(`${g.displayName} disconnected.`);
    }
  }

  if (state === "connected") {
    g.retries = 0;
    setBoxStatus(uid, "good");
    hideReconnectBanner();
    if (uid === currentUser?.uid) toast("✅ Reconnected!");
  }
}

function monitorIceState(pc, uid) {
  if (pc.iceConnectionState === "failed") handlePCState(pc, uid);
  if (pc.iceConnectionState === "disconnected") {
    // Transient disconnection — show 🟡 weak but don't reconnect yet
    setBoxStatus(uid, "weak");
    if (uid === currentUser?.uid) toast("🟡 Weak connection — holding your spot…");
  }
  if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
    setBoxStatus(uid, "good");
  }
}

async function reconnectPeer(uid) {
  const g = guests[uid];
  if (!g) return;
  setBoxStatus(uid, "reconnecting");
  try {
    const offer = await g.pc.createOffer({ iceRestart: true });
    await g.pc.setLocalDescription(offer);
    await setDoc(doc(db, "liveRooms", roomId, "signals", uid), { offer: offer.toJSON(), ts: serverTimestamp() });
  } catch (_) {
    // ICE restart failed — clear only this peer's slot, never touch others
    setBoxStatus(uid, "error", "Connection lost. Tap 🔄 to retry.");
    closePeer(uid);
  }
}

function closePeer(uid) {
  const g = guests[uid];
  if (!g) return;
  try { g.pc.close(); } catch (_) {}
  if (g._qualityInterval) clearInterval(g._qualityInterval);
  delete guests[uid];
  clearSlot(uid);
  updateMiniStrip();
  deleteDoc(doc(db, "liveRooms", roomId, "signals", uid)).catch(() => {});
  // Clean up per-user automod state so a re-joining user starts fresh
  delete _violationState[uid];
  delete _spamTrack[uid];
}

// ─────────────────────────────────────────────────────────────────
// Global reconnect banner (shown if ANY peer is reconnecting)
// ─────────────────────────────────────────────────────────────────
function showReconnectBanner() { $("reconnect-banner").classList.add("visible"); }
function hideReconnectBanner() {
  // Only hide when no box is in reconnecting state
  const anyReconnecting = Object.values(guests).some(g =>
    g.pc?.connectionState === "disconnected" || g.pc?.connectionState === "failed"
  );
  if (!anyReconnecting) $("reconnect-banner").classList.remove("visible");
}

// ─────────────────────────────────────────────────────────────────
// Local media acquisition — with clear error messages
// ─────────────────────────────────────────────────────────────────
async function acquireLocalStream(constraints) {
  // Start at a quality appropriate for the detected network
  const cappedLevel = capQualityByNetwork(currentQuality);
  if (cappedLevel !== currentQuality) currentQuality = cappedLevel;
  const qual = QUALITY[currentQuality];
  const c = constraints || {
    video: {
      width:     { ideal: qual.width  },
      height:    { ideal: qual.height },
      frameRate: { ideal: qual.frameRate },
      facingMode
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl:  true,
      sampleRate:       44100
    }
  };
  try {
    localStream = await navigator.mediaDevices.getUserMedia(c);
  } catch (e) {
    // Resolution may not be supported — fall back to unconstrained video
    if (e.name === "OverconstrainedError") {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode }, audio: { echoCancellation: true, noiseSuppression: true } });
      } catch (e2) {
        const msg = getMediaErrorMessage(e2);
        toast(msg);
        const mySlot = slotFor(currentUser?.uid);
        if (mySlot) setBoxStatus(mySlot, "error", msg);
        throw e2;
      }
    } else {
      const msg = getMediaErrorMessage(e);
      toast(msg);
      const mySlot = slotFor(currentUser?.uid);
      if (mySlot) setBoxStatus(mySlot, "error", msg);
      throw e;
    }
  }
  if (isMobile()) {
    navigator.mediaDevices.enumerateDevices().then(devs => {
      const cams = devs.filter(d => d.kind === "videoinput");
      if (cams.length > 1) $("btnFlip").style.display = "";
    });
  }
  startVAD();
  return localStream;
}

// Human-readable messages for every media error type
function getMediaErrorMessage(e) {
  if (!e) return "Camera/mic error.";
  const n = e.name || "";
  if (n === "NotAllowedError"  || n === "PermissionDeniedError") return "Microphone permission denied. Please allow access.";
  if (n === "NotFoundError"    || n === "DevicesNotFoundError")  return "Camera unavailable. No device found.";
  if (n === "NotReadableError" || n === "TrackStartError")       return "Camera is already in use by another app.";
  if (n === "OverconstrainedError")                              return "Camera does not support the requested resolution.";
  if (n === "TypeError")                                         return "No media devices found on this browser.";
  return "Camera/mic access denied. Check browser permissions.";
}

// ─────────────────────────────────────────────────────────────────
// Controls
// ─────────────────────────────────────────────────────────────────
function toggleMic() {
  micEnabled = !micEnabled;
  localStream?.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
  $("btnMic").classList.toggle("active", !micEnabled);
  $("btnMic").innerHTML = (micEnabled ? "🎙️" : "🔇") + '<span class="ctrl-tooltip">' + (micEnabled ? "Mute" : "Unmute") + "</span>";
  updateLocalBadges();
}

function toggleCam() {
  camEnabled = !camEnabled;
  localStream?.getVideoTracks().forEach(t => { t.enabled = camEnabled; });
  $("btnCam").classList.toggle("active", !camEnabled);
  $("btnCam").innerHTML = (camEnabled ? "📷" : "🚫") + '<span class="ctrl-tooltip">' + (camEnabled ? "Camera" : "Cam off") + "</span>";
  const mySlot = slotFor(currentUser.uid);
  if (mySlot) mySlot.classList.toggle("cam-off", !camEnabled);
  updateLocalBadges();
}

async function flipCamera() {
  facingMode = facingMode === "user" ? "environment" : "user";
  const old = localStream;
  old?.getTracks().forEach(t => t.stop());
  await acquireLocalStream();
  const newVid = localStream.getVideoTracks()[0];
  Object.values(guests).forEach(g => {
    const sender = g.pc.getSenders().find(s => s.track?.kind === "video");
    if (sender) sender.replaceTrack(newVid).catch(() => {});
  });
  const mySlot = slotFor(currentUser.uid);
  if (mySlot) { const vid = mySlot.querySelector("video"); vid.srcObject = localStream; }
}

function toggleLock() {
  roomLocked = !roomLocked;
  $("btnLock").innerHTML = (roomLocked ? "🔒" : "🔓") + '<span class="ctrl-tooltip">' + (roomLocked ? "Locked" : "Lock room") + "</span>";
  if (roomId) updateDoc(doc(db, "liveRooms", roomId), { locked: roomLocked }).catch(() => {});
  toast(roomLocked ? "Room locked — no new guests." : "Room unlocked.");
}

function updateLocalBadges() {
  const slot = slotFor(currentUser.uid);
  if (!slot) return;
  const bads = slot.querySelector(".box-badges");
  bads.innerHTML = "";
  if (!micEnabled) { const b = el("div", "badge-icon muted", "🔇"); bads.appendChild(b); }
  if (!camEnabled) { const b = el("div", "badge-icon cam-off", "🚫"); bads.appendChild(b); }
}

// Host mute/cam-off a guest remotely via Firestore command
async function hostMuteGuest(uid) {
  await setDoc(doc(db, "liveRooms", roomId, "commands", uid), { cmd: "mute", from: currentUser.uid, ts: serverTimestamp() });
  const slot = slotFor(uid);
  if (slot) {
    const bads = slot.querySelector(".box-badges");
    const b = el("div", "badge-icon muted", "🔇"); bads.appendChild(b);
  }
}
async function hostDisableCam(uid) {
  await setDoc(doc(db, "liveRooms", roomId, "commands", uid), { cmd: "camOff", from: currentUser.uid, ts: serverTimestamp() });
}
async function hostRemoveGuest(uid) {
  await setDoc(doc(db, "liveRooms", roomId, "commands", uid), { cmd: "remove", from: currentUser.uid, ts: serverTimestamp() });
  closePeer(uid);
}

// Guest listens for commands from host
function listenForHostCommands() {
  const cmdRef = doc(db, "liveRooms", roomId, "commands", currentUser.uid);
  const unsub  = onSnapshot(cmdRef, snap => {
    if (!snap.exists()) return;
    const { cmd, reason } = snap.data();
    if (cmd === "mute"   && micEnabled) toggleMic();
    if (cmd === "camOff" && camEnabled) toggleCam();
    if (cmd === "remove") {
      closePeer(currentUser.uid);
      localStream?.getTracks().forEach(t => t.stop());
      localStream = null;
      showLobby();
      toast("You were removed from the Live.");
    }
    // ── AutoMod: warning banner ──
    if (cmd === "autoWarn") {
      _showAutoModWarning(`⚠️ Warning: ${reason || "Your behavior may violate Shadow Nexus Social community rules"}. Please stop.`);
    }
    // ── AutoMod: removed from Live box (medium violation) ──
    if (cmd === "autoRemove") {
      closePeer(currentUser.uid);
      localStream?.getTracks().forEach(t => t.stop());
      localStream = null;
      showLobby();
      _showAutoModWarning(`🔇 You have been removed from the Live box for: ${reason || "repeated violations"}. You may still watch as a viewer.`);
    }
    // ── AutoMod: removed + blocked (serious violation) ──
    if (cmd === "autoRemoveSerious") {
      closePeer(currentUser.uid);
      localStream?.getTracks().forEach(t => t.stop());
      localStream = null;
      showLobby();
      _showAutoModWarning(`🚨 You have been removed from the Live for a serious violation: ${reason || "serious violation"}. A report has been sent to moderators.`);
    }
    // ── Host ended the entire Live — close player and return viewer to Feed ──
    if (cmd === "liveEnded") {
      if (_liveEndNavigating) { deleteDoc(cmdRef).catch(() => {}); return; }
      _liveEndNavigating = true;
      liveActive = false;
      closePeer(currentUser.uid);
      localStream?.getTracks().forEach(t => t.stop());
      localStream = null;
      _unsubs.forEach(u => u()); _unsubs.length = 0;
      if (_chatSettingsUnsub) { _chatSettingsUnsub(); _chatSettingsUnsub = null; }
      _vadRunning = false;
      if (_vadCtx) { try { _vadCtx.close(); } catch (_) {} _vadCtx = null; }
      exitFullscreen();
      _showLiveEndedOverlay();
      // Use replace() so viewers cannot navigate back to the dead live session.
      setTimeout(() => window.location.replace("index.html"), 3500);
    }
    deleteDoc(cmdRef).catch(() => {});
  });
  _unsubs.push(unsub);
}

// ─────────────────────────────────────────────────────────────────
// Adaptive bitrate monitor (runs every 5 s per peer, fully isolated)
// ─────────────────────────────────────────────────────────────────
function startQualityMonitor(uid) {
  const interval = setInterval(async () => {
    const g = guests[uid];
    if (!g) { clearInterval(interval); return; }
    try {
      const stats = await g.pc.getStats();
      let rtt = 0, lost = 0, bytesSent = 0;
      stats.forEach(r => {
        if (r.type === "remote-inbound-rtp" && r.kind === "video") {
          rtt  = (r.roundTripTime || 0) * 1000;
          lost = r.fractionLost || 0;
        }
        if (r.type === "outbound-rtp" && r.kind === "video") {
          bytesSent = r.bytesSent || 0;
        }
      });
      let target = decideQuality(rtt, lost);
      // Cap to network tier
      target = capQualityByNetwork(target);
      if (target !== g.quality) {
        g.quality = target;
        applyQualityToSender(g.pc, target).catch(() => {});
        updateQualityDot(uid, target);
        // Update status bar + user-visible toast for own box
        if (target === "VERY_LOW") {
          setBoxStatus(uid, "weak");
          if (uid === currentUser?.uid) toast("🟡 Very weak signal — audio-priority mode on");
        } else if (target === "LOW") {
          setBoxStatus(uid, "weak");
          if (uid === currentUser?.uid) toast("🟡 Weak connection — reducing video quality");
        } else if (target === "MEDIUM") {
          setBoxStatus(uid, "weak");
        } else {
          setBoxStatus(uid, "good");
          if (uid === currentUser?.uid && g._wasWeak) toast("✅ Connection improved");
        }
        g._wasWeak = (target !== "HIGH");
      }
    } catch (_) {} // isolate — one bad peer never stops others
  }, 5000);
  if (guests[uid]) guests[uid]._qualityInterval = interval;
}

function decideQuality(rtt, loss) {
  if (rtt > QUALITY_THRESHOLDS.rttExtreme  || loss > QUALITY_THRESHOLDS.lossExtreme)  return "VERY_LOW";
  if (rtt > QUALITY_THRESHOLDS.rttCritical || loss > QUALITY_THRESHOLDS.lossCritical) return "LOW";
  if (rtt > QUALITY_THRESHOLDS.rttHigh     || loss > QUALITY_THRESHOLDS.lossHigh)     return "MEDIUM";
  return "HIGH";
}

async function applyQualityToSender(pc, level) {
  const q = QUALITY[level];
  // ── Video sender ──────────────────────────────────────────────
  const videoSender = pc.getSenders().find(s => s.track?.kind === "video");
  if (videoSender) {
    try {
      const params = videoSender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate   = q.bitrate;
      params.encodings[0].maxFramerate = q.frameRate;
      // VERY_LOW: disable video track entirely when signal is critical
      if (level === "VERY_LOW") {
        videoSender.track.enabled = false;
      } else {
        videoSender.track.enabled = true;
        await videoSender.setParameters(params);
        await videoSender.track.applyConstraints({
          width: q.width, height: q.height, frameRate: q.frameRate
        }).catch(() => {});
      }
    } catch (_) {}
  }
  // ── Audio sender — always applied, bitrate is preserved last ──
  const audioSender = pc.getSenders().find(s => s.track?.kind === "audio");
  if (audioSender) {
    try {
      const ap = audioSender.getParameters();
      if (!ap.encodings?.length) ap.encodings = [{}];
      ap.encodings[0].maxBitrate = q.audioBitrate;
      await audioSender.setParameters(ap);
    } catch (_) {}
  }
}

function updateQualityDot(uid, level) {
  const slot = slotFor(uid);
  if (!slot) return;
  const dot = slot.querySelector(".quality-dot");
  if (!dot) return;
  dot.className = "quality-dot " + { HIGH: "good", MEDIUM: "ok", LOW: "poor", VERY_LOW: "poor" }[level];
}

// ─────────────────────────────────────────────────────────────────
// VAD — active speaker detection via Web Audio
// ─────────────────────────────────────────────────────────────────
let _vadCtx = null;
let _vadRunning = false;
function startVAD() {
  if (!localStream || _vadCtx) return;
  try {
    _vadCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src      = _vadCtx.createMediaStreamSource(localStream);
    const analyser = _vadCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    _vadRunning = true;
    function tick() {
      if (!_vadRunning) return;
      requestAnimationFrame(tick);
      analyser.getByteFrequencyData(buf);
      const vol = buf.reduce((a, b) => a + b, 0) / buf.length;
      const slot = slotFor(currentUser.uid);
      if (slot) slot.classList.toggle("speaking", vol > 18);
    }
    tick();
  } catch (_) { /* Safari / old browsers */ }
}

// ─────────────────────────────────────────────────────────────────
// Firebase Realtime DB — viewer count, chat, reactions
// ─────────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════
// LIVE RULE DETECTION & AUTO-MODERATION ENGINE
// ═════════════════════════════════════════════════════════════════

// ── Pattern lists (never flag profanity alone; only flag when combined) ──
const _THREAT_RE = /\b(i(?:'?ll| will| am going to|'m going to)\s+(?:kill|hurt|attack|shoot|stab|beat|destroy|murder|rape|find)\s+(?:you|u\b)|you(?:'re| are) dead|gonna (?:kill|hurt|find) you|watch your back|i know where you live|coming for you)\b/i;
const _HATE_RE = /\b(go\s+(?:kill\s+yourself|kys)|die\s+(?:you|u)\s+(?:dirty|filthy|stupid|fat|ugly)?\s*(?:n[i1]gg[ae]r|ch[i1]nk|sp[i1][ck]|f[a@]gg?[o0]t|k[i1]ke|w[e3]tb[a@]ck)|sub-?human|inferior race|exterminate\s+(?:you|them|all|these)|gas the|white\s+power|heil\s+hitler)\b/i;
const _HARASSMENT_RE = /\b(nobody\s+(?:likes|wants|cares about)\s+you|you(?:'re| are)\s+(?:worthless|pathetic|trash|garbage|useless|disgusting|ugly|fat|stupid|dumb|a\s+(?:loser|idiot|moron|waste))\b|go\s+(?:cry|die|away|back to)|shut\s+the\s+f[u*]ck\s+up|no\s+one\s+asked\s+you|kill\s+your(?:self|s[e3]lf)\b)\b/i;
const _SLUR_TARGET_RE = /\b(n[i1]gg[ae]r|ch[i1]nk|sp[i1][ck]k?|f[a@]gg?[o0]t|k[i1]ke|w[e3]tb[a@]ck|r[e3]t[a@]rd)\b/i;

// ── Spam tracking per-user ──
// { uid: { msgs: [timestamps], dupeText: { text: count }, warnCount: number } }
const _spamTrack = {};
const _SPAM_WINDOW = 8000;   // ms: sliding window for burst detection
const _SPAM_BURST  = 5;      // messages within window → spam
const _DUPE_LIMIT  = 3;      // same text repeated N times in session
const _WARN_LIMIT  = 2;      // violations before escalation to medium

/**
 * Classify a chat message's severity.
 * Returns: { level: "ok"|"low"|"medium"|"serious", reason: string }
 *
 * Escalation model:
 *  • "serious" — death threats, doxxing threats, severe hate speech → immediate removal
 *  • "medium"  — harassment/slurs after a prior warning, or repeated spam
 *  • "low"     — first-offense harassment/slur (warning), first spam burst
 *  • "ok"      — everything else (casual profanity alone is not actioned)
 */
function classifyChatMsg(uid, text) {
  // ── Serious: always immediate regardless of prior history ──
  if (_THREAT_RE.test(text))  return { level: "serious", reason: "Threat detected" };
  if (_HATE_RE.test(text))    return { level: "serious", reason: "Hate speech detected" };

  // ── Content violations: first offense = warning ("low"), repeat = escalate ("medium") ──
  const vs = _violationState[uid] || (_violationState[uid] = { warnCount: 0, lastWarnTs: 0, offenses: [], removedFromBox: false });

  if (_SLUR_TARGET_RE.test(text) || _HARASSMENT_RE.test(text)) {
    const reason = _SLUR_TARGET_RE.test(text) ? "Targeted slur detected" : "Harassment detected";
    if (vs.warnCount === 0) {
      // First offence — issue a warning, do not escalate yet
      return { level: "low", reason };
    }
    // Already warned — escalate
    return { level: "medium", reason: `Repeated violation: ${reason}` };
  }

  // ── Spam detection (burst + duplicate tracking) ──
  const now = Date.now();
  if (!_spamTrack[uid]) _spamTrack[uid] = { msgs: [], dupeText: {}, warnCount: 0 };
  const st = _spamTrack[uid];

  st.msgs = st.msgs.filter(t => now - t < _SPAM_WINDOW);
  st.msgs.push(now);
  if (st.msgs.length >= _SPAM_BURST) {
    st.warnCount++;
    return st.warnCount > _WARN_LIMIT
      ? { level: "medium", reason: "Repeated spam" }
      : { level: "low",    reason: "Message burst detected" };
  }

  const key = text.trim().toLowerCase().slice(0, 80);
  st.dupeText[key] = (st.dupeText[key] || 0) + 1;
  if (st.dupeText[key] >= _DUPE_LIMIT) {
    st.warnCount++;
    return st.warnCount > _WARN_LIMIT
      ? { level: "medium", reason: "Repeated duplicate messages" }
      : { level: "low",    reason: "Duplicate message" };
  }

  return { level: "ok", reason: "" };
}

// ─────────────────────────────────────────────────────────────────
// AutoMod UI helpers
// ─────────────────────────────────────────────────────────────────

/**
 * Show the in-Live warning banner to the current user (the violator).
 * Severity is inferred from the message prefix (🚨 = serious, 🔇 = medium, ⚠️ = low).
 * The banner auto-dismisses after 8 seconds.
 */
function _showAutoModWarning(message) {
  const banner = $("automod-warn-banner");
  if (!banner) return;

  // Pick icon and title by severity prefix
  const iconEl  = $("automod-warn-icon");
  const titleEl = $("automod-warn-title");
  const textEl  = $("automod-warn-text");

  if (message.startsWith("🚨")) {
    if (iconEl)  iconEl.textContent  = "🚨";
    if (titleEl) titleEl.textContent = "Serious Violation";
    banner.style.borderColor = "rgba(255,51,85,0.75)";
    banner.style.boxShadow   = "0 4px 28px rgba(255,51,85,0.28)";
  } else if (message.startsWith("🔇")) {
    if (iconEl)  iconEl.textContent  = "🔇";
    if (titleEl) titleEl.textContent = "Removed from Live Box";
    banner.style.borderColor = "rgba(255,100,100,0.65)";
    banner.style.boxShadow   = "0 4px 28px rgba(200,50,50,0.22)";
  } else {
    if (iconEl)  iconEl.textContent  = "⚠️";
    if (titleEl) titleEl.textContent = "Community Guidelines Warning";
    banner.style.borderColor = "rgba(255,170,30,0.72)";
    banner.style.boxShadow   = "0 4px 28px rgba(255,140,0,0.22)";
  }

  if (textEl) textEl.textContent = message || "Your message or behavior may violate Shadow Nexus Social community rules. Please stop.";
  banner.classList.add("visible");
  clearTimeout(banner._hideTimer);
  // Serious violations stay longer (12s), others auto-dismiss in 8s
  const dur = message.startsWith("🚨") ? 12000 : 8000;
  banner._hideTimer = setTimeout(() => banner.classList.remove("visible"), dur);
}

/**
 * Dismiss the warning banner immediately (e.g. user taps the close button).
 */
function _dismissAutoModWarning() {
  const banner = $("automod-warn-banner");
  if (!banner) return;
  clearTimeout(banner._hideTimer);
  banner.classList.remove("visible");
}

/**
 * Notify the host that the automod has taken an action.
 * Bumps the badge counter on the Mod History button so the host can review.
 */
function _notifyHostAutoMod(actionLabel) {
  if (!isHost) return;
  const btn = $("btn-mod-logs");
  if (!btn) return;
  // Increment badge counter
  let count = parseInt(btn.dataset.badge || "0", 10) + 1;
  btn.dataset.badge = count;
  let badge = btn.querySelector(".mod-logs-badge-dot");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "mod-logs-badge-dot";
    btn.appendChild(badge);
  }
  badge.textContent = count > 9 ? "9+" : String(count);
  badge.title = `${count} auto-mod action${count > 1 ? "s" : ""} taken`;
  // Also show a toast so the host notices immediately
  toast(`🛡 AutoMod: ${actionLabel}`);
}

/**
 * Reset the notification badge once the host opens the Mod History modal.
 */
function _clearModLogsBadge() {
  const btn = $("btn-mod-logs");
  if (!btn) return;
  btn.dataset.badge = "0";
  btn.querySelector(".mod-logs-badge-dot")?.remove();
}

/**
 * Apply automatic moderation based on violation level.
 *
 * Escalation path:
 *  low     → show ⚠️ warning banner to the user, hide message, log warning
 *  medium  → mute from chat, remove from Live box if already warned, log + notify host
 *  serious → immediately remove from Live box, block from re-joining, file report to moderators
 */
async function _applyAutoMod(uid, displayName, msgDocRef, violation) {
  if (!roomId || !uid) return;
  const { level, reason } = violation;

  // Ensure violation state entry exists
  if (!_violationState[uid]) {
    _violationState[uid] = { warnCount: 0, lastWarnTs: 0, offenses: [], removedFromBox: false };
  }
  const vs = _violationState[uid];

  // ── LOW: First-offense warning ──
  if (level === "low") {
    // Remove the offending message
    updateDoc(msgDocRef, { deleted: true, text: "Message removed by safety filter.", autoMod: true }).catch(() => {});

    // Record the warning in per-user state
    vs.warnCount++;
    vs.lastWarnTs = Date.now();
    vs.offenses.push(reason);

    // Show the warning banner to the offending user
    if (currentUser?.uid === uid) {
      _showAutoModWarning(`⚠️ Warning: ${reason}. Your message or behavior may violate Shadow Nexus Social community rules. Please stop.`);
    } else {
      // Deliver warning via Firestore command so the guest's client shows the banner
      setDoc(doc(db, "liveRooms", roomId, "commands", uid), {
        cmd: "autoWarn", reason, from: "system", ts: serverTimestamp()
      }).catch(() => {});
    }

    // Log so the host can review
    addDoc(collection(db, "moderationLogs"), {
      roomId, targetUid: uid, targetName: displayName,
      action: "warning_issued", reason, level,
      actorUid: "system", ts: serverTimestamp()
    }).catch(() => {});

    _notifyHostAutoMod(`Warning issued to ${displayName}`);
    return;
  }

  // ── MEDIUM: Mute from chat + remove from box if already warned ──
  if (level === "medium") {
    updateDoc(msgDocRef, { deleted: true, text: "Message removed by safety filter.", autoMod: true }).catch(() => {});
    vs.warnCount++;
    vs.offenses.push(reason);

    // Mute user from chat
    const muteUpdate = {};
    muteUpdate[`chatMutedUsers.${uid}`] = true;
    updateDoc(doc(db, "liveRooms", roomId), muteUpdate).catch(() => {});

    // Enable slow mode (safety net for the room)
    if (!slowMode && isHost) {
      slowMode = true;
      updateDoc(doc(db, "liveRooms", roomId), { slowMode: true }).catch(() => {});
      _syncChatStatusBar();
    }

    // Remove from Live box if they haven't been removed yet
    if (!vs.removedFromBox) {
      vs.removedFromBox = true;
      if (uid !== currentUser?.uid && guests[uid]) {
        // Deliver remove command through standard host-command channel
        setDoc(doc(db, "liveRooms", roomId, "commands", uid), {
          cmd: "autoRemove", reason, from: "system", ts: serverTimestamp()
        }).catch(() => {});
        // Close the peer connection on the host side
        hostRemoveGuest(uid);
      } else if (currentUser?.uid === uid) {
        // Self — remove own box
        closePeer(uid);
        localStream?.getTracks().forEach(t => t.stop());
        localStream = null;
        showLobby();
        _showAutoModWarning(`🔇 You have been removed from the Live box for: ${reason}. You may still watch as a viewer.`);
      }
    }

    if (currentUser?.uid !== uid) {
      toast(`🔇 ${displayName} removed from box & muted by safety system.`);
    }

    addDoc(collection(db, "moderationLogs"), {
      roomId, targetUid: uid, targetName: displayName,
      action: "chat_mute_and_remove", reason, level,
      actorUid: "system", ts: serverTimestamp()
    }).catch(() => {});

    _notifyHostAutoMod(`${displayName} muted & removed from box`);
    return;
  }

  // ── SERIOUS: Immediate removal, block from re-joining, report to moderators ──
  if (level === "serious") {
    updateDoc(msgDocRef, { deleted: true, text: "Message removed by safety filter.", autoMod: true }).catch(() => {});
    vs.warnCount++;
    vs.offenses.push(reason);
    vs.removedFromBox = true;

    // Notify the user why they are being removed (they see this briefly before being kicked)
    if (currentUser?.uid === uid) {
      _showAutoModWarning(`🚨 You have been removed from the Live for a serious violation: ${reason}.`);
    } else {
      setDoc(doc(db, "liveRooms", roomId, "commands", uid), {
        cmd: "autoRemoveSerious", reason, from: "system", ts: serverTimestamp()
      }).catch(() => {});
    }

    // Remove from box
    if (uid !== currentUser?.uid && guests[uid]) hostRemoveGuest(uid);
    else if (currentUser?.uid === uid) {
      closePeer(uid);
      localStream?.getTracks().forEach(t => t.stop());
      localStream = null;
      showLobby();
    }

    // Block from re-joining this Live session
    if (isHost) {
      const blockUpdate = {};
      blockUpdate[`blockedUsers.${uid}`] = true;
      updateDoc(doc(db, "liveRooms", roomId), blockUpdate).catch(() => {});
    }

    toast(`🚨 ${displayName} removed for serious violation.`);

    // File report to moderators/admins
    addDoc(collection(db, "reports"), {
      reportedUid: uid, reportedName: displayName,
      reporterUid: "system", context: "auto_mod_live",
      roomId, reason, level, ts: serverTimestamp()
    }).catch(() => {});

    addDoc(collection(db, "moderationLogs"), {
      roomId, targetUid: uid, targetName: displayName,
      action: "remove_live_serious", reason, level,
      actorUid: "system", ts: serverTimestamp()
    }).catch(() => {});

    _notifyHostAutoMod(`🚨 ${displayName} removed — serious violation reported`);
  }
}

// ─────────────────────────────────────────────────────────────────
// REPORT LIVE MODAL
// ─────────────────────────────────────────────────────────────────

/**
 * Open the Report Live modal.
 * @param {object} opts — optional pre-fill:
 *   { targetUid, targetName, targetType, msgId, msgText }
 */
function openReportModal(opts = {}) {
  const m = $("report-live-modal");
  if (!m) return;
  const typeSelect = $("rpt-target-type");
  const uidInput   = $("rpt-target-uid");
  const nameInput  = $("rpt-target-name");
  const msgRow     = $("rpt-msg-row");
  const msgInput   = $("rpt-msg-id");

  if (typeSelect && opts.targetType) typeSelect.value = opts.targetType;
  if (uidInput  && opts.targetUid)   uidInput.value   = opts.targetUid   || "";
  if (nameInput && opts.targetName)  nameInput.value  = opts.targetName  || "";
  if (msgRow)    msgRow.style.display = opts.msgId ? "block" : "none";
  if (msgInput  && opts.msgId)       msgInput.value   = opts.msgId       || "";

  document.querySelectorAll(".rpt-reason-btn").forEach(b => b.classList.remove("selected"));
  const notesEl = $("rpt-notes");
  if (notesEl) notesEl.value = "";
  $("rpt-submit-feedback")?.classList.remove("visible");

  m.classList.add("visible");
}

async function submitReport() {
  if (!currentUser || !roomId) return;
  const typeSelect  = $("rpt-target-type");
  const nameInput   = $("rpt-target-name");
  const uidInput    = $("rpt-target-uid");
  const msgInput    = $("rpt-msg-id");
  const notesEl     = $("rpt-notes");
  const selectedBtn = document.querySelector(".rpt-reason-btn.selected");
  const feedback    = $("rpt-submit-feedback");

  if (!selectedBtn) { toast("Please select a reason for your report."); return; }

  const payload = {
    reporterUid:  currentUser.uid,
    reporterName: myDisplayName,
    roomId,
    targetType:   typeSelect?.value  || "unknown",
    targetName:   nameInput?.value   || "",
    targetUid:    uidInput?.value    || "",
    msgId:        msgInput?.value    || null,
    reason:       selectedBtn.dataset.reason,
    notes:        notesEl?.value?.trim() || "",
    context:      "live",
    ts:           serverTimestamp(),
  };

  try {
    await addDoc(collection(db, "reports"), payload);
    await addDoc(collection(db, "moderationLogs"), {
      roomId,
      targetUid:  payload.targetUid,
      targetName: payload.targetName,
      action:     "user_report",
      reason:     payload.reason,
      level:      "user_submitted",
      actorUid:   currentUser.uid,
      ts:         serverTimestamp(),
    });
    if (feedback) { feedback.textContent = "✅ Report sent. Thank you."; feedback.classList.add("visible"); }
    setTimeout(() => closeReportModal(), 1800);
  } catch (_) {
    toast("Could not send report. Please try again.");
  }
}

function closeReportModal() {
  $("report-live-modal")?.classList.remove("visible");
}

function _attachReportLiveBtn() {
  const btn = $("btn-report-live");
  if (!btn) return;
  btn.onclick = () => openReportModal({
    targetType: "host",
    targetName: $("roomTitle")?.textContent || "",
    targetUid:  "",
  });
}

function reportMessage(msgId, data) {
  openReportModal({
    targetType: "message",
    targetUid:  data.uid  || "",
    targetName: data.name || "Unknown",
    msgId,
    msgText:    data.text || "",
  });
}

// ── Moderator: load and display recent moderation logs ──
async function openModLogs() {
  if (!roomId) return;
  const m = $("mod-logs-modal");
  if (!m) return;
  const list = $("mod-logs-list");
  if (list) list.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:18px;">Loading…</div>';
  m.classList.add("visible");
  _clearModLogsBadge();

  try {
    const q = query(
      collection(db, "moderationLogs"),
      where("roomId", "==", roomId),
      orderBy("ts", "desc"),
      limit(50)
    );
    const snap = await getDocs(q);
    if (!list) return;
    if (snap.empty) {
      list.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:18px;">No actions logged yet.</div>';
      return;
    }
    list.innerHTML = "";
    snap.forEach(d => {
      const data = d.data();
      const row  = document.createElement("div");
      row.className = "mod-log-row";
      const ts = data.ts?.toDate?.() ? data.ts.toDate().toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }) : "–";
      const badge = data.actorUid === "system" ? '<span class="mod-log-badge system">AUTO</span>' : '<span class="mod-log-badge user">USER</span>';
      row.innerHTML = `
        <div class="mod-log-meta">${badge} <span class="mod-log-action">${esc(data.action || "")}</span> <span class="mod-log-time">${ts}</span></div>
        <div class="mod-log-detail">Target: <strong>${esc(data.targetName || data.targetUid || "–")}</strong></div>
        <div class="mod-log-reason">${esc(data.reason || "")}</div>
      `;
      list.appendChild(row);
    });
  } catch (_) {
    if (list) list.innerHTML = '<div style="color:#ff8899;text-align:center;padding:18px;">Could not load logs.</div>';
  }
}

function closeModLogs() {
  $("mod-logs-modal")?.classList.remove("visible");
}

// ── Expose report + mod + automod functions globally ──
window.openReportModal          = openReportModal;
window.closeReportModal         = closeReportModal;
window.submitReport             = submitReport;
window.reportMessage            = reportMessage;
window.openModLogs              = openModLogs;
window.closeModLogs             = closeModLogs;
window._dismissAutoModWarning   = _dismissAutoModWarning;

function setupRTDB() {
  if (!roomId) return;
  roomRtRef   = ref(rtdb, `liveRooms/${roomId}`);
  chatRtRef   = ref(rtdb, `liveRooms/${roomId}/chat`);
  viewerRef   = ref(rtdb, `liveRooms/${roomId}/viewers/${currentUser.uid}`);
  presenceRef = viewerRef;

  set(viewerRef, { uid: currentUser.uid, name: myDisplayName, ts: Date.now() });
  onDisconnect(viewerRef).remove();

  listenViewerCount();
  listenChat();
}

function listenViewerCount() {
  if (!roomRtRef) return;
  const vRef = ref(rtdb, `liveRooms/${roomId}/viewers`);
  onValue(vRef, snap => {
    const count = snap.exists() ? Object.keys(snap.val() || {}).length : 0;
    $("viewerNum").textContent = count;
  });
}

function listenChat() {
  if (!chatRtRef) return;
  // Load last 200 messages; real-time new additions come via "added" changes
  const q = query(collection(db, "liveRooms", roomId, "chat"), orderBy("ts", "asc"), limit(200));
  const unsub = onSnapshot(q, snap => {
    snap.docChanges().forEach(ch => {
      if (ch.type === "added") {
        appendChatMsg(ch.doc.data(), ch.doc.id);
      } else if (ch.type === "modified") {
        updateChatMsg(ch.doc.id, ch.doc.data());
      } else if (ch.type === "removed") {
        removeChatMsgEl(ch.doc.id);
      }
    });
  });
  _unsubs.push(unsub);
  // Also listen to the room doc for chatEnabled / slowMode / pinnedMsgId changes
  listenChatSettings();
}

function listenChatSettings() {
  if (_chatSettingsUnsub) return;   // already listening
  _chatSettingsUnsub = onSnapshot(doc(db, "liveRooms", roomId), snap => {
    // ── Host ended the Live — notify viewer and return them to the Feed ──
    if (!snap.exists() || snap.data().live === false) {
      if (!isHost && liveActive && !_liveEndNavigating) {
        _liveEndNavigating = true;
        liveActive = false;
        // Show a prominent full-screen "Live has ended" overlay
        _showLiveEndedOverlay();
        // Clean up and navigate back after the overlay is seen.
        // Use replace() so viewers cannot navigate back to the dead live session.
        setTimeout(() => {
          _unsubs.forEach(u => u()); _unsubs.length = 0;
          if (_chatSettingsUnsub) { _chatSettingsUnsub(); _chatSettingsUnsub = null; }
          localStream?.getTracks().forEach(t => t.stop());
          localStream = null;
          exitFullscreen();
          window.location.replace("index.html");
        }, 3500);
      }
      return;
    }
    const d = snap.data();
    // Chat on/off
    const nowEnabled = d.chatEnabled !== false;
    if (nowEnabled !== chatEnabled) {
      chatEnabled = nowEnabled;
      _syncChatStatusBar();
      _syncChatInputDisabled();
    }
    // Slow mode
    const nowSlow = !!d.slowMode;
    if (nowSlow !== slowMode) {
      slowMode = nowSlow;
      _syncChatStatusBar();
    }
    // Chat-muted users
    chatMutedUsers = d.chatMutedUsers || {};
    // Pinned message
    const newPinId = d.pinnedMsgId || null;
    if (newPinId !== pinnedMsgId) {
      pinnedMsgId = newPinId;
      _syncPinnedBar(d.pinnedMsgText || null, d.pinnedMsgAuthor || null);
    }
    // Host bar sync
    if (isHost) _syncHostChatBar();
    // Viewer mute check (if current user got muted/unmuted)
    _syncChatInputDisabled();
  });
  _unsubs.push(_chatSettingsUnsub);
}

// ── Update the status bar text (chat off / slow mode) ──
function _syncChatStatusBar() {
  const bar = $("chat-status-bar");
  if (!bar) return;
  if (!chatEnabled) {
    bar.textContent = "🚫 Chat has been turned off by the host.";
    bar.classList.add("visible");
  } else if (slowMode) {
    bar.textContent = "🐢 Slow mode — 1 message every 5 seconds.";
    bar.classList.add("visible");
  } else {
    bar.classList.remove("visible");
    bar.textContent = "";
  }
}

function _syncChatInputDisabled() {
  const off = !chatEnabled || (chatMutedUsers[currentUser?.uid] === true);
  const inp  = $("chat-input");
  const btn  = $("chat-send");
  const inpM = $("chat-input-mobile");
  if (inp) { inp.disabled = off; inp.placeholder = off ? "Chat is disabled…" : "Say something…"; }
  if (btn) btn.disabled = off;
  if (inpM) { inpM.disabled = off; inpM.placeholder = off ? "Chat is disabled…" : "Say something…"; }
}

function _syncPinnedBar(text, author) {
  const bar  = $("chat-pinned-bar");
  const span = $("chat-pinned-text");
  if (!bar || !span) return;
  if (!pinnedMsgId || !text) {
    bar.classList.remove("visible");
  } else {
    span.textContent = author ? `${author}: ${text}` : text;
    bar.classList.add("visible");
  }
  // Also re-style messages
  document.querySelectorAll(".chat-msg[data-msg-id]").forEach(el => {
    el.classList.toggle("pinned-msg", el.dataset.msgId === pinnedMsgId);
  });
}

function _syncHostChatBar() {
  const bar = $("host-chat-bar");
  if (!bar) return;
  bar.classList.add("visible");
  const toggleBtn = $("btn-chat-toggle");
  const slowBtn   = $("btn-slow-mode");
  const label     = $("slow-mode-label");
  if (toggleBtn) {
    toggleBtn.textContent = chatEnabled ? "💬 Chat on" : "🚫 Chat off";
    toggleBtn.classList.toggle("active", !chatEnabled);
  }
  if (slowBtn) slowBtn.classList.toggle("active", slowMode);
  if (label) label.textContent = slowMode ? `(${slowModeDelay / 1000}s delay)` : "";
}

// ── Helper to format a timestamp as HH:MM ──
function _fmtTime(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Build a rich chat message element ──
function _buildMsgEl(data, msgId) {
  if (data.isReaction) {
    const r = el("div", "chat-msg reaction-msg");
    r.dataset.msgId = msgId;
    r.textContent = data.text;
    return r;
  }

  const isOwn   = currentUser && data.uid === currentUser.uid;
  const isMine  = isOwn;
  const msgEl   = el("div", "chat-msg");
  msgEl.dataset.msgId = msgId;
  if (data.pinned || msgId === pinnedMsgId) msgEl.classList.add("pinned-msg");
  if (data.deleted) msgEl.classList.add("deleted-msg");

  // Avatar
  const avatarEl = el("div", "msg-avatar");
  if (data.photoURL) {
    const img = document.createElement("img");
    img.src = data.photoURL;
    img.alt = "";
    img.onerror = () => { img.style.display = "none"; avatarEl.textContent = data.name?.[0]?.toUpperCase() || "?"; };
    avatarEl.appendChild(img);
  } else {
    avatarEl.textContent = data.name?.[0]?.toUpperCase() || "?";
  }

  // Body
  const bodyEl = el("div", "msg-body");

  // Meta row: name + verify + time
  const metaEl = el("div", "msg-meta");
  const nameEl = el("span", `msg-name${data.isHost ? " host" : ""}`, esc(data.name || "User"));
  metaEl.appendChild(nameEl);
  if (data.verified) {
    metaEl.appendChild(el("span", "msg-verify", "✔️"));
  }
  if (data.pinned || msgId === pinnedMsgId) {
    metaEl.appendChild(el("span", "msg-pinned-tag", "📌 pinned"));
  }
  const timeEl = el("span", "msg-time", _fmtTime(data.ts));
  metaEl.appendChild(timeEl);
  bodyEl.appendChild(metaEl);

  // Reply-to quote
  if (data.replyTo?.text) {
    const quoteEl = el("div", "msg-reply-quote",
      `↩ <strong>${esc(data.replyTo.name || "")}</strong>: ${esc(data.replyTo.text)}`);
    bodyEl.appendChild(quoteEl);
  }

  // Message text
  const textContent = data.deleted ? "Message deleted." : esc(data.text || "");
  bodyEl.appendChild(el("div", "msg-text", textContent));

  // Action buttons
  const actions = el("div", "msg-actions");

  // Reply button (everyone)
  const replyBtn = el("button", "msg-action-btn", "↩ Reply");
  replyBtn.addEventListener("click", e => {
    e.stopPropagation();
    setReplyTo({ msgId, name: data.name, text: data.text });
  });
  actions.appendChild(replyBtn);

  // Delete button (own messages or host)
  if (isMine || isHost) {
    const delBtn = el("button", "msg-action-btn danger", isHost && !isMine ? "🗑 Remove" : "🗑 Delete");
    delBtn.addEventListener("click", e => { e.stopPropagation(); deleteMessage(msgId, data); });
    actions.appendChild(delBtn);
  }

  // Pin / unpin button (host only)
  if (isHost) {
    const pinBtn = el("button", "msg-action-btn", msgId === pinnedMsgId ? "📌 Unpin" : "📌 Pin");
    pinBtn.addEventListener("click", e => {
      e.stopPropagation();
      if (msgId === pinnedMsgId) unpinMessage();
      else pinMessage(msgId, data);
    });
    actions.appendChild(pinBtn);

    // Mute user from chat (host, on other users' messages)
    if (data.uid !== currentUser?.uid) {
      const muteLabel = chatMutedUsers[data.uid] ? "💬 Unmute chat" : "🔇 Mute chat";
      const muteBtn = el("button", "msg-action-btn", muteLabel);
      muteBtn.addEventListener("click", e => { e.stopPropagation(); toggleChatMuteUser(data.uid, data.name); });
      actions.appendChild(muteBtn);
    }
  }

  // Report button (everyone, on other users' messages)
  if (!isMine && !data.deleted && !data.isReaction) {
    const rptBtn = el("button", "msg-action-btn warn", "🚩 Report");
    rptBtn.addEventListener("click", e => { e.stopPropagation(); reportMessage(msgId, data); });
    actions.appendChild(rptBtn);
  }

  msgEl.appendChild(avatarEl);
  msgEl.appendChild(bodyEl);
  msgEl.appendChild(actions);
  return msgEl;
}

function appendChatMsg(data, msgId) {
  if (!msgId) return; // defensive: Firestore always provides an id
  const msgEl = _buildMsgEl(data, msgId);
  const panels = [$("chat-messages"), $("mobile-chat-messages")];
  panels.forEach(p => {
    if (!p) return;
    const clone = msgEl.cloneNode(true);
    // Re-wire action buttons on the clone (cloneNode doesn't clone event listeners)
    _wireClonedActions(clone, data, msgId);
    p.appendChild(clone);
    // Auto-scroll only if already near the bottom
    if (p.scrollHeight - p.scrollTop - p.clientHeight < 120) {
      p.scrollTop = p.scrollHeight;
    }
  });
  // Push bubble to mobile overlay (only if drawer is closed)
  if (!data.isReaction && isMobile()) {
    _pushMobileOverlayBubble(data);
  }
}

// Re-wire action button event listeners on a cloned node
function _wireClonedActions(clone, data, msgId) {
  const btns = clone.querySelectorAll(".msg-action-btn");
  btns.forEach(btn => {
    const label = btn.textContent.trim();
    if (label.startsWith("↩")) {
      btn.addEventListener("click", e => { e.stopPropagation(); setReplyTo({ msgId, name: data.name, text: data.text }); });
    } else if (label.includes("Delete") || label.includes("Remove")) {
      btn.addEventListener("click", e => { e.stopPropagation(); deleteMessage(msgId, data); });
    } else if (label.includes("Pin") || label.includes("Unpin")) {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        if (msgId === pinnedMsgId) unpinMessage(); else pinMessage(msgId, data);
      });
    } else if (label.includes("Mute") || label.includes("Unmute")) {
      btn.addEventListener("click", e => { e.stopPropagation(); toggleChatMuteUser(data.uid, data.name); });
    } else if (label.includes("Report")) {
      btn.addEventListener("click", e => { e.stopPropagation(); reportMessage(msgId, data); });
    }
  });
}

// Called when a message is modified (e.g., deleted flag set, or pinned)
function updateChatMsg(msgId, data) {
  document.querySelectorAll(`.chat-msg[data-msg-id="${msgId}"]`).forEach(el => {
    const textEl = el.querySelector(".msg-text");
    if (textEl) {
      textEl.textContent = data.deleted ? "Message deleted." : (data.text || "");
    }
    el.classList.toggle("deleted-msg", !!data.deleted);
    el.classList.toggle("pinned-msg",  msgId === pinnedMsgId);
  });
}

function removeChatMsgEl(msgId) {
  document.querySelectorAll(`.chat-msg[data-msg-id="${msgId}"]`).forEach(el => el.remove());
}

// ── Push a floating bubble to the mobile overlay ──
function _pushMobileOverlayBubble(data) {
  const overlay = $("mobile-chat-overlay");
  if (!overlay) return;
  // Keep max 6 bubbles visible
  while (overlay.children.length >= 6) overlay.firstChild.remove();
  const bubble = el("div", "mob-bubble",
    `<span class="mob-name${data.isHost ? " host" : ""}">${esc(data.name || "")}</span>: ${esc(data.text || "")}`);
  overlay.appendChild(bubble);
  // Auto-remove after 6s
  setTimeout(() => { if (bubble.parentNode) bubble.remove(); }, 6000);
}

async function sendChat() {
  if (!chatEnabled || chatMutedUsers[currentUser?.uid]) {
    toast("Chat is currently disabled.");
    return;
  }
  const input = $("chat-input");
  const text  = input.value.trim();
  if (!text || !roomId) return;
  // Slow mode check
  if (slowMode && !isHost) {
    const now = Date.now();
    if (now - _lastMsgTime < slowModeDelay) {
      const wait = Math.ceil((slowModeDelay - (now - _lastMsgTime)) / 1000);
      toast(`🐢 Slow mode — wait ${wait}s`);
      return;
    }
  }
  // ── Rule detection: classify before sending ──
  if (!isHost) {
    const violation = classifyChatMsg(currentUser.uid, text);
    if (violation.level !== "ok") {
      input.value = "";
      const payload = {
        uid: currentUser.uid, name: myDisplayName,
        photoURL: myPhotoURL || null, verified: myVerified || false,
        text, isHost, ts: serverTimestamp()
      };
      if (_replyTo) { payload.replyTo = { msgId: _replyTo.msgId, name: _replyTo.name, text: _replyTo.text }; clearReplyTo(); }
      const docRef = await addDoc(collection(db, "liveRooms", roomId, "chat"), payload);
      await _applyAutoMod(currentUser.uid, myDisplayName, doc(db, "liveRooms", roomId, "chat", docRef.id), violation);
      _lastMsgTime = Date.now();
      return;
    }
  }
  input.value = "";
  _lastMsgTime = Date.now();
  const payload = {
    uid:      currentUser.uid,
    name:     myDisplayName,
    photoURL: myPhotoURL || null,
    verified: myVerified || false,
    text,
    isHost:   isHost,
    ts:       serverTimestamp()
  };
  if (_replyTo) {
    payload.replyTo = { msgId: _replyTo.msgId, name: _replyTo.name, text: _replyTo.text };
    clearReplyTo();
  }
  await addDoc(collection(db, "liveRooms", roomId, "chat"), payload);
}

function sendChatMobile() {
  if (!chatEnabled || chatMutedUsers[currentUser?.uid]) {
    toast("Chat is currently disabled.");
    return;
  }
  const input = $("chat-input-mobile");
  const text  = input.value.trim();
  if (!text || !roomId) return;
  if (slowMode && !isHost) {
    const now = Date.now();
    if (now - _lastMsgTime < slowModeDelay) {
      const wait = Math.ceil((slowModeDelay - (now - _lastMsgTime)) / 1000);
      toast(`🐢 Slow mode — wait ${wait}s`);
      return;
    }
  }
  // ── Rule detection: classify before sending ──
  if (!isHost) {
    const violation = classifyChatMsg(currentUser.uid, text);
    if (violation.level !== "ok") {
      input.value = "";
      const payload = {
        uid: currentUser.uid, name: myDisplayName,
        photoURL: myPhotoURL || null, verified: myVerified || false,
        text, isHost, ts: serverTimestamp()
      };
      if (_replyTo) { payload.replyTo = { msgId: _replyTo.msgId, name: _replyTo.name, text: _replyTo.text }; clearReplyTo(); }
      addDoc(collection(db, "liveRooms", roomId, "chat"), payload).then(docRef => {
        _applyAutoMod(currentUser.uid, myDisplayName, doc(db, "liveRooms", roomId, "chat", docRef.id), violation);
      });
      _lastMsgTime = Date.now();
      return;
    }
  }
  input.value = "";
  _lastMsgTime = Date.now();
  const payload = {
    uid:      currentUser.uid,
    name:     myDisplayName,
    photoURL: myPhotoURL || null,
    verified: myVerified || false,
    text,
    isHost:   isHost,
    ts:       serverTimestamp()
  };
  if (_replyTo) {
    payload.replyTo = { msgId: _replyTo.msgId, name: _replyTo.name, text: _replyTo.text };
    clearReplyTo();
  }
  addDoc(collection(db, "liveRooms", roomId, "chat"), payload);
}

function sendReaction(emoji) {
  if (!roomId) return;
  addDoc(collection(db, "liveRooms", roomId, "chat"), {
    uid: currentUser.uid, name: myDisplayName,
    text: emoji, isReaction: true,
    photoURL: myPhotoURL || null,
    verified: myVerified || false,
    ts: serverTimestamp()
  });
  flyReaction(emoji);
}

// ─────────────────────────────────────────────────────────────────
// Chat feature: Reply-to
// ─────────────────────────────────────────────────────────────────
function setReplyTo(ref) {
  _replyTo = ref;
  const previewTxt = `↩ ${ref.name}: ${ref.text}`;
  const desktopPreview = $("chat-reply-preview");
  const desktopText    = $("chat-reply-text");
  if (desktopPreview && desktopText) {
    desktopText.textContent = previewTxt;
    desktopPreview.classList.add("visible");
    $("chat-input")?.focus();
  }
  const mobilePreview = $("chat-reply-preview-mobile");
  const mobileText    = $("chat-reply-text-mobile");
  if (mobilePreview && mobileText) {
    mobileText.textContent = previewTxt;
    mobilePreview.classList.add("visible");
    $("chat-input-mobile")?.focus();
  }
}

function clearReplyTo() {
  _replyTo = null;
  $("chat-reply-preview")?.classList.remove("visible");
  $("chat-reply-preview-mobile")?.classList.remove("visible");
}

// ─────────────────────────────────────────────────────────────────
// Chat feature: Delete message
// ─────────────────────────────────────────────────────────────────
function deleteMessage(msgId, data) {
  if (!roomId || !msgId) return;
  const isOwn = currentUser && data.uid === currentUser.uid;
  if (!isOwn && !isHost) return;
  // Soft-delete: update the message doc
  updateDoc(doc(db, "liveRooms", roomId, "chat", msgId), { deleted: true, text: "Message deleted." }).catch(() => {});
  // If it was pinned, unpin it
  if (msgId === pinnedMsgId) unpinMessage();
}

// ─────────────────────────────────────────────────────────────────
// Chat feature: Pin message (host only)
// ─────────────────────────────────────────────────────────────────
function pinMessage(msgId, data) {
  if (!isHost || !roomId) return;
  pinnedMsgId = msgId;
  updateDoc(doc(db, "liveRooms", roomId), {
    pinnedMsgId:     msgId,
    pinnedMsgText:   data.text || "",
    pinnedMsgAuthor: data.name || ""
  }).catch(() => {});
}

function unpinMessage() {
  if (!isHost || !roomId) return;
  pinnedMsgId = null;
  updateDoc(doc(db, "liveRooms", roomId), {
    pinnedMsgId:     null,
    pinnedMsgText:   null,
    pinnedMsgAuthor: null
  }).catch(() => {});
}

function scrollToPinnedMsg() {
  if (!pinnedMsgId) return;
  const el = document.querySelector(`.chat-msg[data-msg-id="${pinnedMsgId}"]`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ─────────────────────────────────────────────────────────────────
// Chat feature: Host toggle chat on/off
// ─────────────────────────────────────────────────────────────────
function toggleChatEnabled() {
  if (!isHost || !roomId) return;
  chatEnabled = !chatEnabled;
  updateDoc(doc(db, "liveRooms", roomId), { chatEnabled }).catch(() => {});
  _syncHostChatBar();
  _syncChatStatusBar();
  _syncChatInputDisabled();
  toast(chatEnabled ? "💬 Chat enabled." : "🚫 Chat disabled.");
}

// ─────────────────────────────────────────────────────────────────
// Chat feature: Slow mode (host only)
// ─────────────────────────────────────────────────────────────────
function toggleSlowMode() {
  if (!isHost || !roomId) return;
  slowMode = !slowMode;
  updateDoc(doc(db, "liveRooms", roomId), { slowMode }).catch(() => {});
  _syncHostChatBar();
  _syncChatStatusBar();
  toast(slowMode ? "🐢 Slow mode on (5s)." : "🐢 Slow mode off.");
}

// ─────────────────────────────────────────────────────────────────
// Chat feature: Mute a user from chat (host only)
// ─────────────────────────────────────────────────────────────────
function toggleChatMuteUser(uid, name) {
  if (!isHost || !roomId) return;
  const isMuted = !!chatMutedUsers[uid];
  chatMutedUsers[uid] = !isMuted;
  // Persist the muted map to Firestore
  const update = {};
  update[`chatMutedUsers.${uid}`] = !isMuted;
  updateDoc(doc(db, "liveRooms", roomId), update).catch(() => {});
  toast(isMuted ? `💬 ${name} can chat again.` : `🔇 ${name} muted from chat.`);
}

function flyReaction(emoji) {
  const stage = $("reaction-stage");
  const r = el("div", "fly-reaction", emoji);
  r.style.left = (Math.random() * 20 - 10) + "px";
  stage.appendChild(r);
  setTimeout(() => r.remove(), 2500);
}

// ─────────────────────────────────────────────────────────────────
// Host context menu (long-press / right-click guest box)
// ─────────────────────────────────────────────────────────────────
let _ctxUid = null;
let _pressTimer = null;

function addContextMenuTrigger(box) {
  const show = (uid, x, y) => {
    if (!isHost || uid === currentUser.uid) return;
    _ctxUid = uid;
    const menu = $("guest-ctx-menu");
    menu.style.left = Math.min(x, window.innerWidth  - 180) + "px";
    menu.style.top  = Math.min(y, window.innerHeight - 200) + "px";
    menu.classList.add("visible");
  };
  box.addEventListener("contextmenu", e => {
    e.preventDefault();
    const uid = box.dataset.uid;
    if (uid) show(uid, e.clientX, e.clientY);
  });
  box.addEventListener("touchstart", e => {
    const uid = box.dataset.uid;
    if (!uid) return;
    _pressTimer = setTimeout(() => show(uid, e.touches[0].clientX, e.touches[0].clientY), 600);
  }, { passive: true });
  box.addEventListener("touchend", () => clearTimeout(_pressTimer));
}

function hideCtxMenu() { $("guest-ctx-menu").classList.remove("visible"); _ctxUid = null; }

$("ctx-mute").onclick    = () => { if (_ctxUid) hostMuteGuest(_ctxUid);    hideCtxMenu(); };
$("ctx-cam").onclick     = () => { if (_ctxUid) hostDisableCam(_ctxUid);   hideCtxMenu(); };
$("ctx-remove").onclick  = () => { if (_ctxUid) hostRemoveGuest(_ctxUid);  hideCtxMenu(); };
$("ctx-restart").onclick = () => { if (_ctxUid) { reconnectPeer(_ctxUid); toast(`Restarting ${guests[_ctxUid]?.displayName || "guest"}…`); } hideCtxMenu(); };
$("ctx-report")?.onclick = () => { if (_ctxUid) { reportUser(_ctxUid, guests[_ctxUid]?.displayName || "Guest"); } hideCtxMenu(); };
$("ctx-block")?.onclick  = () => { if (_ctxUid) { blockUser(_ctxUid,  guests[_ctxUid]?.displayName || "Guest"); hostRemoveGuest(_ctxUid); } hideCtxMenu(); };

// ─────────────────────────────────────────────────────────────────
// Mobile mini-strip — pause hidden video previews to save battery
// ─────────────────────────────────────────────────────────────────
function updateMiniStrip() {
  if (!isMobile()) return;
  const strip = $("mini-strip");
  strip.innerHTML = "";
  Object.entries(guests).forEach(([uid, g]) => {
    if (uid === currentUser.uid) return;
    const box = el("div", "mini-box", "");
    box.dataset.uid = uid;
    const vid = document.createElement("video");
    vid.autoplay = true; vid.playsInline = true; vid.muted = true;
    // Only set srcObject for active speaker on mobile (saves battery)
    if (g.stream) vid.srcObject = g.stream;
    box.appendChild(vid);
    const nm = el("div", "mini-name", esc(g.displayName));
    box.appendChild(nm);
    box.onclick = () => setActiveSpeaker(uid);
    strip.appendChild(box);
  });
  // Pause all mini videos that are not the active speaker (battery saving)
  pauseInactiveMiniVideos();
}

function pauseInactiveMiniVideos() {
  if (!isMobile()) return;
  document.querySelectorAll(".mini-box video").forEach(vid => {
    const box = vid.closest(".mini-box");
    const uid = box?.dataset.uid;
    const activeSlot = document.querySelector('.video-box[data-active="true"]');
    const isActive = activeSlot && activeSlot.dataset.uid === uid;
    if (isActive) {
      vid.play().catch(() => {});
    } else {
      // Pause video to save CPU/battery; keep srcObject so it can resume
      vid.pause();
    }
  });
}

function setActiveSpeaker(uid) {
  document.querySelectorAll(".video-box").forEach(b => { delete b.dataset.active; });
  const slot = slotFor(uid);
  if (slot) slot.dataset.active = "true";
  pauseInactiveMiniVideos();
}

// ─────────────────────────────────────────────────────────────────
// Side tab switching
// ─────────────────────────────────────────────────────────────────
function switchSideTab(tab) {
  document.querySelectorAll(".side-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $("chat-panel")?.classList.toggle("active",     tab === "chat");
  $("requests-panel")?.classList.toggle("active", tab === "requests");
  $("people-panel")?.classList.toggle("active",   tab === "people");
  if (tab === "people") openPeoplePanel();
}
window.switchSideTab = switchSideTab;

// ─────────────────────────────────────────────────────────────────
// Mobile chat drawer
// ─────────────────────────────────────────────────────────────────
function toggleMobileChat() {
  const drawer  = $("mobile-chat-drawer");
  const overlay = $("mobile-chat-overlay");
  const isOpen  = drawer.classList.toggle("open");
  // Hide the floating bubble overlay while drawer is open
  if (overlay) overlay.style.display = isOpen ? "none" : "";
}
window.toggleMobileChat = toggleMobileChat;

// ─────────────────────────────────────────────────────────────────
// Ctrl bar visibility + fullscreen entry
// ─────────────────────────────────────────────────────────────────
function showCtrlBar() {
  $("ctrl-bar").classList.add("visible");
  if (isMobile()) $("mobile-chat-btn").style.display = "flex";
  // Show the always-accessible exit button once we are live
  $("btnExitLive").classList.add("visible");
  // Show contextual safety buttons based on role
  if (!isHost) $("btn-report-live")?.classList.add("visible");
  if (isHost)  $("btn-mod-logs")?.classList.add("visible");
  // Wire mod-logs button here (safe to call multiple times — idempotent)
  const modBtn = $("btn-mod-logs");
  if (modBtn && !modBtn._wired) { modBtn._wired = true; modBtn.onclick = () => openModLogs(); }
  // Request fullscreen — gracefully ignored if not supported or denied
  enterFullscreen();
}

// ─────────────────────────────────────────────────────────────────
// Back / exit — return to Feed without a hard reload
// ─────────────────────────────────────────────────────────────────
async function handleBack() {
  if (liveActive) {
    if (isHost) {
      // Host pressing Exit: treat it the same as End Live — show confirmation
      handleEndLive();
      return;
    }
    // Viewer / guest pressing Exit — show inline overlay, no browser confirm()
    $("leaveConfirm").classList.add("open");
    return;
  }
  exitFullscreen();
  // Return to the Feed without a hard reload — session stays active
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.location.replace("index.html");
  }
}

// Called when viewer taps "Leave" in the leave-confirm overlay
async function confirmLeave() {
  $("leaveConfirm").classList.remove("open");
  await leaveAsGuest();
  liveActive = false;
  $("ctrl-bar").classList.remove("visible");
  $("btnExitLive").classList.remove("visible");
  $("btn-report-live")?.classList.remove("visible");
  $("btn-mod-logs")?.classList.remove("visible");
  if (isMobile()) $("mobile-chat-btn").style.display = "none";
  buildVideoGrid();
  exitFullscreen();
  // Navigate back to the Feed WITHOUT a hard reload so the auth session stays
  // active. Replace the sentinel history entry (or the live.html entry) so
  // the viewer cannot press browser-forward back into a dead stream.
  _navigateToFeed();
}

async function leaveAsGuest() {
  stopGuestConnectionMonitor();
  Object.keys(guests).forEach(uid => closePeer(uid));
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  _vadRunning = false;
  if (_vadCtx) { try { _vadCtx.close(); } catch (_) {} _vadCtx = null; }
  // Remove this viewer from the RTDB viewer count
  if (presenceRef) set(presenceRef, null).catch(() => {});
  // Remove viewerRef explicitly in case presenceRef differs (pure-viewer path)
  if (viewerRef && viewerRef !== presenceRef) set(viewerRef, null).catch(() => {});
  if (roomId && currentUser) {
    deleteDoc(doc(db, "liveRooms", roomId, "requests", currentUser.uid)).catch(() => {});
    deleteDoc(doc(db, "liveRooms", roomId, "signals",  currentUser.uid)).catch(() => {});
  }
  _unsubs.forEach(u => u()); _unsubs.length = 0;
  _chatSettingsUnsub = null;  // allow re-registration on next live session
  hideRequestJoinBtn();
}

// ─────────────────────────────────────────────────────────────────
// Navigate back to the Feed without a hard page reload so the
// Firebase Auth session (and all app state in index.html) is
// preserved.  Uses history.back() when there is a real Feed entry
// in the stack; otherwise replaces with index.html (which still
// keeps the auth cookie / localStorage token intact).
// ─────────────────────────────────────────────────────────────────
function _navigateToFeed() {
  // The sentinel entry we pushed is now the current state.
  // history.back() will pop it and land on the Feed page (index.html)
  // that originally navigated here — same tab, no reload of index.html
  // from scratch because the browser uses the bfcache / page-cache.
  // If there is no real prior entry (user typed live.html directly),
  // fall back to a replace so the history stack stays clean.
  if (window.history.length > 1) {
    // Pop the sentinel + any extra live entries until we reach index.html.
    // A single back() is sufficient because index.html was the page before
    // the sentinel push; the sentinel is the topmost entry.
    window.history.back();
  } else {
    // No prior history — open Feed in-place. replace() keeps the session;
    // it does reload index.html but auth token in localStorage is intact.
    window.location.replace("index.html");
  }
}

// ─────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function isMobile() { return window.innerWidth <= 700; }

function toast(msg, dur = 3500) {
  const t = $("live-toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), dur);
}

// Show a full-screen "This Live has ended" overlay so the viewer sees a clear message
// before being auto-navigated back to the Feed.
function _showLiveEndedOverlay() {
  let overlay = document.getElementById("liveEndedOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "liveEndedOverlay";
    overlay.style.cssText = [
      "position:fixed", "inset:0", "z-index:9999",
      "display:flex", "flex-direction:column", "align-items:center", "justify-content:center",
      "background:rgba(5,15,35,0.96)", "color:#fff", "text-align:center", "padding:32px",
    ].join(";");
    overlay.innerHTML = [
      '<div style="font-size:52px;margin-bottom:18px;">📺</div>',
      '<div style="font-size:24px;font-weight:800;margin-bottom:10px;">This Live has ended.</div>',
      '<div style="font-size:15px;color:#8ab8d8;margin-bottom:6px;">The host has stopped the stream.</div>',
      '<div style="font-size:13px;color:#4a7a9a;">Returning you to the Feed…</div>',
    ].join("");
    document.body.appendChild(overlay);
  }
  overlay.style.display = "flex";
}

// ═════════════════════════════════════════════════════════════════
// PEOPLE PANEL  — Online Presence, Invite-to-Live, Privacy
// ═════════════════════════════════════════════════════════════════

// ── State ──
let _peopleUnsub       = null;   // RTDB online-users listener
let _inviteUnsub       = null;   // Firestore invite listener (for invitee)
let _invitePrivacy     = "everyone"; // current user's invite privacy setting
let _pendingInvite     = null;   // invite payload waiting for user action
let _peopleSelfRef     = null;   // RTDB ref for this user's global presence

// ─────────────────────────────────────────────────────────────────
// Global presence — write to rtdb:/presence/<uid> when online
// ─────────────────────────────────────────────────────────────────
async function startGlobalPresence() {
  if (!currentUser) return;
  // Load invite privacy preference from Firestore profile
  try {
    const snap = await getDoc(doc(db, "users", currentUser.uid));
    if (snap.exists()) _invitePrivacy = snap.data().invitePrivacy || "everyone";
  } catch (_) { /* best-effort */ }

  _peopleSelfRef = ref(rtdb, `presence/${currentUser.uid}`);
  const presenceData = {
    uid:          currentUser.uid,
    displayName:  myDisplayName,
    photoURL:     currentUser.photoURL || null,
    verified:     false,   // updated below if available
    liveRoomId:   null,
    onlineAt:     Date.now(),
    invitePrivacy: _invitePrivacy,
  };

  // Enrich with Firestore verification flag if available
  try {
    const snap = await getDoc(doc(db, "users", currentUser.uid));
    if (snap.exists()) {
      presenceData.verified   = snap.data().verified || snap.data().isVerified || false;
      presenceData.photoURL   = snap.data().photoURL  || snap.data().avatarUrl || currentUser.photoURL || null;
      presenceData.displayName = snap.data().displayName || snap.data().username || myDisplayName;
    }
  } catch (_) { /* best-effort */ }

  await set(_peopleSelfRef, presenceData).catch(() => {});
  onDisconnect(_peopleSelfRef).remove();
}

// Update own presence to mark as currently Live
async function markPresenceLive(rId) {
  if (!_peopleSelfRef) return;
  set(_peopleSelfRef, { ...(await _readPresenceSelf()), liveRoomId: rId || null }).catch(() => {});
}

async function _readPresenceSelf() {
  // helper: read current value back (fallback if we don't cache it)
  return {
    uid:          currentUser?.uid,
    displayName:  myDisplayName,
    photoURL:     currentUser?.photoURL || null,
    verified:     false,
    liveRoomId:   null,
    onlineAt:     Date.now(),
    invitePrivacy: _invitePrivacy,
  };
}

// ─────────────────────────────────────────────────────────────────
// People Panel — load & render online users
// Called when the host switches to the "People" tab
// ─────────────────────────────────────────────────────────────────
function openPeoplePanel() {
  renderPeopleList(); // immediate render with cached/stale data
  _subscribePeoplePresence();
  listenForIncomingInvites(); // (no-op if already subscribed)
  // Show privacy row only for host
  const privRow = $("invite-privacy-row");
  if (privRow) privRow.style.display = isHost ? "flex" : "none";
  // Bind search input
  const searchEl = $("people-search");
  if (searchEl) {
    searchEl.oninput = () => renderPeopleList(searchEl.value.trim().toLowerCase());
  }
}

// Subscribe to RTDB /presence to get live online list
function _subscribePeoplePresence() {
  if (_peopleUnsub) return; // already subscribed
  const presRef = ref(rtdb, "presence");
  const handler = onValue(presRef, snap => {
    _onlineUsersCache = snap.exists() ? Object.values(snap.val() || {}) : [];
    const q = $("people-search")?.value?.trim().toLowerCase() || "";
    renderPeopleList(q);
    // Update badge count (online users excluding self)
    const count = _onlineUsersCache.filter(u => u.uid !== currentUser?.uid).length;
    const badge = $("people-badge");
    if (badge) { badge.textContent = count || ""; badge.classList.toggle("has-items", count > 0); }
  });
  // Store unsubscribe: RTDB `onValue` returns an unsubscribe fn
  _peopleUnsub = () => off(presRef, "value", handler);
  _unsubs.push(_peopleUnsub);
}

let _onlineUsersCache = [];

// Render the people list (optionally filtered by query string)
function renderPeopleList(query = "") {
  const list = $("people-list");
  if (!list) return;
  list.innerHTML = "";

  // Filter self out; apply search query
  let users = _onlineUsersCache.filter(u => u.uid !== currentUser?.uid);
  if (query) users = users.filter(u =>
    (u.displayName || "").toLowerCase().includes(query)
  );

  if (users.length === 0) {
    list.innerHTML = `<div class="people-empty">No one else is online right now.<br>Invite sent users will appear here.</div>`;
    return;
  }

  // Sort: online first, then live, then offline
  const statusOrder = u => u.liveRoomId ? 0 : (u.onlineAt && Date.now() - u.onlineAt < 3_600_000 ? 1 : 2);
  users.sort((a, b) => statusOrder(a) - statusOrder(b));

  // Single flat section — no friends/family grouping since social graph
  // is not yet present on the client; add section headers once available.
  const hdr = document.createElement("div");
  hdr.className = "people-section-hdr";
  hdr.textContent = `Online now (${users.length})`;
  list.appendChild(hdr);

  users.forEach(u => {
    const row = _buildPersonRow(u);
    list.appendChild(row);
  });
}

// Build a single person row element
function _buildPersonRow(u) {
  const isInThisLive = u.liveRoomId === roomId;
  const isLive       = !!u.liveRoomId && !isInThisLive;
  const statusClass  = u.liveRoomId ? "live" : "online";
  const statusTxt    = isInThisLive ? "Already in this Live" : u.liveRoomId ? "🔴 Currently Live" : "🟢 Online";

  const row = el("div", "person-row");
  row.dataset.uid = u.uid;

  const avatarHtml = u.photoURL
    ? `<img src="${esc(u.photoURL)}" alt="">`
    : `👤`;
  const verifyHtml = u.verified ? `<span class="verify-badge" title="Verified">✔️</span>` : "";

  row.innerHTML = `
    <div class="person-avatar">
      ${avatarHtml}
      <div class="person-status-dot ${statusClass}"></div>
    </div>
    <div class="person-info">
      <div class="person-name">${esc(u.displayName || "User")} ${verifyHtml}</div>
      <div class="person-status-txt ${statusClass}">${statusTxt}</div>
    </div>`;

  // Only show Invite button if host is live and person is not already in this Live
  if (isHost && liveActive && !isInThisLive) {
    const btn = el("button", isLive ? "invite-btn in-live" : "invite-btn", isLive ? "In Live" : "➕ Invite");
    if (!isLive) {
      btn.onclick = () => sendInviteToUser(u, btn);
    }
    row.appendChild(btn);
  }

  return row;
}

// ─────────────────────────────────────────────────────────────────
// Send invite — host writes to Firestore invites subcollection
// ─────────────────────────────────────────────────────────────────
async function sendInviteToUser(u, btn) {
  if (!isHost || !liveActive || !roomId) return;
  btn.textContent = "Sending…";
  btn.disabled = true;
  try {
    await setDoc(doc(db, "users", u.uid, "liveInvites", roomId), {
      roomId,
      hostUid:     currentUser.uid,
      hostName:    myDisplayName,
      invitedAt:   serverTimestamp(),
      status:      "pending",
    });
    btn.textContent = "✓ Sent";
    btn.className   = "invite-btn sent";
    toast(`📨 Invited ${u.displayName}`);
  } catch (e) {
    btn.textContent = "➕ Invite";
    btn.disabled    = false;
    toast("Could not send invite. Try again.");
  }
}

// ─────────────────────────────────────────────────────────────────
// Listen for incoming invites — runs for all users (not only guests)
// ─────────────────────────────────────────────────────────────────
function listenForIncomingInvites() {
  if (_inviteUnsub || !currentUser) return;
  const invRef = collection(db, "users", currentUser.uid, "liveInvites");
  const unsub  = onSnapshot(invRef, snap => {
    snap.docChanges().forEach(ch => {
      if (ch.type === "added" || ch.type === "modified") {
        const data = ch.doc.data();
        if (data.status === "pending") {
          // Check privacy gate
          if (_invitePrivacy === "none") return;
          // TODO: add friends/family checks when social graph is available
          showInviteNotification(data);
        }
      }
    });
  });
  _inviteUnsub = unsub;
  _unsubs.push(unsub);
}

// Show the invite overlay
function showInviteNotification(invite) {
  _pendingInvite = invite;
  $("invite-modal-title").textContent = `${esc(invite.hostName)} invited you to join their Live`;
  $("invite-modal-sub").textContent   = "You will enter as a guest. Camera & mic will be requested.";
  $("invite-overlay").classList.add("visible");
}

function hideInviteOverlay() {
  $("invite-overlay").classList.remove("visible");
  _pendingInvite = null;
}

// Accept invite — navigate to the Live room
async function acceptLiveInvite() {
  if (!_pendingInvite) return;
  const inv = _pendingInvite;
  hideInviteOverlay();

  // Mark invite as accepted in Firestore
  setDoc(doc(db, "users", currentUser.uid, "liveInvites", inv.roomId), {
    ...inv, status: "accepted"
  }).catch(() => {});

  // If already on live.html, join directly — otherwise navigate
  if (window.location.pathname.includes("live.html") || window.location.pathname.endsWith("/live")) {
    // Re-use requestToJoin flow
    if (!liveActive) {
      roomId    = inv.roomId;
      liveActive = true;
      $("roomTitle").textContent = `🔴 Live`;
      hideAll();
      setupRTDB();
      listenViewerCount();
      listenChat();
      listenForHostCommands();
    }
    requestToJoin(inv.roomId);
  } else {
    window.location.href = `live.html?room=${encodeURIComponent(inv.roomId)}`;
  }
}

// Decline invite
async function declineLiveInvite() {
  if (!_pendingInvite) return;
  const inv = _pendingInvite;
  hideInviteOverlay();
  setDoc(doc(db, "users", currentUser.uid, "liveInvites", inv.roomId), {
    ...inv, status: "declined"
  }).catch(() => {});
  toast("Invite declined.");
}

// ─────────────────────────────────────────────────────────────────
// Privacy preference — saved to Firestore user doc
// ─────────────────────────────────────────────────────────────────
async function saveInvitePrivacy(val) {
  _invitePrivacy = val;
  if (!currentUser) return;
  try {
    await updateDoc(doc(db, "users", currentUser.uid), { invitePrivacy: val });
  } catch (_) { /* best-effort */ }
}

// ─────────────────────────────────────────────────────────────────
// Expose globals needed by inline HTML onclick handlers
// ─────────────────────────────────────────────────────────────────
window.sendReaction      = sendReaction;
window.sendChatMobile    = sendChatMobile;
window.acceptLiveInvite  = acceptLiveInvite;
window.declineLiveInvite = declineLiveInvite;
window.openPeoplePanel   = openPeoplePanel;

// ─────────────────────────────────────────────────────────────────
// Mobile orientation change — re-acquire stream at new resolution
// ─────────────────────────────────────────────────────────────────
window.addEventListener("orientationchange", async () => {
  if (!localStream || !liveActive) return;
  await new Promise(r => setTimeout(r, 400));
  const newTrack = localStream.getVideoTracks()[0];
  if (newTrack) {
    const q = QUALITY[currentQuality];
    await newTrack.applyConstraints({ width: { ideal: q.width }, height: { ideal: q.height } }).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────
// Page visibility — pause ALL video tracks when hidden (battery/thermal)
// Resume only active tracks when visible again
// ─────────────────────────────────────────────────────────────────
document.addEventListener("visibilitychange", () => {
  if (!localStream) return;
  if (document.hidden) {
    // Pause local video to reduce CPU / prevent overheating
    localStream.getVideoTracks().forEach(t => { t.enabled = false; });
    // Also suspend VAD while hidden
    _vadRunning = false;
  } else {
    if (camEnabled) localStream.getVideoTracks().forEach(t => { t.enabled = true; });
    // Resume VAD
    if (_vadCtx && !_vadRunning) {
      _vadRunning = true;
      // Re-kick VAD loop
      startVAD();
    }
  }
});

// ─────────────────────────────────────────────────────────────────
// Intersection Observer — pause videos scrolled out of view on mobile
// ─────────────────────────────────────────────────────────────────
if ("IntersectionObserver" in window && isMobile()) {
  const videoObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      const vid = entry.target;
      if (entry.isIntersecting) {
        vid.play().catch(() => {});
      } else {
        vid.pause();
      }
    });
  }, { threshold: 0.1 });

  // Observe all videos added to the grid
  const gridObserverCallback = () => {
    document.querySelectorAll(".video-box video, .mini-box video").forEach(v => {
      videoObserver.observe(v);
    });
  };
  const mo = new MutationObserver(gridObserverCallback);
  mo.observe(document.body, { childList: true, subtree: true });
}
