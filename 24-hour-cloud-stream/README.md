# 24-Hour Audio Cloud Stream

---

## PROJECT

**24-Hour Audio Cloud Stream** — a standalone extraction of the working Cloud Radio system from Shadow Nexus Social.

This package lets a creator go live with a server-side 24-hour audio broadcast without a camera or live video.  
Audio files are served directly from Cloudflare R2. A Cloudflare Worker (backed by a Durable Object) advances the playlist automatically. Listeners receive synchronized real-time playback via Firestore.

---

## SOURCE

Shadow Nexus Social  
Repository: `shadownexussocial-main`

---

## SOURCE VERSION

The **working implementation** extracted here is the **Cloud Radio (CloudStream v1.4.0)** feature:

- Worker self-identifies as `{ worker: 'cloudstream', v: '1.4.0' }` at `GET /health`
- Client code is `cloud-stream.js` (Shadow Nexus Social, 2026)
- Cloudflare Durable Object class: `CloudStreamScheduler`
- Firebase SDK: `10.12.0`
- Firebase project: `horr-a08f4`
- Deployed worker: `snx-cloudstream.nthntjrn.workers.dev`

---

## ENTRY POINT

```
24-hour-cloud-stream/index.html
```

Open `index.html` in a browser (served from any static host) or deploy the folder to a CDN / Firebase Hosting. Firebase Auth must be configured on the same domain or `localhost` must be in the authorised domains list.

---

## REQUIRED FILES

```
24-hour-cloud-stream/
│
├── index.html                         — App shell & HTML (adapted from cloud-stream.html)
│
├── css/
│   └── cloud-stream.css               — All UI styles (standalone, no external CSS)
│
├── js/
│   └── cloud-stream.js                — All client-side logic (creator + listener)
│
├── workers/
│   └── cloudstream-worker.js          — Cloudflare Worker (server-side brain)
│
├── assets/
│   ├── apple-touch-icon.png           — PWA icon
│   ├── favicon.ico                    — Favicon
│   ├── favicon-16x16.png              — Favicon 16px
│   └── favicon-32x32.png             — Favicon 32px
│
├── config/
│   └── wrangler-studio.jsonc          — Worker deployment config (wrangler deploy)
│
└── README.md                          — This file
```

---

## FIREBASE

The Cloud Stream requires the following Firebase services from project **`horr-a08f4`**:

| Service | Purpose |
|---------|---------|
| **Firebase Authentication** | Creator sign-in; ID tokens used to authenticate worker API calls |
| **Firestore** | `cloudStreams/{streamId}` — broadcast record; `studioCloudStreamMusic/{streamId}` — live Now Playing (worker-owned); `studioPlaylists/{uid}/playlists/{plId}` — creator's playlist metadata; `cloudStreamTracks/{uid}/tracks/{trackId}` — creator's uploaded track library; `liveRooms/{uid}` — live discovery feed entry; `users/{uid}` — display name / avatar / role |
| **Firebase SDK** | CDN-loaded `firebase/app`, `firebase/auth`, `firebase/firestore` v10.12.0 |

> **Credentials:** The Firebase config (API key, project ID, etc.) is embedded directly in `js/cloud-stream.js`. These are web-tier, client-safe credentials. Do NOT embed Firebase Admin credentials or service account keys in this file.

The Firebase config in `js/cloud-stream.js` is identical to the canonical `firebase-config.js` in Shadow Nexus Social.

---

## CLOUDFLARE

| Resource | Details |
|----------|---------|
| **Worker** | `snx-cloudstream` deployed at `snx-cloudstream.nthntjrn.workers.dev` |
| **Worker source** | `workers/cloudstream-worker.js` |
| **Wrangler config** | `config/wrangler-studio.jsonc` |
| **KV Namespace** | `cloudStreamKV` (id: `f0d77e4a5397436ba8e01ebe2fd4fe9f`) — stores stream state, music queue, events |
| **Durable Object** | `CloudStreamScheduler` class (inside `cloudstream-worker.js`) — drives 24-hour track alarm scheduling |
| **R2 Bucket** | `legend` (binding `BUCKET`, in `upload-worker.js`) — audio files are stored here; URLs are embedded in Firestore track docs and played directly by the browser |

### Worker Secrets (must be set via `wrangler secret put`)

```
STREAM_SECRET      — Signs/verifies stream auth tokens
FIREBASE_API_KEY   — Firebase Web API key (used for server-side Firestore REST writes only)
```

### Worker API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/stream/start` | Start a new broadcast |
| POST | `/api/stream/stop` | Stop an active broadcast |
| POST | `/api/stream/control` | Scene / music control actions |
| GET  | `/api/stream/health/{streamId}` | Poll stream health + Now Playing |
| GET  | `/api/stream/sync/{streamId}` | Listener sync (public, no auth) |
| GET  | `/api/stream/active/{uid}` | Check if user already has an active stream |
| POST | `/api/stream/music/set` | Replace music queue |
| POST | `/api/stream/music/control` | Skip / pause / resume / volume |
| GET  | `/api/stream/music/{streamId}` | Read current music state |
| POST | `/api/admin/stream/stop` | Force-stop (founder only) |
| GET  | `/api/admin/streams` | List all active streams (founder only) |
| POST | `/api/destinations/save` | Save RTMP destination key |
| POST | `/api/destinations/remove` | Remove RTMP destination |
| GET  | `/api/destinations/list` | List configured destinations |
| GET  | `/health` | Worker liveness check |

### Deploying the Worker

```bash
# From the extraction root — note: wrangler.jsonc picks up the config below
npx wrangler deploy --config config/wrangler-studio.jsonc

# Set required secrets
npx wrangler secret put STREAM_SECRET --config config/wrangler-studio.jsonc
npx wrangler secret put FIREBASE_API_KEY --config config/wrangler-studio.jsonc
```

---

## DEPENDENCIES

| Dependency | Where | Notes |
|-----------|-------|-------|
| Firebase JS SDK v10.12.0 | CDN (gstatic.com) | Loaded via importmap in `index.html`; no npm install needed |
| Cloudflare Workers | Cloudflare | Already deployed at `snx-cloudstream.nthntjrn.workers.dev` |
| Cloudflare KV | Cloudflare | `cloudStreamKV` namespace bound in `wrangler-studio.jsonc` |
| Cloudflare Durable Objects | Cloudflare | `CloudStreamScheduler` class registered in `wrangler-studio.jsonc` |
| Cloudflare R2 | Cloudflare | `legend` bucket — audio file storage; binding in `wrangler.jsonc` (upload worker, not this worker) |

---

## NAVIGATION LINKS BACK TO SHADOW NEXUS SOCIAL

The following links in `index.html` intentionally point back to Shadow Nexus Social:

| Element | Destination | Purpose |
|---------|------------|---------|
| `← Studio` header button | `/?snxPage=studioPage` | Return to 24-Hour Studio page |
| Auth gate link | `/?snxPage=studioPage` | Sign-in redirect |
| Manage Playlist button (JS) | `/?snxPage=studioPage` | Navigate to playlist management |
| Offline player back link | `/` | Return to SNX home |
| Playlist hint link | `/` | Link to 24-Hour Studio |

When integrating back into Shadow Nexus Social, these links work as-is.  
When running standalone, update `/?snxPage=studioPage` to point to wherever the playlist/studio management lives.

---

## INTEGRATION NOTES

### What the Cloud Stream originally relied on in Shadow Nexus Social

| System | Dependency |
|--------|-----------|
| **Firebase Auth** | Users must have SNX accounts to broadcast. The auth gate checks `onAuthStateChanged`. |
| **User profiles** (`users/{uid}`) | Creator's `displayName`, `username`, `avatar`, `role` are read at startup for the status panel and liveRooms feed entry. |
| **Studio Playlists** (`studioPlaylists/{uid}/playlists`) | Creator must have created at least one playlist in the 24-Hour Studio before going live. The Cloud Stream reads these playlists to populate the queue. |
| **Cloud Stream Tracks** (`cloudStreamTracks/{uid}/tracks`) | Individual track documents including `title`, `artist`, `url` (R2 CDN URL), `duration`. Tracks are uploaded via the Studio upload flow (separate from this extraction). |
| **Live Rooms** (`liveRooms/{uid}`) | The Cloud Stream creates/updates this document on Go Live / End Live so the SNX feed shows the stream as live. This is a write dependency; the Cloud Stream creates its own entry. |
| **R2 Bucket** (`legend`) | Audio files are stored in Cloudflare R2 and their CDN URLs are embedded in `cloudStreamTracks` documents. The upload flow is NOT extracted (it lives in `upload-worker.js` / the Studio page). |

### What is NOT required from Shadow Nexus Social

Feed, Profiles, Messages, Notifications, PayPal, Coins, Gifts, Wallet, Admin Panel, Moderation, old Live Studio (`studio.js`/`studio.css`/`live.js`/`webrtc.js`), or any other SNX-specific UI.

---

## TEST CHECKLIST

- [ ] `index.html` opens and shows the loading spinner
- [ ] After Firebase Auth resolves, the app shows Create Broadcast form or active stream panel
- [ ] Selecting a playlist populates the queue preview
- [ ] Clicking GO LIVE FOR 24 HOURS starts the broadcast (handoff steps complete)
- [ ] Stream status panel shows LIVE badge, title, host, expiry countdown
- [ ] Another device / account opens `index.html?id=<streamId>` and sees the listener player
- [ ] Listener hears audio (browser autoplay may require user interaction)
- [ ] Now Playing updates when the Durable Object alarm advances the track
- [ ] Skip Track advances to the next track
- [ ] Listener count displayed in the status panel (updated by worker health)
- [ ] Cover artwork displays if uploaded
- [ ] END CLOUD BROADCAST stops the stream and cleans up Firestore
- [ ] `GET /health` at the worker URL returns `{ ok: true, worker: "cloudstream", v: "1.4.0" }`
- [ ] No camera is requested at any point
- [ ] No Live Studio UI appears

---

## REMAINING DEPENDENCIES ON SHADOW NEXUS SOCIAL

1. **Firebase project `horr-a08f4`** — Auth, Firestore, and the security rules deployed there. The Cloud Stream does not operate without access to this project.
2. **Track library** — Tracks must exist in `cloudStreamTracks/{uid}/tracks` with valid R2 CDN URLs. The upload flow (`upload-worker.js` + Studio page) is in Shadow Nexus Social.
3. **Playlists** — Playlists must exist in `studioPlaylists/{uid}/playlists`. Created via the Studio page in Shadow Nexus Social.
4. **Cloudflare R2 bucket `legend`** — Audio files must already be uploaded. The upload worker is in Shadow Nexus Social.
5. **Cloudflare Worker `snx-cloudstream`** — Already deployed and running. `wrangler-studio.jsonc` is included to redeploy if needed.
