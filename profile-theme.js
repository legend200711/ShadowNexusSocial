/* ══════════════════════════════════════════════════════════════
   Shadow Nexus Social — Profile Theme System
   Handles: theme editor, built-in themes, manager, animations
   ══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Built-in Themes ───────────────────────────────────────────
  const BUILTIN_THEMES = {
    shadow:        { name: 'Shadow',        bg: '#0B1F3A', card: '#0d2444', accent: '#00AEEF', text: '#ffffff', border: '#1a3a5c', gradient: 'linear-gradient(135deg,#071428,#0B1F3A)' },
    eclipse:       { name: 'Eclipse',       bg: '#0a0a0f', card: '#12121f', accent: '#9b59b6', text: '#e0e0e0', border: '#2a1a3c', gradient: 'linear-gradient(135deg,#05050a,#1a0a2a)' },
    midnight:      { name: 'Midnight',      bg: '#05071a', card: '#0a0d30', accent: '#3b4fd8', text: '#cdd0ff', border: '#1a1f5c', gradient: 'linear-gradient(135deg,#02030f,#0d1040)' },
    ocean:         { name: 'Ocean',         bg: '#0a1628', card: '#0d2244', accent: '#00c8ff', text: '#b8e4f0', border: '#0a3050', gradient: 'linear-gradient(135deg,#071020,#0a2040)' },
    forest:        { name: 'Forest',        bg: '#0a1e0a', card: '#0d2e0d', accent: '#39FF14', text: '#c0e8c0', border: '#1a3a1a', gradient: 'linear-gradient(135deg,#050f05,#0a2010)' },
    crimson:       { name: 'Crimson',       bg: '#1a0505', card: '#2a0808', accent: '#ff4757', text: '#f0c0c0', border: '#3c1010', gradient: 'linear-gradient(135deg,#0f0202,#200808)' },
    emerald:       { name: 'Emerald',       bg: '#041a12', card: '#072a1c', accent: '#00e676', text: '#b8f0d4', border: '#0a3020', gradient: 'linear-gradient(135deg,#020f09,#052015)' },
    iceblue:       { name: 'Ice Blue',      bg: '#e8f4fb', card: '#d0e8f8', accent: '#0077cc', text: '#1a2a3a', border: '#a0c8e8', gradient: 'linear-gradient(135deg,#d0e8f8,#e8f4fb)' },
    cyberneon:     { name: 'Cyber Neon',    bg: '#020b14', card: '#051a28', accent: '#00ffcc', text: '#ccffee', border: '#003328', gradient: 'linear-gradient(135deg,#010609,#031020)' },
    royalgold:     { name: 'Royal Gold',    bg: '#1a1200', card: '#2a1e00', accent: '#ffd700', text: '#f8e8b0', border: '#3a2a00', gradient: 'linear-gradient(135deg,#0f0b00,#201800)' },
    purplegalaxy:  { name: 'Purple Galaxy', bg: '#0a0515', card: '#150a25', accent: '#c77dff', text: '#e0ccff', border: '#2a1050', gradient: 'linear-gradient(135deg,#050009,#100518)' },
    darkmode:      { name: 'Dark Mode',     bg: '#121212', card: '#1e1e1e', accent: '#bb86fc', text: '#e0e0e0', border: '#2e2e2e', gradient: 'linear-gradient(135deg,#0a0a0a,#1a1a1a)' },
    lightmode:     { name: 'Light Mode',    bg: '#f5f5f5', card: '#ffffff', accent: '#1976d2', text: '#1a1a1a', border: '#d0d0d0', gradient: 'linear-gradient(135deg,#e8e8e8,#f8f8f8)' },
  };

  // ── Default Theme State ───────────────────────────────────────
  const DEFAULT_THEME = {
    // Background
    bgType: 'gradient',      // solid | gradient | image | animated-gradient | animated-image | video
    bgColor: '#0B1F3A',
    bgGradient: 'linear-gradient(135deg,#071428,#0B1F3A)',
    bgImageUrl: '',
    bgVideoUrl: '',
    bgBlur: 0,
    bgBrightness: 100,
    bgOpacity: 100,
    // Fonts
    fontFamily: '-apple-system, "Segoe UI", system-ui, sans-serif',
    fontSize: 14,
    fontWeight: '400',
    fontColor: '#ffffff',
    letterSpacing: 0,
    lineSpacing: 1.6,
    fontBold: false,
    fontItalic: false,
    fontUnderline: false,
    // Colors
    colorBg: '#0B1F3A',
    colorCard: '#0d2444',
    colorBorder: '#1a3a5c',
    colorHeader: '#071428',
    colorFooter: '#071428',
    colorAccent: '#00AEEF',
    colorGlow: 'rgba(0,174,239,0.3)',
    colorLink: '#00AEEF',
    colorText: '#ffffff',
    colorButton: '#00AEEF',
    colorIcon: '#00AEEF',
    colorNav: '#0d2444',
    colorMenu: '#0d2444',
    // Buttons
    btnStyle: 'rounded',
    btnHover: 'none',
    btnAnimation: 'none',
    // Cards
    cardStyle: 'rounded',
    cardEffect: 'none',
    cardSpacing: 12,
    // Animations
    animFloating: false,
    animPulseGlow: false,
    animBorders: false,
    animGradient: false,
    animRain: false,
    animSnow: false,
    animLightning: false,
    animFire: false,
    animSparkle: false,
    animParticles: false,
    // Meta
    enabled: true,
    effects: true,
  };

  // ── State ─────────────────────────────────────────────────────
  let state = {
    profileUid: null,
    isSelf: false,
    theme: { ...DEFAULT_THEME },
    savedThemes: [],
    activeThemeId: null,
    activePanel: 'builtin',
  };

  let _canvas = null;
  let _animFrame = null;

  // ── Firebase helpers ──────────────────────────────────────────
  function fs() { return window._snxFirestore; }
  function db() { return window._snxDb; }

  async function loadThemeData(uid) {
    const { doc, getDoc } = fs();
    const snap = await getDoc(doc(db(), 'users', uid));
    if (snap.exists()) {
      const data = snap.data();
      return {
        theme: data.profileTheme || {},
        savedThemes: data.profileSavedThemes || [],
        activeThemeId: data.profileActiveThemeId || null,
      };
    }
    return { theme: {}, savedThemes: [], activeThemeId: null };
  }

  async function saveThemeData() {
    // Security: only the profile owner can save theme changes
    const currentUser = window._snxCurrentUser;
    if (!state.isSelf || !currentUser || currentUser.uid !== state.profileUid) return;
    const { doc, updateDoc } = fs();
    await updateDoc(doc(db(), 'users', state.profileUid), {
      profileTheme: state.theme,
      profileSavedThemes: state.savedThemes,
      profileActiveThemeId: state.activeThemeId,
    }).catch(() => {});
  }

  // ── Helpers ───────────────────────────────────────────────────
  function esc(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function toast(msg) {
    if (typeof window.snxToast === 'function') { window.snxToast(msg); return; }
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;bottom:70px;left:50%;transform:translateX(-50%);background:#0d2444;border:1px solid rgba(0,174,239,0.4);color:#fff;font-size:13px;padding:10px 18px;border-radius:30px;z-index:99999;pointer-events:none;';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }

  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // ── Apply Theme to Profile ────────────────────────────────────
  function applyThemeToProfile(uid, t) {
    const profileEl = document.getElementById('profile');
    if (!profileEl) return;

    // Check if this is the active profile
    if (window.activeProfileUid !== uid) return;

    // Remove previous canvas / animation classes
    stopEffects();

    if (!t.enabled) { profileEl.removeAttribute('style'); return; }

    // Background
    let bg = '';
    if (t.bgType === 'solid') bg = t.bgColor || t.colorBg;
    else if (t.bgType === 'gradient' || t.bgType === 'animated-gradient') bg = t.bgGradient || DEFAULT_THEME.bgGradient;
    else if ((t.bgType === 'image' || t.bgType === 'animated-image') && t.bgImageUrl) bg = `url(${t.bgImageUrl}) center/cover no-repeat`;
    else bg = t.bgGradient || DEFAULT_THEME.bgGradient;

    const filter = [];
    if (t.bgBlur > 0) filter.push(`blur(${t.bgBlur}px)`);
    if (t.bgBrightness !== 100) filter.push(`brightness(${t.bgBrightness}%)`);

    // Apply CSS variables and styles
    const root = profileEl;
    const cs = root.style;
    cs.setProperty('--profile-bg', bg);
    cs.setProperty('--profile-card', t.colorCard || DEFAULT_THEME.colorCard);
    cs.setProperty('--profile-border', t.colorBorder || DEFAULT_THEME.colorBorder);
    cs.setProperty('--profile-accent', t.colorAccent || DEFAULT_THEME.colorAccent);
    cs.setProperty('--profile-text', t.colorText || DEFAULT_THEME.colorText);
    cs.setProperty('--profile-link', t.colorLink || DEFAULT_THEME.colorLink);
    cs.setProperty('--profile-glow', t.colorGlow || DEFAULT_THEME.colorGlow);

    root.style.background = bg;
    if (filter.length) root.style.filter = filter.join(' ');
    if (t.bgOpacity !== 100) root.style.opacity = (t.bgOpacity / 100).toString();

    // Font
    if (t.fontFamily) { root.style.fontFamily = t.fontFamily; }
    if (t.fontSize)   { root.style.fontSize = t.fontSize + 'px'; }
    if (t.fontColor)  { root.style.color = t.fontColor; }

    // Cards
    document.querySelectorAll('#profile .section-card').forEach(el => {
      el.style.background = t.colorCard || '';
      el.style.borderColor = t.colorBorder || '';
      if (t.cardEffect === 'glass') {
        el.style.background = 'rgba(13,36,68,0.5)';
        el.style.backdropFilter = 'blur(12px)';
      } else if (t.cardEffect === 'neon') {
        el.style.boxShadow = `0 0 12px ${t.colorAccent || '#00AEEF'}`;
      } else if (t.cardEffect === 'shadow') {
        el.style.boxShadow = '0 4px 24px rgba(0,0,0,0.5)';
      }
    });

    // Animations
    const banner = document.getElementById('profileBanner') || root;
    if (t.animPulseGlow) banner.classList.add('snx-anim-pulse-glow');
    if (t.animFloating) root.classList.add('snx-anim-floating');
    if (t.animBorders) document.querySelectorAll('#profile .section-card').forEach(el => el.classList.add('snx-anim-neon-border'));
    if (t.animGradient) {
      root.style.backgroundSize = '200% 200%';
      root.classList.add('snx-anim-moving-grad');
    }

    // Canvas effects
    if (t.effects && (t.animRain || t.animSnow || t.animLightning || t.animFire || t.animSparkle || t.animParticles)) {
      startCanvasEffect(root, t);
    }

    // Video background
    if (t.bgType === 'video' && t.bgVideoUrl) applyVideoBackground(root, t.bgVideoUrl);
  }

  function applyVideoBackground(container, url) {
    let vid = container.querySelector('.snx-profile-bg-video');
    if (!vid) {
      vid = document.createElement('video');
      vid.className = 'snx-profile-bg-video';
      vid.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:0;pointer-events:none;';
      vid.autoplay = true;
      vid.loop = true;
      vid.muted = true;
      vid.playsInline = true;
      container.style.position = 'relative';
      container.insertBefore(vid, container.firstChild);
    }
    vid.src = url;
    vid.play().catch(() => {});
  }

  function stopEffects() {
    const profile = document.getElementById('profile');
    if (!profile) return;
    profile.classList.remove('snx-anim-floating','snx-anim-pulse-glow','snx-anim-moving-grad');
    document.querySelectorAll('#profile .section-card').forEach(el => el.classList.remove('snx-anim-neon-border','snx-anim-pulse-glow'));
    if (_canvas) { _canvas.remove(); _canvas = null; }
    if (_animFrame) { cancelAnimationFrame(_animFrame); _animFrame = null; }
    const vid = profile.querySelector('.snx-profile-bg-video');
    if (vid) vid.remove();
  }

  // ── Canvas Particle Effects ────────────────────────────────────
  function startCanvasEffect(container, t) {
    _canvas = document.createElement('canvas');
    _canvas.className = 'snx-profile-canvas';
    container.style.position = 'relative';
    container.style.overflow = 'hidden';
    container.insertBefore(_canvas, container.firstChild);

    const ctx = _canvas.getContext('2d');
    const particles = [];

    function resize() {
      _canvas.width  = container.offsetWidth;
      _canvas.height = container.offsetHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    // Seed particles
    function spawn() {
      const type = t.animRain ? 'rain' : t.animSnow ? 'snow' : t.animLightning ? 'lightning' : t.animFire ? 'fire' : t.animSparkle ? 'sparkle' : 'particle';
      const count = type === 'lightning' ? 1 : type === 'rain' ? 5 : 3;
      for (let i = 0; i < count; i++) {
        particles.push(makeParticle(type, _canvas.width, _canvas.height));
      }
    }

    function makeParticle(type, w, h) {
      if (type === 'rain') return { type, x: Math.random()*w, y: -10, vx: 0.5, vy: 10+Math.random()*5, len: 12+Math.random()*8, alpha: 0.4+Math.random()*0.4 };
      if (type === 'snow') return { type, x: Math.random()*w, y: -5, vx: (Math.random()-0.5)*1.5, vy: 1+Math.random()*2, r: 2+Math.random()*3, alpha: 0.6+Math.random()*0.4 };
      if (type === 'lightning') return { type, x: Math.random()*w, y: 0, life: 8+Math.random()*8, maxLife: 8+Math.random()*8 };
      if (type === 'fire') return { type, x: Math.random()*w, y: h+5, vx: (Math.random()-0.5)*2, vy: -(2+Math.random()*3), r: 4+Math.random()*6, life: 30+Math.random()*20, maxLife: 50 };
      if (type === 'sparkle') return { type, x: Math.random()*w, y: Math.random()*h, r: 1+Math.random()*2, alpha: 0, phase: Math.random()*Math.PI*2, speed: 0.05+Math.random()*0.05 };
      // generic particle
      return { type, x: Math.random()*w, y: Math.random()*h, vx: (Math.random()-0.5)*1.5, vy: (Math.random()-0.5)*1.5, r: 1+Math.random()*2, alpha: 0.3+Math.random()*0.5, color: t.colorAccent || '#00AEEF' };
    }

    function draw() {
      if (!_canvas) return;
      ctx.clearRect(0, 0, _canvas.width, _canvas.height);
      spawn();
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        let dead = false;
        ctx.save();
        if (p.type === 'rain') {
          p.x += p.vx; p.y += p.vy;
          if (p.y > _canvas.height + 20) dead = true;
          ctx.strokeStyle = `rgba(170,220,255,${p.alpha})`;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * p.len/p.vy, p.y - p.len); ctx.stroke();
        } else if (p.type === 'snow') {
          p.x += p.vx; p.y += p.vy;
          if (p.y > _canvas.height + 10) dead = true;
          ctx.fillStyle = `rgba(255,255,255,${p.alpha})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2); ctx.fill();
        } else if (p.type === 'lightning') {
          p.life--;
          if (p.life <= 0) { dead = true; }
          else {
            const lx = [p.x], ly = [0];
            for (let s = 0; s < 6; s++) { lx.push(lx[s] + (Math.random()-0.5)*50); ly.push(ly[s] + _canvas.height/6); }
            ctx.strokeStyle = `rgba(220,220,255,${p.life/p.maxLife})`;
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(lx[0], ly[0]);
            for (let s = 1; s < lx.length; s++) ctx.lineTo(lx[s], ly[s]);
            ctx.stroke();
          }
        } else if (p.type === 'fire') {
          p.x += p.vx; p.y += p.vy; p.r *= 0.96; p.life--;
          if (p.life <= 0 || p.r < 0.5) dead = true;
          const fl = p.life / p.maxLife;
          ctx.fillStyle = `rgba(${Math.floor(255)},${Math.floor(fl*150)},0,${fl*0.8})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2); ctx.fill();
        } else if (p.type === 'sparkle') {
          p.phase += p.speed;
          p.alpha = (Math.sin(p.phase) + 1) / 2 * 0.8;
          ctx.fillStyle = `rgba(255,255,200,${p.alpha})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2); ctx.fill();
        } else {
          p.x += p.vx; p.y += p.vy;
          if (p.x < 0 || p.x > _canvas.width || p.y < 0 || p.y > _canvas.height) dead = true;
          ctx.fillStyle = p.color || '#00AEEF';
          ctx.globalAlpha = p.alpha;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2); ctx.fill();
        }
        ctx.restore();
        if (dead) particles.splice(i, 1);
      }
      // Limit particles
      while (particles.length > 200) particles.shift();
      _animFrame = requestAnimationFrame(draw);
    }
    draw();
  }

  // ── Render Theme Tab ──────────────────────────────────────────
  function renderThemeTab() {
    const container = document.getElementById('tabContentThemes');
    if (!container) return;
    const t = state.theme;
    const isOwner = state.isSelf;

    container.innerHTML = `
      ${!isOwner ? '<div class="snx-theme-owner-note">👁 View-only — only the profile owner can edit themes.</div>' : ''}
      <div class="snx-theme-editor${!isOwner ? ' snx-theme-readonly' : ''}">
        ${renderSidebar()}
        <div class="snx-theme-main" id="snxThemeMain">
          ${renderAllPanels(t)}
          ${isOwner ? renderToolbar() : ''}
        </div>
      </div>`;

    attachThemeEvents();
    showPanel(state.activePanel);
  }

  function renderSidebar() {
    const items = [
      { id: 'builtin',    icon: '🎨', label: 'Built-in Themes' },
      { id: 'background', icon: '🖼',  label: 'Background'      },
      { id: 'fonts',      icon: '🔤', label: 'Fonts'            },
      { id: 'colors',     icon: '🎨', label: 'Colors'           },
      { id: 'buttons',    icon: '🔲', label: 'Buttons'          },
      { id: 'cards',      icon: '📋', label: 'Cards'            },
      { id: 'animations', icon: '✨', label: 'Animations'       },
      { id: 'manager',    icon: '💾', label: 'Theme Manager'    },
    ];
    return `<div class="snx-theme-sidebar">${items.map(it =>
      `<button class="snx-theme-nav-btn${it.id === state.activePanel ? ' active' : ''}" data-panel="${it.id}">${it.icon} ${it.label}</button>`
    ).join('')}</div>`;
  }

  function renderAllPanels(t) {
    return [
      renderBuiltinPanel(),
      renderBackgroundPanel(t),
      renderFontsPanel(t),
      renderColorsPanel(t),
      renderButtonsPanel(t),
      renderCardsPanel(t),
      renderAnimationsPanel(t),
      renderManagerPanel(),
    ].join('');
  }

  function renderToolbar() {
    return `
      <div class="snx-theme-toolbar">
        <button class="snx-theme-btn" id="snxThemeResetBtn">↺ Reset</button>
        <button class="snx-theme-btn" id="snxThemePreviewBtn">👁 Preview</button>
        <button class="snx-theme-btn primary" id="snxThemeApplyBtn">✓ Apply & Save</button>
      </div>`;
  }

  // ── Panel Renderers ───────────────────────────────────────────
  function renderBuiltinPanel() {
    let cards = '';
    for (const [key, bt] of Object.entries(BUILTIN_THEMES)) {
      const isActive = state.activeThemeId === `builtin_${key}`;
      cards += `
        <div class="snx-builtin-card${isActive ? ' active' : ''}" data-builtin="${key}">
          <div class="snx-builtin-preview" style="background:${bt.gradient};border-bottom:2px solid ${bt.accent};"></div>
          <div class="snx-builtin-name">${bt.name}</div>
        </div>`;
    }
    return `<div class="snx-theme-panel" id="snxPanel-builtin">
      <div class="snx-theme-panel-title">🎨 Built-in Themes</div>
      <div class="snx-builtin-grid">${cards}</div>
    </div>`;
  }

  function renderBackgroundPanel(t) {
    return `<div class="snx-theme-panel" id="snxPanel-background">
      <div class="snx-theme-panel-title">🖼 Background</div>
      <div class="snx-theme-field-group">
        <div class="snx-theme-field-group-title">Type</div>
        <div class="snx-theme-row full"><div class="snx-theme-field">
          <label>Background Type</label>
          <select data-key="bgType">
            ${['solid','gradient','image','animated-gradient','animated-image','video'].map(v => `<option value="${v}"${t.bgType===v?' selected':''}>${v}</option>`).join('')}
          </select>
        </div></div>
        <div class="snx-theme-row">
          <div class="snx-theme-field"><label>Solid Color</label><input type="color" data-key="bgColor" value="${t.bgColor}"></div>
          <div class="snx-theme-field"><label>Gradient CSS</label><input type="text" data-key="bgGradient" value="${esc(t.bgGradient)}" placeholder="linear-gradient(...)"></div>
        </div>
        <div class="snx-theme-row full">
          <div class="snx-theme-field"><label>Image URL</label><input type="text" data-key="bgImageUrl" value="${esc(t.bgImageUrl)}" placeholder="https://..."></div>
        </div>
        <div class="snx-theme-row full">
          <div class="snx-theme-field"><label>Video URL (mp4)</label><input type="text" data-key="bgVideoUrl" value="${esc(t.bgVideoUrl)}" placeholder="https://...video.mp4"></div>
        </div>
      </div>
      <div class="snx-theme-field-group">
        <div class="snx-theme-field-group-title">Adjustments</div>
        <div class="snx-theme-row tri">
          <div class="snx-theme-field"><label>Blur <span class="snx-range-value">${t.bgBlur}px</span></label><input type="range" data-key="bgBlur" min="0" max="20" value="${t.bgBlur}"></div>
          <div class="snx-theme-field"><label>Brightness <span class="snx-range-value">${t.bgBrightness}%</span></label><input type="range" data-key="bgBrightness" min="20" max="200" value="${t.bgBrightness}"></div>
          <div class="snx-theme-field"><label>Opacity <span class="snx-range-value">${t.bgOpacity}%</span></label><input type="range" data-key="bgOpacity" min="20" max="100" value="${t.bgOpacity}"></div>
        </div>
      </div>
    </div>`;
  }

  function renderFontsPanel(t) {
    const fonts = ['-apple-system, "Segoe UI", system-ui, sans-serif','Georgia, serif','"Courier New", monospace','"Arial", sans-serif','"Verdana", sans-serif','"Trebuchet MS", sans-serif','Impact, sans-serif'];
    const weights = ['100','200','300','400','500','600','700','800','900'];
    return `<div class="snx-theme-panel" id="snxPanel-fonts">
      <div class="snx-theme-panel-title">🔤 Fonts</div>
      <div class="snx-theme-row full">
        <div class="snx-theme-field"><label>Font Family</label>
          <select data-key="fontFamily">${fonts.map(f=>`<option value="${f}"${t.fontFamily===f?' selected':''}>${f.split(',')[0]}</option>`).join('')}</select>
        </div>
      </div>
      <div class="snx-theme-row tri">
        <div class="snx-theme-field"><label>Size (px)</label><input type="number" data-key="fontSize" value="${t.fontSize}" min="10" max="24"></div>
        <div class="snx-theme-field"><label>Weight</label><select data-key="fontWeight">${weights.map(w=>`<option value="${w}"${t.fontWeight===w?' selected':''}>${w}</option>`).join('')}</select></div>
        <div class="snx-theme-field"><label>Color</label><input type="color" data-key="fontColor" value="${t.fontColor}"></div>
      </div>
      <div class="snx-theme-row">
        <div class="snx-theme-field"><label>Letter Spacing (px)</label><input type="number" data-key="letterSpacing" value="${t.letterSpacing}" min="-2" max="10"></div>
        <div class="snx-theme-field"><label>Line Height</label><input type="number" data-key="lineSpacing" value="${t.lineSpacing}" min="1" max="3" step="0.1"></div>
      </div>
      <div class="snx-theme-row tri">
        <div class="snx-theme-field"><label><input type="checkbox" data-key="fontBold" ${t.fontBold?'checked':''}> Bold</label></div>
        <div class="snx-theme-field"><label><input type="checkbox" data-key="fontItalic" ${t.fontItalic?'checked':''}> Italic</label></div>
        <div class="snx-theme-field"><label><input type="checkbox" data-key="fontUnderline" ${t.fontUnderline?'checked':''}> Underline</label></div>
      </div>
    </div>`;
  }

  function renderColorsPanel(t) {
    const colorFields = [
      ['colorBg','Background'],['colorCard','Card'],['colorBorder','Border'],['colorHeader','Header'],
      ['colorFooter','Footer'],['colorAccent','Accent'],['colorLink','Link'],['colorText','Text'],
      ['colorButton','Button'],['colorIcon','Icon'],['colorNav','Navigation'],['colorMenu','Menu'],
    ];
    return `<div class="snx-theme-panel" id="snxPanel-colors">
      <div class="snx-theme-panel-title">🎨 Colors</div>
      <div class="snx-color-grid">
        ${colorFields.map(([key,label])=>`<div class="snx-color-field"><label>${label}</label><input type="color" data-key="${key}" value="${t[key] || '#0B1F3A'}"></div>`).join('')}
      </div>
      <div class="snx-theme-row" style="margin-top:14px">
        <div class="snx-theme-field"><label>Glow Color (CSS)</label><input type="text" data-key="colorGlow" value="${esc(t.colorGlow)}" placeholder="rgba(0,174,239,0.3)"></div>
      </div>
    </div>`;
  }

  function renderButtonsPanel(t) {
    const styles = [
      { id: 'rounded', preview: 'rounded', label: 'Rounded' },
      { id: 'square',  preview: 'square',  label: 'Square'  },
      { id: 'outline', preview: 'outline', label: 'Outline' },
      { id: 'glow',    preview: 'glow',    label: 'Glow'    },
      { id: 'filled',  preview: '',        label: 'Filled'  },
    ];
    const hovers = ['none','scale','glow','shake','bounce'];
    const anims  = ['none','pulse','spin','slide'];
    return `<div class="snx-theme-panel" id="snxPanel-buttons">
      <div class="snx-theme-panel-title">🔲 Buttons</div>
      <div class="snx-theme-field-group-title">Style</div>
      <div class="snx-style-grid">${styles.map(s=>`
        <div class="snx-style-option${t.btnStyle===s.id?' selected':''}" data-btn-style="${s.id}">
          <div class="snx-style-option-preview"><button class="snx-btn-preview ${s.preview}">Button</button></div>
          <span class="snx-style-option-label">${s.label}</span>
        </div>`).join('')}</div>
      <div class="snx-theme-row" style="margin-top:14px">
        <div class="snx-theme-field"><label>Hover Effect</label><select data-key="btnHover">${hovers.map(h=>`<option value="${h}"${t.btnHover===h?' selected':''}>${h}</option>`).join('')}</select></div>
        <div class="snx-theme-field"><label>Animation</label><select data-key="btnAnimation">${anims.map(a=>`<option value="${a}"${t.btnAnimation===a?' selected':''}>${a}</option>`).join('')}</select></div>
      </div>
    </div>`;
  }

  function renderCardsPanel(t) {
    const styles = [
      { id: 'rounded',   label: 'Rounded' },
      { id: 'sharp',     label: 'Sharp'   },
      { id: 'glass',     label: 'Glass'   },
      { id: 'shadow',    label: 'Shadow'  },
      { id: 'neon',      label: 'Neon'    },
      { id: 'animated',  label: 'Animated'},
      { id: 'transparent', label: 'Transparent'},
    ];
    return `<div class="snx-theme-panel" id="snxPanel-cards">
      <div class="snx-theme-panel-title">📋 Cards</div>
      <div class="snx-theme-field-group-title">Style</div>
      <div class="snx-style-grid">${styles.map(s=>`
        <div class="snx-style-option${t.cardStyle===s.id?' selected':''}" data-card-style="${s.id}">
          <div class="snx-style-option-preview" style="font-size:20px;">${s.id==='glass'?'🔮':s.id==='neon'?'💡':s.id==='shadow'?'🌑':s.id==='transparent'?'👻':'📋'}</div>
          <span class="snx-style-option-label">${s.label}</span>
        </div>`).join('')}</div>
      <div class="snx-theme-field-group-title" style="margin-top:14px">Effect</div>
      <div class="snx-style-grid">
        ${['none','glass','shadow','neon'].map(e=>`<div class="snx-style-option${t.cardEffect===e?' selected':''}" data-card-effect="${e}">
          <div class="snx-style-option-preview" style="font-size:18px;">${e==='glass'?'🔮':e==='shadow'?'🌑':e==='neon'?'💡':'○'}</div>
          <span class="snx-style-option-label">${e}</span>
        </div>`).join('')}
      </div>
      <div class="snx-theme-row" style="margin-top:14px">
        <div class="snx-theme-field"><label>Card Spacing (px)</label><input type="number" data-key="cardSpacing" value="${t.cardSpacing}" min="4" max="40"></div>
      </div>
    </div>`;
  }

  function renderAnimationsPanel(t) {
    const anims = [
      { key: 'animFloating',  icon: '🌊', label: 'Floating'          },
      { key: 'animPulseGlow', icon: '💫', label: 'Pulse Glow'        },
      { key: 'animBorders',   icon: '🔳', label: 'Animated Borders'  },
      { key: 'animGradient',  icon: '🌈', label: 'Moving Gradient'   },
      { key: 'animRain',      icon: '🌧', label: 'Rain Effect'       },
      { key: 'animSnow',      icon: '❄',  label: 'Snow Effect'       },
      { key: 'animLightning', icon: '⚡', label: 'Lightning Effect'  },
      { key: 'animFire',      icon: '🔥', label: 'Fire Effect'       },
      { key: 'animSparkle',   icon: '✨', label: 'Sparkle Effect'    },
      { key: 'animParticles', icon: '🌟', label: 'Float Particles'   },
    ];
    return `<div class="snx-theme-panel" id="snxPanel-animations">
      <div class="snx-theme-panel-title">✨ Animations</div>
      <div class="snx-anim-grid">
        ${anims.map(a=>`
          <div class="snx-anim-toggle${t[a.key]?' on':''}" data-anim="${a.key}">
            <span class="snx-anim-icon">${a.icon}</span>
            <span class="snx-anim-label">${a.label}</span>
          </div>`).join('')}
      </div>
    </div>`;
  }

  function renderManagerPanel() {
    const isOwner = state.isSelf;
    const themes = state.savedThemes;
    let list = '';
    themes.forEach(th => {
      list += `
        <div class="snx-saved-theme-item${state.activeThemeId === th.id ? ' active' : ''}" data-saved-id="${th.id}">
          <div class="snx-saved-theme-swatch" style="background:${th.theme?.colorCard || '#0d2444'};border-color:${th.theme?.colorAccent || '#00AEEF'};"></div>
          <span class="snx-saved-theme-name">${esc(th.name)}</span>
          ${isOwner ? `<div class="snx-saved-theme-actions">
            <button class="snx-saved-theme-btn" data-action="load" data-id="${th.id}" title="Load">↺</button>
            <button class="snx-saved-theme-btn" data-action="rename" data-id="${th.id}" title="Rename">✏</button>
            <button class="snx-saved-theme-btn" data-action="dup" data-id="${th.id}" title="Duplicate">⧉</button>
            <button class="snx-saved-theme-btn danger" data-action="del" data-id="${th.id}" title="Delete">🗑</button>
          </div>` : ''}
        </div>`;
    });
    const ownerControls = isOwner ? `
      <div class="snx-theme-save-row">
        <input class="snx-theme-save-input" id="snxThemeSaveName" placeholder="Theme name…">
        <button class="snx-theme-save-btn" id="snxThemeSaveBtn">💾 Save Current</button>
      </div>` : '';
    const ioControls = isOwner ? `
      <div class="snx-theme-import-export">
        <button class="snx-theme-io-btn" id="snxThemeExportBtn">⬆ Export Theme</button>
        <label class="snx-theme-io-btn" style="cursor:pointer;">⬇ Import Theme<input type="file" id="snxThemeImportFile" accept=".json" style="display:none"></label>
      </div>` : '';
    return `<div class="snx-theme-panel" id="snxPanel-manager">
      <div class="snx-theme-panel-title">💾 Theme Manager</div>
      ${ownerControls}
      <div class="snx-saved-theme-list">${list || '<div class="snx-music-empty" style="padding:16px;">No saved themes yet.</div>'}</div>
      ${ioControls}
    </div>`;
  }

  // ── Show Panel ────────────────────────────────────────────────
  function showPanel(id) {
    state.activePanel = id;
    document.querySelectorAll('.snx-theme-panel').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.snx-theme-nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.panel === id));
    const panel = document.getElementById(`snxPanel-${id}`);
    if (panel) panel.classList.add('active');
  }

  // ── Event Wiring ──────────────────────────────────────────────
  function attachThemeEvents() {
    // Sidebar nav — always available (read-only navigation is fine for visitors)
    document.querySelectorAll('.snx-theme-nav-btn[data-panel]').forEach(btn => {
      btn.addEventListener('click', () => showPanel(btn.dataset.panel));
    });

    // ── All edit interactions below are owner-only ─────────────
    if (!state.isSelf) return;

    // Built-in theme selection
    document.querySelectorAll('.snx-builtin-card[data-builtin]').forEach(card => {
      card.addEventListener('click', () => {
        const key = card.dataset.builtin;
        const bt = BUILTIN_THEMES[key];
        if (!bt) return;
        state.theme = { ...state.theme, ...DEFAULT_THEME,
          bgType: 'gradient', bgGradient: bt.gradient,
          colorBg: bt.bg, colorCard: bt.card, colorAccent: bt.accent,
          colorText: bt.text, colorBorder: bt.border,
          colorLink: bt.accent, colorButton: bt.accent, colorGlow: `${bt.accent}55`,
        };
        state.activeThemeId = `builtin_${key}`;
        document.querySelectorAll('.snx-builtin-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        applyThemeToProfile(state.profileUid, state.theme);
      });
    });

    // Generic field change
    document.querySelectorAll('[data-key]').forEach(el => {
      const handler = () => {
        const key = el.dataset.key;
        const val = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? parseFloat(el.value) : el.value);
        state.theme[key] = val;
        if (el.type === 'range') {
          const label = el.closest('.snx-theme-field')?.querySelector('.snx-range-value');
          if (label) label.textContent = val + (key.includes('Blur') ? 'px' : '%');
        }
      };
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    });

    // Button styles
    document.querySelectorAll('[data-btn-style]').forEach(el => {
      el.addEventListener('click', () => {
        state.theme.btnStyle = el.dataset.btnStyle;
        document.querySelectorAll('[data-btn-style]').forEach(e => e.classList.toggle('selected', e.dataset.btnStyle === state.theme.btnStyle));
      });
    });

    // Card styles
    document.querySelectorAll('[data-card-style]').forEach(el => {
      el.addEventListener('click', () => {
        state.theme.cardStyle = el.dataset.cardStyle;
        document.querySelectorAll('[data-card-style]').forEach(e => e.classList.toggle('selected', e.dataset.cardStyle === state.theme.cardStyle));
      });
    });
    document.querySelectorAll('[data-card-effect]').forEach(el => {
      el.addEventListener('click', () => {
        state.theme.cardEffect = el.dataset.cardEffect;
        document.querySelectorAll('[data-card-effect]').forEach(e => e.classList.toggle('selected', e.dataset.cardEffect === state.theme.cardEffect));
      });
    });

    // Animation toggles
    document.querySelectorAll('.snx-anim-toggle[data-anim]').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.dataset.anim;
        state.theme[key] = !state.theme[key];
        el.classList.toggle('on', state.theme[key]);
      });
    });

    // Toolbar
    document.getElementById('snxThemeApplyBtn')?.addEventListener('click', async () => {
      applyThemeToProfile(state.profileUid, state.theme);
      await saveThemeData();
      toast('✓ Theme applied and saved!');
    });
    document.getElementById('snxThemePreviewBtn')?.addEventListener('click', () => {
      applyThemeToProfile(state.profileUid, state.theme);
      toast('Previewing theme…');
    });
    document.getElementById('snxThemeResetBtn')?.addEventListener('click', async () => {
      if (!confirm('Reset to default theme?')) return;
      state.theme = { ...DEFAULT_THEME };
      state.activeThemeId = null;
      applyThemeToProfile(state.profileUid, state.theme);
      await saveThemeData();
      renderThemeTab();
    });

    // Manager: save
    document.getElementById('snxThemeSaveBtn')?.addEventListener('click', async () => {
      const name = document.getElementById('snxThemeSaveName')?.value.trim();
      if (!name) { toast('Enter a theme name first.'); return; }
      const newTheme = { id: genId(), name, theme: { ...state.theme } };
      state.savedThemes.push(newTheme);
      state.activeThemeId = newTheme.id;
      await saveThemeData();
      toast(`Theme "${name}" saved!`);
      renderThemeTab();
      showPanel('manager');
    });

    // Manager actions (load, rename, dup, del)
    document.querySelectorAll('.snx-saved-theme-btn[data-action]').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const { action, id } = btn.dataset;
        const idx = state.savedThemes.findIndex(t => t.id === id);
        if (idx < 0) return;
        if (action === 'load') {
          state.theme = { ...DEFAULT_THEME, ...state.savedThemes[idx].theme };
          state.activeThemeId = id;
          applyThemeToProfile(state.profileUid, state.theme);
          await saveThemeData();
          renderThemeTab();
          showPanel('manager');
        } else if (action === 'rename') {
          const name = prompt('New name:', state.savedThemes[idx].name);
          if (!name || !name.trim()) return;
          state.savedThemes[idx].name = name.trim();
          await saveThemeData();
          renderThemeTab();
          showPanel('manager');
        } else if (action === 'dup') {
          const dup = { ...state.savedThemes[idx], id: genId(), name: state.savedThemes[idx].name + ' (copy)' };
          state.savedThemes.push(dup);
          await saveThemeData();
          renderThemeTab();
          showPanel('manager');
        } else if (action === 'del') {
          if (!confirm('Delete this theme?')) return;
          state.savedThemes.splice(idx, 1);
          if (state.activeThemeId === id) state.activeThemeId = null;
          await saveThemeData();
          renderThemeTab();
          showPanel('manager');
        }
      });
    });

    // Saved theme click to load (owner only — changes local state)
    document.querySelectorAll('.snx-saved-theme-item[data-saved-id]').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('.snx-saved-theme-btn')) return;
        const id = el.dataset.savedId;
        const found = state.savedThemes.find(t => t.id === id);
        if (!found) return;
        state.theme = { ...DEFAULT_THEME, ...found.theme };
        state.activeThemeId = id;
        applyThemeToProfile(state.profileUid, state.theme);
      });
    });

    // Export
    document.getElementById('snxThemeExportBtn')?.addEventListener('click', () => {
      const data = JSON.stringify({ theme: state.theme, savedThemes: state.savedThemes }, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'snx-theme.json';
      a.click(); URL.revokeObjectURL(url);
    });

    // Import
    document.getElementById('snxThemeImportFile')?.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async ev => {
        try {
          const data = JSON.parse(ev.target.result);
          if (data.theme) { state.theme = { ...DEFAULT_THEME, ...data.theme }; }
          if (Array.isArray(data.savedThemes)) {
            data.savedThemes.forEach(th => {
              if (!state.savedThemes.find(s => s.id === th.id)) state.savedThemes.push(th);
            });
          }
          applyThemeToProfile(state.profileUid, state.theme);
          await saveThemeData();
          toast('Theme imported!');
          renderThemeTab();
          showPanel('manager');
        } catch { toast('Invalid theme file.'); }
      };
      reader.readAsText(file);
    });
  }

  // ── Public API ────────────────────────────────────────────────
  async function initThemeTab(uid, isSelf) {
    state.profileUid = uid;
    state.isSelf = isSelf;

    // Hide the Theme tab button entirely for visitors — only the profile owner sees it
    const themeTabBtn = document.getElementById('tabThemesLink');
    if (themeTabBtn) themeTabBtn.style.display = isSelf ? '' : 'none';

    const saved = await loadThemeData(uid).catch(() => ({ theme: {}, savedThemes: [], activeThemeId: null }));
    state.theme = { ...DEFAULT_THEME, ...saved.theme };
    state.savedThemes = Array.isArray(saved.savedThemes) ? saved.savedThemes : [];
    state.activeThemeId = saved.activeThemeId || null;

    // Apply theme to the profile immediately (visible to everyone)
    applyThemeToProfile(uid, state.theme);

    // Only render the editable theme tab if this is the owner
    if (isSelf) renderThemeTab();
  }

  function cleanupThemeTab() {
    stopEffects();
  }

  window.snxTheme = { initThemeTab, cleanupThemeTab, applyThemeToProfile, state };
})();
