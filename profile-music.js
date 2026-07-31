/* ══════════════════════════════════════════════════════════════════
   SHADOW NEXUS SOCIAL — PROFILE MUSIC  v2.0
   ─────────────────────────────────────────────────────────────────
   • Users upload a song from their device (mp3/ogg/wav/flac/m4a)
   • Up to 10 songs stored in Firebase Storage under
       profileMusic/{uid}/{filename}
   • Song metadata stored in Firestore:
       profileMusic/{uid}  — { tracks[], selected, updatedAt }
   • Profile page shows player when a profile has a selected song
   • Autoplay is DISABLED by default
   • Founder can enable / disable the entire feature via
       siteSettings/features.profileMusicEnabled
   • v2 fixes: no infinite loading, timeout guard, retry button,
     "No profile music" empty state, auth-gated loading, upload
     progress, success/error toasts, duplicate-request guard,
     auto-create document, URL verification, cache last song.
   ══════════════════════════════════════════════════════════════════ */
(function _snxProfileMusic() {
  'use strict';

  /* ── Firebase config (DO NOT CHANGE) ───────────────────────────── */
  const _FB_CFG = {
    apiKey:            'AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y',
    authDomain:        'horr-a08f4.firebaseapp.com',
    projectId:         'horr-a08f4',
    storageBucket:     'horr-a08f4.firebasestorage.app',
    messagingSenderId: '933810617818',
    appId:             '1:933810617818:web:efb24f123337dd987c14e3',
  };
  const _FB_SDK = 'https://www.gstatic.com/firebasejs/10.8.0';

  /* ── Supported audio types ──────────────────────────────────────── */
  const _ALLOWED_TYPES = new Set([
    'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav',
    'audio/wave', 'audio/x-wav', 'audio/flac', 'audio/x-flac',
    'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac',
  ]);
  const _ALLOWED_EXT = /\.(mp3|ogg|wav|flac|m4a|aac)$/i;
  const _MAX_MB = 20;

  /* ── State ──────────────────────────────────────────────────────── */
  let _db       = null, _storage = null;
  let _fsApi    = null, _stApi   = null;
  let _apisReady = false;
  let _apisLoading = false;

  let _featureEnabled = true;
  let _currentUid   = null;   // signed-in user uid
  let _viewingUid   = null;   // profile being viewed
  let _tracks       = [];     // track list for viewed profile
  let _selectedId   = null;   // selected track id
  let _audio        = null;   // HTMLAudioElement
  let _isPlaying    = false;
  let _repeat       = false;
  let _shuffle      = false;
  let _unsubFeature = null;
  let _unsubTracks  = null;
  let _loadingUid   = null;   // guard against duplicate requests
  let _loadTimeout  = null;   // timeout handle for loading guard

  /* ── Local cache key ─────────────────────────────────────────────── */
  function _cacheKey(uid) { return `snx_pm_cache_${uid}`; }

  function _readCache(uid) {
    try {
      const raw = sessionStorage.getItem(_cacheKey(uid));
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function _writeCache(uid, data) {
    try { sessionStorage.setItem(_cacheKey(uid), JSON.stringify(data)); } catch (_) {}
  }

  /* ── Bootstrap Firebase APIs ────────────────────────────────────── */
  async function _getApis() {
    if (_apisReady) return true;
    if (_apisLoading) {
      // Wait up to 8 s for concurrent init to finish
      for (let i = 0; i < 80; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (_apisReady) return true;
      }
      return false;
    }
    _apisLoading = true;
    try {
      const [appMod, fsMod, stMod] = await Promise.all([
        import(`${_FB_SDK}/firebase-app.js`),
        import(`${_FB_SDK}/firebase-firestore.js`),
        import(`${_FB_SDK}/firebase-storage.js`),
      ]);
      const { initializeApp, getApps, getApp } = appMod;
      const { getFirestore, doc, getDoc, setDoc, onSnapshot } = fsMod;
      const { getStorage, ref, uploadBytesResumable, getDownloadURL, deleteObject } = stMod;
      const app   = getApps().length ? getApp() : initializeApp(_FB_CFG, 'snx-pm-app');
      _db         = getFirestore(app);
      _storage    = getStorage(app);
      _fsApi      = { doc, getDoc, setDoc, onSnapshot };
      _stApi      = { ref, uploadBytesResumable, getDownloadURL, deleteObject };
      _apisReady  = true;
      return true;
    } catch (e) {
      console.error('[ProfileMusic] Firebase init failed:', e);
      _apisLoading = false;
      return false;
    }
  }

  /* ── Helper: show player loading state ─────────────────────────── */
  function _setPlayerLoading(isLoading) {
    const player = document.getElementById('snxProfileMusicPlayer');
    if (!player) return;
    const statusEl = player.querySelector('.pmp-load-status');
    if (!statusEl) return;
    statusEl.style.display = isLoading ? 'block' : 'none';
    // Hide content rows while loading
    const contentRows = player.querySelectorAll('.pmp-top,.pmp-progress-row,.pmp-volume-row');
    contentRows.forEach(el => { el.style.opacity = isLoading ? '0.3' : '1'; });
  }

  /* ── Helper: show empty / error state ──────────────────────────── */
  function _setPlayerState(state, msg) {
    // state: 'loading' | 'empty' | 'error' | 'ready'
    const player = document.getElementById('snxProfileMusicPlayer');
    if (!player) return;

    const loadEl  = player.querySelector('.pmp-load-status');
    const emptyEl = player.querySelector('.pmp-empty-state');
    const errorEl = player.querySelector('.pmp-error-state');

    if (loadEl)  loadEl.style.display  = state === 'loading' ? 'flex' : 'none';
    if (emptyEl) emptyEl.style.display = state === 'empty'   ? 'block' : 'none';
    if (errorEl) {
      errorEl.style.display = state === 'error' ? 'block' : 'none';
      if (state === 'error' && msg) {
        const msgEl = errorEl.querySelector('.pmp-error-msg');
        if (msgEl) msgEl.textContent = msg;
      }
    }

    const contentRows = player.querySelectorAll('.pmp-top,.pmp-progress-row,.pmp-volume-row');
    const showContent = state === 'ready';
    contentRows.forEach(el => { el.style.display = showContent ? '' : 'none'; });
  }

  /* ── Feature flag listener ──────────────────────────────────────── */
  async function _watchFeatureFlag() {
    const ok = await _getApis();
    if (!ok) return;
    if (_unsubFeature) { try { _unsubFeature(); } catch (_) {} }
    try {
      _unsubFeature = _fsApi.onSnapshot(
        _fsApi.doc(_db, 'siteSettings', 'features'),
        (snap) => {
          const d = snap.exists() ? snap.data() : {};
          _featureEnabled = d.profileMusicEnabled !== false;
          const player = document.getElementById('snxProfileMusicPlayer');
          if (!player) return;
          if (!_featureEnabled) {
            player.classList.remove('pmp-visible');
          } else if (player.dataset.hasTrack === '1') {
            player.classList.add('pmp-visible');
          }
        },
        (e) => { console.warn('[ProfileMusic] feature flag error:', e); }
      );
    } catch (e) {
      console.warn('[ProfileMusic] feature flag watch error:', e);
    }
  }

  /* ── Clear loading timeout ──────────────────────────────────────── */
  function _clearLoadTimeout() {
    if (_loadTimeout) { clearTimeout(_loadTimeout); _loadTimeout = null; }
  }

  /* ── Listen for track changes on a profile ──────────────────────── */
  async function _watchProfileTracks(uid) {
    if (!uid) return;

    // Duplicate-request guard
    if (_loadingUid === uid) return;
    _loadingUid = uid;

    const ok = await _getApis();
    if (!ok) {
      _loadingUid = null;
      _setPlayerState('error', 'Firebase unavailable — check your connection.');
      _showPlayer(true);
      console.error('[ProfileMusic] Cannot connect to Firebase for uid:', uid);
      return;
    }

    // Unsubscribe previous listener
    if (_unsubTracks) { try { _unsubTracks(); } catch (_) {} _unsubTracks = null; }
    _viewingUid = uid;

    // Show loading state
    _setPlayerState('loading');
    _showPlayer(true);

    // Safety timeout — if Firebase doesn't respond within 10 s, show error
    _clearLoadTimeout();
    _loadTimeout = setTimeout(() => {
      if (_loadingUid === uid) {
        _loadingUid = null;
        console.warn('[ProfileMusic] Load timed out for uid:', uid);
        // Try to serve from cache
        const cached = _readCache(uid);
        if (cached) {
          _tracks    = cached.tracks    || [];
          _selectedId = cached.selected || (_tracks.length ? _tracks[0].id : null);
          _renderPlayer();
        } else {
          _setPlayerState('error', 'Music took too long to load. Tap Retry to try again.');
          _showPlayer(true);
        }
      }
    }, 10000);

    try {
      _unsubTracks = _fsApi.onSnapshot(
        _fsApi.doc(_db, 'profileMusic', uid),
        (snap) => {
          _clearLoadTimeout();
          _loadingUid = null;

          let d = snap.exists() ? snap.data() : null;

          // Auto-create document if viewing own profile and doc is missing
          if (!d && uid === _currentUid) {
            d = { tracks: [], selected: null, updatedAt: Date.now() };
            _fsApi.setDoc(_fsApi.doc(_db, 'profileMusic', uid), d, { merge: true })
              .catch(e => console.warn('[ProfileMusic] auto-create doc failed:', e));
          }

          _tracks    = (d && d.tracks) ? d.tracks : [];
          _selectedId = (d && d.selected) ? d.selected
            : (_tracks.length ? _tracks[0].id : null);

          // Write to session cache
          _writeCache(uid, { tracks: _tracks, selected: _selectedId });

          _renderPlayer();

          // Sync edit panel if open and this is the current user
          if (uid === _currentUid) _renderEditPanel();
        },
        (e) => {
          _clearLoadTimeout();
          _loadingUid = null;
          console.error('[ProfileMusic] track snapshot error:', e);
          // Try cache fallback
          const cached = _readCache(uid);
          if (cached) {
            _tracks    = cached.tracks    || [];
            _selectedId = cached.selected || (_tracks.length ? _tracks[0].id : null);
            _renderPlayer();
          } else {
            _setPlayerState('error', 'Failed to load music: ' + e.message);
            _showPlayer(true);
          }
        }
      );
    } catch (e) {
      _clearLoadTimeout();
      _loadingUid = null;
      console.error('[ProfileMusic] _watchProfileTracks error:', e);
      _setPlayerState('error', 'Failed to load music: ' + e.message);
      _showPlayer(true);
    }
  }

  /* ── Show / hide the player widget ─────────────────────────────── */
  function _showPlayer(force) {
    const player = document.getElementById('snxProfileMusicPlayer');
    if (!player) return;
    if (force || _featureEnabled) {
      player.classList.add('pmp-visible');
    }
  }

  /* ── Render the profile player widget ───────────────────────────── */
  function _renderPlayer() {
    const player = document.getElementById('snxProfileMusicPlayer');
    if (!player) return;

    const track = _tracks.find(t => t.id === _selectedId) || _tracks[0] || null;

    if (!_featureEnabled) {
      player.classList.remove('pmp-visible');
      player.dataset.hasTrack = '0';
      return;
    }

    if (!track) {
      player.dataset.hasTrack = '0';
      // Only show "no music" state for the profile owner's own profile
      // Visitors see nothing if there's no track
      if (_viewingUid && _viewingUid === _currentUid) {
        _setPlayerState('empty');
        player.classList.add('pmp-visible');
      } else {
        player.classList.remove('pmp-visible');
      }
      return;
    }

    player.dataset.hasTrack = '1';
    player.classList.add('pmp-visible');
    _setPlayerState('ready');

    // Verify URL before loading
    if (!track.url || !/^https?:\/\//.test(track.url)) {
      console.warn('[ProfileMusic] Invalid audio URL for track:', track.id, track.url);
    }

    // Artwork
    const artEl = player.querySelector('.pmp-artwork-img');
    if (artEl) {
      if (track.artUrl && /^https?:\/\//.test(track.artUrl)) {
        artEl.src = track.artUrl;
        artEl.style.display = 'block';
        const iconEl = player.querySelector('.pmp-artwork-icon');
        if (iconEl) iconEl.style.display = 'none';
      } else {
        artEl.style.display = 'none';
        const iconEl = player.querySelector('.pmp-artwork-icon');
        if (iconEl) iconEl.style.display = 'block';
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
    _audio.addEventListener('ended',         _onAudioEnded);
    _audio.addEventListener('timeupdate',    _onTimeUpdate);
    _audio.addEventListener('loadedmetadata', _onMetadata);
    _audio.addEventListener('error',         _onAudioError);
    return _audio;
  }

  function _stopAudio() {
    if (_audio) {
      _audio.pause();
      try { _audio.removeEventListener('ended',         _onAudioEnded);  } catch (_) {}
      try { _audio.removeEventListener('timeupdate',    _onTimeUpdate);  } catch (_) {}
      try { _audio.removeEventListener('loadedmetadata', _onMetadata);   } catch (_) {}
      try { _audio.removeEventListener('error',         _onAudioError);  } catch (_) {}
      _audio = null;
    }
    _isPlaying = false;
    _updatePlayBtn();
    const player = document.getElementById('snxProfileMusicPlayer');
    if (player) player.classList.remove('pmp-playing');
  }

  function _onAudioError(e) {
    console.error('[ProfileMusic] Audio error:', e);
    _isPlaying = false;
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
    if (_shuffle) { _playRandomTrack(); return; }
    _playNextTrack();
  }

  function _onTimeUpdate() {
    const player = document.getElementById('snxProfileMusicPlayer');
    if (!player || !_audio) return;
    const pct  = _audio.duration ? (_audio.currentTime / _audio.duration) * 100 : 0;
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
    const m   = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  function _updatePlayBtn() {
    const btn = document.getElementById('pmpPlayBtn');
    if (btn) btn.textContent = _isPlaying ? '⏸' : '▶';
  }

  function _playNextTrack() {
    if (!_tracks.length) return;
    const idx  = _tracks.findIndex(t => t.id === _selectedId);
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
    if (!track.url || !/^https?:\/\//.test(track.url)) {
      console.error('[ProfileMusic] Cannot play — invalid URL for track:', track.id);
      return;
    }
    const audio = _getAudio(track.url, track.id);
    try {
      await audio.play();
      _isPlaying = true;
      _updatePlayBtn();
      const player = document.getElementById('snxProfileMusicPlayer');
      if (player) player.classList.add('pmp-playing');
    } catch (e) {
      console.warn('[ProfileMusic] play blocked:', e);
      _isPlaying = false;
      _updatePlayBtn();
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
    const trackEl = document.querySelector('#snxProfileMusicPlayer .pmp-progress-track');
    if (!trackEl) return;
    const rect = trackEl.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    _audio.currentTime = pct * (_audio.duration || 0);
  };

  window.snxPmpSeekBar = function (input) {
    if (!_audio) return;
    _audio.currentTime = (parseFloat(input.value) / 100) * (_audio.duration || 0);
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

  window.snxPmpClickProgress = function (e) {
    const trackEl = e.currentTarget;
    const rect    = trackEl.getBoundingClientRect();
    const pct     = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (_audio) _audio.currentTime = pct * (_audio.duration || 0);
  };

  /* Retry — re-attempt loading for the current viewing uid */
  window.snxPmpRetry = function () {
    const uid = _viewingUid;
    if (!uid) return;
    _loadingUid = null; // reset guard
    if (_unsubTracks) { try { _unsubTracks(); } catch (_) {} _unsubTracks = null; }
    _watchProfileTracks(uid);
  };

  /* ═══════════════════════════════════════════════
     EDIT PANEL — in Edit Profile modal (Music tab)
     ═══════════════════════════════════════════════ */

  function _renderEditPanel() {
    const wrap = document.getElementById('pmpEditWrap');
    if (!wrap) return;

    const isEmpty = !_tracks.length;
    wrap.innerHTML = `
      <p style="font-size:12px;color:#6a90b8;margin:0 0 12px;line-height:1.5;">
        Upload songs (mp3, ogg, wav, flac, m4a — max ${_MAX_MB}MB each).
        Choose one as your profile song. Visitors can play it on your profile.
      </p>

      <!-- Upload area -->
      <div class="pmp-upload-area" onclick="document.getElementById('pmpFileInput').click()" title="Upload Music">
        <div class="pmp-upload-area-icon">🎵</div>
        <div class="pmp-upload-area-text">
          Click to upload a song<br>
          <span style="color:#4a6a8a;font-size:11px;">mp3 · ogg · wav · flac · m4a · max ${_MAX_MB} MB</span>
        </div>
      </div>
      <input type="file" id="pmpFileInput"
             accept="audio/mpeg,audio/ogg,audio/wav,audio/flac,audio/mp4,audio/m4a,audio/*"
             style="display:none;" onchange="snxPmpUpload(this)">
      <div class="pmp-upload-progress-wrap" id="pmpUploadProgressWrap">
        <div class="pmp-upload-progress-bar" id="pmpUploadProgressBar"></div>
      </div>
      <div id="pmpUploadStatus" style="font-size:11px;color:#6a90b8;margin-bottom:8px;min-height:16px;"></div>

      <!-- Action buttons row -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
        <button class="pmp-action-btn" onclick="document.getElementById('pmpFileInput').click()" title="Upload Music">
          ⬆️ Upload Music
        </button>
        <button class="pmp-action-btn" id="pmpSelectBtn"
                onclick="snxPmpSelectTrack(_snxPmpGetSelectedInList())"
                title="Set as Profile Song" ${isEmpty ? 'disabled' : ''}>
          ✅ Select Music
        </button>
        <button class="pmp-action-btn pmp-action-btn-danger" id="pmpRemoveBtn"
                onclick="snxPmpDeleteTrack('${_selectedId || ''}')"
                title="Remove Selected Track" ${!_selectedId ? 'disabled' : ''}>
          🗑 Remove Music
        </button>
        <button class="pmp-action-btn pmp-action-btn-save" id="pmpSaveMetaBtn"
                onclick="snxPmpSaveMeta()" title="Save Track Info" ${isEmpty ? 'disabled' : ''}>
          💾 Save Music
        </button>
      </div>

      <!-- Track list -->
      <div class="pmp-track-list" id="pmpTrackList">
        ${isEmpty ? '<div style="text-align:center;font-size:12px;color:#3a5a7a;padding:12px 0;">No songs uploaded yet.</div>' : ''}
      </div>

      <!-- Song meta editor -->
      <div id="pmpMetaEditor" style="display:${isEmpty ? 'none' : 'block'};">
        <label style="font-size:11px;color:#4a7a9a;margin:10px 0 4px;display:block;">Song Title</label>
        <input id="pmpEditTitle" placeholder="Track title"
               style="margin-bottom:6px;" oninput="snxPmpMarkDirty()">
        <label style="font-size:11px;color:#4a7a9a;margin:0 0 4px;display:block;">Artist</label>
        <input id="pmpEditArtist" placeholder="Artist name"
               style="margin-bottom:6px;" oninput="snxPmpMarkDirty()">
        <label style="font-size:11px;color:#4a7a9a;margin:0 0 4px;display:block;">
          Album Art URL <small>(optional)</small>
        </label>
        <input id="pmpEditArtUrl" placeholder="https://…"
               style="margin-bottom:10px;" oninput="snxPmpMarkDirty()">
      </div>
    `;

    _renderTrackList();
  }

  /* Helper exposed so the Select button can read which track is highlighted */
  window._snxPmpGetSelectedInList = function () { return _selectedId; };

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
      return `<div class="pmp-track-item${sel ? ' pmp-track-selected' : ''}"
                   onclick="snxPmpSelectTrack('${t.id}')">
        <div class="pmp-track-art">
          ${t.artUrl && /^https?:\/\//.test(t.artUrl)
            ? `<img src="${_esc(t.artUrl)}" alt="art" onerror="this.style.display='none'">`
            : '🎵'}
        </div>
        <div class="pmp-track-info">
          <div class="pmp-track-name">${_esc(t.title || t.filename || 'Track')}</div>
          <div class="pmp-track-artist">${_esc(t.artist || '—')}</div>
        </div>
        <div class="pmp-track-dur">${_esc(t.duration || '')}</div>
        <span class="pmp-track-del"
              onclick="event.stopPropagation();snxPmpDeleteTrack('${t.id}')"
              title="Delete track">🗑</span>
      </div>`;
    }).join('');

    // Populate meta editor with selected track
    const track = _tracks.find(t => t.id === _selectedId) || _tracks[0];
    if (track) {
      const meta    = document.getElementById('pmpMetaEditor');
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
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── Upload handler ─────────────────────────────────────────────── */
  window.snxPmpUpload = async function (input) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';

    // Validate file type
    const typeOk = _ALLOWED_TYPES.has(file.type) || _ALLOWED_EXT.test(file.name);
    if (!typeOk) {
      _pmpStatus('❌ Unsupported file type. Use mp3, ogg, wav, flac, or m4a.');
      console.warn('[ProfileMusic] Rejected file type:', file.type, file.name);
      return;
    }

    if (file.size > _MAX_MB * 1024 * 1024) {
      _pmpStatus(`❌ File too large (max ${_MAX_MB} MB)`);
      return;
    }

    // Verify signed-in user
    const uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!uid) {
      _pmpStatus('❌ You must be signed in to upload music.');
      console.warn('[ProfileMusic] Upload attempted without auth');
      return;
    }

    // Must be own profile
    if (_viewingUid && uid !== _viewingUid) {
      _pmpStatus('❌ You can only upload music to your own profile.');
      return;
    }

    if (_tracks.length >= 10) {
      _pmpStatus('❌ Maximum 10 songs reached. Delete one first.');
      return;
    }

    const ok = await _getApis();
    if (!ok) { _pmpStatus('❌ Firebase not ready. Check your connection.'); return; }

    const trackId = 'trk_' + Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9._\-]/g, '_');
    const path = `profileMusic/${uid}/${trackId}_${safeName}`;

    // Show progress
    const prog = document.getElementById('pmpUploadProgressWrap');
    const bar  = document.getElementById('pmpUploadProgressBar');
    if (prog) prog.classList.add('visible');
    _pmpStatus('⬆️ Uploading… 0%');

    let storageRef;
    try {
      storageRef = _stApi.ref(_storage, path);
    } catch (e) {
      if (prog) prog.classList.remove('visible');
      _pmpStatus('❌ Storage error: ' + e.message);
      console.error('[ProfileMusic] Storage ref error:', e);
      return;
    }

    const task = _stApi.uploadBytesResumable(storageRef, file, { contentType: file.type });

    task.on(
      'state_changed',
      (snap) => {
        const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
        if (bar) bar.style.width = pct + '%';
        _pmpStatus(`⬆️ Uploading… ${pct}%`);
      },
      (err) => {
        if (prog) prog.classList.remove('visible');
        _pmpStatus('❌ Upload failed: ' + err.message);
        console.error('[ProfileMusic] Upload error:', err);
      },
      async () => {
        if (prog) prog.classList.remove('visible');
        try {
          const url = await _stApi.getDownloadURL(storageRef);

          // Verify the URL is reachable
          if (!url || !/^https?:\/\//.test(url)) {
            throw new Error('Invalid download URL returned from Storage');
          }

          const dur = await _getFileDuration(file);
          const track = {
            id:         trackId,
            filename:   file.name,
            title:      file.name.replace(/\.[^.]+$/, ''),
            artist:     '',
            artUrl:     '',
            url:        url,
            path:       path,
            duration:   _fmtTime(dur),
            uploadedAt: Date.now(),
          };
          const newTracks = [..._tracks, track];
          await _saveTracks(uid, newTracks, track.id);
          _pmpStatus('✅ Upload complete!');
          setTimeout(() => _pmpStatus(''), 3000);

          // Refresh player immediately
          _tracks    = newTracks;
          _selectedId = track.id;
          _renderPlayer();
          _renderEditPanel();
        } catch (e) {
          _pmpStatus('❌ ' + e.message);
          console.error('[ProfileMusic] Post-upload error:', e);
        }
      }
    );
  };

  function _getFileDuration(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const a   = new Audio(url);
      a.addEventListener('loadedmetadata', () => { resolve(a.duration || 0); URL.revokeObjectURL(url); });
      a.addEventListener('error',         () => { resolve(0);               URL.revokeObjectURL(url); });
    });
  }

  function _pmpStatus(msg) {
    const el = document.getElementById('pmpUploadStatus');
    if (el) el.textContent = msg;
  }

  /* ── Select track as profile song ───────────────────────────────── */
  window.snxPmpSelectTrack = async function (id) {
    if (!id) return;
    const uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!uid) { console.warn('[ProfileMusic] Select attempted without auth'); return; }
    if (uid !== _viewingUid) { console.warn('[ProfileMusic] Cannot select — not own profile'); return; }

    _selectedId = id;
    try {
      await _saveTracks(uid, _tracks, id);
      _renderTrackList();
      _renderPlayer();
      // Refresh music player immediately after saving
      _writeCache(uid, { tracks: _tracks, selected: id });
      if (typeof toastNotification === 'function') toastNotification('🎵 Profile song updated!');
    } catch (e) {
      console.error('[ProfileMusic] selectTrack error:', e);
      if (typeof toastNotification === 'function') toastNotification('❌ Failed to select song: ' + e.message);
    }
  };

  /* ── Delete a track ─────────────────────────────────────────────── */
  window.snxPmpDeleteTrack = async function (id) {
    if (!id) return;
    const uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!uid) { console.warn('[ProfileMusic] Delete attempted without auth'); return; }
    if (uid !== _viewingUid) { console.warn('[ProfileMusic] Cannot delete — not own profile'); return; }
    if (!confirm('Delete this track? This cannot be undone.')) return;

    const ok = await _getApis();
    if (!ok) { console.error('[ProfileMusic] Firebase unavailable for delete'); return; }

    const track = _tracks.find(t => t.id === id);
    if (track && track.path) {
      try {
        await _stApi.deleteObject(_stApi.ref(_storage, track.path));
      } catch (e) {
        console.warn('[ProfileMusic] Storage delete failed (file may already be gone):', e);
      }
    }

    const newTracks   = _tracks.filter(t => t.id !== id);
    const newSelected = (id === _selectedId)
      ? (newTracks.length ? newTracks[0].id : null)
      : _selectedId;

    try {
      await _saveTracks(uid, newTracks, newSelected);
      if (id === _selectedId) _stopAudio();
      _tracks    = newTracks;
      _selectedId = newSelected;
      _writeCache(uid, { tracks: _tracks, selected: _selectedId });
      _renderPlayer();
      _renderEditPanel();
      if (typeof toastNotification === 'function') toastNotification('🗑 Track removed.');
    } catch (e) {
      console.error('[ProfileMusic] deleteTrack save error:', e);
      if (typeof toastNotification === 'function') toastNotification('❌ Failed to remove track: ' + e.message);
    }
  };

  /* ── Save meta (title / artist / art URL) ───────────────────────── */
  window.snxPmpSaveMeta = async function () {
    const uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!uid) { console.warn('[ProfileMusic] SaveMeta attempted without auth'); return; }
    if (!_selectedId)  { console.warn('[ProfileMusic] No track selected'); return; }
    if (uid !== _viewingUid) { console.warn('[ProfileMusic] Cannot save meta — not own profile'); return; }

    const title  = (document.getElementById('pmpEditTitle')  || {}).value || '';
    const artist = (document.getElementById('pmpEditArtist') || {}).value || '';
    const artUrl = (document.getElementById('pmpEditArtUrl') || {}).value || '';

    const newTracks = _tracks.map(t =>
      t.id === _selectedId ? { ...t, title, artist, artUrl } : t
    );

    const btn = document.getElementById('pmpSaveMetaBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving…'; }

    try {
      await _saveTracks(uid, newTracks, _selectedId);
      _tracks = newTracks;
      _writeCache(uid, { tracks: _tracks, selected: _selectedId });
      // Refresh player immediately after saving
      _renderPlayer();
      if (btn) { btn.disabled = false; btn.textContent = '💾 Save Music'; btn.style.borderColor = ''; }
      if (typeof toastNotification === 'function') toastNotification('✅ Music info saved!');
      else _pmpStatus('✅ Saved!');
      setTimeout(() => _pmpStatus(''), 2500);
    } catch (e) {
      console.error('[ProfileMusic] saveMeta error:', e);
      if (btn) { btn.disabled = false; btn.textContent = '💾 Save Music'; }
      if (typeof toastNotification === 'function') toastNotification('❌ Save failed: ' + e.message);
      else _pmpStatus('❌ Save failed: ' + e.message);
    }
  };

  window.snxPmpMarkDirty = function () {
    const btn = document.getElementById('pmpSaveMetaBtn');
    if (btn) btn.style.borderColor = 'rgba(57,255,20,0.65)';
  };

  /* ── Save tracks to Firestore ───────────────────────────────────── */
  async function _saveTracks(uid, tracks, selected) {
    const ok = await _getApis();
    if (!ok) throw new Error('Firebase not ready');
    await _fsApi.setDoc(
      _fsApi.doc(_db, 'profileMusic', uid),
      { tracks, selected: selected || null, updatedAt: Date.now() },
      { merge: true }
    );
  }

  /* ═══════════════════════════════════════════════
     PUBLIC: load player for a given profile uid
     Called by viewProfile() in the main app.
     Only runs when user auth has completed.
     ═══════════════════════════════════════════════ */
  window.snxProfileMusicLoad = async function (uid) {
    if (!uid) return;

    // Verify Firebase connection before requesting music
    const ok = await _getApis();
    if (!ok) {
      console.error('[ProfileMusic] Cannot load — Firebase unavailable');
      const player = document.getElementById('snxProfileMusicPlayer');
      if (player) {
        _setPlayerState('error', 'Cannot connect to Firebase. The page will remain usable.');
        player.classList.add('pmp-visible');
      }
      return;
    }

    // Stop any playing audio from previous profile
    _stopAudio();
    _tracks     = [];
    _selectedId = null;
    _viewingUid = uid;

    // Update current user uid (set by auth completion)
    _currentUid = (window._snxCurrentUser && window._snxCurrentUser.uid) || null;

    // Verify UID before requesting
    if (!_currentUid) {
      console.warn('[ProfileMusic] No authenticated user — will load read-only');
    }

    const player = document.getElementById('snxProfileMusicPlayer');
    if (player) player.classList.remove('pmp-visible');

    // Serve cached data instantly while fetching fresh data
    const cached = _readCache(uid);
    if (cached && cached.tracks && cached.tracks.length) {
      _tracks    = cached.tracks;
      _selectedId = cached.selected || _tracks[0].id;
      _renderPlayer();
    }

    // Only load music when profile page is open (guard: called here)
    await _watchProfileTracks(uid);
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
      console.error('[ProfileMusic] Founder toggle error:', e);
      if (typeof toastNotification === 'function') toastNotification('❌ ' + e.message);
    }
  };

  /* ── Init ───────────────────────────────────────────────────────── */
  function _init() {
    _watchFeatureFlag();

    // Listen for auth-ready event dispatched by the main app
    document.addEventListener('snx-auth-ready', (e) => {
      _currentUid = (e.detail && e.detail.uid) || null;
      // If there's a viewing uid waiting for auth, load now
      if (_viewingUid && _loadingUid !== _viewingUid) {
        _watchProfileTracks(_viewingUid);
      }
    });

    // Also sync current user from window if already set
    if (window._snxCurrentUser && window._snxCurrentUser.uid) {
      _currentUid = window._snxCurrentUser.uid;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

})();
