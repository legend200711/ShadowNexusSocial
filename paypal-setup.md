# Shadow Nexus Social — PayPal Sandbox Setup Guide

## Architecture

```
shadownexussocial.online  (static site)
    │
    │  snx-gifts.js calls:
    │  https://yellow-term-11e6.nthntjrn.workers.dev/paypal/*
    ▼
yellow-term-11e6  (Cloudflare Worker — already deployed)
    │
    ├── /paypal/create-order     POST  — creates PayPal order, returns approval link
    ├── /paypal/capture-order    POST  — captures approved order, credits Shadow Coins
    ├── /paypal/webhook          POST  — receives PayPal events (idempotent)
    ├── /paypal/payout           POST  — creator cash-out via PayPal Payouts API
    ├── /paypal/creator-status   GET   — creator PayPal onboarding status
    ├── /paypal/onboard-creator  POST  — generate PayPal Partner Referral link
    └── /paypal/health           GET   — health check (test this first)
    │
    ├──► PayPal REST API (sandbox.paypal.com or paypal.com)
    └──► Firestore REST API  (project: horr-a08f4)
```

**Worker URL:** `https://yellow-term-11e6.nthntjrn.workers.dev`  
**Webhook endpoint:** `https://yellow-term-11e6.nthntjrn.workers.dev/paypal/webhook`  
**Health check:** `https://yellow-term-11e6.nthntjrn.workers.dev/paypal/health`

> ⚠️ Do **not** use `https://shadownexussocial.online/paypal/webhook` as the webhook URL.  
> The live Worker URL above is the correct webhook target.

---

## Step 1 — Create a PayPal Developer App

1. Go to [developer.paypal.com](https://developer.paypal.com) → **My Apps & Credentials**
2. Under the **Sandbox** tab → **Create App**
   - Name: `Shadow Nexus Social`
   - App type: **Merchant**
3. After creation, copy:
   - **Client ID** (safe to share, goes in the worker secret)
   - **Secret** (keep private — goes in the worker secret, never in frontend code)

### Enable additional features on your Sandbox app

Under your app settings → **Additional features**:

| Feature | Required for |
|---------|-------------|
| **Payouts** | Sending earnings to creators |
| **Partner Referrals** | Creator PayPal onboarding (optional initially) |

> **Payouts API requires PayPal approval.** Apply at [developer.paypal.com/docs/payouts/](https://developer.paypal.com/docs/payouts/). Approval takes 1–3 business days. The gifting and coin system works without it — only creator cash-outs need it.

---

## Step 2 — Create Sandbox Test Accounts

1. PayPal Developer Dashboard → **Sandbox** → **Accounts**
2. You should already have a default **Business** and **Personal** account
3. Note the sandbox personal buyer's email and password — you'll use these to test coin purchases

---

## Step 3 — Register a Webhook

1. PayPal Developer Dashboard → Your Sandbox App → **Webhooks**
2. Click **Add Webhook**
3. **Webhook URL:** `https://yellow-term-11e6.nthntjrn.workers.dev/paypal/webhook`
4. Subscribe to these events:

   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.CAPTURE.DENIED`
   - `PAYMENT.CAPTURE.REFUNDED`
   - `CHECKOUT.ORDER.COMPLETED`

5. Click **Save** → copy the **Webhook ID** shown

---

## Step 4 — Get a Firebase Service Account Key

The Worker uses the Firestore REST API to credit coins and record transactions. It needs a Firebase service account.

1. [Firebase Console](https://console.firebase.google.com) → Project **horr-a08f4**
2. ⚙️ **Project Settings** → **Service accounts** tab
3. Click **Generate new private key** → **Generate key**
4. A `.json` file downloads — keep it safe, never commit it to git

---

## Step 5 — Set Secrets on the Worker

Run each command in your terminal from the project directory. Paste the value when prompted.

```bash
# PayPal Sandbox Client ID (from Step 1)
npx wrangler secret put PAYPAL_CLIENT_ID --name yellow-term-11e6

# PayPal Sandbox Client Secret (from Step 1)
npx wrangler secret put PAYPAL_CLIENT_SECRET --name yellow-term-11e6

# PayPal Webhook ID (from Step 3)
npx wrangler secret put PAYPAL_WEBHOOK_ID --name yellow-term-11e6

# Firebase Service Account JSON (from Step 4)
# Open the downloaded JSON file, copy ALL of its contents, then paste when prompted
npx wrangler secret put FIREBASE_SERVICE_KEY --name yellow-term-11e6
```

> `FIREBASE_WEB_API_KEY` is already set on this worker — no action needed for that one.

---

## Step 6 — Verify the Worker

After setting secrets, confirm the health check shows `paypalConfigured: true`:

```bash
curl https://yellow-term-11e6.nthntjrn.workers.dev/paypal/health
```

Expected response:
```json
{
  "status": "ok",
  "service": "snx-paypal",
  "worker": "yellow-term-11e6",
  "environment": "sandbox",
  "paypalConfigured": true,
  "firestoreConfigured": true
}
```

---

## Step 7 — Deploy Firestore Security Rules + Indexes

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

---

## Step 8 — Test End-to-End

### Test coin purchase
1. Open `https://shadownexussocial.online` and sign in
2. Click the **🪙** coin pill (top right)
3. Select **$1.00** → **💳 Pay with PayPal**
4. Sign in with your **sandbox buyer account** on PayPal
5. Approve → you're redirected to `paypal-return.html`
6. Should show "🪙 100 Shadow Coins added!"
7. Your coin balance in the app should update to 100

### Test gift sending
1. Navigate to any post that isn't yours
2. Click **🎁** → select **Wolf** (100 coins)
3. The gift animation should play
4. The creator's wallet should show +90 coins earned

### Test STAY LEGENDARY
1. Have 300+ coins
2. Open gift tray → select **STAY LEGENDARY**
3. Full-screen blue-flame animation should play and auto-dismiss

### Test Creator Cash-Out
1. Sign in as a creator with gift earnings ≥ 100 coins ($1.00)
2. **Profile → Creator Studio → Wallet**
3. Connect PayPal account
4. Click **💰 Cash Out**

---

## Step 9 — Switch to Live (Production)

1. Create a **Live** PayPal app (same steps, switch to **Live** tab)
2. Update `wrangler.jsonc`:
   ```json
   "PAYPAL_ENV": "live"
   ```
3. Update secrets with live credentials:
   ```bash
   npx wrangler secret put PAYPAL_CLIENT_ID --name yellow-term-11e6
   npx wrangler secret put PAYPAL_CLIENT_SECRET --name yellow-term-11e6
   npx wrangler secret put PAYPAL_WEBHOOK_ID --name yellow-term-11e6
   ```
4. Register a live webhook (same URL, different PayPal app)
5. Re-deploy:
   ```bash
   npx wrangler deploy --config wrangler.jsonc
   ```

---

## Troubleshooting

### `paypalConfigured: false` in health check
→ `PAYPAL_CLIENT_ID` and/or `PAYPAL_CLIENT_SECRET` secrets not set. Run Step 5.

### `firestoreConfigured: false` in health check
→ `FIREBASE_SERVICE_KEY` secret not set. Run Step 5.

### "Payment service temporarily unavailable"
→ Check worker logs: `npx wrangler tail --name yellow-term-11e6`

### Coins not appearing after PayPal payment
→ Check `coinPurchases/{purchaseId}` in Firestore — should be `status: completed`  
→ Check worker tail logs for capture errors

### "Authentication failed" on any request
→ Firebase ID token is invalid or expired — user should refresh the page and try again  
→ Confirm `FIREBASE_WEB_API_KEY` secret is set: `npx wrangler secret list --name yellow-term-11e6`

### CORS error in browser console
→ The worker already includes `https://shadownexussocial.online` in `ALLOWED_ORIGINS` — verify your site domain matches exactly

### Firestore permission denied
→ Re-deploy security rules: `firebase deploy --only firestore:rules`

---

## Coin Exchange Rate

```
100 Shadow Coins = $1.00 USD
$0.01  →     1 coin
$1.00  →   100 coins
$5.00  →   500 coins
$10.00 → 1,000 coins
$25.00 → 2,500 coins
$50.00 → 5,000 coins
$100.00 → 10,000 coins
```

## Revenue Split

```
Gift sender pays:  X coins
Creator receives:  floor(X × 0.90) — 90%
Platform retains:  X − floor(X × 0.90) — 10%

Example — Wolf (100 coins = $1.00):
  Creator:  90 coins  = $0.90
  Platform: 10 coins  = $0.10
```

Split is calculated server-side in `upload-worker.js`. Client values are never trusted.

---

## Files Changed

| File | Change |
|------|--------|
| `upload-worker.js` | PayPal handler functions + `/paypal/*` routes added |
| `wrangler.jsonc` | Added `PAYPAL_ENV` and `SNX_ORIGIN` vars |
| `snx-gifts.js` | `SNX_PAYPAL_WORKER` now absolute URL to worker |
| `paypal-return.html` | Capture URL now absolute URL to worker |
| `firestore.rules` | Financial collection security rules |
| `firestore.indexes.json` | Composite indexes for new collections |

*Shadow Nexus Social — PayPal Integration v1.0*  
*Worker: yellow-term-11e6.nthntjrn.workers.dev*
