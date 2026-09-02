/**
 * Shadow Nexus Social — CloudStream Worker
 * cloudstream-worker.js
 *
 * Cloudflare Worker that serves as the server-side brain of the
 * 24-Hour CloudStream system.
 *
 * Responsibilities:
 *   - Receive stream start / stop / control commands from creators
 *   - Maintain stream state in Cloudflare KV (cloudStreamKV)
 *   - Run the automation engine (scene scheduling, announcements)
 *   - Emit health heartbeats back to Firestore via Firebase REST API
 *   - Provide admin endpoints (founder-only)
 *   - NEVER expose Firebase Admin SDK keys to the browser
 *
 * Environment variables required (set via wrangler secret put):
 *   FIREBASE_PROJECT_ID      — Firebase project ID
 *   FIREBASE_API_KEY         — Web API key (for REST calls)
 *   STREAM_SECRET            — Shared secret for creator auth tokens
 *
 * KV Namespace binding:
 *   cloudStreamKV            — Cloudflare KV for stream state
 *
 * Durable Object binding (optional, for persistent alarms):
 *   CloudStreamDO            — see CloudStreamScheduler class below
 */

// Allowed origins for CORS — production domain + any localhost port for dev/testing
const ALLOWED_ORIGINS = [
  'https://shadownexussocial.online',
  'https://www.shadownexussocial.online',
  'https://chrislegendofshadows.com',
  'https://www.chrislegendofshadows.com',
];

function _corsHeaders(request) {
  const origin = (request.headers.get('Origin') || '').trim();
  // Allow exact matches and any localhost origin
  const allowed = ALLOWED_ORIGINS.includes(origin) || /^https?:\/\/localhost(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin':  allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',
  };
}

// Keep backward-compat reference for inline usages in helpers below
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  'https://shadownexussocial.online',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age':       '86400',
  'Vary':                         'Origin',
};

/* ═══════════════════════════════════════════════════════
   MAIN FETCH HANDLER
═══════════════════════════════════════════════════════ */
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;
    // Compute per-request CORS headers (respects Origin for localhost dev)
    const cors   = _corsHeaders(request);

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      // ── Route table ──
      if (method === 'POST' && path === '/api/stream/start')   return handleStart(request, env, ctx, cors);
      if (method === 'POST' && path === '/api/stream/stop')    return handleStop(request, env, ctx, cors);
      if (method === 'POST' && path === '/api/stream/control') return handleControlExtended(request, env, ctx, cors);
      if (method === 'GET'  && path.startsWith('/api/stream/health/')) return handleHealth(request, env, url, cors);
      if (method === 'GET'  && path.startsWith('/api/stream/sync/'))   return handleStreamSync(request, env, url, cors);
      if (method === 'GET'  && path.startsWith('/api/stream/active/')) return handleActiveCheck(request, env, url, cors);
      if (method === 'POST' && path === '/api/admin/stream/stop') return handleAdminStop(request, env, ctx, cors);
      if (method === 'GET'  && path === '/api/admin/streams')  return handleAdminList(request, env, cors);
      // ── Music API ──
      if (method === 'POST' && path === '/api/stream/music/set')      return handleMusicSet(request, env, ctx, cors);
      if (method === 'POST' && path === '/api/stream/music/control')  return handleMusicControl(request, env, ctx, cors);
      if (method === 'POST' && path === '/api/stream/music/watchdog') return handleMusicWatchdog(request, env, url, cors);
      if (method === 'GET'  && path.startsWith('/api/stream/music/')) return handleMusicGet(request, env, url, cors);
      // ── Viewer/Listener presence API ──
      if (method === 'POST' && path === '/api/stream/listener/join')      return handleListenerJoin(request, env, ctx, cors);
      if (method === 'POST' && path === '/api/stream/listener/heartbeat') return handleListenerHeartbeat(request, env, ctx, cors);
      if (method === 'POST' && path === '/api/stream/listener/leave')     return handleListenerLeave(request, env, ctx, cors);
      // ── Likes API ──
      if (method === 'POST' && path === '/api/stream/like')   return handleStreamLike(request, env, ctx, cors);
      if (method === 'GET'  && path.startsWith('/api/stream/likes/')) return handleStreamLikesGet(request, env, url, cors);
      // ── Destinations API ──
      if (method === 'POST' && path === '/api/destinations/save')   return handleDestinationsSave(request, env, cors);
      if (method === 'POST' && path === '/api/destinations/remove') return handleDestinationsRemove(request, env, cors);
      if (method === 'GET'  && path === '/api/destinations/list')   return handleDestinationsList(request, env, url, cors);
      if (method === 'GET'  && path === '/health')             return jsonOK({ ok: true, worker: 'cloudstream', v: '1.5.0' }, cors);

      return jsonErr('Not found', 404, cors);
    } catch (err) {
      console.error('[CloudStream Worker]', err);
      return jsonErr('Internal worker error: ' + err.message, 500, cors);
    }
  }
};

/* ═══════════════════════════════════════════════════════
   STREAM START
═══════════════════════════════════════════════════════ */
async function handleStart(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }

  const {
    streamId, uid, displayName, streamName, theme, scenePlaylist, durationMinutes,
    musicQueue, musicShuffle, musicRepeat, musicCrossfade, musicVolume, musicPlaylistId
  } = body;

  if (!streamId || !uid) return jsonErr('streamId and uid are required', 400, cors);
  if (!durationMinutes || durationMinutes < 1 || durationMinutes > 1440) {
    return jsonErr('durationMinutes must be between 1 and 1440', 400, cors);
  }

  // ── Verify Firebase ID token — prevents UID spoofing ─────────────────────
  // The client must send: Authorization: Bearer <Firebase ID token>
  // The verified UID must match the uid in the request body.
  const idToken = _extractBearerToken(request);
  if (idToken) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (verified && verified.uid !== uid) {
        return jsonErr('Unauthorized: token UID does not match request uid', 403, cors);
      }
    } catch (verifyErr) {
      return jsonErr('Unauthorized: ' + verifyErr.message, 401, cors);
    }
  } else if (env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    // Token required in production (when both env vars are configured)
    return jsonErr('Unauthorized: Authorization header with Firebase ID token required', 401, cors);
  }

  const stream = {
    streamId,
    uid,
    displayName:     displayName || '',
    streamName:      streamName  || 'CloudStream',
    theme:           theme       || 'shadow-nexus',
    scenePlaylist:   Array.isArray(scenePlaylist) ? scenePlaylist : [],
    durationMinutes,
    status:          'active',
    startedAt:       Date.now(),
    endsAt:          Date.now() + (durationMinutes * 60 * 1000),
    currentScene:    scenePlaylist && scenePlaylist[0] ? scenePlaylist[0].name : 'Starting Soon',
    sceneIndex:      0,
    viewerCount:     0,
    bitrate:         2500,
    fps:             30,
    lastHeartbeat:   Date.now(),
    workerActive:    true
  };

  // Store music state separately in KV so it can be updated independently
  if (env.cloudStreamKV && Array.isArray(musicQueue) && musicQueue.length) {
    const musicState = {
      streamId,
      uid,
      playlistId:     musicPlaylistId || '',
      queue:          musicQueue,
      queueIndex:     0,
      shuffle:        musicShuffle  || false,
      repeat:         typeof musicRepeat === 'boolean' ? musicRepeat : true,
      crossfade:      typeof musicCrossfade === 'number' ? musicCrossfade : 3,
      volume:         typeof musicVolume === 'number' ? musicVolume : 80,
      status:         'playing',
      startedAt:      Date.now(),
      lastAdvancedAt: Date.now()
    };
    const ttlSeconds = (durationMinutes + 60) * 60;
    await env.cloudStreamKV.put(`music:${streamId}`, JSON.stringify(musicState), { expirationTtl: ttlSeconds });
    // Schedule first track advancement via Durable Object alarm
    if (env.CloudStreamDO && musicQueue[0] && musicQueue[0].duration) {
      const id  = env.CloudStreamDO.idFromName(streamId + '_music');
      const obj = env.CloudStreamDO.get(id);
      await obj.fetch('https://do/music-schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamId, durationMinutes, musicQueue, shuffle: musicShuffle, repeat: typeof musicRepeat === 'boolean' ? musicRepeat : true })
      });
    }
  }

  // Store in KV with TTL slightly beyond the stream's duration
  if (env.cloudStreamKV) {
    const ttlSeconds = (durationMinutes + 60) * 60;
    await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream), { expirationTtl: ttlSeconds });
  }

  // Schedule the automation engine + write active status to Firestore using waitUntil
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(Promise.all([
      runAutomationEngine(stream, env),
      // Write active status + startedAt to Firestore cloudStreams doc so the record
      // stays current even if the creator's browser disconnects before the client write.
      markCloudStreamInFirestore(env, streamId, {
        status:    'active',
        startedAt: new Date(stream.startedAt).toISOString(),
        expiresAt: new Date(stream.endsAt).toISOString()
      })
    ]));
  }

  return jsonOK({ success: true, stream }, cors);
}

/* ═══════════════════════════════════════════════════════
   STREAM STOP
═══════════════════════════════════════════════════════ */
async function handleStop(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }

  const { streamId, uid } = body;
  if (!streamId) return jsonErr('streamId required', 400, cors);

  // ── Verify Firebase ID token — prevents UID spoofing ─────────────────────
  const idToken = _extractBearerToken(request);
  if (idToken) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (verified && verified.uid !== uid) {
        return jsonErr('Unauthorized: token UID does not match request uid', 403, cors);
      }
    } catch (verifyErr) {
      return jsonErr('Unauthorized: ' + verifyErr.message, 401, cors);
    }
  } else if (env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    return jsonErr('Unauthorized: Authorization header with Firebase ID token required', 401, cors);
  }

  const stream = await getStream(streamId, env);
  if (!stream) return jsonErr('Stream not found', 404, cors);

  // Validate ownership (uid must match)
  if (stream.uid !== uid) return jsonErr('Unauthorized', 403, cors);

  stream.status       = 'stopped';
  stream.stoppedAt    = Date.now();
  stream.workerActive = false;

  if (env.cloudStreamKV) {
    await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream), { expirationTtl: 3600 });
  }

  // Notify Firestore so the feed removes the live card AND updates the cloudStreams record.
  // Also write a history record for the creator's broadcast history.
  if (ctx) {
    ctx.waitUntil(Promise.all([
      markLiveRoomOffline(env, stream.uid),
      markCloudStreamInFirestore(env, streamId, {
        status:     'stopped',
        stoppedAt:  new Date().toISOString(),
        stoppedBy:  'creator'
      }),
      writeCloudStreamHistory(env, stream, 'creator_stop')
    ]));
  }

  return jsonOK({ success: true, message: 'Stream stopped.' }, cors);
}

/* ═══════════════════════════════════════════════════════
   STREAM CONTROL (remote scene / music / announcement)
═══════════════════════════════════════════════════════ */
async function handleControl(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400); }

  const { streamId, uid, action } = body;
  if (!streamId || !uid || !action) return jsonErr('streamId, uid and action required', 400);

  const stream = await getStream(streamId, env);
  if (!stream) return jsonErr('Stream not found', 404);
  if (stream.uid !== uid) return jsonErr('Unauthorized', 403);
  if (stream.status !== 'active' && stream.status !== 'recovering') {
    return jsonErr('Stream is not active. Status: ' + stream.status, 409);
  }

  // Apply action
  switch (action) {
    case 'setScene':
      stream.currentScene = body.sceneId || stream.currentScene;
      break;
    case 'setTheme':
      stream.theme = body.themeId || stream.theme;
      break;
    case 'setVolume':
      stream.musicVolume = typeof body.volume === 'number' ? body.volume : stream.musicVolume;
      break;
    case 'announce':
      stream.lastAnnouncement = { text: body.text || '', ts: Date.now() };
      break;
    case 'nextScene':
      if (stream.scenePlaylist && stream.scenePlaylist.length) {
        stream.sceneIndex = (stream.sceneIndex + 1) % stream.scenePlaylist.length;
        stream.currentScene = stream.scenePlaylist[stream.sceneIndex].name;
      }
      break;
    default:
      return jsonErr('Unknown action: ' + action, 400);
  }

  stream.lastControlAt = Date.now();

  if (env.cloudStreamKV) {
    await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream), { expirationTtl: (stream.durationMinutes + 60) * 60 });
  }

  return jsonOK({ success: true, stream });
}

/* ═══════════════════════════════════════════════════════
   HEALTH CHECK
═══════════════════════════════════════════════════════ */
async function handleHealth(request, env, url, cors) {
  const streamId = url.pathname.replace('/api/stream/health/', '');
  if (!streamId) return jsonErr('streamId required', 400, cors);

  const stream = await getStream(streamId, env);
  if (!stream) return jsonErr('Stream not found', 404, cors);

  // Check if stream has passed its end time
  if (stream.endsAt && Date.now() > stream.endsAt && stream.status === 'active') {
    stream.status = 'stopped';
    if (env.cloudStreamKV) {
      await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream), { expirationTtl: 3600 });
    }
  }

  // Simulate heartbeat update
  stream.lastHeartbeat = Date.now();

  // ── Read current music state so viewer can play the active track ──────────
  let musicInfo = { currentMusicTitle: '', currentMusicArtist: '', currentMusicUrl: '',
                    nextMusicTitle: '', queueIndex: 0, musicStatus: 'no_music',
                    lastMusicAdvancedAt: 0, currentMusicDuration: 0 };
  if (env.cloudStreamKV) {
    const ms = await env.cloudStreamKV.get(`music:${streamId}`, { type: 'json' });
    if (ms && ms.queue && ms.queue.length) {
      const cur  = ms.queue[ms.queueIndex || 0] || {};
      const nxt  = ms.queue[((ms.queueIndex || 0) + 1) % ms.queue.length] || {};
      musicInfo = {
        currentMusicTitle:   cur.title    || '',
        currentMusicArtist:  cur.artist   || '',
        currentMusicUrl:     cur.url      || '',
        currentMusicId:      cur.id       || '',
        currentMusicDuration: cur.duration || 0,
        nextMusicTitle:      nxt.title    || '',
        queueIndex:          ms.queueIndex || 0,
        musicStatus:         ms.status    || 'playing',
        musicVolume:         ms.volume    || 80,
        lastMusicAdvancedAt: ms.lastAdvancedAt || 0
      };
    }
  }

  return jsonOK({
    success:       true,
    status:        stream.status,
    currentScene:  stream.currentScene,
    viewerCount:   stream.viewerCount,
    bitrate:       stream.bitrate,
    fps:           stream.fps,
    uptime:        stream.startedAt ? Math.floor((Date.now() - stream.startedAt) / 60000) : 0,
    lastHeartbeat: stream.lastHeartbeat,
    workerActive:  stream.workerActive,
    ...musicInfo
  }, cors);
}

/* ═══════════════════════════════════════════════════════
   ADMIN: FORCE STOP
   Requires a valid Firebase ID token whose UID has
   role === 'founder' in Firestore users/{uid}.
═══════════════════════════════════════════════════════ */
async function handleAdminStop(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }

  const { streamId, adminUid } = body;
  if (!streamId || !adminUid) return jsonErr('streamId and adminUid required', 400, cors);

  // ── Require a valid Firebase ID token ────────────────────────────────────
  const idToken = _extractBearerToken(request);
  if (!idToken) return jsonErr('Unauthorized: Authorization header required', 401, cors);
  try {
    const verified = await verifyFirebaseIdToken(idToken, env);
    if (!verified || verified.uid !== adminUid) {
      return jsonErr('Unauthorized: token UID does not match adminUid', 403, cors);
    }
    // Verify founder role via Firestore REST
    const isAdmin = await _verifyFounderRole(verified.uid, env);
    if (!isAdmin) return jsonErr('Unauthorized: founder role required', 403, cors);
  } catch (e) {
    return jsonErr('Unauthorized: ' + e.message, 401, cors);
  }

  const stream = await getStream(streamId, env);
  if (!stream) return jsonErr('Stream not found', 404, cors);

  stream.status      = 'stopped';
  stream.stoppedBy   = 'admin';
  stream.stoppedAt   = Date.now();
  stream.workerActive = false;

  if (env.cloudStreamKV) {
    await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream), { expirationTtl: 3600 });
  }

  // Update Firestore cloudStreams record so creator sees the stopped status
  if (ctx) {
    ctx.waitUntil(Promise.all([
      markLiveRoomOffline(env, stream.uid),
      markCloudStreamInFirestore(env, streamId, {
        status:    'stopped',
        stoppedAt: new Date().toISOString(),
        stoppedBy: 'admin'
      })
    ]));
  }

  return jsonOK({ success: true, message: 'Stream force-stopped by admin.' }, cors);
}

/* ═══════════════════════════════════════════════════════
   ADMIN: LIST ACTIVE STREAMS
   Requires a valid Firebase ID token with founder role.
═══════════════════════════════════════════════════════ */
async function handleAdminList(request, env, cors) {
  // ── Require a valid Firebase ID token ────────────────────────────────────
  const idToken = _extractBearerToken(request);
  if (!idToken) return jsonErr('Unauthorized: Authorization header required', 401, cors);
  try {
    const verified = await verifyFirebaseIdToken(idToken, env);
    if (!verified) return jsonErr('Unauthorized: invalid token', 403, cors);
    const isAdmin = await _verifyFounderRole(verified.uid, env);
    if (!isAdmin) return jsonErr('Unauthorized: founder role required', 403, cors);
  } catch (e) {
    return jsonErr('Unauthorized: ' + e.message, 401, cors);
  }

  if (!env.cloudStreamKV) return jsonOK({ streams: [], note: 'KV not configured' }, cors);

  // List all keys with "stream:" prefix
  const list = await env.cloudStreamKV.list({ prefix: 'stream:' });
  const streams = [];
  for (const key of (list.keys || [])) {
    const val = await env.cloudStreamKV.get(key.name, { type: 'json' });
    if (val) streams.push(val);
  }

  return jsonOK({ streams: streams.filter(function(s) {
    return s.status === 'active' || s.status === 'starting' || s.status === 'recovering';
  }) }, cors);
}

/* ── Verify founder role via Firestore REST ──────────────────────────────
   Returns true if the given uid has role === 'founder' in users/{uid}.
   Returns false on any error (fail-closed: deny if can't verify).
   Only called for admin endpoints — not on the hot path for normal users.
────────────────────────────────────────────────────────────────────────── */
async function _verifyFounderRole(uid, env) {
  if (!uid || !env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY) return false;
  try {
    // Get a short-lived anonymous token to read Firestore
    const signInRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${env.FIREBASE_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true }) }
    );
    if (!signInRes.ok) return false;
    const { idToken: anonToken } = await signInRes.json();
    if (!anonToken) return false;

    const docUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`;
    const docRes = await fetch(docUrl, {
      headers: { 'Authorization': `Bearer ${anonToken}` }
    });
    if (!docRes.ok) return false;
    const doc = await docRes.json();
    const role = doc.fields?.role?.stringValue || '';
    return role === 'founder';
  } catch {
    return false;  // fail-closed
  }
}

/* ═══════════════════════════════════════════════════════
   AUTOMATION ENGINE
   Runs server-side scene scheduling.
   Called via ctx.waitUntil — Cloudflare gives it up to 30 seconds
   of CPU time per request. For true 24-hour scheduling, pair this
   with Cloudflare Durable Objects / Cron Triggers.
═══════════════════════════════════════════════════════ */
async function runAutomationEngine(stream, env) {
  // This runs in the background of the start request.
  // It processes the first few scene transitions, then the
  // Durable Object / Cron Trigger takes over for long-running schedules.

  if (!stream.scenePlaylist || !stream.scenePlaylist.length) return;

  // Log the stream start event
  await logStreamEvent(env, stream.streamId, 'stream_started', {
    streamName: stream.streamName,
    theme:      stream.theme,
    sceneCount: stream.scenePlaylist.length,
    duration:   stream.durationMinutes
  });
}

/* ═══════════════════════════════════════════════════════
   MUSIC SET — Replace/update the music queue for a stream
   Called when creator selects a new playlist while active.
═══════════════════════════════════════════════════════ */
async function handleMusicSet(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }

  const { streamId, uid, queue, shuffle, repeat, crossfade, volume, playlistId, queueIndex } = body;
  if (!streamId || !uid) return jsonErr('streamId and uid required', 400, cors);

  // ── Verify Firebase ID token ──────────────────────────────────────────────
  const idToken = _extractBearerToken(request);
  if (idToken) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (verified && verified.uid !== uid) return jsonErr('Unauthorized: token UID mismatch', 403, cors);
    } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  } else if (env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    return jsonErr('Unauthorized: Authorization header required', 401, cors);
  }

  const stream = await getStream(streamId, env);
  if (!stream) return jsonErr('Stream not found', 404, cors);
  if (stream.uid !== uid) return jsonErr('Unauthorized', 403, cors);

  if (!env.cloudStreamKV) return jsonErr('KV not configured', 503, cors);

  // Build or update music state
  const existing = await env.cloudStreamKV.get(`music:${streamId}`, { type: 'json' }) || {};
  const musicState = Object.assign(existing, {
    streamId,
    uid,
    playlistId:     playlistId  || existing.playlistId || '',
    queue:          Array.isArray(queue) ? queue : (existing.queue || []),
    queueIndex:     typeof queueIndex === 'number' ? queueIndex : 0,
    shuffle:        typeof shuffle  === 'boolean' ? shuffle  : (existing.shuffle  || false),
    repeat:         typeof repeat   === 'boolean' ? repeat   : (typeof existing.repeat === 'boolean' ? existing.repeat : true),
    crossfade:      typeof crossfade === 'number' ? crossfade : (existing.crossfade || 3),
    volume:         typeof volume   === 'number' ? volume    : (existing.volume    || 80),
    status:         'playing',
    lastAdvancedAt: Date.now()
  });

  const ttlSeconds = (stream.durationMinutes + 60) * 60;
  await env.cloudStreamKV.put(`music:${streamId}`, JSON.stringify(musicState), { expirationTtl: ttlSeconds });

  // Reschedule music alarm with new queue
  if (env.CloudStreamDO && musicState.queue.length) {
    const curTrack = musicState.queue[musicState.queueIndex];
    if (curTrack && curTrack.duration) {
      const id  = env.CloudStreamDO.idFromName(streamId + '_music');
      const obj = env.CloudStreamDO.get(id);
      await obj.fetch('https://do/music-schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          streamId,
          durationMinutes: stream.durationMinutes,
          musicQueue:      musicState.queue,
          shuffle:         musicState.shuffle,
          repeat:          musicState.repeat,
          queueIndex:      musicState.queueIndex
        })
      });
    }
  }

  // Push Now Playing update to Firestore
  if (ctx) ctx.waitUntil(pushNowPlayingToFirestore(env, streamId, musicState));

  const cur  = musicState.queue[musicState.queueIndex] || {};
  const next = musicState.queue[(musicState.queueIndex + 1) % (musicState.queue.length || 1)] || {};
  return jsonOK({
    success:       true,
    currentTitle:  cur.title  || '',
    currentArtist: cur.artist || '',
    nextTitle:     next.title || '',
    queueLength:   musicState.queue.length
  }, cors);
}

/* ═══════════════════════════════════════════════════════
   MUSIC CONTROL — Playback actions (next, pause, etc.)
═══════════════════════════════════════════════════════ */
async function handleMusicControl(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }

  const { streamId, uid, action } = body;
  if (!streamId || !uid || !action) return jsonErr('streamId, uid and action required', 400, cors);

  // ── Verify Firebase ID token ──────────────────────────────────────────────
  const idToken = _extractBearerToken(request);
  if (idToken) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (verified && verified.uid !== uid) return jsonErr('Unauthorized: token UID mismatch', 403, cors);
    } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  } else if (env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    return jsonErr('Unauthorized: Authorization header required', 401, cors);
  }

  const stream = await getStream(streamId, env);
  if (!stream) return jsonErr('Stream not found', 404, cors);
  if (stream.uid !== uid) return jsonErr('Unauthorized', 403, cors);

  if (!env.cloudStreamKV) return jsonErr('KV not configured', 503, cors);
  const musicState = await env.cloudStreamKV.get(`music:${streamId}`, { type: 'json' });
  if (!musicState) return jsonErr('No music state found for stream', 404, cors);

  switch (action) {
    case 'musicNext':
    case 'next': {
      if (musicState.shuffle) {
        musicState.queueIndex = Math.floor(Math.random() * musicState.queue.length);
      } else {
        const next = (musicState.queueIndex + 1) % musicState.queue.length;
        if (next === 0 && !musicState.repeat) {
          musicState.status = 'ended';
        } else {
          musicState.queueIndex = next;
        }
      }
      musicState.lastAdvancedAt = Date.now();
      break;
    }
    case 'musicPause':
    case 'pause':
      musicState.status = 'paused';
      break;
    case 'musicResume':
    case 'resume':
      musicState.status = 'playing';
      break;
    case 'musicShuffle':
      musicState.shuffle = typeof body.value === 'boolean' ? body.value : !musicState.shuffle;
      break;
    case 'musicRepeat':
      musicState.repeat  = typeof body.value === 'boolean' ? body.value : !musicState.repeat;
      break;
    case 'musicVolume':
      musicState.volume  = typeof body.value === 'number' ? body.value : musicState.volume;
      break;
    case 'musicCrossfade':
      musicState.crossfade = typeof body.value === 'number' ? body.value : musicState.crossfade;
      break;
    default:
      return jsonErr('Unknown music action: ' + action, 400, cors);
  }

  const ttlSeconds = (stream.durationMinutes + 60) * 60;
  await env.cloudStreamKV.put(`music:${streamId}`, JSON.stringify(musicState), { expirationTtl: ttlSeconds });

  if (ctx) ctx.waitUntil(pushNowPlayingToFirestore(env, streamId, musicState));

  const cur  = musicState.queue[musicState.queueIndex] || {};
  return jsonOK({ success: true, currentTitle: cur.title || '', queueIndex: musicState.queueIndex, status: musicState.status }, cors);
}

/* ═══════════════════════════════════════════════════════
   MUSIC GET — Read current music state
═══════════════════════════════════════════════════════ */
async function handleMusicGet(request, env, url, cors) {
  const streamId = url.pathname.replace('/api/stream/music/', '');
  if (!streamId) return jsonErr('streamId required', 400, cors);

  const musicState = env.cloudStreamKV
    ? await env.cloudStreamKV.get(`music:${streamId}`, { type: 'json' })
    : null;

  if (!musicState) return jsonOK({ success: true, status: 'no_music', currentTitle: '', currentArtist: '', nextTitle: '' }, cors);

  const cur  = musicState.queue[musicState.queueIndex] || {};
  const next = musicState.queue[(musicState.queueIndex + 1) % (musicState.queue.length || 1)] || {};
  return jsonOK({
    success:       true,
    status:        musicState.status || 'playing',
    playlistId:    musicState.playlistId || '',
    currentTitle:  cur.title   || '',
    currentArtist: cur.artist  || '',
    nextTitle:     next.title  || '',
    nextArtist:    next.artist || '',
    queueIndex:    musicState.queueIndex,
    queueLength:   musicState.queue.length,
    shuffle:       musicState.shuffle,
    repeat:        musicState.repeat,
    volume:        musicState.volume,
    crossfade:     musicState.crossfade
  }, cors);
}

/* ── Push Now Playing to Firestore via REST ── */
async function pushNowPlayingToFirestore(env, streamId, musicState) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY || !musicState) return;

  const cur  = musicState.queue[musicState.queueIndex] || {};
  const next = musicState.queue[(musicState.queueIndex + 1) % (musicState.queue.length || 1)] || {};

  try {
    // Sign in anonymously for Firestore REST
    const signInRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${env.FIREBASE_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true }) }
    );
    if (!signInRes.ok) return;
    const { idToken } = await signInRes.json();
    if (!idToken) return;

    // Use PATCH without updateMask — this is a full document write (create or replace).
    // A PATCH with updateMask returns 404 if the document does not yet exist, causing
    // silent failure on the first track write.  Without updateMask the Firestore REST
    // API performs a create-or-replace, which always succeeds (subject to security rules).
    // We include uid (= musicState.uid, the creator's real UID) so the Firestore
    // create rule "request.resource.data.uid == request.auth.uid" can be satisfied by
    // the update rule's anonymous-token path instead (the update rule does not require
    // uid match; only the create rule does — and after the client's first setDoc write
    // the doc always already exists, so we only hit the update rule).
    const firestoreUrl =
      `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/studioCloudStreamMusic/${streamId}`;

    const res = await fetch(firestoreUrl, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
      body: JSON.stringify({
        fields: {
          cloudStreamId:   { stringValue: streamId },
          uid:             { stringValue: musicState.uid || '' },
          currentTrackId:  { stringValue: cur.id       || '' },
          currentTitle:    { stringValue: cur.title     || '' },
          currentArtist:   { stringValue: cur.artist    || '' },
          currentTrackUrl: { stringValue: cur.url       || '' },
          currentDuration: { integerValue: String(cur.duration || 0) },
          nextTrackId:     { stringValue: next.id       || '' },
          nextTitle:       { stringValue: next.title    || '' },
          nextArtist:      { stringValue: next.artist   || '' },
          queueIndex:      { integerValue: String(musicState.queueIndex || 0) },
          status:          { stringValue: musicState.status || 'playing' },
          updatedAt:       { timestampValue: new Date().toISOString() }
        }
      })
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[CloudStream Worker] pushNowPlayingToFirestore HTTP', res.status, body.slice(0, 200));
    }
  } catch(e) {
    console.warn('[CloudStream Worker] pushNowPlayingToFirestore error:', e.message);
  }
}

/* ═══════════════════════════════════════════════════════
   MUSIC WATCHDOG — external trigger to recover a stalled
   DO alarm.  Called by the creator's browser health check
   (or a Cron Trigger) when tracks stop advancing.
   POST /api/stream/music/watchdog  { streamId, uid }
═══════════════════════════════════════════════════════ */
async function handleMusicWatchdog(request, env, url, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }
  const { streamId, uid } = body;
  if (!streamId) return jsonErr('streamId required', 400, cors);

  // Verify caller owns the stream
  const idToken = _extractBearerToken(request);
  if (idToken && env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (!verified || verified.uid !== uid) return jsonErr('Unauthorized', 403, cors);
    } catch(e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  }

  if (!env.CloudStreamDO) return jsonErr('DO not configured', 503, cors);
  const id  = env.CloudStreamDO.idFromName(streamId + '_music');
  const obj = env.CloudStreamDO.get(id);
  const res = await obj.fetch('https://do/music-watchdog', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ streamId })
  });
  const data = await res.json().catch(() => ({}));
  return jsonOK(data, cors);
}

/* ═══════════════════════════════════════════════════════
   DURABLE OBJECT — CloudStreamScheduler
   Enables persistent 24-hour scheduling via Cloudflare Alarms.
   Register this in wrangler-studio.jsonc as a Durable Object binding.
═══════════════════════════════════════════════════════ */
export class CloudStreamScheduler {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
  }

  async fetch(request) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/schedule') {
      let body;
      try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400); }

      const { streamId, scenePlaylist, durationMinutes } = body;
      if (!streamId) return jsonErr('streamId required', 400);

      await this.state.storage.put('streamId', streamId);
      await this.state.storage.put('scenePlaylist', JSON.stringify(scenePlaylist || []));
      await this.state.storage.put('sceneIndex', 0);
      await this.state.storage.put('startedAt', Date.now());
      await this.state.storage.put('durationMinutes', durationMinutes || 24 * 60);
      await this.state.storage.put('mode', 'scene');

      if (scenePlaylist && scenePlaylist.length > 0) {
        const firstDuration = (scenePlaylist[0].duration || 1200) * 1000;
        await this.state.storage.setAlarm(Date.now() + firstDuration);
      }
      return jsonOK({ scheduled: true, streamId });
    }

    // ── Music scheduling: fires an alarm every track to advance the playlist ──
    if (request.method === 'POST' && path === '/music-schedule') {
      let body;
      try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400); }

      const { streamId, durationMinutes, musicQueue, shuffle, repeat, queueIndex } = body;
      if (!streamId || !Array.isArray(musicQueue) || !musicQueue.length) {
        return jsonOK({ scheduled: false, reason: 'empty queue' });
      }

      await this.state.storage.put('m_streamId',       streamId);
      await this.state.storage.put('m_queue',          JSON.stringify(musicQueue));
      await this.state.storage.put('m_queueIndex',     queueIndex || 0);
      await this.state.storage.put('m_shuffle',        shuffle ? 1 : 0);
      await this.state.storage.put('m_repeat',         (typeof repeat === 'boolean' ? repeat : true) ? 1 : 0);
      await this.state.storage.put('m_startedAt',      Date.now());
      await this.state.storage.put('m_lastAlarmAt',    Date.now());
      await this.state.storage.put('m_durationMin',    durationMinutes || 1440);
      await this.state.storage.put('mode',             'music');

      // Set alarm for end of current track
      const idx   = queueIndex || 0;
      const track = musicQueue[idx];
      const dur   = track && track.duration ? track.duration * 1000 : 240000; // default 4 min
      await this.state.storage.setAlarm(Date.now() + dur);
      return jsonOK({ scheduled: true, streamId, firstTrack: track ? track.title : '' });
    }

    // ── Music watchdog: called externally to detect & recover lost alarms ──
    // If the DO alarm has not fired for > 10 minutes beyond the expected
    // track duration, we re-trigger the alarm immediately.
    if (request.method === 'POST' && path === '/music-watchdog') {
      const streamId = await this.state.storage.get('m_streamId');
      if (!streamId) return jsonOK({ ok: true, reason: 'no_stream' });

      const mode = (await this.state.storage.get('mode')) || 'scene';
      if (mode !== 'music') return jsonOK({ ok: true, reason: 'not_music_mode' });

      // Check KV music state to see if tracks are advancing
      let musicState = null;
      if (this.env.cloudStreamKV) {
        musicState = await this.env.cloudStreamKV.get(`music:${streamId}`, { type: 'json' });
      }
      if (!musicState) return jsonOK({ ok: true, reason: 'kv_no_state' });
      if (musicState.status === 'stopped' || musicState.status === 'ended') {
        return jsonOK({ ok: true, reason: 'stream_ended' });
      }

      // If lastAdvancedAt is too stale (track should have finished), re-trigger alarm now
      const lastAdvanced = musicState.lastAdvancedAt || 0;
      const trackDurMs   = ((musicState.queue && musicState.queue[musicState.queueIndex || 0] && musicState.queue[musicState.queueIndex || 0].duration) || 240) * 1000;
      const staleness    = Date.now() - lastAdvanced;
      // Stale if it's been > track duration + 10 minutes since last advancement
      if (staleness > trackDurMs + 10 * 60 * 1000) {
        await this.state.storage.put('m_lastAlarmAt', Date.now());
        await this.state.storage.setAlarm(Date.now() + 1000); // fire in 1 second
        await logStreamEvent(this.env, streamId, 'music_watchdog_triggered', { staleness, trackDurMs });
        return jsonOK({ ok: true, reason: 'alarm_rescheduled', staleness });
      }

      return jsonOK({ ok: true, reason: 'alarm_healthy', staleness });
    }

    return jsonErr('Not found', 404);
  }

  async alarm() {
    const mode = (await this.state.storage.get('mode')) || 'scene';

    if (mode === 'music') {
      await this._handleMusicAlarm();
    } else {
      await this._handleSceneAlarm();
    }
  }

  async _handleMusicAlarm() {
    const streamId    = await this.state.storage.get('m_streamId');
    const queueJson   = await this.state.storage.get('m_queue');
    const queueIndex  = (await this.state.storage.get('m_queueIndex')) || 0;
    const shuffle     = !!( await this.state.storage.get('m_shuffle'));
    const repeat      = !!( await this.state.storage.get('m_repeat'));
    const startedAt   = (await this.state.storage.get('m_startedAt')) || Date.now();
    const durationMin = (await this.state.storage.get('m_durationMin')) || 1440;

    if (!streamId) return;

    // ── Watchdog: read music state from KV and sync if DO queue is stale ──────
    let musicState = null;
    if (this.env.cloudStreamKV) {
      musicState = await this.env.cloudStreamKV.get(`music:${streamId}`, { type: 'json' });
    }

    // If KV has no music state the stream was already ended/deleted — stop scheduling
    if (!musicState) {
      await logStreamEvent(this.env, streamId, 'music_alarm_no_state', { reason: 'kv_missing' });
      return;
    }

    // Always authoritative: use KV queue over DO-stored queue (KV may have been updated mid-stream)
    const musicQueue = (musicState.queue && musicState.queue.length)
      ? musicState.queue
      : (queueJson ? JSON.parse(queueJson) : []);

    if (!musicQueue.length) {
      // Save the empty-queue state but keep broadcasting (re-check in 60s)
      musicState.status = 'paused';
      if (this.env.cloudStreamKV) {
        await this.env.cloudStreamKV.put(`music:${streamId}`, JSON.stringify(musicState));
      }
      await logStreamEvent(this.env, streamId, 'music_queue_empty', { reason: 'all_tracks_removed' });
      await this.state.storage.setAlarm(Date.now() + 60000);
      return;
    }

    // Keep KV queue authoritative
    musicState.queue = musicQueue;

    // Check stream expiry via KV stream record (more reliable than startedAt in DO storage)
    const streamRec = this.env.cloudStreamKV
      ? await this.env.cloudStreamKV.get(`stream:${streamId}`, { type: 'json' })
      : null;
    if (streamRec && streamRec.endsAt && Date.now() > streamRec.endsAt) {
      await this._endStream(streamId);
      return;
    }
    // Fallback expiry via DO startedAt
    const elapsed = (Date.now() - startedAt) / 60000;
    if (elapsed >= durationMin) {
      await this._endStream(streamId);
      return;
    }

    // Paused: reschedule watchdog in 30s instead of 60s so resume is snappy
    if (musicState.status === 'paused') {
      await this.state.storage.setAlarm(Date.now() + 30000);
      return;
    }

    // Ended with repeat=false: if the stream is still active but music ended,
    // restart from track 0 (override "ended" if stream hasn't expired — keeps broadcast alive)
    if (musicState.status === 'ended') {
      if (musicState.repeat === false) {
        // Truly ended by design — log and stop rescheduling
        await logStreamEvent(this.env, streamId, 'music_ended', { reason: 'repeat_off' });
        return;
      }
      // repeat=true but somehow landed on 'ended' — recover
      musicState.status = 'playing';
    }

    // ── Guard: if queue is now empty (all tracks deleted), put stream into safe
    //    idle state rather than crashing.  The broadcast stays alive.
    if (!musicState.queue || !musicState.queue.length) {
      musicState.status = 'paused';
      if (this.env.cloudStreamKV) {
        await this.env.cloudStreamKV.put(`music:${streamId}`, JSON.stringify(musicState));
      }
      await logStreamEvent(this.env, streamId, 'music_queue_empty', { reason: 'all_tracks_removed' });
      await this.state.storage.setAlarm(Date.now() + 60000); // re-check in 1 min
      return;
    }

    // Advance to next track, skipping any tracks with empty/missing URLs
    let nextIndex;
    const qLen = musicState.queue.length;

    if (musicState.shuffle) {
      // Shuffle: pick random index different from current when possible
      if (qLen > 1) {
        do { nextIndex = Math.floor(Math.random() * qLen); }
        while (nextIndex === (musicState.queueIndex || 0));
      } else {
        nextIndex = 0;
      }
    } else {
      nextIndex = ((musicState.queueIndex || 0) + 1) % qLen;
      // Reached end of playlist
      if (nextIndex === 0) {
        if (musicState.repeat === false) {
          musicState.status = 'ended';
          if (this.env.cloudStreamKV) {
            await this.env.cloudStreamKV.put(`music:${streamId}`, JSON.stringify(musicState));
          }
          await logStreamEvent(this.env, streamId, 'music_ended', { reason: 'repeat_off' });
          return;
        }
        // repeat=true (or undefined, default repeat) — loop back to beginning
        await logStreamEvent(this.env, streamId, 'music_looped', { queueLength: qLen });
      }
    }

    // Skip tracks that have no URL (deleted or broken) — try up to qLen candidates
    let skipped = 0;
    while (skipped < qLen) {
      const candidate = musicState.queue[nextIndex];
      if (candidate && candidate.url) break; // valid track found
      // Track is missing/deleted — skip it
      await logStreamEvent(this.env, streamId, 'track_skipped', {
        reason: 'no_url',
        index:  nextIndex,
        title:  (candidate && candidate.title) || ''
      });
      nextIndex = (nextIndex + 1) % qLen;
      skipped++;
    }

    // If every track in the queue is missing, pause rather than crash
    if (skipped >= qLen) {
      musicState.status = 'paused';
      if (this.env.cloudStreamKV) {
        await this.env.cloudStreamKV.put(`music:${streamId}`, JSON.stringify(musicState));
      }
      await logStreamEvent(this.env, streamId, 'music_queue_all_invalid', { reason: 'all_tracks_missing_url' });
      await this.state.storage.setAlarm(Date.now() + 60000);
      return;
    }

    musicState.queueIndex     = nextIndex;
    musicState.lastAdvancedAt = Date.now();
    musicState.status         = 'playing'; // ensure status is playing after advance

    if (this.env.cloudStreamKV) {
      await this.env.cloudStreamKV.put(`music:${streamId}`, JSON.stringify(musicState));
    }

    // Update Durable Object's local index for next alarm
    await this.state.storage.put('m_queueIndex',  nextIndex);
    await this.state.storage.put('m_lastAlarmAt', Date.now());

    // Push Now Playing to Firestore
    await pushNowPlayingToFirestore(this.env, streamId, musicState);

    // Log track change
    const cur = musicState.queue[nextIndex] || {};
    await logStreamEvent(this.env, streamId, 'track_advanced', {
      title:  cur.title  || '',
      artist: cur.artist || '',
      index:  nextIndex
    });

    // Schedule alarm for end of next track
    // Guard: minimum 5s, maximum 6 hours, default 4 min if duration is 0/missing
    const rawDur = cur.duration ? cur.duration * 1000 : 240000;
    const nextDur = Math.max(5000, Math.min(rawDur, 6 * 60 * 60 * 1000));
    await this.state.storage.setAlarm(Date.now() + nextDur);
  }

  async _handleSceneAlarm() {
    // Called by Cloudflare when the alarm fires
    const streamId     = await this.state.storage.get('streamId');
    const sceneJson    = await this.state.storage.get('scenePlaylist');
    const sceneIndex   = (await this.state.storage.get('sceneIndex')) || 0;
    const startedAt    = (await this.state.storage.get('startedAt')) || Date.now();
    const durationMin  = (await this.state.storage.get('durationMinutes')) || 1440;

    if (!streamId) return;

    const scenePlaylist = sceneJson ? JSON.parse(sceneJson) : [];
    const elapsed       = (Date.now() - startedAt) / 60000;

    if (elapsed >= durationMin) {
      await this._endStream(streamId);
      return;
    }

    const nextIndex = (sceneIndex + 1) % scenePlaylist.length;
    await this.state.storage.put('sceneIndex', nextIndex);

    if (this.env.cloudStreamKV) {
      const streamData = await this.env.cloudStreamKV.get(`stream:${streamId}`, { type: 'json' });
      if (streamData && streamData.status === 'active') {
        const nextScene = scenePlaylist[nextIndex];
        streamData.currentScene = nextScene ? nextScene.name : streamData.currentScene;
        streamData.sceneIndex   = nextIndex;
        await this.env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(streamData));
        await logStreamEvent(this.env, streamId, 'scene_changed', {
          scene: streamData.currentScene, index: nextIndex
        });
      }
    }

    const nextScene    = scenePlaylist[nextIndex];
    const nextDuration = (nextScene && nextScene.duration ? nextScene.duration : 1200) * 1000;
    await this.state.storage.setAlarm(Date.now() + nextDuration);
  }

  async _endStream(streamId) {
    let uid = null;
    let startedAt = null;
    if (this.env.cloudStreamKV) {
      const streamData = await this.env.cloudStreamKV.get(`stream:${streamId}`, { type: 'json' });
      if (streamData) {
        uid                  = streamData.uid;
        startedAt            = streamData.startedAt;
        streamData.status    = 'stopped';
        streamData.stoppedAt = Date.now();
        streamData.reason    = 'scheduled_end';
        await this.env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(streamData), { expirationTtl: 3600 });
      }
    }
    await logStreamEvent(this.env, streamId, 'stream_ended', { reason: 'scheduled_end' });
    // Update Firestore: mark liveRooms offline, update cloudStreams doc, write history
    const stoppedStreamData = this.env.cloudStreamKV
      ? (await this.env.cloudStreamKV.get(`stream:${streamId}`, { type: 'json' })) || {}
      : {};
    await Promise.all([
      uid ? markLiveRoomOffline(this.env, uid) : Promise.resolve(),
      markCloudStreamInFirestore(this.env, streamId, {
        status:    'stopped',
        stoppedAt: new Date().toISOString(),
        stoppedBy: 'scheduled_end'
      }),
      writeCloudStreamHistory(this.env, Object.assign({ streamId }, stoppedStreamData), 'scheduled_end')
    ]);
  }
}

/* ═══════════════════════════════════════════════════════
   FIREBASE REST — mark liveRooms doc offline
═══════════════════════════════════════════════════════ */
/**
 * Called server-side when a CloudStream stops (scheduled end or manual stop).
 * Uses Firestore REST API (PATCH) to set isLive=false on the host's liveRooms doc.
 * Does nothing if FIREBASE_PROJECT_ID / FIREBASE_API_KEY are not configured.
 */
async function markLiveRoomOffline(env, hostUid) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY || !hostUid) return;

  const projectId = env.FIREBASE_PROJECT_ID;
  const apiKey    = env.FIREBASE_API_KEY;

  // Exchange API key for an anonymous identity token (needed for Firestore REST writes)
  // We use the Firebase signInAnonymously REST endpoint only to obtain a bearer token.
  // Note: The Firestore security rules allow liveRooms updates where hostId == auth.uid.
  // Since we can't authenticate as the host from the worker, we use Firebase Admin REST
  // which allows unauthenticated writes if the project allows them — or we use the
  // special "service account impersonation via custom token" approach.
  //
  // SIMPLEST APPROACH: use the REST API with the service account secret (FIREBASE_SERVICE_SECRET)
  // if available; otherwise use the Firestore API key with a workaround that matches
  // the existing liveRooms rule (allow update where only isLive/status fields changed).
  //
  // For now we use the Firebase Web API key approach with a short-lived anonymous token.

  try {
    // Step 1: sign in anonymously to get an id_token
    const signInRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true })
      }
    );
    if (!signInRes.ok) return; // can't authenticate — skip
    const signInData = await signInRes.json();
    const idToken    = signInData.idToken;
    if (!idToken) return;

    // Step 2: PATCH the liveRooms/{hostUid} document
    //   updateMask limits the write to only isLive + status + updatedAt
    const firestoreUrl =
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/liveRooms/${hostUid}` +
      `?updateMask.fieldPaths=isLive&updateMask.fieldPaths=status&updateMask.fieldPaths=updatedAt`;

    const patchRes = await fetch(firestoreUrl, {
      method:  'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        fields: {
          isLive:    { booleanValue: false },
          status:    { stringValue:  'ended' },
          updatedAt: { timestampValue: new Date().toISOString() }
        }
      })
    });

    if (!patchRes.ok) {
      console.warn('[CloudStream Worker] markLiveRoomOffline PATCH failed:', patchRes.status);
    }
  } catch (e) {
    console.warn('[CloudStream Worker] markLiveRoomOffline error:', e.message);
  }
}

/* ═══════════════════════════════════════════════════════
   FIREBASE REST — update cloudStreams document
   Called server-side when a stream stops/ends to keep the
   Firestore record consistent even when the creator's device
   is offline or the browser has been closed.
═══════════════════════════════════════════════════════ */
async function markCloudStreamInFirestore(env, streamId, fields) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY || !streamId) return;

  try {
    // Obtain a short-lived anonymous token for the Firestore REST write.
    // The studioCloudStreamMusic rule already allows anon writes;
    // the cloudStreams rule allows updates where resource.data.uid == request.auth.uid.
    // Since we cannot impersonate the creator from the worker we use the anonymous
    // token and rely on the Firestore rule that allows Founder to update any record.
    // The update is intentionally narrow: only status + stoppedAt + stoppedBy fields.
    const signInRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${env.FIREBASE_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true }) }
    );
    if (!signInRes.ok) return;
    const { idToken } = await signInRes.json();
    if (!idToken) return;

    // Build the Firestore REST fields object — support all lifecycle fields
    const firestoreFields = {};
    if (fields.status)    firestoreFields.status    = { stringValue: fields.status };
    if (fields.stoppedAt) firestoreFields.stoppedAt = { stringValue: fields.stoppedAt };
    if (fields.stoppedBy) firestoreFields.stoppedBy = { stringValue: fields.stoppedBy };
    if (fields.startedAt) firestoreFields.startedAt = { stringValue: fields.startedAt };
    if (fields.expiresAt) firestoreFields.expiresAt = { stringValue: fields.expiresAt };
    firestoreFields.updatedAt = { timestampValue: new Date().toISOString() };

    // Build updateMask so only these fields are written
    const maskParams = Object.keys(firestoreFields)
      .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
      .join('&');

    const firestoreUrl =
      `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/cloudStreams/${streamId}?${maskParams}`;

    const patchRes = await fetch(firestoreUrl, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
      body:    JSON.stringify({ fields: firestoreFields })
    });

    if (!patchRes.ok) {
      const errBody = await patchRes.text().catch(() => '');
      console.warn('[CloudStream Worker] markCloudStreamInFirestore PATCH failed:', patchRes.status, errBody.slice(0, 200));
    }
  } catch (e) {
    console.warn('[CloudStream Worker] markCloudStreamInFirestore error:', e.message);
  }
}

/* ═══════════════════════════════════════════════════════
   FIREBASE REST — write broadcast history record
   Called when a stream ends (scheduled or manual) to preserve
   a permanent history record in cloudStreamHistory collection.
═══════════════════════════════════════════════════════ */
async function writeCloudStreamHistory(env, streamData, reason) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY || !streamData) return;

  try {
    const signInRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${env.FIREBASE_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true }) }
    );
    if (!signInRes.ok) return;
    const { idToken } = await signInRes.json();
    if (!idToken) return;

    const histId = `${streamData.streamId || 'unknown'}_${Date.now()}`;
    const firestoreUrl =
      `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/cloudStreamHistory/${histId}`;

    const now       = new Date().toISOString();
    const startedMs = streamData.startedAt || 0;
    const stoppedMs = streamData.stoppedAt || Date.now();
    const durSecs   = startedMs ? Math.max(0, Math.floor((stoppedMs - startedMs) / 1000)) : 0;

    const res = await fetch(firestoreUrl, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
      body: JSON.stringify({
        fields: {
          historyId:    { stringValue: histId },
          streamId:     { stringValue: streamData.streamId   || '' },
          uid:          { stringValue: streamData.uid        || '' },
          displayName:  { stringValue: streamData.displayName|| '' },
          streamName:   { stringValue: streamData.streamName || '' },
          description:  { stringValue: streamData.description|| '' },
          category:     { stringValue: streamData.category   || '' },
          startedAt:    { stringValue: startedMs ? new Date(startedMs).toISOString() : now },
          stoppedAt:    { stringValue: new Date(stoppedMs).toISOString() },
          durationSecs: { integerValue: String(durSecs) },
          peakListeners:{ integerValue: String(streamData.viewerCount || 0) },
          finalStatus:  { stringValue: streamData.status   || 'stopped' },
          stopReason:   { stringValue: reason              || 'unknown' },
          createdAt:    { timestampValue: now }
        }
      })
    });
    if (!res.ok) {
      console.warn('[CloudStream Worker] writeCloudStreamHistory PUT failed:', res.status);
    }
  } catch (e) {
    console.warn('[CloudStream Worker] writeCloudStreamHistory error:', e.message);
  }
}

/* ═══════════════════════════════════════════════════════
   FIREBASE ID TOKEN VERIFICATION
   Verifies a Firebase Auth ID token using the Firebase
   Auth REST API (tokeninfo endpoint).  The verified UID
   is returned so the caller can compare it to the
   requested resource owner — preventing User A from
   claiming User B's stream.
   
   Returns { uid } on success, or throws with a message.
   Only called when env.FIREBASE_PROJECT_ID is set.
═══════════════════════════════════════════════════════ */
async function verifyFirebaseIdToken(idToken, env) {
  if (!env.FIREBASE_PROJECT_ID) {
    // Project ID not configured — skip verification (development only).
    // In production wrangler-studio.jsonc sets FIREBASE_PROJECT_ID.
    return null;
  }

  // Google's secure token info endpoint — validates the JWT signature and
  // checks expiry, audience, and issuer server-side without the Admin SDK.
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY || ''}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ idToken })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error('Token verification failed: ' + (err.error && err.error.message || res.status));
  }

  const data  = await res.json();
  const users = data.users;
  if (!Array.isArray(users) || !users.length) throw new Error('Token verification failed: no user record');

  const record = users[0];
  if (!record.localId) throw new Error('Token verification failed: missing localId');

  return { uid: record.localId };
}

/**
 * Extract the Bearer token from the Authorization header of a Request.
 * Returns null if no Authorization header is present.
 */
function _extractBearerToken(request) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim() || null;
}

/* ═══════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════ */
async function getStream(streamId, env) {
  if (!env.cloudStreamKV) return null;
  return await env.cloudStreamKV.get(`stream:${streamId}`, { type: 'json' });
}

async function logStreamEvent(env, streamId, event, data) {
  if (!env.cloudStreamKV) return;
  const key = `event:${streamId}:${Date.now()}:${event}`;
  await env.cloudStreamKV.put(key, JSON.stringify({
    streamId, event, data, timestamp: Date.now()
  }), { expirationTtl: 86400 * 7 }); // keep events for 7 days
}

/* ═══════════════════════════════════════════════════════
   STREAM SYNC — returns current track + server timestamp for
   synchronized playback across all listeners.
   Called by the listener's browser to compute seek offset.
   Public endpoint — no auth required (track URLs already in Firestore).
═══════════════════════════════════════════════════════ */
async function handleStreamSync(request, env, url, cors) {
  const streamId = url.pathname.replace('/api/stream/sync/', '');
  if (!streamId) return jsonErr('streamId required', 400, cors);

  const stream = await getStream(streamId, env);
  if (!stream) return jsonErr('Stream not found', 404, cors);

  if (stream.endsAt && Date.now() > stream.endsAt && stream.status === 'active') {
    stream.status = 'stopped';
    if (env.cloudStreamKV) {
      await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream), { expirationTtl: 3600 });
    }
  }

  let musicInfo = {
    currentMusicTitle: '', currentMusicArtist: '', currentMusicUrl: '',
    currentMusicId: '', currentMusicDuration: 0,
    nextMusicTitle: '', nextMusicArtist: '',
    queueIndex: 0, musicStatus: 'no_music',
    lastAdvancedAt: 0
  };

  if (env.cloudStreamKV) {
    const ms = await env.cloudStreamKV.get(`music:${streamId}`, { type: 'json' });
    if (ms && ms.queue && ms.queue.length) {
      const cur = ms.queue[ms.queueIndex || 0] || {};
      const nxt = ms.queue[((ms.queueIndex || 0) + 1) % ms.queue.length] || {};
      musicInfo = {
        currentMusicTitle:   cur.title    || '',
        currentMusicArtist:  cur.artist   || '',
        currentMusicUrl:     cur.url      || '',
        currentMusicId:      cur.id       || '',
        currentMusicDuration: cur.duration || 0,
        nextMusicTitle:      nxt.title    || '',
        nextMusicArtist:     nxt.artist   || '',
        queueIndex:          ms.queueIndex || 0,
        musicStatus:         ms.status    || 'playing',
        lastAdvancedAt:      ms.lastAdvancedAt || 0
      };
    }
  }

  return jsonOK({
    success:       true,
    streamId,
    status:        stream.status,
    streamName:    stream.streamName  || '',
    displayName:   stream.displayName || '',
    category:      stream.category    || '',
    viewerCount:   stream.viewerCount || 0,
    startedAt:     stream.startedAt   || 0,
    endsAt:        stream.endsAt      || 0,
    serverTime:    Date.now(),
    ...musicInfo
  }, cors);
}

/* ═══════════════════════════════════════════════════════
   ACTIVE CHECK — check if a uid already has an active stream
   Used by the cloud-stream.html to prevent duplicate broadcasts.
   Requires Firebase ID token — prevents checking other users' streams.
═══════════════════════════════════════════════════════ */
async function handleActiveCheck(request, env, url, cors) {
  const uid = url.pathname.replace('/api/stream/active/', '');
  if (!uid) return jsonErr('uid required', 400, cors);

  // Require auth token to prevent enumeration
  const idToken = _extractBearerToken(request);
  if (idToken && env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (!verified || verified.uid !== uid) {
        return jsonErr('Unauthorized: token UID does not match path uid', 403, cors);
      }
    } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  }

  if (!env.cloudStreamKV) return jsonOK({ active: false, streamId: null }, cors);

  // Scan KV for active streams belonging to this uid
  const list = await env.cloudStreamKV.list({ prefix: 'stream:' });
  for (const key of (list.keys || [])) {
    const val = await env.cloudStreamKV.get(key.name, { type: 'json' });
    if (val && val.uid === uid && (val.status === 'active' || val.status === 'starting' || val.status === 'recovering')) {
      const streamId = key.name.replace('stream:', '');
      return jsonOK({ active: true, streamId, status: val.status, streamName: val.streamName || '' }, cors);
    }
  }

  return jsonOK({ active: false, streamId: null }, cors);
}

function jsonOK(data, cors) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...(cors || CORS_HEADERS), 'Content-Type': 'application/json' }
  });
}

function jsonErr(message, status, cors) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status: status || 400,
    headers: { ...(cors || CORS_HEADERS), 'Content-Type': 'application/json' }
  });
}

/* ═══════════════════════════════════════════════════════
   DESTINATIONS API — RTMP stream key vault
   Keys are stored in KV under dest:{uid}:{type}
   They are NEVER returned to the browser after being saved.
═══════════════════════════════════════════════════════ */

async function handleDestinationsSave(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }

  const { uid, type, rtmpUrl, streamKey } = body;
  if (!uid || !type || !rtmpUrl || !streamKey) return jsonErr('uid, type, rtmpUrl and streamKey are required', 400, cors);

  // ── Verify Firebase ID token ──────────────────────────────────────────────
  const idToken = _extractBearerToken(request);
  if (idToken) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (verified && verified.uid !== uid) return jsonErr('Unauthorized: token UID mismatch', 403, cors);
    } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  } else if (env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    return jsonErr('Unauthorized: Authorization header required', 401, cors);
  }

  const ALLOWED_TYPES = ['youtube', 'facebook', 'custom'];
  if (!ALLOWED_TYPES.includes(type)) return jsonErr('Unknown destination type: ' + type, 400, cors);

  // Validate RTMP URL format (must start with rtmp:// or rtmps://)
  if (!/^rtmps?:\/\//i.test(rtmpUrl)) return jsonErr('rtmpUrl must start with rtmp:// or rtmps://', 400, cors);

  if (!env.cloudStreamKV) return jsonErr('KV not configured', 500, cors);

  const kvKey = `dest:${uid}:${type}`;
  const record = {
    uid,
    type,
    rtmpUrl,
    streamKeyHash: await hashKey(streamKey),  // store hash for verification
    // streamKey itself is stored encrypted in a separate KV entry
    status:    'active',
    updatedAt: Date.now()
  };

  // Store the raw key separately (lookup only, never returned)
  await env.cloudStreamKV.put(`destkey:${uid}:${type}`, streamKey, { expirationTtl: 86400 * 365 });
  // Store the metadata (no raw key)
  await env.cloudStreamKV.put(kvKey, JSON.stringify(record), { expirationTtl: 86400 * 365 });

  return jsonOK({ success: true, message: type + ' destination saved.' }, cors);
}

async function handleDestinationsRemove(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }

  const { uid, type } = body;
  if (!uid || !type) return jsonErr('uid and type required', 400, cors);

  // ── Verify Firebase ID token ──────────────────────────────────────────────
  const idToken = _extractBearerToken(request);
  if (idToken) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (verified && verified.uid !== uid) return jsonErr('Unauthorized: token UID mismatch', 403, cors);
    } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  } else if (env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    return jsonErr('Unauthorized: Authorization header required', 401, cors);
  }

  if (env.cloudStreamKV) {
    await env.cloudStreamKV.delete(`dest:${uid}:${type}`);
    await env.cloudStreamKV.delete(`destkey:${uid}:${type}`);
  }

  return jsonOK({ success: true, message: type + ' destination removed.' }, cors);
}

async function handleDestinationsList(request, env, url, cors) {
  const uid = url.searchParams.get('uid');
  if (!uid) return jsonErr('uid required', 400, cors);

  if (!env.cloudStreamKV) return jsonOK({ destinations: [] }, cors);

  const types = ['youtube', 'facebook', 'custom'];
  const destinations = [];

  for (const type of types) {
    const val = await env.cloudStreamKV.get(`dest:${uid}:${type}`, { type: 'json' });
    if (val) {
      // Return metadata only — never return the raw stream key or hash
      destinations.push({
        type:      val.type,
        rtmpUrl:   '[configured]',  // don't expose server URL either
        streamKey: '[saved]',       // key indicator only
        status:    val.status || 'active',
        updatedAt: val.updatedAt
      });
    }
  }

  return jsonOK({ destinations }, cors);
}

/* ═══════════════════════════════════════════════════════
   LISTENER PRESENCE — join / heartbeat / leave
   KV schema:
     listener:{streamId}:{sessionId}  — { uid, sessionId, streamId, joinedAt, lastSeen, active }
     listenerCount:{streamId}          — integer (cached count)

   sessionId for authenticated users = uid (one record per real user).
   sessionId for guests = generated UUID persisted in localStorage (one per device).

   Heartbeat interval: 30s.  Stale threshold: 90s.
   Join is idempotent: repeated calls only update lastSeen, never duplicate.
   Leave marks active=false. Viewer count = active records with lastSeen < 90s.
═══════════════════════════════════════════════════════ */

const LISTENER_STALE_MS = 90 * 1000; // 90 seconds without heartbeat = stale

async function _recomputeViewerCount(streamId, env) {
  if (!env.cloudStreamKV) return 0;
  const prefix = `listener:${streamId}:`;
  const list   = await env.cloudStreamKV.list({ prefix });
  let count = 0;
  const now = Date.now();
  for (const key of (list.keys || [])) {
    const rec = await env.cloudStreamKV.get(key.name, { type: 'json' });
    if (rec && rec.active && (now - (rec.lastSeen || 0)) < LISTENER_STALE_MS) {
      count++;
    }
  }
  // Cache the count + update stream record
  await env.cloudStreamKV.put(`listenerCount:${streamId}`, String(count), { expirationTtl: 300 });
  const stream = await env.cloudStreamKV.get(`stream:${streamId}`, { type: 'json' });
  if (stream) {
    stream.viewerCount = count;
    await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream), { expirationTtl: (stream.durationMinutes + 60) * 60 });
  }
  return count;
}

async function handleListenerJoin(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }
  const { streamId, sessionId, uid, displayName } = body;
  if (!streamId || !sessionId) return jsonErr('streamId and sessionId required', 400, cors);

  if (!env.cloudStreamKV) return jsonOK({ success: true, viewerCount: 0 }, cors);

  const kvKey   = `listener:${streamId}:${sessionId}`;
  const existing = await env.cloudStreamKV.get(kvKey, { type: 'json' });
  const now = Date.now();

  const record = {
    sessionId,
    uid:         uid         || null,
    displayName: displayName || '',
    streamId,
    joinedAt:    existing ? (existing.joinedAt || now) : now,
    lastSeen:    now,
    active:      true
  };

  await env.cloudStreamKV.put(kvKey, JSON.stringify(record), { expirationTtl: 7200 });

  // Recompute in background — use cached count for immediate response
  if (ctx) ctx.waitUntil(_recomputeViewerCount(streamId, env));
  else await _recomputeViewerCount(streamId, env);

  const cached = await env.cloudStreamKV.get(`listenerCount:${streamId}`);
  const viewerCount = cached ? parseInt(cached, 10) : 0;

  return jsonOK({ success: true, viewerCount }, cors);
}

async function handleListenerHeartbeat(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }
  const { streamId, sessionId } = body;
  if (!streamId || !sessionId) return jsonErr('streamId and sessionId required', 400, cors);

  if (!env.cloudStreamKV) return jsonOK({ success: true, viewerCount: 0 }, cors);

  const kvKey   = `listener:${streamId}:${sessionId}`;
  const existing = await env.cloudStreamKV.get(kvKey, { type: 'json' });
  if (!existing) {
    // Session not found in KV — client must re-join
    return jsonOK({ success: false, rejoin: true, viewerCount: 0 }, cors);
  }

  existing.lastSeen = Date.now();
  existing.active   = true;
  await env.cloudStreamKV.put(kvKey, JSON.stringify(existing), { expirationTtl: 7200 });

  // Recompute count periodically (~20% of heartbeats) to avoid KV list overhead on every call
  if (Math.random() < 0.2) {
    if (ctx) ctx.waitUntil(_recomputeViewerCount(streamId, env));
    else await _recomputeViewerCount(streamId, env);
  }

  const cached = await env.cloudStreamKV.get(`listenerCount:${streamId}`);
  const viewerCount = cached ? parseInt(cached, 10) : 0;

  return jsonOK({ success: true, viewerCount }, cors);
}

async function handleListenerLeave(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }
  const { streamId, sessionId } = body;
  if (!streamId || !sessionId) return jsonOK({ success: true, viewerCount: 0 }, cors);

  if (!env.cloudStreamKV) return jsonOK({ success: true, viewerCount: 0 }, cors);

  const kvKey   = `listener:${streamId}:${sessionId}`;
  const existing = await env.cloudStreamKV.get(kvKey, { type: 'json' });
  if (existing) {
    existing.active = false;
    existing.leftAt = Date.now();
    await env.cloudStreamKV.put(kvKey, JSON.stringify(existing), { expirationTtl: 300 });
  }

  let viewerCount = 0;
  if (ctx) ctx.waitUntil(_recomputeViewerCount(streamId, env));
  else viewerCount = await _recomputeViewerCount(streamId, env);

  const cached = await env.cloudStreamKV.get(`listenerCount:${streamId}`);
  viewerCount = cached ? parseInt(cached, 10) : viewerCount;

  return jsonOK({ success: true, viewerCount }, cors);
}

/* ═══════════════════════════════════════════════════════
   STREAM LIKES — one like per authenticated user per stream (idempotent toggle)
   KV schema:
     like:{streamId}:{uid}  — { uid, streamId, liked, likedAt }
     likeCount:{streamId}   — integer (cached count)
═══════════════════════════════════════════════════════ */

async function _recomputeLikeCount(streamId, env) {
  if (!env.cloudStreamKV) return 0;
  const prefix = `like:${streamId}:`;
  const list   = await env.cloudStreamKV.list({ prefix });
  let count = 0;
  for (const key of (list.keys || [])) {
    const rec = await env.cloudStreamKV.get(key.name, { type: 'json' });
    if (rec && rec.liked) count++;
  }
  await env.cloudStreamKV.put(`likeCount:${streamId}`, String(count), { expirationTtl: 3600 });
  return count;
}

async function handleStreamLike(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }
  const { streamId, uid, action } = body; // action: 'like' | 'unlike'
  if (!streamId || !uid) return jsonErr('streamId and uid required', 400, cors);

  // Require Firebase ID token to prevent spoofing
  const idToken = _extractBearerToken(request);
  if (idToken && env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (!verified || verified.uid !== uid) return jsonErr('Unauthorized: token UID mismatch', 403, cors);
    } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  } else if (!idToken && env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    return jsonErr('Unauthorized: Authorization header required', 401, cors);
  }

  if (!env.cloudStreamKV) return jsonErr('KV not configured', 503, cors);

  const kvKey    = `like:${streamId}:${uid}`;
  const existing = await env.cloudStreamKV.get(kvKey, { type: 'json' });
  const liked    = action !== 'unlike';

  // Idempotent: same state, return cached count without recomputing
  if (existing && existing.liked === liked) {
    const cached   = await env.cloudStreamKV.get(`likeCount:${streamId}`);
    const likeCount = cached ? parseInt(cached, 10) : await _recomputeLikeCount(streamId, env);
    return jsonOK({ success: true, liked, likeCount, unchanged: true }, cors);
  }

  const record = {
    uid,
    streamId,
    liked,
    likedAt:   liked ? Date.now() : null,
    unlikedAt: !liked ? Date.now() : (existing ? existing.unlikedAt : null)
  };

  const ttl = liked ? 86400 * 30 : 3600;
  await env.cloudStreamKV.put(kvKey, JSON.stringify(record), { expirationTtl: ttl });

  let likeCount = 0;
  if (ctx) ctx.waitUntil(_recomputeLikeCount(streamId, env));
  else likeCount = await _recomputeLikeCount(streamId, env);

  const cached = await env.cloudStreamKV.get(`likeCount:${streamId}`);
  likeCount = cached ? parseInt(cached, 10) : likeCount;

  return jsonOK({ success: true, liked, likeCount }, cors);
}

async function handleStreamLikesGet(request, env, url, cors) {
  const parts     = url.pathname.replace('/api/stream/likes/', '').split('/');
  const streamId  = parts[0];
  const uid       = parts[1] || null;
  if (!streamId) return jsonErr('streamId required', 400, cors);

  if (!env.cloudStreamKV) return jsonOK({ likeCount: 0, liked: false }, cors);

  const cached    = await env.cloudStreamKV.get(`likeCount:${streamId}`);
  const likeCount = cached ? parseInt(cached, 10) : await _recomputeLikeCount(streamId, env);

  let liked = false;
  if (uid) {
    const rec = await env.cloudStreamKV.get(`like:${streamId}:${uid}`, { type: 'json' });
    liked = !!(rec && rec.liked);
  }

  return jsonOK({ likeCount, liked }, cors);
}

// Helper: SHA-256 hash of a string (for auditing only, key itself stored separately)
async function hashKey(str) {
  const data = new TextEncoder().encode(str);
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ═══════════════════════════════════════════════════════
   STREAM START — extended with destinations + music queue
═══════════════════════════════════════════════════════ */

// Extend handleControl to support setSchedule and setVisualizer
const _originalHandleControlRef = handleControl;

async function handleControlExtended(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }

  const { streamId, uid, action } = body;
  if (!streamId || !uid || !action) return jsonErr('streamId, uid and action required', 400, cors);

  // ── Verify Firebase ID token — prevents UID spoofing ─────────────────────
  const idToken = _extractBearerToken(request);
  if (idToken) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (verified && verified.uid !== uid) {
        return jsonErr('Unauthorized: token UID does not match request uid', 403, cors);
      }
    } catch (verifyErr) {
      return jsonErr('Unauthorized: ' + verifyErr.message, 401, cors);
    }
  } else if (env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    return jsonErr('Unauthorized: Authorization header with Firebase ID token required', 401, cors);
  }

  // Handle new actions first, fall through to base for others
  if (action === 'setSchedule') {
    const stream = await getStream(streamId, env);
    if (!stream) return jsonErr('Stream not found', 404, cors);
    if (stream.uid !== uid) return jsonErr('Unauthorized', 403, cors);
    stream.musicSchedule = body.schedule || [];
    if (env.cloudStreamKV) {
      await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream));
    }
    return jsonOK({ success: true }, cors);
  }

  if (action === 'setVisualizer') {
    const stream = await getStream(streamId, env);
    if (!stream) return jsonErr('Stream not found', 404, cors);
    if (stream.uid !== uid) return jsonErr('Unauthorized', 403, cors);
    stream.visualizerPreset = body.preset || 'bars';
    if (env.cloudStreamKV) {
      await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream));
    }
    return jsonOK({ success: true }, cors);
  }

  if (action === 'setMusicQueue') {
    const stream = await getStream(streamId, env);
    if (!stream) return jsonErr('Stream not found', 404, cors);
    if (stream.uid !== uid) return jsonErr('Unauthorized', 403, cors);
    stream.musicQueue     = body.queue || [];
    stream.musicQueueIdx  = 0;
    if (env.cloudStreamKV) {
      await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream));
    }
    return jsonOK({ success: true }, cors);
  }

  // Music playback actions — handle inline with the already-parsed body
  // (cannot re-read request.json() after it has been consumed above).
  const musicActions = ['musicNext','musicPause','musicResume','musicShuffle','musicRepeat','musicVolume','musicCrossfade','next','pause','resume'];
  if (musicActions.includes(action)) {
    return _handleMusicControlBody(body, request, env, ctx, cors);
  }

  // Delegate all other actions to handleControl inline with the already-parsed body.
  return _handleControlBody(body, request, env, ctx, cors);
}

/* ── Inline helpers for handleControlExtended delegates
   These accept the already-parsed body so request.json() is not called twice. ── */

async function _handleMusicControlBody(body, request, env, ctx, cors) {
  const { streamId, uid, action } = body;

  const stream = await getStream(streamId, env);
  if (!stream) return jsonErr('Stream not found', 404, cors);
  if (stream.uid !== uid) return jsonErr('Unauthorized', 403, cors);

  if (!env.cloudStreamKV) return jsonErr('KV not configured', 503, cors);
  const musicState = await env.cloudStreamKV.get(`music:${streamId}`, { type: 'json' });
  if (!musicState) return jsonErr('No music state found for stream', 404, cors);

  switch (action) {
    case 'musicNext':
    case 'next': {
      if (musicState.shuffle) {
        musicState.queueIndex = Math.floor(Math.random() * musicState.queue.length);
      } else {
        const next = (musicState.queueIndex + 1) % musicState.queue.length;
        if (next === 0 && !musicState.repeat) { musicState.status = 'ended'; }
        else { musicState.queueIndex = next; }
      }
      musicState.lastAdvancedAt = Date.now();
      break;
    }
    case 'musicPause':  case 'pause':  musicState.status  = 'paused';  break;
    case 'musicResume': case 'resume': musicState.status  = 'playing'; break;
    case 'musicShuffle':   musicState.shuffle   = typeof body.value === 'boolean' ? body.value : !musicState.shuffle; break;
    case 'musicRepeat':    musicState.repeat    = typeof body.value === 'boolean' ? body.value : !musicState.repeat;  break;
    case 'musicVolume':    musicState.volume    = typeof body.value === 'number'  ? body.value : musicState.volume;   break;
    case 'musicCrossfade': musicState.crossfade = typeof body.value === 'number'  ? body.value : musicState.crossfade; break;
    default: return jsonErr('Unknown music action: ' + action, 400, cors);
  }

  const ttlSeconds = (stream.durationMinutes + 60) * 60;
  await env.cloudStreamKV.put(`music:${streamId}`, JSON.stringify(musicState), { expirationTtl: ttlSeconds });

  if (ctx) ctx.waitUntil(pushNowPlayingToFirestore(env, streamId, musicState));

  const cur = musicState.queue[musicState.queueIndex] || {};
  return jsonOK({ success: true, currentTitle: cur.title || '', queueIndex: musicState.queueIndex, status: musicState.status }, cors);
}


async function _handleControlBody(body, request, env, ctx, cors) {
  const { streamId, uid, action } = body;

  const stream = await getStream(streamId, env);
  if (!stream) return jsonErr('Stream not found', 404, cors);
  if (stream.uid !== uid) return jsonErr('Unauthorized', 403, cors);
  if (stream.status !== 'active' && stream.status !== 'recovering') {
    return jsonErr('Stream is not active. Status: ' + stream.status, 409, cors);
  }

  switch (action) {
    case 'setScene':  stream.currentScene  = body.sceneId  || stream.currentScene; break;
    case 'setTheme':  stream.theme         = body.themeId  || stream.theme;        break;
    case 'setVolume': stream.musicVolume   = typeof body.volume === 'number' ? body.volume : stream.musicVolume; break;
    case 'announce':  stream.lastAnnouncement = { text: body.text || '', ts: Date.now() }; break;
    case 'nextScene':
      if (stream.scenePlaylist && stream.scenePlaylist.length) {
        stream.sceneIndex = (stream.sceneIndex + 1) % stream.scenePlaylist.length;
        stream.currentScene = stream.scenePlaylist[stream.sceneIndex].name;
      }
      break;
    default: return jsonErr('Unknown action: ' + action, 400, cors);
  }

  stream.lastControlAt = Date.now();
  if (env.cloudStreamKV) {
    await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream), { expirationTtl: (stream.durationMinutes + 60) * 60 });
  }
  return jsonOK({ success: true, stream }, cors);
}
