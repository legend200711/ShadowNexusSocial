/* ══════════════════════════════════════════════════════════════════
   SHADOW NEXUS SOCIAL — FOUNDER THEME ENGINE  v3.0
   ─────────────────────────────────────────────────────────────────
   • Reads siteSettings/holidayTheme from Firestore in real-time
   • Applies [data-snx-theme] to <html> for CSS variable overrides
   • Full colour palette: backgrounds, text, buttons, nav, cards,
     borders, accents — all configurable per theme
   • Typography: font family, size, weight, line-height per theme
   • Wallpaper / background image with opacity control
   • Logo override (injects CSS variable used by logo elements)
   • Scrollbar theming per theme
   • Shadows & glow effects per theme
   • Per-page tint overrides: Feed, Profile, Messages, Communities,
     Events, Live, Games, Notifications
   • Cursor effects (desktop sparkle trail) — optional per theme
   • Sound effects (Web Audio API ambient tones) — user-toggleable
   • Page transition animations — variant per theme
   • Loading screen & Splash screen — themed
   • Floating particles (snow, confetti, hearts, fireworks, etc.)
   • Seasonal 3px colour stripe banner at top of page
   • Holiday presets: Christmas, Halloween, Valentine's Day, Easter,
     Independence Day, Thanksgiving, New Year's, Winter + more
   • Custom theme builder — unlimited custom themes
   • Duplicate & edit existing themes
   • Save/load/delete named presets — unlimited
   • Preview mode (Founder-only, 30s auto-cancel)
   • One-click Publish → real-time push to ALL users via Firestore
   • One-click Restore Default
   • Auto-schedule by calendar date — Founder can toggle on/off
   • BroadcastChannel sync across all open tabs (same origin)
   • Fully compatible — zero impact on Firebase data, streams,
     messages, or any app logic
   ══════════════════════════════════════════════════════════════════ */
(function _snxHolidayThemes() {
  'use strict';

  /* ── Theme catalogue ────────────────────────────────────────────── */
  const THEMES = {
    none:         { id:'none',         name:'Default (No Theme)',  emoji:'🌑', swatch:'#0B1F3A,#00AEEF',   particles:null,        font:null,     music:null,         cursor:null,   transition:'fadeSlide' },
    newyears:     { id:'newyears',     name:"New Year's",          emoji:'🎆', swatch:'#0a0a12,#FFD700',   particles:'confetti',  font:null,     music:'newyears',   cursor:'sparkle', transition:'zoom' },
    valentines:   { id:'valentines',   name:"Valentine's Day",     emoji:'💝', swatch:'#1a0810,#FF6B8A',   particles:'hearts',    font:null,     music:'valentines', cursor:'heart',   transition:'fadeSlide' },
    stpatricks:   { id:'stpatricks',   name:"St. Patrick's Day",   emoji:'🍀', swatch:'#061a08,#2ED74A',   particles:'clovers',   font:null,     music:'stpatricks', cursor:null,      transition:'fadeSlide' },
    easter:       { id:'easter',       name:'Easter',              emoji:'🐣', swatch:'#120e1f,#B87CFF',   particles:'eggs',      font:null,     music:null,         cursor:'sparkle', transition:'fadeSlide' },
    memorialday:  { id:'memorialday',  name:'Memorial Day',        emoji:'🇺🇸', swatch:'#060b1a,#4A90D9',  particles:'stars',     font:null,     music:'patriotic',  cursor:null,      transition:'fadeSlide' },
    july4:        { id:'july4',        name:'Independence Day',    emoji:'🎇', swatch:'#03081a,#4466FF',   particles:'fireworks', font:null,     music:'patriotic',  cursor:'sparkle', transition:'fadeSlide' },
    halloween:    { id:'halloween',    name:'Halloween',           emoji:'🎃', swatch:'#0f0508,#FF6A00',   particles:'bats',      font:null,     music:'halloween',  cursor:'sparkle', transition:'slideRight' },
    thanksgiving: { id:'thanksgiving', name:'Thanksgiving',        emoji:'🦃', swatch:'#110a02,#E07020',   particles:'leaves',    font:null,     music:null,         cursor:null,      transition:'fadeSlide' },
    christmas:    { id:'christmas',    name:'Christmas',           emoji:'🎄', swatch:'#040f04,#D42020',   particles:'snow',      font:null,     music:'christmas',  cursor:'snowflake', transition:'fadeSlide' },
    winter:       { id:'winter',       name:'Winter',              emoji:'❄️', swatch:'#050d18,#7EC8E3',  particles:'snow',      font:null,     music:'winter',     cursor:'snowflake', transition:'fadeSlide' },
    birthday:     { id:'birthday',     name:'Birthday',            emoji:'🎂', swatch:'#0a0418,#FF44CC',   particles:'confetti',  font:null,     music:'birthday',   cursor:'sparkle', transition:'zoom' },
    anniversary:  { id:'anniversary',  name:'Anniversary',         emoji:'💫', swatch:'#0e0a04,#D4A840',   particles:'sparkles',  font:null,     music:null,         cursor:'sparkle', transition:'fadeSlide' },
    custom:       { id:'custom',       name:'Custom Theme',        emoji:'🎨', swatch:'#0B1F3A,#00AEEF',   particles:'sparkles',  font:null,     music:null,         cursor:null,      transition:'fadeSlide' },
  };

  /* ── Auto-activation calendar ───────────────────────────────────── */
  const SCHEDULE = [
    { month:1,  startDay:1,  endDay:7,   themeId:'newyears'     },
    { month:2,  startDay:10, endDay:14,  themeId:'valentines'   },
    { month:3,  startDay:14, endDay:17,  themeId:'stpatricks'   },
    { month:4,  startDay:14, endDay:21,  themeId:'easter'       },
    { month:5,  startDay:25, endDay:31,  themeId:'memorialday'  },
    { month:7,  startDay:1,  endDay:5,   themeId:'july4'        },
    { month:10, startDay:25, endDay:31,  themeId:'halloween'    },
    { month:11, startDay:22, endDay:28,  themeId:'thanksgiving' },
    { month:12, startDay:1,  endDay:26,  themeId:'christmas'    },
    { month:12, startDay:27, endDay:31,  themeId:'winter'       },
    { month:1,  startDay:8,  endDay:31,  themeId:'winter'       },
    { month:2,  startDay:1,  endDay:9,   themeId:'winter'       },
  ];

  /* ── Music tracks (Web Audio API generated tones) ─────────────── */
  const MUSIC_TRACKS = {
    newyears:   { label:"New Year's Fanfare",    loops:true  },
    valentines: { label:'Romantic Ambience',     loops:true  },
    stpatricks: { label:'Irish Jig',             loops:true  },
    patriotic:  { label:'Patriotic Fanfare',     loops:true  },
    halloween:  { label:'Spooky Ambience',       loops:true  },
    christmas:  { label:'Holiday Bells',         loops:true  },
    winter:     { label:'Winter Ambience',       loops:true  },
    birthday:   { label:'Birthday Celebration',  loops:true  },
  };

  /* ── Firebase config ────────────────────────────────────────────── */
  const _FIREBASE_CFG = {
    apiKey:            'AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y',
    authDomain:        'horr-a08f4.firebaseapp.com',
    projectId:         'horr-a08f4',
    storageBucket:     'horr-a08f4.firebasestorage.app',
    messagingSenderId: '933810617818',
    appId:             '1:933810617818:web:efb24f123337dd987c14e3',
  };
  const _FB_SDK = 'https://www.gstatic.com/firebasejs/10.8.0';

  /* ── State ──────────────────────────────────────────────────────── */
  let _currentTheme   = 'none';
  let _previewMode    = false;
  let _previewTimer   = null;
  let _particleAnim   = null;
  let _unsubscribe    = null;
  let _fsApi          = null;
  let _audioCtx       = null;
  let _musicNode      = null;
  let _musicEnabled   = false;    // Founder/site toggle
  let _userMusicOn    = false;    // Per-user preference
  let _musicGain      = null;
  let _musicInterval  = null;
  let _savedPresets   = [];
  let _liveData       = {};
  let _cursorEnabled  = false;
  let _cursorHandler  = null;
  let _activeSubTab   = 'themes'; // Admin UI state

  /* ── Helpers ────────────────────────────────────────────────────── */
  function _toast(msg) {
    if (typeof toastNotification === 'function') toastNotification(msg);
  }

  function _getAutoTheme() {
    const now = new Date();
    const m = now.getMonth() + 1;
    const d = now.getDate();
    for (const s of SCHEDULE) {
      if (s.month === m && d >= s.startDay && d <= s.endDay) return s.themeId;
    }
    return 'none';
  }

  /* ── Get or bootstrap Firestore API ─────────────────────────────── */
  async function _getFs() {
    if (window._snxFirestore) {
      return {
        db:         window._snxFirestore.db,
        doc:        window._snxFirestore.doc,
        getDoc:     window._snxFirestore.getDoc,
        setDoc:     window._snxFirestore.setDoc,
        onSnapshot: window._snxFirestore.onSnapshot,
        collection: window._snxFirestore.collection,
        getDocs:    window._snxFirestore.getDocs,
        deleteDoc:  window._snxFirestore.deleteDoc,
      };
    }
    if (_fsApi) return _fsApi;
    try {
      const [appMod, fsMod] = await Promise.all([
        import(`${_FB_SDK}/firebase-app.js`),
        import(`${_FB_SDK}/firebase-firestore.js`),
      ]);
      const { initializeApp, getApps, getApp } = appMod;
      const { getFirestore, doc, getDoc, setDoc, onSnapshot, collection, getDocs, deleteDoc } = fsMod;
      const app = getApps().length ? getApp() : initializeApp(_FIREBASE_CFG, 'snx-ht-app');
      const db  = getFirestore(app);
      _fsApi = { db, doc, getDoc, setDoc, onSnapshot, collection, getDocs, deleteDoc };
      return _fsApi;
    } catch(e) {
      console.warn('[ThemeEngine] Firestore bootstrap failed:', e);
      return null;
    }
  }

  /* ── Apply theme to the page ─────────────────────────────────────── */
  function _applyTheme(themeId, customVars) {
    const html = document.documentElement;

    if (themeId === 'none') {
      html.removeAttribute('data-snx-theme');
    } else {
      html.setAttribute('data-snx-theme', themeId);
    }

    // Reset all injected CSS vars first (non-custom themes use stylesheet rules)
    const _allVars = [
      '--bg-main','--bg-card','--bg-input','--bg-deep','--bg-deeper',
      '--neon-blue','--neon-cyan','--neon-blue-dim','--neon-green','--neon-green-dim',
      '--text-primary','--text-secondary','--text-muted','--border-color','--accent-glow',
      '--blue-glow-sm','--blue-glow-md','--blue-glow-lg','--green-glow-sm','--green-glow-md',
      '--ht-banner-gradient','--ht-font-body','--ht-font-heading',
      '--ht-font-size-base','--ht-font-size-sm','--ht-font-size-lg',
      '--ht-font-weight','--ht-line-height','--ht-letter-spacing',
      '--ht-scrollbar-thumb','--ht-scrollbar-track','--ht-scrollbar-width',
      '--ht-shadow-card','--ht-shadow-btn','--ht-glow-intensity',
      '--ht-radius-card','--ht-radius-btn','--ht-radius-input',
      '--ht-transition-dur','--ht-wallpaper','--ht-wallpaper-opacity',
      '--ht-logo-url','--ht-cursor','--ht-cursor-pointer',
      '--ht-feed-bg','--ht-profile-bg','--ht-messages-bg','--ht-communities-bg',
      '--ht-events-bg','--ht-live-bg','--ht-games-bg','--ht-notifications-bg',
      '--ht-btn-bg','--ht-btn-color','--ht-btn-border',
      '--ht-btn-primary-bg','--ht-btn-primary-color',
      '--ht-nav-bg','--ht-nav-color','--ht-nav-active-color','--ht-nav-active-bg',
    ];

    if (themeId === 'custom' && customVars) {
      // For custom themes, inject all provided vars directly
      for (const [key, val] of Object.entries(customVars)) {
        html.style.setProperty(key, val);
      }
    } else {
      // Remove any previously injected inline vars so CSS rules take over
      _allVars.forEach(k => html.style.removeProperty(k));

      // Apply extended vars from Firestore data if they exist on this theme entry
      if (customVars) {
        for (const [key, val] of Object.entries(customVars)) {
          html.style.setProperty(key, val);
        }
      }
    }

    // Apply cursor override on <html>
    if (themeId !== 'none') {
      const t = THEMES[themeId] || {};
      const cursorVal = customVars && customVars['--ht-cursor'] ? customVars['--ht-cursor'] : null;
      if (cursorVal && cursorVal !== 'auto') {
        document.body.style.cursor = cursorVal;
      } else {
        document.body.style.cursor = '';
      }
    } else {
      document.body.style.cursor = '';
    }

    // Logo override
    _applyLogoOverride(themeId, customVars);

    // Wallpaper overlay
    _applyWallpaper(themeId, customVars);

    // Banner stripe
    const banner = document.getElementById('snxHolidayBanner');
    if (banner) banner.classList.toggle('visible', themeId !== 'none');

    // Loading/splash screen
    _updateLoadingScreen(themeId);

    // Particles
    _startParticles(themeId);

    // Cursor effect
    _startCursorEffect(themeId, customVars);

    // Music
    if (_musicEnabled && _userMusicOn) {
      _startMusicForTheme(themeId);
    } else {
      _stopMusic();
    }

    // User music toggle visibility
    _updateMusicToggleUI(themeId);

    _currentTheme = themeId;
    _syncAdminUI();
  }

  /* ── Logo override ───────────────────────────────────────────────── */
  function _applyLogoOverride(themeId, customVars) {
    const logoUrl = customVars && customVars['--ht-logo-url'];
    // Apply to any element with data-snx-logo attribute
    document.querySelectorAll('[data-snx-logo]').forEach(el => {
      if (logoUrl && logoUrl !== 'none' && logoUrl !== '') {
        el.src = logoUrl;
        el.dataset.snxLogoOverride = '1';
      } else if (el.dataset.snxLogoOverride && el.dataset.snxLogoOriginal) {
        el.src = el.dataset.snxLogoOriginal;
        delete el.dataset.snxLogoOverride;
      }
    });
  }

  /* ── Wallpaper overlay ───────────────────────────────────────────── */
  function _applyWallpaper(themeId, customVars) {
    const wallEl = document.getElementById('snxThemeWallpaper');
    if (!wallEl) return;
    const wallUrl = customVars && customVars['--ht-wallpaper'];
    const wallOp  = customVars && customVars['--ht-wallpaper-opacity'];
    if (wallUrl && wallUrl !== 'none' && wallUrl !== '') {
      wallEl.style.backgroundImage = `url('${wallUrl}')`;
      wallEl.style.opacity = wallOp || '0.12';
      wallEl.classList.add('visible');
    } else {
      wallEl.classList.remove('visible');
      wallEl.style.backgroundImage = '';
    }
  }

  /* ── Update loading screen for theme ─────────────────────────────── */
  function _updateLoadingScreen(themeId) {
    const splash = document.getElementById('snxHolidayLoadingSplash');
    if (!splash) return;
    const t = THEMES[themeId] || THEMES.none;
    if (themeId === 'none') {
      splash.style.display = 'none';
      return;
    }
    const emojiEl = splash.querySelector('.ht-splash-emoji');
    const nameEl  = splash.querySelector('.ht-splash-name');
    if (emojiEl) emojiEl.textContent = t.emoji;
    if (nameEl)  nameEl.textContent  = t.name;
  }

  /* ── Cursor effect ───────────────────────────────────────────────── */
  function _startCursorEffect(themeId, customVars) {
    // Stop existing cursor effect
    _stopCursorEffect();

    const t = THEMES[themeId];
    const cursorType = (customVars && customVars['--ht-cursor-effect']) ||
                       (t && t.cursor) || null;

    if (!cursorType || themeId === 'none') return;
    if (window.matchMedia('(pointer: coarse)').matches) return; // skip on touch devices

    const cursorEl = document.getElementById('snxCursorEffect');
    if (!cursorEl) return;

    // Set cursor colour based on theme accent
    const html = document.documentElement;
    const accentColor = getComputedStyle(html).getPropertyValue('--neon-blue').trim() || '#00AEEF';
    cursorEl.style.background = accentColor;
    cursorEl.style.boxShadow  = `0 0 8px ${accentColor}, 0 0 20px ${accentColor}66`;
    cursorEl.classList.add('visible');

    _cursorEnabled = true;

    _cursorHandler = (e) => {
      if (!_cursorEnabled) return;
      cursorEl.style.left = e.clientX + 'px';
      cursorEl.style.top  = e.clientY + 'px';

      // Spawn trail dot
      const trail = document.createElement('div');
      trail.className = 'snx-cursor-trail';
      trail.style.left       = e.clientX + 'px';
      trail.style.top        = e.clientY + 'px';
      trail.style.background = accentColor;
      trail.style.boxShadow  = `0 0 4px ${accentColor}`;
      document.body.appendChild(trail);
      setTimeout(() => { if (trail.parentNode) trail.parentNode.removeChild(trail); }, 500);
    };

    document.addEventListener('mousemove', _cursorHandler, { passive: true });
  }

  function _stopCursorEffect() {
    _cursorEnabled = false;
    if (_cursorHandler) {
      document.removeEventListener('mousemove', _cursorHandler);
      _cursorHandler = null;
    }
    const cursorEl = document.getElementById('snxCursorEffect');
    if (cursorEl) cursorEl.classList.remove('visible');
    // Clean up any remaining trail dots
    document.querySelectorAll('.snx-cursor-trail').forEach(el => el.remove());
  }

  /* ── Music system (Web Audio API — procedural ambient tones) ─────── */
  function _ensureAudioCtx() {
    if (!_audioCtx) {
      try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch(e) { return false; }
    }
    if (_audioCtx.state === 'suspended') {
      _audioCtx.resume().catch(() => {});
    }
    return true;
  }

  function _stopMusic() {
    if (_musicInterval) { clearInterval(_musicInterval); _musicInterval = null; }
    if (_musicNode) {
      try { _musicNode.stop(); } catch(_) {}
      _musicNode = null;
    }
    if (_musicGain) {
      try { _musicGain.disconnect(); } catch(_) {}
      _musicGain = null;
    }
  }

  /* Theme-specific procedural ambient music via Web Audio API */
  const _MUSIC_SEQUENCES = {
    newyears:   [523.25,659.25,784,1046.5,784,659.25,523.25,440],
    valentines: [392,440,493.88,523.25,493.88,440,392,349.23],
    stpatricks: [523.25,587.33,659.25,698.46,784,698.46,659.25,587.33],
    patriotic:  [523.25,523.25,784,523.25,659.25,784,880,784],
    halloween:  [220,246.94,220,196,220,246.94,261.63,220],
    christmas:  [523.25,659.25,523.25,392,440,523.25,659.25,784],
    winter:     [440,493.88,440,392,349.23,392,440,493.88],
    birthday:   [523.25,523.25,587.33,523.25,698.46,659.25,523.25,587.33],
  };

  function _startMusicForTheme(themeId) {
    _stopMusic();
    const t = THEMES[themeId];
    if (!t || !t.music) return;
    if (!_ensureAudioCtx()) return;

    const seq  = _MUSIC_SEQUENCES[t.music] || _MUSIC_SEQUENCES.christmas;
    let   step = 0;
    const bpm  = 72;
    const dur  = (60 / bpm) * 0.8;

    _musicGain = _audioCtx.createGain();
    _musicGain.gain.setValueAtTime(0.08, _audioCtx.currentTime);
    _musicGain.connect(_audioCtx.destination);

    function _playNote() {
      if (!_musicGain || !_audioCtx) return;
      const osc = _audioCtx.createOscillator();
      osc.type = (themeId === 'halloween') ? 'sawtooth' : 'sine';
      osc.frequency.setValueAtTime(seq[step % seq.length], _audioCtx.currentTime);
      const g = _audioCtx.createGain();
      g.gain.setValueAtTime(0, _audioCtx.currentTime);
      g.gain.linearRampToValueAtTime(1, _audioCtx.currentTime + 0.05);
      g.gain.linearRampToValueAtTime(0, _audioCtx.currentTime + dur - 0.05);
      osc.connect(g);
      g.connect(_musicGain);
      osc.start(_audioCtx.currentTime);
      osc.stop(_audioCtx.currentTime + dur);
      step++;
    }

    _playNote();
    _musicInterval = setInterval(_playNote, dur * 1000);

    const muteBtn = document.getElementById('snxMusicToggleBtn');
    if (muteBtn) { muteBtn.textContent = '🎵 Music ON'; muteBtn.classList.add('music-on'); }
  }

  /* ── BroadcastChannel: same-origin tab sync ─────────────────────── */
  const _bc = (typeof BroadcastChannel !== 'undefined')
    ? new BroadcastChannel('snx-holiday-theme') : null;

  if (_bc) {
    _bc.onmessage = (e) => {
      if (e.data && e.data.type === 'snx-theme-apply') {
        _applyTheme(e.data.themeId, e.data.customVars || null);
      }
      if (e.data && e.data.type === 'snx-music-toggle') {
        _musicEnabled = e.data.enabled;
        if (!_musicEnabled) _stopMusic();
      }
    };
  }

  function _broadcastApply(themeId, customVars) {
    if (_bc) _bc.postMessage({ type:'snx-theme-apply', themeId, customVars: customVars || null });
  }

  /* ── Firestore real-time listener ───────────────────────────────── */
  async function _startFirestoreListener() {
    const fs = await _getFs();
    if (!fs) { setTimeout(_startFirestoreListener, 3000); return; }
    if (_unsubscribe) { try { _unsubscribe(); } catch(_) {} }
    try {
      _unsubscribe = fs.onSnapshot(
        fs.doc(fs.db, 'siteSettings', 'holidayTheme'),
        (snap) => {
          if (!snap.exists()) { _applyTheme('none'); return; }
          const data          = snap.data();
          _liveData           = data;
          const autoEnabled   = data.autoEnabled !== false;
          const manualTheme   = data.manualTheme  || 'none';
          const customVars    = data.customVars   || null;
          _musicEnabled       = data.musicEnabled !== false;
          _savedPresets       = data.presets || [];

          let resolvedTheme;
          if (manualTheme !== 'none' && manualTheme !== 'auto') {
            resolvedTheme = manualTheme;
          } else if (autoEnabled) {
            resolvedTheme = _getAutoTheme();
          } else {
            resolvedTheme = 'none';
          }

          if (!_previewMode) {
            _applyTheme(resolvedTheme, customVars);
            _broadcastApply(resolvedTheme, customVars);
          }

          _syncAdminUI();
          _syncAdminFullUI(data);
        },
        (err) => { console.warn('[ThemeEngine] snapshot error:', err); }
      );
    } catch(e) {
      console.warn('[ThemeEngine] listener failed:', e);
      setTimeout(_startFirestoreListener, 5000);
    }
  }

  /* ── Particles ───────────────────────────────────────────────────── */
  function _startParticles(themeId) {
    if (_particleAnim) { cancelAnimationFrame(_particleAnim); _particleAnim = null; }
    const canvas = document.getElementById('snxHolidayParticles');
    if (!canvas) return;
    const theme = THEMES[themeId];
    const type  = theme ? theme.particles : null;
    if (!type || themeId === 'none') { canvas.classList.remove('visible'); return; }

    canvas.classList.add('visible');
    const ctx = canvas.getContext('2d');
    if (!ctx) { canvas.classList.remove('visible'); return; }

    function _resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
    _resize();
    window.removeEventListener('resize', _resize);
    window.addEventListener('resize', _resize, { passive: true });

    const PARTICLE_COLORS = {
      snow:      ['#C0E8F5','#E0F4FF','#ffffff','#B0D8F8','#d0f0ff'],
      confetti:  ['#FF44CC','#FFDD00','#44CCFF','#FF8800','#FFD700','#39FF14','#FF3366','#00AEEF'],
      hearts:    ['#FF6B8A','#FF9EB8','#FFBFD0','#FF3366','#cc0044'],
      clovers:   ['#2ED74A','#78F08E','#FFD700','#1a9e30','#44ff66'],
      eggs:      ['#B87CFF','#80E878','#FFD700','#7EB8FF','#FF9EB8','#FFE066'],
      bats:      ['#AA44FF','#FF6A00','#7722CC','#B84A00','#cc00ff'],
      leaves:    ['#E07020','#D4920A','#8B3A00','#A05010','#F0A050','#cc5500'],
      fireworks: ['#FF3322','#4466FF','#ffffff','#FFDD00','#ff88aa','#88aaff'],
      sparkles:  ['#D4A840','#EED090','#FFD700','#C8805A','#fff0a0'],
      stars:     ['#4A90D9','#D93030','#ffffff','#80B8F0','#ffaaaa'],
    };

    const COUNT = (type === 'fireworks') ? 80 : (type === 'snow') ? 70 : 55;

    function _mkP() {
      const col = PARTICLE_COLORS[type] || ['#ffffff'];
      return {
        x:     Math.random() * canvas.width,
        y:     Math.random() * canvas.height - canvas.height,
        size:  Math.random() * 8 + 2,
        speed: Math.random() * 2 + 0.4,
        drift: (Math.random() - 0.5) * 1.2,
        rot:   Math.random() * Math.PI * 2,
        rotV:  (Math.random() - 0.5) * 0.08,
        color: col[Math.floor(Math.random() * col.length)],
        alpha: Math.random() * 0.55 + 0.35,
        life:  1,
        lifeD: (type === 'fireworks') ? Math.random() * 0.008 + 0.002 : 0,
      };
    }

    const particles = Array.from({ length: COUNT }, _mkP);

    function _drawP(ctx, p) {
      ctx.save();
      ctx.globalAlpha = p.alpha * p.life;
      ctx.fillStyle   = p.color;
      ctx.strokeStyle = p.color;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      const s = p.size;

      switch(type) {
        case 'hearts':
          ctx.beginPath();
          ctx.moveTo(0, -s*0.4);
          ctx.bezierCurveTo( s*0.6,-s, s*1.2,-s*0.3, 0, s*0.5);
          ctx.bezierCurveTo(-s*1.2,-s*0.3,-s*0.6,-s, 0,-s*0.4);
          ctx.fill();
          break;
        case 'snow':
          ctx.beginPath();
          ctx.arc(0, 0, s/2, 0, Math.PI*2);
          ctx.fill();
          ctx.lineWidth = 1;
          for (let i = 0; i < 6; i++) {
            ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(0,-s); ctx.stroke();
            ctx.rotate(Math.PI/3);
          }
          break;
        case 'eggs':
          ctx.beginPath();
          ctx.ellipse(0, 0, s*0.5, s*0.7, 0, 0, Math.PI*2);
          ctx.fill();
          break;
        case 'bats':
          ctx.beginPath();
          ctx.arc(-s*0.5, 0, s*0.55, 0, Math.PI, false);
          ctx.arc( s*0.5, 0, s*0.55, 0, Math.PI, false);
          ctx.lineTo(0, s*0.6); ctx.fill();
          break;
        case 'sparkles':
        case 'stars':
        case 'fireworks': {
          ctx.lineWidth = (s > 5) ? 2 : 1.5;
          const arms = (type === 'fireworks') ? 6 : 4;
          const step = (Math.PI * 2) / arms;
          for (let i = 0; i < arms; i++) {
            ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(0,-s*1.2); ctx.stroke();
            ctx.rotate(step);
          }
          break;
        }
        case 'clovers':
          for (let i = 0; i < 4; i++) {
            ctx.beginPath();
            ctx.arc(s*0.3, 0, s*0.38, 0, Math.PI*2);
            ctx.fill();
            ctx.rotate(Math.PI/2);
          }
          break;
        case 'leaves':
          ctx.beginPath();
          ctx.moveTo(0,-s); ctx.quadraticCurveTo(s,0,0,s); ctx.quadraticCurveTo(-s,0,0,-s);
          ctx.fill();
          break;
        default:
          ctx.fillRect(-s*0.25, -s*0.5, s*0.5, s);
      }
      ctx.restore();
    }

    function _tick() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of particles) {
        p.y += p.speed; p.x += p.drift; p.rot += p.rotV;
        if (p.lifeD) { p.life -= p.lifeD; }
        if (p.y > canvas.height + 20 || (p.lifeD && p.life <= 0)) {
          const np = _mkP(); np.y = -20; Object.assign(p, np);
        }
        _drawP(ctx, p);
      }
      _particleAnim = requestAnimationFrame(_tick);
    }
    _tick();
  }

  /* ── Admin UI sync ───────────────────────────────────────────────── */
  function _syncAdminUI() {
    document.querySelectorAll('.snx-holiday-card').forEach(card => {
      card.classList.toggle('active-theme', card.dataset.themeId === _currentTheme);
    });
    document.querySelectorAll('.snx-schedule-status').forEach(el => {
      const auto = _getAutoTheme();
      el.classList.toggle('active-now', el.dataset.themeId === auto);
      el.textContent = (el.dataset.themeId === auto) ? 'ACTIVE NOW' : 'UPCOMING';
    });
    const nameEl = document.getElementById('htActiveThemeName');
    if (nameEl) {
      const t = THEMES[_currentTheme] || THEMES.none;
      nameEl.textContent = `${t.emoji} ${t.name}`;
    }
    const musicStatusEl = document.getElementById('htMusicStatus');
    if (musicStatusEl) {
      musicStatusEl.textContent = _musicEnabled ? '🎵 Music Enabled Site-Wide' : '🔇 Music Disabled';
      musicStatusEl.style.color = _musicEnabled ? '#39FF14' : '#ff6680';
    }
  }

  function _syncAdminFullUI(data) {
    const cb = document.getElementById('htToggleAuto');
    if (cb) cb.checked = data.autoEnabled !== false;
    const musicCb = document.getElementById('htToggleMusic');
    if (musicCb) musicCb.checked = data.musicEnabled !== false;
    const nEl = document.getElementById('htActiveThemeName');
    if (nEl) {
      const t = THEMES[data.manualTheme] || THEMES.none;
      nEl.textContent = `${t.emoji} ${t.name}`;
    }
    _renderPresets(data.presets || []);

    // Populate custom form with live data if custom theme is active
    if (data.manualTheme === 'custom' && data.customVars) {
      _populateCustomForm(data.customVars);
    }
  }

  /* ── Populate custom form from saved vars ────────────────────────── */
  function _populateCustomForm(vars) {
    const _set = (id, val) => {
      const el = document.getElementById(id);
      if (el && val) el.value = val;
    };
    _set('htCustomBgMainPicker',        vars['--bg-main']);
    _set('htCustomBgMainHex',           vars['--bg-main']);
    _set('htCustomBgCardPicker',        vars['--bg-card']);
    _set('htCustomBgCardHex',           vars['--bg-card']);
    _set('htCustomBgInputPicker',       vars['--bg-input']);
    _set('htCustomBgInputHex',          vars['--bg-input']);
    _set('htCustomAccentPicker',        vars['--neon-blue']);
    _set('htCustomAccentHex',           vars['--neon-blue']);
    _set('htCustomAccent2Picker',       vars['--neon-green']);
    _set('htCustomAccent2Hex',          vars['--neon-green']);
    _set('htCustomTextPrimaryPicker',   vars['--text-primary']);
    _set('htCustomTextPrimaryHex',      vars['--text-primary']);
    _set('htCustomTextSecondaryPicker', vars['--text-secondary']);
    _set('htCustomTextSecondaryHex',    vars['--text-secondary']);
    _set('htCustomBorderPicker',        vars['--border-color']);
    _set('htCustomBorderHex',           vars['--border-color']);
    _set('htCustomBtnPrimaryPicker',    vars['--ht-btn-primary-bg']);
    _set('htCustomBanner1Picker',       vars['--ht-banner-a']);
    _set('htCustomBanner1Hex',          vars['--ht-banner-a']);
    _set('htCustomBanner2Picker',       vars['--ht-banner-b']);
    _set('htCustomBanner2Hex',          vars['--ht-banner-b']);
    _set('htCustomFontBodySel',         vars['--ht-font-body']);
    _set('htCustomFontHeadingSel',      vars['--ht-font-heading']);
    _set('htCustomFontSize',            vars['--ht-font-size-base']);
    _set('htCustomScrollbar',           vars['--ht-scrollbar-thumb']);
    _set('htCustomWallpaperUrl',        vars['--ht-wallpaper']);
    _set('htCustomWallpaperOpacity',    vars['--ht-wallpaper-opacity']);
    _set('htCustomLogoUrl',             vars['--ht-logo-url']);
    _set('htCustomTransitionDur',       vars['--ht-transition-dur']);
    _set('htCustomRadiusCard',          vars['--ht-radius-card']);
    _set('htCustomCursorEffect',        vars['--ht-cursor-effect']);
  }

  /* ── User-facing music toggle UI ─────────────────────────────────── */
  function _updateMusicToggleUI(themeId) {
    const wrap = document.getElementById('snxMusicPlayerWrap');
    if (!wrap) return;
    const t = THEMES[themeId];
    const hasMusicTrack = t && t.music;
    wrap.style.display = (_musicEnabled && hasMusicTrack) ? 'flex' : 'none';
  }

  /* ══════════════════════════════════════════════════════════════════
     PUBLIC API — called by Founder Control Panel & User toggles
     ══════════════════════════════════════════════════════════════════ */

  window.snxHtPreview = function(themeId) {
    _previewMode = true;
    window._snxHtSelectedPreview = themeId;
    if (_previewTimer) clearTimeout(_previewTimer);
    _applyTheme(themeId);
    const badge = document.getElementById('snxThemePreviewBadge');
    const t = THEMES[themeId] || THEMES.none;
    if (badge) {
      badge.innerHTML = `<span style="opacity:0.7">PREVIEW:</span> ${t.emoji} ${t.name} &nbsp;·&nbsp; <span style="color:#39FF14;cursor:pointer;" onclick="snxHtPublish('${themeId}')">✅ Publish</span> &nbsp;·&nbsp; <span style="opacity:0.7;cursor:pointer;" onclick="snxHtCancelPreview()">✕ Cancel</span>`;
      badge.classList.add('visible');
    }
    _previewTimer = setTimeout(() => { if (_previewMode) window.snxHtCancelPreview(); }, 30000);
  };

  window.snxHtCancelPreview = async function() {
    _previewMode = false;
    if (_previewTimer) { clearTimeout(_previewTimer); _previewTimer = null; }
    const badge = document.getElementById('snxThemePreviewBadge');
    if (badge) badge.classList.remove('visible');
    const fs = await _getFs();
    if (!fs) { _applyTheme('none'); return; }
    try {
      const snap = await fs.getDoc(fs.doc(fs.db,'siteSettings','holidayTheme'));
      if (snap.exists()) {
        const d = snap.data();
        const resolved = (d.manualTheme && d.manualTheme !== 'none' && d.manualTheme !== 'auto')
          ? d.manualTheme
          : (d.autoEnabled !== false ? _getAutoTheme() : 'none');
        _applyTheme(resolved, d.customVars || null);
      } else { _applyTheme('none'); }
    } catch(e) { _applyTheme('none'); }
  };

  window.snxHtPublish = async function(themeId) {
    if (!_founderCheck()) return;
    _previewMode = false;
    if (_previewTimer) { clearTimeout(_previewTimer); _previewTimer = null; }
    const badge = document.getElementById('snxThemePreviewBadge');
    if (badge) badge.classList.remove('visible');
    const fs = await _getFs();
    if (!fs) { _toast('⚠️ Firestore not ready'); return; }
    try {
      await fs.setDoc(fs.doc(fs.db,'siteSettings','holidayTheme'),
        { manualTheme: themeId, updatedAt: Date.now() }, { merge: true });
      _toast(`🎨 Theme published: ${(THEMES[themeId]||{}).name || themeId}`);
      _syncAdminUI();
      if (typeof window.adminAuditLog === 'function')
        window.adminAuditLog('THEME_ENGINE_SET', `theme=${themeId}`);
    } catch(e) { _toast('❌ Publish failed: ' + e.message); }
  };

  window.snxHtDisable = async function() {
    if (!_founderCheck()) return;
    const fs = await _getFs();
    if (!fs) return;
    try {
      await fs.setDoc(fs.doc(fs.db,'siteSettings','holidayTheme'),
        { manualTheme:'none', updatedAt: Date.now() }, { merge: true });
      _toast('🌑 Theme disabled. Default restored.');
      if (typeof window.adminAuditLog === 'function')
        window.adminAuditLog('THEME_ENGINE_SET', 'theme=none (default restored)');
    } catch(e) { _toast('❌ ' + e.message); }
  };

  window.snxHtSetAuto = async function(enabled) {
    if (!_founderCheck()) return;
    const fs = await _getFs();
    if (!fs) return;
    try {
      await fs.setDoc(fs.doc(fs.db,'siteSettings','holidayTheme'),
        { autoEnabled: enabled, updatedAt: Date.now() }, { merge: true });
      _toast(`📅 Auto-holiday themes: ${enabled ? 'ON' : 'OFF'}`);
    } catch(e) { _toast('❌ ' + e.message); }
  };

  window.snxHtSetMusic = async function(enabled) {
    if (!_founderCheck()) return;
    const fs = await _getFs();
    if (!fs) return;
    try {
      await fs.setDoc(fs.doc(fs.db,'siteSettings','holidayTheme'),
        { musicEnabled: enabled, updatedAt: Date.now() }, { merge: true });
      _musicEnabled = enabled;
      if (!enabled) _stopMusic();
      else if (_userMusicOn) _startMusicForTheme(_currentTheme);
      _updateMusicToggleUI(_currentTheme);
      if (_bc) _bc.postMessage({ type:'snx-music-toggle', enabled });
      _toast(`🎵 Holiday music: ${enabled ? 'Enabled site-wide' : 'Disabled'}`);
    } catch(e) { _toast('❌ ' + e.message); }
  };

  /* User music on/off (no founder check) */
  window.snxHtUserMusicToggle = function() {
    _userMusicOn = !_userMusicOn;
    try { localStorage.setItem('snx-music-pref', _userMusicOn ? '1' : '0'); } catch(_) {}
    if (_userMusicOn && _musicEnabled) {
      _ensureAudioCtx();
      _startMusicForTheme(_currentTheme);
    } else {
      _stopMusic();
    }
    const btn = document.getElementById('snxMusicToggleBtn');
    if (btn) {
      btn.textContent = _userMusicOn ? '🔊 Music ON' : '🔇 Music OFF';
      btn.classList.toggle('music-on', _userMusicOn);
    }
  };

  /* ── Custom theme publish ─────────────────────────────────────────── */
  window.snxHtPublishCustom = async function() {
    if (!_founderCheck()) return;
    const fs = await _getFs();
    if (!fs) return;
    const vars = _readCustomFormVars();
    try {
      await fs.setDoc(fs.doc(fs.db,'siteSettings','holidayTheme'),
        { manualTheme:'custom', customVars: vars, updatedAt: Date.now() }, { merge: true });
      _toast('🎨 Custom theme published!');
      if (typeof window.adminAuditLog === 'function')
        window.adminAuditLog('THEME_ENGINE_SET', 'theme=custom');
    } catch(e) { _toast('❌ ' + e.message); }
  };

  window.snxHtPreviewCustom = function() {
    const vars = _readCustomFormVars();
    _previewMode = true;
    window._snxHtSelectedPreview = 'custom';
    _applyTheme('custom', vars);
    const badge = document.getElementById('snxThemePreviewBadge');
    if (badge) {
      badge.innerHTML = 'PREVIEW: 🎨 Custom Theme &nbsp;·&nbsp; <span style="color:#39FF14;cursor:pointer;" onclick="snxHtPublishCustom()">✅ Publish</span> &nbsp;·&nbsp; <span style="opacity:0.7;cursor:pointer;" onclick="snxHtCancelPreview()">✕ Cancel</span>';
      badge.classList.add('visible');
    }
    if (_previewTimer) clearTimeout(_previewTimer);
    _previewTimer = setTimeout(() => { if (_previewMode) window.snxHtCancelPreview(); }, 30000);
  };

  /* ── Duplicate existing theme into custom builder ─────────────────── */
  window.snxHtDuplicateTheme = function(themeId) {
    // Read CSS vars currently applied by that theme and push into custom form
    // We do this by temporarily applying the theme, reading computed style, then restoring
    const prevTheme = _currentTheme;
    const html = document.documentElement;
    html.setAttribute('data-snx-theme', themeId);
    const cs = getComputedStyle(html);
    const snap = {};
    ['--bg-main','--bg-card','--bg-input','--neon-blue','--neon-cyan','--neon-blue-dim',
     '--neon-green','--neon-green-dim','--text-primary','--text-secondary','--text-muted',
     '--border-color','--ht-scrollbar-thumb','--ht-shadow-card','--ht-nav-bg',
     '--ht-btn-primary-bg','--ht-btn-primary-color'].forEach(k => {
      const v = cs.getPropertyValue(k).trim();
      if (v) snap[k] = v;
    });
    // Restore
    if (prevTheme === 'none') html.removeAttribute('data-snx-theme');
    else html.setAttribute('data-snx-theme', prevTheme);

    // Switch to Custom sub-tab and populate form
    window.snxHtSwitchSubTab('custom');
    _populateCustomForm(snap);
    _toast(`📋 Duplicated "${(THEMES[themeId]||{}).name||themeId}" into Custom Builder`);
  };

  /* ── Save preset ─────────────────────────────────────────────────── */
  window.snxHtSavePreset = async function() {
    if (!_founderCheck()) return;
    const nameEl = document.getElementById('htPresetNameInput');
    const presetName = (nameEl && nameEl.value.trim()) || `Preset ${Date.now()}`;
    const fs = await _getFs();
    if (!fs) return;
    try {
      const snap = await fs.getDoc(fs.doc(fs.db,'siteSettings','holidayTheme'));
      const cur  = snap.exists() ? snap.data() : {};
      const presets = cur.presets || [];
      presets.push({
        id:         Date.now().toString(),
        name:       presetName,
        themeId:    _currentTheme,
        customVars: cur.customVars || null,
        savedAt:    Date.now(),
      });
      await fs.setDoc(fs.doc(fs.db,'siteSettings','holidayTheme'),
        { presets, updatedAt: Date.now() }, { merge: true });
      _toast(`💾 Preset saved: "${presetName}"`);
      if (nameEl) nameEl.value = '';
      _renderPresets(presets);
    } catch(e) { _toast('❌ ' + e.message); }
  };

  window.snxHtLoadPreset = async function(presetId) {
    if (!_founderCheck()) return;
    const preset = _savedPresets.find(p => p.id === presetId);
    if (!preset) { _toast('❌ Preset not found'); return; }
    const fs = await _getFs();
    if (!fs) return;
    try {
      await fs.setDoc(fs.doc(fs.db,'siteSettings','holidayTheme'),
        { manualTheme: preset.themeId, customVars: preset.customVars || null, updatedAt: Date.now() },
        { merge: true });
      _toast(`✅ Preset loaded: "${preset.name}"`);
    } catch(e) { _toast('❌ ' + e.message); }
  };

  window.snxHtDeletePreset = async function(presetId) {
    if (!_founderCheck()) return;
    const fs = await _getFs();
    if (!fs) return;
    try {
      const snap = await fs.getDoc(fs.doc(fs.db,'siteSettings','holidayTheme'));
      if (!snap.exists()) return;
      const presets = (snap.data().presets || []).filter(p => p.id !== presetId);
      await fs.setDoc(fs.doc(fs.db,'siteSettings','holidayTheme'),
        { presets, updatedAt: Date.now() }, { merge: true });
      _toast('🗑️ Preset deleted.');
      _renderPresets(presets);
    } catch(e) { _toast('❌ ' + e.message); }
  };

  function _renderPresets(presets) {
    const el = document.getElementById('htPresetsList');
    if (!el) return;
    _savedPresets = presets;
    if (!presets || !presets.length) {
      el.innerHTML = '<p style="font-size:12px;color:#6a90b8;margin:0;">No presets saved yet.</p>';
      return;
    }
    el.innerHTML = presets.map(p => {
      const t = THEMES[p.themeId] || THEMES.none;
      const d = new Date(p.savedAt);
      return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
        <span style="font-size:18px;">${t.emoji}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;font-weight:700;color:var(--text-primary,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.name}</div>
          <div style="font-size:10px;color:#6a90b8;">${t.name} · ${d.toLocaleDateString()}</div>
        </div>
        <button onclick="snxHtPreview('${p.themeId}')" style="font-size:11px;padding:4px 10px;border-radius:7px;background:rgba(0,174,239,0.10);border-color:rgba(0,174,239,0.25);color:#00d4ff;">👁</button>
        <button onclick="snxHtLoadPreset('${p.id}')" style="font-size:11px;padding:4px 10px;border-radius:7px;background:rgba(57,255,20,0.10);border-color:rgba(57,255,20,0.3);color:#39FF14;">Load</button>
        <button onclick="snxHtDeletePreset('${p.id}')" style="font-size:11px;padding:4px 10px;border-radius:7px;background:rgba(255,51,80,0.08);border-color:rgba(255,51,80,0.25);color:#ff6680;">✕</button>
      </div>`;
    }).join('');
  }

  /* ── Read ALL fields from custom builder form ────────────────────── */
  function _readCustomFormVars() {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const pick = (pickerId, hexId, fallback) =>
      val(pickerId) || val(hexId) || fallback;

    const bgMain     = pick('htCustomBgMainPicker',        'htCustomBgMainHex',           '#0B1F3A');
    const bgCard     = pick('htCustomBgCardPicker',        'htCustomBgCardHex',           '#0d2444');
    const bgInput    = pick('htCustomBgInputPicker',       'htCustomBgInputHex',          '#0a1c35');
    const acc1       = pick('htCustomAccentPicker',        'htCustomAccentHex',           '#00AEEF');
    const acc2       = pick('htCustomAccent2Picker',       'htCustomAccent2Hex',          '#39FF14');
    const textPri    = pick('htCustomTextPrimaryPicker',   'htCustomTextPrimaryHex',      '#ffffff');
    const textSec    = pick('htCustomTextSecondaryPicker', 'htCustomTextSecondaryHex',    '#b8d4f0');
    const borderCol  = pick('htCustomBorderPicker',        'htCustomBorderHex',           '#1a3a5c');
    const bannerA    = pick('htCustomBanner1Picker',       'htCustomBanner1Hex',          acc1);
    const bannerB    = pick('htCustomBanner2Picker',       'htCustomBanner2Hex',          acc2);
    const fontBody   = val('htCustomFontBodySel')   || "'Segoe UI', Arial, sans-serif";
    const fontHead   = val('htCustomFontHeadingSel') || fontBody;
    const fontSize   = val('htCustomFontSize')      || '14px';
    const scrollbar  = pick('htCustomScrollbarPicker', 'htCustomScrollbar', `rgba(0,100,220,0.22)`);
    const wallUrl    = val('htCustomWallpaperUrl');
    const wallOp     = val('htCustomWallpaperOpacity') || '0.12';
    const logoUrl    = val('htCustomLogoUrl');
    const transDur   = val('htCustomTransitionDur')  || '0.45s';
    const radiusCard = val('htCustomRadiusCard')     || '10px';
    const cursor     = val('htCustomCursorEffect')   || 'none';
    const navBg      = pick('htCustomNavBgPicker',    'htCustomNavBgHex',    '#050f1e');

    return {
      '--bg-main':              bgMain,
      '--bg-card':              bgCard,
      '--bg-input':             bgInput,
      '--bg-deep':              bgMain,
      '--bg-deeper':            bgMain,
      '--neon-blue':            acc1,
      '--neon-cyan':            acc1,
      '--neon-blue-dim':        acc1,
      '--neon-green':           acc2,
      '--neon-green-dim':       acc2,
      '--text-primary':         textPri,
      '--text-secondary':       textSec,
      '--text-muted':           textSec,
      '--border-color':         borderCol,
      '--accent-glow':          acc1 + '4d',
      '--blue-glow-sm':         `0 0 10px ${acc1}8c`,
      '--blue-glow-md':         `0 0 22px ${acc1}a6`,
      '--blue-glow-lg':         `0 0 44px ${acc1}b3`,
      '--green-glow-sm':        `0 0 10px ${acc2}80`,
      '--green-glow-md':        `0 0 24px ${acc2}99`,
      '--ht-banner-gradient':   `linear-gradient(90deg,${bannerA},${bannerB},${bannerA})`,
      '--ht-banner-a':          bannerA,
      '--ht-banner-b':          bannerB,
      '--ht-font-body':         fontBody,
      '--ht-font-heading':      fontHead,
      '--ht-font-size-base':    fontSize,
      '--ht-scrollbar-thumb':   scrollbar,
      '--ht-wallpaper':         wallUrl || 'none',
      '--ht-wallpaper-opacity': wallOp,
      '--ht-logo-url':          logoUrl || 'none',
      '--ht-transition-dur':    transDur,
      '--ht-radius-card':       radiusCard,
      '--ht-cursor-effect':     cursor === 'none' ? '' : cursor,
      '--ht-nav-bg':            navBg,
      '--ht-btn-primary-bg':    `linear-gradient(135deg,${acc1},${acc2})`,
      '--ht-btn-primary-color': '#fff',
      '--ht-shadow-card':       `0 2px 16px ${acc1}1f`,
    };
  }

  /* ── Sub-tab switcher for admin panel ────────────────────────────── */
  window.snxHtSwitchSubTab = function(tab) {
    _activeSubTab = tab;
    document.querySelectorAll('.ht-sub-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.tab === tab);
    });
    document.querySelectorAll('.ht-sub-panel').forEach(el => {
      el.style.display = (el.dataset.panel === tab) ? 'block' : 'none';
    });
  };

  /* ── Founder check ───────────────────────────────────────────────── */
  const _FOUNDER_EMAIL = 'christijerina46@gmail.com';

  function _founderCheck() {
    if (window._snxRole === 'founder') return true;
    if (window.userData && window.userData.role === 'founder') return true;
    if (window._snxUserData && window._snxUserData.role === 'founder') return true;
    if (typeof founderOnly === 'function') return founderOnly();
    const _cu = window._snxCurrentUser || null;
    if (_cu && _cu.email && _cu.email.toLowerCase() === _FOUNDER_EMAIL) return true;
    const _role  = window._snxRole || (window.userData && window.userData.role) || 'unknown';
    const _email = (_cu && _cu.email) || 'not signed in';
    console.warn('[ThemeEngine] _founderCheck denied. _snxRole=' + _role + ', email=' + _email);
    _toast('⛔ Founder access only. (role: ' + _role + ')');
    return false;
  }

  /* ══════════════════════════════════════════════════════════════════
     RENDER FULL THEME ENGINE TAB IN FOUNDER CONTROL PANEL
     ══════════════════════════════════════════════════════════════════ */
  window.snxHtRenderAdminTab = function() {
    const container = document.getElementById('adminTab-holidaythemes');
    if (!container) return;
    const autoTheme = _getAutoTheme();
    const months    = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    /* ── Theme grid cards ── */
    const themeCards = Object.values(THEMES).map(t => {
      const [bg, acc] = t.swatch.split(',');
      const isActive  = _currentTheme === t.id;
      return `<div class="snx-holiday-card${isActive ? ' active-theme' : ''}"
                   data-theme-id="${t.id}"
                   onclick="window._snxHtSelectedPreview='${t.id}';document.querySelectorAll('#htThemeGrid .snx-holiday-card').forEach(c=>c.style.outline='');this.style.outline='2px solid #39FF14';snxHtPreview('${t.id}')">
        <span class="ht-emoji">${t.emoji}</span>
        <div class="ht-name">${t.name}</div>
        <div class="ht-swatch" style="background:linear-gradient(90deg,${bg},${acc})"></div>
        <span class="ht-active-badge">LIVE</span>
        <button onclick="event.stopPropagation();snxHtDuplicateTheme('${t.id}')"
                style="margin-top:6px;font-size:10px;padding:2px 8px;border-radius:6px;background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.12);color:#b8d4f0;width:100%;">
          📋 Duplicate
        </button>
      </div>`;
    }).join('');

    /* ── Schedule rows ── */
    const scheduleRows = SCHEDULE.map(s => {
      const isNow = autoTheme === s.themeId;
      const t     = THEMES[s.themeId] || {};
      return `<div class="snx-schedule-row">
        <span class="snx-schedule-emoji">${t.emoji||'🗓'}</span>
        <span class="snx-schedule-name">${t.name||s.themeId}</span>
        <span class="snx-schedule-dates">${months[s.month-1]} ${s.startDay}–${s.endDay}</span>
        <span class="snx-schedule-status${isNow?' active-now':''}" data-theme-id="${s.themeId}">${isNow?'ACTIVE NOW':'UPCOMING'}</span>
      </div>`;
    }).join('');

    /* ── Font options ── */
    const FONTS = [
      ["'Segoe UI', Arial, sans-serif",     'Segoe UI (Default)'],
      ["'Georgia', serif",                  'Georgia (Serif)'],
      ["'Courier New', monospace",          'Courier New (Mono)'],
      ["'Impact', fantasy",                 'Impact (Bold)'],
      ["'Comic Sans MS', cursive",          'Comic Sans'],
      ["'Trebuchet MS', sans-serif",        'Trebuchet MS'],
      ["'Palatino Linotype', serif",        'Palatino'],
      ["'Arial Black', sans-serif",         'Arial Black'],
    ];
    const fontOpts = FONTS.map(([val, lbl]) => `<option value="${val}">${lbl}</option>`).join('');

    /* ── Transition duration options ── */
    const TRANS_OPTS = ['0.15s','0.25s','0.35s','0.45s','0.6s','0.8s','1s'];
    const transOpts  = TRANS_OPTS.map(v => `<option value="${v}">${v}</option>`).join('');

    /* ── Cursor effect options ── */
    const CURSOR_OPTS = [
      ['none',      'None'],
      ['sparkle',   'Sparkle Trail'],
      ['heart',     'Heart Trail'],
      ['snowflake', 'Snowflake Trail'],
    ];
    const cursorOpts = CURSOR_OPTS.map(([v,l]) => `<option value="${v}">${l}</option>`).join('');

    container.innerHTML = `

    <!-- ══ STATUS BAR ══ -->
    <div class="section-card" style="margin-bottom:14px;border-color:rgba(0,174,239,0.45);background:linear-gradient(135deg,rgba(0,30,60,0.55),rgba(11,31,58,0.96));">
      <h3 style="margin:0 0 14px;font-size:13px;color:#00d4ff;text-transform:uppercase;letter-spacing:0.8px;">🎨 Founder Theme Engine</h3>

      <div class="settings-row">
        <div class="settings-label">Live Theme<small>Applied site-wide in real time</small></div>
        <strong id="htActiveThemeName" style="color:#00d4ff;font-size:13px;">—</strong>
      </div>

      <div class="settings-row">
        <div class="settings-label">Auto-activate by Calendar<small>Switches themes on holiday dates automatically</small></div>
        <label class="notif-toggle-wrap">
          <input type="checkbox" id="htToggleAuto" class="notif-toggle-cb" onchange="snxHtSetAuto(this.checked)">
          <span class="notif-toggle-slider"></span>
        </label>
      </div>

      <div class="settings-row">
        <div class="settings-label">Holiday Music<small>Allow users to turn on ambient music</small></div>
        <label class="notif-toggle-wrap">
          <input type="checkbox" id="htToggleMusic" class="notif-toggle-cb" onchange="snxHtSetMusic(this.checked)">
          <span class="notif-toggle-slider"></span>
        </label>
      </div>

      <div style="margin-top:10px;font-size:12px;color:#6a90b8;">
        Today's auto-suggestion: <strong style="color:#39FF14;">${(THEMES[autoTheme]||THEMES.none).emoji} ${(THEMES[autoTheme]||THEMES.none).name}</strong>
        &nbsp;&nbsp;<span id="htMusicStatus" style="font-size:11px;"></span>
      </div>

      <!-- Quick action buttons -->
      <div class="snx-holiday-actions" style="margin-top:14px;">
        <button onclick="snxHtPublish(window._snxHtSelectedPreview||'none')"
                style="font-size:12px;padding:8px 18px;border-radius:8px;background:rgba(57,255,20,0.14);border-color:rgba(57,255,20,0.45);color:#39FF14;font-weight:700;">
          ✅ Publish Selected
        </button>
        <button onclick="snxHtCancelPreview()" style="font-size:12px;padding:8px 14px;border-radius:8px;">
          👁 Cancel Preview
        </button>
        <button onclick="snxHtDisable()"
                style="font-size:12px;padding:8px 14px;border-radius:8px;background:rgba(255,51,80,0.10);border-color:rgba(255,51,80,0.35);color:#ff6680;font-weight:700;">
          🌑 Restore Default
        </button>
      </div>
    </div>

    <!-- ══ SUB-TAB NAV ══ -->
    <div class="ht-sub-tabs">
      <button class="ht-sub-tab active" data-tab="themes"    onclick="snxHtSwitchSubTab('themes')">🎨 Themes</button>
      <button class="ht-sub-tab"        data-tab="custom"    onclick="snxHtSwitchSubTab('custom')">🛠 Custom Builder</button>
      <button class="ht-sub-tab"        data-tab="presets"   onclick="snxHtSwitchSubTab('presets')">💾 Presets</button>
      <button class="ht-sub-tab"        data-tab="schedule"  onclick="snxHtSwitchSubTab('schedule')">📅 Schedule</button>
    </div>

    <!-- ══ PANEL: THEMES ══ -->
    <div class="ht-sub-panel" data-panel="themes">
      <div class="section-card" style="margin-bottom:14px;">
        <h3 style="margin:0 0 6px;font-size:13px;color:#00d4ff;text-transform:uppercase;letter-spacing:0.8px;">🎄 Holiday Presets</h3>
        <p style="font-size:11px;color:#6a90b8;margin:0 0 10px;">Click a card to preview locally. Press <strong style="color:#39FF14;">Publish Selected</strong> above to push to all users instantly. Click 📋 Duplicate to copy into Custom Builder.</p>
        <div class="snx-holiday-grid" id="htThemeGrid">${themeCards}</div>
      </div>
    </div>

    <!-- ══ PANEL: CUSTOM BUILDER ══ -->
    <div class="ht-sub-panel" data-panel="custom" style="display:none;">
      <div class="section-card" style="margin-bottom:14px;">
        <h3 style="margin:0 0 4px;font-size:13px;color:#00d4ff;text-transform:uppercase;letter-spacing:0.8px;">🛠 Custom Theme Builder</h3>
        <p style="font-size:11px;color:#6a90b8;margin:0 0 12px;">Design a full custom theme. Preview live, then publish site-wide. Duplicate any holiday preset to start from it.</p>

        <!-- COLOURS -->
        <div class="snx-custom-theme-builder">
          <h4>🎨 Background Colours</h4>
          <div class="snx-color-row"><label>Main Background</label>
            <input type="color" id="htCustomBgMainPicker"  value="#0B1F3A" oninput="document.getElementById('htCustomBgMainHex').value=this.value">
            <input type="text"  id="htCustomBgMainHex"     value="#0B1F3A" oninput="document.getElementById('htCustomBgMainPicker').value=this.value"></div>
          <div class="snx-color-row"><label>Card Background</label>
            <input type="color" id="htCustomBgCardPicker"  value="#0d2444" oninput="document.getElementById('htCustomBgCardHex').value=this.value">
            <input type="text"  id="htCustomBgCardHex"     value="#0d2444" oninput="document.getElementById('htCustomBgCardPicker').value=this.value"></div>
          <div class="snx-color-row"><label>Input Background</label>
            <input type="color" id="htCustomBgInputPicker" value="#0a1c35" oninput="document.getElementById('htCustomBgInputHex').value=this.value">
            <input type="text"  id="htCustomBgInputHex"    value="#0a1c35" oninput="document.getElementById('htCustomBgInputPicker').value=this.value"></div>
          <div class="snx-color-row"><label>Menu / Nav Background</label>
            <input type="color" id="htCustomNavBgPicker"   value="#050f1e" oninput="document.getElementById('htCustomNavBgHex').value=this.value">
            <input type="text"  id="htCustomNavBgHex"      value="#050f1e" oninput="document.getElementById('htCustomNavBgPicker').value=this.value"></div>
        </div>

        <div class="snx-custom-theme-builder" style="margin-top:10px;">
          <h4>✏️ Text Colours</h4>
          <div class="snx-color-row"><label>Primary Text</label>
            <input type="color" id="htCustomTextPrimaryPicker"   value="#ffffff" oninput="document.getElementById('htCustomTextPrimaryHex').value=this.value">
            <input type="text"  id="htCustomTextPrimaryHex"      value="#ffffff" oninput="document.getElementById('htCustomTextPrimaryPicker').value=this.value"></div>
          <div class="snx-color-row"><label>Secondary Text</label>
            <input type="color" id="htCustomTextSecondaryPicker" value="#b8d4f0" oninput="document.getElementById('htCustomTextSecondaryHex').value=this.value">
            <input type="text"  id="htCustomTextSecondaryHex"    value="#b8d4f0" oninput="document.getElementById('htCustomTextSecondaryPicker').value=this.value"></div>
        </div>

        <div class="snx-custom-theme-builder" style="margin-top:10px;">
          <h4>⚡ Accent &amp; Button Colours</h4>
          <div class="snx-color-row"><label>Primary Accent</label>
            <input type="color" id="htCustomAccentPicker"  value="#00AEEF" oninput="document.getElementById('htCustomAccentHex').value=this.value">
            <input type="text"  id="htCustomAccentHex"     value="#00AEEF" oninput="document.getElementById('htCustomAccentPicker').value=this.value"></div>
          <div class="snx-color-row"><label>Secondary Accent</label>
            <input type="color" id="htCustomAccent2Picker" value="#39FF14" oninput="document.getElementById('htCustomAccent2Hex').value=this.value">
            <input type="text"  id="htCustomAccent2Hex"    value="#39FF14" oninput="document.getElementById('htCustomAccent2Picker').value=this.value"></div>
          <div class="snx-color-row"><label>Border Colour</label>
            <input type="color" id="htCustomBorderPicker"  value="#1a3a5c" oninput="document.getElementById('htCustomBorderHex').value=this.value">
            <input type="text"  id="htCustomBorderHex"     value="#1a3a5c" oninput="document.getElementById('htCustomBorderPicker').value=this.value"></div>
          <div class="snx-color-row"><label>Banner Colour A</label>
            <input type="color" id="htCustomBanner1Picker" value="#00AEEF" oninput="document.getElementById('htCustomBanner1Hex').value=this.value">
            <input type="text"  id="htCustomBanner1Hex"    value="#00AEEF" oninput="document.getElementById('htCustomBanner1Picker').value=this.value"></div>
          <div class="snx-color-row"><label>Banner Colour B</label>
            <input type="color" id="htCustomBanner2Picker" value="#39FF14" oninput="document.getElementById('htCustomBanner2Hex').value=this.value">
            <input type="text"  id="htCustomBanner2Hex"    value="#39FF14" oninput="document.getElementById('htCustomBanner2Picker').value=this.value"></div>
          <div class="snx-color-row"><label>Scrollbar Colour</label>
            <input type="color" id="htCustomScrollbarPicker" value="#1a3a5c" oninput="document.getElementById('htCustomScrollbar').value=this.value">
            <input type="text"  id="htCustomScrollbar"       value="rgba(0,100,220,0.22)"></div>
        </div>

        <div class="snx-custom-theme-builder" style="margin-top:10px;">
          <h4>🔤 Typography</h4>
          <div class="snx-color-row"><label>Body Font</label>
            <select id="htCustomFontBodySel">${fontOpts}</select></div>
          <div class="snx-color-row"><label>Heading Font</label>
            <select id="htCustomFontHeadingSel">${fontOpts}</select></div>
          <div class="snx-color-row"><label>Base Font Size</label>
            <input type="text" id="htCustomFontSize" value="14px" style="width:80px;"></div>
        </div>

        <div class="snx-custom-theme-builder" style="margin-top:10px;">
          <h4>🖼 Wallpaper &amp; Logo</h4>
          <div class="snx-color-row"><label>Wallpaper URL</label>
            <input type="text" id="htCustomWallpaperUrl" placeholder="https://…image.jpg" style="width:200px;min-width:0;flex:1;"></div>
          <div class="snx-color-row"><label>Wallpaper Opacity</label>
            <input type="number" id="htCustomWallpaperOpacity" value="0.12" min="0.01" max="0.95" step="0.01" style="width:70px;"></div>
          <div class="snx-color-row"><label>Logo URL</label>
            <input type="text" id="htCustomLogoUrl" placeholder="https://…logo.png (optional)" style="width:200px;min-width:0;flex:1;"></div>
          <p style="font-size:10px;color:#6a90b8;margin:4px 0 0;">Add <code style="background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:4px;">data-snx-logo</code> attribute to your logo &lt;img&gt; elements to enable logo override.</p>
        </div>

        <div class="snx-custom-theme-builder" style="margin-top:10px;">
          <h4>✨ Effects &amp; Animations</h4>
          <div class="snx-color-row"><label>Page Transition</label>
            <select id="htCustomTransitionDur">${transOpts}</select></div>
          <div class="snx-color-row"><label>Card Border Radius</label>
            <input type="text" id="htCustomRadiusCard" value="10px" style="width:70px;"></div>
          <div class="snx-color-row"><label>Cursor Effect (Desktop)</label>
            <select id="htCustomCursorEffect">${cursorOpts}</select></div>
          <p style="font-size:10px;color:#6a90b8;margin:4px 0 0;">Cursor effects are cosmetic and do not affect touch/mobile devices. Particles are inherited from the base theme type.</p>
        </div>

        <div class="snx-holiday-actions" style="margin-top:14px;">
          <button onclick="snxHtPreviewCustom()" style="font-size:12px;padding:7px 14px;border-radius:8px;">👁 Preview Custom</button>
          <button onclick="snxHtPublishCustom()"
                  style="font-size:12px;padding:7px 18px;border-radius:8px;background:rgba(57,255,20,0.12);border-color:rgba(57,255,20,0.4);color:#39FF14;font-weight:700;">
            ✅ Publish Custom Theme
          </button>
        </div>
      </div>
    </div>

    <!-- ══ PANEL: PRESETS ══ -->
    <div class="ht-sub-panel" data-panel="presets" style="display:none;">
      <div class="section-card" style="margin-bottom:14px;">
        <h3 style="margin:0 0 10px;font-size:13px;color:#00d4ff;text-transform:uppercase;letter-spacing:0.8px;">💾 Theme Presets</h3>
        <p style="font-size:11px;color:#6a90b8;margin:0 0 10px;">Save the current live theme as a named preset to restore it instantly any time. Unlimited presets supported.</p>
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
          <input id="htPresetNameInput" placeholder="Preset name…" style="flex:1;min-width:140px;margin:0;font-size:12px;padding:7px 10px;">
          <button onclick="snxHtSavePreset()" style="font-size:12px;padding:7px 14px;border-radius:8px;background:rgba(0,174,239,0.12);border-color:rgba(0,174,239,0.35);color:#00d4ff;font-weight:700;">💾 Save Current</button>
        </div>
        <div id="htPresetsList"><p style="font-size:12px;color:#6a90b8;margin:0;">No presets saved yet.</p></div>
      </div>
    </div>

    <!-- ══ PANEL: SCHEDULE ══ -->
    <div class="ht-sub-panel" data-panel="schedule" style="display:none;">
      <div class="section-card">
        <h3 style="margin:0 0 12px;font-size:13px;color:#00d4ff;text-transform:uppercase;letter-spacing:0.8px;">📅 Auto-Activation Schedule</h3>
        <p style="font-size:11px;color:#6a90b8;margin:0 0 10px;">When <strong>Auto-activate by Calendar</strong> is ON, themes switch automatically on these dates. A manual selection always overrides the schedule.</p>
        ${scheduleRows}
      </div>
    </div>`;

    // Hydrate with Firestore state
    _getFs().then(fs => {
      if (!fs) return;
      fs.getDoc(fs.doc(fs.db,'siteSettings','holidayTheme')).then(snap => {
        if (!snap.exists()) {
          const cb  = document.getElementById('htToggleAuto');  if (cb)  cb.checked  = true;
          const mcb = document.getElementById('htToggleMusic'); if (mcb) mcb.checked = true;
          return;
        }
        _syncAdminFullUI(snap.data());
        _syncAdminUI();
      }).catch(() => {});
    });

    // Restore active sub-tab
    window.snxHtSwitchSubTab(_activeSubTab);
  };

  /* ── User music preference restore ──────────────────────────────── */
  try {
    const _saved = localStorage.getItem('snx-music-pref');
    if (_saved === '1') _userMusicOn = true;
  } catch(_) {}

  /* ── Boot ────────────────────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _startFirestoreListener);
  } else {
    _startFirestoreListener();
  }

  // Expose for debugging / other modules
  window._snxHolidayThemes = {
    THEMES,
    SCHEDULE,
    getAutoTheme: _getAutoTheme,
    get currentTheme() { return _currentTheme; },
  };

})();
