/**
 * Shadow Nexus Live - cohost.js  (v4)
 *
 * Co-Host feature - completely self-contained.
 * Does NOT touch live.js internals, chat, feed, guest boxes,
 * notifications, stories, or any existing Firebase path.
 *
 * Architecture:
 *  Firestore:  /coHostRequests/{liveId}_{guestId}
 *  RTDB:       cohosts/{liveId}/active/{uid}
 *              cohosts/{liveId}/settings
 *              cohosts/{liveId}/removed/{uid}
 *              coHostInvites/{guestUid}/{hostUid}
 *              liveRooms/{roomId}  (read-only — written by live.js)
 */

'use strict';

(function () {

  var _db = null, _liveDB = null, _auth = null, _user = null;
  var _userData = null, _roomId = null, _isHost = false;
  var _coHostEnabled = true;
  var _activeUnsub = null, _inviteInboxUnsub = null, _hostDeclineUnsub = null;
  // Real-time live-user listeners
  var _rtdbLiveUnsub = null;   // RTDB liveRooms onValue unsubscribe
  var _fsLiveUnsub   = null;   // Firestore users onSnapshot unsubscribe
  var _pendingInvites = {}, _panelOpen = false;
  var _cohostSettings = { allowCohosts: true, whoCanCohost: 'everyone' };
  var _pendingInviteData = null;
  var _searchQuery = '', _cachedLiveUsers = [];
  // Merged live-user map: uid → user object (union of RTDB + FS sources)
  var _liveUserMap = {};

  function _importFS()   { return import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js'); }
  function _importRTDB() { return import('https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js'); }

  window.addEventListener('snxLiveReady', function(e) {
    var d = e.detail || {};
    _init(d.db, d.liveDB, d.auth, d.user, d.userData, d.roomId, d.isHost);
  });

  function _init(db, liveDB, auth, user, userData, roomId, isHost) {
    _db = db; _liveDB = liveDB; _auth = auth; _user = user;
    _userData = userData || {}; _roomId = roomId; _isHost = isHost;
    _fetchCoHostFlag().then(function() {
      _injectUI(); _wireEvents(); _applyCoHostEnabled();
      if (_isHost) {
        _loadSettings(); _subscribeActiveCohosts(); _subscribeDeclineNotifications();
        if (_coHostEnabled) _watchForInvite();
        _writePresence('online');
      } else {
        if (_coHostEnabled) _watchForInvite();
        _writePresence('online');
      }
      _subscribeCoHostFlag();
      // Start real-time live-users listeners immediately (not just when panel opens)
      _subscribeRtdbLiveRooms();
      _subscribeFsLiveUsers();
      window._cohostCleanup = _cleanup;
    });
  }

  async function _fetchCoHostFlag() {
    if (!_db) return;
    try {
      var fs = await _importFS();
      var snap = await fs.getDoc(fs.doc(_db, 'settings', 'features'));
      if (snap.exists()) _coHostEnabled = snap.data().coHostEnabled !== false;
    } catch(e) {}
  }

  function _subscribeCoHostFlag() {
    if (!_db) return;
    _importFS().then(function(fs) {
      try {
        fs.onSnapshot(fs.doc(_db, 'settings', 'features'), function(snap) {
          var prev = _coHostEnabled;
          _coHostEnabled = !snap.exists() || snap.data().coHostEnabled !== false;
          if (_coHostEnabled !== prev) _applyCoHostEnabled();
        });
      } catch(e) {}
    });
  }

  function _applyCoHostEnabled() {
    window._snxCoHostEnabled = _coHostEnabled;
    var body = document.body;
    if (!_coHostEnabled) {
      if (body) body.classList.add('cohost-disabled');
      var btn = document.getElementById('btnCoHost');
      if (btn) { btn.style.display = 'none'; btn.style.visibility = 'hidden'; }
      var sec = document.getElementById('cohostSettingsSection');
      if (sec) sec.style.display = 'none';
      _hideInviteCard(); if (_panelOpen) _closePanel();
      if (_inviteInboxUnsub) { try { _inviteInboxUnsub(); } catch(e){} _inviteInboxUnsub = null; }
      if (_activeUnsub) { try { _activeUnsub(); } catch(e){} _activeUnsub = null; }
      if (_hostDeclineUnsub) { try { _hostDeclineUnsub(); } catch(e){} _hostDeclineUnsub = null; }
      _clearCohostBadge(); _pendingInviteData = null; _pendingInvites = {};
    } else {
      if (body) body.classList.remove('cohost-disabled');
      var btn2 = document.getElementById('btnCoHost');
      if (btn2) { btn2.style.display = ''; btn2.style.visibility = ''; }
      var sec2 = document.getElementById('cohostSettingsSection');
      if (sec2) sec2.style.display = '';
      if (!_inviteInboxUnsub) _watchForInvite();
      if (_isHost) {
        if (!_activeUnsub) _subscribeActiveCohosts();
        if (!_hostDeclineUnsub) _subscribeDeclineNotifications();
      }
      // Re-start real-time listeners if they were stopped
      if (!_rtdbLiveUnsub) _subscribeRtdbLiveRooms();
      if (!_fsLiveUnsub) _subscribeFsLiveUsers();
    }
  }

  async function _writePresence(status) {
    if (!_liveDB || !_user) return;
    try {
      var rtdb = await _importRTDB();
      var presRef = rtdb.ref(_liveDB, 'presence/' + _user.uid);
      await rtdb.set(presRef, { online: status === 'online', lastSeen: Date.now() });
      if (status === 'online') rtdb.onDisconnect(presRef).set({ online: false, lastSeen: Date.now() });
    } catch(e) {}
  }

  function _injectUI() {
    _injectButton(); _injectSettingsPanel(); _injectInviteCard();
    if (_isHost) _injectSettingsSection();
  }

  function _injectButton() {
    if (document.getElementById('btnCoHost')) return;
    var btn = document.createElement('button');
    btn.id = 'btnCoHost'; btn.className = 'live-ctrl-btn';
    btn.title = 'Co-Host Settings'; btn.setAttribute('aria-label', 'Open co-host settings');
    btn.textContent = '\uD83C\uDF99\uFE0F';
    var endBtn = document.getElementById('btnEndLive');
    if (endBtn && endBtn.parentNode) endBtn.parentNode.insertBefore(btn, endBtn);
  }

  function _injectSettingsPanel() {
    if (document.getElementById('cohostPanel')) return;
    var panel = document.createElement('div');
    panel.id = 'cohostPanel'; panel.setAttribute('aria-label', 'Co-Host Settings');
    panel.innerHTML = '<button class="cohost-popup-close" id="cohostPanelClose" aria-label="Close">x</button>'
      + '<div class="cohost-popup-title">Co-Host Settings</div>'
      + '<div class="cohost-section-label">Current Co-Hosts</div>'
      + '<div id="cohostActiveList" class="cohost-user-list"><div class="cohost-empty">No active co-hosts.</div></div>'
      + '<hr class="cohost-divider">'
      + '<div class="cohost-section-label">Live Now</div>'
      + '<input type="text" id="cohostLiveSearch" class="cohost-search-input" placeholder="Search live users..." autocomplete="off" autocorrect="off" spellcheck="false" style="margin-bottom:8px;width:100%;display:block;">'
      + '<div id="cohostLiveList" class="cohost-user-list"><div class="cohost-empty">No one is live right now.</div></div>'
      + '<hr class="cohost-divider">'
      + '<div class="cohost-section-label">Friends</div>'
      + '<div id="cohostFriendsList" class="cohost-user-list"><div class="cohost-empty">Loading friends...</div></div>';
    var vw = document.querySelector('.live-video-wrap');
    (vw || document.body).appendChild(panel);
  }

  function _injectInviteCard() {
    if (document.getElementById('cohostInviteCard')) return;
    var card = document.createElement('div');
    card.id = 'cohostInviteCard';
    card.innerHTML = '<div class="cohost-invite-icon">\uD83C\uDFA5</div>'
      + '<div class="cohost-invite-title">Co-host Invite</div>'
      + '<div class="cohost-invite-sub" id="cohostInviteSub">Someone wants you to join as a co-host.</div>'
      + '<div class="cohost-invite-actions">'
      +   '<button class="cohost-invite-accept" id="cohostAcceptBtn">ACCEPT</button>'
      +   '<button class="cohost-invite-deny" id="cohostDenyBtn">DENY</button>'
      + '</div>';
    document.body.appendChild(card);
  }

  function _injectSettingsSection() {
    if (document.getElementById('cohostSettingsSection')) return;
    var panel = document.getElementById('liveSettingsPanel');
    if (!panel) return;
    var section = document.createElement('div');
    section.id = 'cohostSettingsSection';
    section.innerHTML = '<hr class="cohost-divider" style="margin:14px 0 10px;">'
      + '<div class="lsp-row">'
      +   '<div class="lsp-label"><div class="lsp-label-name">Allow Co-Hosts</div><div class="lsp-label-desc">Let others join as co-host</div></div>'
      +   '<label class="lsp-toggle" aria-label="Allow co-hosts toggle"><input type="checkbox" id="toggleAllowCohost" checked><span class="lsp-slider"></span></label>'
      + '</div>'
      + '<div class="lsp-row" style="flex-direction:column;align-items:flex-start;">'
      +   '<div class="lsp-label"><div class="lsp-label-name">Who Can Co-Host</div><div class="lsp-label-desc">Who is eligible to receive an invite</div></div>'
      +   '<div class="cohost-select-wrap" style="margin-top:6px;">'
      +     '<select id="selectWhoCanCohost" class="cohost-select">'
      +       '<option value="everyone">Everyone Live</option>'
      +       '<option value="friends">Friends</option>'
      +       '<option value="nobody">Nobody</option>'
      +     '</select>'
      +   '</div>'
      + '</div>';
    panel.appendChild(section);
  }

  function _wireEvents() {
    var btn = document.getElementById('btnCoHost');
    if (btn) btn.addEventListener('click', _togglePanel);
    var closeBtn = document.getElementById('cohostPanelClose');
    if (closeBtn) closeBtn.addEventListener('click', _closePanel);
    var acceptBtn = document.getElementById('cohostAcceptBtn');
    if (acceptBtn) acceptBtn.addEventListener('click', _acceptInvite);
    var denyBtn = document.getElementById('cohostDenyBtn');
    if (denyBtn) denyBtn.addEventListener('click', _declineInvite);
    if (_isHost) {
      var toggleAllow = document.getElementById('toggleAllowCohost');
      if (toggleAllow) toggleAllow.addEventListener('change', function(e) {
        _cohostSettings.allowCohosts = e.target.checked; _saveSettings();
      });
      var selectWho = document.getElementById('selectWhoCanCohost');
      if (selectWho) selectWho.addEventListener('change', function(e) {
        _cohostSettings.whoCanCohost = e.target.value; _saveSettings();
      });
    }
    document.addEventListener('input', function(e) {
      if (e.target && e.target.id === 'cohostLiveSearch') {
        _searchQuery = e.target.value.toLowerCase().trim();
        _renderLiveList(_cachedLiveUsers);
      }
    });
    document.addEventListener('click', function(e) {
      if (!_panelOpen) return;
      var p = document.getElementById('cohostPanel');
      var b = document.getElementById('btnCoHost');
      if (!p || !b) return;
      if (!p.contains(e.target) && !b.contains(e.target)) _closePanel();
    }, true);
  }

  function _togglePanel() { _panelOpen ? _closePanel() : _openPanel(); }

  function _openPanel() {
    var panel = document.getElementById('cohostPanel');
    var btn = document.getElementById('btnCoHost');
    if (!panel) return;
    panel.classList.add('visible'); if (btn) btn.classList.add('cohost-active');
    _panelOpen = true;
    // Immediately render whatever is already in the live map (real-time listeners
    // have been running since init, so the cache may already be populated).
    _flushLiveMap();
    _loadFriendsList();
  }

  function _closePanel() {
    var panel = document.getElementById('cohostPanel');
    var btn = document.getElementById('btnCoHost');
    if (!panel) return;
    panel.classList.remove('visible'); if (btn) btn.classList.remove('cohost-active');
    _panelOpen = false;
  }

  /* ── Real-time RTDB listener on liveRooms ──
     Fires instantly when any stream starts or ends. */
  function _subscribeRtdbLiveRooms() {
    if (!_liveDB) return;
    if (_rtdbLiveUnsub) { try { _rtdbLiveUnsub(); } catch(e){} _rtdbLiveUnsub = null; }
    _importRTDB().then(function(rtdb) {
      var roomsRef = rtdb.ref(_liveDB, 'liveRooms');
      var listener = rtdb.onValue(roomsRef, function(snap) {
        // Remove all RTDB-sourced entries first, keep FS-sourced ones
        var newMap = {};
        Object.keys(_liveUserMap).forEach(function(uid) {
          if (_liveUserMap[uid]._src === 'fs') newMap[uid] = _liveUserMap[uid];
        });
        if (snap.exists()) {
          snap.forEach(function(child) {
            var r = child.val();
            if (!r) return;
            // Only include rooms that are currently live
            if (r.status !== 'live' && !r.isLive) return;
            if (!r.hostId) return;
            if (_user && r.hostId === _user.uid) return; // exclude self
            // Merge with any existing FS entry (FS data takes priority for profile)
            var existing = newMap[r.hostId] || {};
            newMap[r.hostId] = Object.assign({}, existing, {
              uid:        r.hostId,
              displayName: existing.displayName || r.hostName || 'Someone',
              username:    existing.username    || r.hostUsername || '',
              avatar:      existing.avatar      || r.hostAvatar  || '',
              isLive:      true,
              liveRoomId:  child.key,
              liveTitle:   r.title || '',
              _src:        existing._src === 'fs' ? 'fs' : 'rtdb',
            });
          });
        }
        _liveUserMap = newMap;
        _flushLiveMap();
      }, function(err) {
        console.warn('[CoHost] RTDB liveRooms listener error:', err && err.message);
      });
      _rtdbLiveUnsub = function() { try { rtdb.off(roomsRef, listener); } catch(e){} };
    }).catch(function(e) { console.warn('[CoHost] _subscribeRtdbLiveRooms:', e && e.message); });
  }

  /* ── Real-time Firestore listener on users where isLive == true ──
     Catches Firestore-side changes that RTDB may not reflect yet. */
  function _subscribeFsLiveUsers() {
    if (!_db) return;
    if (_fsLiveUnsub) { try { _fsLiveUnsub(); } catch(e){} _fsLiveUnsub = null; }
    _importFS().then(function(fs) {
      try {
        var q = fs.query(fs.collection(_db, 'users'), fs.where('isLive', '==', true));
        _fsLiveUnsub = fs.onSnapshot(q, function(snap) {
          // Remove all FS-sourced entries, keep RTDB-sourced ones
          var newMap = {};
          Object.keys(_liveUserMap).forEach(function(uid) {
            if (_liveUserMap[uid]._src !== 'fs') newMap[uid] = _liveUserMap[uid];
          });
          snap.forEach(function(d) {
            if (_user && d.id === _user.uid) return; // exclude self
            var data = d.data();
            // Merge with any RTDB entry
            var existing = newMap[d.id] || _liveUserMap[d.id] || {};
            newMap[d.id] = Object.assign({}, existing, {
              uid:        d.id,
              displayName: data.displayName || data.username || existing.displayName || 'Someone',
              username:    data.username    || existing.username    || '',
              avatar:      data.avatar      || data.profilePicture || existing.avatar || '',
              isLive:      true,
              liveRoomId:  data.liveRoomId  || existing.liveRoomId || '',
              liveTitle:   data.liveTitle   || existing.liveTitle  || '',
              _src:        'fs',
            });
          });
          _liveUserMap = newMap;
          _flushLiveMap();
        }, function(err) {
          console.warn('[CoHost] FS live users listener error:', err && err.message);
        });
      } catch(e) { console.warn('[CoHost] _subscribeFsLiveUsers:', e && e.message); }
    }).catch(function(e) { console.warn('[CoHost] _subscribeFsLiveUsers import:', e && e.message); });
  }

  /* ── Convert the live-user map to a sorted array and render ── */
  function _flushLiveMap() {
    _cachedLiveUsers = Object.keys(_liveUserMap).map(function(uid) { return _liveUserMap[uid]; });
    // Sort by displayName for consistent ordering
    _cachedLiveUsers.sort(function(a, b) {
      return (a.displayName || '').localeCompare(b.displayName || '');
    });
    _renderLiveList(_cachedLiveUsers);
  }

  function _renderLiveList(users) {
    var el = document.getElementById('cohostLiveList');
    if (!el) return;
    // If panel is not open, don't bother rendering (will render on open)
    if (!_panelOpen) return;
    var q = _searchQuery;
    var filtered = q ? users.filter(function(u) {
      return (u.displayName||'').toLowerCase().indexOf(q) > -1 || (u.username||'').toLowerCase().indexOf(q) > -1;
    }) : users;
    if (!filtered.length) {
      el.innerHTML = q ? '<div class="cohost-empty">No results for "' + _esc(q) + '"</div>'
                       : '<div class="cohost-empty">No one is live right now.</div>';
      return;
    }
    el.innerHTML = '';
    filtered.forEach(function(u) { _renderRow(u, el, true); });
  }

  async function _loadFriendsList() {
    var el = document.getElementById('cohostFriendsList');
    if (!el) return;
    if (!_db || !_user) { el.innerHTML = '<div class="cohost-empty">Not connected.</div>'; return; }
    try {
      var fs = await _importFS();
      var rtdb = await _importRTDB();
      var myDoc = await fs.getDoc(fs.doc(_db, 'users', _user.uid));
      var friendUids = (myDoc.exists() && myDoc.data().friends) || [];
      if (!friendUids.length) { el.innerHTML = '<div class="cohost-empty">No friends yet.</div>'; return; }
      var friends = [];
      for (var i = 0; i < friendUids.length; i++) {
        var fuid = friendUids[i];
        if (fuid === _user.uid) continue;
        try {
          var fdoc = await fs.getDoc(fs.doc(_db, 'users', fuid));
          if (fdoc.exists()) friends.push(Object.assign({ uid: fuid }, fdoc.data()));
        } catch(e) {}
      }
      var presSnap = await rtdb.get(rtdb.ref(_liveDB, 'users')).catch(function() { return null; });
      var presMap = {};
      if (presSnap && presSnap.exists()) presSnap.forEach(function(c) { presMap[c.key] = c.val(); });
      if (!friends.length) { el.innerHTML = '<div class="cohost-empty">No friends to show.</div>'; return; }
      el.innerHTML = '';
      friends.forEach(function(f) {
        var pres = presMap[f.uid] || {};
        _renderRow(Object.assign({}, f, { _isOnline: !!pres.online, _isLive: !!pres.live }), el, false);
      });
    } catch(e) {
      console.warn('[CoHost] loadFriendsList:', e && e.message);
      var el2 = document.getElementById('cohostFriendsList');
      if (el2) el2.innerHTML = '<div class="cohost-empty">Could not load friends.</div>';
    }
  }

  function _renderRow(u, container, isLive) {
    var sent = !!_pendingInvites[u.uid];
    var row = document.createElement('div'); row.className = 'cohost-user-row';

    // ── Avatar (profile picture) ──
    var av = document.createElement('div'); av.className = 'cohost-user-avatar';
    var avUrl = u.avatar || u.profilePicture || '';
    if (avUrl) {
      var img = document.createElement('img');
      img.src = avUrl;
      img.alt = '';
      img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover;';
      img.onerror = function() { av.removeChild(img); av.textContent = (u.displayName || '?')[0].toUpperCase(); };
      av.appendChild(img);
    } else {
      av.textContent = (u.displayName || '?')[0].toUpperCase();
    }

    // ── Status dot + label ──
    var dotClass = 'cohost-status-offline', label = 'Offline';
    if (isLive || u._isLive || u.isLive) {
      dotClass = 'cohost-status-available'; label = 'Live Now';
    } else if (u._isOnline) {
      dotClass = 'cohost-status-online'; label = 'Online';
    }

    // ── "LIVE NOW" pill for live users ──
    var liveNowPill = (isLive || u._isLive || u.isLive)
      ? '<span style="display:inline-flex;align-items:center;gap:3px;background:rgba(220,0,60,0.22);border:1px solid rgba(255,50,80,0.55);border-radius:6px;padding:1px 6px;font-size:9px;font-weight:800;color:#ff6680;letter-spacing:0.4px;text-transform:uppercase;margin-left:4px;">● LIVE NOW</span>'
      : '';

    var th = u.liveTitle ? '<span style="color:#5a7a9a;font-size:9px;margin-left:4px;">' + _esc(u.liveTitle.slice(0,28)) + '</span>' : '';
    var info = document.createElement('div'); info.style.cssText = 'flex:1;min-width:0;';
    info.innerHTML = '<div class="cohost-user-name" style="display:flex;align-items:center;flex-wrap:wrap;gap:4px;">'
      + _esc(u.displayName || 'Unknown') + liveNowPill + '</div>'
      + '<div class="cohost-user-status"><span class="cohost-status-dot ' + dotClass + '"></span>'
      + '<span class="cohost-status-label">' + label + '</span>' + th + '</div>';

    var invBtn = document.createElement('button');
    invBtn.className = 'cohost-invite-btn' + (sent ? ' sent' : '');
    invBtn.textContent = sent ? 'Sent ✓' : 'Invite'; invBtn.disabled = sent;
    if (!sent) { (function(user, btn) { btn.addEventListener('click', function() { _sendInvite(user, btn); }); })(u, invBtn); }
    row.appendChild(av); row.appendChild(info); row.appendChild(invBtn);
    container.appendChild(row);
  }

  async function _sendInvite(user, btn) {
    if (!_db || !_liveDB || !_user || !_roomId) return;
    if (!_cohostSettings.allowCohosts) { _toast('Co-Hosting is disabled in Live Settings.'); return; }
    if (_cohostSettings.whoCanCohost === 'nobody') { _toast('Co-Hosting is set to nobody.'); return; }
    if (_pendingInvites[user.uid]) { _toast('Invite already sent to ' + (user.displayName||'this user')); return; }
    var guestId = user.uid, requestId = _roomId + '_' + guestId;
    if (btn) { btn.textContent = 'Sent'; btn.classList.add('sent'); btn.disabled = true; }
    _pendingInvites[guestId] = requestId;
    try {
      var fs = await _importFS(); var rtdb = await _importRTDB();
      var hostName = _userData.displayName || (_user.email && _user.email.split('@')[0]) || 'Host';
      var hostAvatar = _userData.avatar || _userData.profilePicture || '';
      await fs.setDoc(fs.doc(_db, 'coHostRequests', requestId), {
        liveId: _roomId, hostId: _user.uid, hostName: hostName, hostAvatar: hostAvatar,
        guestId: guestId, guestName: user.displayName || '', status: 'pending', createdAt: fs.serverTimestamp(),
      });
      await rtdb.set(rtdb.ref(_liveDB, 'coHostInvites/' + guestId + '/' + _user.uid), {
        liveId: _roomId, hostUid: _user.uid, hostName: hostName, hostAvatar: hostAvatar,
        requestId: requestId, ts: Date.now(),
      });
      _toast('Invite sent to ' + (user.displayName || 'user'));
      _watchInviteResponse(guestId, requestId);
    } catch(e) {
      console.error('[CoHost] sendInvite failed:', e.code, e.message);
      _toast('Could not send invite. Try again.');
      if (btn) { btn.textContent = 'Invite'; btn.classList.remove('sent'); btn.disabled = false; }
      delete _pendingInvites[guestId];
    }
  }

  function _watchInviteResponse(guestId, requestId) {
    if (!_db) return;
    _importFS().then(function(fs) {
      var unsub = fs.onSnapshot(fs.doc(_db, 'coHostRequests', requestId), function(snap) {
        if (!snap.exists()) { unsub(); return; }
        var status = snap.data().status;
        if (status === 'accepted') {
          unsub(); _toast('Co-host accepted your invite!');
          if (_activeUnsub) { try { _activeUnsub(); } catch(e){} _activeUnsub = null; }
          _subscribeActiveCohosts();
        } else if (status === 'declined') {
          unsub(); _toast((snap.data().guestName || 'User') + ' declined your invite.');
          delete _pendingInvites[guestId];
          _loadFriendsList();
          // Live list is real-time; invite button state refreshes on next _flushLiveMap call
          setTimeout(function() { try { fs.deleteDoc(fs.doc(_db, 'coHostRequests', requestId)); } catch(e){} }, 3000);
        }
      }, function() { unsub(); });
    });
  }

  function _watchForInvite() {
    if (!_liveDB || !_user) return;
    if (_inviteInboxUnsub) { try { _inviteInboxUnsub(); } catch(e){} _inviteInboxUnsub = null; }
    _importRTDB().then(function(rtdb) {
      var invRef = rtdb.ref(_liveDB, 'coHostInvites/' + _user.uid);
      var listener = rtdb.onValue(invRef, function(snap) {
        if (!snap.exists()) { _hideInviteCard(); return; }
        if (!_coHostEnabled) return;
        var latestInvite = null, latestTs = 0;
        snap.forEach(function(child) {
          var inv = child.val();
          if (inv && inv.ts > latestTs) { latestTs = inv.ts; latestInvite = Object.assign({ senderUid: child.key }, inv); }
        });
        if (!latestInvite) { _hideInviteCard(); return; }
        if (latestInvite.hostUid === _user.uid) return;
        _pendingInviteData = latestInvite; _showInviteCard(latestInvite);
      });
      _inviteInboxUnsub = function() { try { rtdb.off(invRef, listener); } catch(e){} };
    });
  }

  function _showInviteCard(inv) {
    var card = document.getElementById('cohostInviteCard');
    var sub  = document.getElementById('cohostInviteSub');
    var icon = card && card.querySelector('.cohost-invite-icon');
    if (!card) return;
    // Show host avatar if available
    if (icon) {
      var avUrl = inv.hostAvatar || '';
      if (avUrl) {
        icon.innerHTML = '';
        var img = document.createElement('img');
        img.src = avUrl; img.alt = '';
        img.style.cssText = 'width:48px;height:48px;border-radius:50%;object-fit:cover;border:2px solid rgba(160,80,255,0.6);';
        img.onerror = function() { icon.innerHTML = '🎥'; };
        icon.appendChild(img);
      } else {
        icon.textContent = '🎥';
      }
    }
    if (sub) sub.textContent = (inv.hostName || 'Someone') + ' invited you to co-host their live stream.';
    card.classList.add('visible');
  }

  function _hideInviteCard() {
    var card = document.getElementById('cohostInviteCard');
    if (card) card.classList.remove('visible');
  }

  async function _acceptInvite() {
    if (!_pendingInviteData) return;
    var inv = _pendingInviteData; _pendingInviteData = null; _hideInviteCard();
    try {
      var fs = await _importFS(); var rtdb = await _importRTDB();
      var myName = (_userData && _userData.displayName) || (_user && _user.email && _user.email.split('@')[0]) || 'Co-Host';
      var myAvatar = (_userData && (_userData.avatar || _userData.profilePicture)) || '';
      if (inv.requestId) { try { await fs.updateDoc(fs.doc(_db, 'coHostRequests', inv.requestId), { status: 'accepted' }); } catch(e){} }
      var sk = inv.senderUid || inv.hostUid;
      try { await rtdb.remove(rtdb.ref(_liveDB, 'coHostInvites/' + _user.uid + '/' + sk)); } catch(e){}
      if (inv.liveId) {
        await rtdb.set(rtdb.ref(_liveDB, 'cohosts/' + inv.liveId + '/active/' + _user.uid), {
          uid: _user.uid, name: myName, avatar: myAvatar, role: 'cohost', joinedAt: Date.now(),
        });
      }
      _showCohostBadge(); _toast('You joined as co-host!');
      if (inv.liveId && window.location.hash.indexOf(inv.liveId) === -1) {
        window.location.href = 'live.html#watch=' + inv.liveId;
      }
    } catch(e) { console.error('[CoHost] acceptInvite:', e.message); _toast('Could not join. Please try again.'); }
  }

  async function _declineInvite() {
    if (!_pendingInviteData) return;
    var inv = _pendingInviteData; _pendingInviteData = null; _hideInviteCard();
    try {
      var fs = await _importFS(); var rtdb = await _importRTDB();
      if (inv.requestId) { try { await fs.updateDoc(fs.doc(_db, 'coHostRequests', inv.requestId), { status: 'declined' }); } catch(e){} }
      var sk = inv.senderUid || inv.hostUid;
      try { await rtdb.remove(rtdb.ref(_liveDB, 'coHostInvites/' + _user.uid + '/' + sk)); } catch(e){}
    } catch(e) { console.error('[CoHost] declineInvite:', e.message); }
    _toast('Co-host invite declined.');
  }

  function _subscribeActiveCohosts() {
    if (!_liveDB || !_roomId) return;
    if (_activeUnsub) { try { _activeUnsub(); } catch(e){} _activeUnsub = null; }
    _importRTDB().then(function(rtdb) {
      var activeRef = rtdb.ref(_liveDB, 'cohosts/' + _roomId + '/active');
      var listener = rtdb.onValue(activeRef, function(snap) {
        var el = document.getElementById('cohostActiveList');
        if (!el) return;
        if (!snap.exists()) { el.innerHTML = '<div class="cohost-empty">No active co-hosts.</div>'; return; }
        el.innerHTML = '';
        snap.forEach(function(child) {
          var c = child.val(); if (!c) return;
          var row = document.createElement('div'); row.className = 'cohost-active-row';
          var av = document.createElement('div'); av.className = 'cohost-user-avatar';
          if (c.avatar) av.style.backgroundImage = "url('" + _esc(c.avatar) + "')";
          else av.textContent = (c.name || '?')[0].toUpperCase();
          var info = document.createElement('div'); info.style.cssText = 'flex:1;min-width:0;';
          info.innerHTML = '<div class="cohost-active-name">' + _esc(c.name||'Co-Host') + '</div>'
            + '<div class="cohost-active-status" style="font-size:10px;color:#22d470;">Active</div>';
          var rb = document.createElement('button'); rb.className = 'cohost-remove-btn'; rb.textContent = 'Remove';
          (function(uid, name) {
            rb.addEventListener('click', function() {
              try { rtdb.remove(rtdb.ref(_liveDB, 'cohosts/' + _roomId + '/active/' + uid)); } catch(e){}
              try { rtdb.set(rtdb.ref(_liveDB, 'cohosts/' + _roomId + '/removed/' + uid), { ts: Date.now() }); } catch(e){}
              _toast((name||'Co-Host') + ' removed.');
            });
          })(child.key, c.name);
          row.appendChild(av); row.appendChild(info); row.appendChild(rb); el.appendChild(row);
        });
      });
      _activeUnsub = function() { try { rtdb.off(activeRef, listener); } catch(e){} };
    });
  }

  function _subscribeDeclineNotifications() {
    if (!_db || !_roomId || !_user) return;
    if (_hostDeclineUnsub) { try { _hostDeclineUnsub(); } catch(e){} _hostDeclineUnsub = null; }
    _importFS().then(function(fs) {
      var q = fs.query(fs.collection(_db, 'coHostRequests'),
        fs.where('liveId', '==', _roomId), fs.where('hostId', '==', _user.uid), fs.where('status', '==', 'declined'));
      _hostDeclineUnsub = fs.onSnapshot(q, function(snap) {
        snap.docChanges().forEach(function(change) {
          if (change.type === 'added') {
            var d = change.doc.data();
            _toast((d.guestName||'User') + ' declined your co-host invite.');
            delete _pendingInvites[d.guestId];
          }
        });
      }, function() {});
    });
  }

  async function _saveSettings() {
    if (!_liveDB || !_roomId) return;
    try {
      var rtdb = await _importRTDB();
      await rtdb.set(rtdb.ref(_liveDB, 'cohosts/' + _roomId + '/settings'), _cohostSettings);
    } catch(e) {}
  }

  async function _loadSettings() {
    if (!_liveDB || !_roomId) return;
    try {
      var rtdb = await _importRTDB();
      var snap = await rtdb.get(rtdb.ref(_liveDB, 'cohosts/' + _roomId + '/settings'));
      if (snap.exists()) {
        _cohostSettings = Object.assign({}, _cohostSettings, snap.val());
        var t = document.getElementById('toggleAllowCohost');
        if (t) t.checked = _cohostSettings.allowCohosts !== false;
        var s = document.getElementById('selectWhoCanCohost');
        if (s) s.value = _cohostSettings.whoCanCohost || 'everyone';
      }
    } catch(e) {}
  }

  function _showCohostBadge() {
    var badge = document.getElementById('cohostActiveBadge');
    if (!badge) {
      badge = document.createElement('div'); badge.id = 'cohostActiveBadge';
      badge.className = 'cohost-badge-pill';
      badge.style.cssText = 'position:fixed;top:72px;left:50%;transform:translateX(-50%);z-index:8000;';
      badge.textContent = 'CO-HOST'; document.body.appendChild(badge);
    }
    badge.style.display = 'inline-flex';
  }

  function _clearCohostBadge() {
    var badge = document.getElementById('cohostActiveBadge');
    if (badge) badge.style.display = 'none';
  }

  function _cleanup() {
    if (_activeUnsub)      { try { _activeUnsub(); }      catch(e){} _activeUnsub      = null; }
    if (_inviteInboxUnsub) { try { _inviteInboxUnsub(); } catch(e){} _inviteInboxUnsub = null; }
    if (_hostDeclineUnsub) { try { _hostDeclineUnsub(); } catch(e){} _hostDeclineUnsub = null; }
    if (_rtdbLiveUnsub)    { try { _rtdbLiveUnsub(); }    catch(e){} _rtdbLiveUnsub    = null; }
    if (_fsLiveUnsub)      { try { _fsLiveUnsub(); }      catch(e){} _fsLiveUnsub      = null; }
    _liveUserMap = {}; _cachedLiveUsers = [];
    _pendingInvites = {}; _pendingInviteData = null; _hideInviteCard(); _clearCohostBadge();
    if (_liveDB && _roomId && _user) {
      _importRTDB().then(function(rtdb) {
        if (_isHost) { try { rtdb.remove(rtdb.ref(_liveDB, 'cohosts/' + _roomId)); } catch(e){} }
        else {
          try { rtdb.remove(rtdb.ref(_liveDB, 'cohosts/' + _roomId + '/active/' + _user.uid)); } catch(e){}
          try { rtdb.remove(rtdb.ref(_liveDB, 'cohosts/' + _roomId + '/removed/' + _user.uid)); } catch(e){}
        }
        Object.keys(_pendingInvites).forEach(function(gid) {
          try { rtdb.remove(rtdb.ref(_liveDB, 'coHostInvites/' + gid + '/' + _user.uid)); } catch(e){}
        });
      });
    }
    _writePresence('offline');
  }

  function _esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function _toast(msg) {
    if (typeof window.toast === 'function') { window.toast(msg); return; }
    var t = document.getElementById('liveToast');
    if (!t) {
      t = document.createElement('div'); t.id = 'liveToast';
      t.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#fff;padding:10px 18px;border-radius:20px;font-size:13px;z-index:99999;pointer-events:none;transition:opacity .3s;';
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(function() { t.style.opacity = '0'; }, 3200);
  }

})();
