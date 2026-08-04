/**
 * shadow-nexus-features.js
 * Shadow Nexus Social — Top 5 Unique Systems
 *
 * 1. 🌑 Shadow Realms      — users/{uid}/shadowRealm
 * 2. 🐺 Shadow Companions  — users/{uid}/companion
 * 3. 🕯 Shadow Memory Vault— users/{uid}/memoryVault  (sub-collection: vaultItems)
 * 4. ⚔  Shadow Quest System— users/{uid}/quests       (sub-collection: questItems)
 * 5. 🎤 Creator Story Mode — users/{uid}/creatorStories (sub-collection: episodes)
 *
 * Progression System:
 *   /shadowXP/{uid}   — level, experience, title
 *   /badges/{uid}     — badge collection
 *
 * Depends on window._snxFirestore (db + helpers) and window._snxCurrentUser
 * exposed by the main index.html module block.
 */

'use strict';

/* ══════════════════════════════════════════════════════════
   HELPERS — Firestore + auth shortcuts
   ══════════════════════════════════════════════════════════ */
function _fs() { return window._snxFirestore || null; }
function _me() { return window._snxCurrentUser || null; }
function _toast(msg) { if (typeof toastNotification === 'function') toastNotification(msg); }

/**
 * cleanText — strips stray HTML attributes and random slug prefixes that
 * can appear in Firestore data (e.g. id="abc123" or a bare slug before the
 * real title/username).
 * @param {*} text
 * @returns {string}
 */
function cleanText(text) {
  if (!text) return '';
  let s = String(text);
  // 1. Remove any HTML-attribute fragments like  id="xyz"  or  id='xyz'
  s = s.replace(/\s*id="[^"]*"/gi, '');
  s = s.replace(/\s*id='[^']*'/gi, '');
  // 2. Remove any remaining HTML tag fragments  <tag ...>  or  </tag>
  s = s.replace(/<[^>]*>/g, '');
  // 3. Strip a leading token of 4-30 non-space chars that contains NO
  //    letters from a typical word (pure slug / random ID characters)
  //    followed by optional whitespace — only when text follows after it.
  s = s.replace(/^[a-zA-Z0-9_\-]{4,30}\s+(?=\S)/, '');
  return s.trim();
}

/* ══════════════════════════════════════════════════════════
   XP / PROGRESSION SYSTEM
   ══════════════════════════════════════════════════════════ */

const XP_TITLES = [
  { level:   1, title: 'New Shadow' },
  { level:  10, title: 'Shadow Walker' },
  { level:  25, title: 'Realm Creator' },
  { level:  50, title: 'Nexus Guardian' },
  { level: 100, title: 'Legendary Shadow' },
];

function _xpTitle(level) {
  let t = XP_TITLES[0].title;
  for (const row of XP_TITLES) { if (level >= row.level) t = row.title; }
  return t;
}
function _xpForLevel(level) { return level * 100; }   // XP needed to reach level+1
function _xpPercent(xp, level) {
  const base = _xpForLevel(level);
  return Math.min(100, Math.round((xp % base) / base * 100));
}

async function snxf_awardXP(amount, reason) {
  const user = _me(); const fs = _fs();
  if (!user || !fs) return;
  const { db, doc, getDoc, setDoc, increment, serverTimestamp } = fs;
  try {
    const ref = doc(db, 'shadowXP', user.uid);
    const snap = await getDoc(ref);
    const data = snap.exists() ? snap.data() : { level: 1, experience: 0 };
    const newXP = (data.experience || 0) + amount;
    let level   = data.level || 1;
    while (newXP >= _xpForLevel(level) * level) level++;  // simple level-up check
    level = Math.min(level, 100);
    await setDoc(ref, {
      uid: user.uid,
      experience: newXP,
      level,
      title: _xpTitle(level),
      lastUpdated: serverTimestamp(),
    }, { merge: true });
    _toast(`+${amount} Shadow XP — ${reason}`);
    return { newXP, level };
  } catch(e) { console.error('[SNX-XP] awardXP error:', e.message); }
}
window.snxf_awardXP = snxf_awardXP;

async function snxf_loadXPStrip(elementId) {
  const user = _me(); const fs = _fs();
  if (!user || !fs) return;
  const { db, doc, getDoc } = fs;
  const el = document.getElementById(elementId);
  if (!el) return;
  try {
    const snap = await getDoc(doc(db, 'shadowXP', user.uid));
    const d    = snap.exists() ? snap.data() : { level: 1, experience: 0 };
    const lvl  = d.level || 1;
    const xp   = d.experience || 0;
    const pct  = _xpPercent(xp, lvl);
    const name = cleanText(window._snxUserData?.displayName || user.email?.split('@')[0] || 'Shadow User');
    el.innerHTML = `
      <div class="snxf-xp-avatar">${window._snxUserData?.avatar || '🌑'}</div>
      <div class="snxf-xp-info">
        <div class="snxf-xp-name">${name}</div>
        <div class="snxf-xp-title-text">${cleanText(_xpTitle(lvl))}</div>
        <div class="snxf-xp-bar-wrap"><div class="snxf-xp-bar-fill" style="width:${pct}%"></div></div>
        <div class="snxf-xp-pct">${pct}% to next level · ${xp} total XP</div>
      </div>
      <div class="snxf-xp-level">Lv${lvl}<span>SHADOW</span></div>
    `;
  } catch(e) { console.error('[SNX-XP] loadXPStrip error:', e.message); }
}
window.snxf_loadXPStrip = snxf_loadXPStrip;

/* ══════════════════════════════════════════════════════════
   1. SHADOW REALMS
   ══════════════════════════════════════════════════════════ */

const REALM_THEMES = [
  { id: 'darkForest',      icon: '🌲', name: 'Dark Forest',     desc: 'Ancient, haunted woods' },
  { id: 'space',           icon: '🌌', name: 'Space',           desc: 'Infinite cosmic void' },
  { id: 'cyberCity',       icon: '🏙', name: 'Cyber City',      desc: 'Neon-lit future grid' },
  { id: 'hauntedMansion',  icon: '🏚', name: 'Haunted Mansion', desc: 'Shadows and secrets' },
  { id: 'fantasyKingdom',  icon: '🏰', name: 'Fantasy Kingdom', desc: 'Myth and legend' },
];

const REALM_CUSTOMISE = [
  { key: 'background', icon: '🖼', label: 'Background' },
  { key: 'music',      icon: '🎵', label: 'Music' },
  { key: 'lighting',   icon: '💡', label: 'Lighting' },
  { key: 'effects',    icon: '✨', label: 'Animated Effects' },
  { key: 'decorations',icon: '🪄', label: 'Decorations' },
  { key: 'featuredPosts',icon: '📌', label: 'Featured Content' },
  { key: 'memories',   icon: '💾', label: 'Favorite Memories' },
  { key: 'achievements',icon: '🏆', label: 'Achievements' },
];

async function snxf_loadRealmsPage() {
  const user = _me(); const fs = _fs();
  if (!user || !fs) { document.getElementById('shadowRealmsPage').innerHTML = '<p style="color:#5a8ab8;padding:20px">Please log in to access Shadow Realms.</p>'; return; }
  const { db, doc, getDoc } = fs;

  await snxf_loadXPStrip('realmsXPStrip');

  let realmData = {};
  try {
    const snap = await getDoc(doc(db, 'users', user.uid, 'shadowRealm', 'config'));
    if (snap.exists()) realmData = snap.data();
  } catch(e) { /* new user */ }

  const currentTheme = realmData.theme || '';
  const realmLevel   = realmData.realmLevel || 1;

  const themeCards = REALM_THEMES.map(t => `
    <div class="snxr-theme-card ${currentTheme === t.id ? 'active' : ''}"
         onclick="snxf_setRealmTheme('${t.id}')" data-realm-theme="${t.id}">
      <div class="snxr-theme-icon">${t.icon}</div>
      <div class="snxr-theme-name">${t.name}</div>
      <div class="snxr-theme-desc">${t.desc}</div>
    </div>
  `).join('');

  const custItems = REALM_CUSTOMISE.map(c => `
    <div class="snxr-cust-item" onclick="snxf_realmCustomise('${c.key}')">
      <span class="snxr-cust-icon">${c.icon}</span>
      <span class="snxr-cust-label">${c.label}</span>
    </div>
  `).join('');

  document.getElementById('realmsContent').innerHTML = `
    <div class="snxr-level-badge">🌑 Realm Level ${realmLevel} &nbsp; | &nbsp; ${REALM_THEMES.find(t=>t.id===currentTheme)?.icon||'🌑'} ${REALM_THEMES.find(t=>t.id===currentTheme)?.name||'No Theme Selected'}</div>

    <div class="snxf-section-title">Choose Your Realm Theme</div>
    <div class="snxr-theme-grid">${themeCards}</div>

    <div class="snxf-section-title">Customise Your Realm</div>
    <div class="snxr-customise-grid">${custItems}</div>
  `;
}
window.snxf_loadRealmsPage = snxf_loadRealmsPage;

async function snxf_setRealmTheme(themeId) {
  const user = _me(); const fs = _fs();
  if (!user || !fs) return;
  const { db, doc, setDoc, serverTimestamp } = fs;
  try {
    await setDoc(doc(db, 'users', user.uid, 'shadowRealm', 'config'), {
      theme: themeId, updatedAt: serverTimestamp()
    }, { merge: true });
    document.querySelectorAll('[data-realm-theme]').forEach(el => {
      el.classList.toggle('active', el.dataset.realmTheme === themeId);
    });
    const t = REALM_THEMES.find(t => t.id === themeId);
    _toast(`${t?.icon || '🌑'} Realm theme set to "${t?.name || themeId}"`);
    snxf_awardXP(10, 'Customised your Realm');
  } catch(e) { _toast('❌ Could not update realm theme: ' + e.message); }
}
window.snxf_setRealmTheme = snxf_setRealmTheme;

function snxf_realmCustomise(key) {
  const labels = { background:'Background', music:'Music', lighting:'Lighting',
    effects:'Animated Effects', decorations:'Decorations', featuredPosts:'Featured Content',
    memories:'Favorite Memories', achievements:'Achievements' };
  _toast(`🪄 ${labels[key] || key} customisation coming soon!`);
}
window.snxf_realmCustomise = snxf_realmCustomise;

/* ══════════════════════════════════════════════════════════
   2. SHADOW COMPANIONS
   ══════════════════════════════════════════════════════════ */

const COMPANIONS = [
  { id: 'wolf',    icon: '🐺', name: 'Shadow Wolf',  traits: ['Strength', 'Loyalty', 'Protection'] },
  { id: 'raven',   icon: '🐦', name: 'Shadow Raven', traits: ['Wisdom', 'Mystery', 'Knowledge'] },
  { id: 'cat',     icon: '🐈', name: 'Black Cat',    traits: ['Creativity', 'Independence', 'Luck'] },
  { id: 'phoenix', icon: '🔥', name: 'Phoenix',      traits: ['Rebirth', 'Growth', 'Transformation'] },
];

const COMPANION_ABILITIES = [
  { level: 1,  icon: '⚡', text: 'Basic companion bond',    unlockLevel: 1  },
  { level: 10, icon: '✨', text: 'Unlock companion animations', unlockLevel: 10 },
  { level: 25, icon: '🌟', text: 'Unlock special abilities',  unlockLevel: 25 },
  { level: 50, icon: '💫', text: 'Legendary Companion Form',  unlockLevel: 50 },
];

async function snxf_loadCompanionsPage() {
  const user = _me(); const fs = _fs();
  if (!user || !fs) return;
  const { db, doc, getDoc } = fs;

  await snxf_loadXPStrip('companionsXPStrip');

  let compData = null;
  try {
    const snap = await getDoc(doc(db, 'users', user.uid, 'companion', 'data'));
    if (snap.exists()) compData = snap.data();
  } catch(e) { /* new */ }

  const container = document.getElementById('companionsContent');
  if (!container) return;

  if (compData) {
    const comp = COMPANIONS.find(c => c.id === compData.type) || COMPANIONS[0];
    const lvl  = compData.level || 1;
    const xp   = compData.experience || 0;
    const pct  = Math.min(100, Math.round((xp % 100) / 100 * 100));

    const abilities = COMPANION_ABILITIES.map(a => {
      const locked = lvl < a.unlockLevel;
      return `
        <div class="snxc-ability-row ${locked ? 'snxc-ability-locked' : ''}">
          <span class="snxc-ability-icon">${a.icon}</span>
          <span class="snxc-ability-text">${a.text}</span>
          ${locked ? `<span class="snxc-ability-unlock">Unlocks at Lv${a.unlockLevel}</span>` : '<span class="snxc-ability-unlock" style="color:#39FF14">✓ Unlocked</span>'}
        </div>
      `;
    }).join('');

    const traits = comp.traits.map(t => `<span class="snxc-trait-pill">${t}</span>`).join('');

    container.innerHTML = `
      <div class="snxc-companion-display">
        <div class="snxc-companion-emoji">${comp.icon}</div>
        <div class="snxc-companion-name">${comp.name}</div>
        <div class="snxc-companion-type">Level ${lvl} Companion</div>
        <div class="snxc-companion-traits">${traits}</div>
        <div class="snxc-xp-bar-outer" style="width:80%;"><div class="snxc-xp-bar-inner" style="width:${pct}%"></div></div>
        <div class="snxc-xp-label">${xp} XP · ${pct}% to next level</div>
      </div>
      <div class="snxf-section-title">Companion Abilities</div>
      <div class="snxc-abilities-list">${abilities}</div>
    `;
  } else {
    const cards = COMPANIONS.map(c => `
      <div class="snxc-choose-card" onclick="snxf_chooseCompanion('${c.id}')">
        <div class="snxc-choose-icon">${c.icon}</div>
        <div class="snxc-choose-name">${c.name}</div>
      </div>
    `).join('');
    container.innerHTML = `
      <div class="snxc-choose-title">Choose your Shadow Companion to begin your journey:</div>
      <div class="snxc-choose-grid">${cards}</div>
    `;
  }
}
window.snxf_loadCompanionsPage = snxf_loadCompanionsPage;

async function snxf_chooseCompanion(compId) {
  const user = _me(); const fs = _fs();
  if (!user || !fs) return;
  const { db, doc, setDoc, serverTimestamp } = fs;
  const comp = COMPANIONS.find(c => c.id === compId);
  if (!comp) return;
  try {
    await setDoc(doc(db, 'users', user.uid, 'companion', 'data'), {
      type: compId,
      level: 1,
      experience: 0,
      abilities: [],
      animations: false,
      unlockedForms: [],
      createdAt: serverTimestamp(),
    });
    _toast(`${comp.icon} ${comp.name} is now your Shadow Companion!`);
    snxf_awardXP(25, 'Chose your Companion');
    snxf_loadCompanionsPage();
  } catch(e) { _toast('❌ Could not choose companion: ' + e.message); }
}
window.snxf_chooseCompanion = snxf_chooseCompanion;

/* ══════════════════════════════════════════════════════════
   3. SHADOW MEMORY VAULT
   ══════════════════════════════════════════════════════════ */

const VAULT_MODES   = ['private', 'friends', 'legacy'];
const VAULT_LABELS  = { private: '🔒 Private Vault', friends: '👥 Friend Vault', legacy: '🌍 Legacy Vault' };
const VAULT_DESCS   = {
  private: 'Only you can see this vault',
  friends: 'Approved friends can view',
  legacy:  'Your public life story',
};
const VAULT_CATEGORIES = ['Photo', 'Video', 'Music', 'Post', 'Voice', 'Achievement', 'Moment'];

let _vaultCurrentFilter = 'private';

async function snxf_loadVaultPage() {
  const user = _me(); const fs = _fs();
  if (!user || !fs) return;

  await snxf_loadXPStrip('vaultXPStrip');
  snxf_renderVaultFilter(_vaultCurrentFilter);
  await snxf_loadVaultItems(_vaultCurrentFilter);
}
window.snxf_loadVaultPage = snxf_loadVaultPage;

function snxf_renderVaultFilter(active) {
  const tabs = document.getElementById('vaultPrivacyTabs');
  if (!tabs) return;
  tabs.innerHTML = VAULT_MODES.map(m => `
    <div class="snxv-privacy-tab ${m === active ? 'active' : ''}" onclick="snxf_setVaultFilter('${m}')">
      ${VAULT_LABELS[m]}<br><span style="font-size:9px;font-weight:400;opacity:0.7">${VAULT_DESCS[m]}</span>
    </div>
  `).join('');
}

async function snxf_loadVaultItems(privacy) {
  const user = _me(); const fs = _fs();
  if (!user || !fs) return;
  const { db, collection, query, where, orderBy, limit, getDocs } = fs;
  const grid = document.getElementById('vaultGrid');
  if (!grid) return;
  grid.innerHTML = '<div style="color:#3a5a7a;font-size:12px;padding:14px 0;">Loading memories…</div>';
  try {
    let q;
    if (privacy === 'private') {
      q = query(collection(db, 'users', user.uid, 'memoryVault'), orderBy('dateCreated', 'desc'), limit(20));
    } else {
      q = query(collection(db, 'users', user.uid, 'memoryVault'),
        where('privacy', '==', privacy), orderBy('dateCreated', 'desc'), limit(20));
    }
    const snap = await getDocs(q);
    if (snap.empty) {
      grid.innerHTML = '<div style="color:#3a5a7a;font-size:12px;padding:14px 0;text-align:center;">No memories in this vault yet.<br>Create your first memory!</div>';
      return;
    }
    grid.innerHTML = snap.docs.map(d => {
      const m = d.data();
      const thumb = m.mediaURL ? `<img src="${m.mediaURL}" loading="lazy" onerror="this.style.display='none'">` : '💾';
      return `
        <div class="snxv-memory-card">
          <div class="snxv-memory-thumb">${thumb}</div>
          <div class="snxv-memory-body">
            <div class="snxv-memory-title">${cleanText(m.title) || 'Untitled Memory'}</div>
            <div class="snxv-memory-meta">${m.dateCreated ? new Date(m.dateCreated.seconds ? m.dateCreated.seconds*1000 : m.dateCreated).toLocaleDateString() : ''}</div>
            <span class="snxv-memory-cat">${m.category || 'Moment'}</span>
          </div>
        </div>
      `;
    }).join('');
  } catch(e) {
    grid.innerHTML = `<div style="color:#ff5577;font-size:12px;padding:14px 0;">Error loading vault: ${e.message}</div>`;
  }
}
window.snxf_loadVaultItems = snxf_loadVaultItems;

function snxf_setVaultFilter(privacy) {
  _vaultCurrentFilter = privacy;
  snxf_renderVaultFilter(privacy);
  snxf_loadVaultItems(privacy);
}
window.snxf_setVaultFilter = snxf_setVaultFilter;

function snxf_openAddMemory() {
  const user = _me(); const fs = _fs();
  if (!user || !fs) return;

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,3,12,0.92);display:flex;align-items:center;justify-content:center;z-index:8000;padding:16px;backdrop-filter:blur(8px)';
  modal.innerHTML = `
    <div style="background:rgba(7,20,42,0.98);border:1px solid rgba(0,174,239,0.4);border-radius:16px;padding:22px;width:100%;max-width:400px;max-height:90vh;overflow-y:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <strong style="color:#fff;font-size:16px;">💾 Add Memory</strong>
        <button onclick="this.closest('[style]').remove()" style="background:none;border:none;color:#5a8ab8;font-size:18px;cursor:pointer;">✕</button>
      </div>
      <input id="_vaultTitle" placeholder="Memory title…" style="width:100%;padding:10px;background:rgba(0,15,40,0.8);border:1px solid rgba(0,174,239,0.3);color:#fff;border-radius:8px;margin-bottom:8px;box-sizing:border-box;">
      <textarea id="_vaultDesc" placeholder="Describe this memory…" rows="3" style="width:100%;padding:10px;background:rgba(0,15,40,0.8);border:1px solid rgba(0,174,239,0.3);color:#fff;border-radius:8px;margin-bottom:8px;resize:vertical;box-sizing:border-box;"></textarea>
      <select id="_vaultCat" style="width:100%;padding:10px;background:rgba(0,15,40,0.8);border:1px solid rgba(0,174,239,0.3);color:#fff;border-radius:8px;margin-bottom:8px;">
        ${VAULT_CATEGORIES.map(c => `<option>${c}</option>`).join('')}
      </select>
      <select id="_vaultPrivacy" style="width:100%;padding:10px;background:rgba(0,15,40,0.8);border:1px solid rgba(0,174,239,0.3);color:#fff;border-radius:8px;margin-bottom:14px;">
        <option value="private">🔒 Private</option>
        <option value="friends">👥 Friends</option>
        <option value="legacy">🌍 Legacy (Public)</option>
      </select>
      <button onclick="snxf_saveMemory(this)" style="width:100%;padding:11px;background:linear-gradient(135deg,#0044aa,#0066ff);border:none;border-radius:10px;color:#fff;font-size:13px;font-weight:800;cursor:pointer;">💾 Save Memory</button>
    </div>
  `;
  document.body.appendChild(modal);
}
window.snxf_openAddMemory = snxf_openAddMemory;

async function snxf_saveMemory(btn) {
  const user = _me(); const fs = _fs();
  if (!user || !fs) return;
  const { db, collection, addDoc, serverTimestamp } = fs;
  const title    = document.getElementById('_vaultTitle')?.value.trim();
  const desc     = document.getElementById('_vaultDesc')?.value.trim();
  const category = document.getElementById('_vaultCat')?.value || 'Moment';
  const privacy  = document.getElementById('_vaultPrivacy')?.value || 'private';
  if (!title) { _toast('⚠️ Please enter a memory title.'); return; }
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await addDoc(collection(db, 'users', user.uid, 'memoryVault'), {
      title, description: desc, category, privacy,
      mediaURL: '', dateCreated: serverTimestamp(),
    });
    _toast('💾 Memory saved to your Vault!');
    snxf_awardXP(15, 'Added a Memory to your Vault');
    btn.closest('[style]').remove();
    snxf_loadVaultItems(_vaultCurrentFilter);
  } catch(e) {
    btn.disabled = false; btn.textContent = '💾 Save Memory';
    _toast('❌ Save failed: ' + e.message);
  }
}
window.snxf_saveMemory = snxf_saveMemory;

/* ══════════════════════════════════════════════════════════
   4. SHADOW QUEST SYSTEM
   ══════════════════════════════════════════════════════════ */

const DAILY_QUESTS = [
  { id: 'q_support',   icon: '🔥', name: 'Support Another User', desc: 'Like or comment on a friend\'s post',     type: 'daily',   reward: 20 },
  { id: 'q_post',      icon: '🔥', name: 'Create a Post',        desc: 'Share something with the community',      type: 'daily',   reward: 15 },
  { id: 'q_creative',  icon: '🔥', name: 'Share Creativity',     desc: 'Post art, music, or writing',             type: 'daily',   reward: 25 },
  { id: 'q_community', icon: '🔥', name: 'Join a Community',     desc: 'Participate in Storm Room or Support',    type: 'daily',   reward: 20 },
  { id: 'q_profile',   icon: '🔥', name: 'Complete Profile',     desc: 'Fill in your bio and choose a Realm',     type: 'daily',   reward: 30 },
  { id: 'q_help',      icon: '🔥', name: 'Help a New Member',    desc: 'Welcome or assist a new Shadow',          type: 'daily',   reward: 25 },
  { id: 'q_events',    icon: '🔥', name: 'Attend an Event',      desc: 'Join a live stream or community event',   type: 'weekly',  reward: 50 },
  { id: 'q_legendary', icon: '🔥', name: 'Legendary Quest',      desc: 'Reach Level 25 and unlock Realm Creator', type: 'legendary', reward: 200 },
];

let _questCurrentTab = 'daily';

async function snxf_loadQuestsPage() {
  const user = _me(); const fs = _fs();
  if (!user || !fs) return;

  await snxf_loadXPStrip('questsXPStrip');
  snxf_renderQuestTabs(_questCurrentTab);
  await snxf_renderQuestList(_questCurrentTab);
}
window.snxf_loadQuestsPage = snxf_loadQuestsPage;

function snxf_renderQuestTabs(active) {
  const tabs = document.getElementById('questTabRow');
  if (!tabs) return;
  const tabDefs = [
    { id: 'daily',     label: 'Daily' },
    { id: 'weekly',    label: 'Weekly' },
    { id: 'legendary', label: 'Legendary' },
  ];
  tabs.innerHTML = tabDefs.map(t =>
    `<div class="snxq-tab ${t.id === active ? 'active' : ''}" onclick="snxf_setQuestTab('${t.id}')">${t.label}</div>`
  ).join('');
}

function snxf_setQuestTab(tab) {
  _questCurrentTab = tab;
  snxf_renderQuestTabs(tab);
  snxf_renderQuestList(tab);
}
window.snxf_setQuestTab = snxf_setQuestTab;

async function snxf_renderQuestList(type) {
  const user = _me(); const fs = _fs();
  const list = document.getElementById('questList');
  if (!list || !user || !fs) return;

  list.innerHTML = '<div style="color:#3a5a7a;font-size:12px;padding:14px 0;">Loading quests…</div>';

  const { db, collection, getDocs } = fs;
  let completedIds = new Set();
  try {
    const snap = await getDocs(collection(db, 'users', user.uid, 'quests'));
    snap.forEach(d => { if (d.data().completed) completedIds.add(d.id); });
  } catch(e) { /* first load */ }

  const quests = DAILY_QUESTS.filter(q => q.type === type);
  if (!quests.length) { list.innerHTML = '<div style="color:#3a5a7a;font-size:12px;padding:14px 0;text-align:center;">No quests of this type yet.</div>'; return; }

  list.innerHTML = quests.map(q => {
    const done = completedIds.has(q.id);
    return `
      <div class="snxq-quest-card ${done ? 'completed' : ''}" id="qcard_${q.id}">
        <div class="snxq-quest-icon">${q.icon}</div>
        <div class="snxq-quest-body">
          <div class="snxq-quest-name">${q.name}</div>
          <div class="snxq-quest-desc">${q.desc}</div>
          <div class="snxq-quest-progress"><div class="snxq-quest-bar" style="width:${done ? 100 : 0}%"></div></div>
          <div class="snxq-quest-reward">Reward: <span class="snxq-quest-reward-val">+${q.reward} Shadow XP</span></div>
        </div>
        <div class="snxq-check-wrap">
          <div class="snxq-check" onclick="snxf_completeQuest('${q.id}', ${q.reward})">${done ? '✓' : ''}</div>
        </div>
      </div>
    `;
  }).join('');
}

async function snxf_completeQuest(questId, xpReward) {
  const user = _me(); const fs = _fs();
  if (!user || !fs) return;
  const { db, doc, setDoc, serverTimestamp } = fs;
  try {
    await setDoc(doc(db, 'users', user.uid, 'quests', questId), {
      questID: questId,
      progress: 100,
      completed: true,
      reward: xpReward,
      completedDate: serverTimestamp(),
    });
    const card = document.getElementById(`qcard_${questId}`);
    if (card) {
      card.classList.add('completed');
      const check = card.querySelector('.snxq-check');
      if (check) check.textContent = '✓';
      const bar = card.querySelector('.snxq-quest-bar');
      if (bar) bar.style.width = '100%';
    }
    snxf_awardXP(xpReward, 'Completed a Quest');
  } catch(e) { _toast('❌ Could not mark quest complete: ' + e.message); }
}
window.snxf_completeQuest = snxf_completeQuest;

/* ══════════════════════════════════════════════════════════
   5. CREATOR STORY MODE
   ══════════════════════════════════════════════════════════ */

const EPISODE_TEMPLATES = [
  { num: 1, template: 'THE BEGINNING' },
  { num: 2, template: 'THE STRUGGLE' },
  { num: 3, template: 'THE RISE' },
  { num: 4, template: 'THE LEGACY' },
];

async function snxf_loadCreatorStoriesPage() {
  const user = _me(); const fs = _fs();
  if (!user || !fs) return;

  await snxf_loadXPStrip('storiesXPStrip');
  await snxf_renderEpisodeList();
}
window.snxf_loadCreatorStoriesPage = snxf_loadCreatorStoriesPage;

async function snxf_renderEpisodeList(targetUid) {
  const user = _me(); const fs = _fs();
  const list = document.getElementById('episodeList');
  if (!list || !user || !fs) return;
  const { db, collection, query, orderBy, getDocs } = fs;

  const uid = targetUid || user.uid;
  list.innerHTML = '<div style="color:#3a5a7a;font-size:12px;padding:14px 0;">Loading episodes…</div>';
  try {
    const q    = query(collection(db, 'users', uid, 'creatorStories'), orderBy('episodeNumber', 'asc'));
    const snap = await getDocs(q);

    if (snap.empty) {
      list.innerHTML = `
        <div style="text-align:center;padding:28px 0 10px;color:#4a7a9a;">
          <div style="font-size:40px;margin-bottom:8px;">🎬</div>
          <div style="font-size:13px;color:#5a8ab8;">No episodes yet. Start your creator story!</div>
        </div>
      `;
      return;
    }

    list.innerHTML = snap.docs.map(d => {
      const ep = d.data();
      const ts = ep.createdDate ? new Date(ep.createdDate.seconds ? ep.createdDate.seconds*1000 : ep.createdDate).toLocaleDateString() : '';
      return `
        <div class="snxs-episode-card">
          <div class="snxs-ep-header">
            <div class="snxs-ep-num">EP${ep.episodeNumber}</div>
            <div class="snxs-ep-info">
              <div class="snxs-ep-label">Episode ${ep.episodeNumber}</div>
              <div class="snxs-ep-title">${cleanText(ep.title) || `Episode ${ep.episodeNumber}`}</div>
              <div class="snxs-ep-desc">${cleanText(ep.description)}</div>
            </div>
          </div>
          <div class="snxs-ep-meta">
            <span class="snxs-ep-meta-item">👁 ${ep.views || 0} views</span>
            ${ts ? `<span class="snxs-ep-meta-item">📅 ${ts}</span>` : ''}
            ${ep.soundtrack ? `<span class="snxs-ep-meta-item">🎵 Soundtrack</span>` : ''}
          </div>
        </div>
      `;
    }).join('');
  } catch(e) {
    list.innerHTML = `<div style="color:#ff5577;font-size:12px;padding:14px 0;">Error: ${e.message}</div>`;
  }
}
window.snxf_renderEpisodeList = snxf_renderEpisodeList;

function snxf_openNewEpisode() {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,3,12,0.92);display:flex;align-items:center;justify-content:center;z-index:8000;padding:16px;backdrop-filter:blur(8px)';
  modal.innerHTML = `
    <div style="background:rgba(7,20,42,0.98);border:1px solid rgba(0,174,239,0.4);border-radius:16px;padding:22px;width:100%;max-width:420px;max-height:90vh;overflow-y:auto;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <strong style="color:#fff;font-size:16px;">🎬 New Episode</strong>
        <button onclick="this.closest('[style]').remove()" style="background:none;border:none;color:#5a8ab8;font-size:18px;cursor:pointer;">✕</button>
      </div>
      <div style="margin-bottom:10px;">
        <div style="font-size:11px;color:#5a8ab8;margin-bottom:6px;letter-spacing:1px;text-transform:uppercase;">Quick Templates</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
          ${EPISODE_TEMPLATES.map(t => `<button onclick="document.getElementById('_epTitle').value='${t.template}'" style="background:rgba(0,40,100,0.5);border:1px solid rgba(0,174,239,0.25);border-radius:8px;color:#5a8ab8;font-size:10px;padding:4px 10px;cursor:pointer;">EP${t.num}: ${t.template}</button>`).join('')}
        </div>
      </div>
      <input id="_epNum" type="number" min="1" placeholder="Episode number…" style="width:100%;padding:10px;background:rgba(0,15,40,0.8);border:1px solid rgba(0,174,239,0.3);color:#fff;border-radius:8px;margin-bottom:8px;box-sizing:border-box;">
      <input id="_epTitle" placeholder="Episode title…" style="width:100%;padding:10px;background:rgba(0,15,40,0.8);border:1px solid rgba(0,174,239,0.3);color:#fff;border-radius:8px;margin-bottom:8px;box-sizing:border-box;">
      <textarea id="_epDesc" placeholder="Tell your story…" rows="3" style="width:100%;padding:10px;background:rgba(0,15,40,0.8);border:1px solid rgba(0,174,239,0.3);color:#fff;border-radius:8px;margin-bottom:8px;resize:vertical;box-sizing:border-box;"></textarea>
      <input id="_epSoundtrack" placeholder="Soundtrack / music title (optional)…" style="width:100%;padding:10px;background:rgba(0,15,40,0.8);border:1px solid rgba(0,174,239,0.3);color:#fff;border-radius:8px;margin-bottom:14px;box-sizing:border-box;">
      <button onclick="snxf_saveEpisode(this)" style="width:100%;padding:11px;background:linear-gradient(135deg,#330044,#660099);border:none;border-radius:10px;color:#fff;font-size:13px;font-weight:800;cursor:pointer;">🎬 Publish Episode</button>
    </div>
  `;
  document.body.appendChild(modal);
}
window.snxf_openNewEpisode = snxf_openNewEpisode;

async function snxf_saveEpisode(btn) {
  const user = _me(); const fs = _fs();
  if (!user || !fs) return;
  const { db, collection, addDoc, serverTimestamp } = fs;
  const epNum     = parseInt(document.getElementById('_epNum')?.value) || 1;
  const title     = document.getElementById('_epTitle')?.value.trim();
  const desc      = document.getElementById('_epDesc')?.value.trim();
  const soundtrack= document.getElementById('_epSoundtrack')?.value.trim();
  if (!title) { _toast('⚠️ Please enter an episode title.'); return; }
  btn.disabled = true; btn.textContent = 'Publishing…';
  try {
    await addDoc(collection(db, 'users', user.uid, 'creatorStories'), {
      episodeNumber: epNum,
      title, description: desc, soundtrack,
      media: [], views: 0,
      createdDate: serverTimestamp(),
    });
    _toast(`🎬 Episode ${epNum} "${title}" published!`);
    snxf_awardXP(30, 'Published a Creator Episode');
    btn.closest('[style]').remove();
    snxf_renderEpisodeList();
  } catch(e) {
    btn.disabled = false; btn.textContent = '🎬 Publish Episode';
    _toast('❌ Publish failed: ' + e.message);
  }
}
window.snxf_saveEpisode = snxf_saveEpisode;

/* ══════════════════════════════════════════════════════════
   PAGE INIT — called by navTo hook in index.html
   ══════════════════════════════════════════════════════════ */

const _PAGE_LOADERS = {
  shadowRealmsPage:      snxf_loadRealmsPage,
  shadowCompanionsPage:  snxf_loadCompanionsPage,
  shadowVaultPage:       snxf_loadVaultPage,
  shadowQuestsPage:      snxf_loadQuestsPage,
  creatorStoriesPage:    snxf_loadCreatorStoriesPage,
};

/**
 * Called by the navTo hook below.
 * Runs the correct loader for each feature page.
 */
window.snxf_onNavTo = function(pageId) {
  const loader = _PAGE_LOADERS[pageId];
  if (loader) { try { loader(); } catch(e) { console.error('[SNXF] loader error for', pageId, e); } }
};

/* ── Patch navTo so the feature pages initialise on navigation ── */
(function _patchNavTo() {
  function _patch() {
    const orig = window.navTo;
    if (!orig) { setTimeout(_patch, 400); return; }
    window.navTo = function(pageId) {
      orig(pageId);
      window.snxf_onNavTo(pageId);
    };
  }
  _patch();
})();

console.log('[SNXF] Shadow Nexus Feature Pack loaded — 5 systems ready.');
