/**
 * snx-emulator-test/tests/run-tests.js
 *
 * Automated test runner for Shadow Nexus Social against the Firebase Emulator.
 * Tests: Auth init, Firestore reads/writes, Security Rules, RTDB, loading-loop detection.
 *
 * NEVER touches production Firebase.
 * All connections go to 127.0.0.1 emulator ports.
 *
 * Run: node tests/run-tests.js
 */

'use strict';

process.env.FIRESTORE_EMULATOR_HOST       = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST   = '127.0.0.1:9099';
process.env.FIREBASE_DATABASE_EMULATOR_HOST = '127.0.0.1:9000';

const { initializeApp }         = require('firebase-admin/app');
const { getAuth }               = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getDatabase }           = require('firebase-admin/database');

// Client SDK for rule-aware testing
const clientApp  = require('firebase/app');
const clientAuth = require('firebase/auth');
const clientFS   = require('firebase/firestore');
const clientRTDB = require('firebase/database');

// ── Test framework ────────────────────────────────────────────────────────────
let passed = 0, failed = 0, warnings = 0;
const results = {};

function PASS(name, detail = '')  { passed++;   results[name] = { status: 'PASS',    detail }; console.log(`  ✅ PASS  ${name}${detail ? ' — ' + detail : ''}`); }
function FAIL(name, detail = '')  { failed++;   results[name] = { status: 'FAIL',    detail }; console.log(`  ❌ FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
function WARN(name, detail = '')  { warnings++; results[name] = { status: 'WARN',    detail }; console.log(`  ⚠️  WARN  ${name}${detail ? ' — ' + detail : ''}`); }
function INFO(msg)                {                                                              console.log(`     ℹ   ${msg}`); }
function SECTION(title)           { console.log(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`); }

// ── Admin SDK init ────────────────────────────────────────────────────────────
const adminApp  = initializeApp({ projectId: 'snx-emulator-test', databaseURL: 'http://127.0.0.1:9000/?ns=snx-emulator-test' }, 'test-admin');
const adminAuth = getAuth(adminApp);
const adminDb   = getFirestore(adminApp);
const rtdb      = getDatabase(adminApp);

// ── Client SDK init (for rules-aware reads) ───────────────────────────────────
const CLIENT_CONFIG = {
  apiKey:            'fake-key-emulator-only',
  authDomain:        'snx-emulator-test.firebaseapp.com',
  databaseURL:       'http://127.0.0.1:9000/?ns=snx-emulator-test',
  projectId:         'snx-emulator-test',
  storageBucket:     'snx-emulator-test.appspot.com',
  messagingSenderId: '000000000000',
  appId:             '1:000000000000:web:00000000000000000000'
};

const cApp   = clientApp.initializeApp(CLIENT_CONFIG, 'test-client');
const cAuth  = clientAuth.getAuth(cApp);
const cDb    = clientFS.getFirestore(cApp);
const cRtdb  = clientRTDB.getDatabase(cApp);

clientAuth.connectAuthEmulator(cAuth,    'http://127.0.0.1:9099',  { disableWarnings: true });
clientFS.connectFirestoreEmulator(cDb,   '127.0.0.1', 8080);
clientRTDB.connectDatabaseEmulator(cRtdb, '127.0.0.1', 9000);

const TEST_UID      = 'test-user-001';
const FOUNDER_UID   = 'founder-001';
const TEST_EMAIL    = 'testuser@snx.local';
const TEST_PASS     = 'Test1234!';
const FOUNDER_EMAIL = 'christijerina46@gmail.com';
const FOUNDER_PASS  = 'Founder1234!';

// ── Main test runner ──────────────────────────────────────────────────────────
async function runTests() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║     SHADOW NEXUS SOCIAL — FIREBASE EMULATOR TEST SUITE      ║');
  console.log('║  PRODUCTION: NOT TOUCHED. All traffic → 127.0.0.1 emulators ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 1 — AUTH INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════
  SECTION('TEST 1 — AUTH INITIALIZATION');
  try {
    // Verify emulator is reachable — list users via admin
    const listResult = await adminAuth.listUsers(5);
    if (listResult.users.length >= 2) {
      PASS('auth/emulator-reachable', `${listResult.users.length} users found`);
    } else {
      WARN('auth/emulator-reachable', `only ${listResult.users.length} users (expected ≥2 from seed)`);
    }
  } catch (e) {
    FAIL('auth/emulator-reachable', e.message);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 2 — AUTH LOGIN (client SDK)
  // ═══════════════════════════════════════════════════════════════════════════
  SECTION('TEST 2 — AUTH LOGIN');
  let testUserCredential = null;
  try {
    testUserCredential = await clientAuth.signInWithEmailAndPassword(cAuth, TEST_EMAIL, TEST_PASS);
    PASS('auth/login-test-user', `UID=${testUserCredential.user.uid}`);
  } catch (e) {
    FAIL('auth/login-test-user', e.message);
  }

  // ── Auth state resolution — simulate the critical onAuthStateChanged wait ──
  let authResolved = false;
  let authResolveMs = null;
  const authStart = Date.now();
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // This is the loading loop condition: auth never resolves
        reject(new Error('LOADING LOOP DETECTED: onAuthStateChanged did not fire within 8 seconds'));
      }, 8000);
      const unsub = clientAuth.onAuthStateChanged(cAuth, (user) => {
        unsub();
        clearTimeout(timeout);
        authResolveMs = Date.now() - authStart;
        authResolved = !!user;
        resolve(user);
      });
    });
    PASS('auth/onAuthStateChanged-resolves', `resolved in ${authResolveMs}ms, user=${authResolved}`);
    if (authResolveMs > 3000) {
      WARN('auth/onAuthStateChanged-speed', `took ${authResolveMs}ms — slow auth resolution can cause visible loading gate`);
    }
  } catch (e) {
    FAIL('auth/onAuthStateChanged-resolves', e.message);
    INFO('This is the primary loading loop cause if it happens against production');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 3 — SITESETINGS/CONFIG (critical: gates entire app UI)
  // ═══════════════════════════════════════════════════════════════════════════
  SECTION('TEST 3 — siteSettings/config (auth-gate critical path)');
  try {
    const snap = await clientFS.getDoc(clientFS.doc(cDb, 'siteSettings', 'config'));
    if (snap.exists()) {
      const cfg = snap.data();
      PASS('firestore/siteSettings-config-read', `maintenanceMode=${cfg.maintenanceMode}`);
      if (cfg.maintenanceMode === true) {
        WARN('firestore/maintenance-mode', 'maintenanceMode=true — all non-founder users get redirected immediately on load (loading loop symptom)');
      } else {
        PASS('firestore/maintenance-mode-off', 'maintenanceMode=false — normal load path');
      }
    } else {
      WARN('firestore/siteSettings-config-missing', 'siteSettings/config doc does not exist — onSnapshot returns no data, app still loads but toggles default to true/false');
    }
  } catch (e) {
    FAIL('firestore/siteSettings-config-read', e.message);
    if (e.code === 'permission-denied') {
      INFO('RULE FAILURE: siteSettings/config requires isSignedIn() — unauthenticated read blocked');
      INFO('The app fires this onSnapshot BEFORE auth resolves — if there is no user yet, this will permission-deny and retry infinitely');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CRITICAL CHECK: siteSettings/config is read at startup by an onSnapshot()
  // that fires BEFORE auth resolves. The rule is "allow read: if true" so it
  // does NOT require auth. Test it unauthenticated:
  // ─────────────────────────────────────────────────────────────────────────
  try {
    await clientAuth.signOut(cAuth);
    const snapUnauth = await clientFS.getDoc(clientFS.doc(cDb, 'siteSettings', 'config'));
    PASS('firestore/siteSettings-unauthenticated-read', 'siteSettings/config readable without auth (rule: allow read: if true)');
    await clientAuth.signInWithEmailAndPassword(cAuth, TEST_EMAIL, TEST_PASS); // re-login
  } catch (e) {
    if (e.code === 'permission-denied') {
      FAIL('firestore/siteSettings-unauthenticated-read', 'PERMISSION DENIED unauthenticated — but the app fires this before login');
      INFO('This causes the siteSettings onSnapshot to fail on every cold load before auth resolves');
    } else {
      WARN('firestore/siteSettings-unauthenticated-read', e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 4 — FIRESTORE READS (authenticated)
  // ═══════════════════════════════════════════════════════════════════════════
  SECTION('TEST 4 — FIRESTORE READS (authenticated)');

  // users/{uid}
  try {
    const usnap = await clientFS.getDoc(clientFS.doc(cDb, 'users', TEST_UID));
    if (usnap.exists()) PASS('firestore/users-read', `role=${usnap.data().role}`);
    else FAIL('firestore/users-read', 'doc not found (seed may have failed)');
  } catch (e) {
    FAIL('firestore/users-read', `${e.code}: ${e.message}`);
  }

  // posts collection
  try {
    const pq = clientFS.query(clientFS.collection(cDb, 'posts'), clientFS.limit(5));
    const psnap = await clientFS.getDocs(pq);
    PASS('firestore/posts-read', `${psnap.size} posts`);
  } catch (e) {
    FAIL('firestore/posts-read', `${e.code}: ${e.message}`);
  }

  // chats (messages)
  const chatId = [TEST_UID, FOUNDER_UID].sort().join('_');
  try {
    const csnap = await clientFS.getDoc(clientFS.doc(cDb, 'chats', chatId));
    if (csnap.exists()) PASS('firestore/chats-read', `participants=${csnap.data().participants}`);
    else FAIL('firestore/chats-read', 'chat doc missing');
  } catch (e) {
    FAIL('firestore/chats-read', `${e.code}: ${e.message}`);
  }

  // liveRooms
  try {
    const lq = clientFS.query(clientFS.collection(cDb, 'liveRooms'), clientFS.where('isLive', '==', true));
    const lsnap = await clientFS.getDocs(lq);
    PASS('firestore/liveRooms-read', `${lsnap.size} active live rooms`);
  } catch (e) {
    FAIL('firestore/liveRooms-read', `${e.code}: ${e.message}`);
  }

  // profileMusic
  try {
    const mq = clientFS.query(clientFS.collection(cDb, 'profileMusic'), clientFS.where('ownerUid', '==', TEST_UID));
    const msnap = await clientFS.getDocs(mq);
    PASS('firestore/profileMusic-read', `${msnap.size} tracks`);
  } catch (e) {
    FAIL('firestore/profileMusic-read', `${e.code}: ${e.message}`);
  }

  // profilePlaylists
  try {
    const plq = clientFS.query(clientFS.collection(cDb, 'profilePlaylists'), clientFS.where('ownerUid', '==', TEST_UID));
    const plsnap = await clientFS.getDocs(plq);
    PASS('firestore/profilePlaylists-read', `${plsnap.size} playlists`);
  } catch (e) {
    FAIL('firestore/profilePlaylists-read', `${e.code}: ${e.message}`);
  }

  // messages (new collection)
  const convId = [TEST_UID, FOUNDER_UID].sort().join('_');
  try {
    const convSnap = await clientFS.getDoc(clientFS.doc(cDb, 'messages', convId));
    if (convSnap.exists()) {
      PASS('firestore/messages-conv-read', 'conversation doc accessible to participant');
    } else {
      FAIL('firestore/messages-conv-read', 'conversation doc missing');
    }
  } catch (e) {
    FAIL('firestore/messages-conv-read', `${e.code}: ${e.message}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 5 — REALTIME LISTENERS (onSnapshot — loading loop candidate)
  // ═══════════════════════════════════════════════════════════════════════════
  SECTION('TEST 5 — REALTIME LISTENERS (onSnapshot loading-loop check)');

  // The critical listener that fires on startup is onSnapshot(siteSettings/config).
  // If it never fires, the UI caches no state and _snxReapplyNavVisibility is never called.
  // We test whether it fires within a reasonable window.
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('LOADING LOOP CANDIDATE: siteSettings/config onSnapshot did not fire in 5s'));
      }, 5000);
      const unsub = clientFS.onSnapshot(
        clientFS.doc(cDb, 'siteSettings', 'config'),
        (snap) => {
          unsub();
          clearTimeout(timeout);
          resolve(snap);
        },
        (err) => {
          unsub();
          clearTimeout(timeout);
          reject(err);
        }
      );
    });
    PASS('firestore/siteSettings-onSnapshot-fires', 'listener fires promptly');
  } catch (e) {
    FAIL('firestore/siteSettings-onSnapshot-fires', e.message);
  }

  // pageVisibility listener
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('did not fire in 5s')), 5000);
      const unsub = clientFS.onSnapshot(
        clientFS.doc(cDb, 'siteSettings', 'pageVisibility'),
        (snap) => { unsub(); clearTimeout(timeout); resolve(snap); },
        (err)  => { unsub(); clearTimeout(timeout); reject(err);   }
      );
    });
    PASS('firestore/pageVisibility-onSnapshot-fires', 'listener fires promptly');
  } catch (e) {
    FAIL('firestore/pageVisibility-onSnapshot-fires', e.message);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 6 — SECURITY RULES: UNAUTHENTICATED ACCESS
  // ═══════════════════════════════════════════════════════════════════════════
  SECTION('TEST 6 — SECURITY RULES: unauthenticated access');
  await clientAuth.signOut(cAuth);

  const unauthChecks = [
    { path: ['users', TEST_UID],                      expectDeny: true,  name: 'users/{uid}' },
    { path: ['posts', 'test-post-001'],                expectDeny: true,  name: 'posts/{postId}' },
    { path: ['siteSettings', 'config'],               expectDeny: false, name: 'siteSettings/config (public)' },
    { path: ['liveRooms', TEST_UID],                  expectDeny: true,  name: 'liveRooms/{uid}' },
    { path: ['messages', convId],                     expectDeny: true,  name: 'messages/{convId}' },
    { path: ['profileMusic', 'song-001'],             expectDeny: false, name: 'profileMusic (public doc)' },
  ];

  for (const check of unauthChecks) {
    try {
      await clientFS.getDoc(clientFS.doc(cDb, ...check.path));
      if (check.expectDeny) {
        FAIL(`rules/unauth-${check.name}`, 'Expected PERMISSION_DENIED but read succeeded — rules may be too open');
      } else {
        PASS(`rules/unauth-${check.name}`, 'public read allowed (expected)');
      }
    } catch (e) {
      if (e.code === 'permission-denied') {
        if (check.expectDeny) {
          PASS(`rules/unauth-${check.name}`, 'correctly denied to unauthenticated user');
        } else {
          FAIL(`rules/unauth-${check.name}`, 'denied but should be public');
        }
      } else {
        WARN(`rules/unauth-${check.name}`, `unexpected error: ${e.code}: ${e.message}`);
      }
    }
  }

  // Re-login for remaining tests
  await clientAuth.signInWithEmailAndPassword(cAuth, TEST_EMAIL, TEST_PASS);

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 7 — SECURITY RULES: CROSS-USER ACCESS (should be denied)
  // ═══════════════════════════════════════════════════════════════════════════
  SECTION('TEST 7 — SECURITY RULES: cross-user write protection');

  // Try to write to another user's doc (should be denied by isOwner)
  try {
    await clientFS.updateDoc(clientFS.doc(cDb, 'users', FOUNDER_UID), {
      role: 'hacker'  // attempt to escalate privileges
    });
    FAIL('rules/cross-user-write-blocked', 'CRITICAL: test user was able to update founder\'s doc!');
  } catch (e) {
    if (e.code === 'permission-denied') {
      PASS('rules/cross-user-write-blocked', 'correctly blocked cross-user role update');
    } else {
      WARN('rules/cross-user-write-blocked', `unexpected: ${e.code}: ${e.message}`);
    }
  }

  // Test chat read — participant should be allowed
  try {
    const csnap2 = await clientFS.getDoc(clientFS.doc(cDb, 'chats', chatId));
    PASS('rules/chat-participant-read', 'participant can read their own conversation');
  } catch (e) {
    FAIL('rules/chat-participant-read', `${e.code}: ${e.message}`);
  }

  // Test reading someone else's chat (not a participant)
  const strangerChatId = 'stranger-uid-a_stranger-uid-b';
  try {
    await adminDb.collection('chats').doc(strangerChatId).set({
      participants: ['stranger-uid-a', 'stranger-uid-b'],
      messages:     [],
      lastMsgTs:    Date.now()
    });
    await clientFS.getDoc(clientFS.doc(cDb, 'chats', strangerChatId));
    FAIL('rules/chat-non-participant-blocked', 'RULE FAILURE: test user read a conversation they are not part of');
  } catch (e) {
    if (e.code === 'permission-denied') {
      PASS('rules/chat-non-participant-blocked', 'correctly denied read of conversation user is not part of');
    } else {
      WARN('rules/chat-non-participant-blocked', `unexpected: ${e.code}: ${e.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 8 — RTDB (presence, co-host signaling)
  // ═══════════════════════════════════════════════════════════════════════════
  SECTION('TEST 8 — REALTIME DATABASE (presence, co-host)');
  try {
    const presSnap = await clientRTDB.get(clientRTDB.ref(cRtdb, `users/${TEST_UID}`));
    if (presSnap.exists()) {
      PASS('rtdb/presence-read', `online=${presSnap.val().online}`);
    } else {
      FAIL('rtdb/presence-read', 'presence node missing');
    }
  } catch (e) {
    FAIL('rtdb/presence-read', `${e.code || e.message}`);
  }

  try {
    await clientRTDB.set(clientRTDB.ref(cRtdb, `users/${TEST_UID}`), {
      online: true, live: false, lastSeen: Date.now()
    });
    PASS('rtdb/presence-write', 'user can write own presence');
  } catch (e) {
    FAIL('rtdb/presence-write', `${e.code || e.message}`);
  }

  // RTDB liveRooms
  try {
    const lrSnap = await clientRTDB.get(clientRTDB.ref(cRtdb, 'liveRooms'));
    PASS('rtdb/liveRooms-read', `exists=${lrSnap.exists()}`);
  } catch (e) {
    FAIL('rtdb/liveRooms-read', `${e.code || e.message}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 9 — LOGOUT
  // ═══════════════════════════════════════════════════════════════════════════
  SECTION('TEST 9 — LOGOUT');
  try {
    let logoutAuthResolved = false;
    const logoutPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('onAuthStateChanged did not fire after logout within 5s')), 5000);
      const unsub = clientAuth.onAuthStateChanged(cAuth, (user) => {
        if (!user) {
          unsub(); clearTimeout(timeout);
          logoutAuthResolved = true;
          resolve();
        }
      });
    });
    await clientAuth.signOut(cAuth);
    await logoutPromise;
    PASS('auth/logout', 'signOut succeeded and onAuthStateChanged fired with null user');
  } catch (e) {
    FAIL('auth/logout', e.message);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 10 — FOUNDER LOGIN + BYPASS CHECKS
  // ═══════════════════════════════════════════════════════════════════════════
  SECTION('TEST 10 — FOUNDER LOGIN');
  let founderLoggedIn = false;
  try {
    const fc = await clientAuth.signInWithEmailAndPassword(cAuth, FOUNDER_EMAIL, FOUNDER_PASS);
    PASS('auth/founder-login', `UID=${fc.user.uid}`);
    founderLoggedIn = true;
  } catch (e) {
    FAIL('auth/founder-login', e.message);
  }

  if (founderLoggedIn) {
    // Founder should be able to read their own users doc
    try {
      const fsnap = await clientFS.getDoc(clientFS.doc(cDb, 'users', FOUNDER_UID));
      if (fsnap.exists() && fsnap.data().role === 'founder') {
        PASS('firestore/founder-role-confirmed', `role=${fsnap.data().role}`);
      } else {
        WARN('firestore/founder-role-confirmed', 'founder doc exists but role field unexpected');
      }
    } catch (e) {
      FAIL('firestore/founder-role-confirmed', `${e.code}: ${e.message}`);
    }
  }

  await clientAuth.signOut(cAuth);

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 11 — LOADING LOOP ROOT CAUSE ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════════
  SECTION('TEST 11 — LOADING LOOP ROOT CAUSE ANALYSIS');

  // The #snx-auth-gate spinner is removed when onAuthStateChanged fires AND either:
  //   (a) user != null → navTo('feed') path
  //   (b) user == null → show('login') path
  //
  // If the gate is NEVER removed, one of these must be true:
  //   1. onAuthStateChanged never fires (Firebase Auth unreachable / hung)
  //   2. The app crashes before reaching the gate.classList.add('resolved') call
  //   3. The maintenance check redirects loop back to the same page
  //   4. The siteSettings onSnapshot throws and the error propagates
  //
  // We already verified (1) with TEST 2. Now check structural causes.

  INFO('Checking: does siteSettings/config onSnapshot fire without auth?');
  try {
    // Sign out first — this is the unauthenticated pre-auth window
    await clientAuth.signOut(cAuth).catch(() => {});

    const sSstart = Date.now();
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('siteSettings onSnapshot hung > 5s while unauthenticated')), 5000);
      const u = clientFS.onSnapshot(
        clientFS.doc(cDb, 'siteSettings', 'config'),
        (snap) => { u(); clearTimeout(t); resolve(snap); },
        (err)  => { u(); clearTimeout(t); reject(err);   }
      );
    });
    const elapsed = Date.now() - sSstart;
    PASS('loop/siteSettings-pre-auth-fires', `fires in ${elapsed}ms without user (rule: if true → OK)`);
  } catch (e) {
    if (e.code === 'permission-denied') {
      FAIL('loop/siteSettings-pre-auth-fires',
        'LOADING LOOP CAUSE IDENTIFIED: siteSettings/config onSnapshot is called before auth ' +
        'resolves but PERMISSION DENIED for unauthenticated — causes infinite retry loop');
    } else {
      WARN('loop/siteSettings-pre-auth-fires', e.message);
    }
  }

  INFO('Checking: does pageVisibility onSnapshot fire without auth?');
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('pageVisibility onSnapshot hung > 5s')), 5000);
      const u = clientFS.onSnapshot(
        clientFS.doc(cDb, 'siteSettings', 'pageVisibility'),
        (snap) => { u(); clearTimeout(t); resolve(snap); },
        (err)  => { u(); clearTimeout(t); reject(err);   }
      );
    });
    PASS('loop/pageVisibility-pre-auth-fires', 'fires without user');
  } catch (e) {
    if (e.code === 'permission-denied') {
      FAIL('loop/pageVisibility-pre-auth-fires', 'PERMISSION DENIED pre-auth — potential loop cause');
    } else {
      WARN('loop/pageVisibility-pre-auth-fires', e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  const DIVIDER = '═'.repeat(64);
  console.log(`\n${DIVIDER}`);
  console.log('  SHADOW NEXUS SOCIAL — EMULATOR TEST RESULTS');
  console.log(DIVIDER);
  console.log(`  ✅  PASSED:   ${passed}`);
  console.log(`  ❌  FAILED:   ${failed}`);
  console.log(`  ⚠️   WARNINGS: ${warnings}`);
  console.log(DIVIDER);

  // Print grouped results
  const sections = {
    'AUTH'       : ['auth/emulator-reachable', 'auth/login-test-user', 'auth/onAuthStateChanged-resolves', 'auth/onAuthStateChanged-speed', 'auth/logout', 'auth/founder-login'],
    'FIRESTORE'  : Object.keys(results).filter(k => k.startsWith('firestore/')),
    'RTDB'       : Object.keys(results).filter(k => k.startsWith('rtdb/')),
    'RULES'      : Object.keys(results).filter(k => k.startsWith('rules/')),
    'LOOP CHECKS': Object.keys(results).filter(k => k.startsWith('loop/')),
  };

  for (const [sec, keys] of Object.entries(sections)) {
    const relevant = keys.filter(k => results[k]);
    if (!relevant.length) continue;
    console.log(`\n  [${sec}]`);
    for (const k of relevant) {
      const r = results[k];
      const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⚠️ ';
      console.log(`    ${icon} ${k}: ${r.detail || ''}`);
    }
  }

  console.log(`\n${DIVIDER}`);
  console.log('  PRODUCTION FIREBASE STATUS:');
  console.log('    Firebase production changed:       NO');
  console.log('    Firebase production data changed:  NO');
  console.log('    Firebase production rules changed: NO');
  console.log('    Production deployment performed:   NO');
  console.log(DIVIDER + '\n');

  // Determine overall diagnosis
  const loopFails  = Object.entries(results).filter(([k, v]) => k.startsWith('loop/') && v.status === 'FAIL');
  const authFails  = Object.entries(results).filter(([k, v]) => k.startsWith('auth/') && v.status === 'FAIL');
  const ruleFails  = Object.entries(results).filter(([k, v]) => k.startsWith('rules/') && v.status === 'FAIL');
  const fsFails    = Object.entries(results).filter(([k, v]) => k.startsWith('firestore/') && v.status === 'FAIL');

  console.log('  ROOT CAUSE ANALYSIS:');
  if (loopFails.length > 0) {
    console.log('  ❌ LOADING LOOP EVIDENCE: ' + loopFails.map(([k]) => k).join(', '));
    console.log('     → Likely cause: application code fires Firestore listeners before auth resolves');
    console.log('       and the Firestore security rules deny unauthenticated access to required docs.');
    console.log('     → Category: C (Firebase configuration/environment mismatch) +');
    console.log('                 E (Firestore rules/indexes) + B (application code order)');
  } else if (authFails.length > 0) {
    console.log('  ❌ AUTH FAILURE EVIDENCE: ' + authFails.map(([k]) => k).join(', '));
    console.log('     → Category: D (Authentication)');
  } else if (fsFails.length > 0) {
    console.log('  ❌ FIRESTORE FAILURE EVIDENCE: ' + fsFails.map(([k]) => k).join(', '));
    console.log('     → Category: E (Firestore rules/indexes)');
  } else if (failed === 0) {
    console.log('  ✅ All tests pass against the emulator.');
    console.log('     → If the backup STILL loops in a browser against production, the root cause');
    console.log('       is A: production Firebase environment (different rules, missing docs,');
    console.log('       network differences, or a production-only auth/quota state).');
    console.log('     → Category: A (Production Firebase)');
  }

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('\n  FATAL TEST ERROR:', err);
  process.exit(2);
});
