/* ══════════════════════════════════════════════════════════════════
   SHADOW NEXUS SOCIAL — HOLIDAY THEMES ENGINE  v1.0
   ─────────────────────────────────────────────────────────────────
   • Reads siteSettings/holidayTheme from Firestore in real-time
   • Applies [data-snx-theme] to <html> for CSS variable overrides
   • Renders floating particles (snow, confetti, hearts, etc.)
   • Shows a 3px colour stripe banner at the top of the page
   • On index.html: piggybacks on window._snxFirestore (already init)
   • On other pages: self-bootstraps Firebase (same config/version)
   • Founder Control Panel tab: full UI rendered by snxHtRenderAdminTab()
   ══════════════════════════════════════════════════════════════════ */
(function _snxHolidayThemes() {
  'use strict';

  /* ── Theme catalogue ────────────────────────────────────────────── */
  const THEMES = {
    none:         { id:'none',         name:'Default (No Theme)', emoji:'🌑', swatch:'#0B1F3A,#00AEEF',   particles:null        },
    newyears:     { id:'newyears',     name:"New Year's",         emoji:'🎆', swatch:'#0a0a12,#FFD700',   particles:'confetti'  },
    valentines:   { id:'valentines',   name:"Valentine's Day",    emoji:'💝', swatch:'#1a0810,#FF6B8A',   particles:'hearts'    },
    stpatricks:   { id:'stpatricks',   name:"St. Patrick's Day",  emoji:'🍀', swatch:'#061a08,#2ED74A',   particles:'clovers'   },
    easter:       { id:'easter',       name:'Easter',             emoji:'🐣', swatch:'#120e1f,#B87CFF',   particles:'eggs'      },
    memorialday:  { id:'memorialday',  name:'Memorial Day',       emoji:'🇺🇸', swatch:'#060b1a,#4A90D9',   particles:'stars'     },
    july4:        { id:'july4',        name:'Independence Day',   emoji:'🎇', swatch:'#03081a,#4466FF',   particles:'fireworks' },
    halloween:    { id:'halloween',    name:'Halloween',          emoji:'🎃', swatch:'#0f0508,#FF6A00',   particles:'bats'      },
    thanksgiving: { id:'thanksgiving', name:'Thanksgiving',       emoji:'🦃', swatch:'#110a02,#E07020',   particles:'leaves'    },
    christmas:    { id:'christmas',    name:'Christmas',          emoji:'🎄', swatch:'#040f04,#D42020',   particles:'snow'      },
    winter:       { id:'winter',       name:'Winter',             emoji:'❄️', swatch:'#050d18,#7EC8E3',   particles:'snow'      },
    birthday:     { id:'birthday',     name:'Birthday',           emoji:'🎂', swatch:'#0a0418,#FF44CC',   particles:'confetti'  },
    anniversary:  { id:'anniversary',  name:'Anniversary',        emoji:'💫', swatch:'#0e0a04,#D4A840',   particles:'sparkles'  },
    custom:       { id:'custom',       name:'Custom Theme',       emoji:'🎨', swatch:'#0B1F3A,#00AEEF',   particles:'sparkles'  },
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

  /* ── Firebase config (same project, same SDK version as the rest of the app) */
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
  let _currentTheme  = 'none';
  let _previewMode   = false;
  let _previewTimer  = null;
  let _particleAnim  = null;
  let _unsubscribe   = null;
  let _fsApi         = null;   // { db, doc, getDoc, setDoc, onSnapshot }

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
    // 1. Main page already exposes it
    if (window._snxFirestore) {
      return {
        db:         window._snxFirestore.db,
        doc:        window._snxFirestore.doc,
        getDoc:     window._snxFirestore.getDoc,
        setDoc:     window._snxFirestore.setDoc,
        onSnapshot: window._snxFirestore.onSnapshot,
      };
    }
    // 2. Self-bootstrap via dynamic import (secondary pages)
    if (_fsApi) return _fsApi;
    try {
      const [appMod, fsMod] = await Promise.all([
        import(`${_FB_SDK}/firebase-app.js`),
        import(`${_FB_SDK}/firebase-firestore.js`),
      ]);
      const { initializeApp, getApps, getApp } = appMod;
      const { getFirestore, doc, getDoc, setDoc, onSnapshot } = fsMod;
      const app = getApps().length ? getApp() : initializeApp(_FIREBASE_CFG, 'snx-ht-app');
      const db  = getFirestore(app);
      _fsApi = { db, doc, getDoc, setDoc, onSnapshot };
      return _fsApi;
    } catch(e) {
      console.warn('[HolidayThemes] Firestore bootstrap failed:', e);
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

    // Custom vars: inject on <html> element so they override the theme block
    if (themeId === 'custom' && customVars) {
      for (const [key, val] of Object.entries(customVars)) {
        html.style.setProperty(key, val);
      }
    } else if (themeId !== 'custom') {
      // Remove leftover custom var overrides so the CSS theme class takes effect
      ['--bg-main','--bg-card','--bg-input','--bg-deep','--bg-deeper',
       '--neon-blue','--neon-cyan','--neon-blue-dim','--neon-green','--neon-green-dim',
       '--text-primary','--text-secondary','--text-muted','--border-color','--accent-glow',
       '--blue-glow-sm','--blue-glow-md','--blue-glow-lg','--green-glow-sm','--green-glow-md',
       '--ht-banner-gradient'].forEach(k => html.style.removeProperty(k));
    }

    // Banner stripe
    const banner = document.getElementById('snxHolidayBanner');
    if (banner) banner.classList.toggle('visible', themeId !== 'none');

    // Particles
    _startParticles(themeId);
    _currentTheme = themeId;
    _syncAdminUI();
  }

  /* ── BroadcastChannel: keep same-origin tabs in sync ────────────── */
  const _bc = (typeof BroadcastChannel !== 'undefined')
    ? new BroadcastChannel('snx-holiday-theme') : null;

  if (_bc) {
    _bc.onmessage = (e) => {
      if (e.data && e.data.type === 'snx-theme-apply') {
        _applyTheme(e.data.themeId, e.data.customVars || null);
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
          const data         = snap.data();
          const autoEnabled  = data.autoEnabled !== false;
          const manualTheme  = data.manualTheme  || 'none';
          const customVars   = data.customVars   || null;

          let resolvedTheme;
          if (manualTheme !== 'none' && manualTheme !== 'auto') {
            resolvedTheme = manualTheme;
          } else if (autoEnabled) {
            resolvedTheme = _getAutoTheme();
          } else {
            resolvedTheme = 'none';
          }
          _applyTheme(resolvedTheme, customVars);
          _broadcastApply(resolvedTheme, customVars);
        },
        (err) => { console.warn('[HolidayThemes] snapshot error:', err); }
      );
    } catch(e) {
      console.warn('[HolidayThemes] listener failed:', e);
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
    window.addEventListener('resize', _resize, { passive: true });

    const PARTICLE_COLORS = {
      snow:      ['#C0E8F5','#E0F4FF','#ffffff','#B0D8F8'],
      confetti:  ['#FF44CC','#FFDD00','#44CCFF','#FF8800','#FFD700','#39FF14'],
      hearts:    ['#FF6B8A','#FF9EB8','#FFBFD0','#FF3366'],
      clovers:   ['#2ED74A','#78F08E','#FFD700','#1a9e30'],
      eggs:      ['#B87CFF','#80E878','#FFD700','#7EB8FF','#FF9EB8'],
      bats:      ['#AA44FF','#FF6A00','#7722CC','#B84A00'],
      leaves:    ['#E07020','#D4920A','#8B3A00','#A05010','#F0A050'],
      fireworks: ['#FF3322','#4466FF','#ffffff','#FFDD00'],
      sparkles:  ['#D4A840','#EED090','#FFD700','#C8805A'],
      stars:     ['#4A90D9','#D93030','#ffffff','#80B8F0'],
    };

    function _mkP() {
      const col = PARTICLE_COLORS[type] || ['#ffffff'];
      return {
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height - canvas.height,
        size:  Math.random() * 7 + 3,
        speed: Math.random() * 1.5 + 0.5,
        drift: (Math.random() - 0.5) * 0.8,
        rot:   Math.random() * Math.PI * 2,
        rotV:  (Math.random() - 0.5) * 0.06,
        color: col[Math.floor(Math.random() * col.length)],
        alpha: Math.random() * 0.5 + 0.4,
      };
    }

    const particles = Array.from({ length: 55 }, _mkP);

    function _drawP(ctx, p) {
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle   = p.color;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      const s = p.size;
      if (type === 'hearts') {
        ctx.beginPath();
        ctx.moveTo(0, -s*0.4);
        ctx.bezierCurveTo( s*0.6,-s, s*1.2,-s*0.3, 0, s*0.5);
        ctx.bezierCurveTo(-s*1.2,-s*0.3,-s*0.6,-s, 0,-s*0.4);
        ctx.fill();
      } else if (type === 'snow' || type === 'eggs') {
        ctx.beginPath(); ctx.arc(0, 0, s/2, 0, Math.PI*2); ctx.fill();
      } else if (type === 'bats') {
        ctx.beginPath();
        ctx.arc(-s*0.5, 0, s*0.55, 0, Math.PI, false);
        ctx.arc( s*0.5, 0, s*0.55, 0, Math.PI, false);
        ctx.lineTo(0, s*0.6); ctx.fill();
      } else if (type === 'sparkles' || type === 'stars') {
        ctx.strokeStyle = p.color; ctx.lineWidth = 1.5;
        for (let i = 0; i < 4; i++) {
          ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(0,-s); ctx.stroke();
          ctx.rotate(Math.PI/2);
        }
      } else {
        ctx.fillRect(-s*0.3, -s*0.5, s*0.6, s);
      }
      ctx.restore();
    }

    function _tick() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of particles) {
        p.y += p.speed; p.x += p.drift; p.rot += p.rotV;
        if (p.y > canvas.height + 20) { const np = _mkP(); np.y = -20; Object.assign(p, np); }
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
  }

  /* ══════════════════════════════════════════════════════════════════
     PUBLIC API — called by Founder Control Panel
     ══════════════════════════════════════════════════════════════════ */

  window.snxHtPreview = function(themeId) {
    _previewMode = true;
    window._snxHtSelectedPreview = themeId;
    if (_previewTimer) clearTimeout(_previewTimer);
    _applyTheme(themeId);
    const badge = document.getElementById('snxThemePreviewBadge');
    const t = THEMES[themeId] || THEMES.none;
    if (badge) {
      badge.textContent = `PREVIEW: ${t.emoji} ${t.name} — Click Publish to go live`;
      badge.classList.add('visible');
    }
    _previewTimer = setTimeout(() => { if (_previewMode) window.snxHtCancelPreview(); }, 30000);
  };

  window.snxHtCancelPreview = async function() {
    _previewMode = false;
    if (_previewTimer) { clearTimeout(_previewTimer); _previewTimer = null; }
    const badge = document.getElementById('snxThemePreviewBadge');
    if (badge) badge.classList.remove('visible');
    // Revert to whatever is live in Firestore
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
      if (typeof window.adminAuditLog === 'function')
        window.adminAuditLog('HOLIDAY_THEME_SET', `theme=${themeId}`);
    } catch(e) { _toast('❌ Publish failed: ' + e.message); }
  };

  window.snxHtDisable = async function() {
    if (!_founderCheck()) return;
    const fs = await _getFs();
    if (!fs) return;
    try {
      await fs.setDoc(fs.doc(fs.db,'siteSettings','holidayTheme'),
        { manualTheme:'none', updatedAt: Date.now() }, { merge: true });
      _toast('🌑 Holiday theme disabled.');
      if (typeof window.adminAuditLog === 'function')
        window.adminAuditLog('HOLIDAY_THEME_SET', 'theme=none (disabled)');
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
        window.adminAuditLog('HOLIDAY_THEME_SET', 'theme=custom');
    } catch(e) { _toast('❌ ' + e.message); }
  };

  window.snxHtPreviewCustom = function() {
    const vars = _readCustomFormVars();
    for (const [k, v] of Object.entries(vars))
      document.documentElement.style.setProperty(k, v);
    _previewMode = true;
    _applyTheme('custom', vars);
    const badge = document.getElementById('snxThemePreviewBadge');
    if (badge) { badge.textContent = 'PREVIEW: 🎨 Custom Theme — Click Publish to go live'; badge.classList.add('visible'); }
    if (_previewTimer) clearTimeout(_previewTimer);
    _previewTimer = setTimeout(() => { if (_previewMode) window.snxHtCancelPreview(); }, 30000);
  };

  function _readCustomFormVars() {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const b1  = val('htCustomBanner1Picker') || val('htCustomBanner1Hex') || '#00AEEF';
    const b2  = val('htCustomBanner2Picker') || val('htCustomBanner2Hex') || '#39FF14';
    const acc = val('htCustomAccentPicker')  || val('htCustomAccentHex')  || '#00AEEF';
    return {
      '--bg-main':              val('htCustomBgMainPicker')       || val('htCustomBgMainHex')       || '#0B1F3A',
      '--bg-card':              val('htCustomBgCardPicker')       || val('htCustomBgCardHex')       || '#0d2444',
      '--neon-blue':            acc,
      '--neon-cyan':            acc + 'cc',
      '--neon-blue-dim':        acc,
      '--neon-green':           val('htCustomAccent2Picker')      || val('htCustomAccent2Hex')      || '#39FF14',
      '--neon-green-dim':       val('htCustomAccent2Picker')      || val('htCustomAccent2Hex')      || '#39FF14',
      '--text-primary':         val('htCustomTextPrimaryPicker')  || val('htCustomTextPrimaryHex')  || '#ffffff',
      '--ht-banner-gradient':   `linear-gradient(90deg,${b1},${b2},${b1})`,
      '--accent-glow':          acc + '4d',
    };
  }

  /* ── Founder email constant — must match the one in index.html ── */
  const _FOUNDER_EMAIL = 'christijerina46@gmail.com';

  function _founderCheck() {
    // 1. window._snxRole is set immediately from email in onAuthStateChanged —
    //    most reliable check, available even before Firestore snapshot returns.
    if (window._snxRole === 'founder') return true;
    // 2. window.userData is kept in sync by the onSnapshot listener in index.html.
    if (window.userData && window.userData.role === 'founder') return true;
    // 3. window._snxUserData is the same object under the canonical alias.
    if (window._snxUserData && window._snxUserData.role === 'founder') return true;
    // 4. Delegate to the main founderOnly() guard (index.html IIFE scope).
    if (typeof founderOnly === 'function') return founderOnly();
    // 5. Last resort: verify by email directly.
    const _cu = window._snxCurrentUser || null;
    if (_cu && _cu.email && _cu.email.toLowerCase() === _FOUNDER_EMAIL) return true;
    // Log the exact state for debugging instead of a generic error.
    const _role  = window._snxRole || (window.userData && window.userData.role) || 'unknown';
    const _email = (_cu && _cu.email) || 'not signed in';
    console.warn('[HolidayThemes] _founderCheck denied. _snxRole=' + _role + ', email=' + _email);
    _toast('⛔ Founder access only. (role: ' + _role + ')');
    return false;
  }

  /* ── Render full Holiday Themes tab in Founder Control Panel ─────── */
  window.snxHtRenderAdminTab = function() {
    const container = document.getElementById('adminTab-holidaythemes');
    if (!container) return;
    const autoTheme = _getAutoTheme();

    const themeCards = Object.values(THEMES).map(t => {
      const [bg, acc] = t.swatch.split(',');
      return `<div class="snx-holiday-card${_currentTheme === t.id ? ' active-theme' : ''}"
                   data-theme-id="${t.id}"
                   onclick="snxHtPreview('${t.id}')">
        <span class="ht-emoji">${t.emoji}</span>
        <div class="ht-name">${t.name}</div>
        <div class="ht-swatch" style="background:linear-gradient(90deg,${bg},${acc})"></div>
        <span class="ht-active-badge">LIVE</span>
      </div>`;
    }).join('');

    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const scheduleRows = SCHEDULE.map(s => {
      const isNow = autoTheme === s.themeId;
      const t = THEMES[s.themeId] || {};
      return `<div class="snx-schedule-row">
        <span class="snx-schedule-emoji">${t.emoji||'🗓'}</span>
        <span class="snx-schedule-name">${t.name||s.themeId}</span>
        <span class="snx-schedule-dates">${months[s.month-1]} ${s.startDay}–${s.endDay}</span>
        <span class="snx-schedule-status${isNow?' active-now':''}" data-theme-id="${s.themeId}">${isNow?'ACTIVE NOW':'UPCOMING'}</span>
      </div>`;
    }).join('');

    container.innerHTML = `
    <div class="section-card" style="margin-bottom:14px;">
      <h3 style="margin:0 0 12px;font-size:13px;color:#00d4ff;text-transform:uppercase;letter-spacing:0.8px;">🎨 Current Status</h3>
      <div class="settings-row">
        <div class="settings-label">Auto-activate by calendar<small>Switches themes automatically on holidays</small></div>
        <label class="notif-toggle-wrap">
          <input type="checkbox" id="htToggleAuto" class="notif-toggle-cb" onchange="snxHtSetAuto(this.checked)">
          <span class="notif-toggle-slider"></span>
        </label>
      </div>
      <div style="margin-top:10px;font-size:12px;color:#6a90b8;">
        Live theme: <strong id="htActiveThemeName" style="color:#00d4ff;">—</strong>
        &nbsp;|&nbsp;
        Auto-suggestion today: <strong style="color:#39FF14;">${(THEMES[autoTheme]||THEMES.none).emoji} ${(THEMES[autoTheme]||THEMES.none).name}</strong>
      </div>
    </div>

    <div class="section-card" style="margin-bottom:14px;">
      <h3 style="margin:0 0 6px;font-size:13px;color:#00d4ff;text-transform:uppercase;letter-spacing:0.8px;">🎨 Select Theme</h3>
      <p style="font-size:11px;color:#6a90b8;margin:0 0 2px;">Click a theme card to preview it, then press Publish.</p>
      <div class="snx-holiday-grid" id="htThemeGrid">${themeCards}</div>
      <div class="snx-holiday-actions">
        <button onclick="snxHtPublish(window._snxHtSelectedPreview||'none')"
                style="font-size:12px;padding:7px 18px;border-radius:8px;background:rgba(57,255,20,0.12);border-color:rgba(57,255,20,0.4);color:#39FF14;font-weight:700;">
          ✅ Publish Selected Theme
        </button>
        <button onclick="snxHtCancelPreview()" style="font-size:12px;padding:7px 14px;border-radius:8px;">
          👁 Cancel Preview
        </button>
        <button onclick="snxHtDisable()"
                style="font-size:12px;padding:7px 14px;border-radius:8px;background:rgba(255,51,80,0.1);border-color:rgba(255,51,80,0.35);color:#ff6680;">
          🚫 Disable Theme
        </button>
      </div>
    </div>

    <div class="section-card" style="margin-bottom:14px;">
      <h3 style="margin:0 0 12px;font-size:13px;color:#00d4ff;text-transform:uppercase;letter-spacing:0.8px;">🎨 Custom Theme Builder</h3>
      <p style="font-size:11px;color:#6a90b8;margin:0 0 10px;">Design your own colour scheme, preview it live, then publish.</p>
      <div class="snx-custom-theme-builder">
        <h4>Colour Settings</h4>
        <div class="snx-color-row"><label>Background</label>
          <input type="color" id="htCustomBgMainPicker" value="#0B1F3A" oninput="document.getElementById('htCustomBgMainHex').value=this.value">
          <input type="text"  id="htCustomBgMainHex"   value="#0B1F3A" oninput="document.getElementById('htCustomBgMainPicker').value=this.value"></div>
        <div class="snx-color-row"><label>Card Background</label>
          <input type="color" id="htCustomBgCardPicker" value="#0d2444" oninput="document.getElementById('htCustomBgCardHex').value=this.value">
          <input type="text"  id="htCustomBgCardHex"   value="#0d2444" oninput="document.getElementById('htCustomBgCardPicker').value=this.value"></div>
        <div class="snx-color-row"><label>Primary Accent</label>
          <input type="color" id="htCustomAccentPicker" value="#00AEEF" oninput="document.getElementById('htCustomAccentHex').value=this.value">
          <input type="text"  id="htCustomAccentHex"   value="#00AEEF" oninput="document.getElementById('htCustomAccentPicker').value=this.value"></div>
        <div class="snx-color-row"><label>Secondary Accent</label>
          <input type="color" id="htCustomAccent2Picker" value="#39FF14" oninput="document.getElementById('htCustomAccent2Hex').value=this.value">
          <input type="text"  id="htCustomAccent2Hex"   value="#39FF14" oninput="document.getElementById('htCustomAccent2Picker').value=this.value"></div>
        <div class="snx-color-row"><label>Text Colour</label>
          <input type="color" id="htCustomTextPrimaryPicker" value="#ffffff" oninput="document.getElementById('htCustomTextPrimaryHex').value=this.value">
          <input type="text"  id="htCustomTextPrimaryHex"   value="#ffffff" oninput="document.getElementById('htCustomTextPrimaryPicker').value=this.value"></div>
        <div class="snx-color-row"><label>Banner Colour A</label>
          <input type="color" id="htCustomBanner1Picker" value="#00AEEF" oninput="document.getElementById('htCustomBanner1Hex').value=this.value">
          <input type="text"  id="htCustomBanner1Hex"   value="#00AEEF" oninput="document.getElementById('htCustomBanner1Picker').value=this.value"></div>
        <div class="snx-color-row"><label>Banner Colour B</label>
          <input type="color" id="htCustomBanner2Picker" value="#39FF14" oninput="document.getElementById('htCustomBanner2Hex').value=this.value">
          <input type="text"  id="htCustomBanner2Hex"   value="#39FF14" oninput="document.getElementById('htCustomBanner2Picker').value=this.value"></div>
        <div class="snx-holiday-actions" style="margin-top:12px;">
          <button onclick="snxHtPreviewCustom()" style="font-size:12px;padding:7px 14px;border-radius:8px;">👁 Preview Custom</button>
          <button onclick="snxHtPublishCustom()"
                  style="font-size:12px;padding:7px 18px;border-radius:8px;background:rgba(57,255,20,0.12);border-color:rgba(57,255,20,0.4);color:#39FF14;font-weight:700;">
            ✅ Publish Custom Theme
          </button>
        </div>
      </div>
    </div>

    <div class="section-card">
      <h3 style="margin:0 0 12px;font-size:13px;color:#00d4ff;text-transform:uppercase;letter-spacing:0.8px;">📅 Auto-Activation Schedule</h3>
      <p style="font-size:11px;color:#6a90b8;margin:0 0 10px;">When auto-activate is ON, theme changes happen automatically on these dates.</p>
      ${scheduleRows}
    </div>`;

    // Load Firestore state into the UI
    _getFs().then(fs => {
      if (!fs) return;
      fs.getDoc(fs.doc(fs.db,'siteSettings','holidayTheme')).then(snap => {
        const cb  = document.getElementById('htToggleAuto');
        const nEl = document.getElementById('htActiveThemeName');
        if (!snap.exists()) { if (cb) cb.checked = true; return; }
        const d = snap.data();
        if (cb)  cb.checked = d.autoEnabled !== false;
        if (nEl) {
          const t = THEMES[d.manualTheme] || THEMES.none;
          nEl.textContent = `${t.emoji} ${t.name}`;
        }
      }).catch(() => {});
    });

    // Card click → track selected for Publish button
    document.querySelectorAll('#htThemeGrid .snx-holiday-card').forEach(card => {
      card.addEventListener('click', () => {
        window._snxHtSelectedPreview = card.dataset.themeId;
      });
    });
  };

  /* ── Boot ────────────────────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _startFirestoreListener);
  } else {
    _startFirestoreListener();
  }

  // Expose for debugging
  window._snxHolidayThemes = { THEMES, SCHEDULE, getAutoTheme: _getAutoTheme };

})();
