/**
 * firebase-config.js
 * Shadow Nexus — shared Firebase configuration.
 *
 * Import this module from any page that needs Firebase instead of
 * re-defining the config inline.  live.js keeps its own inline config
 * for backward compatibility; this file is the canonical reference for
 * new pages (e.g. live-hub.html).
 *
 * Usage (ES module):
 *   import { app, auth, db, liveDB } from './firebase-config.js';
 */

import { initializeApp, getApps, getApp }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getDatabase }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

/* ── Firebase project credentials ── */
const _CONFIG = {
  apiKey:            'AIzaSyB2M8sgU__2s0oVa5y4-s1S294aP5CBdeQ',
  authDomain:        'remix-studio-4bf8a.firebaseapp.com',
  databaseURL:       'https://remix-studio-4bf8a-default-rtdb.firebaseio.com',
  projectId:         'remix-studio-4bf8a',
  storageBucket:     'remix-studio-4bf8a.firebasestorage.app',
  messagingSenderId: '220851113113',
  appId:             '1:220851113113:web:bb3cd4e44f478d3925fc08',
  measurementId:     'G-GM0JCC3BGW',
};

/*
 * Reuse the existing app instance if one has already been initialised
 * (e.g. index.html and live-hub.html loaded in the same session).
 */
const app    = getApps().length ? getApp() : initializeApp(_CONFIG);
const auth   = getAuth(app);
const db     = getFirestore(app);
const liveDB = getDatabase(app);

export { app, auth, db, liveDB, _CONFIG };
