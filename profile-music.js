/* ══════════════════════════════════════════════════════════════════
   SHADOW NEXUS SOCIAL — PROFILE MUSIC  v1.0
   ─────────────────────────────────────────────────────────────────
   • Users upload a song from their device (mp3/ogg/wav/flac)
   • Up to 10 songs stored in Firebase Storage under
       profileMusic/{uid}/{filename}
   • Song metadata stored in Firestore:
       profileMusic/{uid}/tracks — array of track objects
       profileMusic/{uid}/selected — selected track id
   • Profile page shows player when a profile has a selected song:
       title, artist, album art (if embedded), play/pause,
       progress bar, volume control, repeat, shuffle
   • Autoplay is DISABLED by default
   • Founder can enable / disable the entire feature via
       siteSettings/features.profileMusicEnabled
   • Zero impact on feeds, auth, messaging, live, or any other module
   ══════════════════════════════════════════════════════════════════ */
(function _snxProfileMusic() {
  'use strict';

  /* ── Firebase config (mirrors existing app) ─────────────────────── */
  const _FB_CFG = {
    apiKey:            'AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y',
    authDomain:        'horr-a08f4.firebaseapp.com',
    projectId:         'horr-a08f4',
    storageBucket:     'horr-a08f4.firebasestorage.app',
    messagingSenderId: '933810617818',
    appId:             '1:933810617818:web:efb24f123337dd987c14e3',
  };
  const _FB_SDK = 'https://www.gstatic.com/firebasejs/10.8.0';

  /* ── State ──────────────────────────────────────────────────────── */
  let _db = null, _storage = null, _auth = null;
  let _fsApi = null, _stApi = null;
  let _featureEnabled = true;       // from Firestore siteSettings
  let _currentUid = null;           // signed-in user uid
  let _viewingUid = null;           // profile being viewed
  let _tracks = [];                 // track list for viewed profile
  let _selectedId = null;           // selected track id
  let _audio = null;                // HTMLAudioElement
  let _isPlaying = false;
  let _repeat = false;
  let _shuffle = false;
  let _progressRaf = null;
  let _unsubFeature = null;
  let _unsubTracks = null;

  /* ── Bootstrap Firebase API ─────────────────────────────────────── */
  async function _getApis() {
    if (_fsApi && _stApi) return true;
    if (window._snxFirestore) {
      _fsApi = window._snxFirestore;
    }
    try {
      const [appMod, fsMod, stMod] = await Promise.all([
        import(`${_FB_SDK}/firebase-app.js`),
        import(`${_FB_SDK}/firebase-firestore.js`),
        import(`${_FB_SDK}/firebase-storage.js`),
      ]);
      const { initializeApp, getApps, getApp } = appMod;
      const { getFirestore, doc, getDoc, setDoc, onSnapshot, collection, query } = fsMod;
      const { getStorage, ref, uploadBytesResumable, getDownloadURL, deleteObject } = stMod;
      const app = getApps().length ? getApp() : initializeApp(_FB_CFG, 'snx-pm-app');
      _db      = getFirestore(app);
      _storage = getStorage(app);
      _fsApi   = { doc, getDoc, setDoc, onSnapshot, collection, query };
      _stApi   = { ref, uploadBytesResumable, getDownloadURL, deleteObject };
      return true;
    } catch (e) {
      console.warn('[ProfileMusic] Firebase init failed:', e);
      return false;
    }
  }

  /* ── Feature flag listener ──────────────────────────────────────── */
  async function _watchFeatureFlag() {
    const ok = await _getApis();
    if (!ok) return;
    if (_unsubFeature) { try { _unsubFeature(); } catch(_) {} }
    try {
      _unsubFeature = _fsApi.onSnapshot(
        _fsApi.doc(_db, 'siteSettings', 'features'),
        (snap) => {
          const d = snap.exists() ? snap.data() : {};
          _featureEnabled = d.profileMusicEnabled !== false;
          const player = document.getElementById('snxProfileMusicPlayer');
          if (player) player.style.display = (_featureEnabled && player.dataset.hasTrack === '1') ? 'block' : 'none';
        }
      );
    } catch (e) {
      console.warn('[ProfileMusic] feature flag watch error:', e);
    }
  }

  /* ── Listen for track changes on a profile ──────────────────────── */
  async function _watchProfileTracks(uid) {
    const ok = await _getApis();
    if (!ok) return;
    if (_unsubTracks) { try { _unsubTracks(); } catch(_) {} _unsubTracks = null; }
    _viewingUid = uid;
    try {
      _unsubTracks = _fsApi.onSnapshot(
        _fsApi.doc(_db, 'profileMusic', uid),
        (snap) => {
          const d = snap.exists() ? snap.data() : {};
          _tracks = d.tracks || [];
          _selectedId = d.selected || (_tracks.length ? _tracks[0].id : null);
          _renderPlayer();
          // sync edit panel if open and this is the current user
          if (uid === _currentUid) _renderEditPanel();
        }
      );
    } catch (e) {
      console.warn('[ProfileMusic] track watch error:', e);
    }
  }

  /* ── Render the profile player widget ───────────────────────────── */
  function _renderPlayer() {
    const player = document.getElementById('snxProfileMusicPlayer');
    if (!player) return;
    const track = _tracks.find(t => t.id === _selectedId) || _tracks[0] || null;
    if (!track || !_featureEnabled) {
      player.classList.remove('pmp-visible');
      player.dataset.hasTrack = '0';
      return;
    }
    player.dataset.hasTrack = '1';
    player.classList.add('pmp-visible');

    // Artwork
    const artEl = player.querySelector('.pmp-artwork-img');
    if (artEl) {
      if (track.artUrl) {
        artEl.src = track.artUrl;
        artEl.style.display = 'block';
        player.querySelector('.pmp-artwork-icon').style.display = 'none';
      } else {
        artEl.style.display = 'none';
        player.querySelector('.pmp-artwork-icon').style.display = 'block';
      }
    }

    // Info
    const titleEl = player.querySelector('.pmp-title');
    if (titleEl) titleEl.textContent = track.title || track.filename || 'Unknown Track';
    const artistEl = player.querySelector('.pmp-artist');
    if (artistEl) artistEl.textContent = track.artist || '—';

    // If audio is for a different track, reset
    if (_audio && _audio.dataset.trackId !== track.id) {
      _stopAudio();
    }
  }

  /* ── Create or reuse HTMLAudioElement ───────────────────────────── */
  function _getAudio(url, trackId) {
    if (_audio && _audio.dataset.trackId === trackId) return _audio;
    _stopAudio();
    _audio = new Audio(url);
    _audio.dataset.trackId = trackId;
    _audio.preload = 'metadata';
    _audio.addEventListener('ended', _onAudioEnded);
    _audio.addEventListener('timeupdate', _onTimeUpdate);
    _audio.addEventListener('loadedmetadata', _onMetadata);
    return _audio;
  }

  function _stopAudio() {
    if (_audio) {
      _audio.pause();
      try { _audio.removeEventListener('ended', _onAudioEnded); } catch(_) {}
      try { _audio.removeEventListener('timeupdate', _onTimeUpdate); } catch(_) {}
      _audio = null;
    }
    _isPlaying = false;
    if (_progressRaf) { cancelAnimationFrame(_progressRaf); _progressRaf = null; }
    _updatePlayBtn();
    const player = document.getElementById('snxProfileMusicPlayer');
    if (player) player.classList.remove('pmp-playing');
  }

  function _onAudioEnded() {
    if (_repeat) {
      _audio.currentTime = 0;
      _audio.play().catch(() => {});
      return;
    }
    if (_shuffle) {
      _playRandomTrack();
      return;
    }
    // auto-advance to next track
    _playNextTrack();
  }

  function _onTimeUpdate() {
    const player = document.getElementById('snxProfileMusicPlayer');
    if (!player || !_audio) return;
    const pct = _audio.duration ? (_audio.currentTime / _audio.duration) * 100 : 0;
    const fill = player.querySelector('.pmp-progress-fill');
    if (fill) fill.style.width = pct + '%';
    const curEl = player.querySelector('.pmp-time-current');
    if (curEl) curEl.textContent = _fmtTime(_audio.currentTime);
  }

  function _onMetadata() {
    const player = document.getElementById('snxProfileMusicPlayer');
    if (!player || !_audio) return;
    const durEl = player.querySelector('.pmp-time-total');
    if (durEl) durEl.textContent = _fmtTime(_audio.duration);
  }

  function _fmtTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2,'0')}`;
  }

  function _updatePlayBtn() {
    const btn = document.getElementById('pmpPlayBtn');
    if (btn) btn.textContent = _isPlaying ? '⏸' : '▶';
  }

  function _playNextTrack() {
    if (!_tracks.length) return;
    const idx = _tracks.findIndex(t => t.id === _selectedId);
    const next = _tracks[(idx + 1) % _tracks.length];
    if (next) { _selectedId = next.id; _renderPlayer(); _startPlay(); }
  }

  function _playRandomTrack() {
    if (_tracks.length < 2) return;
    let r;
    do { r = Math.floor(Math.random() * _tracks.length); } while (_tracks[r].id === _selectedId);
    _selectedId = _tracks[r].id;
    _renderPlayer();
    _startPlay();
  }

  async function _startPlay() {
    const track = _tracks.find(t => t.id === _selectedId);
    if (!track) return;
    const audio = _getAudio(track.url, track.id);
    try {
      await audio.play();
      _isPlaying = true;
      _updatePlayBtn();
      const player = document.getElementById('snxProfileMusicPlayer');
      if (player) player.classList.add('pmp-playing');
    } catch (e) {
      console.warn('[ProfileMusic] play blocked:', e);
    }
  }

  /* ═══════════════════════════════════════════════
     PUBLIC API — called from HTML buttons
     ═══════════════════════════════════════════════ */

  window.snxPmpTogglePlay = function () {
    const track = _tracks.find(t => t.id === _selectedId);
    if (!track) return;
    if (!_audio || _audio.dataset.trackId !== track.id) {
      _startPlay();
      return;
    }
    if (_isPlaying) {
      _audio.pause();
      _isPlaying = false;
      const player = document.getElementById('snxProfileMusicPlayer');
      if (player) player.classList.remove('pmp-playing');
    } else {
      _startPlay();
    }
    _updatePlayBtn();
  };

  window.snxPmpSeek = function (e) {
    if (!_audio) return;
    const track = player.querySelector('.pmp-progress-track');
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    _audio.currentTime = pct * (_audio.duration || 0);
  };

  window.snxPmpSeekBar = function (input) {
    if (!_audio) return;
    const pct = parseFloat(input.value) / 100;
    _audio.currentTime = pct * (_audio.duration || 0);
  };

  window.snxPmpVolume = function (input) {
    if (_audio) _audio.volume = parseFloat(input.value);
  };

  window.snxPmpToggleRepeat = function () {
    _repeat = !_repeat;
    const btn = document.getElementById('pmpRepeatBtn');
    if (btn) btn.classList.toggle('pmp-active', _repeat);
  };

  window.snxPmpToggleShuffle = function () {
    _shuffle = !_shuffle;
    const btn = document.getElementById('pmpShuffleBtn');
    if (btn) btn.classList.toggle('pmp-active', _shuffle);
  };

  window.snxPmpNext = function () { _playNextTrack(); };
  window.snxPmpPrev = function () {
    if (!_tracks.length) return;
    const idx  = _tracks.findIndex(t => t.id === _selectedId);
    const prev = _tracks[(idx - 1 + _tracks.length) % _tracks.length];
    if (prev) { _selectedId = prev.id; _renderPlayer(); _startPlay(); }
  };

  /* ── Click on progress bar ── */
  window.snxPmpClickProgress = function (e) {
    const track = e.currentTarget;
    const rect  = track.getBoundingClientRect();
    const pct   = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (_audio) _audio.currentTime = pct * (_audio.duration || 0);
  };

  /* ═══════════════════════════════════════════════
     EDIT PANEL — in Edit Profile modal
     ═══════════════════════════════════════════════ */

  function _renderEditPanel() {
    const wrap = document.getElementById('pmpEditWrap');
    if (!wrap) return;

    const isEmpty = !_tracks.length;
    wrap.innerHTML = `
      <p style="font-size:12px;color:#6a90b8;margin:0 0 12px;line-height:1.5;">
        Upload songs (mp3, ogg, wav, flac — max 20MB each). Choose one as your profile song.
        Visitors can play it on your profile.
      </p>

      <!-- Upload area -->
      <div class="pmp-upload-area" onclick="document.getElementById('pmpFileInput').click()">
        <div class="pmp-upload-area-icon">🎵</div>
        <div class="pmp-upload-area-text">Click to upload a song<br>
          <span style="color:#4a6a8a;font-size:11px;">mp3 · ogg · wav · flac · max 20 MB</span>
        </div>
      </div>
      <input type="file" id="pmpFileInput" accept="audio/mpeg,audio/ogg,audio/wav,audio/flac,audio/*"
             style="display:none;" onchange="snxPmpUpload(this)">
      <div class="pmp-upload-progress-wrap" id="pmpUploadProgressWrap">
        <div class="pmp-upload-progress-bar" id="pmpUploadProgressBar"></div>
      </div>
      <div id="pmpUploadStatus" style="font-size:11px;color:#6a90b8;margin-bottom:8px;min-height:16px;"></div>

      <!-- Track list -->
      <div class="pmp-track-list" id="pmpTrackList">
        ${isEmpty ? '<div style="text-align:center;font-size:12px;color:#3a5a7a;padding:12px 0;">No songs uploaded yet.</div>' : ''}
      </div>

      <!-- Song meta editor -->
      <div id="pmpMetaEditor" style="display:${isEmpty?'none':'block'};">
        <label style="font-size:11px;color:#4a7a9a;margin:10px 0 4px;display:block;">Song Title</label>
        <input id="pmpEditTitle" placeholder="Track title" style="margin-bottom:6px;" oninput="snxPmpMarkDirty()">
        <label style="font-size:11px;color:#4a7a9a;margin:0 0 4px;display:block;">Artist</label>
        <input id="pmpEditArtist" placeholder="Artist name" style="margin-bottom:6px;" oninput="snxPmpMarkDirty()">
        <label style="font-size:11px;color:#4a7a9a;margin:0 0 4px;display:block;">Album Art URL <small>(optional)</small></label>
        <input id="pmpEditArtUrl" placeholder="https://…" style="margin-bottom:10px;" oninput="snxPmpMarkDirty()">
        <button id="pmpSaveMetaBtn" onclick="snxPmpSaveMeta()" style="font-size:12px;padding:6px 16px;border-radius:8px;background:linear-gradient(135deg,#003d99,#0066cc);border-color:rgba(0,174,239,0.65);color:#fff;">💾 Save Info</button>
      </div>
    `;

    _renderTrackList();
  }

  function _renderTrackList() {
    const list = document.getElementById('pmpTrackList');
    if (!list) return;
    if (!_tracks.length) {
      list.innerHTML = '<div style="text-align:center;font-size:12px;color:#3a5a7a;padding:12px 0;">No songs uploaded yet.</div>';
      const meta = document.getElementById('pmpMetaEditor');
      if (meta) meta.style.display = 'none';
      return;
    }
    list.innerHTML = _tracks.map(t => {
      const sel = t.id === _selectedId;
      return `<div class="pmp-track-item${sel?' pmp-track-selected':''}" onclick="snxPmpSelectTrack('${t.id}')">
        <div class="pmp-track-art">
          ${t.artUrl ? `<img src="${t.artUrl}" alt="art" onerror="this.style.display='none'">` : '🎵'}
        </div>
        <div class="pmp-track-info">
          <div class="pmp-track-name">${_esc(t.title || t.filename || 'Track')}</div>
          <div class="pmp-track-artist">${_esc(t.artist || '—')}</div>
        </div>
        <div class="pmp-track-dur">${t.duration || ''}</div>
        <span class="pmp-track-del" onclick="event.stopPropagation();snxPmpDeleteTrack('${t.id}')" title="Delete">🗑</span>
      </div>`;
    }).join('');

    // Populate meta editor with selected track
    const track = _tracks.find(t => t.id === _selectedId) || _tracks[0];
    if (track) {
      const meta = document.getElementById('pmpMetaEditor');
      if (meta) meta.style.display = 'block';
      const titleEl  = document.getElementById('pmpEditTitle');
      const artistEl = document.getElementById('pmpEditArtist');
      const artEl    = document.getElementById('pmpEditArtUrl');
      if (titleEl)  titleEl.value  = track.title  || '';
      if (artistEl) artistEl.value = track.artist || '';
      if (artEl)    artEl.value    = track.artUrl || '';
      _selectedId = track.id;
    }
  }

  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ── Upload handler ─────────────────────────────────────────────── */
  window.snxPmpUpload = async function (input) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';

    const MAX_MB = 20;
    if (file.size > MAX_MB * 1024 * 1024) {
      _pmpStatus(`❌ File too large (max ${MAX_MB} MB)`);
      return;
    }

    const uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!uid) { _pmpStatus('❌ Not signed in'); return; }

    const ok = await _getApis();
    if (!ok) { _pmpStatus('❌ Firebase not ready'); return; }

    const trackId = 'trk_' + Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9._\-]/g, '_');
    const path = `profileMusic/${uid}/${trackId}_${safeName}`;

    // Show progress
    const prog = document.getElementById('pmpUploadProgressWrap');
    const bar  = document.getElementById('pmpUploadProgressBar');
    if (prog) prog.classList.add('visible');
    _pmpStatus('⬆️ Uploading…');

    const storageRef = _stApi.ref(_storage, path);
    const task = _stApi.uploadBytesResumable(storageRef, file, {
      contentType: file.type,
    });

    task.on('state_changed',
      (snap) => {
        const pct = (snap.bytesTransferred / snap.totalBytes) * 100;
        if (bar) bar.style.width = pct + '%';
      },
      (err) => {
        if (prog) prog.classList.remove('visible');
        _pmpStatus('❌ Upload failed: ' + err.message);
      },
      async () => {
        if (prog) prog.classList.remove('visible');
        try {
          const url = await _stApi.getDownloadURL(storageRef);
          // Read duration from audio
          const dur = await _getFileDuration(file);
          const track = {
            id:       trackId,
            filename: file.name,
            title:    file.name.replace(/\.[^.]+$/, ''),
            artist:   '',
            artUrl:   '',
            url:      url,
            path:     path,
            duration: _fmtTime(dur),
            uploadedAt: Date.now(),
          };
          const newTracks = [..._tracks, track];
          await _saveTracks(uid, newTracks, track.id);
          _pmpStatus('✅ Uploaded!');
          setTimeout(() => _pmpStatus(''), 2500);
        } catch (e) {
          _pmpStatus('❌ ' + e.message);
        }
      }
    );
  };

  function _getFileDuration(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const a = new Audio(url);
      a.addEventListener('loadedmetadata', () => {
        resolve(a.duration || 0);
        URL.revokeObjectURL(url);
      });
      a.addEventListener('error', () => { resolve(0); URL.revokeObjectURL(url); });
    });
  }

  function _pmpStatus(msg) {
    const el = document.getElementById('pmpUploadStatus');
    if (el) el.textContent = msg;
  }

  /* ── Select track as profile song ───────────────────────────────── */
  window.snxPmpSelectTrack = async function (id) {
    const uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!uid) return;
    _selectedId = id;
    await _saveTracks(uid, _tracks, id);
    _renderTrackList();
    _renderPlayer();
  };

  /* ── Delete a track ─────────────────────────────────────────────── */
  window.snxPmpDeleteTrack = async function (id) {
    const uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!uid) return;
    if (!confirm('Delete this track?')) return;
    const ok = await _getApis();
    if (!ok) return;
    const track = _tracks.find(t => t.id === id);
    if (track && track.path) {
      try {
        await _stApi.deleteObject(_stApi.ref(_storage, track.path));
      } catch (e) {
        console.warn('[ProfileMusic] storage delete failed:', e);
      }
    }
    const newTracks = _tracks.filter(t => t.id !== id);
    const newSelected = (id === _selectedId)
      ? (newTracks.length ? newTracks[0].id : null)
      : _selectedId;
    await _saveTracks(uid, newTracks, newSelected);
    if (id === _selectedId) _stopAudio();
  };

  /* ── Save meta (title / artist / art URL) ───────────────────────── */
  window.snxPmpSaveMeta = async function () {
    const uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!uid || !_selectedId) return;
    const title  = (document.getElementById('pmpEditTitle')  || {}).value || '';
    const artist = (document.getElementById('pmpEditArtist') || {}).value || '';
    const artUrl = (document.getElementById('pmpEditArtUrl') || {}).value || '';
    const newTracks = _tracks.map(t =>
      t.id === _selectedId ? { ...t, title, artist, artUrl } : t
    );
    await _saveTracks(uid, newTracks, _selectedId);
    if (typeof toastNotification === 'function') toastNotification('🎵 Track info saved!');
  };

  window.snxPmpMarkDirty = function () {
    const btn = document.getElementById('pmpSaveMetaBtn');
    if (btn) btn.style.borderColor = 'rgba(57,255,20,0.65)';
  };

  /* ── Save tracks to Firestore ───────────────────────────────────── */
  async function _saveTracks(uid, tracks, selected) {
    const ok = await _getApis();
    if (!ok) return;
    try {
      await _fsApi.setDoc(
        _fsApi.doc(_db, 'profileMusic', uid),
        { tracks, selected, updatedAt: Date.now() },
        { merge: true }
      );
    } catch (e) {
      console.warn('[ProfileMusic] save tracks error:', e);
    }
  }

  /* ═══════════════════════════════════════════════
     PUBLIC: load player for a given profile uid
     Called by viewProfile() in the main app
     ═══════════════════════════════════════════════ */
  window.snxProfileMusicLoad = async function (uid) {
    if (!uid) return;
    _stopAudio();
    _tracks = [];
    _selectedId = null;
    _viewingUid = uid;
    const player = document.getElementById('snxProfileMusicPlayer');
    if (player) player.classList.remove('pmp-visible');
    await _watchProfileTracks(uid);
    // also track current user uid (set externally)
    _currentUid = window._snxCurrentUser && window._snxCurrentUser.uid;
  };

  /* ── Founder kill switch ────────────────────────────────────────── */
  window.snxPmpFounderToggle = async function (enabled) {
    if (window._snxRole !== 'founder' &&
        !(window.userData && window.userData.role === 'founder')) {
      if (typeof toastNotification === 'function') toastNotification('⛔ Founder only');
      return;
    }
    const ok = await _getApis();
    if (!ok) return;
    try {
      await _fsApi.setDoc(
        _fsApi.doc(_db, 'siteSettings', 'features'),
        { profileMusicEnabled: enabled, updatedAt: Date.now() },
        { merge: true }
      );
      if (typeof toastNotification === 'function')
        toastNotification(`🎵 Profile Music: ${enabled ? 'Enabled' : 'Disabled'}`);
    } catch (e) {
      if (typeof toastNotification === 'function') toastNotification('❌ ' + e.message);
    }
  };

  /* ── Init ───────────────────────────────────────────────────────── */
  function _init() {
    _watchFeatureFlag();
    // Expose a way for the main app to set current user
    document.addEventListener('snx-auth-ready', (e) => {
      _currentUid = e.detail && e.detail.uid;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

})();
