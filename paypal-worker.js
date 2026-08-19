/**
 * paypal-worker.js
 * Shadow Nexus Social — PayPal Payment Backend
 *
 * Cloudflare Worker that acts as the secure payment backend.
 * NO PayPal secrets are ever sent to the browser.
 *
 * Routes:
 *   POST /paypal/create-order        — Create a PayPal order for coin purchase
 *   POST /paypal/capture-order       — Capture a PayPal order after buyer approval
 *   POST /paypal/webhook             — Receive and verify PayPal webhook events
 *   POST /paypal/onboard-creator     — Generate a PayPal onboarding link for creator
 *   POST /paypal/payout              — Send payout to a connected creator
 *   GET  /paypal/creator-status      — Get creator PayPal onboarding status
 *   GET  /health                     — Health check
 *
 * Required Cloudflare Secrets (set via: wrangler secret put <NAME> --config wrangler-paypal.toml):
 *   PAYPAL_CLIENT_ID         — BAA_f0dLIUnsqCYMCUKypUxef68PGf6RUCHlYk-Y9FFSf8VdHn3tpAYb6O7lEAkqNpWUL2ebmy4GKwmndw
 *   PAYPAL_CLIENT_SECRET     — BAA_f0dLIUnsqCYMCUKypUxef68PGf6RUCHlYk-Y9FFSf8VdHn3tpAYb6O7lEAkqNpWUL2ebmy4GKwmndw
 *   PAYPAL_WEBHOOK_ID        — PayPal Webhook ID (from PayPal developer dashboard)
 *   PAYPAL_PARTNER_BN_CODE   — PayPal Partner BN code (for marketplace/platform)
 *   FIREBASE_SERVICE_KEY     — Firebase Admin SDK service account JSON (stringified)
 *
 * Required Environment Variable:
 *   PAYPAL_ENV               — "sandbox" | "live"  (set in wrangler-paypal.toml vars)
 *   SNX_ORIGIN               — "https://shadownexussocial.online"
 *
 * PayPal Environment URLs:
 *   Sandbox: https://api-m.sandbox.paypal.com
 *   Live:    https://api-m.paypal.com
 *
 * IMPORTANT: This worker uses Firebase Admin REST API (not the Admin SDK)
 * because Cloudflare Workers do not support Node.js Firebase Admin SDK.
 * All Firestore writes use the Firestore REST API authenticated via a
 * Google service account JWT.
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const COINS_PER_DOLLAR  = 100;   // 100 coins = $1.00 USD
const CREATOR_SHARE_PCT = 0.90;  // 90% to creator
const PLATFORM_SHARE_PCT= 0.10;  // 10% to platform
const MIN_PURCHASE_USD  = 0.01;
const MAX_PURCHASE_USD  = 100.00;
const MIN_PAYOUT_USD    = 1.00;
const PAYOUT_COOLDOWN_H = 24;    // hours between payouts
const FIREBASE_PROJECT  = 'horr-a08f4';

// ─── CORS Helper ──────────────────────────────────────────────────────────────

function corsHeaders(origin, env) {
  const allowed = env.SNX_ORIGIN || 'https://shadownexussocial.online';
  const isAllowed = origin && (origin === allowed || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1'));
  return {
    'Access-Control-Allow-Origin':  isAllowed ? origin : allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Firebase-UID, X-Firebase-Token',
    'Access-Control-Max-Age':       '86400',
  };
}

function jsonResp(data, status, origin, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin, env),
    },
  });
}

function errResp(message, status, origin, env) {
  return jsonResp({ success: false, error: message }, status || 400, origin, env);
}

// ─── PayPal API Client ────────────────────────────────────────────────────────

function ppBaseUrl(env) {
  return env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

/**
 * Get a PayPal access token using Client Credentials.
 * Tokens are valid for ~9 hours but we request a fresh one per request
 * (in production you'd cache in KV with TTL).
 */
async function ppGetToken(env) {
  const base = ppBaseUrl(env);
  const credentials = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method:  'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PayPal token error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.access_token;
}

/**
 * Create a PayPal Order for coin purchase.
 * Returns the order ID and approval link.
 */
async function ppCreateOrder(env, { usdAmount, purchaseId, returnUrl, cancelUrl }) {
  const token = await ppGetToken(env);
  const base  = ppBaseUrl(env);
  const amountStr = parseFloat(usdAmount).toFixed(2);

  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id:   purchaseId,
      description:    `Shadow Coins — ${Math.floor(usdAmount * COINS_PER_DOLLAR)} coins`,
      custom_id:      purchaseId,
      amount: {
        currency_code: 'USD',
        value:         amountStr,
      },
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
  };

  const res = await fetch(`${base}/v2/checkout/orders`, {
    method:  'POST',
    headers: {
      'Authorization':          `Bearer ${token}`,
      'Content-Type':           'application/json',
      'PayPal-Request-Id':      purchaseId,       // idempotency key
      'Prefer':                 'return=representation',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PayPal createOrder ${res.status}: ${err}`);
  }

  const order = await res.json();
  const approveLink = order.links?.find(l => l.rel === 'approve')?.href || null;
  return { orderId: order.id, approveLink, order };
}

/**
 * Capture a PayPal order after buyer approves.
 */
async function ppCaptureOrder(env, orderId) {
  const token = await ppGetToken(env);
  const base  = ppBaseUrl(env);

  const res = await fetch(`${base}/v2/checkout/orders/${orderId}/capture`, {
    method:  'POST',
    headers: {
      'Authorization':     `Bearer ${token}`,
      'Content-Type':      'application/json',
      'PayPal-Request-Id': `cap_${orderId}`,  // idempotency key
    },
    body: '{}',
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PayPal captureOrder ${res.status}: ${err}`);
  }

  const capture = await res.json();
  return capture;
}

/**
 * Verify a PayPal webhook signature.
 * Uses PayPal's /v1/notifications/verify-webhook-signature endpoint.
 */
async function ppVerifyWebhook(env, { headers, body }) {
  const token = await ppGetToken(env);
  const base  = ppBaseUrl(env);

  const verifyBody = {
    auth_algo:         headers['paypal-auth-algo']         || '',
    cert_url:          headers['paypal-cert-url']          || '',
    transmission_id:   headers['paypal-transmission-id']   || '',
    transmission_sig:  headers['paypal-transmission-sig']  || '',
    transmission_time: headers['paypal-transmission-time'] || '',
    webhook_id:        env.PAYPAL_WEBHOOK_ID,
    webhook_event:     body,  // must be the raw parsed JSON
  };

  const res = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(verifyBody),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PayPal webhook verify ${res.status}: ${err}`);
  }

  const result = await res.json();
  // PayPal returns { "verification_status": "SUCCESS" | "FAILURE" }
  return result.verification_status === 'SUCCESS';
}

/**
 * Generate a PayPal Partner Referral (seller onboarding) link.
 * Requires PayPal Marketplace / Commerce Platform approval.
 */
async function ppCreateReferral(env, { creatorUid, returnUrl }) {
  const token = await ppGetToken(env);
  const base  = ppBaseUrl(env);

  const body = {
    tracking_id:      `snx_creator_${creatorUid}`,
    partner_config_override: {
      return_url:     returnUrl,
      action_renewal_url: returnUrl,
    },
    operations: [{
      operation:      'API_INTEGRATION',
      api_integration_preference: {
        rest_api_integration: {
          integration_method:  'PAYPAL',
          integration_type:    'THIRD_PARTY',
          third_party_details: {
            features: ['PAYMENT', 'REFUND', 'DELAY_FUNDS_DISBURSEMENT'],
          },
        },
      },
    }],
    products:    ['EXPRESS_CHECKOUT'],
    legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
  };

  const res = await fetch(`${base}/v2/customer/partner-referrals`, {
    method:  'POST',
    headers: {
      'Authorization':  `Bearer ${token}`,
      'Content-Type':   'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PayPal createReferral ${res.status}: ${err}`);
  }

  const data = await res.json();
  const actionUrl = data.links?.find(l => l.rel === 'action_url')?.href || null;
  return { referralId: data.token || null, actionUrl };
}

/**
 * Get a connected creator's merchant status from PayPal.
 */
async function ppGetMerchantStatus(env, merchantIdInPayPal) {
  const token = await ppGetToken(env);
  const base  = ppBaseUrl(env);
  const partnerId = env.PAYPAL_PARTNER_ID;

  const res = await fetch(`${base}/v1/customer/partners/${partnerId}/merchant-integrations/${merchantIdInPayPal}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!res.ok) return null;
  return res.json();
}

/**
 * Send a payout to a creator's connected PayPal account.
 * Uses PayPal Payouts v1 API (requires approved Payouts API access).
 */
async function ppSendPayout(env, { payoutId, receiverEmail, amountUsd, note }) {
  const token = await ppGetToken(env);
  const base  = ppBaseUrl(env);

  const body = {
    sender_batch_header: {
      sender_batch_id: payoutId,
      email_subject:   'Shadow Nexus Social — Creator Payout',
      email_message:   note || 'Your creator earnings from Shadow Nexus Social.',
    },
    items: [{
      recipient_type: 'EMAIL',
      amount: {
        value:         parseFloat(amountUsd).toFixed(2),
        currency:      'USD',
      },
      receiver:       receiverEmail,
      note:           note || 'Creator earnings — Shadow Nexus Social',
      sender_item_id: payoutId,
    }],
  };

  const res = await fetch(`${base}/v1/payments/payouts`, {
    method:  'POST',
    headers: {
      'Authorization':          `Bearer ${token}`,
      'Content-Type':           'application/json',
      'PayPal-Request-Id':      payoutId,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PayPal payout ${res.status}: ${err}`);
  }

  const result = await res.json();
  return result;
}

// ─── Firebase Firestore REST API ──────────────────────────────────────────────

/**
 * Get a Firebase access token using Service Account JWT.
 * The FIREBASE_SERVICE_KEY secret contains the full service-account JSON.
 */
async function fbGetToken(env) {
  const sa = JSON.parse(env.FIREBASE_SERVICE_KEY);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase',
  };

  // Build JWT header.payload
  const header = { alg: 'RS256', typ: 'JWT' };
  const b64Header  = btoa(JSON.stringify(header)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const b64Payload = btoa(JSON.stringify(payload)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const signingInput = `${b64Header}.${b64Payload}`;

  // Import RSA private key (PKCS#8)
  const pemBody = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
  const keyDer  = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const encoder = new TextEncoder();
  const sigBytes = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, encoder.encode(signingInput));
  const b64Sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const jwt = `${signingInput}.${b64Sig}`;

  // Exchange JWT for access token
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firebase token error: ${err}`);
  }
  const data = await res.json();
  return data.access_token;
}

const FB_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

/** Read a single Firestore document */
async function fbGetDoc(token, collection, docId) {
  const res = await fetch(`${FB_BASE}/${collection}/${docId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fbGetDoc ${collection}/${docId}: ${res.status}`);
  const data = await res.json();
  return data;
}

/** Write / update a Firestore document (PATCH with updateMask for merge) */
async function fbSetDoc(token, collection, docId, fields) {
  const body = { fields: toFirestoreFields(fields) };
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${FB_BASE}/${collection}/${docId}?${mask}`, {
    method:  'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`fbSetDoc ${collection}/${docId}: ${res.status} ${err}`);
  }
  return res.json();
}

/** Create a new Firestore document with auto-generated ID */
async function fbAddDoc(token, collection, fields) {
  const body = { fields: toFirestoreFields(fields) };
  const res = await fetch(`${FB_BASE}/${collection}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`fbAddDoc ${collection}: ${res.status} ${err}`);
  }
  return res.json();
}

/** Query Firestore documents */
async function fbQuery(token, collection, filters) {
  // Simple equality filters only — uses runQuery
  const structuredQuery = {
    from: [{ collectionId: collection }],
    where: filters.length === 1 ? {
      fieldFilter: {
        field: { fieldPath: filters[0].field },
        op: 'EQUAL',
        value: toFirestoreValue(filters[0].value),
      },
    } : {
      compositeFilter: {
        op: 'AND',
        filters: filters.map(f => ({
          fieldFilter: {
            field: { fieldPath: f.field },
            op: f.op || 'EQUAL',
            value: toFirestoreValue(f.value),
          },
        })),
      },
    },
    orderBy: filters[0]?.orderBy ? [{ field: { fieldPath: filters[0].orderBy }, direction: 'DESCENDING' }] : undefined,
    limit: filters[0]?.limit || 10,
  };

  const res = await fetch(`${FB_BASE.replace('/documents', '')}:runQuery`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!res.ok) throw new Error(`fbQuery ${collection}: ${res.status}`);
  return res.json();
}

/** Convert a JS object to Firestore REST API field format */
function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    fields[k] = toFirestoreValue(v);
  }
  return fields;
}

function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean')  return { booleanValue: v };
  if (typeof v === 'number')   return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string')   return { stringValue: v };
  if (v && v._serverTimestamp) return { timestampValue: new Date().toISOString() };
  if (v instanceof Date)       return { timestampValue: v.toISOString() };
  if (Array.isArray(v))        return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === 'object')   return { mapValue:  { fields: toFirestoreFields(v) } };
  return { stringValue: String(v) };
}

function serverTs() { return { _serverTimestamp: true }; }

/** Extract a plain JS value from a Firestore REST field */
function fromFirestoreValue(v) {
  if (!v) return null;
  if ('stringValue'  in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue);
  if ('doubleValue'  in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue'    in v) return null;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('mapValue'     in v) return fromFirestoreFields(v.mapValue.fields || {});
  if ('arrayValue'   in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  return null;
}

function fromFirestoreFields(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields || {})) {
    obj[k] = fromFirestoreValue(v);
  }
  return obj;
}

function fromFirestoreDoc(doc) {
  if (!doc || !doc.fields) return null;
  return fromFirestoreFields(doc.fields);
}

// ─── Firebase Auth Token Verification ────────────────────────────────────────

/**
 * Verify a Firebase ID token using Google's tokeninfo endpoint.
 * Returns the UID if valid, throws if invalid.
 */
async function fbVerifyToken(idToken) {
  // Use Google's public key endpoint to verify the Firebase ID token.
  // Firebase ID tokens have aud = Firebase project ID (not the numeric sender ID).
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y`,
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
  if (!user || !user.localId) throw new Error('Token has no UID');
  return user.localId;  // UID
}

// ─── Route Handlers ───────────────────────────────────────────────────────────

/**
 * POST /paypal/create-order
 * Body: { usdAmount, idToken }
 * Creates a PayPal order and a pending coinPurchases Firestore record.
 * Returns: { purchaseId, orderId, approveLink }
 */
async function handleCreateOrder(req, env, origin) {
  let body;
  try { body = await req.json(); } catch { return errResp('Invalid JSON', 400, origin, env); }

  const { usdAmount, idToken } = body;
  if (!idToken) return errResp('Authentication required', 401, origin, env);
  if (!usdAmount || isNaN(usdAmount)) return errResp('Invalid amount', 400, origin, env);

  const amount = parseFloat(usdAmount);
  if (amount < MIN_PURCHASE_USD || amount > MAX_PURCHASE_USD) {
    return errResp(`Amount must be between $${MIN_PURCHASE_USD} and $${MAX_PURCHASE_USD}`, 400, origin, env);
  }

  // Verify Firebase auth token
  let uid;
  try { uid = await fbVerifyToken(idToken); }
  catch { return errResp('Authentication failed', 401, origin, env); }

  const coins      = Math.floor(amount * COINS_PER_DOLLAR);
  const purchaseId = `snxp_${uid.slice(0, 8)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const env_label  = env.PAYPAL_ENV || 'sandbox';
  const siteOrigin = env.SNX_ORIGIN || 'https://shadownexussocial.online';
  const returnUrl  = `${siteOrigin}/paypal-return.html?purchaseId=${purchaseId}`;
  const cancelUrl  = `${siteOrigin}/index.html?paypal_cancel=1`;

  // Create PayPal order
  let ppResult;
  try {
    ppResult = await ppCreateOrder(env, { usdAmount: amount, purchaseId, returnUrl, cancelUrl });
  } catch (err) {
    console.error('[SNX-PAYPAL] createOrder error:', err.message);
    return errResp('Payment service temporarily unavailable. Please try again.', 503, origin, env);
  }

  // Record pending purchase in Firestore
  const fbToken = await fbGetToken(env);
  await fbSetDoc(fbToken, 'coinPurchases', purchaseId, {
    uid,
    purchaseId,
    usdAmount:      amount,
    coinsRequested: coins,
    status:         'pending_payment',
    paypalOrderId:  ppResult.orderId,
    paypalEnv:      env_label,
    createdAt:      serverTs(),
    idempotencyKey: purchaseId,
  });

  return jsonResp({
    success:     true,
    purchaseId,
    orderId:     ppResult.orderId,
    approveLink: ppResult.approveLink,
    coins,
    usdAmount:   amount,
    environment: env_label,
  }, 200, origin, env);
}

/**
 * POST /paypal/capture-order
 * Body: { orderId, purchaseId, idToken }
 * Captures an approved PayPal order and credits coins on success.
 * Idempotent — safe to call multiple times with same orderId.
 */
async function handleCaptureOrder(req, env, origin) {
  let body;
  try { body = await req.json(); } catch { return errResp('Invalid JSON', 400, origin, env); }

  const { orderId, purchaseId, idToken } = body;
  if (!idToken) return errResp('Authentication required', 401, origin, env);
  if (!orderId || !purchaseId) return errResp('Missing orderId or purchaseId', 400, origin, env);

  let uid;
  try { uid = await fbVerifyToken(idToken); }
  catch { return errResp('Authentication failed', 401, origin, env); }

  const fbToken = await fbGetToken(env);

  // Load the purchase record
  const purchaseDoc = await fbGetDoc(fbToken, 'coinPurchases', purchaseId);
  const purchase    = fromFirestoreDoc(purchaseDoc);

  if (!purchase) return errResp('Purchase not found', 404, origin, env);
  if (purchase.uid !== uid) return errResp('Purchase does not belong to this user', 403, origin, env);

  // Idempotency: already completed
  if (purchase.status === 'completed') {
    return jsonResp({ success: true, alreadyCompleted: true, coins: purchase.coinsRequested }, 200, origin, env);
  }

  // Prevent double-processing
  if (purchase.status === 'capturing') {
    return errResp('Payment is already being processed. Please wait.', 409, origin, env);
  }

  if (purchase.status !== 'pending_payment') {
    return errResp(`Purchase is in state: ${purchase.status}`, 400, origin, env);
  }

  // Mark as capturing (lock against duplicate calls)
  await fbSetDoc(fbToken, 'coinPurchases', purchaseId, {
    status:        'capturing',
    captureStart:  serverTs(),
  });

  // Capture the PayPal order
  let captureResult;
  try {
    captureResult = await ppCaptureOrder(env, orderId);
  } catch (err) {
    console.error('[SNX-PAYPAL] captureOrder error:', err.message);
    await fbSetDoc(fbToken, 'coinPurchases', purchaseId, {
      status:       'capture_failed',
      captureError: err.message,
      captureAt:    serverTs(),
    });
    return errResp('Payment capture failed. Please try again or contact support.', 502, origin, env);
  }

  const captureStatus = captureResult.status;

  if (captureStatus !== 'COMPLETED') {
    await fbSetDoc(fbToken, 'coinPurchases', purchaseId, {
      status:         'capture_failed',
      paypalStatus:   captureStatus,
      captureAt:      serverTs(),
      captureResult:  JSON.stringify(captureResult).slice(0, 500),
    });
    return errResp(`Payment not completed. Status: ${captureStatus}`, 400, origin, env);
  }

  // Extract verified capture details
  const captureUnit  = captureResult.purchase_units?.[0];
  const captureData  = captureUnit?.payments?.captures?.[0];
  const capturedAmt  = parseFloat(captureData?.amount?.value || '0');
  const captureId    = captureData?.id || '';
  const payerId      = captureResult.payer?.payer_id || '';

  // Verify captured amount matches expected amount (within $0.01 tolerance)
  if (Math.abs(capturedAmt - purchase.usdAmount) > 0.01) {
    await fbSetDoc(fbToken, 'coinPurchases', purchaseId, {
      status:          'amount_mismatch',
      capturedAmount:  capturedAmt,
      expectedAmount:  purchase.usdAmount,
      captureId,
      captureAt:       serverTs(),
    });
    // Log for admin review
    await fbAddDoc(fbToken, 'financialAuditLog', {
      type:           'AMOUNT_MISMATCH',
      purchaseId,
      uid,
      expectedUsd:    purchase.usdAmount,
      capturedUsd:    capturedAmt,
      captureId,
      timestamp:      serverTs(),
      severity:       'HIGH',
    });
    return errResp('Payment amount mismatch. Transaction flagged for review.', 400, origin, env);
  }

  const coins = purchase.coinsRequested;

  // Credit coins to wallet (Firestore transaction via REST)
  // We use a simple read-then-write with the capturing lock preventing races
  const walletDoc = await fbGetDoc(fbToken, 'wallets', uid);
  const wallet    = fromFirestoreDoc(walletDoc) || {};
  const newBalance = (wallet.shadowCoins || 0) + coins;

  await fbSetDoc(fbToken, 'wallets', uid, {
    uid,
    shadowCoins:       newBalance,
    totalPurchasedCoins: (wallet.totalPurchasedCoins || 0) + coins,
    lastPurchaseAt:    serverTs(),
  });

  // Mark purchase as completed
  await fbSetDoc(fbToken, 'coinPurchases', purchaseId, {
    status:         'completed',
    captureId,
    payerId,
    capturedAmount: capturedAmt,
    coinsCredited:  coins,
    completedAt:    serverTs(),
  });

  // Write financial audit log
  await fbAddDoc(fbToken, 'financialAuditLog', {
    type:           'COIN_PURCHASE_COMPLETED',
    purchaseId,
    uid,
    usdAmount:      capturedAmt,
    coinsCredited:  coins,
    captureId,
    paypalOrderId:  orderId,
    payerId,
    newBalance,
    timestamp:      serverTs(),
    environment:    env.PAYPAL_ENV || 'sandbox',
  });

  return jsonResp({
    success:       true,
    coins,
    newBalance,
    usdAmount:     capturedAmt,
    captureId,
  }, 200, origin, env);
}

/**
 * POST /paypal/webhook
 * Receives PayPal webhook events.
 * Verifies signature, processes relevant events idempotently.
 */
async function handleWebhook(req, env, origin) {
  const rawBody = await req.text();
  let event;
  try { event = JSON.parse(rawBody); }
  catch { return new Response('Bad JSON', { status: 400 }); }

  // Verify webhook signature
  const hdrs = Object.fromEntries(req.headers.entries());
  let verified = false;
  try {
    verified = await ppVerifyWebhook(env, { headers: hdrs, body: event });
  } catch (err) {
    console.error('[SNX-PAYPAL] webhook verify error:', err.message);
    return new Response('Verification failed', { status: 400 });
  }

  if (!verified) {
    console.error('[SNX-PAYPAL] webhook signature INVALID');
    return new Response('Invalid signature', { status: 401 });
  }

  const eventId   = event.id;
  const eventType = event.event_type;
  const fbToken   = await fbGetToken(env);

  // Idempotency: check if we already processed this event
  const existingEvent = await fbGetDoc(fbToken, 'paypalWebhooks', eventId);
  if (existingEvent) {
    console.log(`[SNX-PAYPAL] Webhook ${eventId} already processed — skipping`);
    return new Response('OK', { status: 200 });
  }

  // Record webhook received
  await fbSetDoc(fbToken, 'paypalWebhooks', eventId, {
    eventId,
    eventType,
    receivedAt:  serverTs(),
    status:      'processing',
    rawSummary:  JSON.stringify(event).slice(0, 1000),
  });

  try {
    await processWebhookEvent(fbToken, env, event, eventType);
    await fbSetDoc(fbToken, 'paypalWebhooks', eventId, {
      status:      'processed',
      processedAt: serverTs(),
    });
  } catch (err) {
    console.error('[SNX-PAYPAL] webhook process error:', err.message);
    await fbSetDoc(fbToken, 'paypalWebhooks', eventId, {
      status:       'error',
      errorMessage: err.message,
      errorAt:      serverTs(),
    });
    // Return 200 so PayPal doesn't retry infinitely — error is logged for admin
    return new Response('Logged', { status: 200 });
  }

  return new Response('OK', { status: 200 });
}

async function processWebhookEvent(fbToken, env, event, eventType) {
  const resource = event.resource || {};

  switch (eventType) {
    // ── Payment captured (backup path — capture API already handles this) ──
    case 'PAYMENT.CAPTURE.COMPLETED': {
      const captureId  = resource.id;
      const customId   = resource.custom_id || resource.invoice_id || '';
      const amount     = parseFloat(resource.amount?.value || '0');

      await fbAddDoc(fbToken, 'financialAuditLog', {
        type:       'WEBHOOK_CAPTURE_COMPLETED',
        captureId,
        customId,
        amount,
        timestamp:  serverTs(),
        eventId:    event.id,
      });
      break;
    }

    // ── Payment denied / failed ──
    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.REVERSED': {
      const captureId = resource.id;
      // Try to find associated purchase and mark it
      await fbAddDoc(fbToken, 'financialAuditLog', {
        type:       eventType,
        captureId,
        timestamp:  serverTs(),
        eventId:    event.id,
        severity:   'MEDIUM',
      });
      break;
    }

    // ── Refund ──
    case 'PAYMENT.CAPTURE.REFUNDED': {
      const refundId   = resource.id;
      const captureId  = resource.links?.find(l => l.rel === 'up')?.href?.split('/').pop() || '';
      const refundAmt  = parseFloat(resource.amount?.value || '0');

      // Find the purchase by captureId and flag it
      await fbAddDoc(fbToken, 'financialAuditLog', {
        type:       'REFUND_RECEIVED',
        refundId,
        captureId,
        refundAmount: refundAmt,
        timestamp:   serverTs(),
        eventId:     event.id,
        severity:    'HIGH',
        adminAction: 'REVIEW_REQUIRED',
        note:        'Coins may need to be reversed. Check wallet balance for associated UID.',
      });
      break;
    }

    // ── Payout status updates ──
    case 'PAYMENT.PAYOUTSBATCH.SUCCESS': {
      const batchId = resource.batch_header?.payout_batch_id;
      const batchStatus = resource.batch_header?.batch_status;
      if (batchId) {
        await fbAddDoc(fbToken, 'financialAuditLog', {
          type:        'PAYOUT_BATCH_SUCCESS',
          batchId,
          batchStatus,
          timestamp:   serverTs(),
          eventId:     event.id,
        });
        // Find associated payout record and update status
        // (In production: query payouts by paypalBatchId)
      }
      break;
    }

    case 'PAYMENT.PAYOUTSBATCH.DENIED': {
      const batchId = resource.batch_header?.payout_batch_id;
      if (batchId) {
        await fbAddDoc(fbToken, 'financialAuditLog', {
          type:      'PAYOUT_BATCH_DENIED',
          batchId,
          timestamp: serverTs(),
          eventId:   event.id,
          severity:  'HIGH',
        });
      }
      break;
    }

    // ── Merchant onboarding ──
    case 'MERCHANT.ONBOARDING.COMPLETED': {
      const merchantId = resource.merchant_id || resource.tracking_id?.replace('snx_creator_', '');
      const trackingId = resource.tracking_id || '';
      // Extract UID from tracking_id: "snx_creator_{uid}"
      const uid = trackingId.startsWith('snx_creator_') ? trackingId.slice(12) : null;

      if (uid) {
        await fbSetDoc(fbToken, 'paypalAccounts', uid, {
          uid,
          merchantId:       resource.merchant_id || '',
          onboardingStatus: 'completed',
          payoutsEnabled:   resource.payments_receivable || false,
          emailConfirmed:   resource.primary_email_confirmed || false,
          updatedAt:        serverTs(),
        });
        await fbAddDoc(fbToken, 'financialAuditLog', {
          type:       'CREATOR_ONBOARDING_COMPLETE',
          uid,
          merchantId: resource.merchant_id || '',
          timestamp:  serverTs(),
          eventId:    event.id,
        });
      }
      break;
    }

    case 'MERCHANT.PARTNER-CONSENT.REVOKED': {
      const merchantId = resource.merchant_id || '';
      await fbAddDoc(fbToken, 'financialAuditLog', {
        type:       'CREATOR_CONSENT_REVOKED',
        merchantId,
        timestamp:  serverTs(),
        eventId:    event.id,
        severity:   'MEDIUM',
      });
      break;
    }

    default:
      // Log unhandled event types for monitoring
      console.log(`[SNX-PAYPAL] Unhandled webhook event: ${eventType}`);
      break;
  }
}

/**
 * POST /paypal/onboard-creator
 * Body: { idToken }
 * Generates a PayPal Partner Referral link for the creator.
 * Returns: { actionUrl } — creator opens this URL to connect their PayPal.
 */
async function handleOnboardCreator(req, env, origin) {
  let body;
  try { body = await req.json(); } catch { return errResp('Invalid JSON', 400, origin, env); }

  const { idToken } = body;
  if (!idToken) return errResp('Authentication required', 401, origin, env);

  let uid;
  try { uid = await fbVerifyToken(idToken); }
  catch { return errResp('Authentication failed', 401, origin, env); }

  const siteOrigin = env.SNX_ORIGIN || 'https://shadownexussocial.online';
  const returnUrl  = `${siteOrigin}/index.html?paypal_onboard=complete&uid=${uid}`;

  let referralResult;
  try {
    referralResult = await ppCreateReferral(env, { creatorUid: uid, returnUrl });
  } catch (err) {
    console.error('[SNX-PAYPAL] onboard error:', err.message);
    // Check if this is a "marketplace approval required" error
    const isApprovalError = err.message.includes('PERMISSION_DENIED') || err.message.includes('403');
    if (isApprovalError) {
      return errResp(
        'PayPal Marketplace approval is required before creators can connect. See paypal-setup.md for instructions.',
        503, origin, env
      );
    }
    return errResp('PayPal onboarding temporarily unavailable. Please try again.', 503, origin, env);
  }

  const fbToken = await fbGetToken(env);
  await fbSetDoc(fbToken, 'paypalAccounts', uid, {
    uid,
    onboardingStatus: 'pending',
    referralId:       referralResult.referralId || '',
    actionUrl:        referralResult.actionUrl   || '',
    initiatedAt:      serverTs(),
  });

  return jsonResp({
    success:   true,
    actionUrl: referralResult.actionUrl,
  }, 200, origin, env);
}

/**
 * GET /paypal/creator-status?idToken=...
 * Returns the creator's PayPal onboarding and payout status.
 */
async function handleCreatorStatus(req, env, origin) {
  const url     = new URL(req.url);
  const idToken = url.searchParams.get('idToken');
  if (!idToken) return errResp('Authentication required', 401, origin, env);

  let uid;
  try { uid = await fbVerifyToken(idToken); }
  catch { return errResp('Authentication failed', 401, origin, env); }

  const fbToken  = await fbGetToken(env);
  const ppDoc    = await fbGetDoc(fbToken, 'paypalAccounts', uid);
  const ppData   = fromFirestoreDoc(ppDoc) || {};

  // If connected, optionally refresh status from PayPal
  let liveStatus = null;
  if (ppData.merchantId && env.PAYPAL_PARTNER_ID) {
    try {
      liveStatus = await ppGetMerchantStatus(env, ppData.merchantId);
    } catch (_) {
      // Non-fatal — use stored status
    }
  }

  return jsonResp({
    success:          true,
    onboardingStatus: ppData.onboardingStatus || 'not_connected',
    payoutsEnabled:   liveStatus?.payments_receivable ?? ppData.payoutsEnabled ?? false,
    emailConfirmed:   liveStatus?.primary_email_confirmed ?? ppData.emailConfirmed ?? false,
    hasMerchantId:    !!ppData.merchantId,
    environment:      env.PAYPAL_ENV || 'sandbox',
  }, 200, origin, env);
}

/**
 * POST /paypal/payout
 * Body: { idToken }
 * Processes a creator payout request.
 * All validation and 24h cooldown are enforced server-side.
 */
async function handlePayout(req, env, origin) {
  let body;
  try { body = await req.json(); } catch { return errResp('Invalid JSON', 400, origin, env); }

  const { idToken } = body;
  if (!idToken) return errResp('Authentication required', 401, origin, env);

  let uid;
  try { uid = await fbVerifyToken(idToken); }
  catch { return errResp('Authentication failed', 401, origin, env); }

  const fbToken = await fbGetToken(env);

  // 1. Check PayPal connection
  const ppDoc  = await fbGetDoc(fbToken, 'paypalAccounts', uid);
  const ppData = fromFirestoreDoc(ppDoc) || {};

  if (ppData.onboardingStatus !== 'completed') {
    return errResp('Please connect your PayPal account before requesting a payout.', 400, origin, env);
  }
  if (!ppData.payoutsEnabled) {
    return errResp('PayPal requires additional verification before you can receive payouts.', 400, origin, env);
  }
  if (!ppData.paypalEmail && !ppData.merchantId) {
    return errResp('PayPal payout account not fully configured.', 400, origin, env);
  }

  // 2. Load creator earnings
  const earnDoc  = await fbGetDoc(fbToken, 'creatorEarnings', uid);
  const earn     = fromFirestoreDoc(earnDoc) || {};
  const available = earn.availableCoins || 0;

  if (available < (MIN_PAYOUT_USD * COINS_PER_DOLLAR)) {
    return errResp(`Minimum cash-out is $${MIN_PAYOUT_USD.toFixed(2)}. You have ${available} coins available.`, 400, origin, env);
  }

  // 3. Enforce 24-hour cooldown (server-side — never trust client)
  const lastPayoutDoc = await fbQuery(fbToken, 'creatorPayouts', [
    { field: 'creatorId', value: uid, orderBy: 'requestedAt', limit: 1 }
  ]);
  const payoutDocs = (lastPayoutDoc || []).filter(r => r.document);
  if (payoutDocs.length > 0) {
    const lastPayout  = fromFirestoreDoc(payoutDocs[0].document);
    const lastPayoutTs = lastPayout?.requestedAt;
    if (lastPayoutTs) {
      const lastTs  = lastPayoutTs instanceof Date ? lastPayoutTs.getTime() : new Date(lastPayoutTs).getTime();
      const cooldownMs = PAYOUT_COOLDOWN_H * 60 * 60 * 1000;
      const elapsed    = Date.now() - lastTs;
      if (elapsed < cooldownMs) {
        const hoursLeft = Math.ceil((cooldownMs - elapsed) / 3600000);
        return errResp(
          `You can request another payout after your 24-hour payout window. ${hoursLeft} hour${hoursLeft !== 1 ? 's' : ''} remaining.`,
          429, origin, env
        );
      }
    }
  }

  // 4. Check no payout is already processing
  if (earn.lockedCoins > 0) {
    return errResp('A payout is already processing. Please wait for it to complete.', 409, origin, env);
  }

  // 5. Calculate payout amount
  const usdAmount   = available / COINS_PER_DOLLAR;
  const payoutId    = `snxo_${uid.slice(0, 8)}_${Date.now().toString(36)}`;

  // 6. Lock earnings (prevent double-payout)
  await fbSetDoc(fbToken, 'creatorEarnings', uid, {
    availableCoins: 0,
    lockedCoins:    (earn.lockedCoins || 0) + available,
    lastPayoutAt:   serverTs(),
  });

  // 7. Create payout record
  await fbSetDoc(fbToken, 'creatorPayouts', payoutId, {
    payoutId,
    creatorId:      uid,
    coinsLocked:    available,
    usdAmount:      parseFloat(usdAmount.toFixed(2)),
    currency:       'USD',
    status:         'processing',
    requestedAt:    serverTs(),
    paypalEmail:    ppData.paypalEmail || '',
    merchantId:     ppData.merchantId  || '',
    environment:    env.PAYPAL_ENV     || 'sandbox',
  });

  // 8. Send PayPal payout
  let paypalResult;
  try {
    const receiverEmail = ppData.paypalEmail;
    if (!receiverEmail) throw new Error('Creator PayPal email not on file');

    paypalResult = await ppSendPayout(env, {
      payoutId,
      receiverEmail,
      amountUsd: usdAmount.toFixed(2),
      note:      `Shadow Nexus Social creator earnings — ${available} coins`,
    });
  } catch (err) {
    console.error('[SNX-PAYPAL] payout error:', err.message);
    // Unlock earnings on failure
    await fbSetDoc(fbToken, 'creatorEarnings', uid, {
      availableCoins: available,
      lockedCoins:    Math.max(0, (earn.lockedCoins || 0)),
      lastPayoutAt:   serverTs(),
    });
    await fbSetDoc(fbToken, 'creatorPayouts', payoutId, {
      status:       'failed',
      failureReason: err.message,
      failedAt:     serverTs(),
    });
    await fbAddDoc(fbToken, 'financialAuditLog', {
      type:         'PAYOUT_FAILED',
      payoutId,
      uid,
      usdAmount:    parseFloat(usdAmount.toFixed(2)),
      error:        err.message,
      timestamp:    serverTs(),
      severity:     'HIGH',
    });
    return errResp('Payout processing failed. Your earnings have been unlocked. Please try again.', 502, origin, env);
  }

  const batchId = paypalResult.batch_header?.payout_batch_id || '';

  // 9. Update payout record with PayPal batch ID
  await fbSetDoc(fbToken, 'creatorPayouts', payoutId, {
    status:         'processing',
    paypalBatchId:  batchId,
    paypalResponse: JSON.stringify(paypalResult).slice(0, 500),
    submittedAt:    serverTs(),
  });

  // 10. Write audit log
  await fbAddDoc(fbToken, 'financialAuditLog', {
    type:          'PAYOUT_SUBMITTED',
    payoutId,
    uid,
    usdAmount:     parseFloat(usdAmount.toFixed(2)),
    coinsLocked:   available,
    paypalBatchId: batchId,
    environment:   env.PAYPAL_ENV || 'sandbox',
    timestamp:     serverTs(),
  });

  return jsonResp({
    success:      true,
    payoutId,
    usdAmount:    parseFloat(usdAmount.toFixed(2)),
    status:       'processing',
    paypalBatchId: batchId,
    message:      'Your payout request is being processed. You will receive it in your PayPal account shortly.',
  }, 200, origin, env);
}

/**
 * POST /paypal/grant-test-coins
 * Body: { idToken, recipientUid, reason? }
 *
 * Founder-only: grants exactly 500 test Shadow Coins to a user for testing.
 * These coins carry NO real cash value and CANNOT trigger PayPal payouts.
 * The wallet write uses integerValue so Firestore type rules are satisfied.
 */
async function handleGrantTestCoins(req, env, origin) {
  let body;
  try { body = await req.json(); } catch { return errResp('Invalid JSON', 400, origin, env); }

  const { idToken, recipientUid, reason } = body;
  if (!idToken)      return errResp('Authentication required', 401, origin, env);
  if (!recipientUid) return errResp('recipientUid is required', 400, origin, env);

  // Verify the caller's Firebase ID token
  let callerUid;
  try { callerUid = await fbVerifyToken(idToken); }
  catch { return errResp('Authentication failed', 401, origin, env); }

  const fbToken = await fbGetToken(env);

  // Verify caller is a Founder (role == 'founder' in /users/{uid})
  const callerDoc  = await fbGetDoc(fbToken, 'users', callerUid);
  const callerData = fromFirestoreDoc(callerDoc) || {};
  if (callerData.role !== 'founder') {
    return errResp('Permission denied — Founders only.', 403, origin, env);
  }

  // Verify recipient exists
  const recipientDoc  = await fbGetDoc(fbToken, 'users', recipientUid);
  const recipientData = fromFirestoreDoc(recipientDoc) || {};
  if (!recipientDoc) {
    return errResp('Recipient user not found.', 404, origin, env);
  }
  const recipientName = recipientData.displayName || recipientData.username || recipientUid;

  const TEST_GRANT_AMOUNT = 500;  // fixed test amount

  // Read current wallet balance
  const walletDoc  = await fbGetDoc(fbToken, 'wallets', recipientUid);
  const walletData = fromFirestoreDoc(walletDoc) || {};
  const newBalance = (walletData.shadowCoins || 0) + TEST_GRANT_AMOUNT;

  // Write updated wallet (integer so Firestore type rules pass)
  await fbSetDoc(fbToken, 'wallets', recipientUid, {
    uid:              recipientUid,
    shadowCoins:      newBalance,
    testCoinsGranted: ((walletData.testCoinsGranted || 0) + TEST_GRANT_AMOUNT),
    lastGrantAt:      serverTs(),
  });

  // Write immutable grant log record
  const txId = `snxt_${callerUid.slice(0, 6)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  await fbSetDoc(fbToken, 'testCoinGrants', txId, {
    txId,
    grantedBy:       callerUid,
    recipientUid,
    recipientName,
    amount:          TEST_GRANT_AMOUNT,
    reason:          reason || 'Test grant',
    newBalance,
    environment:     env.PAYPAL_ENV || 'sandbox',
    cashValue:       0,
    isTestOnly:      true,
    grantedAt:       serverTs(),
  });

  return jsonResp({
    success:       true,
    txId,
    amount:        TEST_GRANT_AMOUNT,
    recipientUid,
    recipientName,
    newBalance,
    note:          'Test coins only — no cash value, cannot be paid out.',
  }, 200, origin, env);
}

// ─── Main Fetch Handler ───────────────────────────────────────────────────────

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const url    = new URL(req.url);
    const path   = url.pathname;

    // Preflight CORS
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, env),
      });
    }

    // Health check
    if (path === '/health' && req.method === 'GET') {
      return jsonResp({
        status:      'ok',
        service:     'snx-paypal-worker',
        environment: env.PAYPAL_ENV || 'sandbox',
        version:     '1.0.0',
      }, 200, origin, env);
    }

    // Route dispatch
    try {
      if (path === '/paypal/create-order'    && req.method === 'POST') return handleCreateOrder(req, env, origin);
      if (path === '/paypal/capture-order'   && req.method === 'POST') return handleCaptureOrder(req, env, origin);
      if (path === '/paypal/webhook'         && req.method === 'POST') return handleWebhook(req, env, origin);
      if (path === '/paypal/onboard-creator' && req.method === 'POST') return handleOnboardCreator(req, env, origin);
      if (path === '/paypal/creator-status'  && req.method === 'GET')  return handleCreatorStatus(req, env, origin);
      if (path === '/paypal/payout'          && req.method === 'POST') return handlePayout(req, env, origin);
      if (path === '/paypal/grant-test-coins'&& req.method === 'POST') return handleGrantTestCoins(req, env, origin);

      return errResp('Not found', 404, origin, env);
    } catch (err) {
      console.error('[SNX-PAYPAL] Unhandled error:', err.message, err.stack);
      return errResp('Internal server error', 500, origin, env);
    }
  },
};
