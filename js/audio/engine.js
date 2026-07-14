// Web Audio engine. Everything the game plays is synthesised live through this
// graph — there are no audio files. The engine owns the AudioContext (created
// lazily, resumed on the first user gesture), a small bus mixer, the 3D
// listener, shared noise buffers, and a global voice cap so a burst of events
// can't stack into a wall of sound.
//
//   sfx bus  ─┐
//   amb bus  ─┼─► master gain ─► muffle (underwater lowpass) ─┐
//   ui  bus  ─┴──────────────────────────────────────────────┼─► compressor ─► out
//                    (ui joins after the muffle so menus stay crisp)
//
// One-shot voices are throwaway node chains: build, start, and let GC reap them
// when they end. Positional sounds go through a per-voice equal-power panner.

const MAX_VOICES = 32;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.unlocked = false;
    this._voices = 0;
    this._noise = {};        // cached noise buffers by kind
    this._volumes = { master: 0.8, sfx: 0.8, ambient: 0.6, ui: 0.5 };
    this._duck = 1;          // pause-menu duck multiplier
    this._underwater = 0;
  }

  ready() { return this.unlocked && this.ctx && this.ctx.state === "running"; }
  now() { return this.ctx ? this.ctx.currentTime : 0; }

  // Create the context + graph. Safe to call repeatedly.
  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = this.ctx = new AC();

    this.master = c.createGain();
    this.muffle = c.createBiquadFilter();
    this.muffle.type = "lowpass";
    this.muffle.frequency.value = 19000;
    this.muffle.Q.value = 0.5;
    this.comp = c.createDynamicsCompressor();      // gentle safety limiter
    this.comp.threshold.value = -14;
    this.comp.knee.value = 18;
    this.comp.ratio.value = 5;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.18;

    this.busSfx = c.createGain();
    this.busAmb = c.createGain();
    this.busUi = c.createGain();
    this.busSfx.connect(this.master);
    this.busAmb.connect(this.master);
    this.master.connect(this.muffle);
    this.muffle.connect(this.comp);
    this.busUi.connect(this.comp);                 // UI skips the underwater muffle
    this.comp.connect(c.destination);
    this.applyVolumes();

    // A hidden tab stops the rAF loop but audio would keep running — freeze the
    // whole context so ambient loops don't play over other tabs.
    document.addEventListener("visibilitychange", () => {
      if (!this.ctx || !this.unlocked) return;
      if (document.hidden) this.ctx.suspend();
      else this.ctx.resume();
    });
  }

  // Called from a user-gesture handler; browsers refuse to start audio otherwise.
  unlock() {
    this.ensure();
    if (!this.ctx) return;
    if (this.ctx.state === "suspended") this.ctx.resume();
    this.unlocked = true;
  }

  setVolumes(v) { Object.assign(this._volumes, v); this.applyVolumes(); }
  applyVolumes() {
    if (!this.ctx) return;
    const vv = this._volumes;
    const g = (x) => x * x;                        // sliders feel linear-ish in loudness
    this.master.gain.value = g(vv.master) * this._duck;
    this.busSfx.gain.value = g(vv.sfx);
    this.busAmb.gain.value = g(vv.ambient);
    this.busUi.gain.value = g(vv.ui) * g(vv.master);
  }

  // Duck the world mix while paused (menus overlay a frozen world).
  setDucked(on) {
    this._duck = on ? 0.35 : 1;
    if (this.master) this.master.gain.setTargetAtTime(
      this._volumes.master * this._volumes.master * this._duck, this.now(), 0.15);
  }

  // 0 = air, 1 = fully submerged. Sweeps the master lowpass for the classic
  // underwater muffle; the ramp keeps surface-bobbing from clicking.
  setUnderwater(t) {
    if (!this.ctx || Math.abs(t - this._underwater) < 0.01) return;
    this._underwater = t;
    const f = 19000 * Math.pow(750 / 19000, t);    // exp sweep 19k → 750 Hz
    this.muffle.frequency.setTargetAtTime(f, this.now(), 0.12);
  }

  // Keep the 3D listener glued to the camera each frame.
  updateListener(pos, yaw) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    if (l.positionX) {
      const t = this.now();
      l.positionX.setTargetAtTime(pos[0], t, 0.03);
      l.positionY.setTargetAtTime(pos[1], t, 0.03);
      l.positionZ.setTargetAtTime(pos[2], t, 0.03);
      l.forwardX.setTargetAtTime(fx, t, 0.03);
      l.forwardY.setTargetAtTime(0, t, 0.03);
      l.forwardZ.setTargetAtTime(fz, t, 0.03);
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else {
      l.setPosition(pos[0], pos[1], pos[2]);
      l.setOrientation(fx, 0, fz, 0, 1, 0);
    }
  }

  // Voice accounting: returns false when the mixer is saturated so callers can
  // simply skip the sound. `dur` is the expected life of the voice in seconds.
  tryVoice(dur) {
    if (this._voices >= MAX_VOICES) return false;
    this._voices++;
    setTimeout(() => { this._voices = Math.max(0, this._voices - 1); }, dur * 1000 + 120);
    return true;
  }

  // Destination for a one-shot. With a position we route through an equal-power
  // panner (inverse falloff, inaudible past ~26 blocks); without, straight to
  // the bus. Returns the node the sound chain should connect to.
  out(bus, pos) {
    const b = bus === "amb" ? this.busAmb : bus === "ui" ? this.busUi : this.busSfx;
    if (!pos) return b;
    const p = this.ctx.createPanner();
    p.panningModel = "equalpower";
    p.distanceModel = "inverse";
    p.refDistance = 3;
    p.maxDistance = 60;
    p.rolloffFactor = 1.6;
    if (p.positionX) { p.positionX.value = pos[0]; p.positionY.value = pos[1]; p.positionZ.value = pos[2]; }
    else p.setPosition(pos[0], pos[1], pos[2]);
    p.connect(b);
    return p;
  }

  // ---- shared sources ----

  // Cached looping-friendly noise buffers. "white" is flat; "pink" is softened
  // (running-average filtered) for wind beds; "crackle" is sparse impulses for
  // fire. 2 s is plenty for loops and one-shots alike.
  noise(kind = "white") {
    let buf = this._noise[kind];
    if (buf) return buf;
    const c = this.ctx, len = c.sampleRate * 2;
    buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    if (kind === "pink") {
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.997 * b0 + 0.029 * w;
        b1 = 0.985 * b1 + 0.032 * w;
        b2 = 0.950 * b2 + 0.048 * w;
        d[i] = (b0 + b1 + b2 + w * 0.05) * 2.1;
      }
    } else if (kind === "crackle") {
      for (let i = 0; i < len; i++) {
        d[i] = Math.random() < 0.0018 ? (Math.random() * 2 - 1) : d[i - 1] * 0.62 || 0;
      }
    } else {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    this._noise[kind] = buf;
    return buf;
  }

  // A noise burst: buffer source → optional biquad(s) → gain envelope → dest.
  // opts: { dur, delay, gain, attack, curve ("exp"|"lin"), type, rate,
  //         filters: [{type, freq, Q, sweepTo, sweepT}] }
  burst(dest, o = {}) {
    const c = this.ctx;
    const t0 = this.now() + (o.delay || 0);
    const dur = o.dur || 0.1;
    const src = c.createBufferSource();
    src.buffer = this.noise(o.type || "white");
    src.loop = true;
    src.loopStart = Math.random() * 1.2;           // decorrelate repeats
    if (o.rate) src.playbackRate.value = o.rate;
    let head = src;
    for (const f of o.filters || []) {
      const bq = c.createBiquadFilter();
      bq.type = f.type || "bandpass";
      bq.frequency.value = f.freq;
      bq.Q.value = f.Q != null ? f.Q : 1;
      if (f.sweepTo) bq.frequency.exponentialRampToValueAtTime(Math.max(20, f.sweepTo), t0 + (f.sweepT || dur));
      head.connect(bq);
      head = bq;
    }
    const g = c.createGain();
    const peak = o.gain != null ? o.gain : 0.5;
    const atk = o.attack || 0.003;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + atk);
    if (o.curve === "lin") g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    else g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    head.connect(g);
    g.connect(dest);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
    return g;
  }

  // A tonal partial: oscillator → optional filter → gain envelope → dest.
  // opts: { freq, sweepTo, sweepT, wave, dur, delay, gain, attack,
  //         vibRate, vibDepth, tremRate, tremDepth, filter:{...} }
  tone(dest, o = {}) {
    const c = this.ctx;
    const t0 = this.now() + (o.delay || 0);
    const dur = o.dur || 0.15;
    const osc = c.createOscillator();
    osc.type = o.wave || "sine";
    osc.frequency.setValueAtTime(o.freq || 440, t0);
    if (o.sweepTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.sweepTo), t0 + (o.sweepT || dur));
    if (o.vibRate) {
      const lfo = c.createOscillator(), lg = c.createGain();
      lfo.frequency.value = o.vibRate;
      lg.gain.value = o.vibDepth || 10;
      lfo.connect(lg); lg.connect(osc.frequency);
      lfo.start(t0); lfo.stop(t0 + dur + 0.05);
    }
    let head = osc;
    if (o.filter) {
      const bq = c.createBiquadFilter();
      bq.type = o.filter.type || "bandpass";
      bq.frequency.setValueAtTime(o.filter.freq, t0);
      bq.Q.value = o.filter.Q != null ? o.filter.Q : 1;
      if (o.filter.sweepTo) bq.frequency.exponentialRampToValueAtTime(Math.max(20, o.filter.sweepTo), t0 + (o.filter.sweepT || dur));
      head.connect(bq);
      head = bq;
    }
    const g = c.createGain();
    const peak = o.gain != null ? o.gain : 0.3;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    if (o.tremRate) {
      const lfo = c.createOscillator(), lg = c.createGain();
      lfo.frequency.value = o.tremRate;
      lg.gain.value = peak * (o.tremDepth || 0.5);
      lfo.connect(lg); lg.connect(g.gain);
      lfo.start(t0); lfo.stop(t0 + dur + 0.05);
    }
    head.connect(g);
    g.connect(dest);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    return g;
  }
}

export const engine = new AudioEngine();
