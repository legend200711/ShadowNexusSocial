/**
 * Shadow Nexus Social — Cloud Radio
 * cloud-stream.js
 *
 * Handles:
 *   - Creator dashboard: start / manage / stop a 24-hour cloud broadcast
 *   - Listener player: real-time synchronized playback from the cloud worker
 *   - Real-time Now Playing sync via Firestore studioCloudStreamMusic
 *   - Duplicate stream prevention
 *   - Test mode (5-minute broadcasts, founder-only)
 *
 * Architecture:
 *   Creator configures → Cloudflare Worker (snx-cloudstream) starts
 *   Worker Durable Object alarms advance tracks every N seconds
 *   Worker writes Now Playing → studioCloudStreamMusic/{streamId}
 *   Listeners subscribe to that Firestore doc and seek to synchronized position
 *   Audio files served directly from Cloudflare R2 CDN
 *
 * Collections used (no new collections):
 *   cloudStreams/{streamId}         — broadcast record
 *   studioCloudStreamMusic/{streamId} — live Now Playing (worker-owned)
 *   studioPlaylists/{uid}/playlists/{plId} — creator's playlists
 *   cloudStreamTracks/{uid}/tracks/{trackId} — creator's track library
 *   liveRooms/{uid}                 — feed entry (live discovery)
 */

'use strict';

import { initializeApp, getApps, getApp }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, browserLocalPersistence, setPersistence
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore,
  doc, getDoc, getDocs, setDoc, updateDoc, addDoc,
  collection, query, orderBy, limit, where, onSnapshot,
  serverTimestamp, documentId
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

/* ── Firebase config (matches firebase-config.js) ─────────────────── */
const _CFG = {
  apiKey:            'AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y',
  authDomain:        'horr-a08f4.firebaseapp.com',
  databaseURL:       'https://horr-a08f4-default-rtdb.firebaseio.com',
  projectId:         'horr-a08f4',
  storageBucket:     'horr-a08f4.firebasestorage.app',
  messagingSenderId: '933810617818',
  appId:             '1:933810617818:web:efb24f123337dd987c14e3',
};

const _app  = getApps().length ? getApp() : initializeApp(_CFG);
const _auth = getAuth(_app);
const _db   = getFirestore(_app);

setPersistence(_auth, browserLocalPersistence).catch(() => {});

/* ── Worker URL ──────────────────────────────────────────────────────── */
const WORKER_URL = 'https://snx-cloudstream.nthntjrn.workers.dev';

/* ═══════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════ */
let _user         = null;
let _userData     = null;
let _streamId     = null;   // active stream ID (creator's own)
let _streamData   = null;   // cloudStreams Firestore doc data
let _artworkDataUrl = null; // base64 cover artwork

/* Listener player state */
let _player = {
  audio:       null,      // HTMLAudioElement
  playing:     false,
  trackId:     null,
  trackUrl:    null,
  trackDur:    0,
  trackStartedAt: 0,      // server timestamp when track started
  volume:      0.8,
  progressRaf: null,
  unsub:       null,      // Firestore Now Playing snapshot unsubscribe
  syncInterval: null,
  listenerCount: 0,
  broadcastTitle: '',
  hostName:    '',
};

/* Creator state */
let _creator = {
  playlists:    [],
  selectedPl:   null,
  queue:        [],
  activeUnsub:  null,
  healthInterval: null,
  expiryInterval: null,
};

/* Confirmation dialog callback */
let _confirmCallback = null;

/* ═══════════════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════════════ */
onAuthStateChanged(_auth, async user => {
  _show('csrLoading', false);

  if (!user) {
    _show('csrAuthGate', true);
    _show('csrApp', false);
    _setAuthBadge('Sign In');
    return;
  }

  _user = user;
  try {
    const snap = await getDoc(doc(_db, 'users', user.uid));
    if (snap.exists()) _userData = snap.data();
  } catch(_) {}

  _setAuthBadge(_userData ? (_userData.displayName || _userData.username || 'You') : 'You');

  // Check URL params — are we in listener mode?
  const params = new URLSearchParams(window.location.search);
  const watchId = params.get('id') || params.get('watch') || params.get('stream');

  if (watchId) {
    // Listener mode: open a specific broadcast
    _show('csrApp', true);
    _show('csrListenerPanel', true);
    await _initListenerMode(watchId);
  } else {
    // Creator mode: check for own active stream
    _show('csrApp', true);
    await _initCreatorMode();
  }
});

/* ═══════════════════════════════════════════════════════
   CREATOR MODE
═══════════════════════════════════════════════════════ */
async function _initCreatorMode() {
  // Check for an already-active stream belonging to this user
  try {
    const snap = await getDocs(query(
      collection(_db, 'cloudStreams'),
      where('uid', '==', _user.uid),
      where('status', 'in', ['active', 'starting', 'recovering']),
      limit(1)
    ));
    if (snap.docs.length) {
      const d = snap.docs[0];
      _streamId   = d.id;
      _streamData = d.data();
      _showActiveStream();
    } else {
      _showCreateForm();
    }
  } catch (e) {
    console.error('[CSR] initCreatorMode error:', e);
    _showCreateForm();
  }

  // Load playlists for the create form (background)
  _loadPlaylists();

  // Load broadcast history
  _loadHistory();
}

function _showActiveStream() {
  _show('csrStatusPanel', true);
  _show('csrActiveBanner', true);
  _show('csrCreatePanel', false);
  _renderStatusPanel();
  _startHealthMonitor();
  _startExpiryCountdown();
  _subscribeNowPlaying(_streamId);

  // Also show listener player below so creator can monitor the broadcast
  _show('csrListenerPanel', true);
  _initListenerForStream(_streamId, _streamData);
}

function _showCreateForm() {
  _show('csrStatusPanel', false);
  _show('csrActiveBanner', false);
  _show('csrCreatePanel', true);
  _renderCreateForm();
  _show('csrHistoryPanel', true);
}

/* ═══════════════════════════════════════════════════════
   STATUS PANEL RENDER
═══════════════════════════════════════════════════════ */
function _renderStatusPanel() {
  if (!_streamData) return;
  const d = _streamData;

  _setStatusBadge(d.status || 'unknown');

  _el('csrStreamId').textContent   = 'ID: ' + (_streamId || '—');
  _el('csrInfoTitle').textContent  = d.streamName     || '—';
  _el('csrInfoHost').textContent   = d.displayName    || (_userData && (_userData.displayName || _userData.username)) || '—';
  _el('csrInfoCategory').textContent = d.category     || '—';
  _el('csrInfoStarted').textContent  = d.startedAt ? _fmtTime(d.startedAt.toMillis ? d.startedAt.toMillis() : d.startedAt) : '—';
  _el('csrInfoExpires').textContent  = d.expiresAt ? new Date(d.expiresAt).toLocaleString() : '—';
  _el('csrInfoListeners').textContent = d.viewerCount || '0';
  _el('csrInfoWorker').textContent   = d.workerStatus || 'active';
}

function _setStatusBadge(status) {
  const el = _el('csrStatusBadge');
  if (!el) return;
  const map = {
    active:    ['csr-status-live',    '&#128308; LIVE'],
    starting:  ['csr-status-starting','&#9203; STARTING'],
    recovering:['csr-status-warn',    '&#9888; RECOVERING'],
    stopping:  ['csr-status-warn',    '&#9209; STOPPING'],
    stopped:   ['csr-status-offline', '&#9209; ENDED'],
    ended:     ['csr-status-offline', '&#9209; ENDED'],
    failed:    ['csr-status-error',   '&#10060; ERROR'],
    offline:   ['csr-status-offline', '&#9898; OFFLINE'],
    unknown:   ['csr-status-offline', '&#9898; OFFLINE'],
  };
  const [cls, label] = map[status] || map.unknown;
  el.className = 'csr-status-badge ' + cls;
  el.innerHTML = label;
}

/* ═══════════════════════════════════════════════════════
   HEALTH MONITOR (creator)
═══════════════════════════════════════════════════════ */
function _startHealthMonitor() {
  _stopHealthMonitor();
  _creator.healthInterval = setInterval(_checkHealth, 30000);
  _checkHealth(); // immediate
}
function _stopHealthMonitor() {
  if (_creator.healthInterval) { clearInterval(_creator.healthInterval); _creator.healthInterval = null; }
}

async function _checkHealth() {
  if (!_streamId) return;
  try {
    const r    = await fetch(WORKER_URL + '/api/stream/health/' + _streamId);
    const data = await r.json();
    if (data.success) {
      if (_streamData) {
        _streamData.status     = data.status;
        _streamData.viewerCount = data.viewerCount || 0;
      }
      _setStatusBadge(data.status);
      _el('csrInfoWorker').textContent = data.workerActive ? 'active' : 'offline';
      _el('csrInfoListeners').textContent = data.viewerCount || '0';
      // Sync now playing from health response
      if (data.currentMusicTitle) {
        _el('csrNpTitle').textContent  = data.currentMusicTitle;
        _el('csrNpArtist').textContent = data.currentMusicArtist || '';
        _el('csrNpNext').textContent   = data.nextMusicTitle ? 'Next: ' + data.nextMusicTitle : '';
      }
    }
    // Check expiry
    if (_streamData && _streamData.expiresAt) {
      const remain = _streamData.expiresAt - Date.now();
      if (remain <= 0) {
        _streamExpired();
      }
    }
  } catch(_) {
    // Worker temporarily unreachable — non-fatal
  }
}

/* ═══════════════════════════════════════════════════════
   EXPIRY COUNTDOWN
═══════════════════════════════════════════════════════ */
function _startExpiryCountdown() {
  if (_creator.expiryInterval) clearInterval(_creator.expiryInterval);
  _creator.expiryInterval = setInterval(_tickExpiry, 1000);
  _tickExpiry();
}
function _tickExpiry() {
  if (!_streamData || !_streamData.expiresAt) return;
  const remain = _streamData.expiresAt - Date.now();
  const el = _el('csrInfoRemaining');
  if (remain <= 0) {
    if (el) el.textContent = 'EXPIRED';
    _streamExpired();
    return;
  }
  if (el) el.textContent = _fmtDuration(Math.floor(remain / 1000));
}
function _streamExpired() {
  if (_creator.expiryInterval) { clearInterval(_creator.expiryInterval); _creator.expiryInterval = null; }
  _setStatusBadge('ended');
  _toast('Your 24-hour cloud broadcast has ended.', 'info');
}

/* ═══════════════════════════════════════════════════════
   NOW PLAYING SYNC (Firestore real-time)
═══════════════════════════════════════════════════════ */
function _subscribeNowPlaying(streamId) {
  if (_player.unsub) { try { _player.unsub(); } catch(_) {} }
  _player.unsub = onSnapshot(
    doc(_db, 'studioCloudStreamMusic', streamId),
    snap => {
      if (!snap.exists()) return;
      const d = snap.data();
      // Update creator status panel
      _el('csrNpTitle').textContent  = d.currentTitle  || '—';
      _el('csrNpArtist').textContent = d.currentArtist || '';
      _el('csrNpNext').textContent   = d.nextTitle ? 'Next: ' + d.nextTitle : '';
      // Update listener player if same track is playing
      _syncListenerToNowPlaying(d);
    },
    err => console.warn('[CSR] NowPlaying snapshot error:', err.message)
  );
}

/* ═══════════════════════════════════════════════════════
   CREATE BROADCAST FORM
═══════════════════════════════════════════════════════ */
function _renderCreateForm() {
  // Reveal test mode option only for founders
  const isFounder = _userData && _userData.role === 'founder';
  const dur = _el('csrFormDuration');
  if (dur) {
    // Show 5-min test option only to founders
    const testOpt = dur.querySelector('option[value="5"]');
    if (testOpt) testOpt.style.display = isFounder ? '' : 'none';
  }
  const hint = _el('csrTestModeHint');
  if (hint && dur) {
    dur.addEventListener('change', () => {
      hint.style.display = (dur.value === '5' && isFounder) ? '' : 'none';
    });
  }
}

async function _loadPlaylists() {
  const el = _el('csrPlaylistSelector');
  if (!el) return;
  try {
    const snap = await getDocs(query(
      collection(_db, 'studioPlaylists', _user.uid, 'playlists'),
      orderBy('createdAt', 'desc'),
      limit(50)
    ));
    _creator.playlists = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _renderPlaylistSelector();
  } catch (e) {
    el.innerHTML = '<div class="csr-hint">Could not load playlists. Try uploading music in 24-Hour Studio first.</div>';
  }
}

function _renderPlaylistSelector() {
  const el = _el('csrPlaylistSelector');
  if (!el) return;
  if (!_creator.playlists.length) {
    el.innerHTML = '<div class="csr-hint">No playlists found. <a class="csr-link" href="/?snxPage=studioPage">Go to 24-Hour Studio</a> to create a playlist and upload tracks.</div>';
    return;
  }
  el.innerHTML = _creator.playlists.map(pl => {
    const sel = _creator.selectedPl && _creator.selectedPl.id === pl.id;
    return `<button class="csr-pl-btn${sel ? ' selected' : ''}" onclick="csrSelectPlaylist('${_esc(pl.id)}')">
      <span class="csr-pl-name">${_esc(pl.name)}</span>
      <span class="csr-pl-count">${(pl.trackIds || []).length} tracks</span>
    </button>`;
  }).join('');
}

window.csrSelectPlaylist = async function(plId) {
  const pl = _creator.playlists.find(p => p.id === plId);
  if (!pl) return;
  _creator.selectedPl = pl;
  _renderPlaylistSelector();
  // Load track objects
  _creator.queue = [];
  const el = _el('csrQueuePreview');
  if (el) { el.style.display = ''; el.innerHTML = '<div class="csr-hint">Loading tracks…</div>'; }
  try {
    const ids = pl.trackIds || [];
    if (!ids.length) {
      if (el) el.innerHTML = '<div class="csr-hint">This playlist has no tracks yet.</div>';
      return;
    }
    // Batch-fetch in chunks of 30 (Firestore 'in' query limit)
    const chunks = [];
    for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
    const results = [];
    for (const chunk of chunks) {
      const snap = await getDocs(query(
        collection(_db, 'cloudStreamTracks', _user.uid, 'tracks'),
        where(documentId(), 'in', chunk)
      ));
      snap.docs.forEach(d => results.push({ id: d.id, ...d.data() }));
    }
    // Order by original trackIds order
    _creator.queue = ids.map(id => results.find(r => r.id === id)).filter(Boolean);
    _renderQueuePreview();
  } catch (e) {
    if (el) el.innerHTML = '<div class="csr-hint">Could not load tracks: ' + _esc(e.message) + '</div>';
  }
};

function _renderQueuePreview() {
  const el = _el('csrQueuePreview');
  if (!el) return;
  const q = _creator.queue;
  if (!q.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  const totalSecs = q.reduce((a, t) => a + (t.duration || 0), 0);
  el.innerHTML =
    `<div class="csr-queue-header">${q.length} tracks · ${_fmtDuration(totalSecs)} total</div>` +
    `<div class="csr-queue-list">` +
    q.slice(0, 10).map((t, i) =>
      `<div class="csr-queue-item">
        <span class="csr-queue-num">${i + 1}</span>
        <div class="csr-queue-info">
          <div class="csr-queue-title">${_esc(t.title || 'Untitled')}</div>
          <div class="csr-queue-artist">${_esc(t.artist || '')}</div>
        </div>
        <span class="csr-queue-dur">${_fmtDuration(t.duration || 0)}</span>
      </div>`
    ).join('') +
    (q.length > 10 ? `<div class="csr-queue-more">+ ${q.length - 10} more tracks</div>` : '') +
    `</div>`;
}

/* ═══════════════════════════════════════════════════════
   START BROADCAST
═══════════════════════════════════════════════════════ */
window.csrStartBroadcast = async function() {
  const btn = _el('csrStartBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Starting…'; }

  try {
    // 1. Auth check
    if (!_user) throw new Error('Authentication required. Please sign in.');

    // 2. Validate playlist
    if (!_creator.selectedPl) throw new Error('No audio tracks selected. Please select a playlist first.');
    // Accept any track that has a playable URL regardless of status field —
    // different upload paths (Studio upload vs profile music) may not set status:'ready'.
    const validTracks = _creator.queue.filter(t => t.url || t.downloadURL || t.musicUrl);
    if (!validTracks.length) throw new Error('No playable audio tracks found in the selected playlist. Make sure uploaded tracks have a valid audio URL.');

    // 3. Duration limit
    const durEl = _el('csrFormDuration');
    let durationMinutes = parseInt(durEl ? durEl.value : '1440', 10);
    const maxDuration = 1440; // 24 hours — backend enforces this too
    const isFounder = _userData && _userData.role === 'founder';
    if (durationMinutes === 5 && !isFounder) {
      throw new Error('Test mode is only available to founders.');
    }
    if (durationMinutes > maxDuration) {
      durationMinutes = maxDuration;
    }

    // 4. Duplicate stream check
    const dupSnap = await getDocs(query(
      collection(_db, 'cloudStreams'),
      where('uid', '==', _user.uid),
      where('status', 'in', ['active', 'starting', 'recovering']),
      limit(1)
    ));
    if (dupSnap.docs.length) {
      _show('csrDuplicateWarn', true);
      _streamId   = dupSnap.docs[0].id;
      _streamData = dupSnap.docs[0].data();
      throw new Error('Broadcast already active — opening your existing broadcast.');
    }

    // 5. Build stream ID and config
    const streamId = _user.uid + '_' + Date.now();
    _streamId = streamId;
    const title   = (_el('csrFormTitle')    || {}).value?.trim() || 'CloudStream by ' + (_userData?.displayName || _user.uid);
    const desc    = (_el('csrFormDesc')     || {}).value?.trim() || '';
    const cat     = (_el('csrFormCategory') || {}).value || 'Music';
    const shuffle = (_el('csrFormShuffle')  || {}).checked || false;
    const repeat  = (_el('csrFormRepeat')   || {}).checked !== false;

    _show('csrStartingProgress', true);
    _show('csrValidationError', false);
    _renderHandoffStep(0, 'Preparing broadcast…');

    // 6. Create Firestore record
    await setDoc(doc(_db, 'cloudStreams', streamId), {
      uid:            _user.uid,
      displayName:    _userData?.displayName || _userData?.username || '',
      streamName:     title,
      description:    desc,
      category:       cat,
      theme:          'shadow-nexus',
      durationMinutes,
      status:         'starting',
      viewerCount:    0,
      coverArt:       _artworkDataUrl || '',
      createdAt:      serverTimestamp(),
      startedAt:      null,
      expiresAt:      null,
      workerStatus:   'pending',
      lastHeartbeat:  null,
      musicPlaylistId: _creator.selectedPl.id
    });
    _streamData = { uid: _user.uid, streamName: title, status: 'starting', durationMinutes };
    _renderHandoffStep(1, 'Saving broadcast configuration…');
    await _sleep(400);

    // 7. Start cloud worker
    _renderHandoffStep(2, 'Starting cloud broadcast worker…');
    const musicQueue = validTracks.map(t => ({
      id:       t.id,
      title:    t.title    || t.name   || 'Untitled',
      artist:   t.artist   || t.artist_name || '',
      url:      t.url      || t.downloadURL || t.musicUrl || '',
      duration: t.duration || t.durationSecs || 0
    }));

    const idToken = await _user.getIdToken();
    const startRes = await fetch(WORKER_URL + '/api/stream/start', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
      body:    JSON.stringify({
        streamId, uid: _user.uid,
        displayName:    _userData?.displayName || '',
        streamName:     title,
        theme:          'shadow-nexus',
        scenePlaylist:  [],
        durationMinutes,
        musicQueue,
        musicShuffle:   shuffle,
        musicRepeat:    repeat,
        musicCrossfade: 3,
        musicVolume:    80,
        musicPlaylistId: _creator.selectedPl.id
      })
    });
    if (!startRes.ok) {
      const errData = await startRes.json().catch(() => ({}));
      throw new Error(errData.error || 'Cloud worker failed to start (HTTP ' + startRes.status + '). Check your internet connection.');
    }
    await startRes.json();
    _renderHandoffStep(3, 'Verifying cloud worker…');
    await _sleep(600);

    // 8. Mark active + publish to liveRooms feed
    const expiresAt = Date.now() + durationMinutes * 60 * 1000;
    await updateDoc(doc(_db, 'cloudStreams', streamId), {
      status:    'active',
      startedAt: serverTimestamp(),
      expiresAt: expiresAt
    });

    // Publish to liveRooms so the discovery feed picks it up
    await setDoc(doc(_db, 'liveRooms', _user.uid), {
      creatorId:     _user.uid,
      creatorSource: 'shadow_nexus_social',
      roomId:        _user.uid,
      hostId:        _user.uid,
      hostName:      _userData?.displayName || _userData?.username || '',
      hostUsername:  _userData?.username    || '',
      hostAvatar:    _userData?.avatar || _userData?.profilePicture || _user.photoURL || '',
      title,
      description:   desc,
      category:      cat,
      coverArt:      _artworkDataUrl || '',
      status:        'live',
      isLive:        true,
      type:          '24hour_cloudstream',
      cloudStreamId: streamId,
      startedAt:     serverTimestamp(),
      expiresAt:     new Date(expiresAt).toISOString(),
      viewers:       0,
      likes:         0,
      createdAt:     serverTimestamp(),
      updatedAt:     serverTimestamp()
    });

    _streamData = {
      uid: _user.uid, streamName: title, status: 'active', durationMinutes,
      expiresAt, category: cat,
      displayName: _userData?.displayName || ''
    };

    // 9. Write initial Now Playing to Firestore (worker will overwrite)
    if (musicQueue.length) {
      const first = musicQueue[0];
      await setDoc(doc(_db, 'studioCloudStreamMusic', streamId), {
        cloudStreamId:  streamId,
        uid:            _user.uid,
        playlistId:     _creator.selectedPl.id,
        currentTrackId: first.id,
        currentTitle:   first.title,
        currentArtist:  first.artist,
        currentTrackUrl: first.url,
        currentDuration: first.duration || 0,
        nextTrackId:    musicQueue[1]?.id    || '',
        nextTitle:      musicQueue[1]?.title || '',
        nextArtist:     musicQueue[1]?.artist || '',
        queueIndex:     0,
        status:         'playing',
        updatedAt:      serverTimestamp()
      }, { merge: true });
    }

    _renderHandoffStep(4, 'Broadcast is LIVE!');
    await _sleep(800);

    _show('csrStartingProgress', false);
    _show('csrCreatePanel', false);
    _showActiveStream();
    _toast('&#9925; Cloud Radio is now LIVE! You can close this tab — the broadcast continues.', 'success');

  } catch (e) {
    console.error('[CSR] startBroadcast error:', e);
    _show('csrStartingProgress', false);
    if (btn) { btn.disabled = false; btn.innerHTML = '&#128308; GO LIVE FOR 24 HOURS'; }
    if (_streamId && e.message && e.message.includes('already active')) {
      _showActiveStream();
    } else {
      _showError('csrValidationError', e.message || 'Could not start broadcast.');
      if (_streamId) {
        // Mark failed
        updateDoc(doc(_db, 'cloudStreams', _streamId), { status: 'failed' }).catch(() => {});
      }
    }
    _streamId = null;
  }
};

function _renderHandoffStep(step, label) {
  const el = _el('csrHandoffSteps');
  if (!el) return;
  const steps = [
    'Preparing broadcast…',
    'Saving broadcast configuration…',
    'Starting cloud broadcast worker…',
    'Verifying cloud worker…',
    'Broadcast is LIVE!',
  ];
  el.innerHTML = steps.map((s, i) => {
    const done   = i < step;
    const active = i === step;
    const icon   = done ? '&#10003;' : active ? '&#9203;' : '&#9675;';
    return `<div class="csr-handoff-step${done ? ' done' : active ? ' active' : ''}">
      <span class="csr-handoff-icon">${icon}</span>
      <span>${_esc(i === step ? label : s)}</span>
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════
   STOP BROADCAST
═══════════════════════════════════════════════════════ */
window.csrConfirmStop = function() {
  _showConfirm(
    'End Cloud Broadcast?',
    'This will stop the broadcast for all listeners. The cloud worker will be shut down. This cannot be undone.',
    _stopBroadcast
  );
};

async function _stopBroadcast() {
  const btn = _el('csrStopBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Stopping…'; }
  _stopHealthMonitor();

  try {
    const idToken = await _user.getIdToken();
    await fetch(WORKER_URL + '/api/stream/stop', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
      body:    JSON.stringify({ streamId: _streamId, uid: _user.uid })
    });
  } catch(_) {}

  try {
    if (_streamId) {
      await updateDoc(doc(_db, 'cloudStreams', _streamId), {
        status: 'stopped', stoppedAt: serverTimestamp()
      });
      await updateDoc(doc(_db, 'studioCloudStreamMusic', _streamId), {
        status: 'stopped', stoppedAt: serverTimestamp()
      }).catch(() => {});
    }
    await updateDoc(doc(_db, 'liveRooms', _user.uid), {
      isLive: false, status: 'ended', updatedAt: serverTimestamp()
    }).catch(() => {});
  } catch(_) {}

  if (_player.unsub) { try { _player.unsub(); } catch(_) {} _player.unsub = null; }
  _stopPlayerAudio();
  _streamId   = null;
  _streamData = null;
  _show('csrStatusPanel', false);
  _show('csrActiveBanner', false);
  _show('csrListenerPanel', false);
  _show('csrCreatePanel', true);
  _renderCreateForm();
  _toast('Cloud broadcast ended.', 'info');
}

/* ═══════════════════════════════════════════════════════
   SKIP TRACK
═══════════════════════════════════════════════════════ */
window.csrSkipTrack = async function() {
  if (!_streamId || !_user) return;
  try {
    const idToken = await _user.getIdToken();
    await fetch(WORKER_URL + '/api/stream/music/control', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
      body:    JSON.stringify({ streamId: _streamId, uid: _user.uid, action: 'next' })
    });
    _toast('Skipping to next track…', 'info');
    // Refresh now playing after a short delay
    setTimeout(_checkHealth, 1500);
  } catch (e) {
    _toast('Could not skip: ' + e.message, 'error');
  }
};

/* ═══════════════════════════════════════════════════════
   SCROLL HELPERS
═══════════════════════════════════════════════════════ */
window.csrScrollToStream = function() {
  const el = _el('csrStatusPanel');
  if (el) el.scrollIntoView({ behavior: 'smooth' });
};
window.csrScrollToPlaylist = function() {
  // Navigate back to the 24-Hour Studio page (preserves SPA state via ?snxPage=)
  window.location.href = '/?snxPage=studioPage';
};
window.csrOpenExistingStream = function() {
  _show('csrDuplicateWarn', false);
  _showActiveStream();
};

/* ═══════════════════════════════════════════════════════
   LISTENER MODE (URL ?id=STREAMID)
   Uses the worker sync API (public endpoint) so a regular listener
   doesn't need Firestore read access to the creator's cloudStreams doc.
═══════════════════════════════════════════════════════ */
async function _initListenerMode(streamId) {
  try {
    // Worker sync endpoint is public — returns metadata + current track
    const r    = await fetch(WORKER_URL + '/api/stream/sync/' + streamId);
    const data = await r.json();

    if (!r.ok || !data.success) {
      _showPlayerOffline(data.error || 'Broadcast not found or stream worker offline.');
      return;
    }
    if (data.status !== 'active' && data.status !== 'recovering' && data.status !== 'starting') {
      _showPlayerOffline('This broadcast has ended.');
      return;
    }

    const streamData = {
      streamName:  data.streamName  || 'Shadow Nexus Cloud Radio',
      displayName: data.displayName || '',
      category:    data.category    || '',
      viewerCount: data.viewerCount || 0,
      startedAt:   data.startedAt   || 0,
      expiresAt:   data.endsAt      || 0,
      status:      data.status
    };

    // Prime the track start timestamp for seek synchronisation
    _player.trackStartedAt = data.lastAdvancedAt || data.startedAt || Date.now();

    await _initListenerForStream(streamId, streamData);

    // Pre-populate Now Playing from worker sync response immediately
    if (data.currentMusicUrl) {
      _syncListenerToNowPlaying({
        currentTitle:    data.currentMusicTitle    || '',
        currentArtist:   data.currentMusicArtist   || '',
        currentTrackUrl: data.currentMusicUrl,
        currentTrackId:  data.currentMusicId       || '',
        currentDuration: data.currentMusicDuration || 0,
        nextTitle:       data.nextMusicTitle       || '',
        nextArtist:      data.nextMusicArtist      || '',
        status:          data.musicStatus          || 'playing',
        updatedAt:       { toMillis: () => data.lastAdvancedAt || Date.now() }
      });
    }
  } catch (e) {
    // Worker temporarily down — fall back to Firestore subscription only
    console.warn('[CSR] Worker sync failed, using Firestore only:', e.message);
    _show('csrListenerPanel', true);
    await _initListenerForStream(streamId, { streamName: 'Shadow Nexus Cloud Radio', displayName: '' });
  }
}

async function _initListenerForStream(streamId, streamData) {
  _player.broadcastTitle = streamData?.streamName || 'Shadow Nexus Cloud Radio';
  _player.hostName       = streamData?.displayName || streamData?.hostName || '';

  // Update player UI header
  _setText('csrPlayerBroadcastTitle', _player.broadcastTitle);
  _setText('csrPlayerHost', _player.hostName ? 'by ' + _player.hostName : '');

  // Handle cover artwork
  if (streamData?.coverArt) {
    const art = _el('csrPlayerArtwork');
    if (art) art.innerHTML = `<img src="${_esc(streamData.coverArt)}" alt="Cover" style="width:100%;height:100%;object-fit:cover;border-radius:12px;">`;
  }

  // Subscribe to Now Playing from Firestore
  if (_player.unsub) { try { _player.unsub(); } catch(_) {} }
  _player.unsub = onSnapshot(
    doc(_db, 'studioCloudStreamMusic', streamId),
    snap => {
      if (!snap.exists()) { _showPlayerOffline('Broadcast ended.'); return; }
      const d = snap.data();
      if (d.status === 'stopped' || d.status === 'ended') {
        _showPlayerOffline('Broadcast ended.');
        return;
      }
      _syncListenerToNowPlaying(d);
    },
    err => {
      console.warn('[CSR] listener nowPlaying error:', err.message);
    }
  );

  // Note: listener count is maintained by the cloud worker via health heartbeats.
  // Clients do not write to cloudStreams directly (permission denied for non-owners).

  // Try to load current Now Playing right away
  try {
    const np = await getDoc(doc(_db, 'studioCloudStreamMusic', streamId));
    if (np.exists()) _syncListenerToNowPlaying(np.data());
  } catch(_) {}
}

function _syncListenerToNowPlaying(d) {
  if (!d) return;
  const url    = d.currentTrackUrl  || '';
  const title  = d.currentTitle     || '—';
  const artist = d.currentArtist    || '';
  const dur    = d.currentDuration  || 0;
  const next   = d.nextTitle || '';

  _setText('csrPlayerTrackTitle',  title);
  _setText('csrPlayerTrackArtist', artist);
  _setText('csrPlayerTotalTime',   _fmtDuration(dur));

  const nextEl = _el('csrPlayerNextRow');
  if (nextEl) nextEl.textContent = next ? '▶ Next: ' + next : '';

  // If the track changed, load the new audio
  if (url && url !== _player.trackUrl) {
    _player.trackUrl     = url;
    _player.trackId      = d.currentTrackId || '';
    _player.trackDur     = dur;
    _player.trackStartedAt = d.updatedAt?.toMillis ? d.updatedAt.toMillis() : Date.now();
    _loadAndPlayTrack(url, dur);
  }
}

function _loadAndPlayTrack(url, dur) {
  _stopPlayerAudio();
  const audio = new Audio(url);
  audio.volume      = _player.volume;
  audio.crossOrigin = 'anonymous';
  audio.preload     = 'auto';
  _player.audio     = audio;
  _player.trackDur  = dur;

  // Seek to synchronized position based on server-side clock
  // The worker sets updatedAt when the track starts; we skip ahead to match
  const elapsed = Math.max(0, (Date.now() - _player.trackStartedAt) / 1000);
  if (elapsed > 2 && dur > 0 && elapsed < dur - 2) {
    audio.addEventListener('loadedmetadata', () => {
      if (isFinite(audio.duration) && audio.duration > 0) {
        // Clamp seek to valid range
        const seekTo = Math.min(elapsed, audio.duration - 1);
        try { audio.currentTime = seekTo; } catch(_) {}
      }
    }, { once: true });
  }

  audio.addEventListener('timeupdate', _updatePlayerProgress);
  audio.addEventListener('ended', _onTrackEnded);
  audio.addEventListener('error', () => {
    console.warn('[CSR] audio error for track:', url);
    // Don't show error — the worker will advance and we'll get a new track
  });

  if (_player.playing) {
    audio.play().catch(() => {
      // Autoplay blocked — show play button
      _setPlayBtn(false);
    });
  }
  _setPlayBtn(_player.playing);
  _startProgressRaf();
  _show('csrPlayerOffline', false);
}

function _onTrackEnded() {
  // The Durable Object alarm will advance the track and write the new Now Playing.
  // The Firestore snapshot listener (_syncListenerToNowPlaying) will pick it up.
  // Nothing to do here — just wait for the next snapshot update.
  _stopProgressRaf();
  _setPlayBtn(false);
}

function _updatePlayerProgress() {
  const audio = _player.audio;
  if (!audio) return;
  const pos = audio.currentTime;
  const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : _player.trackDur;
  const pct = dur > 0 ? (pos / dur) * 100 : 0;
  const fill = _el('csrPlayerProgressFill');
  if (fill) fill.style.width = pct.toFixed(2) + '%';
  _setText('csrPlayerCurrentTime', _fmtDuration(Math.floor(pos)));
}

function _startProgressRaf() {
  _stopProgressRaf();
  function tick() {
    _updatePlayerProgress();
    _player.progressRaf = requestAnimationFrame(tick);
  }
  _player.progressRaf = requestAnimationFrame(tick);
}

function _stopProgressRaf() {
  if (_player.progressRaf) {
    cancelAnimationFrame(_player.progressRaf);
    _player.progressRaf = null;
  }
}

function _stopPlayerAudio() {
  _stopProgressRaf();
  if (_player.audio) {
    _player.audio.removeEventListener('timeupdate', _updatePlayerProgress);
    _player.audio.removeEventListener('ended', _onTrackEnded);
    _player.audio.pause();
    _player.audio.src = '';
    _player.audio = null;
  }
  _player.playing = false;
}

function _showPlayerOffline(msg) {
  _show('csrPlayerOffline', true);
  const el = _el('csrPlayerOffline');
  if (el) {
    const msgEl = el.querySelector('.csr-player-offline-msg');
    if (msgEl) msgEl.textContent = msg || 'Broadcast ended.';
  }
  _stopPlayerAudio();
}

/* ── Play/Pause controls ── */
window.csrTogglePlay = function() {
  if (!_player.audio) {
    // If no audio loaded yet, try reloading current track
    if (_player.trackUrl) {
      _player.playing = true;
      _loadAndPlayTrack(_player.trackUrl, _player.trackDur);
    }
    return;
  }
  if (_player.playing) {
    _player.audio.pause();
    _player.playing = false;
    _stopProgressRaf();
  } else {
    _player.audio.play().catch(() => {});
    _player.playing = true;
    _startProgressRaf();
  }
  _setPlayBtn(_player.playing);
};

function _setPlayBtn(playing) {
  const btn = _el('csrPlayerPlayBtn');
  if (btn) btn.innerHTML = playing ? '&#9646;&#9646;' : '&#9654;';
}

window.csrSetVolume = function(val) {
  _player.volume = parseInt(val, 10) / 100;
  if (_player.audio) _player.audio.volume = _player.volume;
};

/* ═══════════════════════════════════════════════════════
   BROADCAST HISTORY
═══════════════════════════════════════════════════════ */
async function _loadHistory() {
  const el = _el('csrHistoryList');
  if (!el || !_user) return;
  try {
    const snap = await getDocs(query(
      collection(_db, 'cloudStreams'),
      where('uid', '==', _user.uid),
      orderBy('createdAt', 'desc'),
      limit(10)
    ));
    if (!snap.docs.length) {
      el.innerHTML = '<div class="csr-hint">No broadcast history yet.</div>';
      _show('csrHistoryPanel', false);
      return;
    }
    _show('csrHistoryPanel', true);
    el.innerHTML = snap.docs.map(d => {
      const data = d.data();
      const started = data.startedAt?.toMillis ? data.startedAt.toMillis() : null;
      const stopped = data.stoppedAt?.toMillis ? data.stoppedAt.toMillis() : null;
      const duration = (started && stopped) ? _fmtDuration(Math.floor((stopped - started) / 1000)) : '—';
      const statusColors = { active: '#39ff14', stopped: '#5a80a8', failed: '#ff3355', ended: '#5a80a8' };
      const color = statusColors[data.status] || '#5a80a8';
      return `<div class="csr-history-item">
        <div class="csr-history-name">${_esc(data.streamName || 'Untitled')}</div>
        <div class="csr-history-meta">
          <span style="color:${color}">${_esc((data.status || '').toUpperCase())}</span>
          <span>·</span>
          <span>${started ? _fmtDate(started) : '—'}</span>
          <span>·</span>
          <span>${duration}</span>
        </div>
      </div>`;
    }).join('');
  } catch(_) {
    el.innerHTML = '<div class="csr-hint">Could not load history.</div>';
  }
}

/* ═══════════════════════════════════════════════════════
   ARTWORK
═══════════════════════════════════════════════════════ */
window.csrLoadArtwork = function(evt) {
  const file = evt.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    _artworkDataUrl = e.target.result;
    const img = _el('csrArtworkImg');
    if (img) img.src = _artworkDataUrl;
    _show('csrArtworkPreview', true);
    _el('csrArtworkBtn').textContent = '&#128444; Change Image';
  };
  reader.readAsDataURL(file);
};
window.csrRemoveArtwork = function() {
  _artworkDataUrl = null;
  _show('csrArtworkPreview', false);
  _el('csrArtworkBtn').textContent = '&#128444; Choose Image';
};

/* ═══════════════════════════════════════════════════════
   CONFIRMATION DIALOG
═══════════════════════════════════════════════════════ */
function _showConfirm(title, body, cb) {
  _confirmCallback = cb;
  _setText('csrConfirmTitle', title);
  _setText('csrConfirmBody', body);
  _show('csrConfirmOverlay', true);
}
window.csrConfirmCancel  = function() { _show('csrConfirmOverlay', false); _confirmCallback = null; };
window.csrConfirmProceed = function() { _show('csrConfirmOverlay', false); if (_confirmCallback) _confirmCallback(); _confirmCallback = null; };

/* ═══════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════ */
function _el(id)      { return document.getElementById(id); }
function _show(id, v) { const e = _el(id); if (e) e.style.display = v ? '' : 'none'; }
function _setText(id, t) { const e = _el(id); if (e) e.textContent = t || ''; }
function _sleep(ms)   { return new Promise(r => setTimeout(r, ms)); }
function _esc(s)      { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

function _fmtDuration(secs) {
  if (!secs || secs <= 0) return '0:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0 ? `${h}:${_pad(m)}:${_pad(s)}` : `${m}:${_pad(s)}`;
}
function _pad(n) { return n < 10 ? '0' + n : '' + n; }

function _fmtTime(ms) {
  return new Date(ms).toLocaleString();
}
function _fmtDate(ms) {
  return new Date(ms).toLocaleDateString();
}

function _setAuthBadge(name) {
  const el = _el('csrAuthBadge');
  if (el) el.textContent = name;
}

function _showError(id, msg) {
  const el = _el(id);
  if (!el) return;
  el.style.display = msg ? '' : 'none';
  el.textContent = msg || '';
}

let _toastTimeout = null;
function _toast(msg, type) {
  const el = _el('csrToast');
  if (!el) return;
  el.innerHTML = msg;
  el.className = 'csr-toast csr-toast-show' + (type === 'success' ? ' csr-toast-success' : type === 'error' ? ' csr-toast-error' : '');
  el.style.display = '';
  if (_toastTimeout) clearTimeout(_toastTimeout);
  _toastTimeout = setTimeout(() => {
    el.classList.remove('csr-toast-show');
    setTimeout(() => { el.style.display = 'none'; }, 300);
  }, 4000);
}

/* ═══════════════════════════════════════════════════════
   SPA RE-INIT — called by index.html realmNavTo hook
   when the user navigates to the studioPage within the SPA.
   Re-runs creator-mode check so the UI reflects current state.
═══════════════════════════════════════════════════════ */
window.csrSpaInit = async function() {
  if (!_user) return; // not signed in — onAuthStateChanged will handle it
  // Reset loading / panel visibility then re-check state
  _show('csrLoading', false);
  _show('csrAuthGate', false);
  _show('csrApp', true);
  _show('csrListenerPanel', false);
  await _initCreatorMode();
};
