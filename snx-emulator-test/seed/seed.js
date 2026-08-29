/**
 * snx-emulator-test/seed/seed.js
 *
 * Seeds the Firebase Emulator with minimal data required to test Shadow Nexus Social:
 *   - Auth users (test user + founder)
 *   - Firestore: users, siteSettings/config, siteSettings/pageVisibility,
 *                posts, messages (chats), liveRooms, profileMusic, profilePlaylists
 *   - Realtime Database: users/{uid} presence
 *
 * NEVER connects to production. All writes go to 127.0.0.1 emulator ports.
 */

'use strict';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIREBASE_DATABASE_EMULATOR_HOST = '127.0.0.1:9000';

const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth }             = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getDatabase }         = require('firebase-admin/database');

// Use a fake credential — admin SDK with emulators ignores it
const app = initializeApp({
  projectId:   'snx-emulator-test',
  databaseURL: 'http://127.0.0.1:9000/?ns=snx-emulator-test'
}, 'seed');

const adminAuth = getAuth(app);
const adminDb   = getFirestore(app);
const rtdb      = getDatabase(app);

async function seed() {
  console.log('=== SNX EMULATOR SEED ===');
  console.log('Target: 127.0.0.1 emulators ONLY. Production: NOT touched.\n');

  // ── 1. Create Auth users ──────────────────────────────────────────────────
  let testUid, founderUid;

  try {
    const tu = await adminAuth.createUser({
      uid:           'test-user-001',
      email:         'testuser@snx.local',
      password:      'Test1234!',
      displayName:   'Test User'
    });
    testUid = tu.uid;
    console.log('[AUTH] Created test user:', testUid);
  } catch (e) {
    if (e.code === 'auth/uid-already-exists') {
      testUid = 'test-user-001';
      console.log('[AUTH] Test user already exists');
    } else throw e;
  }

  try {
    const fu = await adminAuth.createUser({
      uid:           'founder-001',
      email:         'christijerina46@gmail.com',
      password:      'Founder1234!',
      displayName:   'Founder'
    });
    founderUid = fu.uid;
    console.log('[AUTH] Created founder:', founderUid);
  } catch (e) {
    if (e.code === 'auth/uid-already-exists') {
      founderUid = 'founder-001';
      console.log('[AUTH] Founder already exists');
    } else throw e;
  }

  // ── 2. Firestore: users ───────────────────────────────────────────────────
  await adminDb.collection('users').doc(testUid).set({
    uid:          testUid,
    email:        'testuser@snx.local',
    username:     'testuser',
    displayName:  'Test User',
    role:         'member',
    status:       'online',
    lastSeen:     Date.now(),
    badges:       [],
    followers:    [],
    following:    [],
    friends:      [],
    createdAt:    FieldValue.serverTimestamp()
  }, { merge: true });
  console.log('[FIRESTORE] users/' + testUid + ' seeded');

  await adminDb.collection('users').doc(founderUid).set({
    uid:          founderUid,
    email:        'christijerina46@gmail.com',
    username:     'founder',
    displayName:  'Founder',
    role:         'founder',
    status:       'online',
    lastSeen:     Date.now(),
    badges:       ['Founder'],
    followers:    [],
    following:    [],
    friends:      [],
    createdAt:    FieldValue.serverTimestamp()
  }, { merge: true });
  console.log('[FIRESTORE] users/' + founderUid + ' seeded');

  // ── 3. Firestore: siteSettings/config ─────────────────────────────────────
  await adminDb.collection('siteSettings').doc('config').set({
    maintenanceMode:      false,
    registrationEnabled:  true,
    postsEnabled:         true,
    stormRoomsEnabled:    true,
    arcadeEnabled:        true,
    aiModerationEnabled:  true,
    shadowBotEnabled:     false,
    messagesTabEnabled:   true,
    welcomePopupEnabled:  true,
    coHostEnabled:        true
  }, { merge: true });
  console.log('[FIRESTORE] siteSettings/config seeded (maintenanceMode=false)');

  // ── 4. Firestore: siteSettings/pageVisibility ─────────────────────────────
  await adminDb.collection('siteSettings').doc('pageVisibility').set({
    disabledPages: []
  }, { merge: true });
  console.log('[FIRESTORE] siteSettings/pageVisibility seeded');

  // ── 5. Firestore: posts ───────────────────────────────────────────────────
  const postsRef = adminDb.collection('posts');
  await postsRef.doc('test-post-001').set({
    uid:         testUid,
    authorUid:   testUid,
    authorName:  'Test User',
    text:        'Hello from the emulator test! 🌑',
    likes:       0,
    likedBy:     [],
    comments:    [],
    createdAt:   FieldValue.serverTimestamp()
  });
  console.log('[FIRESTORE] posts/test-post-001 seeded');

  // ── 6. Firestore: chats (DM) ──────────────────────────────────────────────
  const chatId = [testUid, founderUid].sort().join('_');
  await adminDb.collection('chats').doc(chatId).set({
    participants: [testUid, founderUid],
    messages:     [{
      sender:    testUid,
      type:      'text',
      text:      'Test message from emulator',
      timestamp: Date.now()
    }],
    lastMsgTs: Date.now()
  });
  console.log('[FIRESTORE] chats/' + chatId + ' seeded');

  // ── 7. Firestore: messages (new top-level) ────────────────────────────────
  const convId = [testUid, founderUid].sort().join('_');
  await adminDb.collection('messages').doc(convId).set({
    participants: [testUid, founderUid],
    senderID:     testUid,
    receiverID:   founderUid,
    lastMsgTs:    Date.now()
  });
  await adminDb.collection('messages').doc(convId)
    .collection('msgs').doc('msg-001').set({
      senderID:   testUid,
      receiverID: founderUid,
      text:       'Emulator test message',
      timestamp:  Date.now(),
      read:       false,
      deleted:    false
    });
  console.log('[FIRESTORE] messages/' + convId + '/msgs seeded');

  // ── 8. Firestore: liveRooms ───────────────────────────────────────────────
  await adminDb.collection('liveRooms').doc(testUid).set({
    hostId:      testUid,
    hostName:    'Test User',
    isLive:      false,
    status:      'ended',
    viewers:     0,
    likes:       0,
    title:       'Emulator Test Room',
    createdAt:   FieldValue.serverTimestamp(),
    updatedAt:   FieldValue.serverTimestamp()
  });
  console.log('[FIRESTORE] liveRooms/' + testUid + ' seeded (isLive=false)');

  // ── 9. Firestore: profileMusic ────────────────────────────────────────────
  await adminDb.collection('profileMusic').doc('song-001').set({
    ownerUid:    testUid,
    ownerId:     testUid,
    title:       'Test Track',
    artist:      'SNX Emulator',
    visibility:  'public',
    isPublic:    true,
    uploadedAt:  FieldValue.serverTimestamp()
  });
  console.log('[FIRESTORE] profileMusic/song-001 seeded');

  // ── 10. Firestore: profilePlaylists ──────────────────────────────────────
  await adminDb.collection('profilePlaylists').doc('pl-001').set({
    ownerUid:  testUid,
    name:      'Test Playlist',
    songIds:   ['song-001'],
    createdAt: FieldValue.serverTimestamp()
  });
  console.log('[FIRESTORE] profilePlaylists/pl-001 seeded');

  // ── 11. Realtime Database: presence ──────────────────────────────────────
  await rtdb.ref('users/' + testUid).set({
    online:   true,
    live:     false,
    lastSeen: Date.now()
  });
  await rtdb.ref('users/' + founderUid).set({
    online:   true,
    live:     false,
    lastSeen: Date.now()
  });
  console.log('[RTDB] presence seeded for both users');

  // ── 12. Wallets ──────────────────────────────────────────────────────────
  await adminDb.collection('wallets').doc(testUid).set({
    uid:         testUid,
    shadowCoins: 100
  });
  console.log('[FIRESTORE] wallets/' + testUid + ' seeded');

  console.log('\n=== SEED COMPLETE ===');
  console.log('Test user:    testuser@snx.local  / Test1234!');
  console.log('Founder user: christijerina46@gmail.com / Founder1234!');
  console.log('UID test:    ', testUid);
  console.log('UID founder: ', founderUid);
}

seed().catch(err => {
  console.error('SEED FAILED:', err);
  process.exit(1);
});
