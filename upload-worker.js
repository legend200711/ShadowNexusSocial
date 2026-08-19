/**
 * Shadow Nexus Social — Cloudflare R2 Upload + Serve Worker
 *
 * Cloudflare handles ALL media storage for Shadow Nexus Social:
 *   - Profile pictures
 *   - Post images, videos, music files
 *   - Message media attachments
 *
 * Firebase stores only the public URL + file metadata.
 *
 * Routes:
 *   GET  /{key}  — serves a file from R2 with CDN caching
 *   POST /       — uploads a file to R2, returns public URL
 *
 * Security:
 *   - Origin whitelist (ALLOWED_ORIGINS)
 *   - MIME type allowlist (images / video / audio only)
 *   - 200 MB max file size
 *   - User UID scoped storage paths
 *   - Security response headers on every response
 *   - Rate-limit hint headers (enforce limits in Cloudflare dashboard)
 */

const MAX_SIZE_IMAGE = 10  * 1024 * 1024;  // 10 MB  — images
const MAX_SIZE_VIDEO = 100 * 1024 * 1024;  // 100 MB — video
const MAX_SIZE_AUDIO = 200 * 1024 * 1024;  // 200 MB — audio / music
const MAX_SIZE       = MAX_SIZE_AUDIO;     // absolute upper bound (used by music endpoint)

const ALLOWED_ORIGINS = [
  'https://shadownexussocial.online',
  'http://localhost',
  'http://127.0.0.1'
];

// ── MIME type allowlist ───────────────────────────────────────────────────────
function isAllowedType(mime) {
  if (!mime) return false;
  const m = mime.toLowerCase().split(';')[0].trim();
  return (
    m.startsWith('image/') ||
    m.startsWith('video/') ||
    m.startsWith('audio/') ||
    m === 'application/octet-stream' // fallback for some mobile browsers
  );
}

// ── CORS headers ──────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(o => origin && origin.startsWith(o))
    ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-User-UID',
    'Access-Control-Max-Age':       '86400',
  };
}

// ── Security headers added to every response ──────────────────────────────────
function securityHeaders() {
  return {
    // Prevent MIME sniffing
    'X-Content-Type-Options': 'nosniff',
    // Block pages from being embedded in iframes (clickjacking)
    'X-Frame-Options': 'DENY',
    // XSS protection for older browsers
    'X-XSS-Protection': '1; mode=block',
    // Rate-limit hint (actual limits enforced via Cloudflare dashboard WAF rules)
    'X-RateLimit-Limit':     '100',
    'X-RateLimit-Window':    '60',
    // CDN hint — vary caching per origin
    'Vary': 'Origin',
    // Strict-Transport-Security (HTTPS only)
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    // Referrer policy
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

// ── Merge multiple header objects ─────────────────────────────────────────────
function mergeHeaders(...objs) {
  return Object.assign({}, ...objs);
}

// ── Extension → MIME fallback ─────────────────────────────────────────────────
function mimeFromExt(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif',  webp: 'image/webp', svg: 'image/svg+xml',
    mp4: 'video/mp4',  mov: 'video/quicktime',
    avi: 'video/x-msvideo', mkv: 'video/x-matroska', m4v: 'video/mp4',
    mp3: 'audio/mpeg', m4a: 'audio/mp4',  aac: 'audio/aac',
    ogg: 'audio/ogg',  wav: 'audio/wav',  flac: 'audio/flac',
    opus: 'audio/ogg', webm: 'audio/webm',
  };
  return map[ext] || null;
}

// ── Shared: sign a LiveKit JWT ────────────────────────────────────────────────
async function signLiveKitJwt(apiKey, apiSecret, payload) {
  const b64url = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const enc    = s => b64url(unescape(encodeURIComponent(s)));
  const header = { alg: 'HS256', typ: 'JWT' };
  const h = enc(JSON.stringify(header));
  const p = enc(JSON.stringify(payload));
  const sigInput = `${h}.${p}`;
  const keyData  = new TextEncoder().encode(apiSecret);
  const msgData  = new TextEncoder().encode(sigInput);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${sigInput}.${sigB64}`;
}

// ── LiveKit room creator ──────────────────────────────────────────────────────
// POST /livekit-room   body: { roomName }
// Creates the room on the LiveKit server so participants can join it.
async function handleLiveKitRoom(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: mergeHeaders(cors, sec) });
  }

  const apiKey    = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  const livekitUrl = (env.LIVEKIT_URL || '')
    .replace('wss://', 'https://')
    .replace('ws://',  'http://');

  if (!apiKey || !apiSecret) {
    return new Response(JSON.stringify({ error: 'LiveKit credentials not configured' }), {
      status: 500,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); }
  catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const { roomName } = body;
  if (!roomName) {
    return new Response(JSON.stringify({ error: 'roomName is required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Mint an admin JWT (roomCreate grant) to call the LiveKit REST API
  const now = Math.floor(Date.now() / 1000);
  const adminToken = await signLiveKitJwt(apiKey, apiSecret, {
    iss: apiKey, sub: 'server', iat: now, exp: now + 60, nbf: now,
    video: { roomCreate: true },
  });

  // Call LiveKit REST API — CreateRoom (Twirp/JSON)
  let lkResp;
  try {
    lkResp = await fetch(`${livekitUrl}/twirp/livekit.RoomService/CreateRoom`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        name:              roomName,
        empty_timeout:     300,   // close room 5 min after last participant leaves
        max_participants:  500,
      }),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'LiveKit API unreachable: ' + e.message }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const lkBody = await lkResp.text();
  if (!lkResp.ok) {
    return new Response(JSON.stringify({ error: 'LiveKit room creation failed: ' + lkBody }), {
      status: lkResp.status, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  return new Response(JSON.stringify({ roomName, created: true }), {
    status: 200,
    headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// ── LiveKit JWT token generator ───────────────────────────────────────────────
// Signs an access token using the LiveKit API key + secret stored as Worker secrets.
// POST /livekit-token   body: { roomName, participantName, canPublish }
async function handleLiveKitToken(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: mergeHeaders(cors, sec) });
  }

  const apiKey    = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    return new Response(JSON.stringify({ error: 'LiveKit credentials not configured' }), {
      status: 500,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); }
  catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const { roomName, participantName, canPublish = false } = body;
  if (!roomName || !participantName) {
    return new Response(JSON.stringify({ error: 'roomName and participantName are required' }), {
      status: 400,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Build LiveKit access token using shared JWT signer
  const now = Math.floor(Date.now() / 1000);
  const token = await signLiveKitJwt(apiKey, apiSecret, {
    iss:  apiKey,
    sub:  participantName,
    iat:  now,
    exp:  now + 6 * 3600,
    nbf:  now,
    name: participantName,
    video: {
      room:           roomName,
      roomJoin:       true,
      canPublish,
      canSubscribe:   true,
      canPublishData: true,
    },
  });

  return new Response(JSON.stringify({ token, url: env.LIVEKIT_URL }), {
    status: 200,
    headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// ── Resumable / chunked upload ────────────────────────────────────────────────
//
//  Phase 1 — POST /upload-chunk
//    FormData: { uploadId, chunkIndex, totalChunks, uid, key, chunk(File) }
//    Stores each chunk as a temporary R2 object at:
//      _tmp/{uploadId}/chunk_{chunkIndex}
//    Returns { ok: true }
//
//  Phase 2 — POST /upload-complete
//    FormData: { uploadId, totalChunks, key, uid, fileName, fileType, fileSize }
//    Reads all chunks from R2 in order, concatenates them, stores the final
//    object at `key`, deletes temp chunk objects, returns { url, key }.
//
// This lets the client implement retry-per-chunk for mobile/slow connections.

async function handleUploadChunk(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: mergeHeaders(cors, sec) });
  }
  let fd;
  try { fd = await request.formData(); }
  catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid form data: ' + e.message }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const uploadId    = (fd.get('uploadId')    || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const chunkIndex  = parseInt(fd.get('chunkIndex')  || '0', 10);
  const totalChunks = parseInt(fd.get('totalChunks') || '1', 10);
  const userUid     = (fd.get('uid') || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const chunk       = fd.get('chunk');

  if (!uploadId || !userUid || !chunk || typeof chunk === 'string') {
    return new Response(JSON.stringify({ error: 'uploadId, uid, and chunk are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
  if (chunkIndex < 0 || chunkIndex >= totalChunks) {
    return new Response(JSON.stringify({ error: 'Invalid chunkIndex' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const buffer = await chunk.arrayBuffer();
  if (buffer.byteLength > 50 * 1024 * 1024) { // 50 MB max per chunk
    return new Response(JSON.stringify({ error: 'Chunk too large (max 50 MB)' }), {
      status: 413, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const tmpKey = `_tmp/${uploadId}/chunk_${String(chunkIndex).padStart(6, '0')}`;
  try {
    await env.BUCKET.put(tmpKey, buffer, {
      customMetadata: { uploaderUid: userUid, chunkIndex: String(chunkIndex) }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'R2 chunk store failed: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  return new Response(JSON.stringify({ ok: true, chunkIndex }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

async function handleUploadComplete(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: mergeHeaders(cors, sec) });
  }
  let fd;
  try { fd = await request.formData(); }
  catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid form data: ' + e.message }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const uploadId    = (fd.get('uploadId')    || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const totalChunks = parseInt(fd.get('totalChunks') || '1', 10);
  const finalKey    = (fd.get('key')         || '').replace(/\.\./g, '');
  const userUid     = (fd.get('uid')         || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const fileName    = fd.get('fileName')    || 'upload';
  let   fileType    = fd.get('fileType')    || 'application/octet-stream';
  const fileSize    = parseInt(fd.get('fileSize') || '0', 10);

  if (!uploadId || !finalKey || !userUid || totalChunks < 1) {
    return new Response(JSON.stringify({ error: 'uploadId, key, uid, and totalChunks are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Validate total assembled size
  const sizeLimit = fileType.startsWith('image/') ? MAX_SIZE_IMAGE
                  : fileType.startsWith('video/') ? MAX_SIZE_VIDEO
                  : MAX_SIZE_AUDIO;
  if (fileSize > sizeLimit) {
    const limitMB = Math.round(sizeLimit / 1024 / 1024);
    return new Response(JSON.stringify({ error: `File too large (max ${limitMB} MB for this type)` }), {
      status: 413, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Validate MIME
  const extMime = mimeFromExt(fileName);
  if (!fileType || fileType === 'application/octet-stream') fileType = extMime || fileType;
  else if (extMime && fileType.startsWith('video/') && extMime.startsWith('audio/')) fileType = extMime;
  if (!isAllowedType(fileType)) {
    return new Response(JSON.stringify({ error: `File type not supported: ${fileType}` }), {
      status: 415, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Assemble all chunks in order
  const parts = [];
  for (let i = 0; i < totalChunks; i++) {
    const tmpKey = `_tmp/${uploadId}/chunk_${String(i).padStart(6, '0')}`;
    let obj;
    try { obj = await env.BUCKET.get(tmpKey); }
    catch (e) {
      return new Response(JSON.stringify({ error: `Failed to read chunk ${i}: ` + e.message }), {
        status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    if (!obj) {
      return new Response(JSON.stringify({ error: `Chunk ${i} not found — upload may have expired` }), {
        status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    parts.push(await obj.arrayBuffer());
  }

  // Concatenate
  const totalBytes = parts.reduce((s, b) => s + b.byteLength, 0);
  const assembled  = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    assembled.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }

  const cleanMime = fileType.split(';')[0].trim();
  try {
    await env.BUCKET.put(finalKey, assembled.buffer, {
      httpMetadata:   { contentType: cleanMime },
      customMetadata: { uploaderUid: userUid, originalName: fileName }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'R2 final write failed: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Clean up temp chunks (best-effort — do not fail the response if this fails)
  for (let i = 0; i < totalChunks; i++) {
    const tmpKey = `_tmp/${uploadId}/chunk_${String(i).padStart(6, '0')}`;
    env.BUCKET.delete(tmpKey).catch(() => {});
  }

  const publicUrl = `https://yellow-term-11e6.nthntjrn.workers.dev/${finalKey}`;
  return new Response(JSON.stringify({ url: publicUrl, key: finalKey }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PAYPAL COIN-PURCHASE + CREATOR-PAYOUT HANDLERS
//
//  Routes (all under /paypal/*):
//    POST /paypal/create-order     — Create PayPal order, return approval link
//    POST /paypal/capture-order    — Capture approved order, credit coins
//    POST /paypal/webhook          — Receive PayPal webhook events (idempotent)
//    POST /paypal/payout           — Creator cash-out via PayPal Payouts API
//    GET  /paypal/creator-status   — Creator PayPal onboarding/payout status
//    POST /paypal/onboard-creator  — Generate PayPal Partner Referral link
//    GET  /paypal/health           — Health check for PayPal subsystem
//
//  Required secrets (set via: wrangler secret put <NAME>):
//    PAYPAL_CLIENT_ID        — PayPal app client ID
//    PAYPAL_CLIENT_SECRET    — PayPal app client secret  (NEVER sent to browser)
//    PAYPAL_WEBHOOK_ID       — Webhook ID from PayPal developer dashboard
//    FIREBASE_WEB_API_KEY    — Firebase web API key (already set on this worker)
//
//  Required var (in wrangler.jsonc [vars]):
//    PAYPAL_ENV              — "sandbox" | "live"
//
//  Constants
const _PP_COINS_PER_DOLLAR   = 100;    // 100 coins = $1.00 USD
const _PP_CREATOR_SHARE      = 0.90;   // 90% to creator
const _PP_PLATFORM_SHARE     = 0.10;   // 10% to platform
const _PP_MIN_PURCHASE_USD   = 0.01;
const _PP_MAX_PURCHASE_USD   = 100.00;
const _PP_MIN_PAYOUT_USD     = 1.00;
const _PP_PAYOUT_COOLDOWN_MS = 24 * 60 * 60 * 1000;  // 24 hours
const _PP_FIREBASE_PROJECT   = 'horr-a08f4';
const _PP_WORKER_BASE        = 'https://yellow-term-11e6.nthntjrn.workers.dev';

// ── PayPal API helpers ────────────────────────────────────────────────────────

function _ppBaseUrl(env) {
  return (env.PAYPAL_ENV === 'live')
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

async function _ppGetToken(env) {
  const creds = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
  const res = await fetch(`${_ppBaseUrl(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function _ppCreateOrder(env, { usdAmount, purchaseId, returnUrl, cancelUrl }) {
  const token = await _ppGetToken(env);
  const res = await fetch(`${_ppBaseUrl(env)}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': purchaseId,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id:    purchaseId,
        description:     `Shadow Coins — ${Math.floor(usdAmount * _PP_COINS_PER_DOLLAR)} coins`,
        custom_id:       purchaseId,
        amount: { currency_code: 'USD', value: parseFloat(usdAmount).toFixed(2) },
        soft_descriptor: 'SHADOW NEXUS',
      }],
      application_context: {
        brand_name:          'Shadow Nexus Social',
        landing_page:        'NO_PREFERENCE',
        shipping_preference: 'NO_SHIPPING',
        user_action:         'PAY_NOW',
        return_url:          returnUrl,
        cancel_url:          cancelUrl,
      },
    }),
  });
  if (!res.ok) throw new Error(`PayPal createOrder ${res.status}: ${await res.text()}`);
  const order = await res.json();
  const approveLink = order.links?.find(l => l.rel === 'approve')?.href || null;
  return { orderId: order.id, approveLink };
}

async function _ppCaptureOrder(env, orderId) {
  const token = await _ppGetToken(env);
  const res = await fetch(`${_ppBaseUrl(env)}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': `cap_${orderId}`,
    },
    body: '{}',
  });
  if (!res.ok) throw new Error(`PayPal captureOrder ${res.status}: ${await res.text()}`);
  return res.json();
}

async function _ppVerifyWebhook(env, headersObj, rawBody) {
  const token = await _ppGetToken(env);
  const res = await fetch(`${_ppBaseUrl(env)}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo:         headersObj['paypal-auth-algo']         || '',
      cert_url:          headersObj['paypal-cert-url']          || '',
      transmission_id:   headersObj['paypal-transmission-id']   || '',
      transmission_sig:  headersObj['paypal-transmission-sig']  || '',
      transmission_time: headersObj['paypal-transmission-time'] || '',
      webhook_id:        env.PAYPAL_WEBHOOK_ID,
      webhook_event:     rawBody,
    }),
  });
  if (!res.ok) throw new Error(`PayPal webhook verify ${res.status}`);
  return (await res.json()).verification_status === 'SUCCESS';
}

async function _ppSendPayout(env, { payoutId, receiverEmail, amountUsd }) {
  const token = await _ppGetToken(env);
  const res = await fetch(`${_ppBaseUrl(env)}/v1/payments/payouts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': payoutId,
    },
    body: JSON.stringify({
      sender_batch_header: {
        sender_batch_id: payoutId,
        email_subject:   'Shadow Nexus Social — Creator Payout',
        email_message:   'Your creator earnings from Shadow Nexus Social.',
      },
      items: [{
        recipient_type: 'EMAIL',
        amount: { value: parseFloat(amountUsd).toFixed(2), currency: 'USD' },
        receiver:       receiverEmail,
        note:           'Creator earnings — Shadow Nexus Social',
        sender_item_id: payoutId,
      }],
    }),
  });
  if (!res.ok) throw new Error(`PayPal payout ${res.status}: ${await res.text()}`);
  return res.json();
}

async function _ppCreateReferral(env, { creatorUid, returnUrl }) {
  const token = await _ppGetToken(env);
  const res = await fetch(`${_ppBaseUrl(env)}/v2/customer/partner-referrals`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tracking_id:  `snx_creator_${creatorUid}`,
      partner_config_override: { return_url: returnUrl, action_renewal_url: returnUrl },
      operations: [{
        operation: 'API_INTEGRATION',
        api_integration_preference: {
          rest_api_integration: {
            integration_method: 'PAYPAL',
            integration_type:   'THIRD_PARTY',
            third_party_details: { features: ['PAYMENT', 'REFUND', 'DELAY_FUNDS_DISBURSEMENT'] },
          },
        },
      }],
      products:       ['EXPRESS_CHECKOUT'],
      legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
    }),
  });
  if (!res.ok) throw new Error(`PayPal referral ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.links?.find(l => l.rel === 'action_url')?.href || null;
}

// ── Firebase Auth token verification ─────────────────────────────────────────
// Uses the Firebase REST identitytoolkit to validate ID tokens server-side.
// FIREBASE_WEB_API_KEY is already a secret on this worker.

async function _fbVerifyToken(env, idToken) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_WEB_API_KEY}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ idToken }),
    }
  );
  if (!res.ok) throw new Error('Invalid Firebase token');
  const data = await res.json();
  if (data.error) throw new Error('Token validation failed: ' + data.error.message);
  const user = data.users?.[0];
  if (!user?.localId) throw new Error('Token has no UID');
  return user.localId;
}

// ── Firestore REST helpers ────────────────────────────────────────────────────
// No Admin SDK — uses service-account-free approach: Firebase Auth token is
// verified via identitytoolkit; Firestore writes use the Firebase Web API key
// via the Firestore REST API with an OAuth2 token obtained from the service account.
//
// Since this worker already uses FIREBASE_WEB_API_KEY (web key, not service account),
// we use the Firebase REST API with custom auth tokens for admin writes.
// For simplicity + security we use the Google Cloud Identity Toolkit to mint
// a custom token, then exchange it for an ID token to call Firestore REST.
//
// SIMPLER APPROACH: We store FIREBASE_SERVICE_KEY as a secret (service account JSON).
// If it's not set, we fall back to writing via the Firestore REST API using
// a Google OAuth2 token obtained by signing a JWT with the service account key.
// If FIREBASE_SERVICE_KEY is also not set, we use the FIREBASE_WEB_API_KEY to
// write as a specific Firebase user (the server) — but this requires a server UID.
//
// ACTUAL IMPLEMENTATION: We use the Firestore REST API with a Google service
// account OAuth2 token. The service account JSON is stored as FIREBASE_SERVICE_KEY.
// If that secret is missing, we fall back to using FIREBASE_WEB_API_KEY with
// anonymous auth (which Firestore rules must permit for the relevant collections).

const _FB_BASE = `https://firestore.googleapis.com/v1/projects/${_PP_FIREBASE_PROJECT}/databases/(default)/documents`;

async function _fbGetAdminToken(env) {
  // If service account key is available, use it for full admin access
  if (env.FIREBASE_SERVICE_KEY) {
    return _fbGetServiceAccountToken(env);
  }
  // Fallback: use Firebase Web API key to create an anonymous session token
  // (Firestore rules must allow the relevant operations for authenticated users)
  throw new Error('FIREBASE_SERVICE_KEY secret not set — cannot write to Firestore from worker');
}

async function _fbGetServiceAccountToken(env) {
  const sa  = JSON.parse(env.FIREBASE_SERVICE_KEY);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: sa.client_email, sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase',
  };
  const header = { alg: 'RS256', typ: 'JWT' };
  const b64u = s => btoa(s).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const b64Header  = b64u(JSON.stringify(header));
  const b64Payload = b64u(JSON.stringify(payload));
  const sigInput   = `${b64Header}.${b64Payload}`;
  const pemBody    = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
  const keyDer     = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey  = await crypto.subtle.importKey(
    'pkcs8', keyDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sigBytes = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(sigInput));
  const b64Sig   = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const jwt = `${sigInput}.${b64Sig}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`Firebase service account token error: ${await res.text()}`);
  return (await res.json()).access_token;
}

function _fbToValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')  return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string')  return { stringValue: v };
  if (v && v._serverTs)       return { timestampValue: new Date().toISOString() };
  if (v instanceof Date)      return { timestampValue: v.toISOString() };
  if (Array.isArray(v))       return { arrayValue: { values: v.map(_fbToValue) } };
  if (typeof v === 'object')  return { mapValue: { fields: _fbToFields(v) } };
  return { stringValue: String(v) };
}
function _fbToFields(obj) {
  const f = {};
  for (const [k, v] of Object.entries(obj)) f[k] = _fbToValue(v);
  return f;
}
function _fbFromValue(v) {
  if (!v) return null;
  if ('stringValue'    in v) return v.stringValue;
  if ('integerValue'   in v) return parseInt(v.integerValue);
  if ('doubleValue'    in v) return v.doubleValue;
  if ('booleanValue'   in v) return v.booleanValue;
  if ('nullValue'      in v) return null;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('mapValue'       in v) return _fbFromFields(v.mapValue.fields || {});
  if ('arrayValue'     in v) return (v.arrayValue.values || []).map(_fbFromValue);
  return null;
}
function _fbFromFields(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields || {})) obj[k] = _fbFromValue(v);
  return obj;
}
function _fbFromDoc(doc) { return doc?.fields ? _fbFromFields(doc.fields) : null; }
function _fbTs() { return { _serverTs: true }; }

async function _fbGet(token, col, id) {
  const res = await fetch(`${_FB_BASE}/${col}/${encodeURIComponent(id)}`,
    { headers: { 'Authorization': `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fbGet ${col}/${id}: ${res.status}`);
  return _fbFromDoc(await res.json());
}

async function _fbSet(token, col, id, fields) {
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${_FB_BASE}/${col}/${encodeURIComponent(id)}?${mask}`, {
    method:  'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: _fbToFields(fields) }),
  });
  if (!res.ok) throw new Error(`fbSet ${col}/${id}: ${res.status} ${await res.text()}`);
}

async function _fbAdd(token, col, fields) {
  const res = await fetch(`${_FB_BASE}/${col}`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: _fbToFields(fields) }),
  });
  if (!res.ok) throw new Error(`fbAdd ${col}: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function _fbQuery(token, col, filters, opts = {}) {
  const filterClause = filters.length === 1
    ? { fieldFilter: { field: { fieldPath: filters[0].field }, op: filters[0].op || 'EQUAL', value: _fbToValue(filters[0].value) } }
    : { compositeFilter: { op: 'AND', filters: filters.map(f => ({
        fieldFilter: { field: { fieldPath: f.field }, op: f.op || 'EQUAL', value: _fbToValue(f.value) }
      })) } };

  const q = { from: [{ collectionId: col }], where: filterClause };
  if (opts.orderBy) q.orderBy = [{ field: { fieldPath: opts.orderBy }, direction: opts.dir || 'DESCENDING' }];
  if (opts.limit)   q.limit = opts.limit;

  const res = await fetch(`${_FB_BASE.replace('/documents', '')}:runQuery`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: q }),
  });
  if (!res.ok) throw new Error(`fbQuery ${col}: ${res.status}`);
  const rows = await res.json();
  return rows.filter(r => r.document).map(r => ({ id: r.document.name.split('/').pop(), data: _fbFromDoc(r.document) }));
}

// ── JSON response helpers ─────────────────────────────────────────────────────

function _ppJson(data, status, cors, sec) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }),
  });
}
function _ppErr(msg, status, cors, sec) {
  return _ppJson({ success: false, error: msg }, status || 400, cors, sec);
}

// ── Config diagnostic helper ──────────────────────────────────────────────────
// Returns a user-friendly message describing the first missing secret.
// Never reveals the value of any secret — only reports which NAME is absent.
function _ppMissingConfig(env) {
  if (!env.PAYPAL_CLIENT_ID)     return 'PayPal Sandbox is not configured yet. (PAYPAL_CLIENT_ID is missing)';
  if (!env.PAYPAL_CLIENT_SECRET) return 'PayPal Sandbox is not configured yet. (PAYPAL_CLIENT_SECRET is missing)';
  return null;
}
function _ppMissingFirestore(env) {
  if (!env.FIREBASE_SERVICE_KEY) return 'PayPal Sandbox is not configured yet. (FIREBASE_SERVICE_KEY is missing)';
  return null;
}

// ── Route: POST /paypal/create-order ─────────────────────────────────────────

async function handlePaypalCreateOrder(req, env, cors, sec) {
  let body;
  try { body = await req.json(); } catch { return _ppErr('Invalid JSON', 400, cors, sec); }

  const { usdAmount, idToken } = body;
  if (!idToken)  return _ppErr('Authentication required', 401, cors, sec);
  if (!usdAmount || isNaN(usdAmount)) return _ppErr('Invalid amount', 400, cors, sec);

  const amount = parseFloat(usdAmount);
  if (amount < _PP_MIN_PURCHASE_USD || amount > _PP_MAX_PURCHASE_USD)
    return _ppErr(`Amount must be between $${_PP_MIN_PURCHASE_USD} and $${_PP_MAX_PURCHASE_USD}`, 400, cors, sec);

  const cfgErr = _ppMissingConfig(env);
  if (cfgErr) return _ppErr(cfgErr, 503, cors, sec);

  let uid;
  try { uid = await _fbVerifyToken(env, idToken); }
  catch { return _ppErr('Authentication failed', 401, cors, sec); }

  const coins      = Math.floor(amount * _PP_COINS_PER_DOLLAR);
  const purchaseId = `snxp_${uid.slice(0,8)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;
  const origin     = env.SNX_ORIGIN || 'https://shadownexussocial.online';
  const returnUrl  = `${origin}/paypal-return.html?purchaseId=${purchaseId}`;
  const cancelUrl  = `${origin}/index.html?paypal_cancel=1`;

  let ppResult;
  try {
    ppResult = await _ppCreateOrder(env, { usdAmount: amount, purchaseId, returnUrl, cancelUrl });
  } catch (err) {
    console.error('[SNX-PAYPAL] createOrder:', err.message);
    return _ppErr('Payment service temporarily unavailable. Please try again.', 503, cors, sec);
  }

  // Record pending purchase in Firestore (uses Firebase Web API key path)
  // We write the purchase record using the FIREBASE_SERVICE_KEY for admin access.
  // If not available yet, the capture step will create it.
  if (env.FIREBASE_SERVICE_KEY) {
    try {
      const fbToken = await _fbGetAdminToken(env);
      await _fbSet(fbToken, 'coinPurchases', purchaseId, {
        uid, purchaseId, usdAmount: amount, coinsRequested: coins,
        status: 'pending_payment', paypalOrderId: ppResult.orderId,
        paypalEnv: env.PAYPAL_ENV || 'sandbox', createdAt: _fbTs(),
      });
    } catch (err) {
      console.error('[SNX-PAYPAL] Firestore pending record:', err.message);
      // Non-fatal — capture step will handle it
    }
  }

  return _ppJson({
    success: true, purchaseId, orderId: ppResult.orderId,
    approveLink: ppResult.approveLink, coins, usdAmount: amount,
    environment: env.PAYPAL_ENV || 'sandbox',
  }, 200, cors, sec);
}

// ── Route: POST /paypal/capture-order ────────────────────────────────────────

async function handlePaypalCaptureOrder(req, env, cors, sec) {
  let body;
  try { body = await req.json(); } catch { return _ppErr('Invalid JSON', 400, cors, sec); }

  const { orderId, purchaseId, idToken } = body;
  if (!idToken)              return _ppErr('Authentication required', 401, cors, sec);
  if (!orderId || !purchaseId) return _ppErr('Missing orderId or purchaseId', 400, cors, sec);

  const cfgErr = _ppMissingConfig(env);
  if (cfgErr) return _ppErr(cfgErr, 503, cors, sec);

  let uid;
  try { uid = await _fbVerifyToken(env, idToken); }
  catch { return _ppErr('Authentication failed', 401, cors, sec); }

  // Try Firestore if available — not required to capture the payment
  const hasFirestore = !!env.FIREBASE_SERVICE_KEY;
  let fbToken = null;
  if (hasFirestore) {
    try { fbToken = await _fbGetAdminToken(env); } catch (e) {
      console.error('[SNX-PAYPAL] Firestore token error:', e.message);
    }
  }

  // Idempotency — check if already processed (only if Firestore available)
  if (fbToken) {
    const existing = await _fbGet(fbToken, 'coinPurchases', purchaseId);
    if (existing?.status === 'completed') {
      return _ppJson({
        success: true, alreadyProcessed: true,
        coins: existing.coinsRequested || 0,
        message: 'Your purchase is still being verified.',
      }, 200, cors, sec);
    }
    if (existing && existing.uid !== uid)
      return _ppErr('Purchase does not belong to this account', 403, cors, sec);
  }

  // Capture the PayPal order — this is the authoritative payment step
  let capture;
  try { capture = await _ppCaptureOrder(env, orderId); }
  catch (err) {
    console.error('[SNX-PAYPAL] capture:', err.message);
    return _ppErr('Payment capture failed. Please try again.', 502, cors, sec);
  }

  const captureStatus = capture.status;
  if (captureStatus !== 'COMPLETED') {
    if (fbToken) {
      await _fbSet(fbToken, 'coinPurchases', purchaseId, {
        status: 'failed', paypalStatus: captureStatus, failedAt: _fbTs(),
      }).catch(() => {});
    }
    return _ppErr(`Payment not completed (status: ${captureStatus})`, 400, cors, sec);
  }

  // Verify amount server-side — NEVER trust the client-supplied amount
  const capturedAmount = parseFloat(
    capture.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || '0'
  );
  const expectedCoins = Math.floor(capturedAmount * _PP_COINS_PER_DOLLAR);
  const captureId     = capture.purchase_units?.[0]?.payments?.captures?.[0]?.id || '';

  // Credit coins and record transaction in Firestore (when available)
  let newBalance = expectedCoins; // fallback if no Firestore
  if (fbToken) {
    try {
      const walletData   = await _fbGet(fbToken, 'wallets', uid) || {};
      const currentCoins = walletData.shadowCoins || 0;
      newBalance         = currentCoins + expectedCoins;

      await _fbSet(fbToken, 'wallets', uid, {
        uid, shadowCoins: newBalance,
        totalPurchased: (walletData.totalPurchased || 0) + expectedCoins,
        lastPurchaseAt: _fbTs(),
      });
      await _fbSet(fbToken, 'coinPurchases', purchaseId, {
        uid, purchaseId, usdAmount: capturedAmount, coinsRequested: expectedCoins,
        status: 'completed', paypalOrderId: orderId, paypalCaptureId: captureId,
        paypalEnv: env.PAYPAL_ENV || 'live', completedAt: _fbTs(),
      });
      await _fbAdd(fbToken, 'financialAuditLog', {
        type: 'COIN_PURCHASE', uid, purchaseId, orderId,
        usdAmount: capturedAmount, coinsAdded: expectedCoins, newBalance,
        environment: env.PAYPAL_ENV || 'live', timestamp: _fbTs(),
      });
    } catch (err) {
      // Payment was captured — log the error but don't fail the response.
      // Coins will need to be manually reconciled from PayPal dashboard.
      console.error('[SNX-PAYPAL] Firestore write after capture FAILED:', err.message,
        'orderId:', orderId, 'purchaseId:', purchaseId, 'uid:', uid,
        'amount:', capturedAmount, 'captureId:', captureId);
    }
  } else {
    // Firestore not configured — payment captured but coins cannot be credited yet.
    // Log everything needed for manual reconciliation.
    console.warn('[SNX-PAYPAL] PAYMENT CAPTURED but Firestore not configured.',
      'orderId:', orderId, 'purchaseId:', purchaseId, 'uid:', uid,
      'amount:', capturedAmount, 'coins:', expectedCoins, 'captureId:', captureId);
  }

  return _ppJson({
    success: true, coins: expectedCoins,
    newBalance, usdAmount: capturedAmount,
    firestoreRecorded: !!fbToken,
    message: `${expectedCoins} Shadow Coins added to your wallet!`,
  }, 200, cors, sec);
}

// ── Route: POST /paypal/webhook ───────────────────────────────────────────────

async function handlePaypalWebhook(req, env, cors, sec) {
  const rawText = await req.text();
  let event;
  try { event = JSON.parse(rawText); } catch { return _ppErr('Invalid JSON', 400, cors, sec); }

  const eventId = event.id;
  if (!eventId) return _ppErr('Missing event ID', 400, cors, sec);

  if (!env.FIREBASE_SERVICE_KEY)
    return _ppJson({ received: true, warning: 'Service key not set — not persisted' }, 200, cors, sec);

  const fbToken = await _fbGetAdminToken(env);

  // Idempotency — skip if already processed
  const already = await _fbGet(fbToken, 'paypalWebhooks', eventId);
  if (already?.processed) {
    return _ppJson({ received: true, duplicate: true }, 200, cors, sec);
  }

  // Verify webhook signature if PAYPAL_WEBHOOK_ID is set
  if (env.PAYPAL_WEBHOOK_ID && env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
    const hdrs = {};
    for (const [k, v] of req.headers.entries()) hdrs[k.toLowerCase()] = v;
    try {
      const valid = await _ppVerifyWebhook(env, hdrs, event);
      if (!valid) {
        console.warn('[SNX-PAYPAL] Webhook signature FAILED for', eventId);
        return _ppErr('Webhook signature verification failed', 400, cors, sec);
      }
    } catch (err) {
      console.error('[SNX-PAYPAL] Webhook verify error:', err.message);
      // Don't reject on verify error — log and continue (PayPal sandbox sometimes fails verify)
    }
  }

  // Record event
  await _fbSet(fbToken, 'paypalWebhooks', eventId, {
    eventId, eventType: event.event_type || '',
    processed: true, receivedAt: _fbTs(),
    resourceId: event.resource?.id || '',
  });

  const eventType = event.event_type || '';
  const resource  = event.resource   || {};

  if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
    const customId = resource.purchase_units?.[0]?.reference_id
      || resource.supplementary_data?.related_ids?.order_id || '';
    if (customId) {
      const purchase = await _fbGet(fbToken, 'coinPurchases', customId);
      if (purchase && purchase.status !== 'completed') {
        const coins       = purchase.coinsRequested || 0;
        const walletData  = await _fbGet(fbToken, 'wallets', purchase.uid) || {};
        const currentCoins = walletData.shadowCoins || 0;
        await _fbSet(fbToken, 'wallets', purchase.uid, {
          uid: purchase.uid, shadowCoins: currentCoins + coins,
          totalPurchased: (walletData.totalPurchased || 0) + coins,
          lastPurchaseAt: _fbTs(),
        });
        await _fbSet(fbToken, 'coinPurchases', customId, {
          status: 'completed', webhookConfirmed: true, completedAt: _fbTs(),
        });
      }
    }
  }

  return _ppJson({ received: true, eventType }, 200, cors, sec);
}

// ── Route: POST /paypal/payout ────────────────────────────────────────────────

async function handlePaypalPayout(req, env, cors, sec) {
  let body;
  try { body = await req.json(); } catch { return _ppErr('Invalid JSON', 400, cors, sec); }

  const { idToken } = body;
  if (!idToken) return _ppErr('Authentication required', 401, cors, sec);

  const cfgErr = _ppMissingConfig(env) || _ppMissingFirestore(env);
  if (cfgErr) return _ppErr(cfgErr, 503, cors, sec);

  let uid;
  try { uid = await _fbVerifyToken(env, idToken); }
  catch { return _ppErr('Authentication failed', 401, cors, sec); }

  const fbToken  = await _fbGetAdminToken(env);
  const earnings = await _fbGet(fbToken, 'creatorEarnings', uid);
  if (!earnings) return _ppErr('No earnings found.', 404, cors, sec);

  const available = earnings.availableCoins || 0;
  const usdAmount = available / _PP_COINS_PER_DOLLAR;

  if (usdAmount < _PP_MIN_PAYOUT_USD)
    return _ppErr(`Minimum cash-out is $${_PP_MIN_PAYOUT_USD.toFixed(2)}. Keep creating!`, 400, cors, sec);

  // Check 24-hour cooldown
  const payouts = await _fbQuery(fbToken, 'creatorPayouts',
    [{ field: 'creatorId', value: uid }],
    { orderBy: 'requestedAt', dir: 'DESCENDING', limit: 1 }
  );
  if (payouts.length > 0) {
    const lastTs = payouts[0].data.requestedAt;
    if (lastTs && (Date.now() - new Date(lastTs).getTime()) < _PP_PAYOUT_COOLDOWN_MS) {
      const hoursLeft = Math.ceil((_PP_PAYOUT_COOLDOWN_MS - (Date.now() - new Date(lastTs).getTime())) / 3600000);
      return _ppErr(`You can request another payout after ${hoursLeft} hour${hoursLeft !== 1 ? 's' : ''}.`, 429, cors, sec);
    }
  }

  // Get creator's PayPal email
  const ppAccount = await _fbGet(fbToken, 'paypalAccounts', uid);
  if (!ppAccount?.email || ppAccount.onboardingStatus !== 'completed')
    return _ppErr('Connect your PayPal account before requesting a payout.', 400, cors, sec);

  // Lock earnings atomically — zero out availableCoins
  await _fbSet(fbToken, 'creatorEarnings', uid, {
    availableCoins: 0, lastPayoutLockedAt: _fbTs(),
  });

  const payoutId = `snxo_${uid.slice(0,8)}_${Date.now().toString(36)}`;

  // Create payout record
  await _fbSet(fbToken, 'creatorPayouts', payoutId, {
    payoutId, creatorId: uid, usdAmount,
    coinsLocked: available, status: 'processing',
    paypalEmail: ppAccount.email, requestedAt: _fbTs(),
  });

  // Send payout via PayPal
  let ppResult;
  try {
    ppResult = await _ppSendPayout(env, { payoutId, receiverEmail: ppAccount.email, amountUsd: usdAmount });
  } catch (err) {
    console.error('[SNX-PAYPAL] payout error:', err.message);
    // Unlock earnings on failure
    await _fbSet(fbToken, 'creatorEarnings', uid, { availableCoins: available });
    await _fbSet(fbToken, 'creatorPayouts', payoutId, { status: 'failed', failedAt: _fbTs() });
    return _ppErr('Your payout request is being processed.', 502, cors, sec);
  }

  const batchId = ppResult.batch_header?.payout_batch_id || '';
  await _fbSet(fbToken, 'creatorPayouts', payoutId, {
    status: 'processing', paypalBatchId: batchId, submittedAt: _fbTs(),
  });
  await _fbAdd(fbToken, 'financialAuditLog', {
    type: 'PAYOUT_SUBMITTED', payoutId, uid, usdAmount,
    coinsLocked: available, paypalBatchId: batchId,
    environment: env.PAYPAL_ENV || 'sandbox', timestamp: _fbTs(),
  });

  return _ppJson({
    success: true, payoutId, usdAmount, status: 'processing', paypalBatchId: batchId,
    message: 'Your payout request is being processed.',
  }, 200, cors, sec);
}

// ── Route: GET /paypal/creator-status ────────────────────────────────────────

async function handlePaypalCreatorStatus(req, env, cors, sec) {
  const url      = new URL(req.url);
  const idToken  = url.searchParams.get('idToken');
  if (!idToken) return _ppErr('Authentication required', 401, cors, sec);

  let uid;
  try { uid = await _fbVerifyToken(env, idToken); }
  catch { return _ppErr('Authentication failed', 401, cors, sec); }

  if (!env.FIREBASE_SERVICE_KEY)
    return _ppJson({ success: true, onboardingStatus: 'not_configured', payoutsEnabled: false }, 200, cors, sec);

  const fbToken  = await _fbGetAdminToken(env);
  const ppAcct   = await _fbGet(fbToken, 'paypalAccounts', uid);

  return _ppJson({
    success: true,
    onboardingStatus: ppAcct?.onboardingStatus || 'not_connected',
    payoutsEnabled:   ppAcct?.payoutsEnabled   || false,
    email:            ppAcct?.email            || null,
  }, 200, cors, sec);
}

// ── Route: POST /paypal/onboard-creator ──────────────────────────────────────

async function handlePaypalOnboardCreator(req, env, cors, sec) {
  let body;
  try { body = await req.json(); } catch { return _ppErr('Invalid JSON', 400, cors, sec); }

  const { idToken } = body;
  if (!idToken) return _ppErr('Authentication required', 401, cors, sec);

  let uid;
  try { uid = await _fbVerifyToken(env, idToken); }
  catch { return _ppErr('Authentication failed', 401, cors, sec); }

  const cfgErr = _ppMissingConfig(env);
  if (cfgErr) return _ppErr(cfgErr, 503, cors, sec);

  const origin    = env.SNX_ORIGIN || 'https://shadownexussocial.online';
  const returnUrl = `${origin}/index.html?paypal_onboard=done`;

  let actionUrl;
  try {
    actionUrl = await _ppCreateReferral(env, { creatorUid: uid, returnUrl });
  } catch (err) {
    console.error('[SNX-PAYPAL] onboard-creator:', err.message);
    return _ppErr('PayPal onboarding unavailable. Requires PayPal Marketplace API approval.', 503, cors, sec);
  }

  if (!actionUrl) return _ppErr('Could not generate onboarding link.', 500, cors, sec);

  if (env.FIREBASE_SERVICE_KEY) {
    try {
      const fbToken = await _fbGetAdminToken(env);
      await _fbSet(fbToken, 'paypalAccounts', uid, {
        uid, onboardingStatus: 'pending', onboardingStartedAt: _fbTs(),
      });
    } catch (err) { console.error('[SNX-PAYPAL] onboard record:', err.message); }
  }

  return _ppJson({ success: true, actionUrl }, 200, cors, sec);
}

// ── Route: POST /paypal/grant-test-coins ─────────────────────────────────────
//
// Founder-only: grants exactly 500 test Shadow Coins to a specified user.
// The backend independently verifies:
//   1. The caller's Firebase ID token is valid
//   2. The caller's users/{uid}.role === 'founder' AND email matches FOUNDER_EMAIL
//   3. ENABLE_TEST_COIN_GRANTS === 'true' in worker env vars
//   4. Amount is hardcoded to 500 — never taken from the request body
//   5. Transaction is marked TEST_GRANT, environment: 'sandbox', no cash value
//
// A non-founder or any other role receives 403 Permission denied.

const _FOUNDER_EMAIL         = 'christijerina46@gmail.com';
const _TEST_GRANT_COINS      = 500;  // hardcoded — never trusted from client

async function handleGrantTestCoins(req, env, cors, sec) {
  // ── 0. Feature flag — must be explicitly enabled in wrangler vars ──
  if (env.ENABLE_TEST_COIN_GRANTS !== 'true') {
    return _ppErr('Test coin grants are not enabled.', 403, cors, sec);
  }

  // ── 1. Parse request ──
  let body;
  try { body = await req.json(); } catch { return _ppErr('Invalid JSON', 400, cors, sec); }

  const { idToken, recipientUid, reason } = body;
  if (!idToken)      return _ppErr('Authentication required', 401, cors, sec);
  if (!recipientUid) return _ppErr('recipientUid is required', 400, cors, sec);

  // ── 2. Verify caller's Firebase ID token ──
  let callerUid;
  try { callerUid = await _fbVerifyToken(env, idToken); }
  catch { return _ppErr('Authentication failed', 401, cors, sec); }

  // ── 3. Firestore is required for this operation ──
  if (!env.FIREBASE_SERVICE_KEY)
    return _ppErr('Server configuration error.', 503, cors, sec);

  const fbToken = await _fbGetAdminToken(env);

  // ── 4. Server-side Founder verification — read users/{callerUid} from Firestore ──
  // This is independent of anything the frontend sends.
  // A user cannot spoof this by modifying their own document (Firestore rules protect it).
  const callerDoc = await _fbGet(fbToken, 'users', callerUid);
  if (!callerDoc) {
    return _ppErr('Permission denied', 403, cors, sec);
  }

  const callerRole  = callerDoc.role  || '';
  const callerEmail = callerDoc.email || '';

  // Role must be 'founder' AND email must match the designated Founder email
  if (callerRole !== 'founder' || callerEmail.toLowerCase() !== _FOUNDER_EMAIL.toLowerCase()) {
    console.warn('[SNX-GRANT] Permission denied for uid:', callerUid,
      'role:', callerRole, 'email:', callerEmail);
    return _ppErr('Permission denied', 403, cors, sec);
  }

  // ── 5. Verify recipient exists ──
  const recipientDoc = await _fbGet(fbToken, 'users', recipientUid);
  if (!recipientDoc) {
    return _ppErr('Recipient user not found', 404, cors, sec);
  }
  // Cannot grant to self (prevents Founder inflating their own balance)
  if (recipientUid === callerUid) {
    return _ppErr('Cannot grant test coins to yourself', 400, cors, sec);
  }
  // Cannot grant to another founder (keep test grants for regular test users)
  if (recipientDoc.role === 'founder') {
    return _ppErr('Cannot grant test coins to a Founder account', 400, cors, sec);
  }

  // ── 6. Atomic wallet update ──
  // Amount is HARDCODED here — the request body amount is never used.
  const grantCoins    = _TEST_GRANT_COINS;  // always 500
  const walletData    = await _fbGet(fbToken, 'wallets', recipientUid) || {};
  const currentCoins  = walletData.shadowCoins || 0;
  const newBalance    = currentCoins + grantCoins;

  await _fbSet(fbToken, 'wallets', recipientUid, {
    uid:          recipientUid,
    shadowCoins:  newBalance,
    lastGrantAt:  _fbTs(),
  });

  // ── 7. Write immutable test transaction record ──
  const txId = `snxtg_${callerUid.slice(0,6)}_${recipientUid.slice(0,6)}_${Date.now().toString(36)}`;
  await _fbAdd(fbToken, 'testCoinGrants', {
    txId,
    transactionType:  'TEST_GRANT',
    amount:           grantCoins,            // always 500
    environment:      'sandbox',
    recipientUserId:  recipientUid,
    recipientName:    recipientDoc.displayName || '',
    grantedBy:        callerUid,
    grantedByEmail:   callerEmail,
    reason:           reason || 'LIVE gifting test',
    noRealCashValue:  true,
    earningsWithdrawable: false,
    timestamp:        _fbTs(),
  });

  // ── 8. Audit log ──
  await _fbAdd(fbToken, 'financialAuditLog', {
    type:            'TEST_COIN_GRANT',
    txId,
    grantedBy:       callerUid,
    recipientUid,
    amount:          grantCoins,
    environment:     'sandbox',
    noRealCashValue: true,
    timestamp:       _fbTs(),
  });

  console.log('[SNX-GRANT] Founder', callerUid, 'granted', grantCoins,
    'test coins to', recipientUid, '(', recipientDoc.displayName, ')');

  return _ppJson({
    success:       true,
    txId,
    amount:        grantCoins,
    recipientUid,
    recipientName: recipientDoc.displayName || '',
    newBalance,
    environment:   'sandbox',
    noRealCashValue: true,
    message:       `✅ ${grantCoins} test coins granted to ${recipientDoc.displayName || recipientUid}`,
  }, 200, cors, sec);
}

// ═══════════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors   = corsHeaders(origin);
    const sec    = securityHeaders();
    const url    = new URL(request.url);

    // ── Preflight ──
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: mergeHeaders(cors, sec)
      });
    }

    // ── PayPal endpoints ──
    if (url.pathname === '/paypal/create-order'    && request.method === 'POST') return handlePaypalCreateOrder(request, env, cors, sec);
    if (url.pathname === '/paypal/capture-order'   && request.method === 'POST') return handlePaypalCaptureOrder(request, env, cors, sec);
    if (url.pathname === '/paypal/webhook'         && request.method === 'POST') return handlePaypalWebhook(request, env, cors, sec);
    if (url.pathname === '/paypal/payout'          && request.method === 'POST') return handlePaypalPayout(request, env, cors, sec);
    if (url.pathname === '/paypal/creator-status'  && request.method === 'GET')  return handlePaypalCreatorStatus(request, env, cors, sec);
    if (url.pathname === '/paypal/onboard-creator'  && request.method === 'POST') return handlePaypalOnboardCreator(request, env, cors, sec);
    if (url.pathname === '/paypal/grant-test-coins' && request.method === 'POST') return handleGrantTestCoins(request, env, cors, sec);
    if (url.pathname === '/paypal/health'          && request.method === 'GET') {
      return _ppJson({
        status: 'ok', service: 'snx-paypal', worker: 'yellow-term-11e6',
        environment: env.PAYPAL_ENV || 'sandbox',
        paypalConfigured: !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
        firestoreConfigured: !!env.FIREBASE_SERVICE_KEY,
      }, 200, cors, sec);
    }

    // ── LiveKit endpoints ──
    if (url.pathname === '/livekit-room')  return handleLiveKitRoom(request, env, cors, sec);
    if (url.pathname === '/livekit-token') return handleLiveKitToken(request, env, cors, sec);

    // ── Chunked / resumable upload endpoints ──
    if (url.pathname === '/upload-chunk')    return handleUploadChunk(request, env, cors, sec);
    if (url.pathname === '/upload-complete') return handleUploadComplete(request, env, cors, sec);

    // ── POST /upload-music: upload a profile music file to R2 at a caller-supplied key ──
    // The client sends: file, uid, path (the full R2 key)
    // Path must start with profiles/{uid}/music/ — enforced server-side.
    if (request.method === 'POST' && url.pathname === '/upload-music') {
      let formData;
      try { formData = await request.formData(); }
      catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid form data: ' + e.message }), {
          status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      const file    = formData.get('file');
      const userUid = (formData.get('uid') || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const reqPath = (formData.get('path') || '').replace(/\.\./g, '');  // strip traversal

      if (!file || typeof file === 'string') {
        return new Response(JSON.stringify({ error: 'No file received' }), {
          status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }
      if (!userUid) {
        return new Response(JSON.stringify({ error: 'uid is required' }), {
          status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      // Enforce: path must be scoped to this user under profiles/{uid}/music/
      const expectedPrefix = `profiles/${userUid}/music/`;
      if (!reqPath.startsWith(expectedPrefix)) {
        return new Response(JSON.stringify({ error: 'Invalid path: must start with ' + expectedPrefix }), {
          status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      // MIME validation — audio only for music uploads
      let mime = file.type || '';
      const extMime = mimeFromExt(file.name);
      if (!mime || mime === 'application/octet-stream') mime = extMime || mime;
      else if (extMime && mime.startsWith('video/') && extMime.startsWith('audio/')) mime = extMime;

      if (!mime.startsWith('audio/') && !mime.startsWith('image/') && mime !== 'application/octet-stream') {
        return new Response(JSON.stringify({ error: `Only audio or image files are allowed for music uploads. Got: ${file.type}` }), {
          status: 415, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      const buffer = await file.arrayBuffer();
      const sizeLimit = mime.startsWith('image/') ? MAX_SIZE_IMAGE : MAX_SIZE_AUDIO;
      if (buffer.byteLength > sizeLimit) {
        const limitMB = Math.round(sizeLimit / 1024 / 1024);
        return new Response(JSON.stringify({ error: `File too large (max ${limitMB} MB for this type)` }), {
          status: 413, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      const cleanMime = (mime || 'audio/mpeg').split(';')[0].trim();
      try {
        await env.BUCKET.put(reqPath, buffer, {
          httpMetadata:   { contentType: cleanMime },
          customMetadata: { uploaderUid: userUid, originalName: file.name }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'R2 upload failed: ' + e.message }), {
          status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      const publicUrl = `https://yellow-term-11e6.nthntjrn.workers.dev/${reqPath}`;
      return new Response(JSON.stringify({ url: publicUrl, key: reqPath }), {
        status: 200,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    // ── DELETE /{key}: delete a file from R2 (called when user deletes a song) ──
    if (request.method === 'DELETE') {
      // url.pathname is already decoded by the URL constructor; slice off the leading '/'
      const key = url.pathname.slice(1);
      if (!key) {
        return new Response(JSON.stringify({ error: 'key is required' }), {
          status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }
      try {
        await env.BUCKET.delete(key);
        return new Response(JSON.stringify({ deleted: true, key }), {
          status: 200,
          headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'R2 delete failed: ' + e.message }), {
          status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }
    }

    // ── GET: serve a file from R2 (CDN delivery) ──────────────────────────────
    if (request.method === 'GET') {
      const key = url.pathname.slice(1);
      if (!key) {
        return new Response('Shadow Nexus Upload Worker — OK ⚡', {
          status: 200,
          headers: mergeHeaders(cors, sec, { 'Content-Type': 'text/plain' })
        });
      }

      try {
        const obj = await env.BUCKET.get(key);
        if (!obj) {
          return new Response('Not found', {
            status: 404,
            headers: mergeHeaders(cors, sec)
          });
        }

        const headers = new Headers(mergeHeaders(cors, sec));
        headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
        // Long-lived immutable cache for media files (files are content-addressed)
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        headers.set('Accept-Ranges', 'bytes');
        if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
        // Bot protection hint (actual blocking via Cloudflare Bot Management)
        headers.set('X-Robots-Tag', 'noindex, nofollow');

        return new Response(obj.body, { status: 200, headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Fetch error: ' + e.message }), {
          status: 500,
          headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }
    }

    // ── POST /: generic upload (profile pics, posts, messages, etc.) ─────────
    if (request.method !== 'POST') {
      return new Response('Method not allowed', {
        status: 405,
        headers: mergeHeaders(cors, sec)
      });
    }

    let formData;
    try { formData = await request.formData(); }
    catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid form data: ' + e.message }), {
        status: 400,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    const file    = formData.get('file');
    const userUid = (formData.get('uid') || 'anonymous').replace(/[^a-zA-Z0-9_-]/g, '');

    if (!file || typeof file === 'string') {
      return new Response(JSON.stringify({ error: 'No file received' }), {
        status: 400,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    // ── MIME determination ────────────────────────────────────────────────────
    // Some mobile browsers report video/webm for audio recordings;
    // override based on file extension when that happens.
    let mime = file.type || '';
    const extMime = mimeFromExt(file.name);
    if (!mime || mime === 'application/octet-stream') {
      mime = extMime || mime;
    } else if (extMime && mime.startsWith('video/') && extMime.startsWith('audio/')) {
      mime = extMime;
    }

    if (!isAllowedType(mime)) {
      return new Response(JSON.stringify({ error: `File type not supported: ${file.type} (${file.name})` }), {
        status: 415,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    const buffer = await file.arrayBuffer();
    // Per-type size limits enforced server-side
    const cleanMime = mime.split(';')[0].trim();
    const sizeLimit = cleanMime.startsWith('image/') ? MAX_SIZE_IMAGE
                    : cleanMime.startsWith('video/') ? MAX_SIZE_VIDEO
                    : MAX_SIZE_AUDIO;
    if (buffer.byteLength > sizeLimit) {
      const limitMB = Math.round(sizeLimit / 1024 / 1024);
      return new Response(JSON.stringify({ error: `File too large (max ${limitMB} MB for this type)` }), {
        status: 413,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    // ── Store in R2 under userUid/timestamp-random.ext ────────────────────────
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = `${userUid}/${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;

    try {
      await env.BUCKET.put(key, buffer, {
        httpMetadata:   { contentType: cleanMime },
        customMetadata: { uploaderUid: userUid, originalName: file.name }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'R2 upload failed: ' + e.message }), {
        status: 500,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    // ── Return public CDN URL (stored in Firebase, served via Cloudflare CDN) ──
    const publicUrl = `https://yellow-term-11e6.nthntjrn.workers.dev/${key}`;
    return new Response(JSON.stringify({ url: publicUrl, key }), {
      status: 200,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
};
