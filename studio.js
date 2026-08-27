/**
 * Shadow Nexus Social — 24-Hour Studio
 * studio.js  •  Production Streaming & CloudStream Controller
 *
 * Architecture:
 *   - Uses window._snxFirestore (Firestore), window._snxAuthResolved, auth
 *   - Integrates with existing liveRooms, feed, gifting & notification systems
 *   - CloudStream state is owned by the Cloudflare Worker (server-side)
 *   - No privileged credentials in this file — all sensitive ops go via worker
 *
 * Collections created (isolated from existing data):
 *   studioSettings/{uid}      — per-creator studio preferences
 *   studioScenes/{sceneId}    — saved scenes (ownerUid, name, elements[])
 *   studioThemes/{uid}        — active theme selection
 *   studioPlaylists/{plId}    — cloud music playlists
 *   cloudStreams/{streamId}   — cloud broadcast records
 *   cloudStreamHeartbeats/{streamId} — health heartbeats
 *   cloudStreamEvents/{evtId} — event log
 */

'use strict';

(function() {

/* ═══════════════════════════════════════════════════════
   0. CONSTANTS
═══════════════════════════════════════════════════════ */
var STUDIO_VERSION = '1.2.0';
var APP_BUILD_VERSION = '2026-08-26-GLOBAL-HARD-UPDATE';

// Expose for debug panels and version verification
window.SNX_STUDIO_BUILD = APP_BUILD_VERSION;

// Debug state accessor — used by the ?snxdebug=1 panel in index.html
// Exposes only non-secret state; never exposes tokens or credentials.
window._snxStudioDebugState = function() {
  return {
    buildVersion:     APP_BUILD_VERSION,
    liveEngine:       'live.html (existing SNX live system)',
    studioSessionId:  _state.studioSessionId,
    cloudStreamId:    _state.cloudStreamId,
    cloudStatus:      _state.cloudStatus,
    isLive:           _state.isLive,
    workerMode:       _state.cloudStream ? _state.cloudStream.workerMode || 'live' : null,
    startedAt:        _state.cloudStream ? _state.cloudStream.startedAt  || null : null,
    viewerCount:      _state.cloudStream ? _state.cloudStream.viewerCount || 0   : 0,
    // CloudStream Playlist
    musicPlaylistId:  _csMusic.selectedId,
    musicQueueLen:    _csMusic.queue.length,
    musicPlaying:     _csMusic.playing,
    musicNowPlaying:  _csMusic.nowPlayingTitle
  };
};

// CloudStream Worker endpoint
var CLOUDSTREAM_WORKER_URL = 'https://snx-cloudstream.nthntjrn.workers.dev';

// Studio modes — 'filters' is its own independent Studio mode, never Regular Live
var MODES = ['live', 'filters', 'music', 'theme', 'effects', 'events', 'cloudstream'];

/* ─────────────────────────────────────────────────────────
   CAMERA FILTERS — applied via CSS filter on the <video> element
   and via Canvas 2D compositing for capture.
   These NEVER route to the regular Live system.
   ───────────────────────────────────────────────────────── */
var CAMERA_FILTERS = [
  { id: 'none',         name: 'Normal',        css: 'none',                                                         icon: '📷' },
  { id: 'neon',         name: 'Neon',          css: 'saturate(2.5) hue-rotate(200deg) brightness(1.1) contrast(1.2)', icon: '💜' },
  { id: 'midnight',     name: 'Midnight',      css: 'brightness(0.55) contrast(1.6) saturate(0.4)',                  icon: '🌙' },
  { id: 'blue-flame',   name: 'Blue Flame',    css: 'sepia(0.4) hue-rotate(180deg) saturate(3) brightness(1.1)',     icon: '🔵' },
  { id: 'shadow',       name: 'Shadow',        css: 'brightness(0.45) contrast(2.0) saturate(0.15)',                 icon: '🌑' },
  { id: 'green-lightning', name: 'Green Lightning', css: 'saturate(3) hue-rotate(90deg) brightness(1.05) contrast(1.3)', icon: '⚡' },
  { id: 'cyber',        name: 'Cyber Nexus',   css: 'invert(0.1) hue-rotate(160deg) saturate(2.5) contrast(1.2)',   icon: '🤖' },
  { id: 'warm',         name: 'Warm Glow',     css: 'sepia(0.5) brightness(1.15) contrast(1.1) saturate(1.3)',      icon: '🔶' },
  { id: 'cold',         name: 'Cold Steel',    css: 'sepia(0.2) hue-rotate(195deg) saturate(1.5) brightness(0.95)', icon: '🔷' },
  { id: 'dramatic',     name: 'Dramatic',      css: 'contrast(1.8) saturate(0.8) brightness(0.85)',                 icon: '🎭' },
  { id: 'vhs',          name: 'VHS Retro',     css: 'sepia(0.3) contrast(1.4) brightness(0.9) saturate(1.6)',       icon: '📼' },
  { id: 'galaxy',       name: 'Dark Galaxy',   css: 'hue-rotate(270deg) saturate(2) brightness(0.7) contrast(1.5)', icon: '🌌' }
];

// Available themes
var THEMES = [
  { id: 'shadow-nexus',    name: 'Shadow Nexus',   bg: 'linear-gradient(135deg,#0B1F3A,#071428)', icon: '🌑', accent: '#00AEEF' },
  { id: 'neon-shadow',     name: 'Neon Shadow',    bg: 'linear-gradient(135deg,#0a0020,#1a0040)', icon: '🔮', accent: '#a855f7' },
  { id: 'midnight',        name: 'Midnight',       bg: 'linear-gradient(135deg,#050505,#101010)', icon: '🌙', accent: '#c8c8ff' },
  { id: 'blue-flame',      name: 'Blue Flame',     bg: 'linear-gradient(135deg,#001433,#003399)', icon: '🔵', accent: '#0099ff' },
  { id: 'green-lightning', name: 'Green Lightning',bg: 'linear-gradient(135deg,#001a00,#003300)', icon: '⚡', accent: '#39ff14' },
  { id: 'dark-galaxy',     name: 'Dark Galaxy',    bg: 'linear-gradient(135deg,#0a0015,#15002a)', icon: '🌌', accent: '#ff00ff' },
  { id: 'cyber-nexus',     name: 'Cyber Nexus',    bg: 'linear-gradient(135deg,#001a1a,#003333)', icon: '🤖', accent: '#00ffff' },
  { id: 'creator-custom',  name: 'Creator Custom', bg: 'linear-gradient(135deg,#1a1020,#2a1838)', icon: '🎨', accent: '#ff6622' }
];

// Default music queue (SNX-licensed / royalty-free placeholder)
var DEFAULT_QUEUE = [
  { id: 'snx-001', title: 'Shadow Rise',    artist: 'SNX Studio', duration: 180 },
  { id: 'snx-002', title: 'Nexus Drift',    artist: 'SNX Studio', duration: 210 },
  { id: 'snx-003', title: 'Eclipse Pulse',  artist: 'SNX Studio', duration: 195 },
  { id: 'snx-004', title: 'Neon Horizon',   artist: 'SNX Studio', duration: 220 },
  { id: 'snx-005', title: 'Midnight Storm', artist: 'SNX Studio', duration: 165 }
];

// Event scenes
var EVENT_SCENES = [
  { id: 'starting-soon', name: 'Starting Soon', icon: '⏰', desc: 'Animated countdown', badge: '' },
  { id: 'going-live',    name: 'Going Live',    icon: '🔴', desc: 'WE ARE LIVE animation', badge: 'live' },
  { id: 'welcome',       name: 'Welcome',       icon: '👋', desc: 'Welcome to the Shadow Nexus', badge: '' },
  { id: 'new-follow',    name: 'New Follow',    icon: '❤️', desc: 'Follower notification', badge: '' },
  { id: 'gift-received', name: 'Gift Received', icon: '🎁', desc: 'Animated gift alert', badge: '' },
  { id: 'milestone',     name: 'Milestone',     icon: '🏆', desc: '100 viewers / 1K likes', badge: '' },
  { id: 'music-scene',   name: 'Music Scene',   icon: '🎵', desc: 'Visualizer + album art', badge: '' },
  { id: 'announcement',  name: 'Announcement',  icon: '📢', desc: 'Text overlay overlay', badge: '' },
  { id: 'break',         name: 'Break',         icon: '☕', desc: 'Be right back', badge: '' },
  { id: 'ending',        name: 'Ending',        icon: '🌅', desc: 'Thank you for watching', badge: '' }
];

// Scene elements for builder
var SCENE_ELEMENTS = [
  { id: 'camera',     name: 'Camera',     icon: '📷' },
  { id: 'text',       name: 'Text',       icon: '📝' },
  { id: 'image',      name: 'Image',      icon: '🖼️' },
  { id: 'video',      name: 'Video',      icon: '🎬' },
  { id: 'background', name: 'Background', icon: '🌌' },
  { id: 'music',      name: 'Music',      icon: '🎵' },
  { id: 'visualizer', name: 'Visualizer', icon: '📊' },
  { id: 'animation',  name: 'Animation',  icon: '✨' },
  { id: 'alert',      name: 'Alert',      icon: '🔔' },
  { id: 'chat',       name: 'Chat',       icon: '💬' },
  { id: 'countdown',  name: 'Countdown',  icon: '⏳' },
  { id: 'logo',       name: 'Logo',       icon: '🌑' }
];

/* ═══════════════════════════════════════════════════════
   1. STATE
═══════════════════════════════════════════════════════ */
var _state = {
  user:            null,
  userData:        null,
  currentSection:  'main',     // 'main' | 'livestudio' | 'cloudstream'
  currentMode:     'live',
  currentTheme:    THEMES[0],
  currentFilter:   CAMERA_FILTERS[0],  // Studio-only filter — never touches regular Live
  isLive:          false,               // Studio live session flag (studioLiveSessions)
  studioSessionId: null,               // Studio session ID — NOT a liveRooms ID
  isCamOn:         false,
  isMicOn:         false,
  cameraFacing:    'user',             // 'user' | 'environment'
  cameraStream:    null,
  audioContext:    null,
  analyser:        null,
  audioAnimId:     null,
  musicQueue:      [].concat(DEFAULT_QUEUE),
  musicIndex:      0,
  musicPlaying:    false,
  musicVolume:     0.8,
  currentScene:    null,
  scenePlaylist:   [],
  cloudStream:     null,       // Firestore cloudStreams document
  cloudStreamId:   null,
  cloudStatus:     'draft',    // draft|starting|active|recovering|stopping|stopped|failed
  handoffStep:     0,
  healthInterval:  null,
  visAnimId:       null,
  savedScenes:     [],
  effectsActive:   []
};

/* ───────────────────────────────────────────────────────
   CloudStream Playlist State
   Completely isolated from Regular Live music system.
   Uses studioPlaylists / studioCloudStreamMusic paths only.
   ─────────────────────────────────────────────────────── */
var _csMusic = {
  // Saved playlists (from Firestore studioPlaylists/{uid}/playlists/{id})
  playlists:       [],      // [{ id, name, trackIds[], createdAt }]
  selectedId:      null,    // currently selected playlist ID

  // Active queue (track objects resolved from cloudStreamTracks)
  queue:           [],      // [{ id, title, artist, url, duration }]
  queueIndex:      0,       // pointer into queue[]

  // Playback state (client-side preview while creator is present)
  playing:         false,
  audio:           null,    // HTMLAudioElement for local preview
  progressTimer:   null,

  // Server-side config pushed to worker
  shuffle:         false,
  repeat:          true,    // default: loop forever
  crossfade:       3,       // seconds (0 = disabled)
  volume:          80,      // 0-100

  // Now Playing (synced from worker health or Firestore)
  nowPlayingTitle: '',
  nowPlayingArtist:'',
  nextTitle:       '',
  nextArtist:      '',

  // Schedule entries [{ playlistId, startHour, startMin, days[] }]
  schedule:        [],

  // Firestore realtime unsub
  unsub:           null,
  musicSyncInterval: null
};

/* ═══════════════════════════════════════════════════════
   2. INIT — called when studio page becomes visible
═══════════════════════════════════════════════════════ */
window.snxStudioInit = function() {
  window._snxOnAuthReady(function() {
    _state.user     = window._snxCurrentUser || null;
    _state.userData = window._snxUserData || null;
    if (!_state.user) { _showStudioError('Please sign in to use 24-Hour Studio.'); return; }
    _loadStudioSettings();
    _checkActiveCloudStream();
    _renderStatusBar();
    // Always start at main landing — user explicitly chooses Live Studio or Cloud Stream
    _switchSection('main');
    // Always load the permanent queue — not gated on active stream
    // This ensures the queue persists across page refreshes for all users.
    _sqLoad();
  });
};

/* ═══════════════════════════════════════════════════════
   3A. TOP-LEVEL SECTION SWITCHING
       'main'        — landing page (two cards)
       'livestudio'  — Live Studio section (modes: live/filters/music/theme/effects/events)
       'cloudstream' — 24-Hour Cloud Stream section (CS tabs)
═══════════════════════════════════════════════════════ */
window.snxStudioSwitchSection = function(section) {
  _switchSection(section);
};

function _switchSection(section) {
  _state.currentSection = section;

  var sections = {
    main:        document.getElementById('snxSectionMain'),
    livestudio:  document.getElementById('snxSectionLiveStudio'),
    cloudstream: document.getElementById('snxSectionCloudStream')
  };

  Object.keys(sections).forEach(function(key) {
    if (sections[key]) sections[key].style.display = (key === section) ? '' : 'none';
  });

  // Update bottom nav active state
  document.querySelectorAll('.sbn-item').forEach(function(it) {
    var sbn = it.dataset.sbn || '';
    var isActive = false;
    if (section === 'main'        && sbn === 'home')         isActive = true;
    if (section === 'cloudstream' && sbn === 'cloud')        isActive = true;
    if (section === 'livestudio'  && sbn.indexOf('live-') === 0) isActive = (sbn === 'live-' + _state.currentMode) || (sbn === 'live-live' && _state.currentMode === 'live');
    it.classList.toggle('active', isActive);
  });

  // Section-specific init
  if (section === 'livestudio') {
    _switchMode(_state.currentMode || 'live');
    // Check if creator is live and show control room (deferred so DOM is visible)
    setTimeout(_crCheckLiveStatus, 80);
  }
  if (section === 'cloudstream') {
    _renderCloudStreamPanel();
    _renderCloudStatusBadge();
    setTimeout(snxStudioLoadDestinations, 60);
    if (!_csMusic.playlists.length) _csMusicLoadPlaylists();
    // Show playlist panel on entry
    var ppEl = document.getElementById('snxCSPlaylistPanel');
    if (ppEl) { ppEl.style.display = ''; _renderCSPlaylistPanel(); }
    // Show stop button if active
    var stopBtn = document.getElementById('snxCSStopBtn');
    if (stopBtn) stopBtn.style.display = (_state.cloudStatus === 'active' || _state.cloudStatus === 'recovering') ? '' : 'none';
    // Populate the CS music library list — always try to load tracks on section enter
    // so the library is available even on first visit (no active stream required).
    if (_music.tracks.length) {
      if (typeof _renderCSLibrary === 'function') { _renderCSLibrary(); }
    } else if (_state.user && window._snxFirestore) {
      _mlLoadTracks();
    }
    // Ensure the queue listener is active whenever the Cloud Stream section is entered
    // (not just when a stream is active) so the queue renders for all users at all times.
    if (!_sq.unsub) { _sqLoad(); }
    _sqRenderQueue();
  }
}

/* ═══════════════════════════════════════════════════════
   3B. CLOUD STREAM TAB SWITCHING
═══════════════════════════════════════════════════════ */
window.snxCSSwitchTab = function(tab) {
  // Update tab bar active state
  document.querySelectorAll('.snx-cs-tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.cstab === tab);
  });
  // Show/hide tab panels
  document.querySelectorAll('.snx-cs-tab-panel').forEach(function(p) {
    p.classList.toggle('active', p.dataset.cstab === tab);
  });
  // Tab-specific init
  if (tab === 'dashboard')   _renderCloudStreamPanel();
  if (tab === 'destinations') setTimeout(snxStudioLoadDestinations, 60);
  if (tab === 'playback') {
    if (!_csMusic.playlists.length) _csMusicLoadPlaylists();
    var ppEl = document.getElementById('snxCSPlaylistPanel');
    if (ppEl) { ppEl.style.display = ''; _renderCSPlaylistPanel(); }
    // Ensure CS library tracks are loaded and rendered
    if (_music.tracks.length) {
      _renderCSLibrary();
    } else if (_state.user && window._snxFirestore) {
      _mlLoadTracks();
    }
  }
  if (tab === 'analytics')   _renderCSAnalytics();
  if (tab === 'sources')     _renderCSEventScenes();
};

/* ═══════════════════════════════════════════════════════
   3C. LIVE STUDIO MODE SWITCHING
═══════════════════════════════════════════════════════ */
window.snxStudioSwitchMode = function(mode) {
  _switchMode(mode);
};

function _switchMode(mode) {
  // Only Live Studio modes — cloudstream mode is now a separate section
  var liveModes = ['live', 'filters', 'music', 'theme', 'effects', 'events'];
  if (!liveModes.includes(mode)) return;
  _state.currentMode = mode;

  // Update mode tabs (only within Live Studio section)
  document.querySelectorAll('.snx-mode-tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.mode === mode);
  });

  // Show/hide mode panels (only within Live Studio section)
  document.querySelectorAll('.snx-mode-panel').forEach(function(p) {
    p.classList.toggle('active', p.dataset.mode === mode);
  });

  // Update bottom nav active state for live studio items
  document.querySelectorAll('.sbn-item').forEach(function(it) {
    var sbn = it.dataset.sbn || '';
    it.classList.toggle('active', sbn === 'live-' + mode);
  });

  // Mode-specific init
  if (mode === 'live')    _renderLivePreview();
  if (mode === 'filters') _renderFiltersPanel();
  if (mode === 'music')   _initMusicMode();
  if (mode === 'theme')   _renderThemes();
  if (mode === 'effects') _renderEffects();
  if (mode === 'events')  _renderEventScenes();
}

/* ── CS Analytics panel renderer ── */
function _renderCSAnalytics() {
  var cs = _state.cloudStream || {};
  var uptime = cs.startedAt ? Math.floor((Date.now() - cs.startedAt) / 60000) : 0;
  var viewers  = document.getElementById('snxCSAnaViewers');
  var uptimeEl = document.getElementById('snxCSAnaUptime');
  var bitrateEl= document.getElementById('snxCSAnaBitrate');
  var fpsEl    = document.getElementById('snxCSAnaFps');
  if (viewers)   viewers.textContent  = cs.viewerCount || '—';
  if (uptimeEl)  uptimeEl.textContent = _state.cloudStatus === 'active' ? uptime + 'm' : '—';
  if (bitrateEl) bitrateEl.textContent= cs.bitrate ? cs.bitrate + 'k' : '—';
  if (fpsEl)     fpsEl.textContent    = cs.fps || '—';
}

/* ── CS Event Scenes (in Sources tab) ── */
function _renderCSEventScenes() {
  var el = document.getElementById('snxCSEventSceneList');
  if (!el) return;
  el.innerHTML = EVENT_SCENES.map(function(s) {
    var active = _state.currentScene === s.id;
    return '<div class="snx-scene-item' + (active ? ' active' : '') + '" onclick="snxStudioActivateScene(\'' + s.id + '\')">' +
      '<span class="snx-scene-icon">' + s.icon + '</span>' +
      '<div class="snx-scene-info">' +
        '<div class="snx-scene-name">' + _esc(s.name) + '</div>' +
        '<div class="snx-scene-desc">' + _esc(s.desc) + '</div>' +
      '</div>' +
      (s.badge ? '<span class="snx-scene-badge ' + _esc(s.badge) + '">' + _esc(s.badge.toUpperCase()) + '</span>' : '') +
    '</div>';
  }).join('');
}

/* ── CS add to playlist (Sources tab) ── */
window.snxCSStudioAddToPlaylist = function() {
  var nameEl = document.getElementById('snxCSPlaylistSceneName');
  var durEl  = document.getElementById('snxCSPlaylistDuration');
  var name = nameEl ? nameEl.value.trim() : '';
  var dur  = parseInt(durEl ? durEl.value : '20', 10) || 20;
  if (!name) { _toastError('Enter a scene name.'); return; }
  _state.scenePlaylist.push({ name: name, duration: dur });
  if (nameEl) nameEl.value = '';
  if (durEl)  durEl.value  = '';
  _renderCSScenePlaylistList();
  _saveStudioSettings();
};

function _renderCSScenePlaylistList() {
  var el = document.getElementById('snxCSScenePlaylistList');
  if (!el) return;
  if (!_state.scenePlaylist.length) {
    el.innerHTML = '<div style="color:#3a5a7a;font-size:12px;padding:8px 0;">No scenes added yet.</div>';
    return;
  }
  el.innerHTML = _state.scenePlaylist.map(function(item, i) {
    return '<div class="snx-playlist-item">' +
      '<span class="snx-playlist-drag">⠿</span>' +
      '<span class="snx-playlist-num">' + (i+1) + '</span>' +
      '<div class="snx-playlist-info">' +
        '<div class="snx-playlist-name">' + _esc(item.name) + '</div>' +
        '<div class="snx-playlist-duration">' + item.duration + ' min</div>' +
      '</div>' +
      '<span class="snx-playlist-del" onclick="snxCSStudioRemovePlaylistItem(' + i + ')">×</span>' +
    '</div>';
  }).join('');
}

window.snxCSStudioRemovePlaylistItem = function(idx) {
  _state.scenePlaylist.splice(idx, 1);
  _renderCSScenePlaylistList();
  _saveStudioSettings();
};

/* ═══════════════════════════════════════════════════════
   4. STATUS BAR
═══════════════════════════════════════════════════════ */
function _renderStatusBar() {
  var el = document.getElementById('snxStudioStatusBar');
  if (!el) return;

  var statusDot  = _state.isLive ? 'live' : 'off';
  var cloudDot   = _state.cloudStatus === 'active' ? 'cloud' :
                   _state.cloudStatus === 'recovering' ? 'warn' :
                   _state.cloudStatus === 'failed' ? 'off' : 'off';
  var micDot     = _state.isMicOn ? 'ok' : 'off';
  var viewerCount = _state.cloudStream && _state.cloudStream.viewerCount
                    ? _state.cloudStream.viewerCount : 0;

  el.innerHTML = [
    _pill(statusDot, 'STATUS', _state.isLive ? 'STUDIO LIVE' : 'OFFLINE'),
    _pill(cloudDot,  'CLOUD',  _state.cloudStatus.toUpperCase()),
    _pill(micDot,    'MIC',    _state.isMicOn ? 'ON' : 'OFF'),
    _pill('off',     '👁',      viewerCount + ' viewers'),
    _pill('off',     'THEME',  _state.currentTheme.name),
    _pill('off',     'FILTER', _state.currentFilter ? _state.currentFilter.name : 'Normal'),
    _pill('off',     'SCENE',  _state.currentScene ? _state.currentScene : '—')
  ].join('');
}

function _pill(dot, label, val) {
  return '<div class="snx-sstatus-pill">' +
    '<span class="snx-sstatus-dot ' + dot + '"></span>' +
    '<span>' + label + ': <strong>' + _esc(val) + '</strong></span>' +
    '</div>';
}

/* ═══════════════════════════════════════════════════════
   5. LIVE STUDIO MODE — Studio camera, filters, controls.
      No connection to regular Live system.
═══════════════════════════════════════════════════════ */
window.snxStudioToggleCam = function() {
  if (_state.isCamOn) _stopCamera(); else _startCamera();
};

window.snxStudioToggleMic = function() {
  if (!_state.cameraStream) {
    _toastError('Start your camera first. Microphone requires camera to be active.');
    return;
  }
  var audioTracks = _state.cameraStream.getAudioTracks();
  if (!audioTracks.length) {
    _toastError('Microphone is not active. No audio track found.');
    return;
  }
  // Check that the track is actually live before toggling
  var at = audioTracks[0];
  if (at.readyState !== 'live') {
    _toastError('Microphone is not active (track state: ' + at.readyState + ').');
    return;
  }
  _state.isMicOn = !_state.isMicOn;
  audioTracks.forEach(function(t) { t.enabled = _state.isMicOn; });
  var btn = document.getElementById('snxMicBtn');
  if (btn) btn.textContent = _state.isMicOn ? '🎙️ Mic On' : '🎙️ Mic Off';
  _renderStatusBar();
  _renderLiveMediaDiag();
};

/* Flip between front and rear camera */
window.snxStudioFlipCamera = function() {
  _state.cameraFacing = (_state.cameraFacing === 'user') ? 'environment' : 'user';
  if (_state.isCamOn) {
    // Restart camera with new facing mode
    _stopCamera();
    setTimeout(_startCamera, 200);
  }
  var btn = document.getElementById('snxFlipCamBtn');
  if (btn) btn.textContent = _state.cameraFacing === 'user' ? '🔄 Front Cam' : '🔄 Rear Cam';
};

function _startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    _showCamPermissionError('Camera is not available on this device or browser.');
    return;
  }
  var constraints = {
    video: { facingMode: _state.cameraFacing },
    audio: true
  };
  navigator.mediaDevices.getUserMedia(constraints)
    .then(function(stream) {
      _state.cameraStream = stream;

      // ── Verify video track is actually live ──
      var videoTracks = stream.getVideoTracks();
      if (!videoTracks.length || videoTracks[0].readyState !== 'live' || !videoTracks[0].enabled) {
        _toastError('Camera is not active. Video track is not live.');
        _showCamPermissionError('Camera is not active. Please check your camera and try again.');
        stream.getTracks().forEach(function(t) { t.stop(); });
        _state.cameraStream = null;
        _renderLiveMediaDiag();
        return;
      }

      // ── Verify audio track is live ──
      var audioTracks = stream.getAudioTracks();
      var hasMic = audioTracks.length > 0 &&
                   audioTracks[0].readyState === 'live' &&
                   audioTracks[0].enabled;
      _state.isCamOn = true;
      _state.isMicOn = hasMic;

      // ── Attach to preview video element ──
      var video = document.getElementById('snxCamPreview');
      if (video) {
        // Ensure required attributes are set (belt-and-suspenders for mobile)
        video.autoplay   = true;
        video.muted      = true;
        video.playsInline = true;
        video.srcObject  = stream;
        var playPromise = video.play();
        if (playPromise && typeof playPromise.then === 'function') {
          playPromise.catch(function(e) {
            // Autoplay blocked — user gesture required on some browsers
            console.warn('[SNX Studio] video.play() blocked:', e.message);
          });
        }
        // Re-apply current filter so the preview shows the chosen filter immediately
        _applyFilterToPreview(_state.currentFilter);
      }

      var off = document.getElementById('snxCamOff');
      if (off) off.style.display = 'none';

      // Clear any permission error overlay
      var permErr = document.getElementById('snxCamPermError');
      if (permErr) permErr.style.display = 'none';

      var btn = document.getElementById('snxCamBtn');
      if (btn) btn.textContent = '📷 Cam On';

      var micBtn = document.getElementById('snxMicBtn');
      if (micBtn) micBtn.textContent = hasMic ? '🎙️ Mic On' : '🎙️ Mic Off';

      if (!hasMic) {
        _toastError('Microphone is not active. Check microphone permissions.');
      }

      _startAudioMeter(stream);
      _renderStatusBar();
      _renderLiveMediaDiag();
    })
    .catch(function(err) {
      _state.isCamOn = false;
      _state.isMicOn = false;
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        // Check what was denied — camera or mic
        navigator.mediaDevices.getUserMedia({ video: { facingMode: _state.cameraFacing }, audio: false })
          .then(function(videoOnlyStream) {
            // Camera works but mic was denied
            videoOnlyStream.getTracks().forEach(function(t) { t.stop(); });
            _showMicPermissionError('Microphone permission is required for Live Studio.');
          })
          .catch(function() {
            // Camera also denied
            _showCamPermissionError('Camera permission is required for Live Studio.');
          });
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        _showCamPermissionError('No camera or microphone found on this device.');
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        _showCamPermissionError('Camera or microphone is already in use by another application.');
      } else {
        _showCamPermissionError('Could not access camera: ' + err.message);
      }
      _renderLiveMediaDiag();
    });
}

function _showCamPermissionError(msg) {
  _toastError(msg);
  var permErr = document.getElementById('snxCamPermError');
  if (!permErr) return;
  permErr.style.display = '';
  permErr.innerHTML =
    '<div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:16px;">' +
      '<div style="font-size:28px;">📷</div>' +
      '<div style="font-size:13px;font-weight:700;color:#ff3355;text-align:center;">' + _esc(msg) + '</div>' +
      '<button class="snx-toggle-btn" style="background:rgba(255,51,85,0.15);border-color:#ff3355;color:#ff3355;" ' +
        'onclick="snxStudioToggleCam()">ENABLE CAMERA</button>' +
    '</div>';
  var off = document.getElementById('snxCamOff');
  if (off) off.style.display = 'none';
}

function _showMicPermissionError(msg) {
  _toastError(msg);
  var permErr = document.getElementById('snxCamPermError');
  if (!permErr) return;
  permErr.style.display = '';
  permErr.innerHTML =
    '<div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:16px;">' +
      '<div style="font-size:28px;">🎙️</div>' +
      '<div style="font-size:13px;font-weight:700;color:#ffaa00;text-align:center;">' + _esc(msg) + '</div>' +
      '<button class="snx-toggle-btn" style="background:rgba(255,170,0,0.15);border-color:#ffaa00;color:#ffaa00;" ' +
        'onclick="snxStudioToggleCam()">ENABLE MICROPHONE</button>' +
    '</div>';
}

function _stopCamera() {
  if (_state.cameraStream) {
    _state.cameraStream.getTracks().forEach(function(t) { t.stop(); });
    _state.cameraStream = null;
  }
  _state.isCamOn = false;
  _state.isMicOn = false;
  var video = document.getElementById('snxCamPreview');
  if (video) { video.srcObject = null; }
  var off = document.getElementById('snxCamOff');
  if (off) off.style.display = '';
  // Hide any permission error overlay when camera is stopped
  var permErr = document.getElementById('snxCamPermError');
  if (permErr) permErr.style.display = 'none';
  var btn = document.getElementById('snxCamBtn');
  if (btn) btn.textContent = '📷 Start Cam';
  var micBtn = document.getElementById('snxMicBtn');
  if (micBtn) micBtn.textContent = '🎙️ Mic Off';
  _stopAudioMeter();
  _renderStatusBar();
  _renderLiveMediaDiag();
}

function _startAudioMeter(stream) {
  try {
    _state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    _state.analyser = _state.audioContext.createAnalyser();
    _state.analyser.fftSize = 64;
    var src = _state.audioContext.createMediaStreamSource(stream);
    src.connect(_state.analyser);
    _animAudioMeter();
  } catch(e) { /* not critical */ }
}

function _stopAudioMeter() {
  if (_state.audioAnimId) { cancelAnimationFrame(_state.audioAnimId); _state.audioAnimId = null; }
  if (_state.audioContext) { try { _state.audioContext.close(); } catch(e){} _state.audioContext = null; }
}

function _animAudioMeter() {
  var bars = document.querySelectorAll('#snxAudioMeter .snx-audio-bar');
  if (!bars.length || !_state.analyser) return;
  var data = new Uint8Array(_state.analyser.frequencyBinCount);
  (function tick() {
    _state.audioAnimId = requestAnimationFrame(tick);
    _state.analyser.getByteFrequencyData(data);
    bars.forEach(function(bar, i) {
      var val = data[i] || 0;
      var h = Math.max(2, Math.round((val / 255) * 24));
      bar.style.height = h + 'px';
      bar.className = 'snx-audio-bar' + (val > 200 ? ' peak' : val > 50 ? ' active' : '');
    });
  })();
}

/* ═══════════════════════════════════════════════════════
   5a. STUDIO FILTER ENGINE
   Applies CSS filters directly to the Studio camera preview <video>.
   No dependency on Regular Live. No call to goLiveOrWatch().
═══════════════════════════════════════════════════════ */

/**
 * Apply a CAMERA_FILTERS entry to the studio preview video.
 * This is the only place the video filter CSS is set.
 */
function _applyFilterToPreview(filter) {
  var video = document.getElementById('snxCamPreview');
  if (!video) return;
  video.style.filter = (filter && filter.css) ? filter.css : 'none';
  // Also tint the preview wrapper border to match the filter accent (cosmetic)
  var wrap = document.getElementById('snxPreviewWrap');
  if (wrap) {
    wrap.setAttribute('data-filter', filter ? filter.id : 'none');
  }
}

/**
 * Render the Filters panel — called when switching to 'filters' mode.
 * Shows filter grid with live camera preview so changes are visible immediately.
 */
function _renderFiltersPanel() {
  var el = document.getElementById('snxFiltersPanel');
  if (!el) return;
  el.innerHTML =
    '<div class="snx-studio-card">' +
      '<div class="snx-studio-card-title">🎨 Camera Filters</div>' +
      '<p style="font-size:12px;color:#4a7a9a;margin:0 0 12px;">Tap a filter to instantly change the camera preview. The selected filter is baked into the Studio output.</p>' +
      '<div class="snx-filter-grid" id="snxFilterGrid">' +
        CAMERA_FILTERS.map(function(f) {
          var active = _state.currentFilter.id === f.id;
          return '<div class="snx-filter-btn' + (active ? ' active' : '') + '" ' +
            'onclick="snxStudioSelectFilter(\'' + f.id + '\')" ' +
            'data-filter-id="' + f.id + '">' +
            '<span class="snx-filter-icon">' + f.icon + '</span>' +
            '<span class="snx-filter-name">' + _esc(f.name) + '</span>' +
            (active ? '<span class="snx-filter-check">✓</span>' : '') +
          '</div>';
        }).join('') +
      '</div>' +
    '</div>' +
    // Live preview mini within the filters panel
    '<div class="snx-studio-card">' +
      '<div class="snx-studio-card-title">📷 Filter Preview</div>' +
      '<div class="snx-notice info" style="margin:0 0 8px;">' +
        'Start your camera in the <strong>Live Studio</strong> tab to see filters live. ' +
        'Selected filter: <strong id="snxFilterCurrentName">' + _esc(_state.currentFilter.name) + '</strong>' +
      '</div>' +
      '<div class="snx-preview-wrap" style="height:200px;">' +
        '<video id="snxFilterPreviewVideo" autoplay muted playsinline ' +
          'style="width:100%;height:100%;object-fit:cover;border-radius:8px;filter:' + _esc(_state.currentFilter.css || 'none') + '" ' +
        '></video>' +
        '<div id="snxFilterPreviewOff" class="snx-preview-off" ' +
          'style="' + (_state.isCamOn ? 'display:none;' : '') + '">' +
          '<span class="cam-off-icon">🎨</span>Start camera to preview filters' +
        '</div>' +
      '</div>' +
    '</div>';

  // If camera is on, pipe stream into the filter preview video too
  _syncFilterPreviewStream();
}

function _syncFilterPreviewStream() {
  var fpv = document.getElementById('snxFilterPreviewVideo');
  if (!fpv) return;
  if (_state.cameraStream) {
    fpv.srcObject = _state.cameraStream;
    fpv.play();
    fpv.style.filter = (_state.currentFilter && _state.currentFilter.css) ? _state.currentFilter.css : 'none';
    var off = document.getElementById('snxFilterPreviewOff');
    if (off) off.style.display = 'none';
  } else {
    fpv.srcObject = null;
    fpv.style.filter = 'none';
  }
}

/**
 * Select a Studio filter. Updates the camera preview, the filter preview,
 * the status bar, and saves the preference.
 * NEVER touches goLiveOrWatch or any Regular Live component.
 */
window.snxStudioSelectFilter = function(filterId) {
  var filter = CAMERA_FILTERS.find(function(f) { return f.id === filterId; });
  if (!filter) return;
  _state.currentFilter = filter;

  // Apply to the main Live Studio camera preview
  _applyFilterToPreview(filter);

  // Apply to the Filters panel preview video
  var fpv = document.getElementById('snxFilterPreviewVideo');
  if (fpv) fpv.style.filter = filter.css || 'none';

  // Update current filter label
  var label = document.getElementById('snxFilterCurrentName');
  if (label) label.textContent = filter.name;

  // Re-render the filter grid to show active state
  var grid = document.getElementById('snxFilterGrid');
  if (grid) {
    grid.querySelectorAll('.snx-filter-btn').forEach(function(btn) {
      var active = btn.getAttribute('data-filter-id') === filterId;
      btn.classList.toggle('active', active);
      // Update checkmark
      var existing = btn.querySelector('.snx-filter-check');
      if (active && !existing) {
        var chk = document.createElement('span');
        chk.className = 'snx-filter-check';
        chk.textContent = '✓';
        btn.appendChild(chk);
      } else if (!active && existing) {
        existing.remove();
      }
    });
  }

  _renderStatusBar();
  _saveStudioSettings();
  _toast('Filter: ' + filter.name);
};

/* ─────────────────────────────────────────────────────────
   Re-apply filter and re-attach camera stream whenever
   the Live Studio tab is activated. This is the fix for
   "camera preview blank after switching tabs".
   ───────────────────────────────────────────────────────── */
function _renderLivePreview() {
  // Re-attach camera stream to the preview video in case the DOM was
  // recreated or the srcObject was lost when switching modes.
  if (_state.isCamOn && _state.cameraStream) {
    var video = document.getElementById('snxCamPreview');
    if (video && video.srcObject !== _state.cameraStream) {
      video.autoplay    = true;
      video.muted       = true;
      video.playsInline = true;
      video.srcObject   = _state.cameraStream;
      var p = video.play();
      if (p && typeof p.then === 'function') { p.catch(function(){}); }
    }
    var off = document.getElementById('snxCamOff');
    if (off) off.style.display = 'none';
  }
  _applyFilterToPreview(_state.currentFilter);
  _renderLiveMediaDiag();
  // Check if creator is currently live — show Control Room if so
  _crCheckLiveStatus();
}

/**
 * Render the Live Studio media diagnostics panel.
 * Developer-only — shows the real state of camera, mic, video element,
 * and final stream. Never exposes secrets.
 */
function _renderLiveMediaDiag() {
  var el = document.getElementById('snxLiveMediaDiag');
  if (!el) return;

  var stream = _state.cameraStream;
  var video  = document.getElementById('snxCamPreview');

  // Camera state
  var camAvail  = stream ? 'AVAILABLE' : 'NOT STARTED';
  var camCls    = stream ? 'ok' : 'off';

  // Video track
  var videoTracks = stream ? stream.getVideoTracks() : [];
  var vt          = videoTracks[0] || null;
  var vtState     = vt ? vt.readyState : 'none';
  var vtEnabled   = vt ? vt.enabled : false;
  var vtOk        = vtState === 'live' && vtEnabled;
  var vtLabel     = vt ? (vtState.toUpperCase() + (vtEnabled ? '' : ' (disabled)')) : 'NO TRACK';
  var vtCls       = vtOk ? 'ok' : (vt ? 'warn' : 'off');

  // Microphone track
  var audioTracks = stream ? stream.getAudioTracks() : [];
  var at          = audioTracks[0] || null;
  var atState     = at ? at.readyState : 'none';
  var atEnabled   = at ? at.enabled : false;
  var atOk        = atState === 'live' && atEnabled;
  var atLabel     = at ? (atState.toUpperCase() + (atEnabled ? '' : ' (disabled)')) : 'NO TRACK';
  var atCls       = atOk ? 'ok' : (at ? 'warn' : 'off');

  // Video element state
  var vidPlaying  = video && !video.paused && !video.ended && video.readyState >= 2;
  var vidLabel    = video ? (vidPlaying ? 'PLAYING' : (video.paused ? 'PAUSED' : 'NOT PLAYING')) : 'ELEMENT MISSING';
  var vidCls      = vidPlaying ? 'ok' : 'warn';

  // Final outgoing stream check — what the WebRTC peers actually send
  var finalVidOk  = vtOk;
  var finalAudOk  = atOk;

  // Live engine status — Studio Live uses live.html (existing SNX live engine)
  var webrtcStatus = '→ live.html (existing SNX live engine)';
  var webrtcCls    = 'ok';

  var colorMap = { ok: '#00d4ff', warn: '#ffaa00', off: '#ff3355' };

  function _dRow(label, val, cls) {
    var c = colorMap[cls] || '#5a80a8';
    return '<div style="display:flex;justify-content:space-between;align-items:center;' +
      'padding:3px 0;border-bottom:1px solid rgba(0,174,239,0.07);">' +
      '<span style="font-size:11px;color:#4a7a9a;">' + _esc(label) + '</span>' +
      '<span style="font-size:11px;font-weight:700;color:' + c + ';">' + _esc(val) + '</span>' +
    '</div>';
  }

  el.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
      '<span style="font-size:12px;font-weight:700;color:#4a7a9a;">🔬 Media Diagnostics</span>' +
      '<button onclick="snxRefreshLiveMediaDiag()" style="padding:2px 8px;font-size:10px;border-radius:5px;' +
        'background:rgba(0,174,239,0.10);border:1px solid rgba(0,174,239,0.30);color:#00AEEF;cursor:pointer;">↺</button>' +
    '</div>' +
    _dRow('CAMERA',                 camAvail,       camCls) +
    _dRow('VIDEO TRACK',            vtLabel,        vtCls) +
    _dRow('MICROPHONE',             at ? 'AVAILABLE' : 'NOT ACTIVE', atOk ? 'ok' : (at ? 'warn' : 'off')) +
    _dRow('AUDIO TRACK',            atLabel,        atCls) +
    _dRow('VIDEO ELEMENT',          vidLabel,       vidCls) +
    _dRow('FINAL VIDEO (outgoing)', finalVidOk ? 'YES ✓' : 'NO ✗', finalVidOk ? 'ok' : 'off') +
    _dRow('FINAL AUDIO (outgoing)', finalAudOk ? 'YES ✓' : 'NO ✗', finalAudOk ? 'ok' : 'off') +
    _dRow('STUDIO LIVE ENGINE',     'live.html (SNX proven system)', 'ok') +
    _dRow('LIVE ENGINE STATUS',     webrtcStatus,   webrtcCls);
}

window.snxRefreshLiveMediaDiag = function() { _renderLiveMediaDiag(); };

/* ═══════════════════════════════════════════════════════
   5b-ENTRY. OPEN STUDIO & GO LIVE
   Called by the 🎨 OPEN STUDIO & GO LIVE button on the 24-Hour Studio page.
   1. Switches to the live mode panel (camera preview, controls, GO LIVE button).
   2. Automatically starts the camera so the creator sees the preview immediately.
   This is NOT CloudStream. Does NOT create a live session — that happens only
   when the creator explicitly presses 🔴 GO LIVE inside the Studio panel.
═══════════════════════════════════════════════════════ */
window.snxOpenStudioAndGoLive = function() {
  // Navigate to Live Studio section, then switch to live mode
  _switchSection('livestudio');
  _switchMode('live');

  // Auto-start camera if not already on so the creator sees their feed immediately
  if (!_state.isCamOn) {
    // Small delay to let the DOM panel become visible before getUserMedia
    setTimeout(_startCamera, 150);
  }
};

/* ═══════════════════════════════════════════════════════
   5b. STUDIO GO LIVE
   Loads the proven Shadow Nexus Social Live engine (live.html)
   into a hidden iframe with ?autostart=1 so it acquires the
   camera/mic and starts the live session immediately without
   navigating the creator away from 24-Hour Studio.

   The live session is detected by the Firestore watcher in
   _crCheckLiveStatus(), which shows the Live Control Room once
   liveRooms/{uid}.isLive === true.
═══════════════════════════════════════════════════════ */
window.snxStudioGoLive = function() {
  if (!_state.user) { _toastError('You must be signed in to go live.'); return; }

  // ── Feature gate ──
  try {
    var ctrl = JSON.parse(localStorage.getItem('founderFeatureControls') || '{}');
    if (ctrl.liveEnabled !== true) {
      _toastError('⛔ Live streaming is currently unavailable.');
      return;
    }
  } catch(_) {}

  // ── Pass title to live.html via localStorage ──
  var title = _getVal('snxLiveTitle') ||
    ('Studio Live — ' + ((_state.userData && (_state.userData.displayName || _state.userData.username)) || 'Creator'));
  try { localStorage.setItem('snx_studio_title', title); } catch(_) {}

  // ── Disable button to prevent double-click ──
  var goBtn = document.getElementById('snxGoLiveBtn');
  if (goBtn) { goBtn.disabled = true; goBtn.textContent = '⏳ Starting Live…'; }

  // ── Listen for messages from the live engine iframe ──
  window.removeEventListener('message', _snxLiveFrameMsg);
  window.addEventListener('message', _snxLiveFrameMsg);

  // ── Load live.html into the hidden iframe with autostart=1 ──
  var frame = document.getElementById('snxLiveEngineFrame');
  if (frame) {
    frame.src = 'live.html?autostart=1';

    // ── Once the live engine is up (~2 s), send any pre-loaded music queue ──
    // This covers the case where the creator selected a CS playlist before going live.
    setTimeout(function() {
      if (_csMusic.queue && _csMusic.queue.length) {
        _csMusicSyncQueueToFrame(false);
      }
    }, 2500);
  } else {
    // Fallback: navigate directly (old behaviour)
    window.location.href = 'live.html';
  }
};

/* Handle messages from the live engine iframe */
function _snxLiveFrameMsg(e) {
  if (e.origin && e.origin !== window.location.origin) return;
  var msg = e.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'snx_live_cam_error') {
    _toastError('⚠ Camera permission denied. Please allow camera & microphone access, then try again.');
    var goBtn = document.getElementById('snxGoLiveBtn');
    if (goBtn) { goBtn.disabled = false; goBtn.textContent = '🔴 GO LIVE'; }
    // Reset iframe
    var frame = document.getElementById('snxLiveEngineFrame');
    if (frame) { frame.src = ''; }
  }

  if (msg.type === 'snx_live_ended') {
    // Live engine has finished cleanup — reset the Studio UI
    _crHideControlRoom();
    var frame = document.getElementById('snxLiveEngineFrame');
    if (frame) { frame.src = ''; }
    var goBtn = document.getElementById('snxGoLiveBtn');
    if (goBtn) { goBtn.disabled = false; goBtn.innerHTML = '&#128308; GO LIVE'; }
    window.removeEventListener('message', _snxLiveFrameMsg);
    _toast('Live stream ended.');
  }

  if (msg.type === 'snx_live_auth_error') {
    // The live engine iframe failed to authenticate.  This must NOT sign the
    // user out of Studio.  Simply tear down the iframe and show a friendly
    // error — the Studio session is unaffected.
    var frame = document.getElementById('snxLiveEngineFrame');
    if (frame) { frame.src = ''; }
    var goBtn = document.getElementById('snxGoLiveBtn');
    if (goBtn) { goBtn.disabled = false; goBtn.innerHTML = '&#128308; GO LIVE'; }
    window.removeEventListener('message', _snxLiveFrameMsg);
    _toastError('⚠ Session error in Live Engine. Please try going live again.');
  }

  // ── Live mixer auto-advanced to next track (live.js → Studio dashboard) ──
  if (msg.type === 'snx_music_auto_advanced') {
    // Keep Studio dashboard in sync when the mixer auto-advances
    if (typeof msg.index === 'number' && msg.index >= 0 && msg.index < _csMusic.queue.length) {
      _csMusic.queueIndex = msg.index;
      _csMusicAdvanceNowPlaying();
      _renderCSPlaylistPanel();
      _patchNowPlayingButtons();
    }
  }
}


/* ═══════════════════════════════════════════════════════
   5c. LIVE CONTROL ROOM
   ─────────────────────────────────────────────────────
   When the creator is detected as actively live (Firestore
   liveRooms/{uid}.isLive === true), the pre-live setup panel
   is hidden and the Live Control Room is shown in its place.

   Data sources (all read from the SAME collections live.js writes):
     Chat    → Firestore liveRooms/{roomId}/liveMessages
     Gifts   → snxgWatchLiveGifts(roomId)  [snx-gifts.js]
     Viewers → Firestore liveRooms/{uid}.viewers  (mirrored by live.js)
     Likes   → Firestore liveRooms/{uid}.likes
     Status  → Firestore liveRooms/{uid}

   Camera / mic controls delegate to the existing studio camera
   state (_state.isCamOn, _state.isMicOn) — the same stream that
   runs in the preview is what live.js is broadcasting.

   End Live → navigates to live.html (which runs the full
   cleanup: RTDB teardown, Firestore writes, peer closures).
═══════════════════════════════════════════════════════ */

var _crState = {
  roomId:        null,    // active room ID (set when live detected)
  roomUid:       null,    // host uid (= _state.user.uid)
  startedAt:     0,       // ms timestamp when live started
  viewerCount:   0,
  likeCount:     0,
  giftCount:     0,
  streamTitle:   '',
  chatUnsub:     null,    // Firestore chat listener
  giftUnsub:     null,    // Firestore gift listener
  roomUnsub:     null,    // Firestore room status listener
  timerInterval: null,    // duration ticker
  sendingChat:   false
};

/* Check if the current user is live and show/hide the control room accordingly.
   Called on Live Studio init and whenever the section becomes visible. */
function _crCheckLiveStatus() {
  var user = _state.user;
  if (!user || !window._snxFirestore) return;
  var fs = window._snxFirestore;

  // Watch the liveRooms/{uid} Firestore doc — live.js writes here on startLive/endLive
  if (_crState.roomUnsub) { try { _crState.roomUnsub(); } catch(_) {} }

  _crState.roomUnsub = fs.onSnapshot(
    fs.doc(fs.db, 'liveRooms', user.uid),
    function(snap) {
      if (snap && snap.exists()) {
        var data = snap.data();
        if (data.isLive && data.roomId) {
          _crShowControlRoom(data);
        } else {
          _crHideControlRoom();
        }
      } else {
        _crHideControlRoom();
      }
    },
    function() { /* ignore — non-fatal */ }
  );
}

function _crShowControlRoom(roomData) {
  var setup = document.getElementById('snxLiveSetupPanel');
  var room  = document.getElementById('snxLiveControlRoom');
  if (!setup || !room) return;

  // Populate state
  _crState.roomId      = roomData.roomId || '';
  _crState.roomUid     = _state.user ? _state.user.uid : '';
  _crState.startedAt   = roomData.createdAt || Date.now();
  _crState.streamTitle = roomData.title || 'Shadow Nexus LIVE';

  setup.style.display = 'none';
  room.style.display  = '';

  // Pipe the studio camera stream into the control room video
  var crVideo = document.getElementById('snxCRVideo');
  if (crVideo && _state.cameraStream) {
    crVideo.srcObject = _state.cameraStream;
    crVideo.play().catch(function() {});
  }

  // Populate static info
  var titleEl   = document.getElementById('snxCRTitle');
  var creatorEl = document.getElementById('snxCRCreator');
  if (titleEl)   titleEl.textContent   = _crState.streamTitle;
  if (creatorEl) creatorEl.textContent = (_state.userData && (_state.userData.displayName || _state.userData.username)) || '';

  // Start duration timer
  _crStartTimer();

  // Update viewer/like counts from roomData
  _crUpdateCounts(roomData.viewers || 0, roomData.likes || 0);

  // Subscribe to chat
  _crSubscribeChat();

  // Subscribe to gifts (uses the existing snxgWatchLiveGifts from snx-gifts.js)
  if (_crState.giftUnsub) { try { _crState.giftUnsub(); } catch(_) {} }
  if (typeof window.snxgWatchLiveGifts === 'function' && _crState.roomId) {
    // We hook into the gift system by also watching ourselves
    _crState.giftUnsub = _crWatchGifts(_crState.roomId);
  }

  // Sync cam/mic button states
  _crSyncControls();

  // Subscribe to live viewer/like count updates from Firestore
  _crSubscribeRoomStats();
}

function _crHideControlRoom() {
  var setup = document.getElementById('snxLiveSetupPanel');
  var room  = document.getElementById('snxLiveControlRoom');
  if (setup) setup.style.display = '';
  if (room)  room.style.display  = 'none';
  _crTeardown();
}

function _crTeardown() {
  if (_crState.timerInterval) { clearInterval(_crState.timerInterval); _crState.timerInterval = null; }
  if (_crState.chatUnsub)     { try { _crState.chatUnsub(); } catch(_) {} _crState.chatUnsub = null; }
  if (_crState.giftUnsub)     { try { _crState.giftUnsub(); } catch(_) {} _crState.giftUnsub = null; }
  // Note: _crState.roomUnsub is NOT torn down here — it continues watching so we
  // can detect when the user goes live again after ending a session.
}

/* ── Duration timer ── */
function _crStartTimer() {
  if (_crState.timerInterval) clearInterval(_crState.timerInterval);
  _crState.timerInterval = setInterval(function() {
    var elapsed = Math.floor((Date.now() - _crState.startedAt) / 1000);
    var h = Math.floor(elapsed / 3600);
    var m = Math.floor((elapsed % 3600) / 60);
    var s = elapsed % 60;
    var fmt = (h > 0 ? _crPad(h) + ':' : '') + _crPad(m) + ':' + _crPad(s);
    var fmtLong = _crPad(h) + ':' + _crPad(m) + ':' + _crPad(s);
    var d1 = document.getElementById('snxCRDuration');
    var d2 = document.getElementById('snxCRDuration2');
    if (d1) d1.textContent = fmtLong;
    if (d2) d2.textContent = fmt;
  }, 1000);
}

function _crPad(n) { return n < 10 ? '0' + n : '' + n; }

/* ── Viewer / Like count update ── */
function _crUpdateCounts(viewers, likes) {
  _crState.viewerCount = viewers;
  _crState.likeCount   = likes;
  var v1 = document.getElementById('snxCRViewers');
  var v2 = document.getElementById('snxCRViewers2');
  var vb = document.getElementById('snxCRViewersBig');
  var l1 = document.getElementById('snxCRLikes');
  var l2 = document.getElementById('snxCRLikes2');
  if (v1) v1.textContent = viewers;
  if (v2) v2.textContent = viewers;
  if (vb) vb.textContent = viewers;
  if (l1) l1.textContent = likes;
  if (l2) l2.textContent = likes;
}

/* ── Subscribe to room stats (viewers + likes) from Firestore ── */
function _crSubscribeRoomStats() {
  if (!_state.user || !window._snxFirestore || !_crState.roomUid) return;
  // Room doc is watched by _crState.roomUnsub already — update counts inside it
  // The roomUnsub snapshot already calls _crShowControlRoom with fresh data,
  // but that only fires on doc changes. For more frequent updates we also patch
  // the viewer count from the incoming snapshot below.
  // (The main roomUnsub above already covers this — no separate sub needed.)
}

/* ── Chat subscription (mirrors _subscribeChat in live.js) ── */
function _crSubscribeChat() {
  if (!_crState.roomId || !window._snxFirestore) return;
  if (_crState.chatUnsub) { try { _crState.chatUnsub(); } catch(_) {} }
  var fs = window._snxFirestore;

  var q = fs.query(
    fs.collection(fs.db, 'liveRooms', _crState.roomId, 'liveMessages'),
    fs.orderBy('createdAt', 'asc'),
    fs.limit(80)
  );

  _crState.chatUnsub = fs.onSnapshot(q, function(snap) {
    var frag = document.createDocumentFragment();
    var hasNew = false;
    snap.docChanges().forEach(function(ch) {
      if (ch.type === 'added') {
        var el = _crBuildChatMsg(ch.doc.data());
        if (el) { frag.appendChild(el); hasNew = true; }
      }
    });
    if (!hasNew) return;
    var cm = document.getElementById('snxCRChatMessages');
    if (!cm) return;
    var atBottom = cm.scrollHeight - cm.scrollTop - cm.clientHeight < 100;
    // Remove placeholder
    var empty = cm.querySelector('.snx-cr-chat-empty');
    if (empty) empty.remove();
    cm.appendChild(frag);
    while (cm.children.length > 70) cm.removeChild(cm.firstChild);
    if (atBottom) cm.scrollTop = cm.scrollHeight;
  }, function() {});
}

function _crBuildChatMsg(data) {
  var isSystem = data.type === 'system';
  var el = document.createElement('div');
  el.className = 'snx-cr-chat-msg' + (isSystem ? ' snx-cr-chat-system' : '');
  if (isSystem) {
    el.textContent = data.text || '';
  } else {
    var author = document.createElement('span');
    author.className = 'snx-cr-chat-author' + (data.userId === _crState.roomUid ? ' is-host' : '');
    author.textContent = (data.userName || 'Guest') + ':';
    var text = document.createElement('span');
    text.className = 'snx-cr-chat-text';
    text.textContent = ' ' + (data.text || '');
    el.appendChild(author);
    el.appendChild(text);
  }
  return el;
}

/* ── Gift watcher (separate from snxgWatchLiveGifts so we can update the panel) ── */
function _crWatchGifts(roomId) {
  if (!window._snxFirestore) return null;
  var fs = window._snxFirestore;
  var initialized = false;

  var q = fs.query(
    fs.collection(fs.db, 'giftTransactions'),
    fs.where('postId', '==', roomId),
    fs.where('isLive', '==', true),
    fs.orderBy('createdAt', 'desc'),
    fs.limit(30)
  );

  return fs.onSnapshot(q, function(snap) {
    if (!initialized) {
      // On first snapshot, render the existing gifts history (up to 30)
      initialized = true;
      var items = [];
      snap.forEach(function(doc) { items.push(doc.data()); });
      items.reverse(); // oldest first
      items.forEach(function(g) { _crAddGiftToPanel(g, false); });
      return;
    }
    // Subsequent changes — only new additions
    snap.docChanges().forEach(function(ch) {
      if (ch.type !== 'added') return;
      var g = ch.doc.data();
      _crAddGiftToPanel(g, true);
      // Also trigger the existing gift animation overlay from snx-gifts.js
      if (typeof window.snxgShowLiveGiftToast === 'function') {
        window.snxgShowLiveGiftToast(g.senderName || 'Someone', g.giftId, g.giftName, g.giftArt);
      }
    });
  }, function() {});
}

function _crAddGiftToPanel(giftData, isNew) {
  var listEl = document.getElementById('snxCRGiftList');
  if (!listEl) return;

  // Remove empty placeholder
  var empty = listEl.querySelector('.snx-cr-gift-empty');
  if (empty) empty.remove();

  // Increment count
  _crState.giftCount++;
  var totalEl = document.getElementById('snxCRGiftTotal');
  if (totalEl) totalEl.textContent = _crState.giftCount;

  // Build gift row
  var item = document.createElement('div');
  item.className = 'snx-cr-gift-item';
  var art = giftData.giftArt || '&#127873;';
  var name = _crEsc(giftData.giftName || giftData.giftId || 'Gift');
  var sender = _crEsc(giftData.senderName || 'Someone');
  var coins = giftData.coins ? ('+' + giftData.coins + ' &#9679;') : '';
  item.innerHTML =
    '<span class="snx-cr-gift-art">' + art + '</span>' +
    '<div class="snx-cr-gift-info">' +
      '<div class="snx-cr-gift-sender">' + sender + '</div>' +
      '<div class="snx-cr-gift-name">' + name + '</div>' +
    '</div>' +
    '<span class="snx-cr-gift-coins">' + coins + '</span>';

  if (isNew) {
    // New gifts go to top
    listEl.insertBefore(item, listEl.firstChild);
  } else {
    listEl.appendChild(item);
  }

  // Keep list to 30 items
  while (listEl.children.length > 30) listEl.removeChild(listEl.lastChild);
}

/* ── Sync camera/mic button states in the control room ── */
function _crSyncControls() {
  var camBtn   = document.getElementById('snxCRCamToggle');
  var micBtn   = document.getElementById('snxCRMicToggle');
  var camLabel = document.getElementById('snxCRCamLabel');
  var micLabel = document.getElementById('snxCRMicLabel');
  var camOff   = document.getElementById('snxCRCamOff');

  if (camBtn)   camBtn.classList.toggle('active', !_state.isCamOn);
  if (micBtn)   micBtn.classList.toggle('active', !_state.isMicOn);
  if (camLabel) camLabel.textContent = _state.isCamOn ? 'Cam On' : 'Cam Off';
  if (micLabel) micLabel.textContent = _state.isMicOn ? 'Mic On' : 'Mic Off';
  if (camOff)   camOff.style.display = _state.isCamOn ? 'none' : '';
}

/* ── Helper: send a message to the live engine iframe ── */
function _crPostToFrame(msg) {
  var frame = document.getElementById('snxLiveEngineFrame');
  if (frame && frame.contentWindow) {
    try { frame.contentWindow.postMessage(msg, window.location.origin); } catch(_) {}
  }
}

/**
 * Post a Cloud Stream music command to the live engine iframe.
 * This causes live.js to route the command to the Web Audio mixer
 * so the mixed audio (mic + music) enters the outgoing WebRTC stream.
 */
function _crPostMusicToFrame(msg) {
  // Only post when the live engine iframe is active (Go Live was pressed)
  var frame = document.getElementById('snxLiveEngineFrame');
  if (!frame || !frame.contentWindow || !frame.src) return;
  try { frame.contentWindow.postMessage(msg, window.location.origin); } catch(_) {}
}

/**
 * Send the full music queue to the live iframe so it can be loaded
 * into the mixer. Called once when the creator first selects a playlist
 * and whenever the queue changes while live.
 */
function _csMusicSyncQueueToFrame(autoplay) {
  _crPostMusicToFrame({
    type:     'snx_music_set_queue',
    queue:    _csMusic.queue.map(function(t) {
      return { id: t.id || '', title: t.title || '', artist: t.artist || '', url: t.url || '', duration: t.duration || 0 };
    }),
    index:    _csMusic.queueIndex,
    autoplay: !!autoplay
  });
}

/* ── Control Room button handlers ── */
window.snxCRToggleCam = function() {
  // Signal the live engine iframe to toggle its camera track
  _crPostToFrame({ type: 'snx_toggle_cam' });
  // Also update the Studio-side camera state so the Control Room button reflects reality
  if (_state.isCamOn) {
    _stopCamera();
  } else {
    _startCamera();
  }
  setTimeout(function() {
    var crVideo = document.getElementById('snxCRVideo');
    if (crVideo && _state.cameraStream) {
      crVideo.srcObject = _state.cameraStream;
      crVideo.play().catch(function() {});
    }
    _crSyncControls();
  }, 300);
};

window.snxCRToggleMic = function() {
  // Signal the live engine iframe to toggle its mic track
  _crPostToFrame({ type: 'snx_toggle_mic' });
  // Also update the Studio-side mic state
  window.snxStudioToggleMic();
  setTimeout(_crSyncControls, 100);
};

window.snxCRFlipCamera = function() {
  // Signal the live engine iframe to flip camera
  _crPostToFrame({ type: 'snx_flip_cam' });
  window.snxStudioFlipCamera();
  setTimeout(function() {
    var crVideo = document.getElementById('snxCRVideo');
    if (crVideo && _state.cameraStream) {
      crVideo.srcObject = _state.cameraStream;
      crVideo.play().catch(function() {});
    }
  }, 600);
};

/* ── Send chat from the Control Room ── */
window.snxCRSendChat = function() {
  if (_crState.sendingChat) return;
  var input = document.getElementById('snxCRChatInput');
  var text = input ? input.value.trim() : '';
  if (!text || !_crState.roomId || !_state.user || !window._snxFirestore) return;
  if (text.length > 200) { _toast('Message too long (max 200 chars)'); return; }

  _crState.sendingChat = true;
  var fs = window._snxFirestore;
  var userData = _state.userData || {};
  fs.addDoc(
    fs.collection(fs.db, 'liveRooms', _crState.roomId, 'liveMessages'),
    {
      userId:    _state.user.uid,
      userName:  userData.displayName || userData.username || 'Creator',
      userAvatar: userData.avatar || userData.profilePicture || '',
      text:      text,
      type:      'chat',
      createdAt: fs.serverTimestamp()
    }
  ).then(function() {
    if (input) input.value = '';
    _crState.sendingChat = false;
  }).catch(function(e) {
    _toastError('Could not send message.');
    _crState.sendingChat = false;
  });
};

/* ── End Live from the Control Room ── */
window.snxCREndLive = function() {
  if (!confirm('End your live stream?\n\nThis will stop the broadcast for all viewers.')) return;

  // Disable End Live button to prevent double-tap
  var endBtn = document.getElementById('snxCREndLiveBtn');
  if (endBtn) { endBtn.disabled = true; endBtn.textContent = '⏳ Ending…'; }

  // Signal the live engine iframe to end the live session cleanly.
  // The iframe's endLive() handles all RTDB / Firestore / WebRTC teardown,
  // then posts snx_live_ended back to us (handled in _snxLiveFrameMsg).
  _crPostToFrame({ type: 'snx_end_live' });

  // Stop local camera tracks to release the device immediately on the Studio side
  _stopCamera();
  // Tear down control room subscriptions (chat, gifts, timer)
  _crTeardown();

  // Safety fallback: if the iframe doesn't respond within 4 s, reset UI anyway
  setTimeout(function() {
    _crHideControlRoom();
    var frame = document.getElementById('snxLiveEngineFrame');
    if (frame) { frame.src = ''; }
    var goBtn = document.getElementById('snxGoLiveBtn');
    if (goBtn) { goBtn.disabled = false; goBtn.innerHTML = '&#128308; GO LIVE'; }
  }, 4000);
};

function _crEsc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ═══════════════════════════════════════════════════════
   6. MUSIC STUDIO
═══════════════════════════════════════════════════════ */
function _initMusicMode() {
  _renderMusicQueue();
  _startVisualizer();
}

function _renderMusicQueue() {
  var el = document.getElementById('snxMusicQueue');
  if (!el) return;
  if (!_state.musicQueue.length) {
    el.innerHTML = '<div class="snx-empty-state"><div class="empty-icon">🎵</div>No tracks in queue. Add your own music files.</div>';
    return;
  }
  el.innerHTML = _state.musicQueue.map(function(track, i) {
    var active = i === _state.musicIndex;
    return '<div class="snx-queue-item' + (active ? ' playing' : '') + '" onclick="snxStudioPlayTrack(' + i + ')">' +
      '<span class="snx-queue-num">' + (active && _state.musicPlaying ? '▶' : (i + 1)) + '</span>' +
      '<div class="snx-queue-info">' +
        '<div class="snx-queue-name">' + _esc(track.title) + '</div>' +
        '<div class="snx-queue-artist">' + _esc(track.artist) + '</div>' +
      '</div>' +
      '<span style="font-size:11px;color:#3a5a7a;">' + _formatDuration(track.duration) + '</span>' +
    '</div>';
  }).join('');
  _updateNowPlaying();
}

function _updateNowPlaying() {
  var track = _state.musicQueue[_state.musicIndex];
  if (!track) return;
  var nameEl   = document.getElementById('snxNowPlayingName');
  var artistEl = document.getElementById('snxNowPlayingArtist');
  if (nameEl)   nameEl.textContent   = track.title;
  if (artistEl) artistEl.textContent = track.artist;
}

window.snxStudioPlayPause = function() {
  _state.musicPlaying = !_state.musicPlaying;
  var btn = document.getElementById('snxMusicPlayBtn');
  if (btn) btn.textContent = _state.musicPlaying ? '⏸' : '▶';
  _renderMusicQueue();
};

window.snxStudioPlayTrack = function(index) {
  _state.musicIndex = index;
  _state.musicPlaying = true;
  var btn = document.getElementById('snxMusicPlayBtn');
  if (btn) btn.textContent = '⏸';
  _renderMusicQueue();
};

window.snxStudioNextTrack = function() {
  _state.musicIndex = (_state.musicIndex + 1) % _state.musicQueue.length;
  _renderMusicQueue();
};

window.snxStudioPrevTrack = function() {
  _state.musicIndex = (_state.musicIndex - 1 + _state.musicQueue.length) % _state.musicQueue.length;
  _renderMusicQueue();
};

window.snxStudioShuffleQueue = function() {
  var i = _state.musicQueue.length - 1;
  while (i > 0) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = _state.musicQueue[i]; _state.musicQueue[i] = _state.musicQueue[j]; _state.musicQueue[j] = tmp;
    i--;
  }
  _state.musicIndex = 0;
  _renderMusicQueue();
};

window.snxStudioSetVolume = function(val) {
  _state.musicVolume = parseFloat(val) / 100;
  var label = document.getElementById('snxMusicVolLabel');
  if (label) label.textContent = val + '%';
};

function _startVisualizer() {
  if (_state.visAnimId) { cancelAnimationFrame(_state.visAnimId); }
  var bars = document.querySelectorAll('#snxVisualizer .snx-vis-bar');
  if (!bars.length) return;
  (function tick() {
    _state.visAnimId = requestAnimationFrame(tick);
    bars.forEach(function(bar) {
      if (_state.musicPlaying) {
        var h = 3 + Math.random() * 42;
        bar.style.height = h + 'px';
      } else {
        bar.style.height = '3px';
      }
    });
  })();
}

/* ═══════════════════════════════════════════════════════
   7. THEME STUDIO
═══════════════════════════════════════════════════════ */
function _renderThemes() {
  var themeHtml = THEMES.map(function(theme) {
    var active = _state.currentTheme.id === theme.id;
    return '<div class="snx-theme-card' + (active ? ' active' : '') + '" onclick="snxStudioSelectTheme(\'' + theme.id + '\')">' +
      '<div class="snx-theme-preview" style="background:' + theme.bg + '">' +
        '<span style="font-size:20px;">' + theme.icon + '</span>' +
      '</div>' +
      '<div class="snx-theme-name">' + _esc(theme.name) + '</div>' +
      '<span class="snx-theme-check">&#10003;</span>' +
    '</div>';
  }).join('');
  var el = document.getElementById('snxThemeGrid');
  if (el) el.innerHTML = themeHtml;
  // Also populate the CS Settings theme grid if present
  var csEl = document.getElementById('snxCSThemeGrid');
  if (csEl) csEl.innerHTML = themeHtml;
}

window.snxStudioSelectTheme = function(id) {
  var theme = THEMES.find(function(t) { return t.id === id; });
  if (!theme) return;
  _state.currentTheme = theme;
  _renderThemes();
  _renderStatusBar();
  _saveStudioSettings();
  _toast('Theme: ' + theme.name);
};

/* ── Render the Cloud Stream music library into snxCSTrackLibraryList ── */
function _renderCSLibrary() {
  var listEl = document.getElementById('snxCSTrackLibraryList');
  if (!listEl) return;

  var q      = (document.getElementById('snxCSLibSearch') || {}).value || '';
  var tracks = _music.tracks.filter(function(t) {
    if (!q) return true;
    var ql = q.toLowerCase();
    return (t.title  || '').toLowerCase().includes(ql) ||
           (t.artist || '').toLowerCase().includes(ql) ||
           (t.album  || '').toLowerCase().includes(ql);
  });

  if (!tracks.length) {
    listEl.innerHTML = '<div class="snx-empty-state"><div class="empty-icon">&#127925;</div>No tracks yet.<br>Upload music in the Upload tab to build your library.</div>';
    return;
  }

  var activePl = _csMusic.playlists.find(function(p) { return p.id === _csMusic.selectedId; });

  listEl.innerHTML = tracks.map(function(t) {
    var isReady    = t.status === 'ready';
    var inPl       = activePl && activePl.trackIds && activePl.trackIds.indexOf(t.id) !== -1;
    var isCurrent  = _csMusic.queue.length && _csMusic.queue[_csMusic.queueIndex] &&
                     _csMusic.queue[_csMusic.queueIndex].id === t.id && _csMusic.playing;
    var durText    = (t.duration && t.duration > 0) ? _formatDuration(t.duration) : '—';
    var inSQ       = _sq.queue.some(function(q) { return q.id === t.id; });

    return '<div class="snx-track-item' + (isCurrent ? ' playing' : '') + '" data-tid="' + _esc(t.id) + '">' +
      '<div class="snx-track-artwork" style="font-size:16px;display:flex;align-items:center;justify-content:center;">&#127925;</div>' +
      '<div class="snx-track-info" style="cursor:pointer;" onclick="snxCSMusicPlayTrack(\'' + _esc(t.id) + '\');event.stopPropagation();" title="Click to play on Cloud Stream">' +
        '<div class="snx-track-title">' + _esc(t.title || 'Untitled') + '</div>' +
        '<div class="snx-track-artist">' + _esc(t.artist || 'Unknown Artist') + '</div>' +
      '</div>' +
      '<div class="snx-track-meta">' +
        '<span class="snx-track-dur">' + durText + '</span>' +
        '<span class="snx-track-status ' + (t.status || 'ready') + '">' + (t.status === 'uploading' ? '↑' : t.status || 'ready') + '</span>' +
        (isReady
          ? '<div class="snx-track-add-btn snx-sq-add-btn' + (inSQ ? ' snx-sq-in-queue' : '') + '" onclick="snxSQAddToQueue(\'' + _esc(t.id) + '\')" title="' + (inSQ ? 'In queue' : 'Add to queue') + '">' +
              (inSQ ? '&#10003;' : '&#9656;') + '</div>'
          : '') +
        (isReady && activePl
          ? '<div class="snx-track-add-btn" onclick="snxCSMusicAddSingleTrack(\'' + _esc(activePl.id) + '\',\'' + _esc(t.id) + '\')" title="' + (inPl ? 'In playlist' : 'Add to playlist') + '" style="' + (inPl ? 'color:#39ff14;border-color:rgba(57,255,20,0.4);' : '') + '">' +
              (inPl ? '&#10003;' : '+') + '</div>'
          : '') +
      '</div>' +
    '</div>';
  }).join('');
}

window.snxCSLibSearch = function() { _renderCSLibrary(); };

/* ── Add a single track to an active CS playlist ── */
window.snxCSMusicAddSingleTrack = function(playlistId, trackId) {
  var pl = _csMusic.playlists.find(function(p) { return p.id === playlistId; });
  if (!pl) { _toastError('No playlist selected.'); return; }
  if (pl.trackIds.indexOf(trackId) !== -1) { _toast('Track already in playlist.'); return; }
  if (!_state.user || !window._snxFirestore) return;
  pl.trackIds.push(trackId);
  var fs  = window._snxFirestore;
  var uid = _state.user.uid;
  fs.updateDoc(fs.doc(fs.db, 'studioPlaylists', uid, 'playlists', playlistId), {
    trackIds: pl.trackIds
  }).then(function() {
    _toast('Track added to playlist.');
    _renderCSLibrary();
    _renderCSPlaylistPanel();
    // If stream is active, push updated queue
    if (_state.cloudStatus === 'active' && _state.cloudStreamId) {
      _csMusicResolveQueue(pl.trackIds, function(tracks) {
        _csMusic.queue = tracks;
        _csMusicPushToWorker();
        _csMusicPushToFirestore();
      });
    }
  }).catch(function(e) { _toastError('Could not add track: ' + e.message); });
};

/* ── Click a CS library track to make it the active cloud stream track ── */
window.snxCSMusicPlayTrack = function(trackId) {
  // If no active playlist, add to queue directly and play
  if (!_csMusic.selectedId) {
    // Find track in shared library
    var track = _music.tracks.find(function(t) { return t.id === trackId; });
    if (!track || track.status !== 'ready') { _toastError('Track is not ready.'); return; }
    if (!_csMusic.queue.some(function(q) { return q.id === trackId; })) {
      _csMusic.queue.push(track);
    }
    _csMusic.queueIndex = _csMusic.queue.findIndex(function(q) { return q.id === trackId; });
    _csMusicAdvanceNowPlaying();
    _csMusicStopLocalPreview();
    _csMusicStartLocalPreview();
    _renderCSPlaylistPanel();
    _patchNowPlayingButtons();
    if (_state.cloudStatus === 'active' && _state.cloudStreamId) {
      _csMusicPushToWorker();
      _csMusicPushToFirestore();
    }
    _toast('Playing: ' + (track.title || 'Untitled'));
    _renderCSLibrary();
    return;
  }

  // Has active playlist — ensure track is in it, then jump to it
  var pl = _csMusic.playlists.find(function(p) { return p.id === _csMusic.selectedId; });
  if (pl && pl.trackIds.indexOf(trackId) === -1) {
    // Add to playlist first, then play
    window.snxCSMusicAddSingleTrack(_csMusic.selectedId, trackId);
    // After add, set as playing
    _csMusicResolveQueue(pl.trackIds.concat([trackId]), function(tracks) {
      _csMusic.queue = tracks;
      _csMusic.queueIndex = tracks.findIndex(function(t) { return t.id === trackId; });
      if (_csMusic.queueIndex < 0) _csMusic.queueIndex = 0;
      _csMusicAdvanceNowPlaying();
      _csMusicStopLocalPreview();
      _csMusicStartLocalPreview();
      _renderCSPlaylistPanel();
      _patchNowPlayingButtons();
      if (_state.cloudStatus === 'active' && _state.cloudStreamId) {
        _csMusicPushToWorker();
        _csMusicPushToFirestore();
      }
      _renderCSLibrary();
    });
    return;
  }

  // Track already in queue — jump to it
  var idx = _csMusic.queue.findIndex(function(t) { return t.id === trackId; });
  if (idx < 0) {
    // Resolve again in case queue is stale
    if (pl) {
      _csMusicResolveQueue(pl.trackIds, function(tracks) {
        _csMusic.queue = tracks;
        var i = tracks.findIndex(function(t) { return t.id === trackId; });
        if (i < 0) return;
        _csMusic.queueIndex = i;
        _csMusicAdvanceNowPlaying();
        _csMusicStopLocalPreview();
        _csMusicStartLocalPreview();
        _renderCSPlaylistPanel();
        _patchNowPlayingButtons();
        if (_state.cloudStatus === 'active' && _state.cloudStreamId) {
          _csMusicPushToWorker();
          _csMusicPushToFirestore();
        }
        _renderCSLibrary();
      });
    }
    return;
  }
  _csMusic.queueIndex = idx;
  _csMusicAdvanceNowPlaying();
  _csMusicStopLocalPreview();
  _csMusicStartLocalPreview();
  _renderCSPlaylistPanel();
  _patchNowPlayingButtons();
  if (_state.cloudStatus === 'active' && _state.cloudStreamId) {
    _csMusicPushToWorker();
    _csMusicPushToFirestore();
  }
  _toast('Playing: ' + (_csMusic.queue[_csMusic.queueIndex] ? (_csMusic.queue[_csMusic.queueIndex].title || 'Untitled') : ''));
  _renderCSLibrary();
};

/* ═══════════════════════════════════════════════════════
   8. EFFECTS STUDIO
═══════════════════════════════════════════════════════ */
var EFFECTS = [
  { id: 'glow',      name: 'Glow',      icon: '✨' },
  { id: 'particles', name: 'Particles', icon: '🌟' },
  { id: 'smoke',     name: 'Smoke',     icon: '💨' },
  { id: 'lightning', name: 'Lightning', icon: '⚡' },
  { id: 'flames',    name: 'Flames',    icon: '🔥' },
  { id: 'neon',      name: 'Neon',      icon: '💡' },
  { id: 'matrix',    name: 'Matrix',    icon: '🔢' },
  { id: 'rainbow',   name: 'Rainbow',   icon: '🌈' },
  { id: 'stars',     name: 'Stars',     icon: '⭐' },
  { id: 'vhs',       name: 'VHS',       icon: '📼' },
  { id: 'glitch',    name: 'Glitch',    icon: '🔀' },
  { id: 'pulse',     name: 'Pulse',     icon: '💓' }
];

function _renderEffects() {
  var el = document.getElementById('snxEffectsGrid');
  if (!el) return;
  el.innerHTML = EFFECTS.map(function(eff) {
    var active = _state.effectsActive.indexOf(eff.id) !== -1;
    return '<div class="snx-effect-btn' + (active ? ' active' : '') + '" onclick="snxStudioToggleEffect(\'' + eff.id + '\')">' +
      '<span class="eff-icon">' + eff.icon + '</span>' + _esc(eff.name) +
    '</div>';
  }).join('');
}

window.snxStudioToggleEffect = function(id) {
  var idx = _state.effectsActive.indexOf(id);
  if (idx === -1) _state.effectsActive.push(id);
  else _state.effectsActive.splice(idx, 1);
  _renderEffects();
};

/* ═══════════════════════════════════════════════════════
   9. EVENT STUDIO / SCENES
═══════════════════════════════════════════════════════ */
function _renderEventScenes() {
  var el = document.getElementById('snxEventSceneList');
  if (!el) return;
  el.innerHTML = EVENT_SCENES.map(function(scene) {
    var active = _state.currentScene === scene.id;
    return '<div class="snx-scene-item' + (active ? ' active' : '') + '" onclick="snxStudioActivateScene(\'' + scene.id + '\')">' +
      '<span class="snx-scene-icon">' + scene.icon + '</span>' +
      '<div class="snx-scene-info">' +
        '<div class="snx-scene-name">' + _esc(scene.name) + '</div>' +
        '<div class="snx-scene-desc">' + _esc(scene.desc) + '</div>' +
      '</div>' +
      (scene.badge ? '<span class="snx-scene-badge ' + scene.badge + '">' + scene.badge.toUpperCase() + '</span>' : '') +
    '</div>';
  }).join('');
}

window.snxStudioActivateScene = function(sceneId) {
  _state.currentScene = sceneId;
  _renderEventScenes();
  _renderStatusBar();
  var scene = EVENT_SCENES.find(function(s) { return s.id === sceneId; });
  if (scene) _toast('Scene: ' + scene.name);
  // If CloudStream is active, sync to cloud
  if (_state.cloudStatus === 'active' && _state.cloudStreamId) {
    _cloudStreamRPC({ action: 'setScene', sceneId: sceneId });
  }
};

/* ═══════════════════════════════════════════════════════
   10. SCENE BUILDER
═══════════════════════════════════════════════════════ */
window.snxStudioInitSceneBuilder = function() {
  var el = document.getElementById('snxSceneElementsGrid');
  if (!el) return;
  el.innerHTML = SCENE_ELEMENTS.map(function(elem) {
    return '<div class="snx-scene-el-btn" onclick="snxStudioAddElement(\'' + elem.id + '\')">' +
      '<span class="el-icon">' + elem.icon + '</span>' + _esc(elem.name) +
    '</div>';
  }).join('');
  _renderScenePlaylist();
};

window.snxStudioAddElement = function(elementId) {
  _toast('Added ' + elementId + ' element to canvas');
};

function _renderScenePlaylist() {
  var el = document.getElementById('snxScenePlaylistList');
  if (!el) return;
  if (!_state.scenePlaylist.length) {
    el.innerHTML = '<div class="snx-empty-state"><div class="empty-icon">🎬</div>No scenes in playlist yet.<br>Add scenes to build your broadcast schedule.</div>';
    return;
  }
  el.innerHTML = _state.scenePlaylist.map(function(item, i) {
    return '<div class="snx-playlist-item" data-index="' + i + '">' +
      '<span class="snx-playlist-drag">⋮⋮</span>' +
      '<span class="snx-playlist-num">' + (i + 1) + '</span>' +
      '<div class="snx-playlist-info">' +
        '<div class="snx-playlist-name">' + _esc(item.name) + '</div>' +
        '<div class="snx-playlist-duration">' + _formatDuration(item.duration) + '</div>' +
      '</div>' +
      '<span class="snx-playlist-del" onclick="snxStudioRemovePlaylistItem(' + i + ')">✕</span>' +
    '</div>';
  }).join('');
}

window.snxStudioAddToPlaylist = function() {
  var nameEl  = document.getElementById('snxPlaylistSceneName');
  var durEl   = document.getElementById('snxPlaylistDuration');
  var name    = nameEl ? nameEl.value.trim() : '';
  var dur     = parseInt(durEl ? durEl.value : 0, 10) || 0;
  if (!name)  { _toastError('Please enter a scene name.'); return; }
  if (dur < 1){ _toastError('Duration must be at least 1 minute.'); return; }
  _state.scenePlaylist.push({ name: name, duration: dur * 60 });
  if (nameEl) nameEl.value = '';
  if (durEl)  durEl.value  = '';
  _renderScenePlaylist();
};

window.snxStudioRemovePlaylistItem = function(index) {
  _state.scenePlaylist.splice(index, 1);
  _renderScenePlaylist();
};

/* ═══════════════════════════════════════════════════════
   11. CLOUDSTREAM PANEL
   Now renders inside the Dashboard tab of the Cloud Stream section.
═══════════════════════════════════════════════════════ */
function _renderCloudStreamPanel() {
  var activeEl  = document.getElementById('snxCSActive');
  var handoffEl = document.getElementById('snxCSHandoff');
  var dashIdle  = document.getElementById('snxCSDashboardIdle');

  if (!activeEl) return; // Cloud Stream section not in DOM yet

  if (_state.cloudStatus === 'active' || _state.cloudStatus === 'recovering') {
    if (handoffEl) handoffEl.style.display = 'none';
    if (dashIdle)  dashIdle.style.display  = 'none';
    activeEl.style.display = '';
    _renderCloudStreamActive();
  } else if (_state.cloudStatus === 'starting') {
    if (dashIdle)  dashIdle.style.display  = 'none';
    activeEl.style.display = 'none';
    if (handoffEl) { handoffEl.style.display = ''; _renderHandoffSteps(); }
  } else {
    if (handoffEl) handoffEl.style.display = 'none';
    activeEl.style.display = 'none';
    if (dashIdle) dashIdle.style.display = '';
  }

  _renderCloudStatusBadge();
}

function _renderCloudStatusBadge() {
  var el = document.getElementById('snxCSStatusBadge');
  if (!el) return;
  var icons  = { draft:'&#9925;', starting:'&#9203;', active:'&#9989;', recovering:'&#9888;', stopping:'&#9209;', stopped:'&#9209;', failed:'&#10060;' };
  var labels = { draft:'DRAFT', starting:'STARTING', active:'CLOUD STREAM ACTIVE',
                 recovering:'RECOVERING', stopping:'STOPPING', stopped:'STOPPED', failed:'FAILED' };
  el.className = 'snx-cs-status-badge ' + (_state.cloudStatus || 'draft');
  el.innerHTML = (icons[_state.cloudStatus] || '&#9925;') + ' ' + (labels[_state.cloudStatus] || 'DRAFT');
}

function _renderHandoffSteps() {
  var el = document.getElementById('snxCSHandoffSteps');
  if (!el) return;
  var steps = [
    { label: 'Preparing CloudStream…',     done: _state.handoffStep > 0, active: _state.handoffStep === 0 },
    { label: 'Uploading configuration…',   done: _state.handoffStep > 1, active: _state.handoffStep === 1 },
    { label: 'Starting cloud broadcast…',  done: _state.handoffStep > 2, active: _state.handoffStep === 2 },
    { label: 'Verifying cloud worker…',    done: _state.handoffStep > 3, active: _state.handoffStep === 3 }
  ];
  el.innerHTML = steps.map(function(s) {
    var cls = s.done ? 'done' : s.active ? 'active' : '';
    var icon = s.done ? '✅' : s.active ? '⏳' : '○';
    return '<div class="snx-handoff-step ' + cls + '"><span class="step-icon">' + icon + '</span>' + _esc(s.label) + '</div>';
  }).join('');
}

function _renderCloudStreamActive() {
  var el = document.getElementById('snxCSActive');
  if (!el) return;
  var cs     = _state.cloudStream || {};
  var uptime = cs.startedAt ? Math.floor((Date.now() - cs.startedAt) / 60000) : 0;

  // Now Playing row
  var npTitle  = _csMusic.nowPlayingTitle  || (cs.currentMusicTitle  || '');
  var npArtist = _csMusic.nowPlayingArtist || (cs.currentMusicArtist || '');
  var nxTitle  = _csMusic.nextTitle        || '';
  var nowPlayingHtml = npTitle
    ? '<div class="snx-cs-now-playing">' +
        '<div class="snx-cs-np-label">♪ NOW PLAYING</div>' +
        '<div class="snx-cs-np-title" id="snxCSNpTitle">' + _esc(npTitle) + '</div>' +
        (npArtist ? '<div class="snx-cs-np-artist" id="snxCSNpArtist">' + _esc(npArtist) + '</div>' : '') +
        (nxTitle  ? '<div class="snx-cs-np-next">Next: ' + _esc(nxTitle) + '</div>' : '') +
        '<div class="snx-cs-np-controls">' +
          '<button class="snx-cs-np-btn" onclick="snxCSMusicPlayPause()" id="snxCSPlayPauseBtn">' +
            (_csMusic.playing ? '⏸' : '▶') +
          '</button>' +
          '<button class="snx-cs-np-btn" onclick="snxCSMusicNext()">⏭</button>' +
          '<button class="snx-cs-np-btn' + (_csMusic.shuffle ? ' active' : '') + '" onclick="snxCSMusicToggleShuffle()" title="Shuffle">⇄</button>' +
          '<button class="snx-cs-np-btn' + (_csMusic.repeat  ? ' active' : '') + '" onclick="snxCSMusicToggleRepeat()" title="Repeat">↺</button>' +
          '<span style="font-size:11px;color:#4a7a9a;margin-left:4px;">Vol</span>' +
          '<input type="range" min="0" max="100" value="' + _csMusic.volume + '" ' +
            'oninput="snxCSMusicSetVolume(this.value)" ' +
            'style="width:70px;margin-left:4px;accent-color:#00AEEF;">' +
        '</div>' +
      '</div>'
    : '<div class="snx-cs-now-playing snx-cs-no-music">' +
        '<div class="snx-cs-np-label">♫ NO MUSIC ACTIVE</div>' +
        '<div class="snx-cs-np-artist">Select a playlist in the Playlist tab below</div>' +
      '</div>';

  el.innerHTML =
    '<div class="snx-cs-active-banner">' +
      '<div class="snx-cs-active-title">☁️ CLOUDSTREAM ACTIVE</div>' +
      '<div class="snx-cs-active-msg">' +
        'Your broadcast is running in the cloud.<br>' +
        'You may close Shadow Nexus Social or turn off your phone/computer.' +
      '</div>' +
      '<div class="snx-health-grid">' +
        '<div class="snx-health-tile"><div class="ht-value">' + uptime + 'm</div><div class="ht-label">Uptime</div></div>' +
        '<div class="snx-health-tile"><div class="ht-value">' + (cs.viewerCount || 0) + '</div><div class="ht-label">Viewers</div></div>' +
        '<div class="snx-health-tile"><div class="ht-value">' + (cs.bitrate ? cs.bitrate + 'k' : '—') + '</div><div class="ht-label">Bitrate</div></div>' +
        '<div class="snx-health-tile"><div class="ht-value">' + (cs.fps || '—') + '</div><div class="ht-label">FPS</div></div>' +
      '</div>' +
    '</div>' +
    nowPlayingHtml +
    '<div class="snx-cs-controls-grid">' +
      _csCtrlBtn('🎬 Change Scene',   'snxCSChangeScene()') +
      _csCtrlBtn('🎵 Change Playlist','snxCSOpenPlaylist()') +
      _csCtrlBtn('🎨 Change Theme',   'snxCSChangeTheme()') +
      _csCtrlBtn('📢 Announcement',   'snxCSAnnounce()') +
      _csCtrlBtn('📋 Edit Queue',     'snxCSEditQueue()') +
      _csCtrlBtn('⛔ Stop CloudStream','snxCSStop()', 'danger') +
    '</div>' +
    // Playlist panel (collapsible)
    '<div id="snxCSPlaylistPanel" class="snx-studio-card snx-cs-playlist-panel" style="margin:10px 14px 0;display:none;">' +
      _renderCSPlaylistPanelHTML() +
    '</div>' +
    // Studio Diagnostic panel — owner-only, live-refreshed
    '<div id="snxCSDiag" class="snx-studio-card" style="margin:10px 14px 0;">' +
      '<div class="snx-studio-card-title" style="display:flex;align-items:center;justify-content:space-between;">' +
        '<span>🔬 Studio Diagnostic</span>' +
        '<button onclick="snxRefreshStudioDiag()" style="padding:3px 10px;font-size:11px;border-radius:6px;background:rgba(0,174,239,0.12);border:1px solid rgba(0,174,239,0.4);color:#00AEEF;cursor:pointer;">↺ Refresh</button>' +
      '</div>' +
      '<div id="snxCSDiagBody" style="font-size:11px;line-height:1.7;color:#5a80a8;">Loading…</div>' +
    '</div>';

  // Immediately populate the diagnostic
  snxRefreshStudioDiag();
  // Load playlists for the panel
  if (!_csMusic.playlists.length) _csMusicLoadPlaylists();
}

function _csCtrlBtn(label, onclick, cls) {
  return '<button class="snx-action-btn' + (cls ? ' ' + cls : '') + '" onclick="' + onclick + '">' + label + '</button>';
}

/* ═══════════════════════════════════════════════════════
   12. START CLOUDSTREAM
═══════════════════════════════════════════════════════ */
window.snxStartCloudStream = function() {
  if (!_state.user) { _toastError('You must be signed in.'); return; }

  var name     = _getVal('snxCSStreamName') || ('CloudStream by ' + (_state.userData && _state.userData.displayName ? _state.userData.displayName : 'me'));
  var desc     = _getVal('snxCSDescription')  || '';
  var category = _getVal('snxCSCategory')     || 'General';
  var duration = parseInt(_getVal('snxCSDuration') || '0', 10);
  var maxHrs   = 24;

  if (duration === 0) duration = 24 * 60; // continuous → max 24h
  if (duration > maxHrs * 60) { _toastError('Maximum CloudStream duration is ' + maxHrs + ' hours.'); return; }

  // Build configuration payload
  var config = {
    uid:          _state.user.uid,
    displayName:  _state.userData ? _state.userData.displayName : '',
    streamName:   name,
    description:  desc,
    category:     category,
    theme:        _state.currentTheme.id,
    musicQueue:   _state.musicQueue.map(function(t) { return t.id; }),
    scenePlaylist: _state.scenePlaylist,
    durationMinutes: duration,
    createdAt:    Date.now()
  };

  _state.cloudStatus    = 'starting';
  _state.handoffStep    = 0;
  _state.pendingConfig  = config;   // stored so _verifyCloudWorker can read streamName
  // Navigate to Cloud Stream section and show the dashboard (handoff progress)
  _switchSection('cloudstream');
  snxCSSwitchTab('dashboard');
  _renderCloudStreamPanel();

  _runHandoff(config);
};

function _runHandoff(config) {
  var steps = [
    function(next) { setTimeout(next, 800); },   // step 0: preparing
    function(next) { _uploadCloudConfig(config, next); }, // step 1: upload
    function(next) { _startCloudWorker(config, next); },  // step 2: start worker
    function(next) { _verifyCloudWorker(next); }           // step 3: verify
  ];

  function advance(i) {
    _state.handoffStep = i;
    _renderHandoffSteps();
    if (i >= steps.length) {
      _handoffComplete();
      return;
    }
    steps[i](function() { advance(i + 1); });
  }
  advance(0);
}

function _uploadCloudConfig(config, next) {
  if (!window._snxFirestore) { next(); return; }
  var fs = window._snxFirestore;
  var docId = _state.user.uid + '_' + Date.now();
  _state.cloudStreamId = docId;
  fs.setDoc(fs.doc(fs.db, 'cloudStreams', docId), {
    uid:            _state.user.uid,
    streamName:     config.streamName,
    description:    config.description,
    category:       config.category,
    theme:          config.theme,
    scenePlaylist:  config.scenePlaylist,
    durationMinutes:config.durationMinutes,
    status:         'starting',
    viewerCount:    0,
    createdAt:      fs.serverTimestamp(),
    startedAt:      null,
    workerStatus:   'pending',
    lastHeartbeat:  null
  }).then(function() {
    setTimeout(next, 600);
  }).catch(function(err) {
    _handoffFailed('Failed to save stream configuration: ' + err.message);
  });
}

function _startCloudWorker(config, next) {
  // POST configuration to the CloudStream Worker.
  // Include the CloudStream music queue so the worker can advance tracks
  // server-side even after the creator closes the app.
  //
  // Source priority:
  //   1. CS Playlist system (_csMusic) — if it has a queue loaded
  //   2. Studio Queue (_sq) — the permanent always-on queue
  // This ensures music added via the Studio Queue tab is also registered
  // with the worker on stream start.
  var musicPayload = _csMusicBuildWorkerPayload();
  if (!musicPayload.queue || !musicPayload.queue.length) {
    // Fall back to studio queue
    musicPayload = {
      queue:      _sq.queue.map(function(t) {
        return { id: t.id, title: t.title || '', artist: t.artist || '',
                 url: t.url || '', duration: t.duration || 0 };
      }),
      queueIndex: _sq.queueIndex,
      shuffle:    false,
      repeat:     true,
      crossfade:  3,
      volume:     80,
      playlistId: 'studio-queue'
    };
  }
  var body = JSON.stringify({
    streamId:        _state.cloudStreamId,
    uid:             _state.user.uid,
    displayName:     config.displayName,
    streamName:      config.streamName,
    theme:           config.theme,
    scenePlaylist:   config.scenePlaylist,
    durationMinutes: config.durationMinutes,
    // Music payload — worker takes ownership of playlist advancement
    musicQueue:      musicPayload.queue,
    musicShuffle:    musicPayload.shuffle,
    musicRepeat:     musicPayload.repeat,
    musicCrossfade:  musicPayload.crossfade,
    musicVolume:     musicPayload.volume,
    musicPlaylistId: musicPayload.playlistId
  });
  _snxWorkerHeaders().then(function(headers) {
  return fetch(CLOUDSTREAM_WORKER_URL + '/api/stream/start', {
    method: 'POST',
    headers: headers,
    body: body
  });
  })
  .then(function(res) {
    if (!res.ok) {
      return res.json().then(function(e) {
        throw new Error(e.error || ('Worker responded ' + res.status));
      }).catch(function() {
        throw new Error('Worker responded ' + res.status);
      });
    }
    return res.json();
  })
  .then(function(data) {
    if (data.success) {
      _state.cloudStream = data.stream || {};
      setTimeout(next, 500);
    } else {
      _handoffFailed(data.error || 'Cloud worker failed to start.');
    }
  })
  .catch(function(err) {
    // Surface the real error so Phone 2/3 creators see why their stream failed
    // instead of silently entering an unusable "demo mode".
    console.error('[SNX Studio] CloudStream worker error:', err.message);
    _handoffFailed('Could not reach CloudStream worker: ' + err.message +
      '. Check your connection and try again.');
  });
}

function _verifyCloudWorker(next) {
  if (!window._snxFirestore || !_state.cloudStreamId) { setTimeout(next, 400); return; }
  var fs  = window._snxFirestore;
  var uid = _state.user ? _state.user.uid : null;

  // 1. Mark cloudStreams doc active
  fs.updateDoc(fs.doc(fs.db, 'cloudStreams', _state.cloudStreamId), {
    status: 'active', startedAt: fs.serverTimestamp()
  }).catch(function() {});

  if (!uid) { setTimeout(next, 400); return; }

  // 2. Publish to liveRooms so the feed detects the stream.
  //    Doc ID = creator uid — one doc per creator, keyed by their UID.
  //    This write MUST succeed for other devices to see the stream.
  //    We wait for it before advancing the handoff.
  var config      = _state.pendingConfig || {};
  var data        = window._snxUserData || _state.userData || {};
  var roomPayload = {
    creatorId:     uid,
    creatorSource: 'shadow_nexus_social',
    roomId:        uid,
    hostId:        uid,
    hostName:      data.displayName || data.username || '',
    hostUsername:  data.username    || '',
    hostAvatar:    data.avatar      || data.profilePicture || (_state.user ? (_state.user.photoURL || '') : ''),
    title:         config.streamName || ('CloudStream by ' + (data.displayName || uid)),
    description:   config.description || '',
    category:      config.category    || 'General',
    status:        'live',
    isLive:        true,
    type:          '24hour_cloudstream',
    cloudStreamId: _state.cloudStreamId,
    startedAt:     fs.serverTimestamp(),
    expiresAt:     new Date(Date.now() + (config.durationMinutes || 1440) * 60 * 1000).toISOString(),
    viewers:       0,
    likes:         0,
    createdAt:     fs.serverTimestamp(),
    updatedAt:     fs.serverTimestamp()
  };

  fs.setDoc(fs.doc(fs.db, 'liveRooms', uid), roomPayload)
    .then(function() {
      // Feed entry confirmed written — other devices will now see this stream.
      next();
    })
    .catch(function(e) {
      // The liveRooms write failed — this is why Phone 2/3 are invisible.
      // Surface the real error so it can be diagnosed and fixed.
      console.error('[SNX Studio] liveRooms write failed for uid=' + uid + ':', e.message, e.code);
      _handoffFailed(
        'Stream started but could not publish to feed (liveRooms write failed): ' +
        (e.code ? e.code + ' — ' : '') + e.message +
        '. Other devices will not see your stream. Check Firestore rules and try again.'
      );
    });
}

function _handoffComplete() {
  _state.cloudStatus  = 'active';
  _state.handoffStep  = 4;
  _renderCloudStreamPanel();
  _renderStatusBar();
  _startHealthMonitor();
  // Save music state to Firestore so viewers and returning creator sessions
  // can read current Now Playing without querying the worker directly.
  _csMusicPushToFirestore();
  // Start local preview playback if queue is populated
  _csMusicStartLocalPreview();
  // Begin real-time music state sync from Firestore
  _csMusicStartSync();
  // Load the permanent studio queue — _sqLoad will also push to worker + Firestore
  // once the snapshot arrives; do an immediate push now for the case where the
  // queue is already in memory (_sq.queue) from before the stream started.
  _sqLoad();
  if (_sq.queue.length) {
    _sqPushToWorker();
    _sqPushToFirestore();
  }
  // Show the stop button in Settings tab
  var stopBtn = document.getElementById('snxCSStopBtn');
  if (stopBtn) stopBtn.style.display = '';
  // Switch dashboard to active view
  var dashIdle = document.getElementById('snxCSDashboardIdle');
  if (dashIdle) dashIdle.style.display = 'none';
  _toast('&#9925; Cloud Stream is now ACTIVE! You may close Shadow Nexus Social.');
}

function _handoffFailed(reason) {
  _state.cloudStatus = 'failed';
  if (window._snxFirestore && _state.cloudStreamId) {
    var fs = window._snxFirestore;
    fs.updateDoc(fs.doc(fs.db, 'cloudStreams', _state.cloudStreamId), { status: 'failed' }).catch(function() {});
  }
  _renderCloudStreamPanel();
  _toastError(reason || 'CloudStream failed to start.');
}

/* ═══════════════════════════════════════════════════════
   13. HEALTH MONITOR
═══════════════════════════════════════════════════════ */
function _startHealthMonitor() {
  if (_state.healthInterval) clearInterval(_state.healthInterval);
  _state.healthInterval = setInterval(function() {
    _checkHealth();
  }, 30000); // check every 30 seconds
}

function _checkHealth() {
  if (!_state.cloudStreamId) return;
  fetch(CLOUDSTREAM_WORKER_URL + '/api/stream/health/' + _state.cloudStreamId)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var prev = _state.cloudStatus;
      _state.cloudStatus = data.status || 'active';
      if (_state.cloudStream) {
        _state.cloudStream.viewerCount = data.viewerCount || 0;
        _state.cloudStream.bitrate     = data.bitrate || 0;
        _state.cloudStream.fps         = data.fps || 0;
      }
      if (prev !== _state.cloudStatus) {
        _renderCloudStreamPanel();
        _renderStatusBar();
      }
      _updateHealthUI(data);
    })
    .catch(function() {
      // Worker unreachable — show recovering but don't terminate
      if (_state.cloudStatus === 'active') {
        _state.cloudStatus = 'recovering';
        _renderStatusBar();
      }
    });
}

function _updateHealthUI(data) {
  // Update health tiles if cloud stream section is visible
  if (_state.currentSection === 'cloudstream') {
    _renderCloudStreamActive();
    _renderCSAnalytics();
  }
}

/* ═══════════════════════════════════════════════════════
   14. REMOTE CONTROL
═══════════════════════════════════════════════════════ */
window.snxCSChangeScene = function() {
  // Navigate to Sources tab within Cloud Stream section
  _switchSection('cloudstream');
  snxCSSwitchTab('sources');
};

window.snxCSChangeMusic = window.snxCSOpenPlaylist = function() {
  // Navigate to Playback tab within Cloud Stream section
  _switchSection('cloudstream');
  snxCSSwitchTab('playback');
};

window.snxCSChangeTheme = function() {
  // Navigate to Settings tab within Cloud Stream section
  _switchSection('cloudstream');
  snxCSSwitchTab('settings');
};

window.snxCSAnnounce = function() {
  var msg = prompt('Enter announcement text:');
  if (!msg) return;
  _cloudStreamRPC({ action: 'announce', text: msg });
};

window.snxCSEditQueue = function() {
  // Navigate to Sources tab within Cloud Stream section
  _switchSection('cloudstream');
  snxCSSwitchTab('sources');
};

window.snxCSStop = function() {
  if (!confirm('Stop your CloudStream? This will end the broadcast for all viewers.')) return;
  _state.cloudStatus = 'stopping';
  _renderCloudStreamPanel();

  var stopBody = JSON.stringify({ streamId: _state.cloudStreamId, uid: _state.user ? _state.user.uid : '' });
  _snxWorkerHeaders().then(function(headers) {
    return fetch(CLOUDSTREAM_WORKER_URL + '/api/stream/stop', {
      method: 'POST',
      headers: headers,
      body: stopBody
    });
  })
  .then(function() { _cloudStreamStopped(); })
  .catch(function() { _cloudStreamStopped(); }); // still mark stopped locally
};

function _cloudStreamStopped() {
  _state.cloudStatus = 'stopped';
  if (_state.healthInterval) { clearInterval(_state.healthInterval); _state.healthInterval = null; }
  // Stop music sync and local preview
  _csMusicStopSync();
  _csMusicStopLocalPreview();
  if (window._snxFirestore) {
    var fs  = window._snxFirestore;
    var uid = _state.user ? _state.user.uid : null;

    // Mark cloudStreams doc stopped
    if (_state.cloudStreamId) {
      fs.updateDoc(fs.doc(fs.db, 'cloudStreams', _state.cloudStreamId), {
        status: 'stopped', stoppedAt: fs.serverTimestamp()
      }).catch(function() {});
      // Clear music state doc
      fs.updateDoc(fs.doc(fs.db, 'studioCloudStreamMusic', _state.cloudStreamId), {
        status: 'stopped', stoppedAt: fs.serverTimestamp()
      }).catch(function() {});
    }

    // Take the liveRooms doc offline so the feed removes the card
    if (uid) {
      fs.updateDoc(fs.doc(fs.db, 'liveRooms', uid), {
        isLive:    false,
        status:    'ended',
        updatedAt: fs.serverTimestamp()
      }).catch(function() {});
    }
  }
  _state.cloudStreamId = null;
  _state.cloudStream   = null;
  _renderCloudStreamPanel();
  _renderStatusBar();
  // Hide stop button, restore idle dashboard
  var stopBtn = document.getElementById('snxCSStopBtn');
  if (stopBtn) stopBtn.style.display = 'none';
  var dashIdle = document.getElementById('snxCSDashboardIdle');
  if (dashIdle) dashIdle.style.display = '';
  // Clear the return banners
  var banner = document.getElementById('snxCSReturnBanner');
  if (banner) { banner.style.display = 'none'; banner.innerHTML = ''; }
  var innerBanner = document.getElementById('snxCSReturnBannerInner');
  if (innerBanner) innerBanner.innerHTML = '';
  _toast('Cloud Stream stopped.');
}

function _cloudStreamRPC(payload) {
  if (!_state.cloudStreamId) return;
  var rpcBody = JSON.stringify(Object.assign({ streamId: _state.cloudStreamId, uid: _state.user ? _state.user.uid : '' }, payload));
  _snxWorkerHeaders().then(function(headers) {
    return fetch(CLOUDSTREAM_WORKER_URL + '/api/stream/control', {
      method: 'POST',
      headers: headers,
      body: rpcBody
    });
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (!data.success) _toastError(data.error || 'Remote control failed.');
    else _toast('Cloud updated: ' + (payload.action || 'OK'));
  })
  .catch(function(e) { _toastError('Could not reach cloud worker: ' + e.message); });
}

/* ═══════════════════════════════════════════════════════
   15. DETECT ACTIVE CLOUDSTREAM ON RETURN
═══════════════════════════════════════════════════════ */
function _checkActiveCloudStream() {
  if (!_state.user || !window._snxFirestore) return;
  var fs = window._snxFirestore;
  fs.getDocs(fs.query(
    fs.collection(fs.db, 'cloudStreams'),
    fs.where('uid', '==', _state.user.uid),
    fs.where('status', 'in', ['active', 'starting', 'recovering']),
    fs.limit(1)
  )).then(function(snap) {
    if (snap && snap.docs && snap.docs.length > 0) {
      var doc  = snap.docs[0];
      var data = doc.data();
      _state.cloudStreamId = doc.id;
      _state.cloudStatus   = data.status;
      _state.cloudStream   = Object.assign({ startedAt: data.startedAt ? data.startedAt.toMillis ? data.startedAt.toMillis() : Date.now() : Date.now() }, data);
      // Restore music state from the cloudStreams doc
      if (data.musicPlaylistId) _csMusic.selectedId = data.musicPlaylistId;
      if (typeof data.musicShuffle  === 'boolean') _csMusic.shuffle  = data.musicShuffle;
      if (typeof data.musicRepeat   === 'boolean') _csMusic.repeat   = data.musicRepeat;
      if (typeof data.musicCrossfade=== 'number')  _csMusic.crossfade= data.musicCrossfade;
      if (typeof data.musicVolume   === 'number')  _csMusic.volume   = data.musicVolume;
      // Show return banner on the main page and auto-navigate to Cloud Stream
      _showReturnBanner();
      _renderStatusBar();
      // Auto-open Cloud Stream section so the creator can manage their active stream
      _switchSection('cloudstream');
      if (_state.cloudStatus === 'active') {
        _startHealthMonitor();
        _csMusicLoadPlaylists();
        _csMusicStartSync();
        _sqLoad();  // Restore permanent queue
        // Re-push music state to Firestore and Worker on reconnect so viewers
        // who are already watching see the correct Now Playing without waiting
        // for the next DO alarm cycle.
        _csMusicPushToFirestore();
        if (_sq.queue.length) {
          _sqPushToWorker();
          _sqPushToFirestore();
        }
        // Show stop button
        var stopBtn = document.getElementById('snxCSStopBtn');
        if (stopBtn) stopBtn.style.display = '';
      }
    }
  }).catch(function() {});
}

function _showReturnBanner() {
  // Show return banner in both the main page banner (legacy) and inside the Cloud Stream section
  var bannerHtml =
    '<div class="snx-cs-active-banner" style="margin:14px 14px 0;">' +
      '<div class="snx-cs-active-title" style="font-size:15px;">&#9925; YOUR CLOUD STREAM IS ACTIVE</div>' +
      '<div class="snx-cs-active-msg">Your cloud broadcast is currently running.</div>' +
      '<div class="snx-cs-controls-grid">' +
        _csCtrlBtn('&#127895; Control Stream',  'snxStudioSwitchSection(\'cloudstream\')') +
        _csCtrlBtn('&#9940; Stop Cloud Stream', 'snxCSStop()', 'danger') +
      '</div>' +
    '</div>';

  // Primary banner at the top of the whole page (visible regardless of section)
  var banner = document.getElementById('snxCSReturnBanner');
  if (banner) { banner.style.display = ''; banner.innerHTML = bannerHtml; }

  // Secondary banner inside Cloud Stream section
  var innerBanner = document.getElementById('snxCSReturnBannerInner');
  if (innerBanner) { innerBanner.innerHTML = bannerHtml; }
}

/* ═══════════════════════════════════════════════════════
   16A. CLOUDSTREAM PLAYLIST SYSTEM
   ─────────────────────────────────────────────────────
   Completely independent from Regular Live music.
   Data paths:
     studioPlaylists/{uid}/playlists/{playlistId}
       { id, name, trackIds[], shuffle, repeat, crossfade, volume, createdAt }
     studioCloudStreamMusic/{cloudStreamId}
       { cloudStreamId, uid, playlistId, queue[], queueIndex,
         currentTrackId, currentTitle, currentArtist, nextTitle, nextArtist,
         shuffle, repeat, crossfade, volume, status, updatedAt }
   Worker KV:
     music:{streamId}  — authoritative server-side playback pointer
═══════════════════════════════════════════════════════ */

/* ── Playlist CRUD ── */

function _csMusicGenId() {
  return 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function _csMusicLoadPlaylists() {
  if (!_state.user || !window._snxFirestore) return;
  var fs  = window._snxFirestore;
  var uid = _state.user.uid;
  fs.getDocs(fs.query(
    fs.collection(fs.db, 'studioPlaylists', uid, 'playlists'),
    fs.orderBy('createdAt', 'desc'),
    fs.limit(50)
  )).then(function(snap) {
    _csMusic.playlists = [];
    if (snap && snap.docs) {
      snap.docs.forEach(function(d) {
        _csMusic.playlists.push(Object.assign({ id: d.id }, d.data()));
      });
    }
    _renderCSPlaylistPanel();
  }).catch(function() { _renderCSPlaylistPanel(); });
}

window.snxCSMusicCreatePlaylist = function() {
  var name = prompt('Playlist name:');
  if (!name || !name.trim()) return;
  if (!_state.user || !window._snxFirestore) { _toastError('Sign in required.'); return; }
  var fs  = window._snxFirestore;
  var uid = _state.user.uid;
  var id  = _csMusicGenId();
  var pl  = { id: id, name: name.trim(), trackIds: [], shuffle: false, repeat: true,
               crossfade: 3, volume: 80, createdAt: fs.serverTimestamp() };
  fs.setDoc(fs.doc(fs.db, 'studioPlaylists', uid, 'playlists', id), pl)
    .then(function() {
      _csMusic.playlists.unshift(Object.assign({}, pl, { id: id, createdAt: Date.now() }));
      _toast('Playlist created: ' + name);
      _renderCSPlaylistPanel();
    })
    .catch(function(e) { _toastError('Could not create playlist: ' + e.message); });
};

window.snxCSMusicSelectPlaylist = function(playlistId) {
  var pl = _csMusic.playlists.find(function(p) { return p.id === playlistId; });
  if (!pl) return;
  _csMusic.selectedId  = playlistId;
  _csMusic.shuffle     = pl.shuffle  || false;
  _csMusic.repeat      = typeof pl.repeat === 'boolean' ? pl.repeat : true;
  _csMusic.crossfade   = typeof pl.crossfade === 'number' ? pl.crossfade : 3;
  _csMusic.volume      = typeof pl.volume === 'number' ? pl.volume : 80;
  // Resolve queue from track IDs using the creator's cloudStreamTracks library
  _csMusicResolveQueue(pl.trackIds || [], function(tracks) {
    _csMusic.queue      = tracks;
    _csMusic.queueIndex = 0;
    // Update now-playing with first track
    if (tracks.length) {
      _csMusic.nowPlayingTitle  = tracks[0].title  || 'Track 1';
      _csMusic.nowPlayingArtist = tracks[0].artist || '';
      _csMusic.nextTitle        = tracks[1] ? tracks[1].title || '' : '';
      _csMusic.nextArtist       = tracks[1] ? tracks[1].artist || '' : '';
    }
    _renderCSPlaylistPanel();
    _renderCloudStreamActive();
    // Push to worker if stream is active
    if (_state.cloudStatus === 'active' && _state.cloudStreamId) {
      _csMusicPushToWorker();
      _csMusicPushToFirestore();
    }
    _toast('Playlist loaded: ' + pl.name + ' (' + tracks.length + ' tracks)');
    // ── Send the full queue to the live engine so the mixer can load it ──
    // autoplay:false — user must still press Play to start; this just preloads the queue
    _csMusicSyncQueueToFrame(false);
  });
};

window.snxCSMusicDeletePlaylist = function(playlistId) {
  if (!confirm('Delete this playlist?')) return;
  if (!_state.user || !window._snxFirestore) return;
  var fs  = window._snxFirestore;
  var uid = _state.user.uid;
  fs.deleteDoc(fs.doc(fs.db, 'studioPlaylists', uid, 'playlists', playlistId))
    .then(function() {
      _csMusic.playlists = _csMusic.playlists.filter(function(p) { return p.id !== playlistId; });
      if (_csMusic.selectedId === playlistId) _csMusic.selectedId = null;
      _renderCSPlaylistPanel();
      _toast('Playlist deleted.');
    })
    .catch(function(e) { _toastError('Delete failed: ' + e.message); });
};

/* Add tracks from the existing cloudStreamTracks library to a playlist */
window.snxCSMusicAddTracksToPlaylist = function(playlistId) {
  var pl = _csMusic.playlists.find(function(p) { return p.id === playlistId; });
  if (!pl) return;
  if (!_state.user || !window._snxFirestore) return;
  var fs   = window._snxFirestore;
  var uid  = _state.user.uid;
  // Load available tracks and let creator pick
  fs.getDocs(fs.query(
    fs.collection(fs.db, 'cloudStreamTracks', uid, 'tracks'),
    fs.where('status', '==', 'ready'),
    fs.orderBy('uploadedAt', 'desc'),
    fs.limit(1000)
  )).then(function(snap) {
    var allTracks = [];
    if (snap && snap.docs) snap.docs.forEach(function(d) { allTracks.push(Object.assign({ id: d.id }, d.data())); });
    if (!allTracks.length) { _toastError('No ready tracks in your library. Upload tracks first.'); return; }
    // Add all ready tracks not already in playlist
    var added = 0;
    allTracks.forEach(function(t) {
      if (!pl.trackIds.includes(t.id)) { pl.trackIds.push(t.id); added++; }
    });
    if (!added) { _toast('All library tracks are already in this playlist.'); return; }
    fs.updateDoc(fs.doc(fs.db, 'studioPlaylists', uid, 'playlists', playlistId), {
      trackIds: pl.trackIds
    }).then(function() {
      _toast(added + ' tracks added to playlist.');
      _renderCSPlaylistPanel();
    }).catch(function(e) { _toastError('Update failed: ' + e.message); });
  }).catch(function(e) { _toastError('Could not load library: ' + e.message); });
};

window.snxCSMusicRemoveTrackFromPlaylist = function(playlistId, trackId) {
  var pl = _csMusic.playlists.find(function(p) { return p.id === playlistId; });
  if (!pl) return;
  pl.trackIds = pl.trackIds.filter(function(id) { return id !== trackId; });
  if (!_state.user || !window._snxFirestore) return;
  var fs  = window._snxFirestore;
  var uid = _state.user.uid;
  fs.updateDoc(fs.doc(fs.db, 'studioPlaylists', uid, 'playlists', playlistId), {
    trackIds: pl.trackIds
  }).then(function() {
    // If this is the active playlist, update queue too
    if (_csMusic.selectedId === playlistId) {
      _csMusic.queue = _csMusic.queue.filter(function(t) { return t.id !== trackId; });
      if (_csMusic.queueIndex >= _csMusic.queue.length) _csMusic.queueIndex = 0;
    }
    _renderCSPlaylistPanel();
  }).catch(function() {});
};

/* Move a track up (-1) or down (+1) in the playlist */
window.snxCSMusicMoveTrack = function(playlistId, fromIdx, dir) {
  var pl = _csMusic.playlists.find(function(p) { return p.id === playlistId; });
  if (!pl) return;
  var toIdx = fromIdx + dir;
  if (toIdx < 0 || toIdx >= pl.trackIds.length) return;
  // Swap in trackIds
  var tmp = pl.trackIds[fromIdx]; pl.trackIds[fromIdx] = pl.trackIds[toIdx]; pl.trackIds[toIdx] = tmp;
  // Swap in queue too if loaded
  if (_csMusic.selectedId === playlistId && _csMusic.queue.length > toIdx && _csMusic.queue.length > fromIdx) {
    var tmpQ = _csMusic.queue[fromIdx]; _csMusic.queue[fromIdx] = _csMusic.queue[toIdx]; _csMusic.queue[toIdx] = tmpQ;
    if (_csMusic.queueIndex === fromIdx) _csMusic.queueIndex = toIdx;
    else if (_csMusic.queueIndex === toIdx) _csMusic.queueIndex = fromIdx;
  }
  if (!_state.user || !window._snxFirestore) { _renderCSPlaylistPanel(); return; }
  var fs  = window._snxFirestore;
  var uid = _state.user.uid;
  fs.updateDoc(fs.doc(fs.db, 'studioPlaylists', uid, 'playlists', playlistId), {
    trackIds: pl.trackIds
  }).then(function() { _renderCSPlaylistPanel(); }).catch(function() { _renderCSPlaylistPanel(); });
};

/* Rename a playlist */
window.snxCSMusicRenamePlaylist = function(playlistId) {
  var pl = _csMusic.playlists.find(function(p) { return p.id === playlistId; });
  if (!pl) return;
  var newName = prompt('Rename playlist:', pl.name);
  if (!newName || !newName.trim() || newName.trim() === pl.name) return;
  if (!_state.user || !window._snxFirestore) return;
  var fs  = window._snxFirestore;
  var uid = _state.user.uid;
  fs.updateDoc(fs.doc(fs.db, 'studioPlaylists', uid, 'playlists', playlistId), {
    name: newName.trim()
  }).then(function() {
    pl.name = newName.trim();
    _toast('Playlist renamed to "' + newName.trim() + '".');
    _renderCSPlaylistPanel();
  }).catch(function(e) { _toastError('Rename failed: ' + e.message); });
};

/* ── Queue resolution ── */

function _csMusicResolveQueue(trackIds, cb) {
  if (!trackIds || !trackIds.length) { cb([]); return; }
  if (!_state.user || !window._snxFirestore) { cb([]); return; }
  var fs  = window._snxFirestore;
  var uid = _state.user.uid;
  // Batch-fetch tracks (Firestore limit: 30 per in-query)
  var chunks = [];
  for (var i = 0; i < trackIds.length; i += 30) chunks.push(trackIds.slice(i, i + 30));
  var results = [];
  var done    = 0;
  chunks.forEach(function(chunk) {
    fs.getDocs(fs.query(
      fs.collection(fs.db, 'cloudStreamTracks', uid, 'tracks'),
      fs.where(fs.documentId(), 'in', chunk)
    )).then(function(snap) {
      if (snap && snap.docs) snap.docs.forEach(function(d) { results.push(Object.assign({ id: d.id }, d.data())); });
      done++;
      if (done === chunks.length) {
        // Preserve original order
        var ordered = trackIds.map(function(id) { return results.find(function(r) { return r.id === id; }); })
                               .filter(Boolean);
        cb(ordered);
      }
    }).catch(function() { done++; if (done === chunks.length) cb(results); });
  });
}

/* ── Playback controls (client-side preview + worker sync) ── */

window.snxCSMusicPlayPause = function() {
  if (!_csMusic.queue.length) { _toastError('No tracks loaded. Select a playlist first.'); return; }
  if (_csMusic.playing) {
    _csMusicStopLocalPreview();
    _csMusic.playing = false;
    _cloudStreamRPC({ action: 'musicPause' });
    // ── Mirror to live mixer ──
    _crPostMusicToFrame({ type: 'snx_music_pause' });
  } else {
    _csMusicStartLocalPreview();
    // ── Mirror to live mixer ──
    var cur = _csMusic.queue[_csMusic.queueIndex];
    _crPostMusicToFrame({ type: 'snx_music_play', track: cur ? { id: cur.id || '', title: cur.title || '', artist: cur.artist || '', url: cur.url || '' } : null });
  }
  _renderCSPlaylistPanel();
  _patchNowPlayingButtons();
};

window.snxCSMusicNext = function() {
  if (!_csMusic.queue.length) return;
  _csMusicStopLocalPreview();
  if (_csMusic.shuffle) {
    _csMusic.queueIndex = Math.floor(Math.random() * _csMusic.queue.length);
  } else {
    _csMusic.queueIndex = (_csMusic.queueIndex + 1) % _csMusic.queue.length;
    if (_csMusic.queueIndex === 0 && !_csMusic.repeat) {
      _toast('Playlist ended. Enable Repeat to loop.');
      _csMusic.playing = false;
      _crPostMusicToFrame({ type: 'snx_music_pause' });
      _renderCSPlaylistPanel();
      return;
    }
  }
  _csMusicAdvanceNowPlaying();
  _csMusicStartLocalPreview();
  _cloudStreamRPC({ action: 'musicNext' });
  _csMusicPushToFirestore();
  // ── Mirror to live mixer ──
  _crPostMusicToFrame({ type: 'snx_music_next' });
};

window.snxCSMusicToggleShuffle = function() {
  _csMusic.shuffle = !_csMusic.shuffle;
  _patchNowPlayingButtons();
  _cloudStreamRPC({ action: 'musicShuffle', value: _csMusic.shuffle });
  _csMusicSaveSetting('shuffle', _csMusic.shuffle);
  _toast('Shuffle: ' + (_csMusic.shuffle ? 'ON' : 'OFF'));
};

window.snxCSMusicToggleRepeat = function() {
  _csMusic.repeat = !_csMusic.repeat;
  _patchNowPlayingButtons();
  _cloudStreamRPC({ action: 'musicRepeat', value: _csMusic.repeat });
  _csMusicSaveSetting('repeat', _csMusic.repeat);
  _toast('Repeat: ' + (_csMusic.repeat ? 'ON' : 'OFF'));
};

window.snxCSMusicSetVolume = function(val) {
  _csMusic.volume = parseInt(val, 10) || 80;
  if (_csMusic.audio) _csMusic.audio.volume = _csMusic.volume / 100;
  _cloudStreamRPC({ action: 'musicVolume', value: _csMusic.volume });
  // ── Mirror to live mixer ──
  _crPostMusicToFrame({ type: 'snx_music_volume', value: _csMusic.volume });
};

window.snxCSMusicSetCrossfade = function(val) {
  _csMusic.crossfade = parseInt(val, 10) || 0;
  _cloudStreamRPC({ action: 'musicCrossfade', value: _csMusic.crossfade });
};

/* ── Local preview playback (creator's device while app is open) ── */

function _csMusicStartLocalPreview() {
  if (!_csMusic.queue.length) return;
  var track = _csMusic.queue[_csMusic.queueIndex];
  if (!track || !track.url) return;

  _csMusicStopLocalPreview();
  _csMusic.playing = true;

  // ── Tell the live mixer to play this track ──
  _crPostMusicToFrame({
    type:  'snx_music_play',
    track: { id: track.id || '', title: track.title || '', artist: track.artist || '', url: track.url || '' }
  });

  var audio = new Audio(track.url);
  audio.volume  = _csMusic.volume / 100;
  audio.crossOrigin = 'anonymous';
  _csMusic.audio = audio;

  audio.ontimeupdate = function() {
    var fill = document.getElementById('snxCSNpProgress');
    if (fill && audio.duration) fill.style.width = ((audio.currentTime / audio.duration) * 100) + '%';
    var cur  = document.getElementById('snxCSNpTime');
    if (cur) cur.textContent = _formatDuration(Math.floor(audio.currentTime));
  };

  audio.onended = function() {
    // Auto-advance
    _csMusic.queueIndex = (_csMusic.queueIndex + 1) % _csMusic.queue.length;
    if (_csMusic.queueIndex === 0 && !_csMusic.repeat) {
      _csMusic.playing = false;
      _csMusicAdvanceNowPlaying();
      _renderCSPlaylistPanel();
      _patchNowPlayingButtons();
      _toast('Playlist ended.');
      // ── Tell the live mixer to stop ──
      _crPostMusicToFrame({ type: 'snx_music_stop' });
      return;
    }
    _csMusicAdvanceNowPlaying();
    _csMusicStartLocalPreview();   // recursive — will tell live mixer about next track
    _csMusicPushToFirestore();
  };

  audio.onerror = function() {
    _csMusic.queueIndex = (_csMusic.queueIndex + 1) % _csMusic.queue.length;
    _csMusicStartLocalPreview();
  };

  audio.play().catch(function() { _csMusic.playing = false; });
}

function _csMusicStopLocalPreview() {
  if (_csMusic.audio) {
    _csMusic.audio.pause();
    _csMusic.audio.src = '';
    _csMusic.audio = null;
  }
  _csMusic.playing = false;
}

function _csMusicAdvanceNowPlaying() {
  var cur  = _csMusic.queue[_csMusic.queueIndex];
  var next = _csMusic.queue[(_csMusic.queueIndex + 1) % _csMusic.queue.length];
  _csMusic.nowPlayingTitle  = cur  ? (cur.title  || 'Untitled') : '';
  _csMusic.nowPlayingArtist = cur  ? (cur.artist || '') : '';
  _csMusic.nextTitle        = next ? (next.title || '') : '';
  _csMusic.nextArtist       = next ? (next.artist|| '') : '';
  _patchNowPlayingText();
}

function _patchNowPlayingText() {
  var t = document.getElementById('snxCSNpTitle');
  var a = document.getElementById('snxCSNpArtist');
  if (t) t.textContent = _csMusic.nowPlayingTitle  || '';
  if (a) a.textContent = _csMusic.nowPlayingArtist || '';
}

function _patchNowPlayingButtons() {
  var btn = document.getElementById('snxCSPlayPauseBtn');
  if (btn) btn.textContent = _csMusic.playing ? '⏸' : '▶';
}

/* ── Push to worker / Firestore ── */

function _csMusicBuildWorkerPayload() {
  var queueForWorker = _csMusic.queue.map(function(t) {
    return { id: t.id, title: t.title || '', artist: t.artist || '', url: t.url || '',
             duration: t.duration || 0 };
  });
  return {
    queue:      queueForWorker,
    shuffle:    _csMusic.shuffle,
    repeat:     _csMusic.repeat,
    crossfade:  _csMusic.crossfade,
    volume:     _csMusic.volume,
    playlistId: _csMusic.selectedId || '',
    queueIndex: _csMusic.queueIndex
  };
}

function _csMusicPushToWorker() {
  if (!_state.cloudStreamId || !_state.user) return;
  var payload  = _csMusicBuildWorkerPayload();
  var musicBody = JSON.stringify(Object.assign({ streamId: _state.cloudStreamId, uid: _state.user.uid }, payload));
  _snxWorkerHeaders().then(function(headers) {
    return fetch(CLOUDSTREAM_WORKER_URL + '/api/stream/music/set', {
      method: 'POST',
      headers: headers,
      body: musicBody
    });
  }).catch(function(e) { console.warn('[SNX Studio] music push to worker failed:', e.message); });
}

function _csMusicPushToFirestore() {
  if (!_state.cloudStreamId || !_state.user || !window._snxFirestore) return;
  var fs  = window._snxFirestore;
  var cur = _csMusic.queue[_csMusic.queueIndex] || {};
  var nxt = _csMusic.queue[(_csMusic.queueIndex + 1) % (_csMusic.queue.length || 1)] || {};
  fs.setDoc(fs.doc(fs.db, 'studioCloudStreamMusic', _state.cloudStreamId), {
    cloudStreamId:  _state.cloudStreamId,
    uid:            _state.user.uid,
    playlistId:     _csMusic.selectedId  || '',
    queueLength:    _csMusic.queue.length,
    queueIndex:     _csMusic.queueIndex,
    currentTrackId: cur.id    || '',
    currentTitle:   cur.title  || '',
    currentArtist:  cur.artist || '',
    nextTrackId:    nxt.id    || '',
    nextTitle:      nxt.title  || '',
    nextArtist:     nxt.artist || '',
    shuffle:        _csMusic.shuffle,
    repeat:         _csMusic.repeat,
    crossfade:      _csMusic.crossfade,
    volume:         _csMusic.volume,
    status:         'playing',
    updatedAt:      fs.serverTimestamp()
  }, { merge: true }).catch(function() {});
  // Also update the cloudStreams doc so the health check carries music context
  fs.updateDoc(fs.doc(fs.db, 'cloudStreams', _state.cloudStreamId), {
    musicPlaylistId:    _csMusic.selectedId  || '',
    currentMusicTitle:  cur.title  || '',
    currentMusicArtist: cur.artist || '',
    musicShuffle:       _csMusic.shuffle,
    musicRepeat:        _csMusic.repeat,
    musicVolume:        _csMusic.volume
  }).catch(function() {});
}

function _csMusicSaveSetting(key, val) {
  if (!_csMusic.selectedId || !_state.user || !window._snxFirestore) return;
  var fs   = window._snxFirestore;
  var uid  = _state.user.uid;
  var upd  = {};
  upd[key] = val;
  fs.updateDoc(fs.doc(fs.db, 'studioPlaylists', uid, 'playlists', _csMusic.selectedId), upd)
    .catch(function() {});
}

/* ── Firestore real-time sync (updates Now Playing for creator's UI) ── */

function _csMusicStartSync() {
  _csMusicStopSync();
  if (!_state.cloudStreamId || !window._snxFirestore) return;
  var fs = window._snxFirestore;
  _csMusic.unsub = fs.onSnapshot(
    fs.doc(fs.db, 'studioCloudStreamMusic', _state.cloudStreamId),
    function(snap) {
      if (!snap || !snap.exists()) return;
      var d = snap.data();
      _csMusic.nowPlayingTitle  = d.currentTitle  || '';
      _csMusic.nowPlayingArtist = d.currentArtist || '';
      _csMusic.nextTitle        = d.nextTitle     || '';
      _csMusic.nextArtist       = d.nextArtist    || '';
      _patchNowPlayingText();
    },
    function() {} // ignore errors silently — non-critical
  );
}

function _csMusicStopSync() {
  if (typeof _csMusic.unsub === 'function') {
    try { _csMusic.unsub(); } catch(e) {}
    _csMusic.unsub = null;
  }
  if (_csMusic.musicSyncInterval) {
    clearInterval(_csMusic.musicSyncInterval);
    _csMusic.musicSyncInterval = null;
  }
}

/* ── CloudStream Playlist Panel renderer ── */

function _renderCSPlaylistPanelHTML() {
  // Synchronous: just return HTML for the panel container
  return '<div class="snx-cs-pl-panel-inner" id="snxCSPlPanelInner">' +
    '<div style="color:#4a7a9a;font-size:12px;text-align:center;padding:12px 0;">Loading playlists…</div>' +
  '</div>';
}

function _renderCSPlaylistPanel() {
  var el = document.getElementById('snxCSPlPanelInner');
  if (!el) return;

  var html = '';

  // Header: Create playlist + playlist selector
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">' +
    '<div style="font-size:13px;font-weight:700;color:#00AEEF;">🎵 CloudStream Playlist</div>' +
    '<div style="display:flex;gap:6px;">' +
      '<button onclick="snxCSMusicCreatePlaylist()" style="padding:4px 10px;border-radius:6px;font-size:11px;border:1px solid rgba(0,174,239,0.4);background:rgba(0,174,239,0.10);color:#00AEEF;cursor:pointer;">+ New</button>' +
    '</div>' +
  '</div>';

  if (!_csMusic.playlists.length) {
    html += '<div style="color:#4a7a9a;font-size:12px;text-align:center;padding:16px 0;">' +
      'No playlists yet. Create one, then add tracks from your Music Library.' +
    '</div>';
  } else {
    // Playlist selector tabs
    html += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">';
    _csMusic.playlists.forEach(function(pl) {
      var isActive = pl.id === _csMusic.selectedId;
      html += '<button onclick="snxCSMusicSelectPlaylist(\'' + _esc(pl.id) + '\')" ' +
        'style="padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;' +
        'border:1px solid ' + (isActive ? '#00AEEF' : 'rgba(0,174,239,0.25)') + ';' +
        'background:' + (isActive ? 'rgba(0,174,239,0.18)' : 'rgba(0,174,239,0.05)') + ';' +
        'color:' + (isActive ? '#00AEEF' : '#5a80a8') + ';">' +
        _esc(pl.name) +
        '</button>';
    });
    html += '</div>';
  }

  // Active playlist detail
  var activePl = _csMusic.playlists.find(function(p) { return p.id === _csMusic.selectedId; });
  if (activePl) {
    // Total duration
    var totalSecs = _csMusic.queue.reduce(function(acc, t) { return acc + (t.duration || 0); }, 0);
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
      '<div style="font-size:11px;color:#4a7a9a;">' +
        activePl.trackIds.length + ' track' + (activePl.trackIds.length !== 1 ? 's' : '') +
        (totalSecs > 0 ? ' · ' + _formatDuration(totalSecs) + ' total' : '') +
      '</div>' +
      '<button onclick="snxCSMusicRenamePlaylist(\'' + _esc(activePl.id) + '\')" ' +
        'style="background:none;border:none;color:#4a7a9a;font-size:11px;cursor:pointer;padding:0;" title="Rename playlist">✎ Rename</button>' +
    '</div>';

    // Track list (from queue if loaded, otherwise just IDs)
    if (_csMusic.queue.length) {
      html += '<div class="snx-cs-pl-tracklist">';
      _csMusic.queue.forEach(function(t, i) {
        var isCur    = i === _csMusic.queueIndex && _csMusic.playing;
        var isFirst  = i === 0;
        var isLast   = i === _csMusic.queue.length - 1;
        html += '<div class="snx-cs-pl-track' + (isCur ? ' playing' : '') + '">' +
          '<span class="snx-cs-pl-track-num">' + (isCur ? '♪' : (i + 1)) + '</span>' +
          '<div class="snx-cs-pl-track-info">' +
            '<div class="snx-cs-pl-track-title">' + _esc(t.title || 'Untitled') + '</div>' +
            (t.artist ? '<div class="snx-cs-pl-track-artist">' + _esc(t.artist) + '</div>' : '') +
          '</div>' +
          (t.duration ? '<span style="font-size:10px;color:#3a5a7a;flex-shrink:0;">' + _formatDuration(t.duration) + '</span>' : '') +
          // Reorder buttons
          '<div class="snx-cs-pl-reorder">' +
            '<button class="snx-cs-pl-reorder-btn" ' +
              (isFirst ? 'disabled style="opacity:0.25;" ' : 'onclick="snxCSMusicMoveTrack(\'' + _esc(activePl.id) + '\',' + i + ',-1)" ') +
              'title="Move up">▲</button>' +
            '<button class="snx-cs-pl-reorder-btn" ' +
              (isLast ? 'disabled style="opacity:0.25;" ' : 'onclick="snxCSMusicMoveTrack(\'' + _esc(activePl.id) + '\',' + i + ',1)" ') +
              'title="Move down">▼</button>' +
          '</div>' +
          '<button onclick="snxCSMusicRemoveTrackFromPlaylist(\'' + _esc(activePl.id) + '\',\'' + _esc(t.id) + '\')" ' +
            'class="snx-cs-pl-remove-btn" title="Remove from playlist">×</button>' +
        '</div>';
      });
      html += '</div>';
    } else if (activePl.trackIds.length) {
      html += '<div style="color:#4a7a9a;font-size:11px;margin:6px 0 10px;">' + activePl.trackIds.length + ' tracks (loading…)</div>';
    }

    // Add all library tracks button
    html += '<button onclick="snxCSMusicAddTracksToPlaylist(\'' + _esc(activePl.id) + '\')" ' +
      'style="width:100%;margin-top:8px;padding:7px;border-radius:7px;' +
      'border:1px solid rgba(0,174,239,0.25);background:rgba(0,174,239,0.07);' +
      'color:#00AEEF;font-size:11px;cursor:pointer;">+ Add All Library Tracks</button>';

    // Playback settings row
    html += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;align-items:center;">' +
      '<label style="font-size:11px;color:#4a7a9a;display:flex;align-items:center;gap:4px;">' +
        '<input type="checkbox"' + (_csMusic.shuffle ? ' checked' : '') + ' onchange="snxCSMusicToggleShuffle()"> Shuffle' +
      '</label>' +
      '<label style="font-size:11px;color:#4a7a9a;display:flex;align-items:center;gap:4px;">' +
        '<input type="checkbox"' + (_csMusic.repeat ? ' checked' : '') + ' onchange="snxCSMusicToggleRepeat()"> Repeat All' +
      '</label>' +
      '<label style="font-size:11px;color:#4a7a9a;display:flex;align-items:center;gap:4px;">' +
        'Crossfade:' +
        '<select onchange="snxCSMusicSetCrossfade(this.value)" style="margin-left:4px;padding:2px 6px;border-radius:4px;background:#071428;border:1px solid rgba(0,174,239,0.25);color:#d8eeff;font-size:11px;">' +
        [0,1,2,3,5,8].map(function(s) {
          return '<option value="' + s + '"' + (_csMusic.crossfade === s ? ' selected' : '') + '>' + (s === 0 ? 'Off' : s + 's') + '</option>';
        }).join('') +
        '</select>' +
      '</label>' +
      '<label style="font-size:11px;color:#4a7a9a;display:flex;align-items:center;gap:4px;">' +
        'Vol: <input type="range" min="0" max="100" value="' + _csMusic.volume + '" ' +
        'oninput="snxCSMusicSetVolume(this.value)" style="width:60px;accent-color:#00AEEF;">' +
      '</label>' +
    '</div>';

    // Delete playlist
    html += '<div style="margin-top:8px;text-align:right;">' +
      '<button onclick="snxCSMusicDeletePlaylist(\'' + _esc(activePl.id) + '\')" ' +
        'style="padding:3px 10px;border-radius:6px;font-size:10px;border:1px solid rgba(255,51,85,0.30);' +
        'background:rgba(255,51,85,0.06);color:#ff3355;cursor:pointer;" title="Delete this playlist">🗑 Delete Playlist</button>' +
    '</div>';

    // Schedule section
    html += '<div style="margin-top:12px;border-top:1px solid rgba(0,174,239,0.10);padding-top:10px;">' +
      '<div style="font-size:11px;color:#00AEEF;font-weight:700;margin-bottom:6px;">⏰ Schedule (Auto-start)</div>' +
      '<div style="font-size:11px;color:#4a7a9a;margin-bottom:6px;">Add a time for this playlist to automatically start during your CloudStream.</div>' +
      '<div style="display:flex;gap:6px;align-items:center;">' +
        '<input type="time" id="snxCSPlScheduleTime" style="padding:4px 8px;border-radius:6px;background:#071428;border:1px solid rgba(0,174,239,0.22);color:#d8eeff;font-size:12px;">' +
        '<button onclick="snxCSMusicAddSchedule(\'' + _esc(activePl.id) + '\')" style="padding:4px 10px;border-radius:6px;font-size:11px;border:1px solid rgba(0,174,239,0.30);background:rgba(0,174,239,0.08);color:#00AEEF;cursor:pointer;">Add</button>' +
      '</div>' +
      _csMusicRenderScheduleEntries(activePl.id) +
    '</div>';
  }

  el.innerHTML = html;
  // Re-render CS library so the + / ✓ buttons reflect the current playlist selection
  if (typeof _renderCSLibrary === 'function') { _renderCSLibrary(); }
}

function _csMusicRenderScheduleEntries(playlistId) {
  var entries = _csMusic.schedule.filter(function(e) { return e.playlistId === playlistId; });
  if (!entries.length) return '';
  return '<div style="margin-top:6px;">' +
    entries.map(function(e, idx) {
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(0,174,239,0.06);">' +
        '<span style="font-size:11px;color:#d8eeff;">▶ ' + _esc(e.time || '—') + '</span>' +
        '<button onclick="snxCSMusicRemoveSchedule(' + idx + ')" style="background:none;border:none;color:#ff3355;font-size:13px;cursor:pointer;">×</button>' +
      '</div>';
    }).join('') +
  '</div>';
}

window.snxCSMusicAddSchedule = function(playlistId) {
  var timeEl = document.getElementById('snxCSPlScheduleTime');
  var time   = timeEl ? timeEl.value : '';
  if (!time) { _toastError('Select a time first.'); return; }
  _csMusic.schedule.push({ playlistId: playlistId, time: time });
  _csMusicPushScheduleToWorker();
  _renderCSPlaylistPanel();
  _toast('Scheduled: ' + time);
};

window.snxCSMusicRemoveSchedule = function(idx) {
  _csMusic.schedule.splice(idx, 1);
  _csMusicPushScheduleToWorker();
  _renderCSPlaylistPanel();
};

function _csMusicPushScheduleToWorker() {
  if (!_state.cloudStreamId || !_state.user) return;
  _cloudStreamRPC({ action: 'setSchedule', schedule: _csMusic.schedule });
}

/* ═══════════════════════════════════════════════════════
   16. SETTINGS PERSISTENCE
═══════════════════════════════════════════════════════ */
function _loadStudioSettings() {
  if (!_state.user || !window._snxFirestore) return;
  var fs = window._snxFirestore;
  fs.getDoc(fs.doc(fs.db, 'studioSettings', _state.user.uid))
    .then(function(snap) {
      if (snap && snap.exists()) {
        var data = snap.data();
        if (data.themeId) {
          var t = THEMES.find(function(x) { return x.id === data.themeId; });
          if (t) _state.currentTheme = t;
        }
        if (data.filterId) {
          var f = CAMERA_FILTERS.find(function(x) { return x.id === data.filterId; });
          if (f) { _state.currentFilter = f; _applyFilterToPreview(f); }
        }
        if (data.scenePlaylist) _state.scenePlaylist = data.scenePlaylist;
      }
    })
    .catch(function() {});
}

function _saveStudioSettings() {
  if (!_state.user || !window._snxFirestore) return;
  var fs = window._snxFirestore;
  fs.setDoc(fs.doc(fs.db, 'studioSettings', _state.user.uid), {
    themeId:       _state.currentTheme.id,
    filterId:      _state.currentFilter ? _state.currentFilter.id : 'none',
    scenePlaylist: _state.scenePlaylist,
    updatedAt:     fs.serverTimestamp()
  }, { merge: true }).catch(function() {});
}

/* ═══════════════════════════════════════════════════════
   17. ADMIN — CLOUDSTREAM MONITOR
═══════════════════════════════════════════════════════ */
window.snxAdminLoadCloudStreams = function() {
  var el = document.getElementById('snxAdminCloudStreamList');
  if (!el) return;
  if (!window._snxFirestore) { el.innerHTML = '<div class="snx-empty-state">Firestore not ready.</div>'; return; }
  var fs = window._snxFirestore;
  el.innerHTML = '<div style="text-align:center;padding:20px;color:#3a5a7a;">Loading active streams…</div>';
  fs.getDocs(fs.query(
    fs.collection(fs.db, 'cloudStreams'),
    fs.where('status', 'in', ['active', 'starting', 'recovering', 'failed']),
    fs.orderBy('createdAt', 'desc'),
    fs.limit(20)
  )).then(function(snap) {
    if (!snap || !snap.docs || !snap.docs.length) {
      el.innerHTML = '<div class="snx-empty-state"><div class="empty-icon">☁️</div>No active CloudStreams.</div>';
      return;
    }
    el.innerHTML = snap.docs.map(function(doc) {
      var d = doc.data();
      var statusColor = d.status === 'active' ? '#00d4ff' : d.status === 'failed' ? '#ff3355' : '#ffaa00';
      return '<div class="snx-admin-stream-card">' +
        '<div class="snx-admin-stream-header">' +
          '<span style="font-size:18px;">☁️</span>' +
          '<span class="snx-admin-stream-name">' + _esc(d.streamName || 'Untitled') + '</span>' +
          '<span class="snx-tag" style="color:' + statusColor + ';border-color:' + statusColor + '">' + _esc(d.status || 'unknown').toUpperCase() + '</span>' +
        '</div>' +
        '<div style="font-size:11px;color:#4a7a9a;margin-bottom:8px;">' +
          'Creator: ' + _esc(d.uid || '—') + ' · Theme: ' + _esc(d.theme || '—') +
          ' · Viewers: ' + (d.viewerCount || 0) +
        '</div>' +
        '<div class="snx-admin-stream-actions">' +
          '<button class="snx-admin-stream-btn danger" onclick="snxAdminStopStream(\'' + doc.id + '\',\'' + _esc(d.uid || '') + '\')">⛔ Stop</button>' +
          '<button class="snx-admin-stream-btn" onclick="snxAdminViewStreamLogs(\'' + doc.id + '\')">📋 Logs</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }).catch(function(err) {
    el.innerHTML = '<div class="snx-empty-state">Error loading streams: ' + _esc(err.message) + '</div>';
  });
};

window.snxAdminStopStream = function(streamId, uid) {
  if (!confirm('Force-stop stream ' + streamId + '?')) return;
  var adminUid = _state.user ? _state.user.uid : '';
  _snxWorkerHeaders().then(function(headers) {
    return fetch(CLOUDSTREAM_WORKER_URL + '/api/admin/stream/stop', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ streamId: streamId, adminUid: adminUid })
    });
  }).then(function(r) { return r.json(); })
  .then(function(data) {
    if (!data.success) { _toastError(data.error || 'Admin stop failed.'); return; }
    if (window._snxFirestore) {
      var fs = window._snxFirestore;
      fs.updateDoc(fs.doc(fs.db, 'cloudStreams', streamId), { status: 'stopped', stoppedBy: 'admin' }).catch(function() {});
    }
    _toast('Stream stopped by admin.');
    snxAdminLoadCloudStreams();
  })
  .catch(function(e) { _toastError('Could not stop stream: ' + e.message); });
};

window.snxAdminViewStreamLogs = function(streamId) {
  _toast('Logs for stream ' + streamId + ' — check cloudStreamEvents collection in Firebase Console.');
};

/* ═══════════════════════════════════════════════════════
   18. UTILITIES
═══════════════════════════════════════════════════════ */
function _getVal(id) {
  var el = document.getElementById(id);
  return el ? el.value : '';
}

function _esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function _formatDuration(secs) {
  if (!secs) return '0:00';
  var m = Math.floor(secs / 60);
  var s = secs % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

/* ═══════════════════════════════════════════════════════
   19. STUDIO DIAGNOSTIC
   Owner-only live status panel. Shows exactly what state
   each component is in so creator/support can identify
   which step failed. Never exposes secrets or tokens.
═══════════════════════════════════════════════════════ */
window.snxToggleStudioDiag = function() {
  var card = document.getElementById('snxCSPreDiagCard');
  if (!card) return;
  var visible = card.style.display !== 'none';
  card.style.display = visible ? 'none' : '';
  if (!visible) snxRefreshStudioDiag();
};

window.snxRefreshStudioDiag = function() {
  // Supports two panel locations:
  //   snxCSDiagBody    — injected by _renderCloudStreamActive (active state)
  //   snxCSDiagPreBody — static HTML in setup/pre-launch panel
  var bodyEl = document.getElementById('snxCSDiagBody') ||
               document.getElementById('snxCSDiagPreBody');
  if (!bodyEl) return;

  var uid = _state.user ? _state.user.uid : null;

  function _diagRow(label, val, cls) {
    var colorMap = { ok: '#00d4ff', warn: '#ffbb00', err: '#ff3355' };
    var color = colorMap[cls] || '#d8eeff';
    return '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:2px;">' +
      '<span style="color:#4a7a9a;min-width:145px;flex-shrink:0;">' + _esc(label) + '</span>' +
      '<span style="color:' + color + ';font-weight:' + (cls ? '600' : '400') + ';">' + _esc(String(val == null ? '—' : val)) + '</span>' +
    '</div>';
  }

  if (!uid) {
    bodyEl.innerHTML = _diagRow('Creator', 'NOT AUTHENTICATED — please sign in', 'err');
    return;
  }

  // Build synchronous rows first
  var html = '';
  html += '<div style="color:#00AEEF;font-weight:700;margin-bottom:4px;">Creator</div>';
  html += _diagRow('Auth UID',       uid,  'ok');
  html += _diagRow('Display Name',   (_state.userData && (_state.userData.displayName || _state.userData.username)) || '(no profile name)');
  html += _diagRow('Auth Provider',  (_state.user.providerData && _state.user.providerData[0] ? _state.user.providerData[0].providerId : 'unknown'));
  html += '<div style="color:#00AEEF;font-weight:700;margin:6px 0 4px;">Studio Session</div>';
  html += _diagRow('CloudStream ID',    _state.cloudStreamId || '(none yet)', _state.cloudStreamId ? 'ok' : '');
  html += _diagRow('CloudStream Status', _state.cloudStatus || 'draft', _state.cloudStatus === 'active' ? 'ok' : _state.cloudStatus === 'failed' ? 'err' : '');
  html += '<div style="color:#00AEEF;font-weight:700;margin:6px 0 4px;">Feed Visibility</div>';
  html += _diagRow('liveRooms doc ID', uid + ' (= your UID)');
  html += _diagRow('Feed Entry Status', 'checking…');
  html += '<div style="color:#00AEEF;font-weight:700;margin:6px 0 4px;">CloudStream Worker</div>';
  html += _diagRow('Worker URL', CLOUDSTREAM_WORKER_URL);
  html += _diagRow('Worker Status', _state.cloudStreamId ? 'checking…' : 'no stream started');

  bodyEl.innerHTML = html;

  // Async: check liveRooms doc in Firestore
  if (window._snxFirestore) {
    var fs = window._snxFirestore;
    fs.getDoc(fs.doc(fs.db, 'liveRooms', uid))
      .then(function(snap) {
        var feedStatus, feedClass;
        if (snap && snap.exists()) {
          var d = snap.data();
          var isActive = d.isLive === true && d.status === 'live';
          var isCS     = d.type === '24hour_cloudstream';
          if (isActive && isCS) {
            feedStatus = 'ACTIVE — cloudStreamId=' + (d.cloudStreamId || '?') + ' — other devices CAN see this stream ✓';
            feedClass  = 'ok';
          } else if (isActive) {
            feedStatus = 'LIVE but wrong type: ' + (d.type || 'unknown') + ' (expected 24hour_cloudstream)';
            feedClass  = 'warn';
          } else {
            feedStatus = 'EXISTS but not live: isLive=' + d.isLive + ', status=' + (d.status || '?');
            feedClass  = 'warn';
          }
        } else {
          feedStatus = 'MISSING — no liveRooms doc for this UID. Other devices CANNOT see this stream.';
          feedClass  = _state.cloudStatus === 'active' ? 'err' : '';
        }
        _diagPatchRow(bodyEl, 'Feed Entry Status', feedStatus, feedClass);
      })
      .catch(function(e) {
        _diagPatchRow(bodyEl, 'Feed Entry Status',
          'READ ERROR (' + (e.code || 'unknown') + '): ' + e.message, 'err');
      });
  }

  // Async: ping the CloudStream Worker health endpoint
  if (_state.cloudStreamId) {
    fetch(CLOUDSTREAM_WORKER_URL + '/api/stream/health/' + _state.cloudStreamId)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var wStatus, wClass;
        if (data.success) {
          wStatus = 'ALIVE — status=' + (data.status || '?') +
            ', uptime=' + (data.uptime || 0) + 'm' +
            ', viewers=' + (data.viewerCount || 0);
          wClass  = data.status === 'active' ? 'ok' : 'warn';
        } else {
          wStatus = 'ERROR — ' + (data.error || 'unknown response');
          wClass  = 'err';
        }
        _diagPatchRow(bodyEl, 'Worker Status', wStatus, wClass);
      })
      .catch(function(e) {
        _diagPatchRow(bodyEl, 'Worker Status', 'UNREACHABLE — ' + e.message, 'err');
      });
  }
};

// Update a single labeled row that is already rendered inside bodyEl.
function _diagPatchRow(bodyEl, label, newVal, cls) {
  var colorMap = { ok: '#00d4ff', warn: '#ffbb00', err: '#ff3355' };
  var color = colorMap[cls] || '#d8eeff';
  var rows = bodyEl.querySelectorAll('div');
  for (var i = 0; i < rows.length; i++) {
    var spans = rows[i].querySelectorAll('span');
    if (spans.length >= 1 && spans[0].textContent.trim() === label) {
      if (spans[1]) {
        spans[1].textContent   = newVal;
        spans[1].style.color   = color;
        spans[1].style.fontWeight = cls ? '600' : '400';
      }
      return;
    }
  }
}

function _toast(msg) {
  if (typeof toastNotification === 'function') toastNotification(msg);
  else console.log('[Studio] ' + msg);
}

function _toastError(msg) {
  if (typeof toastNotification === 'function') toastNotification('⚠️ ' + msg);
  else console.error('[Studio] ' + msg);
}

function _showStudioError(msg) {
  var el = document.getElementById('snxStudioBody');
  if (el) el.innerHTML = '<div class="snx-empty-state" style="padding:40px"><div class="empty-icon">🔒</div>' + _esc(msg) + '</div>';
}

window.snxStudioSaveScene = function() {
  _toast('Scene saved to your account.');
  _saveStudioSettings();
};

window.snxMusicLibTab = function(tab, btn) {
  var tabs = ['library', 'queue', 'upload', 'schedule', 'visualizer'];
  tabs.forEach(function(t) {
    var el = document.getElementById('snxMusicTab_' + t);
    if (el) el.style.display = (t === tab ? '' : 'none');
  });
  document.querySelectorAll('#studioPage .snx-lib-tab').forEach(function(b) {
    b.classList.remove('active');
  });
  if (btn) btn.classList.add('active');
};

window.snxCSMusicLibTab = function(tab, btn) {
  var tabs = ['library', 'queue', 'upload'];
  tabs.forEach(function(t) {
    var el = document.getElementById('snxCSMusicTab_' + t);
    if (el) el.style.display = (t === tab ? '' : 'none');
  });
  // update active tab button within the CS panel only
  if (btn) {
    var parent = btn.closest('.snx-lib-tabs');
    if (parent) parent.querySelectorAll('.snx-lib-tab').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
  }
};

/* ═══════════════════════════════════════════════════════
   20. MUSIC LIBRARY — CONSTANTS & STATE
═══════════════════════════════════════════════════════ */
// Existing upload worker handles R2 storage (audio already supported)
var UPLOAD_WORKER_URL  = 'https://yellow-term-11e6.nthntjrn.workers.dev';
var MUSIC_CONCURRENCY  = 3;   // parallel uploads at once
var MUSIC_RETRY_MAX    = 3;   // retries per failed file
var MUSIC_MAX_FILES    = 1000;

var _music = {
  tracks:        [],   // Firestore-persisted library
  queue:         [],   // active playback queue (track objects)
  queueIndex:    0,
  shuffle:       false,
  repeat:        false,
  playing:       false,
  currentAudio:  null, // HTMLAudioElement
  progressTimer: null,
  // upload state
  uploadFiles:   [],   // File objects selected
  uploadJobs:    [],   // { file, trackId, status, retries, progress }
  uploadPaused:  false,
  uploadCancelled: false,
  uploadActive:  0,    // in-flight count
  uploadDone:    0,
  uploadFailed:  0,
  uploadTotal:   0,
  // destinations
  destinations:  [],   // loaded from worker KV
  schedule:      [],   // scheduled playlist entries
  visPreset:     'bars'
};

/* ═══════════════════════════════════════════════════════
   21. MUSIC LIBRARY — FIRESTORE HELPERS
═══════════════════════════════════════════════════════ */
function _mlFs() { return window._snxFirestore || null; }

function _mlSaveTrack(track) {
  var fs = _mlFs(); if (!fs || !_state.user) return;
  fs.setDoc(fs.doc(fs.db, 'cloudStreamTracks', _state.user.uid, 'tracks', track.id), track, { merge: true })
    .catch(function() {});
}

function _mlLoadTracks() {
  var fs = _mlFs(); if (!fs || !_state.user) return;
  fs.getDocs(fs.query(
    fs.collection(fs.db, 'cloudStreamTracks', _state.user.uid, 'tracks'),
    fs.orderBy('uploadedAt', 'desc'),
    fs.limit(1000)
  )).then(function(snap) {
    _music.tracks = [];
    if (snap && snap.docs) {
      snap.docs.forEach(function(d) { _music.tracks.push(Object.assign({ id: d.id }, d.data())); });
    }
    _renderLibrary();
    _renderNowPlayingBar();
    // Also populate the CS library list if it is currently visible
    if (typeof _renderCSLibrary === 'function') { _renderCSLibrary(); }
  }).catch(function() {});
}

/* ═══════════════════════════════════════════════════════
   22. BATCH UPLOAD ENGINE
═══════════════════════════════════════════════════════ */
window.snxMusicOpenFilePicker = function() {
  var inp = document.getElementById('snxMusicFileInput');
  if (inp) inp.click();
};

window.snxMusicFilesSelected = function(event) {
  var files = event.target.files;
  if (!files || !files.length) return;
  if (!_state.user) { _toastError('Please sign in before uploading music.'); return; }

  var accepted = [];
  for (var i = 0; i < files.length && accepted.length < MUSIC_MAX_FILES; i++) {
    var f = files[i];
    if (f.type.startsWith('audio/') || /\.(mp3|m4a|aac|ogg|wav|flac|opus|weba)$/i.test(f.name)) {
      accepted.push(f);
    }
  }
  if (!accepted.length) { _toastError('No valid audio files found. Select MP3, M4A, AAC, OGG, WAV, or FLAC files.'); return; }

  _music.uploadFiles     = accepted;
  _music.uploadTotal     = accepted.length;
  _music.uploadDone      = 0;
  _music.uploadFailed    = 0;
  _music.uploadActive    = 0;
  _music.uploadPaused    = false;
  _music.uploadCancelled = false;
  _music.uploadJobs      = accepted.map(function(f, idx) {
    return { file: f, trackId: _genId(), status: 'pending', retries: 0, progress: 0, index: idx };
  });

  _showUploadDashboard();
  _toast(accepted.length + ' track' + (accepted.length > 1 ? 's' : '') + ' selected — starting upload queue…');
  _processUploadQueue();
};

function _processUploadQueue() {
  if (_music.uploadCancelled) return;

  // Fill concurrency slots
  var pending = _music.uploadJobs.filter(function(j) { return j.status === 'pending'; });
  while (_music.uploadActive < MUSIC_CONCURRENCY && pending.length > 0 && !_music.uploadPaused) {
    var job = pending.shift();
    job.status = 'uploading';
    _music.uploadActive++;
    _uploadOneTrack(job);
  }
  _renderUploadDashboard();
}

function _uploadOneTrack(job) {
  var uid    = _state.user.uid;
  var key    = 'music/' + uid + '/' + job.trackId + '/' + job.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  var form   = new FormData();
  form.append('file', job.file, job.file.name);
  form.append('uid', uid);
  form.append('path', key);

  // Extract client-side metadata (async duration detection via HTMLAudioElement)
  var baseMeta = _extractFileMeta(job.file);

  // Write Firestore track doc as 'uploading' immediately (duration = 0, updated after detection)
  var trackDoc = {
    id:         job.trackId,
    uid:        uid,
    title:      baseMeta.title,
    artist:     baseMeta.artist,
    album:      baseMeta.album,
    duration:   0,
    fileSize:   job.file.size,
    status:     'uploading',
    r2Key:      key,
    uploadedAt: Date.now(),
    url:        null
  };
  _mlSaveTrack(trackDoc);

  // Detect actual audio duration asynchronously
  _detectAudioDuration(job.file, function(detectedDuration) {
    if (detectedDuration > 0) {
      trackDoc.duration = detectedDuration;
      // Patch in-memory entry if it already exists
      var idx = _music.tracks.findIndex(function(t) { return t.id === job.trackId; });
      if (idx !== -1) _music.tracks[idx].duration = detectedDuration;
      // Update Firestore with real duration (only if still uploading/ready)
      if (window._snxFirestore && _state.user) {
        var fs2 = window._snxFirestore;
        fs2.updateDoc(fs2.doc(fs2.db, 'cloudStreamTracks', uid, 'tracks', job.trackId), {
          duration: detectedDuration
        }).catch(function(){});
      }
      _renderLibrary();
    }
  });

  // XHR so we can track per-file progress
  var xhr = new XMLHttpRequest();
  xhr.open('POST', UPLOAD_WORKER_URL + '/');
  xhr.setRequestHeader('X-User-UID', uid);

  xhr.upload.onprogress = function(e) {
    if (e.lengthComputable) { job.progress = Math.round((e.loaded / e.total) * 100); }
    _renderUploadDashboard();
  };

  xhr.onload = function() {
    _music.uploadActive--;
    if (xhr.status === 200) {
      var res; try { res = JSON.parse(xhr.responseText); } catch(e) { res = {}; }
      job.status = 'done';
      _music.uploadDone++;
      // Update track doc as 'ready' with public URL
      trackDoc.status = 'ready';
      trackDoc.url    = res.url || res.publicUrl || '';
      _mlSaveTrack(trackDoc);
      // Add to in-memory library
      var existing = _music.tracks.findIndex(function(t) { return t.id === job.trackId; });
      if (existing === -1) _music.tracks.unshift(Object.assign({}, trackDoc));
      else _music.tracks[existing] = Object.assign({}, trackDoc);
    } else {
      _handleUploadFail(job, 'HTTP ' + xhr.status);
    }
    _renderUploadDashboard();
    _renderLibrary();
    if (typeof _renderCSLibrary === 'function') { _renderCSLibrary(); }
    _processUploadQueue();
  };

  xhr.onerror = function() {
    _music.uploadActive--;
    _handleUploadFail(job, 'Network error');
    _processUploadQueue();
  };

  xhr.send(form);
  job._xhr = xhr;
}

/* Detect actual audio duration using HTMLAudioElement (browser-native, no lib needed) */
function _detectAudioDuration(file, cb) {
  var url = null;
  try {
    url = URL.createObjectURL(file);
    var audio = new Audio();
    var done = false;
    var cleanup = function() {
      if (done) return; done = true;
      audio.src = '';
      try { URL.revokeObjectURL(url); } catch(e){}
    };
    audio.addEventListener('loadedmetadata', function() {
      var dur = isFinite(audio.duration) && audio.duration > 0 ? Math.round(audio.duration) : 0;
      cleanup();
      cb(dur);
    });
    audio.addEventListener('error', function() { cleanup(); cb(0); });
    // Timeout fallback in case metadata never fires (5 s)
    setTimeout(function() { cleanup(); cb(0); }, 5000);
    audio.preload = 'metadata';
    audio.src = url;
  } catch(e) {
    if (url) { try { URL.revokeObjectURL(url); } catch(_){} }
    cb(0);
  }
}

function _handleUploadFail(job, reason) {
  job.retries++;
  if (job.retries <= MUSIC_RETRY_MAX) {
    job.status = 'pending'; // requeue
    _toast('Retrying: ' + job.file.name + ' (attempt ' + job.retries + ')');
  } else {
    job.status = 'failed';
    _music.uploadFailed++;
    _mlSaveTrack({ id: job.trackId, uid: _state.user.uid, title: _extractFileMeta(job.file).title,
                   status: 'failed', fileSize: job.file.size, uploadedAt: Date.now() });
    _toastError('Upload failed: ' + job.file.name + ' — ' + reason);
  }
}

window.snxUploadPause = function() {
  _music.uploadPaused = true;
  _renderUploadDashboard();
  _toast('Upload paused.');
};
window.snxUploadResume = function() {
  _music.uploadPaused = false;
  _renderUploadDashboard();
  _processUploadQueue();
};
window.snxUploadCancel = function() {
  if (!confirm('Cancel all remaining uploads?')) return;
  _music.uploadCancelled = true;
  _music.uploadJobs.forEach(function(j) {
    if (j._xhr && j.status === 'uploading') { try { j._xhr.abort(); } catch(e){} }
    if (j.status === 'pending' || j.status === 'uploading') j.status = 'cancelled';
  });
  _renderUploadDashboard();
  _toast('Upload queue cancelled.');
};
window.snxUploadRetryFailed = function() {
  _music.uploadJobs.forEach(function(j) {
    if (j.status === 'failed') { j.status = 'pending'; j.retries = 0; }
  });
  _music.uploadFailed = 0;
  _music.uploadCancelled = false;
  _music.uploadPaused  = false;
  _processUploadQueue();
};

function _extractFileMeta(file) {
  // Filename-based metadata extraction (no ID3 lib required; duration detected separately)
  var name   = file.name.replace(/\.(mp3|m4a|aac|ogg|wav|flac|opus)$/i, '');
  var parts  = name.split(' - ');
  var artist = parts.length > 1 ? parts[0].trim() : 'Unknown Artist';
  var title  = parts.length > 1 ? parts.slice(1).join(' - ').trim() : name;
  return { title: title, artist: artist, album: '', duration: 0 };
}

function _genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ═══════════════════════════════════════════════════════
   23. UPLOAD DASHBOARD RENDER
═══════════════════════════════════════════════════════ */
function _showUploadDashboard() {
  var el = document.getElementById('snxUploadDashboard');
  if (el) el.style.display = '';
  _renderUploadDashboard();
}

function _renderUploadDashboard() {
  var el = document.getElementById('snxUploadDashboard');
  if (!el) return;
  var total   = _music.uploadTotal;
  var done    = _music.uploadDone;
  var failed  = _music.uploadFailed;
  var pct     = total > 0 ? Math.round((done / total) * 100) : 0;
  var remaining = total - done - failed;
  var pending = _music.uploadJobs.filter(function(j) { return j.status === 'uploading'; });
  var currentFile = pending.length ? pending[0].file.name : (done === total ? 'All done!' : '—');

  // Calculate speed (rough estimate)
  var speed = '—';

  el.innerHTML =
    '<div class="snx-upload-dashboard">' +
      '<div class="snx-upload-header">' +
        '<span class="snx-upload-title">&#127925; Uploading Music</span>' +
        '<span class="snx-upload-badge">' + done + ' / ' + total + '</span>' +
      '</div>' +
      '<div class="snx-upload-progress-bar-wrap"><div class="snx-upload-progress-bar" style="width:' + pct + '%"></div></div>' +
      '<div class="snx-upload-stats">' +
        '<div class="snx-upload-stat"><div class="us-val">' + pct + '%</div><div class="us-lbl">Progress</div></div>' +
        '<div class="snx-upload-stat"><div class="us-val">' + done + '</div><div class="us-lbl">Done</div></div>' +
        '<div class="snx-upload-stat"><div class="us-val" style="color:' + (failed > 0 ? '#ff3355' : '#39ff14') + '">' + failed + '</div><div class="us-lbl">Failed</div></div>' +
        '<div class="snx-upload-stat"><div class="us-val">' + remaining + '</div><div class="us-lbl">Remaining</div></div>' +
        '<div class="snx-upload-stat"><div class="us-val">' + _music.uploadActive + '</div><div class="us-lbl">Active</div></div>' +
        '<div class="snx-upload-stat"><div class="us-val">' + total + '</div><div class="us-lbl">Total</div></div>' +
      '</div>' +
      '<div class="snx-upload-current">&#9654; ' + _esc(currentFile) + '</div>' +
      '<div class="snx-upload-controls">' +
        (_music.uploadPaused
          ? '<button class="snx-upload-ctl-btn" onclick="snxUploadResume()">&#9654; Resume</button>'
          : '<button class="snx-upload-ctl-btn" onclick="snxUploadPause()">&#9646;&#9646; Pause</button>') +
        (failed > 0 ? '<button class="snx-upload-ctl-btn" onclick="snxUploadRetryFailed()">&#8635; Retry Failed (' + failed + ')</button>' : '') +
        '<button class="snx-upload-ctl-btn danger" onclick="snxUploadCancel()">&#10005; Cancel</button>' +
      '</div>' +
    '</div>';
}

/* ═══════════════════════════════════════════════════════
   24. LIBRARY RENDER
═══════════════════════════════════════════════════════ */

/* Library-level state for preview and multi-select */
var _libPreview = { trackId: null, audio: null, playing: false, raf: null };
var _libMultiSelect = { active: false, selected: {} };

function _renderLibrary() {
  var listEl  = document.getElementById('snxTrackLibraryList');
  var countEl = document.getElementById('snxTrackLibraryCount');
  var msBar   = document.getElementById('snxLibMultiSelectBar');
  if (!listEl) return;

  var q       = (document.getElementById('snxLibSearch') || {}).value || '';
  var tracks  = _music.tracks.filter(function(t) {
    if (!q) return true;
    var ql = q.toLowerCase();
    return (t.title  || '').toLowerCase().includes(ql) ||
           (t.artist || '').toLowerCase().includes(ql) ||
           (t.album  || '').toLowerCase().includes(ql);
  });

  if (countEl) countEl.textContent = tracks.length + ' track' + (tracks.length !== 1 ? 's' : '');

  // Multi-select toolbar visibility
  if (msBar) {
    var selCount = Object.keys(_libMultiSelect.selected).length;
    msBar.style.display = _libMultiSelect.active ? '' : 'none';
    var selCountEl = document.getElementById('snxLibSelCount');
    if (selCountEl) selCountEl.textContent = selCount + ' selected';
  }

  if (!tracks.length) {
    listEl.innerHTML = '<div class="snx-empty-state"><div class="empty-icon">&#127925;</div>No tracks yet.<br>Upload music to build your library.</div>';
    return;
  }

  listEl.innerHTML = tracks.map(function(t) {
    var inQueue    = _music.queue.some(function(qi) { return qi.id === t.id; });
    var isCurrent  = _music.queue[_music.queueIndex] && _music.queue[_music.queueIndex].id === t.id && _music.playing;
    var isPreviewing = _libPreview.trackId === t.id && _libPreview.playing;
    var isSelected = !!_libMultiSelect.selected[t.id];
    var isReady    = t.status === 'ready';
    var durText    = (t.duration && t.duration > 0) ? _formatDuration(t.duration) : '—';

    return '<div class="snx-track-item' + (isCurrent ? ' playing' : '') + (isSelected ? ' snx-track-selected' : '') + '" data-tid="' + _esc(t.id) + '">' +
      // Checkbox (multi-select mode)
      (_libMultiSelect.active
        ? '<label class="snx-track-check"><input type="checkbox"' + (isSelected ? ' checked' : '') +
          ' onchange="snxLibToggleSelect(\'' + _esc(t.id) + '\',this.checked)"></label>'
        : '') +
      // Artwork / play toggle
      '<div class="snx-track-artwork snx-track-play-art" onclick="snxLibPreviewToggle(\'' + _esc(t.id) + '\',\'' + _esc(t.url || '') + '\')" title="' + (isPreviewing ? 'Pause preview' : 'Preview') + '">' +
        (isPreviewing ? '<span class="snx-lib-play-icon playing">&#9646;&#9646;</span>' : '<span class="snx-lib-play-icon">&#9654;</span>') +
      '</div>' +
      // Info + preview progress bar — clicking info area adds to queue and plays
      '<div class="snx-track-info" style="cursor:pointer;" onclick="snxMusicPlayFromLibrary(\'' + _esc(t.id) + '\');event.stopPropagation();" title="Click to play">' +
        '<div class="snx-track-title">' + _esc(t.title || 'Untitled') + '</div>' +
        '<div class="snx-track-artist">' + _esc(t.artist || 'Unknown Artist') + '</div>' +
        (isPreviewing
          ? '<div class="snx-lib-preview-bar">' +
              '<span class="snx-lib-preview-pos" id="snxLibPrevPos_' + _esc(t.id) + '">0:00</span>' +
              '<div class="snx-lib-preview-track" onclick="snxLibPreviewSeek(event,\'' + _esc(t.id) + '\');event.stopPropagation();" title="Seek">' +
                '<div class="snx-lib-preview-fill" id="snxLibPrevFill_' + _esc(t.id) + '" style="width:0%"></div>' +
              '</div>' +
              '<span class="snx-lib-preview-dur">' + durText + '</span>' +
            '</div>'
          : '') +
      '</div>' +
      // Meta: duration + status + action buttons
      '<div class="snx-track-meta">' +
        '<span class="snx-track-dur">' + durText + '</span>' +
        '<span class="snx-track-status ' + (t.status || 'ready') + '">' + (t.status === 'uploading' ? '↑' : t.status || 'ready') + '</span>' +
        (isReady
          ? '<div class="snx-track-add-btn" onclick="snxMusicAddToQueue(\'' + _esc(t.id) + '\')" title="' + (inQueue ? 'In queue' : 'Add to queue') + '">' +
              (inQueue ? '&#10003;' : '+') + '</div>' +
            '<button class="snx-track-pl-btn" onclick="snxLibShowPlaylistPicker(\'' + _esc(t.id) + '\')" title="Add to Playlist">&#9868;</button>'
          : '') +
      '</div>' +
    '</div>';
  }).join('');
}

window.snxLibSearch = function() { _renderLibrary(); };

/* ── Library preview (per-track ▶ with seekable progress bar) ── */
window.snxLibPreviewToggle = function(trackId, url) {
  if (_libPreview.trackId === trackId && _libPreview.playing) {
    // Pause
    if (_libPreview.audio) { _libPreview.audio.pause(); }
    _libPreview.playing = false;
    cancelAnimationFrame(_libPreview.raf);
    _renderLibrary();
    return;
  }
  // Stop previous
  _libPreviewStop();
  if (!url) { _toastError('No audio URL. Track may still be uploading.'); return; }
  var audio = new Audio(url);
  audio.crossOrigin = 'anonymous';
  _libPreview.audio   = audio;
  _libPreview.trackId = trackId;
  _libPreview.playing = true;

  audio.addEventListener('ended', function() {
    _libPreview.playing = false;
    cancelAnimationFrame(_libPreview.raf);
    _renderLibrary();
  });
  audio.addEventListener('error', function() {
    _toastError('Cannot preview this track.');
    _libPreviewStop();
    _renderLibrary();
  });

  audio.play().then(function() {
    _renderLibrary();
    _libPreviewTick(trackId);
  }).catch(function(e) {
    _toastError('Preview failed: ' + e.message);
    _libPreviewStop();
    _renderLibrary();
  });
};

function _libPreviewTick(trackId) {
  _libPreview.raf = requestAnimationFrame(function() {
    if (!_libPreview.playing || _libPreview.trackId !== trackId) return;
    var audio = _libPreview.audio;
    if (!audio) return;
    var pos  = audio.currentTime;
    var dur  = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    var pct  = dur > 0 ? (pos / dur) * 100 : 0;
    var posEl  = document.getElementById('snxLibPrevPos_' + trackId);
    var fillEl = document.getElementById('snxLibPrevFill_' + trackId);
    if (posEl)  posEl.textContent = _formatDuration(Math.floor(pos));
    if (fillEl) fillEl.style.width = pct.toFixed(1) + '%';
    _libPreviewTick(trackId);
  });
}

function _libPreviewStop() {
  if (_libPreview.audio) {
    _libPreview.audio.pause();
    _libPreview.audio.src = '';
    _libPreview.audio = null;
  }
  cancelAnimationFrame(_libPreview.raf);
  _libPreview.playing = false;
  _libPreview.trackId = null;
}

window.snxLibPreviewSeek = function(evt, trackId) {
  if (_libPreview.trackId !== trackId || !_libPreview.audio) return;
  var bar = evt.currentTarget;
  var rect = bar.getBoundingClientRect();
  var ratio = Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width));
  var dur = _libPreview.audio.duration;
  if (isFinite(dur) && dur > 0) { _libPreview.audio.currentTime = ratio * dur; }
};

/* ── Multi-select ── */
window.snxLibToggleMultiSelect = function() {
  _libMultiSelect.active = !_libMultiSelect.active;
  _libMultiSelect.selected = {};
  _renderLibrary();
};

window.snxLibToggleSelect = function(trackId, checked) {
  if (checked) _libMultiSelect.selected[trackId] = true;
  else delete _libMultiSelect.selected[trackId];
  // Update count in toolbar without full re-render
  var selCountEl = document.getElementById('snxLibSelCount');
  var selCount = Object.keys(_libMultiSelect.selected).length;
  if (selCountEl) selCountEl.textContent = selCount + ' selected';
};

window.snxLibSelectAll = function() {
  var q = (document.getElementById('snxLibSearch') || {}).value || '';
  _music.tracks.filter(function(t) {
    if (!q) return true;
    var ql = q.toLowerCase();
    return (t.title||'').toLowerCase().includes(ql)||(t.artist||'').toLowerCase().includes(ql);
  }).forEach(function(t) { _libMultiSelect.selected[t.id] = true; });
  _renderLibrary();
};

window.snxLibBulkAddToPlaylist = function() {
  var ids = Object.keys(_libMultiSelect.selected);
  if (!ids.length) { _toastError('Select at least one track.'); return; }
  _libShowPlaylistPicker(null, ids);
};

/* ── Playlist picker modal ── */
window.snxLibShowPlaylistPicker = function(singleTrackId) {
  _libShowPlaylistPicker(singleTrackId, singleTrackId ? [singleTrackId] : []);
};

function _libShowPlaylistPicker(singleTrackId, trackIds) {
  var ids = trackIds && trackIds.length ? trackIds : (singleTrackId ? [singleTrackId] : []);
  if (!ids.length) return;

  // Remove any existing picker
  var old = document.getElementById('snxLibPlPicker');
  if (old) old.remove();

  var overlay = document.createElement('div');
  overlay.id = 'snxLibPlPicker';
  overlay.className = 'snx-lib-pl-picker-overlay';

  var plOptions = _csMusic.playlists.map(function(pl) {
    return '<button class="snx-lib-pl-pick-btn" onclick="snxLibPickerAddToPlaylist(\'' + _esc(pl.id) + '\',\'' + _esc(JSON.stringify(ids)) + '\')">' +
      '<span class="snx-lib-pl-pick-name">' + _esc(pl.name) + '</span>' +
      '<span class="snx-lib-pl-pick-count">' + (pl.trackIds ? pl.trackIds.length : 0) + ' tracks</span>' +
    '</button>';
  }).join('');

  overlay.innerHTML =
    '<div class="snx-lib-pl-picker">' +
      '<div class="snx-lib-pl-picker-header">' +
        '<span>Add to Playlist</span>' +
        '<button class="snx-lib-pl-picker-close" onclick="snxLibClosePicker()">&#10005;</button>' +
      '</div>' +
      '<div class="snx-lib-pl-picker-list">' +
        (plOptions || '<div style="color:#4a7a9a;font-size:12px;padding:8px 0;">No playlists yet.</div>') +
      '</div>' +
      '<button class="snx-lib-pl-pick-new" onclick="snxLibPickerNewPlaylist(\'' + _esc(JSON.stringify(ids)) + '\')">' +
        '+ Create New Playlist' +
      '</button>' +
    '</div>';

  // Close on overlay click
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

window.snxLibClosePicker = function() {
  var el = document.getElementById('snxLibPlPicker');
  if (el) el.remove();
};

window.snxLibPickerAddToPlaylist = function(playlistId, idsJson) {
  var ids; try { ids = JSON.parse(idsJson); } catch(e) { ids = []; }
  if (!ids.length || !playlistId) return;
  snxLibClosePicker();

  var pl = _csMusic.playlists.find(function(p) { return p.id === playlistId; });
  if (!pl) { _toastError('Playlist not found.'); return; }
  if (!_state.user || !window._snxFirestore) return;
  var fs  = window._snxFirestore;
  var uid = _state.user.uid;
  var added = 0;
  ids.forEach(function(id) { if (!pl.trackIds.includes(id)) { pl.trackIds.push(id); added++; } });
  if (!added) { _toast('Track(s) already in playlist.'); return; }
  fs.updateDoc(fs.doc(fs.db, 'studioPlaylists', uid, 'playlists', playlistId), {
    trackIds: pl.trackIds
  }).then(function() {
    _toast(added + ' track' + (added > 1 ? 's' : '') + ' added to "' + pl.name + '".');
    _libMultiSelect.selected = {};
    _renderCSPlaylistPanel();
  }).catch(function(e) { _toastError('Could not update playlist: ' + e.message); });
};

window.snxLibPickerNewPlaylist = function(idsJson) {
  var ids; try { ids = JSON.parse(idsJson); } catch(e) { ids = []; }
  snxLibClosePicker();
  var name = prompt('New playlist name:');
  if (!name || !name.trim()) return;
  if (!_state.user || !window._snxFirestore) { _toastError('Sign in required.'); return; }
  var fs  = window._snxFirestore;
  var uid = _state.user.uid;
  var id  = _csMusicGenId();
  var pl  = { id: id, name: name.trim(), trackIds: ids.slice(),
              shuffle: false, repeat: true, crossfade: 3, volume: 80, createdAt: fs.serverTimestamp() };
  fs.setDoc(fs.doc(fs.db, 'studioPlaylists', uid, 'playlists', id), pl)
    .then(function() {
      _csMusic.playlists.unshift(Object.assign({}, pl, { id: id, createdAt: Date.now() }));
      _toast('Playlist "' + name.trim() + '" created with ' + ids.length + ' track' + (ids.length > 1 ? 's' : '') + '.');
      _libMultiSelect.selected = {};
      _renderCSPlaylistPanel();
    })
    .catch(function(e) { _toastError('Could not create playlist: ' + e.message); });
};

function _renderNowPlayingBar() {
  var el = document.getElementById('snxNowPlayingBarEl');
  if (!el) return;
  var track = _music.queue[_music.queueIndex] || null;
  if (!track) {
    el.innerHTML =
      '<div class="snx-now-playing-bar">' +
        '<div class="snx-npb-top">' +
          '<div class="snx-npb-art">&#127925;</div>' +
          '<div class="snx-npb-info">' +
            '<div class="snx-npb-title">No track playing</div>' +
            '<div class="snx-npb-artist">Add tracks to the queue</div>' +
          '</div>' +
        '</div>' +
        '<div class="snx-npb-controls">' +
          '<div class="snx-npb-btn" onclick="snxMusicPrev()">&#9198;</div>' +
          '<div class="snx-npb-btn play" onclick="snxMusicPlayPause()">&#9654;</div>' +
          '<div class="snx-npb-btn" onclick="snxMusicNext()">&#9197;</div>' +
        '</div>' +
      '</div>';
    return;
  }
  el.innerHTML =
    '<div class="snx-now-playing-bar">' +
      '<div class="snx-npb-top">' +
        '<div class="snx-npb-art">&#127925;</div>' +
        '<div class="snx-npb-info">' +
          '<div class="snx-npb-title">' + _esc(track.title || 'Untitled') + '</div>' +
          '<div class="snx-npb-artist">' + _esc(track.artist || 'Unknown') + '</div>' +
        '</div>' +
        '<span class="snx-npb-badge">NOW PLAYING</span>' +
      '</div>' +
      '<div class="snx-npb-progress-row">' +
        '<span class="snx-npb-time" id="snxNpbCurrentTime">0:00</span>' +
        '<div class="snx-npb-progress-wrap" onclick="snxMusicSeek(event, this)">' +
          '<div class="snx-npb-progress-fill" id="snxNpbProgressFill"></div>' +
        '</div>' +
        '<span class="snx-npb-time" id="snxNpbTotalTime">' + _formatDuration(track.duration || 0) + '</span>' +
      '</div>' +
      '<div class="snx-npb-controls">' +
        '<div class="snx-npb-btn' + (_music.shuffle ? ' active' : '') + '" onclick="snxMusicToggleShuffle()" title="Shuffle">&#128256;</div>' +
        '<div class="snx-npb-btn" onclick="snxMusicPrev()">&#9198;</div>' +
        '<div class="snx-npb-btn play" onclick="snxMusicPlayPause()">' + (_music.playing ? '&#9646;&#9646;' : '&#9654;') + '</div>' +
        '<div class="snx-npb-btn" onclick="snxMusicNext()">&#9197;</div>' +
        '<div class="snx-npb-btn' + (_music.repeat ? ' active' : '') + '" onclick="snxMusicToggleRepeat()" title="Repeat">&#128257;</div>' +
      '</div>' +
      '<div class="snx-npb-vol-row">' +
        '<span style="font-size:11px;color:#4a7a9a;">&#128264;</span>' +
        '<input type="range" class="snx-range-slider" min="0" max="100" value="80" oninput="snxMusicSetVolume(this.value)">' +
        '<span style="font-size:11px;color:#4a7a9a;">&#128266;</span>' +
      '</div>' +
    '</div>';
}

function _renderQueue() {
  var el = document.getElementById('snxMusicQueueList');
  if (!el) return;
  if (!_music.queue.length) {
    el.innerHTML = '<div class="snx-empty-state"><div class="empty-icon">&#127925;</div>Queue is empty.<br>Add tracks from your library.</div>';
    return;
  }
  el.innerHTML = _music.queue.map(function(t, i) {
    var active = i === _music.queueIndex && _music.playing;
    return '<div class="snx-track-item' + (active ? ' playing' : '') + '">' +
      '<div class="snx-track-artwork">&#127925;</div>' +
      '<div class="snx-track-info">' +
        '<div class="snx-track-title">' + (active ? '&#9654; ' : (i + 1) + '. ') + _esc(t.title || 'Untitled') + '</div>' +
        '<div class="snx-track-artist">' + _esc(t.artist || 'Unknown') + '</div>' +
      '</div>' +
      '<div class="snx-track-meta">' +
        '<span class="snx-track-dur">' + _formatDuration(t.duration || 0) + '</span>' +
        '<div class="snx-track-add-btn" onclick="snxMusicRemoveFromQueue(' + i + ')" title="Remove" style="color:#ff3355;">&#10005;</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

/* ═══════════════════════════════════════════════════════
   25. REAL MUSIC PLAYBACK
═══════════════════════════════════════════════════════ */
window.snxMusicAddToQueue = function(trackId) {
  var track = _music.tracks.find(function(t) { return t.id === trackId; });
  if (!track) return;
  if (track.status !== 'ready') { _toastError('Track is not ready yet. Status: ' + track.status); return; }
  if (_music.queue.some(function(q) { return q.id === trackId; })) {
    _toastError('Track is already in the queue.'); return;
  }
  _music.queue.push(track);
  _renderQueue();
  _renderLibrary();
  _toast('Added: ' + (track.title || 'Untitled'));
  if (!_music.playing && _music.queue.length === 1) {
    _music.queueIndex = 0;
    _renderNowPlayingBar();
  }
};

/* ── Play a track from the library by clicking its info row ── */
window.snxMusicPlayFromLibrary = function(trackId) {
  var track = _music.tracks.find(function(t) { return t.id === trackId; });
  if (!track) return;
  if (track.status !== 'ready') { _toastError('Track is not ready yet. Status: ' + track.status); return; }
  // Add to queue if not already present
  if (!_music.queue.some(function(q) { return q.id === trackId; })) {
    _music.queue.push(track);
  }
  // Jump to this track and start playing
  _music.queueIndex = _music.queue.findIndex(function(q) { return q.id === trackId; });
  _stopAudio();
  _playAudio(track);
  _renderNowPlayingBar();
  _renderQueue();
  _renderLibrary();
};

window.snxMusicRemoveFromQueue = function(idx) {
  _music.queue.splice(idx, 1);
  if (_music.queueIndex >= _music.queue.length) _music.queueIndex = Math.max(0, _music.queue.length - 1);
  _renderQueue();
  _renderNowPlayingBar();
};

window.snxMusicAddAllToQueue = function() {
  var ready = _music.tracks.filter(function(t) { return t.status === 'ready'; });
  ready.forEach(function(t) {
    if (!_music.queue.some(function(q) { return q.id === t.id; })) _music.queue.push(t);
  });
  _renderQueue();
  _renderLibrary();
  _toast('Added ' + ready.length + ' tracks to queue.');
};

window.snxMusicPlayPause = function() {
  if (!_music.queue.length) { _toastError('Queue is empty. Add tracks to play.'); return; }
  var track = _music.queue[_music.queueIndex];
  if (!track) return;

  if (_music.playing) {
    _pauseAudio();
  } else {
    _playAudio(track);
  }
  _renderNowPlayingBar();
};

window.snxMusicNext = function() {
  if (!_music.queue.length) return;
  _stopAudio();
  if (_music.shuffle) {
    _music.queueIndex = Math.floor(Math.random() * _music.queue.length);
  } else {
    _music.queueIndex = (_music.queueIndex + 1) % _music.queue.length;
  }
  _playAudio(_music.queue[_music.queueIndex]);
  _renderNowPlayingBar();
  _renderQueue();
};

window.snxMusicPrev = function() {
  if (!_music.queue.length) return;
  _stopAudio();
  _music.queueIndex = (_music.queueIndex - 1 + _music.queue.length) % _music.queue.length;
  _playAudio(_music.queue[_music.queueIndex]);
  _renderNowPlayingBar();
  _renderQueue();
};

window.snxMusicToggleShuffle = function() {
  _music.shuffle = !_music.shuffle;
  _renderNowPlayingBar();
  _toast('Shuffle: ' + (_music.shuffle ? 'ON' : 'OFF'));
};
window.snxMusicToggleRepeat = function() {
  _music.repeat = !_music.repeat;
  _renderNowPlayingBar();
  _toast('Repeat: ' + (_music.repeat ? 'ON' : 'OFF'));
};
window.snxMusicSetVolume = function(val) {
  if (_music.currentAudio) _music.currentAudio.volume = parseFloat(val) / 100;
};
window.snxMusicSeek = function(evt, wrap) {
  if (!_music.currentAudio) return;
  var rect = wrap.getBoundingClientRect();
  var pct  = (evt.clientX - rect.left) / rect.width;
  _music.currentAudio.currentTime = pct * _music.currentAudio.duration;
};

function _playAudio(track) {
  if (!track || !track.url) {
    _toastError('Track has no audio URL. Re-upload may be needed.'); return;
  }
  _stopAudio();
  _music.playing = true;

  var audio = new Audio(track.url);
  audio.volume = 0.8;
  audio.crossOrigin = 'anonymous';
  _music.currentAudio = audio;

  audio.ontimeupdate = function() {
    var cur  = document.getElementById('snxNpbCurrentTime');
    var fill = document.getElementById('snxNpbProgressFill');
    if (cur)  cur.textContent  = _formatDuration(Math.floor(audio.currentTime));
    if (fill && audio.duration) fill.style.width = ((audio.currentTime / audio.duration) * 100) + '%';
  };

  audio.onended = function() {
    if (_music.queueIndex < _music.queue.length - 1) {
      window.snxMusicNext();
    } else if (_music.repeat) {
      _music.queueIndex = 0;
      _playAudio(_music.queue[0]);
      _renderNowPlayingBar();
    } else {
      _music.playing = false;
      _toast('Playlist ended. Enable Repeat or add more tracks.');
      _renderNowPlayingBar();
    }
  };

  audio.onerror = function() {
    _toastError('Audio playback error — trying next track.');
    window.snxMusicNext();
  };

  audio.play().catch(function(e) {
    _toastError('Playback failed: ' + e.message + '. Tap Play to try again.');
    _music.playing = false;
    _renderNowPlayingBar();
  });
}

function _pauseAudio() {
  if (_music.currentAudio) _music.currentAudio.pause();
  _music.playing = false;
}

function _stopAudio() {
  if (_music.currentAudio) { _music.currentAudio.pause(); _music.currentAudio.src = ''; }
  _music.currentAudio = null;
  _music.playing      = false;
}

/* ═══════════════════════════════════════════════════════
   26. STREAM DESTINATIONS
═══════════════════════════════════════════════════════ */
var DEST_TYPES = [
  { id: 'snx',     name: 'Shadow Nexus Social', icon: '&#127768;', alwaysOn: true },
  { id: 'youtube', name: 'YouTube',              icon: '&#127910;', alwaysOn: false },
  { id: 'facebook',name: 'Facebook',             icon: '&#128100;', alwaysOn: false },
  { id: 'custom',  name: 'Custom RTMP',          icon: '&#128225;', alwaysOn: false }
];

window.snxStudioLoadDestinations = function() {
  _renderDestinations();
  _loadDestinationStatuses();
};

function _renderDestinations() {
  var el = document.getElementById('snxDestinationList');
  if (!el) return;

  var html = DEST_TYPES.map(function(dtype) {
    var saved = _music.destinations.find(function(d) { return d.type === dtype.id; }) || {};
    var connected = dtype.alwaysOn || (saved.status === 'active');
    var statusText = dtype.alwaysOn ? '&#9989; Always connected'
                   : connected ? '&#9989; Configured &amp; active' : '&#9898; Not configured';
    return '<div class="snx-dest-card' + (connected ? ' connected' : '') + '" id="snxDestCard_' + dtype.id + '">' +
      '<div class="snx-dest-header">' +
        '<span class="snx-dest-icon">' + dtype.icon + '</span>' +
        '<span class="snx-dest-name">' + _esc(dtype.name) + '</span>' +
        '<span class="snx-dest-indicator' + (connected ? ' live' : '') + '"></span>' +
      '</div>' +
      '<div class="snx-dest-status">' + statusText + '</div>' +
      (dtype.alwaysOn ? '' :
        '<div class="snx-dest-actions">' +
          '<button class="snx-dest-btn" onclick="snxDestToggleConfig(\'' + dtype.id + '\')">' +
            (connected ? '&#9881; Configure' : '&#128279; Configure') +
          '</button>' +
          (connected ? '<button class="snx-dest-btn danger" onclick="snxDestRemove(\'' + dtype.id + '\')">&#10005; Remove</button>' : '') +
        '</div>' +
        '<div id="snxDestConfig_' + dtype.id + '" class="snx-dest-config" style="display:none;">' +
          _renderDestConfigForm(dtype.id, saved) +
        '</div>'
      ) +
      (connected && !dtype.alwaysOn ?
        '<div class="snx-dest-health">' +
          '<div class="snx-dest-health-tile"><div class="dht-val" id="snxDestBr_' + dtype.id + '">—</div><div class="dht-lbl">Bitrate</div></div>' +
          '<div class="snx-dest-health-tile"><div class="dht-val" id="snxDestFps_' + dtype.id + '">—</div><div class="dht-lbl">FPS</div></div>' +
          '<div class="snx-dest-health-tile"><div class="dht-val" id="snxDestLast_' + dtype.id + '">—</div><div class="dht-lbl">Last beat</div></div>' +
          '<div class="snx-dest-health-tile"><div class="dht-val" id="snxDestErr_' + dtype.id + '">0</div><div class="dht-lbl">Errors</div></div>' +
        '</div>' : '') +
    '</div>';
  }).join('');

  el.innerHTML = html;
}

function _renderDestConfigForm(type, saved) {
  var rtmpUrl = saved.rtmpUrl ? '&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;' : '';
  var streamKey = saved.streamKey ? '&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;' : '';
  var labels = {
    youtube:  { url: 'RTMP URL',   key: 'Stream Key',   urlPlaceholder: 'rtmp://a.rtmp.youtube.com/live2', note: 'Get your stream key from YouTube Studio → Go Live → Stream settings.' },
    facebook: { url: 'Stream URL', key: 'Stream Key',   urlPlaceholder: 'rtmps://live-api-s.facebook.com:443/rtmp/', note: 'Get from Facebook Live → Advanced → Stream Key.' },
    custom:   { url: 'RTMP URL',   key: 'Stream Key',   urlPlaceholder: 'rtmp://your-server/live', note: 'Any RTMP-compatible destination.' }
  };
  var lbl = labels[type] || labels.custom;
  return '<div class="snx-dest-config-field">' +
    '<div class="snx-dest-config-label">' + lbl.url + '</div>' +
    '<input class="snx-dest-key-input" type="url" id="snxDestUrl_' + type + '" placeholder="' + lbl.urlPlaceholder + '" autocomplete="off">' +
  '</div>' +
  '<div class="snx-dest-config-field">' +
    '<div class="snx-dest-config-label">' + lbl.key + '</div>' +
    '<input class="snx-dest-key-input" type="password" id="snxDestKey_' + type + '" placeholder="&#9679;&#9679;&#9679;&#9679;&#9679;&#9679;&#9679;&#9679;&#9679;&#9679;&#9679;&#9679;&#9679;&#9679;&#9679;&#9679;" autocomplete="off">' +
    (saved.streamKey ? '<div class="snx-dest-config-note">&#128274; Key is saved securely. Enter a new key to replace it. Keys are never returned to the browser.</div>' : '') +
  '</div>' +
  '<div class="snx-dest-config-note">' + lbl.note + '</div>' +
  '<div style="margin-top:10px;">' +
    '<button class="snx-dest-btn" onclick="snxDestSave(\'' + type + '\')">&#128190; Save Destination</button>' +
  '</div>';
}

window.snxDestToggleConfig = function(type) {
  var cfg = document.getElementById('snxDestConfig_' + type);
  if (!cfg) return;
  cfg.style.display = cfg.style.display === 'none' ? '' : 'none';
};

window.snxDestSave = function(type) {
  if (!_state.user) { _toastError('Sign in required.'); return; }
  var urlEl = document.getElementById('snxDestUrl_' + type);
  var keyEl = document.getElementById('snxDestKey_' + type);
  var rtmpUrl  = urlEl ? urlEl.value.trim() : '';
  var streamKey = keyEl ? keyEl.value.trim() : '';
  if (!rtmpUrl) { _toastError('Please enter an RTMP URL.'); return; }
  if (!streamKey) { _toastError('Please enter a stream key.'); return; }

  // Send to worker — keys are stored server-side in KV, never returned to browser
  var saveBody = JSON.stringify({
    uid: _state.user.uid,
    type: type,
    rtmpUrl: rtmpUrl,
    streamKey: streamKey   // sent once over HTTPS; worker stores it, never returns it
  });
  _snxWorkerHeaders().then(function(headers) {
    return fetch(CLOUDSTREAM_WORKER_URL + '/api/destinations/save', {
      method: 'POST',
      headers: headers,
      body: saveBody
    });
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.success) {
      // Clear form fields — key must not persist in DOM
      if (urlEl) urlEl.value  = '';
      if (keyEl) keyEl.value  = '';
      var existing = _music.destinations.findIndex(function(d) { return d.type === type; });
      var rec = { type: type, rtmpUrl: '[saved]', streamKey: '[saved]', status: 'active' };
      if (existing === -1) _music.destinations.push(rec);
      else _music.destinations[existing] = rec;
      _renderDestinations();
      _toast(type + ' destination saved.');
    } else {
      _toastError(data.error || 'Failed to save destination.');
    }
  })
  .catch(function(e) { _toastError('Could not reach worker: ' + e.message); });
};

window.snxDestRemove = function(type) {
  if (!confirm('Remove ' + type + ' destination?')) return;
  if (!_state.user) return;
  var removeBody = JSON.stringify({ uid: _state.user.uid, type: type });
  _snxWorkerHeaders().then(function(headers) {
    return fetch(CLOUDSTREAM_WORKER_URL + '/api/destinations/remove', {
      method: 'POST',
      headers: headers,
      body: removeBody
    });
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.success) {
      _music.destinations = _music.destinations.filter(function(d) { return d.type !== type; });
      _renderDestinations();
      _toast(type + ' destination removed.');
    } else {
      _toastError(data.error || 'Failed to remove destination.');
    }
  })
  .catch(function(e) { _toastError('Could not reach worker: ' + e.message); });
};

function _loadDestinationStatuses() {
  if (!_state.user) return;
  fetch(CLOUDSTREAM_WORKER_URL + '/api/destinations/list?uid=' + encodeURIComponent(_state.user.uid))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.destinations) {
        _music.destinations = data.destinations;
        _renderDestinations();
      }
    })
    .catch(function() {}); // non-fatal — destinations are optional
}

/* ═══════════════════════════════════════════════════════
   27. SCHEDULED MUSIC ROTATION
═══════════════════════════════════════════════════════ */
window.snxScheduleAddEntry = function() {
  var timeEl = document.getElementById('snxScheduleTime');
  var nameEl = document.getElementById('snxSchedulePlaylistName');
  var time = timeEl ? timeEl.value : '';
  var name = nameEl ? nameEl.value.trim() : '';
  if (!time) { _toastError('Please select a time.'); return; }
  if (!name) { _toastError('Please enter a playlist or library name.'); return; }
  _music.schedule.push({ time: time, name: name });
  _music.schedule.sort(function(a, b) { return a.time.localeCompare(b.time); });
  if (timeEl) timeEl.value = '';
  if (nameEl) nameEl.value = '';
  _renderSchedule();
  _saveScheduleToWorker();
};

window.snxScheduleRemoveEntry = function(idx) {
  _music.schedule.splice(idx, 1);
  _renderSchedule();
  _saveScheduleToWorker();
};

function _renderSchedule() {
  var el = document.getElementById('snxMusicScheduleList');
  if (!el) return;
  if (!_music.schedule.length) {
    el.innerHTML = '<div class="snx-empty-state"><div class="empty-icon">&#128197;</div>No schedule set.<br>Add time slots below.</div>';
    return;
  }
  el.innerHTML = _music.schedule.map(function(entry, i) {
    return '<div class="snx-schedule-row">' +
      '<span class="snx-schedule-time">' + _esc(entry.time) + '</span>' +
      '<span class="snx-schedule-info">' + _esc(entry.name) + '</span>' +
      '<span class="snx-schedule-del" onclick="snxScheduleRemoveEntry(' + i + ')">&#10005;</span>' +
    '</div>';
  }).join('');
}

function _saveScheduleToWorker() {
  if (!_state.user || !_state.cloudStreamId) return;
  var schedBody = JSON.stringify({
    streamId:  _state.cloudStreamId,
    uid:       _state.user.uid,
    action:    'setSchedule',
    schedule:  _music.schedule
  });
  _snxWorkerHeaders().then(function(headers) {
    return fetch(CLOUDSTREAM_WORKER_URL + '/api/stream/control', {
      method: 'POST',
      headers: headers,
      body: schedBody
    });
  }).catch(function() {});
}

/* ═══════════════════════════════════════════════════════
   28. VISUALIZER PRESETS
═══════════════════════════════════════════════════════ */
window.snxSelectVisPreset = function(preset) {
  _music.visPreset = preset;
  document.querySelectorAll('.snx-vis-preset-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.preset === preset);
  });
  _toast('Visualizer: ' + preset);
  if (_state.cloudStreamId && _state.cloudStatus === 'active') {
    _cloudStreamRPC({ action: 'setVisualizer', preset: preset });
  }
};

/* ═══════════════════════════════════════════════════════
   29. MUSIC LIBRARY INIT (called when music mode activates)
═══════════════════════════════════════════════════════ */
var _musicLibInit = false;
function _initMusicLibrary() {
  if (_musicLibInit) { _renderLibrary(); _renderNowPlayingBar(); _renderQueue(); return; }
  _musicLibInit = true;
  // Drag-and-drop on upload zone
  var zone = document.getElementById('snxUploadZone');
  if (zone) {
    zone.addEventListener('dragover', function(e) { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', function()  { zone.classList.remove('drag-over'); });
    zone.addEventListener('drop', function(e) {
      e.preventDefault(); zone.classList.remove('drag-over');
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) {
        var inp = document.getElementById('snxMusicFileInput');
        if (inp) { inp.files = dt.files; window.snxMusicFilesSelected({ target: inp }); }
        else {
          // manual pass
          var fakeEvt = { target: { files: dt.files } };
          window.snxMusicFilesSelected(fakeEvt);
        }
      }
    });
  }
  _mlLoadTracks();
}

// Override the existing _initMusicMode to also init library
var _origInitMusicMode = typeof _initMusicMode === 'function' ? _initMusicMode : null;
// Patched from inside IIFE — _initMusicMode is in same scope, we reassign it
(function() {
  // Patch snxStudioSwitchMode to also call _initMusicLibrary when mode === 'music'.
  // The cloudstream mode trigger is now handled by _switchSection / snxCSSwitchTab.
  var _origSwitchMode = window.snxStudioSwitchMode;
  window.snxStudioSwitchMode = function(mode) {
    if (_origSwitchMode) _origSwitchMode.call(this, mode);
    if (mode === 'music') { setTimeout(_initMusicLibrary, 60); }
  };
})();

/* ═══════════════════════════════════════════════════════
   19. PAGE HOOK — auto-init when studio page is navigated to
═══════════════════════════════════════════════════════ */
(function hookRealmNavTo() {
  var orig = window.realmNavTo;
  if (typeof orig !== 'function') {
    document.addEventListener('DOMContentLoaded', function() { hookRealmNavTo(); });
    return;
  }
  window.realmNavTo = function(pageId) {
    orig.apply(this, arguments);
    if (pageId === 'studioPage') {
      document.body.classList.add('snx-studio-open');
      setTimeout(snxStudioInit, 120);
    } else {
      document.body.classList.remove('snx-studio-open');
    }
  };
})();

/* ═══════════════════════════════════════════════════════
   27. CLOUDSTREAM WORKER AUTH HEADER HELPER
   Returns a headers object with:
     Content-Type: application/json
     Authorization: Bearer <Firebase ID token>
   The ID token is obtained from the authenticated user so
   the CloudStream worker can verify the caller's identity
   server-side.  If no user is signed in, returns headers
   without the Authorization entry (worker will reject).
═══════════════════════════════════════════════════════ */
function _snxWorkerHeaders(extraHeaders) {
  var base = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
  var user = _state.user;
  if (!user || typeof user.getIdToken !== 'function') return Promise.resolve(base);
  return user.getIdToken(/* forceRefresh */ false).then(function(token) {
    base['Authorization'] = 'Bearer ' + token;
    return base;
  }).catch(function() {
    // Token fetch failed — proceed without auth header; worker will enforce.
    return base;
  });
}

/* ═══════════════════════════════════════════════════════
   30. STUDIO QUEUE (_sq) — Permanent Always-On Queue
   ─────────────────────────────────────────────────────
   A simplified music queue that feeds directly into the
   cloud-stream infrastructure without requiring a playlist.

   Firestore path:
     studioQueue/{uid}
       { uid, queue:[{id,title,artist,url,duration,addedAt}],
         queueIndex, playing, updatedAt }

   Cloud stream: uses the same /api/stream/music/set endpoint.
═══════════════════════════════════════════════════════ */

var _sq = {
  queue:      [],    // [{id, title, artist, url, duration, addedAt}]
  queueIndex: 0,
  playing:    false,
  audio:      null,  // HTMLAudioElement for local preview
  unsub:      null   // Firestore onSnapshot unsubscribe
};

/* ── Firestore persistence ── */

function _sqLoad() {
  if (!_state.user || !window._snxFirestore) return;
  var fs  = window._snxFirestore;
  var uid = _state.user.uid;
  // Unsubscribe previous listener if any
  if (typeof _sq.unsub === 'function') { try { _sq.unsub(); } catch(e) {} _sq.unsub = null; }
  _sq.unsub = fs.onSnapshot(
    fs.doc(fs.db, 'studioQueue', uid),
    function(snap) {
      // Document doesn't exist yet (first time user) — queue is empty, nothing to load
      if (!snap || !snap.exists()) {
        _sqRenderQueue();
        _sqRenderLibraryButtons();
        return;
      }
      var d = snap.data();
      _sq.queue      = Array.isArray(d.queue) ? d.queue : [];
      _sq.queueIndex = typeof d.queueIndex === 'number' ? d.queueIndex : 0;
      // Resume playback if it was marked playing and audio not currently active
      if (d.playing && !_sq.audio && _sq.queue.length) {
        _sqPlay();
      } else if (!d.playing && _sq.audio) {
        _sqStopLocalPreview();
      }
      // Re-sync to worker + viewer channel on every load/restore (handles browser refresh)
      if (_sq.queue.length && _state.cloudStreamId) {
        _sqPushToWorker();
        _sqPushToFirestore();
      }
      _sqRenderQueue();
      _sqRenderLibraryButtons();
    },
    function(err) {
      // Surface Firestore permission errors so they are visible in the console
      console.error('[SNX SQ] studioQueue snapshot error:', err && err.code, err && err.message);
      _sq.unsub = null; // clear so _sqLoad can be retried
    }
  );
}

/* _sqSave — persists the current queue to Firestore and returns the Promise.
   Callers that need to wait for confirmation (e.g. snxSQAddToQueue) await this. */
function _sqSave() {
  if (!_state.user || !window._snxFirestore) return Promise.resolve();
  var fs  = window._snxFirestore;
  var uid = _state.user.uid;
  return fs.setDoc(fs.doc(fs.db, 'studioQueue', uid), {
    uid:        uid,
    queue:      _sq.queue,
    queueIndex: _sq.queueIndex,
    playing:    _sq.playing,
    updatedAt:  fs.serverTimestamp()
  }, { merge: true });
  // Errors propagated to caller — NOT silently swallowed here
}

/* ── Push current queue to cloudstream worker ── */

function _sqPushToWorker() {
  if (!_state.cloudStreamId || !_state.user) return;
  // Push to worker whenever a cloud stream ID exists — not limited to 'active' status
  // so that a queue populated before the stream starts is correctly registered.
  var payload = JSON.stringify({
    streamId:   _state.cloudStreamId,
    uid:        _state.user.uid,
    queue:      _sq.queue.map(function(t) {
      return { id: t.id, title: t.title || '', artist: t.artist || '',
               url: t.url || '', duration: t.duration || 0 };
    }),
    queueIndex: _sq.queueIndex,
    shuffle:    false,
    repeat:     true,
    crossfade:  3,
    volume:     80,
    playlistId: 'studio-queue'
  });
  _snxWorkerHeaders().then(function(headers) {
    return fetch(CLOUDSTREAM_WORKER_URL + '/api/stream/music/set', {
      method: 'POST',
      headers: headers,
      body: payload
    }).then(function(r) {
      if (!r.ok) r.text().then(function(t) { console.warn('[SNX SQ] worker push HTTP', r.status, t); });
    });
  }).catch(function(e) { console.warn('[SNX SQ] worker push failed:', e.message); });
}

/* ── Push current track metadata to Firestore (viewer realtime channel) ──
   Writes to studioCloudStreamMusic/{cloudStreamId} — the same document
   that studio-viewer.html subscribes to via onSnapshot so viewers see
   the correct Now Playing title without waiting for the DO alarm cycle.  */
function _sqPushToFirestore() {
  if (!_state.cloudStreamId || !_state.user || !window._snxFirestore) return;
  if (!_sq.queue.length) return;
  var fs  = window._snxFirestore;
  var cur = _sq.queue[_sq.queueIndex] || {};
  var nxt = _sq.queue[(_sq.queueIndex + 1) % _sq.queue.length] || {};
  fs.setDoc(fs.doc(fs.db, 'studioCloudStreamMusic', _state.cloudStreamId), {
    cloudStreamId:   _state.cloudStreamId,
    uid:             _state.user.uid,
    playlistId:      'studio-queue',
    queueLength:     _sq.queue.length,
    queueIndex:      _sq.queueIndex,
    currentTrackId:  cur.id       || '',
    currentTitle:    cur.title    || '',
    currentArtist:   cur.artist   || '',
    currentTrackUrl: cur.url      || '',   // included so viewer can play without health round-trip
    currentDuration: cur.duration || 0,
    nextTrackId:     nxt.id       || '',
    nextTitle:       nxt.title    || '',
    nextArtist:      nxt.artist   || '',
    shuffle:         false,
    repeat:          true,
    crossfade:       3,
    volume:          80,
    status:          _sq.playing ? 'playing' : 'paused',
    updatedAt:       fs.serverTimestamp()
  }, { merge: true }).catch(function(e) {
    console.warn('[SNX SQ] Firestore push failed:', e && e.message);
  });
}

/* ── Local HTMLAudioElement preview ── */

function _sqPlay() {
  if (!_sq.queue.length) return;
  if (_sq.queueIndex >= _sq.queue.length) _sq.queueIndex = 0;
  var track = _sq.queue[_sq.queueIndex];
  if (!track || !track.url) return;

  _sqStopLocalPreview();
  _sq.playing = true;

  var audio = new Audio(track.url);
  audio.volume = 0.8;
  audio.crossOrigin = 'anonymous';
  _sq.audio = audio;

  audio.onended = function() { _sqAdvance(); };
  audio.onerror = function() { _sqAdvance(); };

  audio.play().catch(function() {
    // Autoplay blocked — still mark playing so server plays it
    _sq.playing = true;
  });

  _sqPushToWorker();
  _sqPushToFirestore();   // Update viewer realtime channel immediately
  _sqRenderQueue();
}

function _sqStopLocalPreview() {
  if (_sq.audio) {
    _sq.audio.pause();
    _sq.audio.src = '';
    _sq.audio = null;
  }
  _sq.playing = false;
}

function _sqAdvance() {
  if (!_sq.queue.length) return;
  _sq.queueIndex = (_sq.queueIndex + 1) % _sq.queue.length;
  _sqSave().catch(function(err) { console.error('[SNX SQ] advance save failed:', err && err.code); });
  _sqPushToFirestore();   // Push new track to viewer channel before playing
  _sqPlay();
}

/* ── Public API (attached to window) ── */

window.snxSQAddToQueue = function(trackId) {
  var track = _music.tracks.find(function(t) { return t.id === trackId; });
  if (!track || track.status !== 'ready') { _toastError('Track not ready.'); return; }

  // Avoid duplicates
  if (_sq.queue.some(function(q) { return q.id === trackId; })) {
    _toast('Track already in queue.');
    return;
  }

  var wasEmpty = (_sq.queue.length === 0);
  _sq.queue.push({
    id:       track.id,
    title:    track.title  || 'Untitled',
    artist:   track.artist || '',
    url:      track.url    || '',
    duration: track.duration || 0,
    addedAt:  Date.now()
  });

  if (wasEmpty) {
    _sq.queueIndex = 0;
    _sq.playing    = true;
  }

  // Optimistically render — then confirm on save
  _sqRenderQueue();
  _sqRenderLibraryButtons();

  // Ensure the snapshot listener is active before we write
  if (!_sq.unsub) { _sqLoad(); }

  _sqSave().then(function() {
    // Save confirmed — toast and start playback / push to worker + viewer channel
    _toast('Added: ' + (track.title || 'Track') + ' → Queue');
    if (wasEmpty) {
      _sqPlay();
    } else {
      _sqPushToWorker();
      _sqPushToFirestore();
    }
  }).catch(function(err) {
    // Save failed — remove the track we optimistically added and show the real error
    var failedIdx = _sq.queue.findIndex(function(q) { return q.id === trackId; });
    if (failedIdx !== -1) _sq.queue.splice(failedIdx, 1);
    if (wasEmpty) { _sq.queueIndex = 0; _sq.playing = false; }
    _sqRenderQueue();
    _sqRenderLibraryButtons();
    var code = (err && err.code) ? err.code : '';
    var msg  = (err && err.message) ? err.message : String(err);
    _toastError('Could not save to queue: ' + (code || msg));
    console.error('[SNX SQ] _sqSave failed:', code, msg);
  });
};

window.snxSQRemove = function(idx) {
  if (idx < 0 || idx >= _sq.queue.length) return;
  var wasCurrent = (idx === _sq.queueIndex);
  _sq.queue.splice(idx, 1);
  if (_sq.queueIndex >= _sq.queue.length && _sq.queue.length > 0) {
    _sq.queueIndex = _sq.queue.length - 1;
  }
  if (!_sq.queue.length) {
    _sqStopLocalPreview();
    _sq.queueIndex = 0;
    _sq.playing = false;
  } else if (wasCurrent) {
    _sqStopLocalPreview();
    _sqPlay();
  }
  _sqSave().catch(function(err) { console.error('[SNX SQ] remove save failed:', err && err.code); });
  _sqRenderQueue();
  _sqRenderLibraryButtons();
};

window.snxSQSkip = function() {
  if (!_sq.queue.length) return;
  _sqStopLocalPreview();
  _sqAdvance();
  _toast('Skipped.');
};

window.snxSQClear = function() {
  if (!_sq.queue.length) return;
  if (!confirm('Clear the entire queue?')) return;
  _sqStopLocalPreview();
  _sq.queue      = [];
  _sq.queueIndex = 0;
  _sq.playing    = false;
  _sqSave().catch(function(err) { console.error('[SNX SQ] clear save failed:', err && err.code); });
  _sqRenderQueue();
  _sqRenderLibraryButtons();
  _toast('Queue cleared.');
};

window.snxSQPlayPause = function() {
  if (!_sq.queue.length) { _toastError('Queue is empty.'); return; }
  if (_sq.playing && _sq.audio) {
    _sqStopLocalPreview();
    _sqSave().catch(function(err) { console.error('[SNX SQ] pause save failed:', err && err.code); });
    _sqPushToFirestore();   // Mark paused in viewer channel
    _sqRenderQueue();
  } else {
    _sq.playing = true;
    _sqPlay();
    _sqSave().catch(function(err) { console.error('[SNX SQ] play save failed:', err && err.code); });
  }
};

/* ── Render ── */

function _sqRenderQueue() {
  var el = document.getElementById('snxSQQueueList');
  if (!el) return;

  if (!_sq.queue.length) {
    el.innerHTML = '<div class="snx-empty-state" style="padding:20px 0;"><div class="empty-icon">&#127925;</div>Queue is empty.<br><span style="font-size:11px;color:#3a5a7a;">Add tracks from your library below.</span></div>';
    return;
  }

  el.innerHTML = _sq.queue.map(function(t, i) {
    var isCur   = (i === _sq.queueIndex);
    var durText = (t.duration && t.duration > 0) ? _formatDuration(t.duration) : '—';
    return '<div class="snx-track-item' + (isCur ? ' playing' : '') + '">' +
      '<div class="snx-track-artwork" style="font-size:13px;color:' + (isCur ? '#00AEEF' : '#4a7a9a') + ';display:flex;align-items:center;justify-content:center;font-weight:700;">' +
        (isCur ? '&#9654;' : (i + 1)) + '</div>' +
      '<div class="snx-track-info" style="cursor:pointer;" onclick="snxSQJumpTo(' + i + ')" title="Play this track">' +
        '<div class="snx-track-title">' + _esc(t.title || 'Untitled') + '</div>' +
        '<div class="snx-track-artist">' + _esc(t.artist || '') + '</div>' +
      '</div>' +
      '<div class="snx-track-meta">' +
        '<span class="snx-track-dur">' + durText + '</span>' +
        '<div class="snx-track-add-btn" onclick="snxSQRemove(' + i + ')" title="Remove from queue" style="font-size:12px;color:#ff3355;border-color:rgba(255,51,85,0.3);">&#x2715;</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function _sqRenderLibraryButtons() {
  // Refresh the CS library list so "Add to Queue" buttons reflect queue state
  if (typeof _renderCSLibrary === 'function') _renderCSLibrary();
}

window.snxSQJumpTo = function(idx) {
  if (idx < 0 || idx >= _sq.queue.length) return;
  _sqStopLocalPreview();
  _sq.queueIndex = idx;
  _sq.playing    = true;
  _sqSave().catch(function(err) { console.error('[SNX SQ] jump save failed:', err && err.code); });
  _sqPushToFirestore();   // Immediately reflect jump in viewer channel
  _sqPlay();
};

})(); // end IIFE

/* ═══════════════════════════════════════════════════════
   31. SIMPLIFIED 24-HOUR CLOUD STREAM CONTROLLER
   ─────────────────────────────────────────────────────
   Controls the simplified 7-feature panel:
     Music · Output · Input · Both · Picture · Camera · Mic

   All audio ultimately flows through the existing
   _sq (Studio Queue) → cloudstream-worker pipeline.
   This controller wires the simplified UI to those
   existing backend functions — it does NOT create a
   second streaming architecture.
═══════════════════════════════════════════════════════ */

(function() {

/* ── State ── */
var _snxs = {
  audioMode:    'output',   // 'output' | 'input' | 'both'
  camStream:    null,       // MediaStream from getUserMedia (cam+mic)
  camOn:        false,
  micOn:        false,
  micStream:    null,       // separate mic-only stream (for INPUT mode without cam)
  camFacing:    'user',
  audioCtx:     null,
  analyserNode: null,
  animId:       null,
  pictureDataUrl: null,
  pictureFile:  null,
  uptimeStart:  null,
  uptimeInterval: null
};

/* ── Library tab switch ── */
window.snxsLibTab = function(tab) {
  var libPane    = document.getElementById('snxsLibPane');
  var uploadPane = document.getElementById('snxsUploadPane');
  var tabLib     = document.getElementById('snxsLibTabLib');
  var tabUp      = document.getElementById('snxsLibTabUpload');
  if (!libPane || !uploadPane) return;
  if (tab === 'upload') {
    libPane.style.display    = 'none';
    uploadPane.style.display = '';
    if (tabLib)  tabLib.classList.remove('active');
    if (tabUp)   tabUp.classList.add('active');
  } else {
    libPane.style.display    = '';
    uploadPane.style.display = 'none';
    if (tabLib)  tabLib.classList.add('active');
    if (tabUp)   tabUp.classList.remove('active');
    // Refresh library list
    if (typeof _renderCSLibrary === 'function') { _renderCSLibrary(); }
  }
};

/* ── Audio mode ── */
window.snxsSetMode = function(mode) {
  _snxs.audioMode = mode;
  var btns = { output: 'snxsModeOutput', input: 'snxsModeInput', both: 'snxsModeBoth' };
  Object.keys(btns).forEach(function(k) {
    var el = document.getElementById(btns[k]);
    if (el) el.classList.toggle('active', k === mode);
  });
  // Show mic volume only when input or both
  var micRow = document.getElementById('snxsMicVolRow');
  if (micRow) micRow.style.display = (mode === 'input' || mode === 'both') ? '' : 'none';
};

/* ── Volume sliders ── */
window.snxsSetMicVol = function(val) {
  var v = document.getElementById('snxsMicVolVal');
  if (v) v.textContent = val;
  // Apply to live mic stream gain if available
  if (_snxs.analyserNode) {
    try { _snxs.analyserNode.channelInterpretation = 'discrete'; } catch(e) {}
  }
};

window.snxsSetMusicVol = function(val) {
  var v = document.getElementById('snxsMusicVolVal');
  if (v) v.textContent = val;
  // Push new volume to queue system
  _csMusic.volume = parseInt(val, 10) || 80;
  if (_sq && _sq.audio) { _sq.audio.volume = (parseInt(val, 10) || 80) / 100; }
  // Push updated volume to worker if streaming
  if (_state.cloudStreamId) { _sqPushToWorker(); }
};

/* ── Picture ── */
window.snxsLoadPicture = function(event) {
  var file = event.target.files && event.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    _snxs.pictureDataUrl = e.target.result;
    _snxs.pictureFile    = file;
    var img = document.getElementById('snxsPicImg');
    var prev = document.getElementById('snxsPicPreview');
    if (img)  img.src = e.target.result;
    if (prev) prev.style.display = '';
  };
  reader.readAsDataURL(file);
};

window.snxsRemovePicture = function() {
  _snxs.pictureDataUrl = null;
  _snxs.pictureFile    = null;
  var prev  = document.getElementById('snxsPicPreview');
  var input = document.getElementById('snxsPicInput');
  if (prev)  prev.style.display = 'none';
  if (input) input.value = '';
};

/* ── Camera toggle ── */
window.snxsToggleCam = function() {
  if (_snxs.camOn) {
    _snxsStopCam();
  } else {
    _snxsStartCam();
  }
};

function _snxsStartCam() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    _snxsShowPermErr('snxsCamPermErr', 'Camera is not available on this device or browser.');
    return;
  }
  navigator.mediaDevices.getUserMedia({
    video: { facingMode: _snxs.camFacing },
    audio: true
  }).then(function(stream) {
    _snxs.camStream = stream;
    _snxs.camOn     = true;

    // Pipe to preview
    var vid = document.getElementById('snxsCamPreview');
    if (vid) { vid.srcObject = stream; vid.play().catch(function(){}); }

    // Show preview, show flip button
    var wrap = document.getElementById('snxsCamWrap');
    var flip = document.getElementById('snxsFlipBtn');
    if (wrap) wrap.style.display = '';
    if (flip) flip.style.display = '';

    // Update toggle
    var btn = document.getElementById('snxsCamToggle');
    if (btn) { btn.textContent = 'ON'; btn.classList.add('on'); }

    // Hide any previous permission error
    _snxsClearPermErr('snxsCamPermErr');

    // If mic is also supposed to be on, reuse camera audio track
    if (_snxs.micOn) {
      _snxsAttachMicFromCamStream(stream);
    }

    // Keep existing studio camera state in sync for diagnostics
    _state.isCamOn      = true;
    _state.cameraStream = stream;

  }).catch(function(err) {
    _snxs.camOn = false;
    var msg = 'Could not access camera: ' + err.message;
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      msg = 'Camera permission was denied. Please allow camera access and try again.';
    } else if (err.name === 'NotFoundError') {
      msg = 'No camera found on this device.';
    }
    _snxsShowPermErr('snxsCamPermErr', msg);
  });
}

function _snxsStopCam() {
  if (_snxs.camStream) {
    _snxs.camStream.getTracks().forEach(function(t) { t.stop(); });
    _snxs.camStream = null;
  }
  _snxs.camOn = false;

  var vid  = document.getElementById('snxsCamPreview');
  var wrap = document.getElementById('snxsCamWrap');
  var flip = document.getElementById('snxsFlipBtn');
  var btn  = document.getElementById('snxsCamToggle');

  if (vid)  { vid.srcObject = null; }
  if (wrap) wrap.style.display = 'none';
  if (flip) flip.style.display = 'none';
  if (btn)  { btn.textContent = 'OFF'; btn.classList.remove('on'); }

  _state.isCamOn      = false;
  _state.cameraStream = null;
}

window.snxsFlipCam = function() {
  _snxs.camFacing = (_snxs.camFacing === 'user') ? 'environment' : 'user';
  if (_snxs.camOn) {
    _snxsStopCam();
    setTimeout(_snxsStartCam, 200);
  }
  var btn = document.getElementById('snxsFlipBtn');
  if (btn) btn.textContent = _snxs.camFacing === 'user' ? '🔄 Flip' : '🔄 Front';
};

/* ── Mic toggle ── */
window.snxsToggleMic = function() {
  if (_snxs.micOn) {
    _snxsStopMic();
  } else {
    _snxsStartMic();
  }
};

function _snxsStartMic() {
  // If camera is on, its stream already has audio — reuse it
  if (_snxs.camOn && _snxs.camStream && _snxs.camStream.getAudioTracks().length) {
    _snxsAttachMicFromCamStream(_snxs.camStream);
    _snxs.micOn = true;
    _snxsUpdateMicUI(true);
    return;
  }
  // Mic-only stream
  navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    .then(function(stream) {
      _snxs.micStream = stream;
      _snxs.micOn     = true;
      _snxsUpdateMicUI(true);
      _snxsAttachMicFromCamStream(stream);
      _snxsClearPermErr('snxsMicPermErr');
    })
    .catch(function(err) {
      _snxs.micOn = false;
      var msg = 'Could not access microphone: ' + err.message;
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        msg = 'Microphone permission was denied. Please allow mic access and try again.';
      }
      _snxsShowPermErr('snxsMicPermErr', msg);
    });
}

function _snxsStopMic() {
  _snxs.micOn = false;
  if (_snxs.micStream) {
    _snxs.micStream.getTracks().forEach(function(t) { t.stop(); });
    _snxs.micStream = null;
  }
  _snxsStopMicMeter();
  _snxsUpdateMicUI(false);
}

function _snxsAttachMicFromCamStream(stream) {
  // Wire the audio from the stream into the Web Audio API meter
  try {
    if (!_snxs.audioCtx) {
      _snxs.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (_snxs.analyserNode) {
      try { _snxs.analyserNode.disconnect(); } catch(e) {}
    }
    var src    = _snxs.audioCtx.createMediaStreamSource(stream);
    var node   = _snxs.audioCtx.createAnalyser();
    node.fftSize = 256;
    src.connect(node);
    _snxs.analyserNode = node;

    // Show meter
    var meterEl = document.getElementById('snxsMicMeter');
    if (meterEl) meterEl.style.display = '';

    _snxsAnimMeter();
  } catch(e) {
    console.warn('[snxs] mic meter error:', e.message);
  }
}

function _snxsAnimMeter() {
  if (_snxs.animId) cancelAnimationFrame(_snxs.animId);
  var bars = document.querySelectorAll('#snxAudioMeter .snx-audio-bar');
  if (!bars.length || !_snxs.analyserNode) return;
  var data = new Uint8Array(_snxs.analyserNode.frequencyBinCount);
  (function tick() {
    if (!_snxs.micOn && !_snxs.camOn) return;
    _snxs.animId = requestAnimationFrame(tick);
    _snxs.analyserNode.getByteFrequencyData(data);
    var step = Math.floor(data.length / bars.length);
    bars.forEach(function(b, i) {
      var v = (data[i * step] || 0) / 255;
      b.style.height  = Math.max(3, Math.round(v * 40)) + 'px';
      b.style.opacity = 0.4 + v * 0.6;
    });
  })();
}

function _snxsStopMicMeter() {
  if (_snxs.animId) { cancelAnimationFrame(_snxs.animId); _snxs.animId = null; }
  var bars = document.querySelectorAll('#snxAudioMeter .snx-audio-bar');
  bars.forEach(function(b) { b.style.height = '3px'; b.style.opacity = '0.4'; });
  var meterEl = document.getElementById('snxsMicMeter');
  if (meterEl) meterEl.style.display = 'none';
}

function _snxsUpdateMicUI(on) {
  var btn = document.getElementById('snxsMicToggle');
  if (btn) { btn.textContent = on ? 'ON' : 'OFF'; btn.classList.toggle('on', on); }
  _state.isMicOn = on;
}

/* ── Permission error helpers ── */
function _snxsShowPermErr(id, msg) {
  var el = document.getElementById(id);
  if (el) { el.textContent = msg; el.style.display = ''; }
}
function _snxsClearPermErr(id) {
  var el = document.getElementById(id);
  if (el) { el.textContent = ''; el.style.display = 'none'; }
}

/* ── Now Playing sync ── */
function _snxsUpdateNowPlaying() {
  var bar    = document.getElementById('snxsNowPlaying');
  var titleEl= document.getElementById('snxsNpTitle');
  var artEl  = document.getElementById('snxsNpArtist');
  var ppBtn  = document.getElementById('snxsPlayPauseBtn');

  if (!_sq.queue.length) {
    if (bar) bar.style.display = 'none';
    return;
  }
  if (bar) bar.style.display = '';

  var cur = _sq.queue[_sq.queueIndex] || {};
  if (titleEl) titleEl.textContent = cur.title  || 'Untitled';
  if (artEl)   artEl.textContent   = cur.artist || '';
  if (ppBtn)   ppBtn.textContent   = _sq.playing ? '⏸' : '▶';
}

/* ── Uptime counter ── */
function _snxsStartUptime() {
  _snxs.uptimeStart = Date.now();
  if (_snxs.uptimeInterval) clearInterval(_snxs.uptimeInterval);
  _snxs.uptimeInterval = setInterval(function() {
    var el = document.getElementById('snxSimpleUptime');
    if (!el) return;
    var secs  = Math.floor((Date.now() - _snxs.uptimeStart) / 1000);
    var h     = Math.floor(secs / 3600);
    var m     = Math.floor((secs % 3600) / 60);
    var s     = secs % 60;
    el.textContent = (h > 0 ? h + 'h ' : '') + m + 'm ' + s + 's';
  }, 1000);
}

function _snxsStopUptime() {
  if (_snxs.uptimeInterval) { clearInterval(_snxs.uptimeInterval); _snxs.uptimeInterval = null; }
  var el = document.getElementById('snxSimpleUptime');
  if (el) el.textContent = '';
}

/* ── Status bar update ── */
function _snxsUpdateStatus(state) {
  var bar  = document.getElementById('snxSimpleStatusBar');
  var text = document.getElementById('snxSimpleStatusText');
  if (!bar || !text) return;
  bar.className = 'snxs-status-bar';
  if (state === 'live') {
    bar.classList.add('snxs-status-live');
    text.textContent = '☁️ Cloud Stream LIVE';
  } else if (state === 'starting') {
    bar.classList.add('snxs-status-starting');
    text.textContent = '⏳ Starting…';
  } else {
    bar.classList.add('snxs-status-off');
    text.textContent = 'Not streaming';
    _snxsStopUptime();
  }
}

/* ── START STREAM — bridges simplified UI to existing snxStartCloudStream ── */
window.snxsStartStream = function() {
  if (!_state.user) {
    _toastError('You must be signed in to start a stream.');
    // Navigate to login page and mark intent to return to Cloud Stream
    setTimeout(function() {
      if (typeof realmNavTo === 'function') {
        realmNavTo('login');
      } else if (typeof navTo === 'function') {
        navTo('login');
      }
    }, 800);
    return;
  }

  // Validate: at least one audio source required
  // Check both the Studio Queue (_sq) and the CS Playlist queue (_csMusic)
  var hasMusic = _sq.queue.length > 0 || _csMusic.queue.length > 0 || _state.musicQueue.length > 0;
  var hasMic   = _snxs.micOn || (_snxs.camOn && _snxs.camStream && _snxs.camStream.getAudioTracks().length > 0);

  if (_snxs.audioMode === 'output' && !hasMusic) {
    // Guide user to upload music rather than silently failing
    _toastError('No music in queue. Upload tracks in the Music section below, or switch to INPUT or MIC mode.');
    // Switch to upload tab so user can add tracks immediately
    if (typeof snxsLibTab === 'function') { snxsLibTab('upload'); }
    return;
  }
  if (_snxs.audioMode === 'input' && !hasMic) {
    _toastError('Turn on your microphone (Mic section below) before starting INPUT mode.');
    return;
  }
  if (_snxs.audioMode === 'both' && !hasMusic && !hasMic) {
    _toastError('Add music to the queue or turn on your microphone before starting BOTH mode.');
    return;
  }

  // Update status
  _snxsUpdateStatus('starting');

  // Disable start button during launch
  var startBtn = document.getElementById('snxsStartBtn');
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = '⏳ Starting…'; }

  // Delegate to the existing cloud stream start function
  // It reads from snxCSStreamName, snxCSDescription, snxCSCategory, snxCSDuration, _sq.queue, etc.
  try {
    snxStartCloudStream();
  } catch(e) {
    _toastError('Could not start stream: ' + e.message);
    _snxsUpdateStatus('off');
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = '⛅ START 24-HOUR CLOUD STREAM'; }
  }
};

/* ── Patch _handoffComplete to update simplified UI on success ── */
var _origHandoffComplete = window._snxHandoffComplete || null;
// Intercept handoff completion by patching the post-handoff state check
// (studio.js runs _handoffComplete → sets _state.cloudStatus = 'active')
// We poll for this state change after start is clicked.
(function() {
  var _handoffPoll = null;
  function _watchHandoff() {
    if (_handoffPoll) clearInterval(_handoffPoll);
    _handoffPoll = setInterval(function() {
      var st = _state.cloudStatus;
      if (st === 'active') {
        clearInterval(_handoffPoll);
        _snxsOnStreamActive();
      } else if (st === 'failed' || st === 'stopped') {
        clearInterval(_handoffPoll);
        _snxsOnStreamStopped();
      }
    }, 500);
    // Stop polling after 90 seconds regardless
    setTimeout(function() { if (_handoffPoll) clearInterval(_handoffPoll); }, 90000);
  }

  // Monkey-patch snxsStartStream to also start the poll
  var _origStart = window.snxsStartStream;
  window.snxsStartStream = function() {
    _origStart();
    setTimeout(_watchHandoff, 1000);
  };
})();

function _snxsOnStreamActive() {
  _snxsUpdateStatus('live');
  _snxsStartUptime();
  var startBtn = document.getElementById('snxsStartBtn');
  var stopBtn  = document.getElementById('snxCSStopBtn');
  if (startBtn) { startBtn.style.display = 'none'; }
  if (stopBtn)  { stopBtn.style.display  = ''; }
  _toast('☁️ Cloud Stream is LIVE! You may close the app.');
}

function _snxsOnStreamStopped() {
  _snxsUpdateStatus('off');
  _snxsStopUptime();
  var startBtn = document.getElementById('snxsStartBtn');
  var stopBtn  = document.getElementById('snxCSStopBtn');
  if (startBtn) {
    startBtn.style.display = '';
    startBtn.disabled      = false;
    startBtn.textContent   = '⛅ START 24-HOUR CLOUD STREAM';
  }
  if (stopBtn) stopBtn.style.display = 'none';
}

/* ── Patch snxCSStop to update simplified UI ── */
var _origCSStop = window.snxCSStop;
window.snxCSStop = function() {
  if (typeof _origCSStop === 'function') _origCSStop();
  _snxsOnStreamStopped();
};

/* ── Now playing bar refresh — hook into _sqRenderQueue ── */
var _origSqRender = window._snxSqRenderHook;
// Poll-based refresh (lightweight — runs only when cloudstream section is visible)
setInterval(function() {
  if (_state.currentSection !== 'cloudstream') return;
  _snxsUpdateNowPlaying();
  // Keep SQPlayPause button in sync
  var ppBtn = document.getElementById('snxsPlayPauseBtn');
  if (ppBtn) ppBtn.textContent = (_sq && _sq.playing) ? '⏸' : '▶';
}, 800);

/* ── On section switch to cloudstream, init simple UI ── */
var _origSwitchSection = window.snxStudioSwitchSection;
window.snxStudioSwitchSection = function(section) {
  if (typeof _origSwitchSection === 'function') _origSwitchSection(section);
  if (section === 'cloudstream') {
    // Init library if not already done
    if (typeof _initMusicLibrary === 'function') {
      setTimeout(_initMusicLibrary, 60);
    }
    // Render CS library (simplified panel uses snxCSTrackLibraryList)
    if (typeof _renderCSLibrary === 'function') {
      setTimeout(_renderCSLibrary, 80);
    }
    // Load SQ queue from Firestore
    if (typeof _sqLoad === 'function') {
      setTimeout(_sqLoad, 100);
    }
    // Sync status bar with current cloud stream state
    setTimeout(function() {
      var st = _state.cloudStatus;
      if (st === 'active') {
        _snxsOnStreamActive();
      } else if (st === 'starting') {
        _snxsUpdateStatus('starting');
      } else {
        _snxsOnStreamStopped();
      }
    }, 200);
  }
};

})(); // end simplified controller IIFE
