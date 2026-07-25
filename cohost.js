/**
 * Shadow Nexus Live — cohost.js  (v2)
 *
 * Co-Host feature — completely self-contained.
 * Does NOT touch live.js internals, chat, comments, feed, guest boxes,
 * notifications, stories, or any existing Firebase path.
 *
 * ─── Architecture ────────────────────────────────────────────────────────────
 *
 *  Firestore:
 *    /coHostRequests/{liveId}_{guestId}
 *      liveId, hostId, guestId, status: 'pending'|'accepted'|'declined', createdAt
 *
 *    /users/{uid}
 *      .friends[]       — host reads to build friend list
 *      .allowCoHostInvites (bool, default true)
 *      .onlineStatus   — 'online'|'away'|'offline' (optional, read-only)
 *
 *  Realtime Database (cohosts/ namespace — no overlap with live system):
 *    cohosts/{liveId}/active/{uid}
 *      uid, name, avatar, role:'cohost', joinedAt
 *    cohosts/{liveId}/settings
 *      allowCohosts, whoCanCohost
 *    cohosts/{liveId}/removed/{uid}
 *      ts
 *
 *  RTDB presence (same project):
 *    presence/{uid}
 *      online: bool, lastSeen: number  (written by live.js or script.js)
 *
 * ─── UI flow ─────────────────────────────────────────────────────────────────
 *
 *  Host:
 *    1. Taps "Co-Host Settings" button in bottom bar → hidden panel opens.
 *    2. Panel shows friends list with Online / Available / Busy / Offline status.
 *    3. Host taps "Invite" next to an online friend.
 *    4. System validates → writes coHostRequests document.
 *    5. Host sees specific error if something fails.
 *
 *  Friend (viewer):
 *    1. Receives "Invitation to join as co-host" card with Accept / Decline.
 *    2. Accept → writes to cohosts/{liveId}/active/, updates request status.
 *    3. Decline → updates request status, host is notified.
 *
 * ─── To disable entirely ────────────────────────────────────────────────────
 *    Remove <script src="cohost.js"> and <link href="cohost.css"> from live.html.
 */

'use strict';

(function () {

  // ── Firebase handles (provided by live.js via snxLiveReady event) ──────────
  let _db     = null;   // Firestore
  let _liveDB = null;   // Realtime Database
  let _auth   = null;
  let _user   = null;
  let _userData = null;
  let _roomId   = null;
  let _isHost   = false;
  let _isCohostOfRoom = null;

  // ── Global co-host feature flag (set by Founder via settings/features) ─────
  let _coHostEnabled = true;   // optimistic default; overridden after Firestore fetch

  // ── Live RTDB listeners ────────────────────────────────────────────────────
  let _activeUnsub      = null;   // cohosts/{room}/active
  let _inviteInboxUnsub = null;   // coHostRequests listener (invitee)
  let _hostDeclineUnsub = null;   // coHostRequests listener (host watching all)
  let _pendingInvites   = {};     // guestId → requestId  (sent this session)
  let _friendsCache     = [];     // [{uid, displayName, username, avatar, status}]
  let _panelOpen        = false;
  let _presenceTimer    = null;   // periodic refresh of friends + live lists

  // ── Settings defaults ──────────────────────────────────────────────────────
  let _cohostSettings = {
    allowCohosts: true,
    whoCanCohost: 'friends',   // 'friends' | 'approved' | 'nobody'
  };

  // ── Current pending invite data (invitee side) ─────────────────────────────
  let _pendingInviteData = null;

  /* ═══════════════════════════════════════════════════════════════════════════
     INIT — called once by the snxLiveReady event
     ═══════════════════════════════════════════════════════════════════════════ */
  function _init(db, liveDB, auth, user, userData, roomId, isHost) {
    _db       = db;
    _liveDB   = liveDB;
    _auth     = auth;
    _user     = user;
    _userData = userData || {};
    _roomId   = roomId;
    _isHost   = isHost;

    // Fetch the global co-host enabled flag from Firestore, then boot
    _fetchCoHostFlag().then(() => {
      _injectUI();
      _wireEvents();
      _applyCoHostEnabled();   // hide/show button based on flag

      if (_isHost) {
        _loadSettings();
        _subscribeActiveCohosts();
        _subscribeDeclineNotifications();
        // Hosts can ALSO receive co-host invites from OTHER streamers,
        // so always start the invite watcher regardless of role.
        if (_coHostEnabled) _watchForInvite();
        _writePresence('online');
      } else {
        if (_coHostEnabled) _watchForInvite();
        _writePresence('online');
      }

      // Subscribe to live changes so Founder toggling OFF mid-stream takes effect
      _subscribeCoHostFlag();
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     CO-HOST FEATURE FLAG — read from Firestore settings/features
     ═══════════════════════════════════════════════════════════════════════════ */
  async function _fetchCoHostFlag() {
    if (!_db) return;
    try {
      const { doc: fsDoc, getDoc: fsGetDoc } = await _importFirestore();
      const snap = await fsGetDoc(fsDoc(_db, 'settings', 'features'));
      if (snap.exists()) {
        const data = snap.data();
        _coHostEnabled = data.coHostEnabled !== false;
      }
    } catch (_) {}
  }

  function _subscribeCoHostFlag() {
    if (!_db) return;
    _importFirestore().then(({ doc: fsDoc, onSnapshot: fsOnSnapshot }) => {
      try {
        fsOnSnapshot(fsDoc(_db, 'settings', 'features'), snap => {
          const prev = _coHostEnabled;
          _coHostEnabled = !snap.exists() || snap.data().coHostEnabled !== false;
          if (_coHostEnabled !== prev) _applyCoHostEnabled();
        });
      } catch (_) {}
    });
  }

  /* Apply or remove co-host UI based on current _coHostEnabled flag */
  function _applyCoHostEnabled() {
    const btn = document.getElementById('btnCoHost');
    if (btn) btn.style.display = _coHostEnabled ? '' : 'none';

    const section = document.getElementById('cohostSettingsSection');
    if (section) section.style.display = _coHostEnabled ? '' : 'none';

    const card = document.getElementById('cohostInviteCard');
    if (card && !_coHostEnabled) _hideInviteCard();

    // When the Founder disables the Co-Host System site-wide, close any open
    // Co-Host Settings panel too so the whole feature disappears for this
    // user in real time — not just the trigger button.
    if (!_coHostEnabled && _panelOpen) _closePanel();

    if (_coHostEnabled && _inviteInboxUnsub === null) {
      // (Re)subscribe invite watcher if it was never started (flag was OFF at
      // boot) — applies to BOTH hosts and viewers, because a host of one
      // stream can still be invited to co-host a different stream.
      _watchForInvite();
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     RTDB PRESENCE — write own presence so friends can see us
     ═══════════════════════════════════════════════════════════════════════════ */
  async function _writePresence(status) {
    if (!_liveDB || !_user) return;
    try {
      const { ref: rtRef, set: rtSet, onDisconnect: rtOnDisconnect } = await _importRTDB();
      const presRef = rtRef(_liveDB, `presence/${_user.uid}`);
      await rtSet(presRef, { online: status === 'online', lastSeen: Date.now() });
      rtOnDisconnect(presRef).set({ online: false, lastSeen: Date.now() });
    } catch (_) {}
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     UI INJECTION — all DOM built here, nothing hard-coded in live.html
     ═══════════════════════════════════════════════════════════════════════════ */
  function _injectUI() {
    _injectButton();
    _injectSettingsPanel();
    _injectInviteCard();
    if (_isHost) {
      _injectSettingsSection();
    }
  }

  /* ── "Co-Host Settings" button — only visible to host, in bottom bar ── */
  function _injectButton() {
    if (document.getElementById('btnCoHost')) return;
    const btn = document.createElement('button');
    btn.id        = 'btnCoHost';
    btn.className = 'live-ctrl-btn';
    btn.title     = 'Co-Host Settings';
    btn.setAttribute('aria-label', 'Open co-host settings');
    btn.textContent = '🎙️';
    const endBtn = document.getElementById('btnEndLive');
    if (endBtn && endBtn.parentNode) {
      endBtn.parentNode.insertBefore(btn, endBtn);
    }
  }

  /* ── Co-Host Settings Panel — hidden by default ── */
  function _injectSettingsPanel() {
    if (document.getElementById('cohostPanel')) return;
    const panel = document.createElement('div');
    panel.id = 'cohostPanel';
    panel.setAttribute('aria-label', 'Co-Host Settings');
    panel.innerHTML = `
      <button class="cohost-popup-close" id="cohostPanelClose" aria-label="Close co-host panel">✕</button>
      <div class="cohost-popup-title">🎙️ Co-Host Settings</div>

      <!-- Current co-hosts -->
      <div class="cohost-section-label">Current Co-Hosts</div>
      <div id="cohostActiveList" class="cohost-user-list">
        <div class="cohost-empty">No active co-hosts.</div>
      </div>

      <hr class="cohost-divider">

      <!-- Live Now -->
      <div class="cohost-section-label">🔴 Live Now</div>
      <div id="cohostLiveList" class="cohost-user-list">
        <div class="cohost-empty">No one is live right now.</div>
      </div>

      <hr class="cohost-divider">

      <!-- Friends list -->
      <div class="cohost-section-label">Friends</div>
      <div id="cohostFriendsList" class="cohost-user-list">
        <div class="cohost-empty">Loading friends…</div>
      </div>
    `;
    const videoWrap = document.querySelector('.live-video-wrap');
    (videoWrap || document.body).appendChild(panel);
  }

  /* ── Invite card shown to the invitee ── */
  function _injectInviteCard() {
    if (document.getElementById('cohostInviteCard')) return;
    const card = document.createElement('div');
    card.id = 'cohostInviteCard';
    card.innerHTML = `
      <div class="cohost-invite-icon">🎥</div>
      <div class="cohost-invite-title">Co-host Invite</div>
      <div class="cohost-invite-sub" id="cohostInviteSub">Someone wants you to join as a co-host.</div>
      <div class="cohost-invite-actions">
        <button class="cohost-invite-accept" id="cohostAcceptBtn">ACCEPT</button>
        <button class="cohost-invite-deny"   id="cohostDenyBtn">DENY</button>
      </div>
    `;
    document.body.appendChild(card);
  }

  /* ── Co-Host settings section inside Live Settings panel ── */
  function _injectSettingsSection() {
    if (document.getElementById('cohostSettingsSection')) return;
    const panel = document.getElementById('liveSettingsPanel');
    if (!panel) return;
    const section = document.createElement('div');
    section.id = 'cohostSettingsSection';
    section.innerHTML = `
      <hr class="cohost-divider" style="margin:14px 0 10px;">
      <div class="lsp-row">
        <div class="lsp-label">
          <div class="lsp-label-name">🎙️ Allow Co-Hosts</div>
          <div class="lsp-label-desc">Let others join as co-host</div>
        </div>
        <label class="lsp-toggle" aria-label="Allow co-hosts toggle">
          <input type="checkbox" id="toggleAllowCohost" checked>
          <span class="lsp-slider"></span>
        </label>
      </div>
      <div class="lsp-row" style="flex-direction:column;align-items:flex-start;">
        <div class="lsp-label">
          <div class="lsp-label-name">Who Can Co-Host</div>
          <div class="lsp-label-desc">Who is eligible to receive an invite</div>
        </div>
        <div class="cohost-select-wrap" style="margin-top:6px;">
          <select id="selectWhoCanCohost" class="cohost-select">
            <option value="friends">🤝 Friends</option>
            <option value="approved">✅ Approved Users</option>
            <option value="nobody">🚫 Nobody</option>
          </select>
        </div>
      </div>
    `;
    panel.appendChild(section);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     EVENT WIRING
     ═══════════════════════════════════════════════════════════════════════════ */
  function _wireEvents() {
    // Co-Host button (host only — hidden via CSS for viewers)
    const btn = document.getElementById('btnCoHost');
    if (btn) btn.addEventListener('click', _togglePanel);

    // Panel close
    const closeBtn = document.getElementById('cohostPanelClose');
    if (closeBtn) closeBtn.addEventListener('click', _closePanel);

    // Accept / Decline invite (invitee side)
    const acceptBtn = document.getElementById('cohostAcceptBtn');
    const denyBtn   = document.getElementById('cohostDenyBtn');
    if (acceptBtn) acceptBtn.addEventListener('click', _acceptInvite);
    if (denyBtn)   denyBtn.addEventListener('click',   _declineInvite);

    // Settings toggles (host only)
    if (_isHost) {
      const toggleAllow = document.getElementById('toggleAllowCohost');
      if (toggleAllow) toggleAllow.addEventListener('change', e => {
        _cohostSettings.allowCohosts = e.target.checked;
        _saveSettings();
      });
      const selectWho = document.getElementById('selectWhoCanCohost');
      if (selectWho) selectWho.addEventListener('change', e => {
        _cohostSettings.whoCanCohost = e.target.value;
        _saveSettings();
      });
    }

    // Close panel on outside click
    document.addEventListener('click', e => {
      if (!_panelOpen) return;
      const panel = document.getElementById('cohostPanel');
      const btn   = document.getElementById('btnCoHost');
      if (!panel || !btn) return;
      if (!panel.contains(e.target) && !btn.contains(e.target)) _closePanel();
    }, true);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PANEL OPEN / CLOSE
     ═══════════════════════════════════════════════════════════════════════════ */
  function _togglePanel() { _panelOpen ? _closePanel() : _openPanel(); }

  function _openPanel() {
    const panel = document.getElementById('cohostPanel');
    const btn   = document.getElementById('btnCoHost');
    if (!panel) return;
    panel.classList.add('visible');
    btn && btn.classList.add('cohost-active');
    _panelOpen = true;
    // Load friends list + live users every time the panel opens
    _loadFriendsList();
    _loadLiveUsers();
    // Refresh every 15 s while the panel is open so status dots update
    // in real time (RTDB presence changes, new live users, etc.)
    if (_presenceTimer) clearInterval(_presenceTimer);
    _presenceTimer = setInterval(() => {
      if (!_panelOpen) {
        clearInterval(_presenceTimer);
        _presenceTimer = null;
        return;
      }
      _loadFriendsList();
      _loadLiveUsers();
    }, 15000);
  }

  function _closePanel() {
    const panel = document.getElementById('cohostPanel');
    const btn   = document.getElementById('btnCoHost');
    if (!panel) return;
    panel.classList.remove('visible');
    btn && btn.classList.remove('cohost-active');
    _panelOpen = false;
    // Stop the periodic refresh when the panel closes
    if (_presenceTimer) {
      clearInterval(_presenceTimer);
      _presenceTimer = null;
    }
  }
  /* Load users who are currently live (for the "Live Now" section) */
  async function _loadLiveUsers() {
    const el = document.getElementById('cohostLiveList');
    if (!el) return;
    el.innerHTML = '<div class="cohost-empty">Loading…</div>';

    if (!_db || !_user) {
      el.innerHTML = '<div class="cohost-empty">Not connected.</div>';
      return;
    }

    try {
      const { collection: fsCol, query: fsQuery, where: fsWhere, getDocs: fsGetDocs } =
        await _importFirestore();
      const { ref: rtRef, get: rtGet } = await _importRTDB();

      let liveUsers = [];
      const seenUids = new Set();

      // ── Primary approach: query Firestore users where isLive == true ──
      try {
        const q = fsQuery(fsCol(_db, 'users'), fsWhere('isLive', '==', true));
        const snap = await fsGetDocs(q);
        snap.forEach(d => {
          if (d.id !== _user.uid && !seenUids.has(d.id)) {
            seenUids.add(d.id);
            liveUsers.push({ uid: d.id, ...d.data() });
          }
        });
      } catch (liveErr) {
        console.warn('[CoHost] live users query failed:', liveErr?.code || liveErr?.message);
      }

      // ── Fallback 1: check the host's friends for isLive ──
      if (!liveUsers.length) {
        try {
          const { doc: fsDoc, getDoc: fsGetDoc } = await _importFirestore();
          const myDoc = await fsGetDoc(fsDoc(_db, 'users', _user.uid));
          const friendUids = (myDoc.exists() && myDoc.data().friends) || [];
          if (friendUids.length) {
            for (const fuid of friendUids) {
              if (fuid === _user.uid || seenUids.has(fuid)) continue;
              try {
                const fdoc = await fsGetDoc(fsDoc(_db, 'users', fuid));
                if (fdoc.exists() && fdoc.data().isLive) {
                  seenUids.add(fuid);
                  liveUsers.push({ uid: fdoc.id, ...fdoc.data() });
                }
              } catch (e) { /* skip individual failures */ }
            }
          }
        } catch (fallbackErr) {
          console.warn('[CoHost] live users fallback failed:', fallbackErr?.code || fallbackErr?.message);
        }
      }

      // ── Fallback 2: scan RTDB users/ for live:true ──
      // The main app (index.html) and live.js both write RTDB users/{uid}
      // with { online: true, live: true, lastSeen }. If Firestore isLive
      // queries fail (missing index, rules, etc.), we can still find live
      // users by reading the RTDB users/ node.
      if (!liveUsers.length) {
        try {
          const usersSnap = await rtGet(rtRef(_liveDB, 'users'));
          if (usersSnap.exists()) {
            const allUsers = usersSnap.val() || {};
            const liveUids = Object.entries(allUsers)
              .filter(([uid, v]) => uid !== _user.uid && v && v.live === true)
              .map(([uid]) => uid);

            // Fetch their Firestore profiles for display data
            if (liveUids.length) {
              const { doc: fsDoc, getDoc: fsGetDoc } = await _importFirestore();
              for (const fuid of liveUids) {
                if (seenUids.has(fuid)) continue;
                try {
                  const fdoc = await fsGetDoc(fsDoc(_db, 'users', fuid));
                  if (fdoc.exists()) {
                    seenUids.add(fuid);
                    liveUsers.push({ uid: fdoc.id, ...fdoc.data() });
                  }
                } catch (_) {}
              }
            }
          }
        } catch (rtdbErr) {
          console.warn('[CoHost] RTDB users/ live scan failed:', rtdbErr?.code || rtdbErr?.message);
        }
      }

      if (!liveUsers.length) {
        el.innerHTML = '<div class="cohost-empty">No one is live right now.</div>';
        return;
      }

      // Deduplicate by uid (already done above, but double-check)
      liveUsers = liveUsers.filter(u => {
        if (seenUids.has(u.uid)) return true; // already filtered above
        return true;
      });

      el.innerHTML = '';
      liveUsers.forEach(f => {
        const isSent    = !!_pendingInvites[f.uid];
        const canInvite = !isSent && f.allowCoHostInvites !== false;
        const initials  = (f.displayName || f.username || '?')[0].toUpperCase();
        const avatarBg  = (f.avatar || f.profilePicture)
          ? `background-image:url('${_esc(f.avatar || f.profilePicture)}');background-size:cover;background-position:center;`
          : '';
        const row = document.createElement('div');
        row.className = 'cohost-user-row';
        row.innerHTML = `
          <div class="cohost-user-avatar" style="${avatarBg}">${avatarBg ? '' : initials}</div>
          <div style="flex:1;min-width:0;">
            <div class="cohost-user-name">${_esc(f.displayName || f.username || 'User')}</div>
            <div class="cohost-user-status">
              <span class="cohost-status-dot cohost-status-available"></span>
      
