/**
 * Shadow Nexus Live - cohost.js  (v5)
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
 *
 * v5 fixes:
 *  - Friend list: loading spinner, retry-on-failure, per-friend error isolation
 *  - Friend list: checks multiple field names (friends, friendList, friendIds)
 *  - Live Now: real-time RTDB + Firestore listeners that fire immediately
 *  - Live Now: respects whoCanCohost='friends' filter (only shows live friends)
 *  - Live Now: friends who are live appear in both Live Now AND Friends sections
 *  - Live Now: profile picture, username, LIVE badge on every row
 *  - Live Now: search works immediately on each keystroke
 *  - Live Now: invite button sends invite to any listed live user
 *  - Invite card: pop-up notification with Accept / Decline
 *  - Accept invite: automatically triggers guest box request
 *  - Empty list guard: list never shows empty when users are live
 *  - Real-time removal: user disappears the instant their stream ends
 *  - RTDB listeners: always use the unsubscribe fn returned by onValue()
 */

'use strict';

(function () {

  var _db = null, _liveDB = null, _auth = null, _user = null;
  var _userData = null, _roomId = null, _isHost = false;
  var _coHostEnabled = true;
  var _activeUnsub = null, _inviteInboxUnsub = null, _hostDeclineUnsub = null;
  // Real-time live-user listeners — unsubscribe functions returned by onValue / onSnapshot
  var _rtdbLiveUnsub = null;
  var _fsLiveUnsub   = null;
  var _pendingInvites = {}, _panelOpen = false;
  var _cohostSettings = { allowCohosts: true, whoCanCohost: 'everyone' };
  var _pendingInviteData = null;
  var _searchQuery = '', _cachedLiveUsers = [];
  // Merged live-user map: uid → user object (union of RTDB + FS sources)
  var _liveUserMap = {};
  // Set of friend UIDs for the current user (populated lazily when panel opens)
  var _friendUidSet = new Set();
  // Whether a friend-list load is currently in flight
  var _friendsLoading = false;

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
      // Hide guest-box co-host controls (cam/mic/leave shown when co-host is in a box)
      var gCam = document.getElementById('btnGuestCam');
      var gMic = document.getElementById('btnGuestMic');
      var gLeave = document.getElementById('btnLeaveBox');
      if (gCam)   { gCam.style.display   = 'none'; }
      if (gMic)   { gMic.style.display   = 'none'; }
      if (gLeave) { gLeave.style.display = 'none'; }
      // Hide fallback co-host invite overlay (index.html overlay, not managed by cohost.css)
      var overlay = document.getElementById('snxCoHostInviteOverlay');
      if (overlay) overlay.classList.remove('visible');
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
      // Guest-box controls are restored by live.js when the viewer enters a box;
      // we do not force-show them here — we only need to ensure they are not
      // stuck hidden if they were hidden by the feature-disable path above.
      // live.js sets display:flex on these when the user actually joins a box.
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
    panel.innerHTML = '<button class="cohost-popup-close" id="cohostPanelClose" aria-label="Close">\u00d7</button>'
      + '<div class="cohost-popup-title">Co-Host Settings</div>'
      + '<div class="cohost-section-label">Current Co-Hosts</div>'
      + '<div id="cohostActiveList" class="cohost-user-list"><div class="cohost-empty">No active co-hosts.</div></div>'
      + '<hr class="cohost-divider">'
      + '<div class="cohost-section-label">Live Now</div>'
      + '<input type="text" id="cohostLiveSearch" class="cohost-search-input"'
      +   ' placeholder="Search live users\u2026" autocomplete="off" autocorrect="off"'
      +   ' spellcheck="false" style="margin-bottom:8px;width:100%;box-sizing:border-box;display:block;">'
      + '<div id="cohostLiveList" class="cohost-user-list">'
      +   '<div class="cohost-empty cohost-loading-live"'
      +     ' style="display:flex;align-items:center;gap:8px;justify-content:center;">'
      +     '<span class="cohost-spinner"></span>Loading\u2026</div></div>'
      + '<hr class="cohost-divider">'
      + '<div class="cohost-section-label">Friends</div>'
      + '<div id="cohostFriendsList" class="cohost-user-list">'
      +   '<div class="cohost-empty cohost-loading-friends"'
      +     ' style="display:flex;align-items:center;gap:8px;justify-content:center;">'
      +     '<span class="cohost-spinner"></span>Loading friends\u2026</div></div>';
    var vw = document.querySelector('.live-video-wrap');
    (vw || document.body).appendChild(panel);
    // Inject spinner keyframes once
    if (!document.getElementById('cohostSpinnerStyle')) {
      var style = document.createElement('style');
      style.id = 'cohostSpinnerStyle';
      style.textContent =
        '@keyframes cohostSpin{to{transform:rotate(360deg)}}'
        + '.cohost-spinner{'
        +   'display:inline-block;width:12px;height:12px;'
        +   'border:2px solid rgba(160,80,255,0.25);'
        +   'border-top-color:rgba(160,80,255,0.85);'
        +   'border-radius:50%;'
        +   'animation:cohostSpin .75s linear infinite;'
        +   'flex-shrink:0;}';
      document.head.appendChild(style);
    }
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
      +       '<option value="friends">Friends Only</option>'
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
        _cohostSettings.whoCanCohost = e.target.value;
        _saveSettings();
        // Re-render live list with updated filter immediately
        _flushLiveMap();
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

  /* ── RTDB listener: fires within milliseconds of any stream start/end ── */
  function _subscribeRtdbLiveRooms() {
    if (!_liveDB) return;
    if (_rtdbLiveUnsub) { try { _rtdbLiveUnsub(); } catch(e){} _rtdbLiveUnsub = null; }
    _importRTDB().then(function(rtdb) {
      var roomsRef = rtdb.ref(_liveDB, 'liveRooms');
      // onValue() returns an unsubscribe function in Firebase v10 modular SDK
      _rtdbLiveUnsub = rtdb.onValue(roomsRef, function(snap) {
        // Rebuild: keep only FS-sourced entries, then add/refresh RTDB ones
        var newMap = {};
        Object.keys(_liveUserMap).forEach(function(uid) {
          if (_liveUserMap[uid]._src === 'fs') newMap[uid] = _liveUserMap[uid];
        });
        if (snap.exists()) {
          snap.forEach(function(child) {
            var r = child.val();
            if (!r) return;
            // Accept as live if status='live' OR isLive=true (handles both live.js variants)
            if (r.status !== 'live' && !r.isLive) return;
            if (!r.hostId) return;
            if (_user && r.hostId === _user.uid) return; // exclude own stream
            var existing = newMap[r.hostId] || {};
            newMap[r.hostId] = Object.assign({}, existing, {
              uid:         r.hostId,
              displayName: existing.displayName || r.hostName     || 'Someone',
              username:    existing.username    || r.hostUsername || '',
              avatar:      existing.avatar      || r.hostAvatar   || '',
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
        console.warn('[CoHost] RTDB liveRooms error:', err && err.message);
      });
    }).catch(function(e) { console.warn('[CoHost] _subscribeRtdbLiveRooms:', e && e.message); });
  }

  /* ── Firestore listener: users where isLive == true ── */
  function _subscribeFsLiveUsers() {
    if (!_db) return;
    if (_fsLiveUnsub) { try { _fsLiveUnsub(); } catch(e){} _fsLiveUnsub = null; }
    _importFS().then(function(fs) {
      try {
        var q = fs.query(fs.collection(_db, 'users'), fs.where('isLive', '==', true));
        _fsLiveUnsub = fs.onSnapshot(q, function(snap) {
          // Rebuild: keep RTDB-sourced entries, then add/refresh FS ones
          var newMap = {};
          Object.keys(_liveUserMap).forEach(function(uid) {
            if (_liveUserMap[uid]._src !== 'fs') newMap[uid] = _liveUserMap[uid];
          });
          snap.forEach(function(d) {
            if (_user && d.id === _user.uid) return; // exclude self
            var data     = d.data();
            var existing = newMap[d.id] || _liveUserMap[d.id] || {};
            newMap[d.id] = Object.assign({}, existing, {
              uid:         d.id,
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
          console.warn('[CoHost] FS live users error:', err && err.message);
        });
      } catch(e) { console.warn('[CoHost] _subscribeFsLiveUsers:', e && e.message); }
    }).catch(function(e) { console.warn('[CoHost] _subscribeFsLiveUsers import:', e && e.message); });
  }

  /* ── Convert live map -> sorted array, apply friend filter, then render ── */
  function _flushLiveMap() {
    var allLive = Object.keys(_liveUserMap).map(function(uid) { return _liveUserMap[uid]; });
    // If whoCanCohost === 'friends', only show live users who are friends.
    // Skip filter when _friendUidSet is empty (friends not loaded yet).
    if (_cohostSettings.whoCanCohost === 'friends' && _friendUidSet.size > 0) {
      allLive = allLive.filter(function(u) { return _friendUidSet.has(u.uid); });
    }
    // Sort alphabetically by displayName
    allLive.sort(function(a, b) {
      return (a.displayName || '').localeCompare(b.displayName || '');
    });
    _cachedLiveUsers = allLive;
    _renderLiveList(_cachedLiveUsers);
  }

  function _renderLiveList(users) {
    var el = document.getElementById('cohostLiveList');
    if (!el) return;
    // Only render when panel is open; _openPanel() calls _flushLiveMap() explicitly
    if (!_panelOpen) return;
    var q        = _searchQuery;
    var filtered = q ? users.filter(function(u) {
      return (u.displayName || '').toLowerCase().indexOf(q) > -1
          || (u.username    || '').toLowerCase().indexOf(q) > -1;
    }) : users;
    if (!filtered.length) {
      if (q) {
        el.innerHTML = '<div class="cohost-empty">No results for &ldquo;' + _esc(q) + '&rdquo;</div>';
      } else if (_cohostSettings.whoCanCohost === 'friends') {
        el.innerHTML = '<div class="cohost-empty">None of your friends are live right now.</div>';
      } else {
        el.innerHTML = '<div class="cohost-empty">No one is live right now.</div>';
      }
      return;
    }
    el.innerHTML = '';
    filtered.forEach(function(u) { _renderRow(u, el, true); });
  }

  async function _loadFriendsList() {
    var el = document.getElementById('cohostFriendsList');
    if (!el) return;
    if (_friendsLoading) return;
    _friendsLoading = true;

    if (!_db || !_user) {
      el.innerHTML = '<div class="cohost-empty">Not connected.</div>';
      _friendsLoading = false;
      return;
    }

    // Show spinner immediately
    el.innerHTML = '<div class="cohost-empty"'
      + ' style="display:flex;align-items:center;gap:8px;justify-content:center;">'
      + '<span class="cohost-spinner"></span>Loading friends\u2026</div>';

    var attempt = 0;
    while (attempt < 2) {
      attempt++;
      try {
        var fs   = await _importFS();
        var rtdb = await _importRTDB();
        var myDoc = await fs.getDoc(fs.doc(_db, 'users', _user.uid));
        var data  = myDoc.exists() ? myDoc.data() : {};
        // Support multiple possible field names for the friends list
        var friendUids = data.friends || data.friendList || data.friendIds || [];
        if (!Array.isArray(friendUids)) friendUids = [];
        friendUids = friendUids.filter(function(uid) { return uid !== _user.uid; });
        if (!friendUids.length) {
          el.innerHTML = '<div class="cohost-empty">No friends yet.</div>';
          _friendUidSet = new Set();
          _friendsLoading = false;
          _flushLiveMap();
          return;
        }
        // Fetch all friend profiles in parallel; swallow errors on individual docs
        var profileResults = await Promise.allSettled(
          friendUids.map(function(fuid) {
            return fs.getDoc(fs.doc(_db, 'users', fuid)).then(function(fdoc) {
              if (!fdoc.exists()) return null;
              return Object.assign({ uid: fuid }, fdoc.data());
            });
          })
        );

        var friends = [];
        profileResults.forEach(function(result, i) {
          if (result.status === 'fulfilled' && result.value) {
            friends.push(result.value);
          } else {
            // Doc missing or fetch threw — minimal placeholder so list never collapses empty
            friends.push({ uid: friendUids[i], displayName: 'Unknown User', username: '', avatar: '' });
          }
        });

        _friendUidSet = new Set(friends.map(function(f) { return f.uid; }));

        var presSnap = await rtdb.get(rtdb.ref(_liveDB, 'users')).catch(function() { return null; });
        var presMap  = {};
        if (presSnap && presSnap.exists()) {
          presSnap.forEach(function(c) { presMap[c.key] = c.val(); });
        }

        el.innerHTML = '';
        friends.forEach(function(f) {
          var pres     = presMap[f.uid] || {};
          var isLive   = !!(pres.live || _liveUserMap[f.uid] || f.isLive);
          var isOnline = !!(pres.online);
          _renderRow(Object.assign({}, f, { _isOnline: isOnline, _isLive: isLive }), el, isLive);
        });

        _flushLiveMap();
        _friendsLoading = false;
        return;

      } catch(e) {
        console.warn('[CoHost] loadFriendsList attempt ' + attempt + ':', e && e.message);
        if (attempt < 2) {
          await new Promise(function(res) { setTimeout(res, 1500); });
          var elRetry = document.getElementById('cohostFriendsList');
          if (elRetry) {
            elRetry.innerHTML = '<div class="cohost-empty"'
              + ' style="display:flex;align-items:center;gap:8px;justify-content:center;">'
              + '<span class="cohost-spinner"></span>Retrying\u2026</div>';
          }
        } else {
          var elErr = document.getElementById('cohostFriendsList');
          if (elErr) {
            elErr.innerHTML = '<div class="cohost-empty">Couldn\'t load friend list.'
              + ' Tap \uD83C\uDF99\uFE0F to retry.</div>';
          }
          _friendsLoading = false;
        }
      }
    }
  }

  function _renderRow(u, container, isLive) {
    var sent = !!_pendingInvites[u.uid];
    var row  = document.createElement('div'); row.className = 'cohost-user-row';

    // ── Avatar ──
    var av = document.createElement('div'); av.className = 'cohost-user-avatar';
    var avUrl = u.avatar || u.profilePicture || '';
    if (avUrl) {
      var img = document.createElement('img');
      img.src = avUrl; img.alt = '';
      img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover;';
      img.onerror = function() {
        try { av.removeChild(img); } catch(_) {}
        av.textContent = (u.displayName || '?')[0].toUpperCase();
      };
      av.appendChild(img);
    } else {
      av.textContent = (u.displayName || '?')[0].toUpperCase();
    }

    // ── Status dot + label ──
    var dotClass    = 'cohost-status-offline';
    var statusLabel = 'Offline';
    if (isLive || u._isLive || u.isLive) {
      dotClass = 'cohost-status-available'; statusLabel = 'Live Now';
    } else if (u._isOnline) {
      dotClass = 'cohost-status-online'; statusLabel = 'Online';
    }

    // ── LIVE pill ──
    var livePill = (isLive || u._isLive || u.isLive)
      ? '<span style="display:inline-flex;align-items:center;gap:3px;'
        + 'background:rgba(220,0,60,0.22);border:1px solid rgba(255,50,80,0.55);'
        + 'border-radius:6px;padding:1px 6px;font-size:9px;font-weight:800;'
        + 'color:#ff6680;letter-spacing:0.4px;text-transform:uppercase;'
        + 'margin-left:4px;">&#9679; LIVE</span>'
      : '';

    // ── @username ──
    var handleStr = u.username
      ? '<span style="color:#5a4a7a;font-size:10px;margin-left:4px;">@' + _esc(u.username) + '</span>'
      : '';

    // ── Stream title (truncated) ──
    var titleStr = u.liveTitle
      ? '<span style="color:#5a7a9a;font-size:9px;margin-left:4px;">'
        + _esc(String(u.liveTitle).slice(0, 28)) + '</span>'
      : '';

    var info = document.createElement('div'); info.style.cssText = 'flex:1;min-width:0;';
    info.innerHTML =
      '<div class="cohost-user-name" style="display:flex;align-items:center;flex-wrap:wrap;gap:4px;">'
        + _esc(u.displayName || 'Unknown') + livePill
      + '</div>'
      + '<div class="cohost-user-status">'
        + '<span class="cohost-status-dot ' + dotClass + '"></span>'
        + '<span class="cohost-status-label">' + statusLabel + '</span>'
        + handleStr + titleStr
      + '</div>';

    var invBtn = document.createElement('button');
    invBtn.className = 'cohost-invite-btn' + (sent ? ' sent' : '');
    invBtn.textContent = sent ? 'Sent \u2713' : 'Invite';
    invBtn.disabled = sent;
    if (!sent) {
      (function(userArg, btnArg) {
        btnArg.addEventListener('click', function() { _sendInvite(userArg, btnArg); });
      })(u, invBtn);
    }
    row.appendChild(av); row.appendChild(info); row.appendChild(invBtn);
    container.appendChild(row);
  }

  async function _sendInvite(user, btn) {
    if (!_db || !_liveDB || !_user || !_roomId) return;
    if (!_coHostEnabled) { _toast('Co-Hosting is currently unavailable.'); return; }
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
          // Refresh invite button state in both lists
          _flushLiveMap();
          _loadFriendsList();
          setTimeout(function() {
            try { fs.deleteDoc(fs.doc(_db, 'coHostRequests', requestId)); } catch(e) {}
          }, 3000);
        }
      }, function() { unsub(); });
    });
  }

  function _watchForInvite() {
    if (!_liveDB || !_user) return;
    if (_inviteInboxUnsub) { try { _inviteInboxUnsub(); } catch(e){} _inviteInboxUnsub = null; }
    _importRTDB().then(function(rtdb) {
      var invRef = rtdb.ref(_liveDB, 'coHostInvites/' + _user.uid);
      // Store the unsubscribe function returned by onValue()
      _inviteInboxUnsub = rtdb.onValue(invRef, function(snap) {
        if (!snap.exists()) { _hideInviteCard(); return; }
        if (!_coHostEnabled) return;
        var latestInvite = null, latestTs = 0;
        snap.forEach(function(child) {
          var inv = child.val();
          if (inv && inv.ts > latestTs) {
            latestTs = inv.ts;
            latestInvite = Object.assign({ senderUid: child.key }, inv);
          }
        });
        if (!latestInvite) { _hideInviteCard(); return; }
        if (latestInvite.hostUid === _user.uid) return; // guard: no self-invites
        _pendingInviteData = latestInvite;
        _showInviteCard(latestInvite);
      });
    });
  }

  function _showInviteCard(inv) {
    var card = document.getElementById('cohostInviteCard');
    var sub  = document.getElementById('cohostInviteSub');
    var icon = card && card.querySelector('.cohost-invite-icon');
    if (!card) return;
    if (icon) {
      var avUrl = inv.hostAvatar || '';
      if (avUrl) {
        icon.innerHTML = '';
        var img = document.createElement('img');
        img.src = avUrl; img.alt = '';
        img.style.cssText = 'width:48px;height:48px;border-radius:50%;object-fit:cover;'
          + 'border:2px solid rgba(160,80,255,0.6);';
        img.onerror = function() { icon.innerHTML = '\uD83C\uDFA5'; };
        icon.appendChild(img);
      } else {
        icon.textContent = '\uD83C\uDFA5';
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
    if (!_coHostEnabled) { _hideInviteCard(); _pendingInviteData = null; _toast('Co-Hosting is currently unavailable.'); return; }
    var inv = _pendingInviteData; _pendingInviteData = null; _hideInviteCard();
    try {
      var fs   = await _importFS();
      var rtdb = await _importRTDB();
      var myName   = (_userData && _userData.displayName)
                   || (_user && _user.email && _user.email.split('@')[0]) || 'Co-Host';
      var myAvatar = (_userData && (_userData.avatar || _userData.profilePicture)) || '';
      if (inv.requestId) {
        try { await fs.updateDoc(fs.doc(_db, 'coHostRequests', inv.requestId), { status: 'accepted' }); } catch(e) {}
      }
      var sk = inv.senderUid || inv.hostUid;
      try { await rtdb.remove(rtdb.ref(_liveDB, 'coHostInvites/' + _user.uid + '/' + sk)); } catch(e) {}
      if (inv.liveId) {
        await rtdb.set(rtdb.ref(_liveDB, 'cohosts/' + inv.liveId + '/active/' + _user.uid), {
          uid: _user.uid, name: myName, avatar: myAvatar, role: 'cohost', joinedAt: Date.now(),
        });
      }
      _showCohostBadge();
      _toast('You joined as co-host!');
      // Auto-request a guest box so the co-host's video appears on stage.
      // _viewerRequestBox() is exposed on window by live.js.
      if (typeof window._viewerRequestBox === 'function') {
        try { window._viewerRequestBox(); } catch(e) {
          console.warn('[CoHost] Auto guest-box request failed:', e && e.message);
        }
      }
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
      _activeUnsub = rtdb.onValue(activeRef, function(snap) {
        var el = document.getElementById('cohostActiveList');
        if (!el) return;
        if (!snap.exists()) { el.innerHTML = '<div class="cohost-empty">No active co-hosts.</div>'; return; }
        el.innerHTML = '';
        snap.forEach(function(child) {
          var c = child.val(); if (!c) return;
          var row = document.createElement('div'); row.className = 'cohost-active-row';
          var av  = document.createElement('div'); av.className = 'cohost-user-avatar';
          if (c.avatar) {
            var img = document.createElement('img');
            img.src = c.avatar; img.alt = '';
            img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover;';
            img.onerror = function() {
              try { av.removeChild(img); } catch(_) {}
              av.textContent = (c.name || '?')[0].toUpperCase();
            };
            av.appendChild(img);
          } else {
            av.textContent = (c.name || '?')[0].toUpperCase();
          }
          var info = document.createElement('div'); info.style.cssText = 'flex:1;min-width:0;';
          info.innerHTML = '<div class="cohost-active-name">' + _esc(c.name || 'Co-Host') + '</div>'
            + '<div class="cohost-active-status" style="font-size:10px;color:#22d470;">Active</div>';
          var rb = document.createElement('button'); rb.className = 'cohost-remove-btn'; rb.textContent = 'Remove';
          (function(uid, name) {
            rb.addEventListener('click', function() {
              try { rtdb.remove(rtdb.ref(_liveDB, 'cohosts/' + _roomId + '/active/' + uid)); } catch(e) {}
              try { rtdb.set(rtdb.ref(_liveDB, 'cohosts/' + _roomId + '/removed/' + uid), { ts: Date.now() }); } catch(e) {}
              _toast((name || 'Co-Host') + ' removed.');
            });
          })(child.key, c.name);
          row.appendChild(av); row.appendChild(info); row.appendChild(rb);
          el.appendChild(row);
        });
      });
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
    _liveUserMap = {}; _cachedLiveUsers = []; _friendUidSet = new Set();
    _pendingInvites = {}; _pendingInviteData = null;
    _hideInviteCard(); _clearCohostBadge();
    if (_liveDB && _roomId && _user) {
      _importRTDB().then(function(rtdb) {
        if (_isHost) {
          try { rtdb.remove(rtdb.ref(_liveDB, 'cohosts/' + _roomId)); } catch(e) {}
        } else {
          try { rtdb.remove(rtdb.ref(_liveDB, 'cohosts/' + _roomId + '/active/' + _user.uid)); } catch(e) {}
          try { rtdb.remove(rtdb.ref(_liveDB, 'cohosts/' + _roomId + '/removed/' + _user.uid)); } catch(e) {}
        }
        Object.keys(_pendingInvites).forEach(function(gid) {
          try { rtdb.remove(rtdb.ref(_liveDB, 'coHostInvites/' + gid + '/' + _user.uid)); } catch(e) {}
        });
      });
    }
    _writePresence('offline');
  }

  function _esc(s) {
    if (!s) return '';
    return String(s)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }

  function _toast(msg) {
    if (typeof window.toast === 'function') { window.toast(msg); return; }
    var t = document.getElementById('liveToast');
    if (!t) {
      t = document.createElement('div'); t.id = 'liveToast';
      t.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);'
        + 'background:rgba(0,0,0,0.85);color:#fff;padding:10px 18px;border-radius:20px;'
        + 'font-size:13px;z-index:99999;pointer-events:none;transition:opacity .3s;';
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(function() { t.style.opacity = '0'; }, 3200);
  }

})();
