/**
 * Shadow Nexus — webrtc.js
 * WebRTC engine for multi-peer live streaming (1 host + up to 7 guests).
 *
 * Architecture:
 *  - Host: creates an RTCPeerConnection per guest. Sends its local stream to
 *    each guest and receives the guest's stream.
 *  - Guest: creates ONE RTCPeerConnection to the host. Sends its local stream
 *    and receives the host stream.
 *
 * Signaling is done via Firebase Realtime Database (see firebase-live.js).
 */

/* ── ICE server config ──────────────────────────────────────────────
   STUN + TURN. TURN is REQUIRED, not optional: without a relay, peers on
   symmetric / carrier-grade NAT (most mobile networks) establish a direct
   path that survives only until the NAT mapping expires (~30-60 s), then
   the video freezes to black. That was the "boxes go black after a minute"
   bug. We include TURN over UDP, TCP, and TLS/443 so the media keeps
   flowing even through firewalls that drop UDP. Kept identical to the list
   used by live.js so every peer path behaves the same. */
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // Metered OpenRelay — free TURN with UDP / TCP / TLS transports.
    { urls: 'turn:openrelay.metered.ca:80',                 username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:80?transport=tcp',   username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',                username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp',  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
  iceCandidatePoolSize: 10,
};

/* ── Max guests per room (host = 1, guests = 7, total 8 boxes) ───────── */
export const MAX_GUESTS = 7;

/* ═══════════════════════════════════════════════
   LOCAL MEDIA
════════════════════════════════════════════════ */

let _localStream = null;
let _facingMode  = 'user'; // 'user' | 'environment'
let _camEnabled  = true;
let _micEnabled  = true;

/** Acquire camera + mic. Returns the MediaStream. */
export async function getLocalStream(video = true, audio = true) {
  const constraints = {
    video: video ? { facingMode: _facingMode, width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    audio: audio
  };
  try {
    _localStream = await navigator.mediaDevices.getUserMedia(constraints);
    return _localStream;
  } catch (err) {
    console.warn('[WebRTC] getUserMedia failed, trying audio-only:', err.message);
    // Fallback: audio only
    try {
      _localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      return _localStream;
    } catch (e) {
      console.error('[WebRTC] Media access denied:', e.message);
      return null;
    }
  }
}

/** Stop all local tracks and release the stream. */
export function stopLocalStream() {
  if (_localStream) {
    _localStream.getTracks().forEach(t => t.stop());
    _localStream = null;
  }
}

/** Toggle camera track on/off. */
export function toggleCamera(enabled) {
  _camEnabled = enabled;
  if (_localStream) {
    _localStream.getVideoTracks().forEach(t => (t.enabled = enabled));
  }
  return _camEnabled;
}

/** Toggle microphone track on/off. */
export function toggleMic(enabled) {
  _micEnabled = enabled;
  if (_localStream) {
    _localStream.getAudioTracks().forEach(t => (t.enabled = enabled));
  }
  return _micEnabled;
}

/** Flip front/back camera by re-acquiring with opposite facingMode. */
export async function flipCamera() {
  _facingMode = _facingMode === 'user' ? 'environment' : 'user';
  const oldStream = _localStream;
  const newStream = await getLocalStream(true, _micEnabled);
  if (oldStream) oldStream.getTracks().forEach(t => t.stop());
  return newStream;
}

export function getLocalStreamRef() { return _localStream; }
export function isCamEnabled()      { return _camEnabled; }
export function isMicEnabled()      { return _micEnabled; }

/* ═══════════════════════════════════════════════
   PEER CONNECTION FACTORY
════════════════════════════════════════════════ */

/**
 * Create a new RTCPeerConnection with our local stream attached.
 * @param {Function} onTrack  - called with (stream, peerId) when remote track arrives
 * @param {Function} onIce    - called with (candidate) when local ICE candidate is ready
 * @param {Function} onState  - called with (state) on connection state change
 * @param {string}   peerId   - identifier for the remote peer (guestUid or 'host')
 */
export function createPeerConnection(onTrack, onIce, onState, peerId) {
  const pc = new RTCPeerConnection(ICE_SERVERS);

  /* Attach local tracks */
  if (_localStream) {
    _localStream.getTracks().forEach(track => pc.addTrack(track, _localStream));
  }

  /* Receive remote tracks */
  pc.ontrack = (e) => {
    const [stream] = e.streams;
    if (stream && onTrack) onTrack(stream, peerId);
  };

  /* ICE candidate collection */
  pc.onicecandidate = (e) => {
    if (e.candidate && onIce) onIce(e.candidate.toJSON());
  };

  /* Connection state changes */
  pc.onconnectionstatechange = () => {
    if (onState) onState(pc.connectionState, peerId);
  };

  /* ── ICE-level recovery ──────────────────────────────────────────
     A `disconnected` ICE state is usually TRANSIENT — the browser can
     often recover on its own within a few seconds. We give it a grace
     window, and if it hasn't recovered we trigger an ICE restart
     (renegotiation with fresh candidates) instead of tearing the box
     down. This is what stops the "box goes black and never comes back"
     symptom. Only a real `failed` state is treated as needing teardown
     (handled by onconnectionstatechange in the managers). */
  pc._iceRecoverTimer = null;
  pc.oniceconnectionstatechange = () => {
    const st = pc.iceConnectionState;
    console.log(`[WebRTC][${peerId}] ICE state: ${st}`);
    if (st === 'disconnected') {
      if (pc._iceRecoverTimer) clearTimeout(pc._iceRecoverTimer);
      pc._iceRecoverTimer = setTimeout(() => {
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
          console.warn(`[WebRTC][${peerId}] ICE still down — restarting ICE`);
          if (typeof pc._onIceRestartNeeded === 'function') {
            pc._onIceRestartNeeded();
          } else {
            try { pc.restartIce && pc.restartIce(); } catch (_) {}
          }
        }
      }, 4000); // 4s grace for self-recovery before forcing a restart
    } else if (st === 'connected' || st === 'completed') {
      if (pc._iceRecoverTimer) { clearTimeout(pc._iceRecoverTimer); pc._iceRecoverTimer = null; }
    }
  };

  return pc;
}

/* ═══════════════════════════════════════════════
   HOST SIDE — manages up to 7 guest connections
════════════════════════════════════════════════ */

export class HostPeerManager {
  constructor({ onGuestStream, onGuestLeave, onIceForGuest, onStateChange, onRenegotiate }) {
    this._peers        = {};   // guestUid → RTCPeerConnection
    this._onGuestStream = onGuestStream;
    this._onGuestLeave  = onGuestLeave;
    this._onIceForGuest = onIceForGuest;
    this._onStateChange = onStateChange;
    // Optional: called with (guestUid, offerSdp) when the host needs to send a
    // fresh ICE-restart offer to a guest whose connection stalled.
    this._onRenegotiate = onRenegotiate;
  }

  get peerCount() { return Object.keys(this._peers).length; }

  /**
   * Called when a new guest sends an offer.
   * Creates a peer connection, sets remote desc, creates answer.
   */
  async handleGuestOffer(guestUid, offerSdp) {
    if (this._peers[guestUid]) return; // already connected
    if (this.peerCount >= MAX_GUESTS) {
      console.warn('[HostPeer] Room full, ignoring guest:', guestUid);
      return;
    }

    const pc = createPeerConnection(
      (stream) => this._onGuestStream(stream, guestUid),
      (cand)   => this._onIceForGuest(guestUid, cand),
      (state)  => {
        this._onStateChange(state, guestUid);
        // Only a real failure or explicit close tears the box down.
        // `disconnected` is transient and handled by ICE restart below —
        // tearing down on `disconnected` was what made boxes go black.
        if (state === 'failed' || state === 'closed') {
          this._cleanup(guestUid);
          this._onGuestLeave(guestUid);
        }
      },
      guestUid
    );

    // When ICE stalls, renegotiate with a fresh ICE-restart offer to this guest
    // instead of dropping them. Requires the caller to relay the offer via
    // onRenegotiate (falls back to a local restartIce() if not provided).
    pc._onIceRestartNeeded = async () => {
      try {
        if (!this._peers[guestUid]) return;
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        if (typeof this._onRenegotiate === 'function') {
          this._onRenegotiate(guestUid, offer.sdp);
        }
      } catch (e) {
        console.warn('[HostPeer] ICE restart failed:', e.message);
      }
    };

    this._peers[guestUid] = pc;

    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    return answer.sdp;
  }

  /** Apply a guest's answer to a host-initiated ICE-restart offer. */
  async applyGuestAnswer(guestUid, answerSdp) {
    const pc = this._peers[guestUid];
    if (pc && answerSdp) {
      try { await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp }); }
      catch (e) { console.warn('[HostPeer] applyGuestAnswer failed:', e.message); }
    }
  }

  /** Add ICE candidate sent by a specific guest. */
  async addGuestIce(guestUid, candidate) {
    const pc = this._peers[guestUid];
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch (e) { console.warn('[HostPeer] addIceCandidate failed:', e.message); }
    }
  }

  /** Forcibly close a guest's connection (kick). */
  kickGuest(guestUid) {
    this._cleanup(guestUid);
    this._onGuestLeave(guestUid);
  }

  /** Close all connections. */
  closeAll() {
    Object.keys(this._peers).forEach(uid => this._cleanup(uid));
  }

  _cleanup(guestUid) {
    const pc = this._peers[guestUid];
    if (pc) { try { pc.close(); } catch (_) {} }
    delete this._peers[guestUid];
  }
}

/* ═══════════════════════════════════════════════
   GUEST SIDE — single connection to host
════════════════════════════════════════════════ */

export class GuestPeerManager {
  constructor({ onHostStream, onIceForHost, onStateChange }) {
    this._pc             = null;
    this._onHostStream   = onHostStream;
    this._onIceForHost   = onIceForHost;
    this._onStateChange  = onStateChange;
  }

  /**
   * Guest creates an offer to send to the host.
   * Returns the offer SDP string.
   */
  async createOffer() {
    this._reconnecting = false;
    this._pc = createPeerConnection(
      (stream) => this._onHostStream(stream),
      (cand)   => this._onIceForHost(cand),
      (state)  => {
        this._onStateChange(state);
        // `failed` = hard failure → full reconnect. `disconnected` is handled
        // by the ICE-restart hook below (softer, keeps the box alive).
        if (state === 'failed') this._tryReconnect();
      },
      'host'
    );

    // When ICE stalls, first try a lightweight ICE restart (keeps the same
    // peer connection & video element — no black flash). Only fall back to a
    // full teardown+reconnect if the restart itself can't be created.
    this._pc._onIceRestartNeeded = async () => {
      try {
        if (!this._pc) return;
        const offer = await this._pc.createOffer({ iceRestart: true });
        await this._pc.setLocalDescription(offer);
        if (this._onReconnectOffer) this._onReconnectOffer(offer.sdp);
        console.warn('[GuestPeer] Sent ICE-restart offer');
      } catch (e) {
        console.warn('[GuestPeer] ICE restart failed, doing full reconnect:', e.message);
        this._tryReconnect();
      }
    };

    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);
    return offer.sdp;
  }

  /** Host sends back an answer — set it as remote description. */
  async handleHostAnswer(answerSdp) {
    if (!this._pc) return;
    await this._pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  /** Add ICE candidate received from host. */
  async addHostIce(candidate) {
    if (this._pc && candidate) {
      try { await this._pc.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch (e) { console.warn('[GuestPeer] addIceCandidate failed:', e.message); }
    }
  }

  close() {
    if (this._pc) { try { this._pc.close(); } catch (_) {} this._pc = null; }
  }

  _tryReconnect() {
    /* Full teardown + fresh offer with bounded exponential back-off.
       Guarded so overlapping state events don't spawn multiple reconnects. */
    if (this._reconnecting) return;
    this._reconnecting = true;
    this._retryCount = (this._retryCount || 0) + 1;
    if (this._retryCount > 6) {
      console.warn('[GuestPeer] Giving up after 6 reconnect attempts');
      this._reconnecting = false;
      return;
    }
    const delay = Math.min(1000 * Math.pow(1.6, this._retryCount - 1), 8000);
    console.warn(`[GuestPeer] Connection failed — retry #${this._retryCount} in ${Math.round(delay)}ms`);
    setTimeout(() => {
      this.close();
      this.createOffer().then(sdp => {
        this._reconnecting = false;
        if (this._onReconnectOffer) this._onReconnectOffer(sdp);
      }).catch(() => { this._reconnecting = false; });
    }, delay);
  }

  /** Optionally set a callback for reconnect offers. */
  onReconnectOffer(cb) { this._onReconnectOffer = cb; }
}

/* ═══════════════════════════════════════════════
   LAYOUT HELPER — 8-box grid
════════════════════════════════════════════════ */

/**
 * Return the CSS grid-template string for N visible boxes (1-8).
 * Chooses the most cinematic layout for each count.
 */
export function gridLayout(count) {
  switch (count) {
    case 1: return 'repeat(1,1fr) / repeat(1,1fr)';
    case 2: return 'repeat(1,1fr) / repeat(2,1fr)';
    case 3: return 'repeat(2,1fr) / repeat(2,1fr)'; // 2+1 with span
    case 4: return 'repeat(2,1fr) / repeat(2,1fr)';
    case 5: return 'repeat(2,1fr) / repeat(3,1fr)'; // 3+2
    case 6: return 'repeat(2,1fr) / repeat(3,1fr)';
    case 7: return 'repeat(3,1fr) / repeat(3,1fr)'; // 3+3+1
    case 8: return 'repeat(2,1fr) / repeat(4,1fr)';
    default: return 'repeat(2,1fr) / repeat(4,1fr)';
  }
}

/* ─── Network quality probe ─────────────────────────────────────────── */
export async function probeNetwork() {
  if (!navigator.connection) return 'unknown';
  const c = navigator.connection;
  const mb = c.downlink || 0;
  if (mb >= 5) return 'good';
  if (mb >= 1) return 'medium';
  return 'poor';
}
