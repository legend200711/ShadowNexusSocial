/* ══════════════════════════════════════════════════════════════
   Shadow Nexus Social — Profile Music System
   Handles: upload, playback, playlists, autoplay, settings
   ══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────
  const ALLOWED_AUDIO = ['audio/mpeg','audio/mp3','audio/wav','audio/ogg','audio/aac','audio/flac','audio/x-flac'];
  const ALLOWED_AUDIO_EXT = /\.(mp3|wav|ogg|aac|flac|m4a|opus)$/i;
  const MAX_AUDIO_MB = 50;
  const COLL_SONGS     = 'profileMusic';       // /profileMusic/{songId}
  const COLL_PLAYLISTS = 'profilePlaylists';  // /profilePlaylists/{plId}
  const COLL_SETTINGS  = 'profileMusicSettings'; // stored in users/{uid} sub-field

  // ── State ─────────────────────────────────────────────────────
  const state = {
    profileUid: null,
    isSelf: false,
    songs: [],
    playlists: [],
    activePlId: '__all__',
    currentIdx: -1,
    settings: { enabled: true, autoplay: true, loop: false, repeat: false, repeatOne: false, shuffle: false, showPlayer: true, showPlaylist: true },
    draggingIdx: null,
    autoplayUnlocked: false,
    resumeTime: 0,
  };

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
  function fs() { return window._snxFirestore; }
  function db() { return window._snxDb; }
  function storage() {
    return window._snxStorage;
  }

  async function uploadFile(path, file, onProgress) {
    // Use Firebase Storage SDK if available, else throw
    const { ref, uploadBytesResumable, getDownloadURL } = window._snxFirebaseStorage || {};
    if (!ref) throw new Error('Storage SDK not loaded');
    const storageRef = ref(storage(), path);
    return new Promise((resolve, reject) => {
      const task = uploadBytesResumable(storageRef, file);
      task.on('state_changed', snap => {
        if (onProgress) onProgress(snap.bytesTransferred / snap.totalBytes * 100);
      }, reject, async () => {
        const url = await getDownloadURL(task.snapshot.ref);
        resolve(url);
      });
    });
  }

  async function deleteStorageFile(url) {
    try {
      const { ref, deleteObject } = window._snxFirebaseStorage || {};
      if (!ref) return;
      const fileRef = ref(storage(), decodeURIComponent(url.split('/o/')[1].split('?')[0]));
      await deleteObject(fileRef);
    } catch (e) { /* best effort */ }
  }

  // ── Firestore ops ─────────────────────────────────────────────
  async function loadSongs(uid) {
    const { collection, query, where, orderBy, getDocs } = fs();
    const q = query(collection(db(), COLL_SONGS), where('ownerUid','==', uid), orderBy('uploadedAt', 'asc'));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async function loadPlaylists(uid) {
    const { collection, query, where, orderBy, getDocs } = fs();
    const q = query(collection(db(), COLL_PLAYLISTS), where('ownerUid','==', uid), orderBy('createdAt','asc'));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async function loadSettings(uid) {
    const { doc, getDoc } = fs();
    const snap = await getDoc(doc(db(), 'users', uid));
    if (snap.exists()) return snap.data().musicSettings || {};
    return {};
  }

  async function saveSettings() {
    if (!state.isSelf) return;
    const { doc, updateDoc } = fs();
    await updateDoc(doc(db(), 'users', state.profileUid), { musicSettings: state.settings }).catch(() => {});
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
    const ids = new Set(pl.songIds || []);
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
    a.src = s.url;
    if (state.resumeTime && prev === s.url) { a.currentTime = state.resumeTime; state.resumeTime = 0; }
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
      <div id="snxMusicPlayerWrap" style="${vis.showPlayer ? '' : 'display:none'}">
        ${renderPlayer()}
      </div>
      <div id="snxMusicListWrap" style="${vis.showPlaylist ? '' : 'display:none'}">
        ${renderPlaylistTabs()}
        <div id="snxSongListWrap">${renderSongList()}</div>
      </div>
    `;
    attachMusicEvents();
  }

  function renderSettingsBlock() {
    const s = state.settings;
    const tog = (key, label) => `
      <div class="snx-toggle-row">
        <span class="snx-toggle-label">${label}</span>
        <label class="snx-toggle">
          <input type="checkbox" data-setting="${key}" ${s[key] ? 'checked' : ''}>
          <span class="snx-toggle-slider"></span>
        </label>
      </div>`;
    return `
      <div class="snx-music-settings">
        <div class="snx-music-settings-title">🎵 Music Settings</div>
        ${tog('enabled',     'Enable Profile Music')}
        ${tog('autoplay',    'Autoplay on Profile Visit')}
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
        <div class="snx-music-form-progress" id="snxMusicProgress">
          <div class="snx-music-form-progress-bar" id="snxMusicProgressBar"></div>
        </div>
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
      html += `<button class="snx-playlist-tab${t.id === state.activePlId ? ' active' : ''}" data-pl="${t.id}">${t.name}<span class="snx-pl-count">${t.count}</span></button>`;
    });
    html += `</div>`;
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
          <img class="snx-song-thumb" src="${s.artUrl || ''}" alt="" style="${s.artUrl ? '' : 'opacity:0.3'}">
          <div class="snx-song-meta">
            <div class="snx-song-name">${esc(s.title || 'Unknown')}</div>
            <div class="snx-song-sub">${esc(s.artist || '')}${s.album ? ' — ' + esc(s.album) : ''}</div>
          </div>
          <span class="snx-song-dur">${s.duration ? fmtTime(s.duration) : ''}</span>
          ${state.isSelf ? `
            <div class="snx-song-actions">
              <button class="snx-song-action-btn" data-action="addtopl" data-id="${s.id}" title="Add to playlist">➕</button>
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

  // ── Event Wiring ──────────────────────────────────────────────
  function attachMusicEvents() {
    // Settings toggles
    document.querySelectorAll('.snx-toggle input[data-setting]').forEach(inp => {
      inp.addEventListener('change', async () => {
        const key = inp.dataset.setting;
        state.settings[key] = inp.checked;
        await saveSettings();
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
    if (cancelBtn) cancelBtn.onclick = () => { document.getElementById('snxMusicForm').classList.remove('open'); };

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
      document.getElementById('snxSongListWrap').innerHTML = renderSongList();
      attachSongListEvents();
    });

    // New playlist btn
    document.getElementById('snxNewPlaylistBtn')?.addEventListener('click', () => promptNewPlaylist());

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
            <div><label>Album Artwork</label><input type="file" data-fi="${i}" data-field="artFile" accept="image/*" style="font-size:11px;color:#6a90b8;"></div>
          </div>
          <div class="snx-music-form-row full">
            <div><label>Description</label><textarea data-fi="${i}" data-field="desc" placeholder="Describe the song…" rows="2"></textarea></div>
          </div>
        </div>`;
    });
  }

  async function submitUploads() {
    if (!state.profileUid) return;
    const btn = document.getElementById('snxMusicUploadBtn');
    const progressWrap = document.getElementById('snxMusicProgress');
    const progressBar = document.getElementById('snxMusicProgressBar');
    if (btn) btn.disabled = true;
    if (progressWrap) progressWrap.style.display = 'block';

    const formEl = document.getElementById('snxMusicFormFields');
    const uid = state.profileUid;
    const results = [];

    for (let i = 0; i < _pendingFiles.length; i++) {
      const f = _pendingFiles[i];
      const fields = {};
      if (formEl) {
        formEl.querySelectorAll(`[data-fi="${i}"][data-field]`).forEach(el => {
          fields[el.dataset.field] = el.value || '';
        });
        const artInput = formEl.querySelector(`input[type="file"][data-fi="${i}"]`);
        if (artInput && artInput.files[0]) fields.artFile = artInput.files[0];
      }

      try {
        const path = `profileMusic/${uid}/${Date.now()}_${f.name}`;
        const audioUrl = await uploadFile(path, f, pct => {
          if (progressBar) progressBar.style.width = pct + '%';
        });

        let artUrl = '';
        if (fields.artFile) {
          const artPath = `profileMusicArt/${uid}/${Date.now()}_art`;
          artUrl = await uploadFile(artPath, fields.artFile, () => {}).catch(() => '');
        }

        // Get duration
        const dur = await getAudioDuration(f).catch(() => 0);

        await addSong({ ownerUid: uid, url: audioUrl, artUrl, title: fields.title || f.name, artist: fields.artist || '', album: fields.album || '', genre: fields.genre || '', year: fields.year || '', description: fields.desc || '', duration: dur });
        results.push({ ok: true });
      } catch (err) {
        results.push({ ok: false, name: f.name });
      }
    }

    if (btn) btn.disabled = false;
    if (progressWrap) progressWrap.style.display = 'none';
    document.getElementById('snxMusicForm').classList.remove('open');
    _pendingFiles = [];

    const failed = results.filter(r => !r.ok);
    if (failed.length) toast(`${results.length - failed.length} uploaded, ${failed.length} failed.`, 'error');
    else toast(`🎵 ${results.length} track${results.length > 1 ? 's' : ''} uploaded!`);

    await reload();
  }

  function getAudioDuration(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const a = new Audio(url);
      a.addEventListener('loadedmetadata', () => { URL.revokeObjectURL(url); resolve(a.duration); });
      a.addEventListener('error', reject);
    });
  }

  // ── Delete Song ───────────────────────────────────────────────
  async function confirmDeleteSong(songId) {
    if (!confirm('Delete this track? This cannot be undone.')) return;
    const song = state.songs.find(s => s.id === songId);
    if (song) {
      if (song.url) await deleteStorageFile(song.url);
      if (song.artUrl) await deleteStorageFile(song.artUrl);
    }
    await deleteSong(songId);
    // Remove from playlists
    for (const pl of state.playlists) {
      const ids = (pl.songIds || []).filter(id => id !== songId);
      if (ids.length !== (pl.songIds || []).length) await updatePlaylist(pl.id, { songIds: ids });
    }
    toast('Track deleted.');
    await reload();
  }

  // ── Playlist Management ───────────────────────────────────────
  async function promptNewPlaylist() {
    const name = prompt('Playlist name:');
    if (!name || !name.trim()) return;
    const ref = await addPlaylist({ ownerUid: state.profileUid, name: name.trim(), songIds: [] });
    toast(`Playlist "${name}" created!`);
    await reload();
    state.activePlId = ref.id;
    renderMusicTab();
  }

  async function promptAddToPlaylist(songId) {
    if (!state.playlists.length) { toast('Create a playlist first.'); return; }
    const names = state.playlists.map((p,i) => `${i+1}. ${p.name}`).join('\n');
    const idx = parseInt(prompt(`Add to playlist:\n${names}\n\nEnter number:`), 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= state.playlists.length) return;
    const pl = state.playlists[idx];
    const ids = [...new Set([...(pl.songIds || []), songId])];
    pl.songIds = ids;
    await updatePlaylist(pl.id, { songIds: ids });
    toast(`Added to "${pl.name}"!`);
    document.getElementById('snxSongListWrap').innerHTML = renderSongList();
    attachSongListEvents();
  }

  // ── Reload ────────────────────────────────────────────────────
  async function reload() {
    const uid = state.profileUid;
    if (!uid) return;
    state.songs = await loadSongs(uid).catch(() => []);
    state.playlists = await loadPlaylists(uid).catch(() => []);
    renderMusicTab();
    // Restore player if audio was playing
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
    const savedSettings = await loadSettings(uid).catch(() => ({}));
    state.settings = Object.assign({ enabled: true, autoplay: true, loop: false, repeat: false, repeatOne: false, shuffle: false, showPlayer: true, showPlaylist: true }, savedSettings);

    if (!state.settings.enabled && !isSelf) {
      const c = document.getElementById('tabContentMusic');
      if (c) c.innerHTML = '<div class="snx-music-empty"><span class="snx-music-empty-icon">🎵</span>Music is disabled on this profile.</div>';
      return;
    }

    // Load data
    state.songs = await loadSongs(uid).catch(() => []);
    state.playlists = await loadPlaylists(uid).catch(() => []);
    renderMusicTab();

    // Autoplay when visiting another profile
    if (!isSelf && state.settings.enabled && state.settings.autoplay && state.songs.length) {
      loadTrack(0, true);
    }
  }

  function stopMusicTab() {
    const a = getAudio();
    if (!a.paused) {
      state.resumeTime = a.currentTime;
      a.pause();
    }
    hidePrompt();
  }

  window.snxMusic = { initMusicTab, stopMusicTab, state };
})();
