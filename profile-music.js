/* ══════════════════════════════════════════════════════════════
   Shadow Nexus Social — Profile Music System
   Handles: upload, playback, playlists, autoplay, settings,
            external music links (YouTube, Spotify, SoundCloud…)
   ══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────
  const ALLOWED_AUDIO = ['audio/mpeg','audio/mp3','audio/wav','audio/ogg','audio/aac','audio/flac','audio/x-flac','audio/mp4','audio/x-m4a'];
  const ALLOWED_AUDIO_EXT = /\.(mp3|wav|ogg|aac|flac|m4a)$/i;
  const MAX_AUDIO_MB = 200;
  const R2_WORKER_URL = 'https://yellow-term-11e6.nthntjrn.workers.dev';
  const COLL_SONGS     = 'profileMusic';       // /profileMusic/{songId}
  const COLL_PLAYLISTS = 'profilePlaylists';   // /profilePlaylists/{plId}
  // musicSettings stored as a field inside users/{uid}

  // ── State ─────────────────────────────────────────────────────
  const state = {
    profileUid: null,
    isSelf: false,
    songs: [],
    playlists: [],
    activePlId: '__all__',
    currentIdx: -1,
    settings: { enabled: true, autoplay: false, loop: false, repeat: false, repeatOne: false, shuffle: false, showPlayer: true, showPlaylist: true },
    draggingIdx: null,
    autoplayUnlocked: false,
    resumeTime: 0,
    musicLink: null,    // { url, platform, displayChoice }  — loaded from Firestore
  };

  // ── External Music Link — Platform Definitions ─────────────────
  const MUSIC_PLATFORMS = [
    {
      id: 'youtube',
      name: 'YouTube',
      icon: '▶',
      color: '#FF0000',
      match: url => /(?:youtube\.com\/(?:watch|shorts)|youtu\.be\/)/i.test(url),
      embedUrl: (url, autoplay = false) => {
      const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{11})/);
      return m ? `https://www.youtube.com/embed/${m[1]}?autoplay=${autoplay ? 1 : 0}` : null;
    },
      canEmbed: true,
    },
    {
      id: 'youtubemusic',
      name: 'YouTube Music',
      icon: '🎵',
      color: '#FF0000',
      match: url => /music\.youtube\.com/i.test(url),
      embedUrl: (url, autoplay = false) => {
      const m = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
      return m ? `https://www.youtube.com/embed/${m[1]}?autoplay=${autoplay ? 1 : 0}` : null;
    },
      canEmbed: true,
    },
    {
      id: 'spotify',
      name: 'Spotify',
      icon: '🎧',
      color: '#1DB954',
      match: url => /open\.spotify\.com/i.test(url),
      embedUrl: (url, autoplay = false) => {
      // Convert share link to embed link: /track/id, /album/id, /playlist/id
      const m = url.match(/open\.spotify\.com\/(track|album|playlist|episode)\/([A-Za-z0-9]+)/);
      return m ? `https://open.spotify.com/embed/${m[1]}/${m[2]}?utm_source=generator${autoplay ? '&autoplay=1' : ''}` : null;
    },
      canEmbed: true,
    },
    {
      id: 'applemusic',
      name: 'Apple Music',
      icon: '🍎',
      color: '#FA243C',
      match: url => /music\.apple\.com/i.test(url),
      embedUrl: (url, autoplay = false) => {
      // Convert  https://music.apple.com/us/album/... → embed
      const m = url.match(/music\.apple\.com\/([a-z]{2})\/(.+)/);
      if (!m) return null;
      const base = `https://embed.music.apple.com/${m[1]}/${m[2]}`;
      return autoplay ? `${base}${base.includes('?') ? '&' : '?'}autoplay=1` : base;
    },
      canEmbed: true,
    },
    {
      id: 'amazonmusic',
      name: 'Amazon Music',
      icon: '📦',
      color: '#00A8E1',
      match: url => /music\.amazon\./i.test(url),
      embedUrl: () => null,
      canEmbed: false,
    },
    {
      id: 'soundcloud',
      name: 'SoundCloud',
      icon: '☁',
      color: '#FF5500',
      match: url => /soundcloud\.com/i.test(url),
      embedUrl: (url, autoplay = false) => `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&color=%2300AEEF&auto_play=${autoplay ? 'true' : 'false'}&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false`,
      canEmbed: true,
    },
    {
      id: 'deezer',
      name: 'Deezer',
      icon: '🎶',
      color: '#A238FF',
      match: url => /deezer\.com/i.test(url),
      embedUrl: (url, autoplay = false) => {
      const m = url.match(/deezer\.com\/(?:[a-z]+\/)?(track|album|playlist)\/(\d+)/);
      return m ? `https://widget.deezer.com/widget/dark/${m[1]}/${m[2]}${autoplay ? '?autoplay=true' : ''}` : null;
    },
      canEmbed: true,
    },
    {
      id: 'tidal',
      name: 'TIDAL',
      icon: '〰',
      color: '#00FFFF',
      match: url => /tidal\.com/i.test(url),
      embedUrl: (url, autoplay = false) => {
      const m = url.match(/tidal\.com\/(?:browse\/)?(track|album|playlist)\/([^/?#]+)/);
      return m ? `https://embed.tidal.com/${m[1]}s/${m[2]}${autoplay ? '?autoplay=true' : ''}` : null;
    },
      canEmbed: true,
    },
    {
      id: 'audiomack',
      name: 'Audiomack',
      icon: '🔊',
      color: '#FFA500',
      match: url => /audiomack\.com/i.test(url),
      embedUrl: (url, autoplay = false) => {
      // https://audiomack.com/artist/song/slug → https://audiomack.com/embed/artist/song/slug
      const m = url.match(/audiomack\.com\/(.+)/);
      return m ? `https://audiomack.com/embed/${m[1]}${autoplay ? '?autoplay=1' : ''}` : null;
    },
      canEmbed: true,
    },
    {
      id: 'bandcamp',
      name: 'Bandcamp',
      icon: '🎸',
      color: '#1DA0C3',
      match: url => /\.bandcamp\.com/i.test(url),
      embedUrl: () => null,  // Bandcamp doesn't offer a generic oEmbed URL we can auto-build
      canEmbed: false,
    },
  ];

  function detectPlatform(url) {
    if (!url) return null;
    return MUSIC_PLATFORMS.find(p => p.match(url)) || null;
  }

  // Audio element (singleton)
  let _audio = null;
  function getAudio() {
    if (!_audio) {
      _audio = new Audio();
      _audio.preload = 'metadata';
      _audio.addEventListener('timeupdate', onTimeUpdate);
      _audio.addEventListener('ended', onEnded);
      _audio.addEventListener('loadedmetadata', onMetaLoaded);
      _audio.addEventListener('error', () => toNext());
    }
    return _audio;
  }

  // ── Firebase helpers ──────────────────────────────────────────
  // These are set by the Firebase module script in index.html.
  // We read them lazily (at call-time) so we never capture stale undefined.
  function fs() {
    const f = window._snxFirestore;
    if (!f) throw new Error('Firestore not ready. Please wait a moment and try again.');
    return f;
  }
  function db() {
    const d = window._snxDb;
    if (!d) throw new Error('Firestore DB not ready.');
    return d;
  }
  // ── R2 upload via Cloudflare Worker ──────────────────────────────
  async function uploadToR2(r2Key, file, uid, onProgress) {
    const formData = new FormData();
    // We pass the key as 'path' so the worker stores it at that exact key.
    // The worker uses uid for security scoping — match the prefix we set.
    formData.append('file', file, file.name);
    formData.append('uid', uid);
    formData.append('path', r2Key);

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      // Timeout: 5 minutes for large files — prevents infinite hang
      xhr.timeout = 5 * 60 * 1000;
      let lastLoaded = 0;
      let lastTime = Date.now();

      xhr.open('POST', R2_WORKER_URL + '/upload-music');

      xhr.upload.onprogress = e => {
        if (!e.lengthComputable) return;
        const pct = (e.loaded / e.total) * 100;
        // Calculate upload speed (bytes/sec)
        const now = Date.now();
        const elapsed = (now - lastTime) / 1000;
        if (elapsed > 0.5) {
          const bytesPerSec = (e.loaded - lastLoaded) / elapsed;
          lastLoaded = e.loaded;
          lastTime = now;
          if (onProgress) onProgress(pct, bytesPerSec, e.loaded, e.total);
        } else {
          if (onProgress) onProgress(pct, null, e.loaded, e.total);
        }
      };

      xhr.onload = () => {
        let resp;
        try { resp = JSON.parse(xhr.responseText); } catch { resp = {}; }
        if (xhr.status >= 200 && xhr.status < 300 && resp.url && resp.key) {
          resolve({ url: resp.url, key: resp.key });
        } else if (xhr.status === 403) {
          reject(new Error('Permission denied — upload not authorized.'));
        } else if (xhr.status === 415) {
          reject(new Error('File format not supported by the server.'));
        } else if (xhr.status === 413) {
          reject(new Error('File too large (max 200 MB).'));
        } else {
          reject(new Error(resp.error || `Storage upload failed (HTTP ${xhr.status})`));
        }
      };

      xhr.onerror  = () => reject(new Error('Network error — check your connection and try again.'));
      xhr.ontimeout = () => reject(new Error('Upload timed out — the file may be too large or the connection is too slow.'));
      xhr.onabort  = () => reject(new Error('Upload cancelled.'));

      xhr.send(formData);
    });
  }

  // ── R2 delete via Cloudflare Worker ──────────────────────────────
  async function deleteR2File(r2Key) {
    if (!r2Key) return;
    try {
      // Encode each path segment individually so slashes are preserved in the URL
      const encodedKey = r2Key.split('/').map(encodeURIComponent).join('/');
      await fetch(`${R2_WORKER_URL}/${encodedKey}`, { method: 'DELETE' });
    } catch (e) { console.warn('[SNX Music] R2 delete best-effort failed:', e); }
  }

  // ── Firestore ops ─────────────────────────────────────────────
  async function loadSongs(uid) {
    // uid must ALWAYS be the profile owner's UID — never the signed-in visitor's UID.
    if (!uid) {
      console.error('[SNX Music] loadSongs called with empty uid — aborting');
      return [];
    }

    console.log('[SNX Music] loadSongs ── START ─────────────────────────');
    console.log('[SNX Music]   profile UID :', uid);
    console.log('[SNX Music]   signed-in   :', window._snxCurrentUser?.uid ?? '(none)');

    const { collection, query, where, orderBy, getDocs } = fs();

    // Deduplicate by Firestore doc id so three queries don't return duplicates.
    function mergeDedupe(base, extra) {
      const seen = new Set(base.map(s => s.id));
      return [...base, ...extra.filter(s => !seen.has(s.id))];
    }

    // Sort newest-first using the server timestamp; fall back to createdAt string.
    function sortByDate(docs) {
      return docs.sort((a, b) => {
        const ta = a.uploadedAt?.seconds ?? (a.createdAt ? new Date(a.createdAt).getTime() / 1000 : 0);
        const tb = b.uploadedAt?.seconds ?? (b.createdAt ? new Date(b.createdAt).getTime() / 1000 : 0);
        return tb - ta;
      });
    }

    // Run a single-field equality query, falling back to unordered if the
    // composite index is missing.  Returns [] on any permission error so the
    // caller gets a useful console message rather than a thrown exception.
    async function queryByField(field) {
      let docs = [];
      try {
        const q = query(
          collection(db(), COLL_SONGS),
          where(field, '==', uid),
          orderBy('uploadedAt', 'desc')
        );
        const snap = await getDocs(q);
        docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        console.log(`[SNX Music]   ${field} query → ${docs.length} doc(s)`);
      } catch (err) {
        if (
          err.code === 'permission-denied' ||
          (err.message && err.message.includes('PERMISSION_DENIED'))
        ) {
          console.error(
            `[SNX Music]   ${field} query PERMISSION DENIED —`,
            'Firestore rule likely requires isSignedIn(); check auth state.',
            err.message
          );
          return [];
        }
        // Index missing → retry without orderBy
        console.warn(`[SNX Music]   ${field} query index fallback:`, err.message);
        try {
          const q2 = query(collection(db(), COLL_SONGS), where(field, '==', uid));
          const snap2 = await getDocs(q2);
          docs = snap2.docs.map(d => ({ id: d.id, ...d.data() }));
          console.log(`[SNX Music]   ${field} fallback query → ${docs.length} doc(s)`);
        } catch (e2) {
          console.error(`[SNX Music]   ${field} fallback query also failed:`, e2.message);
        }
      }
      return docs;
    }

    // ── Query all three ownership fields so every doc schema is covered ──
    // New uploads write ownerUid + ownerId + userId.
    // Old uploads may only have ownerUid or userId.
    const [byOwnerUid, byOwnerId, byUserId] = await Promise.all([
      queryByField('ownerUid'),   // current primary field
      queryByField('ownerId'),    // spec-canonical field (added in latest schema)
      queryByField('userId'),     // legacy field (older uploads)
    ]);

    let results = mergeDedupe(mergeDedupe(byOwnerUid, byOwnerId), byUserId);
    results = sortByDate(results);

    // ── Diagnostic logging ────────────────────────────────────────────────────
    console.log(`[SNX Music]   total after dedup : ${results.length} song(s) for profile ${uid}`);

    if (results.length === 0) {
      console.warn('[SNX Music] ── ZERO RESULTS — root-cause checklist ──────────────');
      console.warn('[SNX Music]   1. Firestore rules  : open the Rules Playground in Firebase Console');
      console.warn(`[SNX Music]      and simulate a read of profileMusic where ownerUid=="${uid}"`);
      console.warn('[SNX Music]      The rule must pass for isSignedIn() or visibility=="public".');
      console.warn('[SNX Music]   2. Missing ownerId  : run this in the Firebase Console:');
      console.warn(`[SNX Music]      db.collection("profileMusic").where("ownerUid","==","${uid}").get()`);
      console.warn('[SNX Music]      If it returns docs, ownerId was not written. Re-upload a track.');
      console.warn('[SNX Music]   3. Visibility filter: all docs must have visibility:"public".');
      console.warn('[SNX Music]      Docs without the field will be excluded when rules check it.');
      console.warn('[SNX Music]   4. Wrong profile UID: confirm window.activeProfileUid is the');
      console.warn(`[SNX Music]      OWNER\'s UID, not the visitor\'s. Current value: "${uid}"`);
      console.warn('[SNX Music]   5. R2 URL access    : paste a musicUrl into a private browser tab.');
      console.warn('[SNX Music]      A 200 response means R2 is public. A 403 means it is private.');
      console.warn('[SNX Music] ─────────────────────────────────────────────────────────────────');
    } else {
      // Log each document so the URL and visibility can be verified in DevTools.
      results.forEach((s, i) => {
        const url = s.musicUrl || s.downloadURL || s.url || '(missing)';
        const vis = s.visibility ?? '(not set — treated as private by rule check)';
        const owner = s.ownerUid || s.ownerId || s.userId || '(no owner field)';
        console.log(
          `[SNX Music]   [${i}] id=${s.id}  owner=${owner}  visibility=${vis}  url=${url}`
        );
        if (!s.musicUrl && !s.downloadURL && !s.url) {
          console.warn(`[SNX Music]       ↳ doc ${s.id} has NO music URL — track will not play`);
        }
        if (!s.visibility) {
          console.warn(
            `[SNX Music]       ↳ doc ${s.id} missing visibility field —`,
            'Firestore rule may deny reads for unauthenticated viewers'
          );
        }
      });
    }

    console.log('[SNX Music] loadSongs ── END ───────────────────────────────');
    return results;
  }

  async function loadPlaylists(uid) {
    const { collection, query, where, orderBy, getDocs } = fs();
    try {
      const q = query(collection(db(), COLL_PLAYLISTS), where('ownerUid','==', uid), orderBy('createdAt','asc'));
      const snap = await getDocs(q);
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
      console.warn('[SNX Music] loadPlaylists index fallback:', err.message);
      const q2 = query(collection(db(), COLL_PLAYLISTS), where('ownerUid', '==', uid));
      const snap2 = await getDocs(q2);
      return snap2.docs.map(d => ({ id: d.id, ...d.data() }));
    }
  }

  async function loadSettings(uid) {
    const { doc, getDoc } = fs();
    const snap = await getDoc(doc(db(), 'users', uid));
    if (snap.exists()) {
      const d = snap.data();
      // Also load the music link while we're here
      state.musicLink = d.musicLink || null;
      return d.musicSettings || {};
    }
    return {};
  }

  async function saveSettings() {
    if (!state.isSelf) return;
    const { doc, updateDoc } = fs();
    await updateDoc(doc(db(), 'users', state.profileUid), { musicSettings: state.settings }).catch(() => {});
  }

  async function saveMusicLink(linkObj) {
    // linkObj = { url, platform, displayChoice } or null to clear
    if (!state.isSelf) return;
    const { doc, updateDoc } = fs();
    await updateDoc(doc(db(), 'users', state.profileUid), { musicLink: linkObj || null }).catch(() => {});
    state.musicLink = linkObj || null;
  }

  async function addSong(songData) {
    const { collection, addDoc, serverTimestamp } = fs();
    return addDoc(collection(db(), COLL_SONGS), { ...songData, uploadedAt: serverTimestamp() });
  }

  async function deleteSong(songId) {
    const { doc, deleteDoc } = fs();
    await deleteDoc(doc(db(), COLL_SONGS, songId));
  }

  async function updateSong(songId, data) {
    const { doc, updateDoc } = fs();
    await updateDoc(doc(db(), COLL_SONGS, songId), data);
  }

  async function addPlaylist(data) {
    const { collection, addDoc, serverTimestamp } = fs();
    return addDoc(collection(db(), COLL_PLAYLISTS), { ...data, createdAt: serverTimestamp() });
  }

  async function updatePlaylist(plId, data) {
    const { doc, updateDoc } = fs();
    await updateDoc(doc(db(), COLL_PLAYLISTS, plId), data);
  }

  async function deletePlaylist(plId) {
    const { doc, deleteDoc } = fs();
    await deleteDoc(doc(db(), COLL_PLAYLISTS, plId));
  }

  // ── Helpers ────────────────────────────────────────────────────
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2,'0')}`;
  }

  function activeSongs() {
    if (state.activePlId === '__all__') return state.songs;
    const pl = state.playlists.find(p => p.id === state.activePlId);
    if (!pl) return state.songs;
    // maintain playlist order
    return (pl.songIds || []).map(id => state.songs.find(s => s.id === id)).filter(Boolean);
  }

  function toast(msg, type = 'info') {
    if (typeof window.snxToast === 'function') { window.snxToast(msg, type); return; }
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;bottom:70px;left:50%;transform:translateX(-50%);background:#0d2444;border:1px solid rgba(0,174,239,0.4);color:#fff;font-size:13px;padding:10px 18px;border-radius:30px;z-index:99999;pointer-events:none;';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }

  // ── Playback ──────────────────────────────────────────────────
  function loadTrack(idx, autoPlay = false) {
    const list = activeSongs();
    if (!list.length) return;
    const s = list[idx];
    if (!s) return;
    state.currentIdx = idx;
    const a = getAudio();
    const prev = a.src;
    // Prefer the R2 downloadURL; fall back to legacy `url` field for old records
    const streamUrl = s.downloadURL || s.url || '';
    if (!streamUrl) {
      updatePlayerUI(s);
      const titleEl = document.getElementById('snxPlayerTitle');
      if (titleEl) titleEl.textContent = 'File unavailable';
      document.querySelectorAll('.snx-song-item').forEach((el, i) => el.classList.toggle('playing', i === idx));
      return;
    }
    a.src = streamUrl;
    if (state.resumeTime && prev === streamUrl) { a.currentTime = state.resumeTime; state.resumeTime = 0; }
    updatePlayerUI(s);
    if (autoPlay) {
      a.play().then(() => { state.autoplayUnlocked = true; hidePrompt(); }).catch(() => {
        if (!state.autoplayUnlocked) {
          a.muted = true;
          a.play().then(() => showPrompt()).catch(() => {});
        }
      });
    }
    // Highlight active song
    document.querySelectorAll('.snx-song-item').forEach((el, i) => el.classList.toggle('playing', i === idx));
  }

  function togglePlay() {
    const a = getAudio();
    if (!a.src) { loadTrack(0, true); return; }
    if (a.paused) {
      a.play().then(() => { state.autoplayUnlocked = true; hidePrompt(); }).catch(() => {});
    } else {
      a.pause();
    }
    updatePlayBtn();
  }

  function toPrev() {
    const list = activeSongs();
    if (!list.length) return;
    let idx = state.currentIdx - 1;
    if (idx < 0) idx = list.length - 1;
    loadTrack(idx, !getAudio().paused);
  }

  function toNext() {
    const list = activeSongs();
    if (!list.length) return;
    if (state.settings.repeatOne) { getAudio().currentTime = 0; getAudio().play().catch(()=>{}); return; }
    let idx;
    if (state.settings.shuffle) {
      idx = Math.floor(Math.random() * list.length);
    } else {
      idx = state.currentIdx + 1;
      if (idx >= list.length) {
        if (state.settings.loop || state.settings.repeat) idx = 0;
        else { updatePlayBtn(); return; }
      }
    }
    loadTrack(idx, true);
  }

  function onEnded() {
    if (state.settings.repeatOne) { getAudio().currentTime = 0; getAudio().play().catch(()=>{}); }
    else toNext();
  }

  function onTimeUpdate() {
    const a = getAudio();
    const ct = document.getElementById('snxPlayerCurrent');
    const dt = document.getElementById('snxPlayerDuration');
    const fill = document.getElementById('snxPlayerFill');
    if (ct) ct.textContent = fmtTime(a.currentTime);
    if (dt) dt.textContent = fmtTime(a.duration);
    const pct = a.duration ? (a.currentTime / a.duration) * 100 : 0;
    if (fill) fill.style.width = pct + '%';
    updatePlayBtn();
  }

  function onMetaLoaded() {
    const dt = document.getElementById('snxPlayerDuration');
    if (dt) dt.textContent = fmtTime(getAudio().duration);
  }

  function updatePlayBtn() {
    const btn = document.getElementById('snxPlayerPlayBtn');
    if (!btn) return;
    btn.textContent = getAudio().paused ? '▶' : '⏸';
  }

  function updatePlayerUI(song) {
    const art = document.getElementById('snxPlayerArt');
    const title = document.getElementById('snxPlayerTitle');
    const artist = document.getElementById('snxPlayerArtist');
    const album = document.getElementById('snxPlayerAlbum');
    if (art) { art.src = song.artUrl || ''; art.style.display = song.artUrl ? '' : 'none'; }
    if (title) title.textContent = song.title || 'Unknown Track';
    if (artist) artist.textContent = song.artist || '';
    if (album) album.textContent = song.album || '';
    updatePlayBtn();
  }

  // ── Autoplay prompt ───────────────────────────────────────────
  function showPrompt() {
    let el = document.getElementById('snxAutoplayPrompt');
    if (!el) {
      el = document.createElement('div');
      el.id = 'snxAutoplayPrompt';
      el.className = 'snx-autoplay-prompt visible';
      el.textContent = '🎵 Tap to play profile music';
      el.onclick = () => {
        const a = getAudio();
        a.muted = false;
        a.play().then(() => { state.autoplayUnlocked = true; hidePrompt(); }).catch(() => {});
      };
      document.body.appendChild(el);
    } else {
      el.classList.add('visible');
    }
  }

  function hidePrompt() {
    const el = document.getElementById('snxAutoplayPrompt');
    if (el) el.classList.remove('visible');
  }

  // ── Render Music Tab ──────────────────────────────────────────
  function renderMusicTab() {
    const container = document.getElementById('tabContentMusic');
    if (!container) return;

    const isOwner = state.isSelf;
    const vis = state.settings;

    container.innerHTML = `
      ${isOwner ? renderSettingsBlock() : ''}
      ${isOwner ? renderUploadZone() : ''}
      ${isOwner ? renderMusicLinkEditor() : ''}
      ${renderMusicLinkCard()}
      <div id="snxMusicPlayerWrap" style="${vis.showPlayer ? '' : 'display:none'}">
        ${renderPlayer()}
      </div>
      <div id="snxMusicListWrap" style="${vis.showPlaylist ? '' : 'display:none'}">
        ${renderPlaylistTabs()}
        <div id="snxSongListWrap">${renderSongList()}</div>
      </div>
    `;
    attachMusicEvents();
    attachMusicLinkEvents();
  }

  // ── Music Link Editor (owner only) ────────────────────────────
  function renderMusicLinkEditor() {
    const ml = state.musicLink;
    const currentUrl = ml ? ml.url : '';
    const displayChoice = ml ? (ml.displayChoice || 'link') : 'link';
    return `
      <div class="snx-music-link-editor" id="snxMusicLinkEditor">
        <div class="snx-music-link-editor-header" id="snxMusicLinkToggleBtn">
          <span>🔗 Music Link <span class="snx-music-link-optional">(Optional)</span></span>
          <span class="snx-music-link-chevron" id="snxMusicLinkChevron">${ml ? '▾' : '▸'}</span>
        </div>
        <div class="snx-music-link-body" id="snxMusicLinkBody" style="${ml ? '' : 'display:none'}">
          <p class="snx-music-link-hint">Paste a link from YouTube, Spotify, Apple Music, SoundCloud, and more.</p>
          <div class="snx-music-link-input-row">
            <input type="url" id="snxMusicLinkInput" placeholder="https://open.spotify.com/track/…" value="${esc(currentUrl)}">
            <button class="snx-music-link-detect-btn" id="snxMusicLinkDetectBtn">Detect</button>
          </div>
          <div class="snx-music-link-platform-info" id="snxMusicLinkPlatformInfo" style="${currentUrl ? '' : 'display:none'}">
            ${currentUrl ? renderDetectedPlatformBadge(currentUrl) : ''}
          </div>
          <div class="snx-music-link-display-choice" id="snxMusicLinkDisplayChoice" style="${currentUrl ? '' : 'display:none'}">
            <p class="snx-music-link-choice-label">Show on your profile:</p>
            <label class="snx-music-link-radio">
              <input type="radio" name="snxLinkDisplay" value="link" ${displayChoice === 'link' ? 'checked' : ''}>
              <span>Link card (always works)</span>
            </label>
            <label class="snx-music-link-radio">
              <input type="radio" name="snxLinkDisplay" value="embed" ${displayChoice === 'embed' ? 'checked' : ''}>
              <span>Embedded player (if supported)</span>
            </label>
          </div>
          <div class="snx-music-link-editor-btns">
            <button class="snx-music-btn-cancel" id="snxMusicLinkClearBtn" ${!currentUrl ? 'disabled' : ''}>Clear Link</button>
            <button class="snx-music-btn-upload" id="snxMusicLinkSaveBtn">Save Link</button>
          </div>
          <div class="snx-music-link-status" id="snxMusicLinkStatus"></div>
        </div>
      </div>`;
  }

  function renderDetectedPlatformBadge(url) {
    const p = detectPlatform(url);
    if (!p) return `<span class="snx-music-link-unknown">⚠ Platform not recognised — link will be saved as-is.</span>`;
    return `<span class="snx-music-link-badge" style="--plt-color:${p.color}">${p.icon} ${esc(p.name)} detected${p.canEmbed ? ' · embedding supported' : ' · open-in-app only'}</span>`;
  }

  // ── Music Link Display Card (all viewers) ─────────────────────
  function renderMusicLinkCard() {
    const ml = state.musicLink;
    if (!ml || !ml.url) return '';

    const p = detectPlatform(ml.url);
    const choice = ml.displayChoice || 'link';
    const useEmbed = choice === 'embed' && p && p.canEmbed;
    // Owners viewing their own profile never get autoplay
    const autoplay = !state.isSelf && state.settings.autoplay;
    const embedSrc = useEmbed ? p.embedUrl(ml.url, autoplay) : null;

    if (useEmbed && embedSrc) {
      const isYT = p.id === 'youtube' || p.id === 'youtubemusic';
      const isSC = p.id === 'soundcloud';
      const height = isYT ? '200' : isSC ? '120' : '152';
      // data-autoplay lets JS show the tap-to-play prompt if needed
      return `
        <div class="snx-music-link-card snx-music-link-embed-card" id="snxMusicLinkCard">
          <div class="snx-music-link-card-label" style="--plt-color:${p ? p.color : '#00AEEF'}">${p ? p.icon + ' ' + esc(p.name) : '🔗 Music Link'}</div>
          <iframe
            id="snxMusicLinkIframe"
            src="${esc(embedSrc)}"
            width="100%"
            height="${height}"
            frameborder="0"
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
            loading="lazy"
            class="snx-music-link-iframe"
            data-autoplay="${autoplay ? '1' : '0'}"
          ></iframe>
        </div>`;
    }

    // Link card fallback
    const platformName = p ? p.name : 'External Platform';
    const platformIcon = p ? p.icon : '🔗';
    const platformColor = p ? p.color : '#00AEEF';
    return `
      <div class="snx-music-link-card" id="snxMusicLinkCard">
        <div class="snx-music-link-card-label" style="--plt-color:${platformColor}">${platformIcon} ${esc(platformName)}</div>
        <a class="snx-music-link-open-btn" href="${esc(ml.url)}" target="_blank" rel="noopener noreferrer">Open in ${esc(platformName)} ↗</a>
      </div>`;
  }

  function renderSettingsBlock() {
    const s = state.settings;
    const tog = (key, label, indent = false) => `
      <div class="snx-toggle-row${indent ? ' snx-toggle-row--indent' : ''}">
        <span class="snx-toggle-label">${label}</span>
        <label class="snx-toggle">
          <input type="checkbox" data-setting="${key}" ${s[key] ? 'checked' : ''}>
          <span class="snx-toggle-slider"></span>
        </label>
      </div>`;
    return `
      <div class="snx-music-settings">
        <div class="snx-music-settings-title">🎵 Music Settings</div>
        ${tog('enabled', 'Enable Profile Music')}
        <div class="snx-autoplay-settings-group" id="snxAutoplayGroup" style="${s.enabled ? '' : 'display:none'}">
          ${tog('autoplay', 'Autoplay Music <span class="snx-toggle-optional">(Optional)</span>', true)}
          <div class="snx-autoplay-hint" id="snxAutoplayHint" style="${s.autoplay ? '' : 'display:none'}">
            Music will start automatically when visitors open your profile. If the browser blocks autoplay, a Play button will appear instead.
          </div>
        </div>
        ${tog('loop',        'Loop Playlist')}
        ${tog('repeat',      'Repeat')}
        ${tog('repeatOne',   'Repeat One')}
        ${tog('shuffle',     'Shuffle')}
        ${tog('showPlayer',  'Show Music Player')}
        ${tog('showPlaylist','Show Playlist')}
      </div>`;
  }

  function renderUploadZone() {
    return `
      <div class="snx-music-upload-zone" id="snxMusicDropZone">
        <span class="snx-upload-icon">🎵</span>
        <p><span>Click to upload</span> or drag & drop audio files</p>
        <p style="font-size:11px;margin-top:4px;">MP3, WAV, OGG, AAC, FLAC • Max ${MAX_AUDIO_MB}MB</p>
        <input type="file" id="snxMusicFileInput" accept="audio/*" multiple style="display:none">
      </div>
      <div class="snx-music-form" id="snxMusicForm">
        <h4>🎵 Add Track Details</h4>
        <div id="snxMusicFormFields"></div>
        <div class="snx-music-form-progress" id="snxMusicProgress" style="display:none">
          <div class="snx-music-form-progress-bar" id="snxMusicProgressBar" style="width:0%"></div>
        </div>
        <div id="snxMusicUploadStatus" style="font-size:12px;color:#4a9aef;min-height:18px;margin-bottom:6px;"></div>
        <div class="snx-music-form-btns">
          <button class="snx-music-btn-cancel" id="snxMusicCancelBtn">Cancel</button>
          <button class="snx-music-btn-upload" id="snxMusicUploadBtn">Upload All</button>
        </div>
      </div>`;
  }

  function renderPlayer() {
    return `
      <div class="snx-music-player" id="snxMusicPlayer">
        <div class="snx-player-top">
          <img class="snx-player-artwork" id="snxPlayerArt" src="" alt="" style="display:none">
          <div class="snx-player-info">
            <div class="snx-player-title" id="snxPlayerTitle">No track selected</div>
            <div class="snx-player-artist" id="snxPlayerArtist"></div>
            <div class="snx-player-album" id="snxPlayerAlbum"></div>
            <span class="snx-player-now-playing-badge">🎵 Now Playing</span>
          </div>
        </div>
        <div class="snx-player-progress-row">
          <span class="snx-player-time" id="snxPlayerCurrent">0:00</span>
          <div class="snx-player-progress" id="snxPlayerBar">
            <div class="snx-player-progress-fill" id="snxPlayerFill"></div>
          </div>
          <span class="snx-player-time" id="snxPlayerDuration">0:00</span>
        </div>
        <div class="snx-player-controls">
          <button class="snx-ctrl-btn ${state.settings.shuffle ? 'active' : ''}" id="snxShuffleBtn" title="Shuffle">⇄</button>
          <button class="snx-ctrl-btn" id="snxPrevBtn" title="Previous">⏮</button>
          <button class="snx-ctrl-btn snx-ctrl-play" id="snxPlayerPlayBtn" title="Play/Pause">▶</button>
          <button class="snx-ctrl-btn" id="snxNextBtn" title="Next">⏭</button>
          <button class="snx-ctrl-btn ${state.settings.repeatOne ? 'active' : ''}" id="snxRepeatBtn" title="Repeat">↺</button>
        </div>
        <div class="snx-player-volume-row">
          <button class="snx-ctrl-btn" id="snxMuteBtn" title="Mute">🔊</button>
          <input type="range" class="snx-volume-slider" id="snxVolumeSlider" min="0" max="1" step="0.01" value="1">
        </div>
      </div>`;
  }

  function renderPlaylistTabs() {
    const tabs = [{ id: '__all__', name: 'All Songs', count: state.songs.length }, ...state.playlists.map(p => ({ id: p.id, name: p.name, count: (p.songIds || []).length }))];
    let html = `
      <div class="snx-music-section-header">
        <span class="snx-music-section-title">🎶 Queue</span>
        ${state.isSelf ? `<button class="snx-music-section-action" id="snxNewPlaylistBtn">+ New Playlist</button>` : ''}
      </div>
      <div class="snx-playlist-tabs" id="snxPlaylistTabsRow">`;
    tabs.forEach(t => {
      html += `<button class="snx-playlist-tab${t.id === state.activePlId ? ' active' : ''}" data-pl="${t.id}">${esc(t.name)}<span class="snx-pl-count">${t.count}</span></button>`;
    });
    html += `</div>`;
    // Playlist management buttons (rename/delete) — shown for owner when a specific playlist is active
    if (state.isSelf && state.activePlId !== '__all__') {
      html += `
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          <button class="snx-music-section-action" id="snxRenamePlaylistBtn" style="font-size:11px;">✏️ Rename</button>
          <button class="snx-music-section-action" id="snxDeletePlaylistBtn" style="font-size:11px;color:#ff4757;">🗑 Delete Playlist</button>
        </div>`;
    }
    return html;
  }

  function renderSongList() {
    const list = activeSongs();
    if (!list.length) {
      return `<div class="snx-music-empty"><span class="snx-music-empty-icon">🎵</span>${state.isSelf ? 'Upload your first track above.' : 'No music yet.'}</div>`;
    }
    let html = '<ul class="snx-song-list">';
    list.forEach((s, i) => {
      html += `
        <li class="snx-song-item${state.currentIdx === i ? ' playing' : ''}" data-idx="${i}" draggable="${state.isSelf && state.activePlId !== '__all__' ? 'true' : 'false'}">
          ${state.isSelf && state.activePlId !== '__all__' ? '<span class="snx-song-drag-handle">⋮⋮</span>' : ''}
          <img class="snx-song-thumb" src="${esc(s.artUrl || '')}" alt="" style="${s.artUrl ? '' : 'opacity:0.3'}">
          <div class="snx-song-meta">
            <div class="snx-song-name">${esc(s.title || 'Unknown')}</div>
            <div class="snx-song-sub">${esc(s.artist || '')}${s.album ? ' — ' + esc(s.album) : ''}</div>
          </div>
          <span class="snx-song-dur">${s.duration ? fmtTime(s.duration) : ''}</span>
          ${state.isSelf ? `
            <div class="snx-song-actions">
              <button class="snx-song-action-btn" data-action="addtopl" data-id="${s.id}" title="Add to playlist">➕</button>
              ${state.activePlId !== '__all__' ? `<button class="snx-song-action-btn" data-action="removefrompl" data-id="${s.id}" title="Remove from playlist">➖</button>` : ''}
              <button class="snx-song-action-btn danger" data-action="del" data-id="${s.id}" title="Delete">🗑</button>
            </div>` : ''}
        </li>`;
    });
    html += '</ul>';
    return html;
  }

  function esc(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Music Link Event Wiring ───────────────────────────────────
  function attachMusicLinkEvents() {
    const toggleBtn = document.getElementById('snxMusicLinkToggleBtn');
    const body      = document.getElementById('snxMusicLinkBody');
    const chevron   = document.getElementById('snxMusicLinkChevron');
    if (toggleBtn && body) {
      toggleBtn.addEventListener('click', () => {
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : '';
        if (chevron) chevron.textContent = open ? '▸' : '▾';
      });
    }

    const inp        = document.getElementById('snxMusicLinkInput');
    const detectBtn  = document.getElementById('snxMusicLinkDetectBtn');
    const infoArea   = document.getElementById('snxMusicLinkPlatformInfo');
    const choiceArea = document.getElementById('snxMusicLinkDisplayChoice');

    function updateDetection() {
      const url = (inp ? inp.value.trim() : '');
      if (infoArea) {
        infoArea.style.display = url ? '' : 'none';
        infoArea.innerHTML = url ? renderDetectedPlatformBadge(url) : '';
      }
      if (choiceArea) {
        choiceArea.style.display = url ? '' : 'none';
        // Hide embed option for non-embeddable platforms
        const p = detectPlatform(url);
        const embedRadio = choiceArea.querySelector('input[value="embed"]')?.closest('label');
        if (embedRadio) {
          embedRadio.style.opacity = (p && p.canEmbed) ? '1' : '0.4';
          const embedInput = choiceArea.querySelector('input[value="embed"]');
          if (embedInput && p && !p.canEmbed) {
            embedInput.disabled = true;
            // Switch to link if embed was selected but platform can't embed
            const linkInput = choiceArea.querySelector('input[value="link"]');
            if (linkInput) linkInput.checked = true;
          } else if (embedInput) {
            embedInput.disabled = false;
          }
        }
      }
      const clearBtn = document.getElementById('snxMusicLinkClearBtn');
      if (clearBtn) clearBtn.disabled = !url;
    }

    if (inp) inp.addEventListener('input', updateDetection);
    if (detectBtn) detectBtn.addEventListener('click', updateDetection);

    const saveBtn = document.getElementById('snxMusicLinkSaveBtn');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const url = inp ? inp.value.trim() : '';
        const statusEl = document.getElementById('snxMusicLinkStatus');
        const choiceEl = document.querySelector('input[name="snxLinkDisplay"]:checked');
        const displayChoice = choiceEl ? choiceEl.value : 'link';

        if (statusEl) statusEl.textContent = 'Saving…';
        try {
          if (url) {
            // Security: only accept URLs from approved platforms or well-formed https links
            let parsedUrl;
            try { parsedUrl = new URL(url); } catch { throw new Error('Invalid URL — please enter a valid link.'); }
            if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
              throw new Error('Only http/https links are allowed.');
            }
            const p = detectPlatform(url);
            if (!p) {
              // Unknown platform — warn but allow (link-only, no embed)
              console.warn('[SNX Music] Saving link from unrecognised platform:', url);
            }
            await saveMusicLink({ url, platform: p ? p.id : 'unknown', displayChoice });
            if (statusEl) { statusEl.style.color = '#00AEEF'; statusEl.textContent = '✓ Link saved!'; }
          } else {
            await saveMusicLink(null);
            if (statusEl) { statusEl.style.color = '#00AEEF'; statusEl.textContent = '✓ Link cleared.'; }
          }
          // Refresh only the card area without a full re-render
          const card = document.getElementById('snxMusicLinkCard');
          const cardHtml = renderMusicLinkCard();
          if (card) {
            card.outerHTML = cardHtml;
          } else {
            // Insert card before the player wrap
            const playerWrap = document.getElementById('snxMusicPlayerWrap');
            if (playerWrap && cardHtml) {
              playerWrap.insertAdjacentHTML('beforebegin', cardHtml);
            }
          }
        } catch (e) {
          if (statusEl) { statusEl.style.color = '#ff4757'; statusEl.textContent = 'Error: ' + (e.message || e); }
        }
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
      });
    }

    const clearBtn = document.getElementById('snxMusicLinkClearBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        if (inp) inp.value = '';
        updateDetection();
        const statusEl = document.getElementById('snxMusicLinkStatus');
        try {
          await saveMusicLink(null);
          if (statusEl) { statusEl.style.color = '#00AEEF'; statusEl.textContent = '✓ Link cleared.'; }
          // Remove card from DOM
          const card = document.getElementById('snxMusicLinkCard');
          if (card) card.remove();
        } catch (e) {
          if (statusEl) { statusEl.style.color = '#ff4757'; statusEl.textContent = 'Error: ' + (e.message || e); }
        }
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
      });
    }
  }

  // ── Event Wiring ──────────────────────────────────────────────
  function attachMusicEvents() {
    // Settings toggles
    document.querySelectorAll('.snx-toggle input[data-setting]').forEach(inp => {
      inp.addEventListener('change', async () => {
        const key = inp.dataset.setting;
        state.settings[key] = inp.checked;
        await saveSettings();
        if (key === 'enabled') {
          const g = document.getElementById('snxAutoplayGroup');
          if (g) g.style.display = inp.checked ? '' : 'none';
          // Stop playback immediately when music is disabled
          if (!inp.checked) {
            if (_audio && !_audio.paused) { _audio.pause(); updatePlayBtn(); }
            const iframe = document.getElementById('snxMusicLinkIframe');
            if (iframe) iframe.src = '';
            hidePrompt();
          }
        }
        if (key === 'autoplay') {
          const h = document.getElementById('snxAutoplayHint');
          if (h) h.style.display = inp.checked ? '' : 'none';
        }
        if (key === 'showPlayer') { const w = document.getElementById('snxMusicPlayerWrap'); if (w) w.style.display = inp.checked ? '' : 'none'; }
        if (key === 'showPlaylist') { const w = document.getElementById('snxMusicListWrap'); if (w) w.style.display = inp.checked ? '' : 'none'; }
        if (key === 'shuffle') { const b = document.getElementById('snxShuffleBtn'); if (b) b.classList.toggle('active', inp.checked); }
      });
    });

    // Upload zone
    const zone = document.getElementById('snxMusicDropZone');
    const fileInp = document.getElementById('snxMusicFileInput');
    if (zone && fileInp) {
      zone.onclick = () => fileInp.click();
      ['dragover','dragenter'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('drag-over'); }));
      ['dragleave','drop'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('drag-over'); }));
      zone.addEventListener('drop', e => handleFiles(Array.from(e.dataTransfer.files)));
      fileInp.addEventListener('change', () => handleFiles(Array.from(fileInp.files)));
    }

    const cancelBtn = document.getElementById('snxMusicCancelBtn');
    if (cancelBtn) cancelBtn.onclick = () => {
      document.getElementById('snxMusicForm').classList.remove('open');
      _pendingFiles = [];
    };

    const uploadBtn = document.getElementById('snxMusicUploadBtn');
    if (uploadBtn) uploadBtn.onclick = () => submitUploads();

    // Player controls
    const playBtn = document.getElementById('snxPlayerPlayBtn');
    if (playBtn) playBtn.onclick = togglePlay;
    const prevBtn = document.getElementById('snxPrevBtn');
    if (prevBtn) prevBtn.onclick = toPrev;
    const nextBtn = document.getElementById('snxNextBtn');
    if (nextBtn) nextBtn.onclick = toNext;
    const bar = document.getElementById('snxPlayerBar');
    if (bar) bar.addEventListener('click', e => {
      const a = getAudio();
      if (!a.duration) return;
      const rect = bar.getBoundingClientRect();
      a.currentTime = ((e.clientX - rect.left) / rect.width) * a.duration;
    });
    const vol = document.getElementById('snxVolumeSlider');
    if (vol) { vol.value = getAudio().volume; vol.oninput = () => { getAudio().volume = parseFloat(vol.value); updateMuteBtn(); }; }
    const muteBtn = document.getElementById('snxMuteBtn');
    if (muteBtn) muteBtn.onclick = () => { const a = getAudio(); a.muted = !a.muted; updateMuteBtn(); };
    const shuffleBtn = document.getElementById('snxShuffleBtn');
    if (shuffleBtn) shuffleBtn.onclick = () => { state.settings.shuffle = !state.settings.shuffle; shuffleBtn.classList.toggle('active', state.settings.shuffle); saveSettings(); };
    const repeatBtn = document.getElementById('snxRepeatBtn');
    if (repeatBtn) repeatBtn.onclick = () => { state.settings.repeatOne = !state.settings.repeatOne; repeatBtn.classList.toggle('active', state.settings.repeatOne); saveSettings(); };

    // Playlist tabs
    document.getElementById('snxPlaylistTabsRow')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-pl]');
      if (!btn) return;
      state.activePlId = btn.dataset.pl;
      state.currentIdx = -1;
      document.querySelectorAll('.snx-playlist-tab').forEach(b => b.classList.toggle('active', b.dataset.pl === state.activePlId));
      // Re-render playlist header (for rename/delete buttons) and song list
      const listWrap = document.getElementById('snxMusicListWrap');
      if (listWrap) {
        listWrap.innerHTML = `
          ${renderPlaylistTabs()}
          <div id="snxSongListWrap">${renderSongList()}</div>
        `;
        attachMusicEvents(); // re-attach since we replaced the whole list wrap
        return;
      }
      document.getElementById('snxSongListWrap').innerHTML = renderSongList();
      attachSongListEvents();
    });

    // New playlist btn
    document.getElementById('snxNewPlaylistBtn')?.addEventListener('click', () => promptNewPlaylist());

    // Rename playlist
    document.getElementById('snxRenamePlaylistBtn')?.addEventListener('click', () => promptRenamePlaylist());

    // Delete playlist
    document.getElementById('snxDeletePlaylistBtn')?.addEventListener('click', () => promptDeletePlaylist());

    attachSongListEvents();
  }

  function updateMuteBtn() {
    const a = getAudio();
    const btn = document.getElementById('snxMuteBtn');
    if (btn) btn.textContent = (a.muted || a.volume === 0) ? '🔇' : '🔊';
  }

  function attachSongListEvents() {
    // Song click to play
    document.querySelectorAll('.snx-song-item').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('.snx-song-actions') || e.target.closest('.snx-song-drag-handle')) return;
        const idx = parseInt(el.dataset.idx, 10);
        if (idx === state.currentIdx && !getAudio().paused) { getAudio().pause(); updatePlayBtn(); return; }
        loadTrack(idx, true);
      });
    });
    // Song action buttons
    document.querySelectorAll('.snx-song-action-btn[data-action]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const { action, id } = btn.dataset;
        if (action === 'del') confirmDeleteSong(id);
        if (action === 'addtopl') promptAddToPlaylist(id);
        if (action === 'removefrompl') removeFromPlaylist(id);
      });
    });
    // Drag-and-drop reorder (playlist only)
    if (state.activePlId !== '__all__') {
      let dragIdx = null;
      document.querySelectorAll('.snx-song-item[draggable="true"]').forEach(el => {
        el.addEventListener('dragstart', () => { dragIdx = parseInt(el.dataset.idx, 10); el.classList.add('dragging'); });
        el.addEventListener('dragend', () => el.classList.remove('dragging'));
        el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag-over'); });
        el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
        el.addEventListener('drop', async () => {
          el.classList.remove('drag-over');
          const dropIdx = parseInt(el.dataset.idx, 10);
          if (dragIdx === null || dragIdx === dropIdx) return;
          const pl = state.playlists.find(p => p.id === state.activePlId);
          if (!pl) return;
          const ids = [...(pl.songIds || [])];
          const [moved] = ids.splice(dragIdx, 1);
          ids.splice(dropIdx, 0, moved);
          pl.songIds = ids;
          document.getElementById('snxSongListWrap').innerHTML = renderSongList();
          attachSongListEvents();
          await updatePlaylist(pl.id, { songIds: ids }).catch(() => {});
        });
      });
    }
  }

  // ── File Handling ─────────────────────────────────────────────
  let _pendingFiles = [];

  function handleFiles(files) {
    const valid = files.filter(f => ALLOWED_AUDIO.includes(f.type) || ALLOWED_AUDIO_EXT.test(f.name));
    if (!valid.length) { toast('No valid audio files selected.', 'error'); return; }
    _pendingFiles = valid.filter(f => f.size <= MAX_AUDIO_MB * 1024 * 1024);
    if (_pendingFiles.length < valid.length) toast(`Some files exceeded ${MAX_AUDIO_MB}MB and were skipped.`);
    if (!_pendingFiles.length) return;
    buildFormFields();
    document.getElementById('snxMusicForm').classList.add('open');
  }

  function buildFormFields() {
    const wrap = document.getElementById('snxMusicFormFields');
    if (!wrap) return;
    wrap.innerHTML = '';
    _pendingFiles.forEach((f, i) => {
      const name = f.name.replace(ALLOWED_AUDIO_EXT, '').replace(/[-_]/g,' ');
      wrap.innerHTML += `
        <div style="border-bottom:1px solid #1a3a5c;padding-bottom:12px;margin-bottom:12px;">
          <div style="font-size:11px;color:#4a6a8a;margin-bottom:8px;">📄 ${esc(f.name)}</div>
          <div class="snx-music-form-row">
            <div><label>Song Title</label><input data-fi="${i}" data-field="title" value="${esc(name)}"></div>
            <div><label>Artist</label><input data-fi="${i}" data-field="artist" placeholder="Artist name"></div>
          </div>
          <div class="snx-music-form-row">
            <div><label>Album</label><input data-fi="${i}" data-field="album" placeholder="Album name"></div>
            <div><label>Genre</label><input data-fi="${i}" data-field="genre" placeholder="Genre"></div>
          </div>
          <div class="snx-music-form-row">
            <div><label>Year</label><input data-fi="${i}" data-field="year" placeholder="2024" type="number"></div>
            <div><label>Album Artwork</label><input type="file" id="snxArtFile_${i}" accept="image/*" style="font-size:11px;color:#6a90b8;"></div>
          </div>
          <div class="snx-music-form-row full">
            <div><label>Description</label><textarea data-fi="${i}" data-field="desc" placeholder="Describe the song…" rows="2"></textarea></div>
          </div>
        </div>`;
    });
  }

  function setUploadStatus(msg, speed) {
    const el = document.getElementById('snxMusicUploadStatus');
    if (!el) return;
    if (speed != null && speed > 0) {
      let speedStr;
      if (speed >= 1024 * 1024) speedStr = (speed / (1024 * 1024)).toFixed(1) + ' MB/s';
      else if (speed >= 1024) speedStr = (speed / 1024).toFixed(0) + ' KB/s';
      else speedStr = speed.toFixed(0) + ' B/s';
      el.textContent = msg + '  (' + speedStr + ')';
    } else {
      el.textContent = msg;
    }
  }

  async function submitUploads() {
    if (!state.profileUid) { toast('Not logged in.', 'error'); return; }
    if (!_pendingFiles.length) { toast('No files selected.', 'error'); return; }

    // Validate all files before starting
    for (const f of _pendingFiles) {
      if (!ALLOWED_AUDIO.includes(f.type) && !ALLOWED_AUDIO_EXT.test(f.name)) {
        toast(`File format not supported: ${f.name}`, 'error');
        return;
      }
      if (f.size > MAX_AUDIO_MB * 1024 * 1024) {
        toast(`File too large (max ${MAX_AUDIO_MB} MB): ${f.name}`, 'error');
        return;
      }
    }

    // Verify Firebase is ready before doing anything
    try { fs(); db(); } catch (e) {
      toast('Database not ready. Please wait a moment and try again.', 'error');
      console.error('[SNX Music] Firebase not ready:', e);
      return;
    }

    const btn = document.getElementById('snxMusicUploadBtn');
    const cancelBtn = document.getElementById('snxMusicCancelBtn');
    const progressWrap = document.getElementById('snxMusicProgress');
    const progressBar = document.getElementById('snxMusicProgressBar');

    // Lock UI — prevent double-submit and cancel during upload
    if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
    if (cancelBtn) cancelBtn.disabled = true;
    if (progressWrap) progressWrap.style.display = 'block';
    if (progressBar) progressBar.style.width = '0%';
    setUploadStatus('Starting upload…');

    const formEl = document.getElementById('snxMusicFormFields');
    const uid = state.profileUid;
    const results = [];
    const total = _pendingFiles.length;
    let firstSuccessId = null;

    for (let i = 0; i < total; i++) {
      const f = _pendingFiles[i];

      // Collect text fields — skip file inputs (type="file")
      const fields = {};
      if (formEl) {
        formEl.querySelectorAll(`[data-fi="${i}"][data-field]`).forEach(el => {
          if (el.type !== 'file') fields[el.dataset.field] = el.value || '';
        });
        const artInput = document.getElementById(`snxArtFile_${i}`);
        if (artInput && artInput.files[0]) fields.artFile = artInput.files[0];
      }

      try {
        // Step 1: Build R2 key
        const safeFileName = f.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const timestamp = Date.now();
        const r2Key = `profiles/${uid}/music/${timestamp}_${safeFileName}`;

        // Step 2: Upload audio to Cloudflare R2
        setUploadStatus(`Uploading track ${i + 1} of ${total}: ${f.name}…`);
        const { url: audioUrl, key: audioR2Key } = await uploadToR2(r2Key, f, uid, (pct, speed) => {
          const overall = ((i / total) + (pct / 100 / total)) * 100;
          if (progressBar) progressBar.style.width = Math.round(overall) + '%';
          setUploadStatus(
            `Uploading track ${i + 1} of ${total} — ${Math.round(pct)}%`,
            speed
          );
        });

        // Step 3: Upload artwork to R2 if provided
        let artUrl = '';
        let artR2Key = '';
        if (fields.artFile instanceof File) {
          setUploadStatus(`Uploading artwork for track ${i + 1}…`);
          const artSafeFile = fields.artFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const artKey = `profiles/${uid}/music/art_${timestamp}_${artSafeFile}`;
          await uploadToR2(artKey, fields.artFile, uid, () => {})
            .then(r => { artUrl = r.url; artR2Key = r.key; })
            .catch(e => { console.warn('[SNX Music] Artwork upload failed:', e); });
        }

        // Step 4: Read audio duration (10s timeout so it never hangs)
        setUploadStatus(`Reading track ${i + 1} metadata…`);
        const dur = await Promise.race([
          getAudioDuration(f),
          new Promise(res => setTimeout(() => res(0), 10000)),
        ]).catch(() => 0);

        // Step 5: Save to Firestore (only after R2 upload confirmed)
        setUploadStatus(`Saving track ${i + 1} to your library…`);
        const now = new Date().toISOString();
        const songRef = await addSong({
          // ownership — queried by ownerUid; ownerId is an alias for spec compliance
          ownerUid:    uid,
          ownerId:     uid,
          userId:      uid,
          // track metadata
          title:       fields.title  || f.name,
          artist:      fields.artist || '',
          album:       fields.album  || '',
          genre:       fields.genre  || '',
          year:        fields.year   || '',
          description: fields.desc   || '',
          fileName:    f.name,
          fileSize:    f.size,
          duration:    dur,
          // audio file
          r2Key:       audioR2Key,
          downloadURL: audioUrl,
          musicUrl:    audioUrl,   // spec-required alias for downloadURL
          url:         audioUrl,
          // artwork
          artR2Key:    artR2Key,
          artworkURL:  artUrl,
          artUrl:      artUrl,
          coverImage:  artUrl,     // spec-required alias for artUrl
          // visibility — always public so any signed-in user can read it
          visibility:  'public',
          isPublic:    true,
          createdAt:   now,
          updatedAt:   now,
        });

        console.log('[SNX Music] Saved song to R2 + Firebase:', songRef.id, { r2Key: audioR2Key, url: audioUrl });

        // ── Also write to /mediaFiles so all uploads have a centralised metadata record ──
        try {
          const { collection: _col, addDoc: _add, serverTimestamp: _sts } = fs();
          _add(_col(db(), 'mediaFiles'), {
            ownerUid:   uid,
            fileName:   f.name,
            fileType:   f.type || 'audio/mpeg',
            fileSize:   f.size,
            uploadedAt: _sts(),
            r2Key:      audioR2Key,
            url:        audioUrl,
            mediaKind:  'music',
            postId:     '',
            messageId:  '',
            storyId:    '',
            visibility: 'public',
          }).catch(e => console.warn('[SNX Music] mediaFiles write failed (non-fatal):', e.message));
        } catch (_) {}

        if (!firstSuccessId) firstSuccessId = songRef.id;
        results.push({ ok: true, id: songRef.id, url: audioUrl, title: fields.title || f.name, artist: fields.artist || '', artUrl });

      } catch (err) {
        console.error(`[SNX Music] Upload step failed for "${f.name}":`, err);
        // Identify the failed step from the error message
        let errMsg = err.message || String(err);
        if (errMsg.includes('Permission denied') || errMsg.includes('permission')) errMsg = 'Permission denied — check your account.';
        else if (errMsg.includes('Network error') || errMsg.includes('network')) errMsg = 'Network error — check your connection.';
        else if (errMsg.includes('Database save') || errMsg.includes('Firestore') || errMsg.includes('PERMISSION_DENIED')) errMsg = 'Database save failed — ' + errMsg;
        results.push({ ok: false, name: f.name, err: errMsg });
      }
    }

    // ── Reset UI state (always runs, even if upload failed) ──
    if (btn) { btn.disabled = false; btn.textContent = 'Upload All'; }
    if (cancelBtn) cancelBtn.disabled = false;
    if (progressBar) progressBar.style.width = '100%';
    setTimeout(() => {
      if (progressWrap) progressWrap.style.display = 'none';
      if (progressBar) progressBar.style.width = '0%';
    }, 600);
    setUploadStatus('');

    const form = document.getElementById('snxMusicForm');
    if (form) form.classList.remove('open');
    _pendingFiles = [];

    const fileInp = document.getElementById('snxMusicFileInput');
    if (fileInp) fileInp.value = '';

    // ── Show result toast ──
    const failed = results.filter(r => !r.ok);
    if (!results.length) {
      toast('No files were uploaded.', 'error');
    } else if (failed.length && results.length === failed.length) {
      toast(`Upload failed: ${failed[0].err}`, 'error');
    } else if (failed.length) {
      toast(`${results.length - failed.length} track${results.length - failed.length > 1 ? 's' : ''} uploaded. ${failed.length} failed: ${failed[0].err}`, 'error');
    } else {
      toast(`🎵 ${results.length} track${results.length > 1 ? 's' : ''} uploaded successfully!`);
    }

    // ── Refresh music library and auto-load first new track ──
    await reload();
    if (firstSuccessId) {
      // Find the newly uploaded song in the refreshed list and load it
      const newIdx = state.songs.findIndex(s => s.id === firstSuccessId);
      if (newIdx >= 0) loadTrack(newIdx, false);
    }
  }

  function getAudioDuration(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const a = new Audio(url);
      a.addEventListener('loadedmetadata', () => { URL.revokeObjectURL(url); resolve(a.duration); });
      a.addEventListener('error', err => { URL.revokeObjectURL(url); reject(err); });
    });
  }

  // ── Delete Song ───────────────────────────────────────────────
  async function confirmDeleteSong(songId) {
    if (!confirm('Delete this track? This cannot be undone.')) return;
    const song = state.songs.find(s => s.id === songId);
    if (song) {
      // Delete R2 files using stored keys (best-effort — don't block on failure)
      if (song.r2Key)   await deleteR2File(song.r2Key);
      if (song.artR2Key) await deleteR2File(song.artR2Key);
    }
    try {
      await deleteSong(songId);
    } catch (e) {
      toast('Failed to delete track: ' + (e.message || e), 'error');
      console.error('[SNX Music] deleteSong error:', e);
      return;
    }
    // Remove from playlists
    for (const pl of state.playlists) {
      const ids = (pl.songIds || []).filter(id => id !== songId);
      if (ids.length !== (pl.songIds || []).length) await updatePlaylist(pl.id, { songIds: ids }).catch(() => {});
    }
    toast('Track deleted.');
    await reload();
  }

  // ── Playlist Management ───────────────────────────────────────
  async function promptNewPlaylist() {
    const name = prompt('Playlist name:');
    if (!name || !name.trim()) return;
    try {
      const ref = await addPlaylist({ ownerUid: state.profileUid, name: name.trim(), songIds: [] });
      toast(`Playlist "${name.trim()}" created!`);
      await reload();
      state.activePlId = ref.id;
      renderMusicTab();
    } catch (e) {
      toast('Failed to create playlist: ' + (e.message || e), 'error');
      console.error('[SNX Music] addPlaylist error:', e);
    }
  }

  async function promptRenamePlaylist() {
    const pl = state.playlists.find(p => p.id === state.activePlId);
    if (!pl) return;
    const name = prompt('New name:', pl.name);
    if (!name || !name.trim() || name.trim() === pl.name) return;
    try {
      await updatePlaylist(pl.id, { name: name.trim() });
      pl.name = name.trim();
      toast(`Renamed to "${name.trim()}"`);
      await reload();
      renderMusicTab();
    } catch (e) {
      toast('Failed to rename: ' + (e.message || e), 'error');
      console.error('[SNX Music] renamePlaylist error:', e);
    }
  }

  async function promptDeletePlaylist() {
    const pl = state.playlists.find(p => p.id === state.activePlId);
    if (!pl) return;
    if (!confirm(`Delete playlist "${pl.name}"? Songs will not be deleted.`)) return;
    try {
      await deletePlaylist(pl.id);
      state.activePlId = '__all__';
      toast(`Playlist "${pl.name}" deleted.`);
      await reload();
      renderMusicTab();
    } catch (e) {
      toast('Failed to delete playlist: ' + (e.message || e), 'error');
      console.error('[SNX Music] deletePlaylist error:', e);
    }
  }

  async function promptAddToPlaylist(songId) {
    if (!state.playlists.length) { toast('Create a playlist first.'); return; }
    const names = state.playlists.map((p,i) => `${i+1}. ${p.name}`).join('\n');
    const idx = parseInt(prompt(`Add to playlist:\n${names}\n\nEnter number:`), 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= state.playlists.length) return;
    const pl = state.playlists[idx];
    const ids = [...new Set([...(pl.songIds || []), songId])];
    pl.songIds = ids;
    try {
      await updatePlaylist(pl.id, { songIds: ids });
      toast(`Added to "${pl.name}"!`);
    } catch (e) {
      toast('Failed to update playlist: ' + (e.message || e), 'error');
      console.error('[SNX Music] addToPlaylist error:', e);
      return;
    }
    document.getElementById('snxSongListWrap').innerHTML = renderSongList();
    attachSongListEvents();
  }

  async function removeFromPlaylist(songId) {
    const pl = state.playlists.find(p => p.id === state.activePlId);
    if (!pl) return;
    const ids = (pl.songIds || []).filter(id => id !== songId);
    pl.songIds = ids;
    try {
      await updatePlaylist(pl.id, { songIds: ids });
      toast(`Removed from "${pl.name}".`);
    } catch (e) {
      toast('Failed to update playlist: ' + (e.message || e), 'error');
      console.error('[SNX Music] removeFromPlaylist error:', e);
      return;
    }
    document.getElementById('snxSongListWrap').innerHTML = renderSongList();
    attachSongListEvents();
  }

  // ── Reload ────────────────────────────────────────────────────
  async function reload() {
    const uid = state.profileUid;
    if (!uid) return;
    try {
      state.songs     = await loadSongs(uid);
      state.playlists = await loadPlaylists(uid);
    } catch (e) {
      console.error('[SNX Music] reload error:', e);
      toast('Failed to refresh music library: ' + (e.message || e), 'error');
      return;
    }
    renderMusicTab();
    // Restore player highlight if audio was playing
    if (!getAudio().paused && state.currentIdx >= 0) {
      document.querySelectorAll('.snx-song-item').forEach((el, i) => el.classList.toggle('playing', i === state.currentIdx));
    }
  }

  // ── Public API ────────────────────────────────────────────────
  async function initMusicTab(uid, isSelf) {
    state.profileUid = uid;
    state.isSelf = isSelf;
    state.currentIdx = -1;
    state.activePlId = '__all__';
    state.autoplayUnlocked = false;

    // Load settings
    let savedSettings = {};
    try {
      savedSettings = await loadSettings(uid);
    } catch (e) {
      console.warn('[SNX Music] loadSettings failed:', e);
    }
    state.settings = Object.assign(
      { enabled: true, autoplay: false, loop: false, repeat: false, repeatOne: false, shuffle: false, showPlayer: true, showPlaylist: true },
      savedSettings
    );
    // state.musicLink is already populated by loadSettings()

    if (!state.settings.enabled && !isSelf) {
      const c = document.getElementById('tabContentMusic');
      if (c) c.innerHTML = '<div class="snx-music-empty"><span class="snx-music-empty-icon">🎵</span>Music is disabled on this profile.</div>';
      return;
    }

    // Load songs and playlists
    try {
      state.songs     = await loadSongs(uid);
      state.playlists = await loadPlaylists(uid);
    } catch (e) {
      console.error('[SNX Music] initMusicTab load error:', e);
      const c = document.getElementById('tabContentMusic');
      if (c) c.innerHTML = `<div class="snx-music-empty" style="color:#ff4757;">Failed to load music: ${esc(e.message || String(e))}</div>`;
      return;
    }

    renderMusicTab();

    // ── Autoplay logic (visitor only, never the owner) ───────────
    if (!isSelf && state.settings.enabled && state.settings.autoplay) {
      // Case 1: uploaded songs — start the first track
      if (state.songs.length) {
        loadTrack(0, true);
      }
      // Case 2: embedded platform player
      // The iframe already has autoplay=1 in its src (set by renderMusicLinkCard).
      // Many browsers will block cross-origin autoplay; we surface a fallback tap
      // prompt after a short grace period if the setting is on.
      else if (state.musicLink && state.musicLink.url) {
        const platform = detectPlatform(state.musicLink.url);
        if (platform && platform.canEmbed && (state.musicLink.displayChoice || 'link') === 'embed') {
          // Show the tap-to-play prompt as a fallback; browsers that allow autoplay
          // will have already started the embed. Dismiss on user tap.
          setTimeout(() => {
            const iframe = document.getElementById('snxMusicLinkIframe');
            // Only show prompt if the iframe is still present (page not navigated away)
            if (iframe && iframe.dataset.autoplay === '1') {
              showExternalPrompt(iframe);
            }
          }, 1200);
        }
      }
    }
  }

  // ── External embed tap-to-play prompt ────────────────────────
  // Shown when autoplay is ON but the browser may have blocked the embed.
  // Tapping scrolls to and focuses the iframe, then hides the prompt.
  function showExternalPrompt(iframe) {
    let el = document.getElementById('snxAutoplayPrompt');
    if (!el) {
      el = document.createElement('div');
      el.id = 'snxAutoplayPrompt';
      el.className = 'snx-autoplay-prompt visible';
      document.body.appendChild(el);
    }
    el.textContent = '🎵 Tap to play profile music';
    el.className = 'snx-autoplay-prompt visible';
    el.onclick = () => {
      hidePrompt();
      if (iframe && iframe.isConnected) {
        iframe.scrollIntoView({ behavior: 'smooth', block: 'center' });
        iframe.focus();
      }
    };
  }

  function stopMusicTab() {
    // Stop uploaded audio playback
    if (_audio) {
      _audio.pause();
      _audio.currentTime = 0;
      _audio.removeAttribute('src');
      _audio.load();

      _audio.onended    = null;
      _audio.onplay     = null;
      _audio.onpause    = null;
      _audio.onerror    = null;

      _audio.removeEventListener('timeupdate',    onTimeUpdate);
      _audio.removeEventListener('ended',         onEnded);
      _audio.removeEventListener('loadedmetadata',onMetaLoaded);

      _audio = null;
    }

    // Stop embedded platform player by blanking its src
    const iframe = document.getElementById('snxMusicLinkIframe');
    if (iframe) { iframe.src = ''; }

    state.currentIdx       = -1;
    state.resumeTime       = 0;
    state.autoplayUnlocked = false;

    hidePrompt();

    // Clear player UI so stale track info isn't shown on next visit
    const playBtn = document.getElementById('snxPlayerPlayBtn');
    if (playBtn) playBtn.textContent = '▶';
    const titleEl = document.getElementById('snxPlayerTitle');
    if (titleEl) titleEl.textContent = '';
    const fill = document.getElementById('snxPlayerFill');
    if (fill) fill.style.width = '0%';
  }

  window.snxMusic = { initMusicTab, stopMusicTab, state, detectPlatform };
})();
