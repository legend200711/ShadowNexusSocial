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
  apiKey:            'AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y',
  authDomain:        'horr-a08f4.firebaseapp.com',
  databaseURL:       'https://horr-a08f4-default-rtdb.firebaseio.com',
  projectId:         'horr-a08f4',
  storageBucket:     'horr-a08f4.firebasestorage.app',
  messagingSenderId: '933810617818',
  appId:             '1:933810617818:web:efb24f123337dd987c14e3',
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
