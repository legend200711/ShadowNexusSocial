/**
 * Shadow Nexus — firebase-live.js  v3
 *
 * Auth model
 * ───────────
 *  HOSTING  → requires a full Shadow Nexus Social account (email/password).
 *             Profile data (displayName, username, avatar, followers) is read
 *             from /users/{uid} in Firestore — the same doc the main app writes.
 *
 *  VIEWING  → anonymous Firebase auth is fine.  No account needed.
 *
 * Collections
 * ───────────
 *   liveRooms/{roomId}                   – room metadata (incl. host profile snapshot)
 *   liveRooms/{roomId}/liveMessages/{id} – real-time chat
 *   liveUsers/{uid}                      – presence / room membership
 *
 * RTDB signaling  /liveSignal/{roomId}/guests/{guestUid}/...
 */

import { initializeApp, getApps } from
  'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  browserLocalPersistence,
  setPersistence
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
  getFirestore,
  doc, setDoc, getDoc, updateDoc, deleteDoc,
  collection, addDoc, query, orderBy, limit,
  onSnapshot, serverTimestamp, increment, where, getDocs
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import {
  getDatabase,
  ref, set, push, onValue, onChildAdded, remove, off
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';

/* ─── Firebase config ─────────────────────────────────────────────────── */
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y',
  authDomain:        'horr-a08f4.firebaseapp.com',
  databaseURL:       'https://horr-a08f4-default-rtdb.firebaseio.com',
  projectId:         'horr-a08f4',
  storageBucket:     'horr-a08f4.firebasestorage.app',
  messagingSenderId: '933810617818',
  appId:             '1:933810617818:web:efb24f123337dd987c14e3'
};

/* ─── Singleton init ──────────────────────────────────────────────────── */
// Re-use the app if the main site already initialised it on this page,
// otherwise create a secondary named app so both can coexist.
const _app  = getApps().find(a => a.name === '[DEFAULT]') ||
              getApps().find(a => a.name === 'live-page')  ||
              initializeApp(FIREBASE_CONFIG, 'live-page');
export const _auth = getAuth(_app);

// Ensure the live page reads the same persisted session that index.html wrote.
// browserLocalPersistence is the default for web but we set it explicitly so
// the named 'live-page' app instance always uses the same localStorage token.
setPersistence(_auth, browserLocalPersistence).catch(() => {});
export const _db   = getFirestore(_app);
export const _rtdb = getDatabase(_app);

/* ─── Auth state ──────────────────────────────────────────────────────── */
export let currentUser = null;

export function onAuthReady(cb) {
  return onAuthStateChanged(_auth, user => {
    currentUser = user;
    cb(user);
  });
}

/**
 * Viewers: sign in anonymously so Firestore rules pass.
 * Returns the Firebase user.
 */
export async function ensureAnonAuth() {
  if (_auth.currentUser) return _auth.currentUser;
  const cred = await signInAnonymously(_auth);
  currentUser = cred.user;
  return cred.user;
}

/* ═══════════════════════════════════════════════
   PROFILE  (reads from the main app's /users/{uid} doc)
════════════════════════════════════════════════ */

/**
 * Load the full SNS profile for the signed-in user.
 * Returns { uid, displayName, username, avatar, followers, role }
 * or null if the account doc doesn't exist.
 */
export async function loadMyProfile() {
  const uid = _auth.currentUser?.uid;
  if (!uid) return null;
  // Anonymous users have no profile doc
  if (_auth.currentUser.isAnonymous) return null;

  try {
    const snap = await getDoc(doc(_db, 'users', uid));
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      uid,
      displayName: d.displayName || d.username || 'Unknown',
      username:    d.username    || '',
      avatar:      d.avatar      || '',
      followers:   d.followers   || [],
      role:        d.role        || 'member',
    };
  } catch (_) {
    return null;
  }
}

/**
 * Fetch any user's public profile snapshot for the stream card.
 */
export async function getUserProfile(uid) {
  try {
    const snap = await getDoc(doc(_db, 'users', uid));
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      uid,
      displayName: d.displayName || d.username || 'Unknown',
      username:    d.username    || '',
      avatar:      d.avatar      || '',
      followers:   (d.followers || []).length,
    };
  } catch (_) {
    return null;
  }
}

/* ═══════════════════════════════════════════════
   ROOM OPERATIONS
════════════════════════════════════════════════ */

export function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/**
 * Create a live room.
 * Caller MUST have a real (non-anonymous) SNS account.
 * Prevents duplicate streams from the same UID.
 */
export async function createRoom(profile, roomTitle, category = 'general', guestPerm = 'invite_only', chatMode = 'open') {
  const uid = _auth.currentUser?.uid;
  if (!uid) throw new Error('Not signed in.');
  if (_auth.currentUser.isAnonymous) throw new Error('You need a Shadow Nexus account to go live.');

  // Prevent duplicate: check if this user already has a live room
  const existingQ = query(
    collection(_db, 'liveRooms'),
    where('hostId',  '==', uid),
    where('status',  '==', 'live')
  );
  const existingSnap = await getDocs(existingQ);
  if (!existingSnap.empty) {
    const existingId = existingSnap.docs[0].data().roomId;
    throw new Error('DUPLICATE:' + existingId);
  }

  const roomId = generateRoomId();

  await setDoc(doc(_db, 'liveRooms', roomId), {
    roomId,
    hostId:          uid,
    hostName:        profile.displayName,
    hostUsername:    profile.username,
    hostAvatar:      profile.avatar,
    hostFollowers:   profile.followers.length,
    title:           roomTitle || 'Shadow Nexus LIVE',
    category,
    guestPerm,
    chatMode,
    status:          'live',
    viewers:         0,
    likes:           0,
    createdAt:       serverTimestamp(),
    endedAt:         null,
  });

  // Mark the host's presence
  await setDoc(doc(_db, 'liveUsers', uid), {
    userId:      uid,
    roomId,
    name:        profile.displayName,
    username:    profile.username,
    avatar:      profile.avatar,
    role:        'host',
    joinedAt:    serverTimestamp(),
  });

  // Write a live badge to the user's own profile doc
  await updateDoc(doc(_db, 'users', uid), {
    isLive:      true,
    liveRoomId:  roomId,
  }).catch(() => {});

  return roomId;
}

/** Fetch a room document. */
export async function getRoom(roomId) {
  const snap = await getDoc(doc(_db, 'liveRooms', roomId));
  return snap.exists() ? snap.data() : null;
}

/** Join as viewer — anonymous auth is fine. */
export async function joinRoom(roomId, name) {
  const uid = _auth.currentUser?.uid;
  if (!uid) throw new Error('Not authenticated');

  await updateDoc(doc(_db, 'liveRooms', roomId), {
    viewers: increment(1),
  });

  // For non-anonymous, try to load their real profile name
  let displayName = name;
  if (!_auth.currentUser.isAnonymous) {
    const profile = await loadMyProfile();
    if (profile) displayName = profile.displayName;
  }

  await setDoc(doc(_db, 'liveUsers', uid), {
    userId:   uid,
    roomId,
    name:     displayName || 'Viewer',
    role:     'viewer',
    joinedAt: serverTimestamp(),
  });
}

/** Leave / decrement. */
export async function leaveRoom(roomId) {
  const uid = _auth.currentUser?.uid;
  if (!uid) return;
  await updateDoc(doc(_db, 'liveRooms', roomId), { viewers: increment(-1) }).catch(() => {});
  await deleteDoc(doc(_db, 'liveUsers', uid)).catch(() => {});
}

/**
 * Host ends the stream.
 * Security: only callable by the host (uid check is also in Firestore rules).
 */
export async function endRoom(roomId) {
  const uid = _auth.currentUser?.uid;
  if (!uid) return;

  await updateDoc(doc(_db, 'liveRooms', roomId), {
    status:  'ended',
    endedAt: serverTimestamp(),
  }).catch(() => {});

  // Clear signaling
  await remove(ref(_rtdb, `liveSignal/${roomId}`)).catch(() => {});
  await deleteDoc(doc(_db, 'liveUsers', uid)).catch(() => {});

  // Remove the live badge from the host's profile
  await updateDoc(doc(_db, 'users', uid), {
    isLive:     false,
    liveRoomId: null,
  }).catch(() => {});
}

/** Watch a single room doc in real time. */
export function watchRoom(roomId, cb) {
  return onSnapshot(doc(_db, 'liveRooms', roomId), snap => {
    cb(snap.exists() ? snap.data() : null);
  });
}

/** Watch ALL active live rooms for the discovery feed. */
export function watchAllRooms(cb) {
  const q = query(
    collection(_db, 'liveRooms'),
    where('status', '==', 'live'),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(q, snap => {
    const rooms = [];
    snap.forEach(d => rooms.push(d.data()));
    cb(rooms);
  });
}

/* ═══════════════════════════════════════════════
   CHAT
════════════════════════════════════════════════ */

/** Send a chat message. Uses real profile name if available. */
export async function sendMessage(roomId, text) {
  const uid = _auth.currentUser?.uid;
  if (!uid || !text?.trim()) return;

  // Resolve sender name: prefer liveUsers doc (already populated on join)
  let senderName = 'Viewer';
  let senderAvatar = '';
  try {
    const liveSnap = await getDoc(doc(_db, 'liveUsers', uid));
    if (liveSnap.exists()) {
      senderName   = liveSnap.data().name   || senderName;
      senderAvatar = liveSnap.data().avatar || '';
    }
  } catch (_) {}

  await addDoc(collection(_db, 'liveRooms', roomId, 'liveMessages'), {
    userId:   uid,
    username: senderName,
    avatar:   senderAvatar,
    message:  text.trim().substring(0, 200),
    timestamp: serverTimestamp(),
  });
}

/** Real-time message stream (last 100). */
export function watchMessages(roomId, cb) {
  const q = query(
    collection(_db, 'liveRooms', roomId, 'liveMessages'),
    orderBy('timestamp', 'asc'),
    limit(100)
  );
  return onSnapshot(q, snap => {
    const msgs = [];
    snap.forEach(d => msgs.push({ id: d.id, ...d.data() }));
    cb(msgs);
  });
}

/* ═══════════════════════════════════════════════
   WEBRTC SIGNALING  (RTDB)
════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════
   LIKES
════════════════════════════════════════════════ */

/** Increment the room's like count by 1. */
export async function sendLike(roomId) {
  const uid = _auth.currentUser?.uid;
  if (!uid || !roomId) return;
  await updateDoc(doc(_db, 'liveRooms', roomId), { likes: increment(1) });
}

/** Watch the like count in real time. cb(n) is called on every change. */
export function watchLikes(roomId, cb) {
  return onSnapshot(doc(_db, 'liveRooms', roomId), snap => {
    if (snap.exists()) cb(snap.data().likes ?? 0);
  });
}

export function publishGuestOffer(roomId, guestUid, sdp) {
  return set(ref(_rtdb, `liveSignal/${roomId}/guests/${guestUid}/offer`), { sdp, ts: Date.now() });
}
export function publishGuestAnswer(roomId, guestUid, sdp) {
  return set(ref(_rtdb, `liveSignal/${roomId}/guests/${guestUid}/answer`), { sdp, ts: Date.now() });
}
export function publishGuestIce(roomId, guestUid, role, candidate) {
  return push(ref(_rtdb, `liveSignal/${roomId}/guests/${guestUid}/ice/${role}`), candidate);
}
export function watchGuestOffer(roomId, guestUid, cb) {
  const r = ref(_rtdb, `liveSignal/${roomId}/guests/${guestUid}/offer`);
  onValue(r, snap => { if (snap.exists()) cb(snap.val()); }, { onlyOnce: true });
}
export function watchGuestAnswer(roomId, guestUid, cb) {
  const r = ref(_rtdb, `liveSignal/${roomId}/guests/${guestUid}/answer`);
  onValue(r, snap => { if (snap.exists()) cb(snap.val()); }, { onlyOnce: true });
}
export function watchGuestIce(roomId, guestUid, role, cb) {
  const r = ref(_rtdb, `liveSignal/${roomId}/guests/${guestUid}/ice/${role}`);
  onChildAdded(r, snap => { if (snap.exists()) cb(snap.val()); });
  return () => off(r);
}
export function watchGuestList(roomId, cb) {
  const r = ref(_rtdb, `liveSignal/${roomId}/guests`);
  onValue(r, snap => {
    const guests = [];
    if (snap.exists()) snap.forEach(c => guests.push(c.key));
    cb(guests);
  });
  return () => off(r);
}
export function removeGuestSignal(roomId, guestUid) {
  return remove(ref(_rtdb, `liveSignal/${roomId}/guests/${guestUid}`)).catch(() => {});
}
