/**
 * snx-audio-mixer.js
 *
 * Web Audio API mixer for Shadow Nexus Live.
 *
 * Mixes the creator's microphone audio with a music track and
 * outputs a single mixed MediaStream audio track that can be
 * injected into the WebRTC peer connections so viewers hear both.
 *
 * Usage:
 *   const mixer = new SNXAudioMixer();
 *   await mixer.init(micStream);           // pass the getUserMedia stream
 *   mixer.setMusicTrack(url, volume);      // start a music track
 *   mixer.setMusicVolume(0.8);             // 0.0 – 1.0
 *   mixer.setMicVolume(1.0);
 *   mixer.pause();
 *   mixer.resume();
 *   mixer.stop();                          // full teardown
 *
 *   mixer.mixedAudioTrack                  // MediaStreamTrack to inject into RTC
 *   mixer.on('ended', cb)                  // fires when music track ends naturally
 */

export class SNXAudioMixer {
  constructor() {
    this._ctx         = null;   // AudioContext
    this._dest        = null;   // MediaStreamAudioDestinationNode
    this._micSource   = null;   // MediaStreamAudioSourceNode (mic)
    this._micGain     = null;   // GainNode for mic level
    this._musicEl     = null;   // HTMLAudioElement for music
    this._musicSource = null;   // MediaElementAudioSourceNode
    this._musicGain   = null;   // GainNode for music level

    this.mixedAudioTrack = null; // the mixed MediaStreamTrack

    this._micVolume   = 1.0;
    this._musicVolume = 0.8;
    this._playing     = false;

    this._listeners   = {};     // event emitter
  }

  /* ── Initialise the AudioContext and wire the mic ── */
  async init(micStream) {
    if (this._ctx) return; // already initialised

    try {
      this._ctx  = new (window.AudioContext || window.webkitAudioContext)();
      this._dest = this._ctx.createMediaStreamDestination();

      // Mic → GainNode → Destination
      const micTracks = micStream ? micStream.getAudioTracks() : [];
      if (micTracks.length > 0) {
        this._micSource = this._ctx.createMediaStreamSource(micStream);
        this._micGain   = this._ctx.createGain();
        this._micGain.gain.value = this._micVolume;
        this._micSource.connect(this._micGain);
        this._micGain.connect(this._dest);
      }

      // Music gain node (no source yet — attached in setMusicTrack)
      this._musicGain = this._ctx.createGain();
      this._musicGain.gain.value = this._musicVolume;
      this._musicGain.connect(this._dest);

      // Expose the mixed audio track
      const destTracks = this._dest.stream.getAudioTracks();
      this.mixedAudioTrack = destTracks.length ? destTracks[0] : null;

    } catch (e) {
      console.error('[SNXAudioMixer] init failed:', e);
    }
  }

  /**
   * Replace the current music source with a new URL.
   * The previous Audio element is paused and detached cleanly.
   * @param {string} url       - CORS-enabled URL for the music file
   * @param {number} [volume]  - optional volume override (0.0–1.0)
   */
  async setMusicTrack(url, volume) {
    if (!this._ctx || !this._musicGain) return;

    // Tear down previous music source
    this._stopMusicEl();

    if (volume !== undefined) {
      this._musicVolume = Math.max(0, Math.min(1, volume));
      this._musicGain.gain.value = this._musicVolume;
    }

    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.src         = url;
    el.volume      = 1.0; // volume controlled by GainNode, not el.volume
    el.preload     = 'auto';

    this._musicEl = el;

    // Wire into the audio graph
    try {
      this._musicSource = this._ctx.createMediaElementSource(el);
      this._musicSource.connect(this._musicGain);
    } catch (e) {
      console.error('[SNXAudioMixer] setMusicTrack connect failed:', e);
      return;
    }

    // Resume AudioContext if it was suspended (autoplay policy)
    if (this._ctx.state === 'suspended') {
      await this._ctx.resume().catch(() => {});
    }

    el.onended = () => {
      this._playing = false;
      this._emit('ended');
    };

    el.onerror = () => {
      this._emit('error', el.error);
    };

    this._playing = true;
    el.play().catch(err => {
      this._playing = false;
      console.warn('[SNXAudioMixer] music play() rejected:', err.message);
    });
  }

  /** Pause music playback (mic still flows). */
  pause() {
    if (this._musicEl && !this._musicEl.paused) {
      this._musicEl.pause();
      this._playing = false;
    }
  }

  /** Resume music playback. */
  async resume() {
    if (!this._musicEl) return;
    if (this._ctx && this._ctx.state === 'suspended') {
      await this._ctx.resume().catch(() => {});
    }
    this._musicEl.play().then(() => { this._playing = true; }).catch(() => {});
  }

  /** Returns true if music is currently playing. */
  isPlaying() {
    return this._playing && this._musicEl && !this._musicEl.paused;
  }

  /** Current playback position in seconds. */
  currentTime() {
    return this._musicEl ? this._musicEl.currentTime : 0;
  }

  /** Duration in seconds, or 0 if not loaded. */
  duration() {
    return this._musicEl ? (this._musicEl.duration || 0) : 0;
  }

  /** Set music volume (0.0 – 1.0). */
  setMusicVolume(v) {
    this._musicVolume = Math.max(0, Math.min(1, v));
    if (this._musicGain) this._musicGain.gain.value = this._musicVolume;
  }

  /** Set microphone volume (0.0 – 1.0). */
  setMicVolume(v) {
    this._micVolume = Math.max(0, Math.min(1, v));
    if (this._micGain) this._micGain.gain.value = this._micVolume;
  }

  /** Mute / unmute music without changing the stored volume. */
  muteMusicToggle(muted) {
    if (!this._musicGain) return;
    this._musicGain.gain.value = muted ? 0 : this._musicVolume;
  }

  /** Mute / unmute microphone. */
  muteMicToggle(muted) {
    if (!this._micGain) return;
    this._micGain.gain.value = muted ? 0 : this._micVolume;
  }

  /**
   * Reconnect to a new mic stream (e.g. after camera flip replaces _localStream).
   * @param {MediaStream} newMicStream
   */
  reconnectMic(newMicStream) {
    if (!this._ctx) return;
    if (this._micSource) {
      try { this._micSource.disconnect(); } catch(_) {}
      this._micSource = null;
    }
    if (!this._micGain) {
      this._micGain = this._ctx.createGain();
      this._micGain.gain.value = this._micVolume;
      this._micGain.connect(this._dest);
    }
    const tracks = newMicStream ? newMicStream.getAudioTracks() : [];
    if (tracks.length > 0) {
      try {
        this._micSource = this._ctx.createMediaStreamSource(newMicStream);
        this._micSource.connect(this._micGain);
      } catch(e) {
        console.error('[SNXAudioMixer] reconnectMic failed:', e);
      }
    }
  }

  /** Full teardown — call on endLive(). */
  stop() {
    this._stopMusicEl();
    if (this._micSource)  { try { this._micSource.disconnect(); }  catch(_) {} this._micSource  = null; }
    if (this._micGain)    { try { this._micGain.disconnect(); }    catch(_) {} this._micGain    = null; }
    if (this._musicGain)  { try { this._musicGain.disconnect(); }  catch(_) {} this._musicGain  = null; }
    if (this._dest)       { try { this._dest.disconnect(); }       catch(_) {} this._dest       = null; }
    if (this._ctx)        { try { this._ctx.close(); }             catch(_) {} this._ctx        = null; }
    this.mixedAudioTrack = null;
    this._playing = false;
    this._listeners = {};
  }

  /* ── private helpers ── */

  _stopMusicEl() {
    if (this._musicSource) {
      try { this._musicSource.disconnect(); } catch(_) {}
      this._musicSource = null;
    }
    if (this._musicEl) {
      this._musicEl.onended = null;
      this._musicEl.onerror = null;
      this._musicEl.pause();
      this._musicEl.src = '';
      this._musicEl = null;
    }
    this._playing = false;
  }

  on(event, cb)  { this._listeners[event] = cb; }
  off(event)     { delete this._listeners[event]; }
  _emit(event, data) {
    const cb = this._listeners[event];
    if (cb) { try { cb(data); } catch(_) {} }
  }
}
