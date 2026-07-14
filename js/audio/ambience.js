// Ambient soundscape: continuous beds (wind, cave drone) that crossfade with
// where you are and what time it is, plus scheduled one-shots (bird chirps by
// day, cricket chirps at night, echoing drips underground, fire crackle near
// torches and burning forges, bubbles underwater). All synthesised.
//
// Beds are persistent node chains whose gains ease toward per-frame targets;
// one-shots are fired off timers with randomised intervals so nothing loops
// audibly. The controller is driven from the game loop via update(dt, ctx).

import { engine } from "./engine.js";
import { sfx } from "./sfx.js";
import { BLOCK } from "../world/blocks.js";

const R = (a, b) => a + Math.random() * (b - a);

export class Ambience {
  constructor() {
    this.built = false;
    this._birdT = R(2, 6);
    this._dripT = R(3, 8);
    this._popT = 0.2;
    this._bubbleT = 1;
    this._scanT = 0;
    this._fires = [];          // nearby torch/forge positions, refreshed by the scan
    this._cricketT = R(1, 3);  // next cricket chirp
  }

  // Lazy-build the persistent beds once the context is unlocked.
  _build() {
    if (this.built || !engine.ready()) return;
    const c = engine.ctx, amb = engine.busAmb;

    // ---- wind: pink noise breathing through a slowly wandering bandpass ----
    const wsrc = c.createBufferSource();
    wsrc.buffer = engine.noise("pink");
    wsrc.loop = true;
    this.windFilter = c.createBiquadFilter();
    this.windFilter.type = "bandpass";
    this.windFilter.frequency.value = 400;
    this.windFilter.Q.value = 0.45;
    this.windGain = c.createGain();
    this.windGain.gain.value = 0;
    wsrc.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(amb);
    wsrc.start();
    this._gustT = 0;

    // Crickets are NOT a bed — a continuous gated carrier reads as a warbling
    // drone (v1 sounded like a dial-up modem). They're scheduled chirp
    // one-shots instead (see _cricketChirp), fired from update().

    // ---- cave: a deep detuned drone + murmur, swelling and fading slowly ----
    this.caveGain = c.createGain();
    this.caveGain.gain.value = 0;
    this.caveGain.connect(amb);
    for (const f of [51.5, 52.2, 103.7]) {
      const o = c.createOscillator();
      o.type = "triangle";
      o.frequency.value = f;
      const g = c.createGain(); g.gain.value = f > 100 ? 0.06 : 0.16;
      o.connect(g); g.connect(this.caveGain);
      o.start();
    }
    const csrc = c.createBufferSource();
    csrc.buffer = engine.noise("pink");
    csrc.loop = true; csrc.loopStart = 0.7;
    const clp = c.createBiquadFilter(); clp.type = "lowpass"; clp.frequency.value = 160; clp.Q.value = 0.6;
    const cg = c.createGain(); cg.gain.value = 0.4;
    csrc.connect(clp); clp.connect(cg); cg.connect(this.caveGain);
    csrc.start();
    this._caveSwellT = 0;

    this.built = true;
  }

  // ctx: { world, player, sky, underwater (0..1), active (playing, not paused) }
  update(dt, ctx) {
    if (!engine.ready()) return;
    this._build();
    if (!this.built) return;
    const { world, player, sky } = ctx;
    const t = engine.now();
    const head = player.eye();
    const exposure = world.getSky(Math.floor(head[0]), Math.floor(head[1]), Math.floor(head[2])) / 15;
    const day = sky.dayFactor();
    const uw = ctx.underwater || 0;
    const act = ctx.active ? 1 : 0.4;             // paused: beds fade low, not out
    const inCave = exposure < 0.2 && head[1] < 55;

    // ---- bed targets ----
    const windT = act * (1 - uw) * (inCave ? 0.02 : (0.05 + exposure * 0.10 + Math.max(0, Math.min(0.15, (head[1] - 66) / 90)))) * (0.7 + 0.3 * day);
    const caveT = act * (1 - uw) * (inCave ? 0.11 : 0);
    this.windGain.gain.setTargetAtTime(windT, t, 0.8);
    this.caveGain.gain.setTargetAtTime(caveT, t, 1.5);

    // wind gusts: every few seconds pick a new filter centre + a swell
    this._gustT -= dt;
    if (this._gustT <= 0) {
      this._gustT = R(2.5, 6);
      this.windFilter.frequency.setTargetAtTime(R(240, 720), t, 1.8);
      this.windGain.gain.setTargetAtTime(windT * R(0.7, 1.5), t, 1.2);
    }

    // cave drone swells
    this._caveSwellT -= dt;
    if (this._caveSwellT <= 0 && inCave) {
      this._caveSwellT = R(5, 12);
      this.caveGain.gain.setTargetAtTime(caveT * R(0.6, 1.6), t, 2.5);
    }

    if (!ctx.active) return;                      // no one-shots while paused

    // ---- birds (day, on the surface) ----
    this._birdT -= dt;
    if (this._birdT <= 0) {
      this._birdT = R(5, 16);
      if (day > 0.5 && exposure > 0.55 && uw < 0.5) this._birdChirp(player.pos);
    }

    // ---- crickets (night, on the surface): a sparse chirp chorus. Each fire
    // is one nearby cricket; the quick interval + random directions make it
    // read as many crickets around you, not one buzzing in your ear. ----
    this._cricketT -= dt;
    if (this._cricketT <= 0) {
      const night = !inCave && exposure > 0.4 && day < 0.2 && uw < 0.5;
      this._cricketT = night ? R(0.26, 0.85) : R(1.5, 3);
      if (night) this._cricketChirp(player.pos);
    }

    // ---- drips (underground) ----
    this._dripT -= dt;
    if (this._dripT <= 0) {
      this._dripT = R(3, 9);
      if (inCave) this._drip(player.pos);
    }

    // ---- fire crackle: scan for nearby torches + burning forges ----
    this._scanT -= dt;
    if (this._scanT <= 0) { this._scanT = 0.8; this._scanFires(world, player.pos); }
    this._popT -= dt;
    if (this._popT <= 0 && this._fires.length) {
      this._popT = R(0.1, 0.35) / Math.min(3, this._fires.length);
      this._pop(this._fires[(Math.random() * this._fires.length) | 0]);
    }

    // ---- bubbles while submerged ----
    this._bubbleT -= dt;
    if (this._bubbleT <= 0) {
      this._bubbleT = R(0.7, 1.8);
      if (uw > 0.5) sfx.bubbles();
    }
  }

  _scanFires(world, p) {
    const fires = [];
    const px = Math.floor(p[0]), py = Math.floor(p[1] + 1), pz = Math.floor(p[2]);
    const RAD = 7;
    for (let y = py - 4; y <= py + 4 && fires.length < 6; y++)
      for (let z = pz - RAD; z <= pz + RAD && fires.length < 6; z++)
        for (let x = px - RAD; x <= px + RAD && fires.length < 6; x++)
          if (world.getBlock(x, y, z) === BLOCK.emberlight) fires.push([x + 0.5, y + 0.5, z + 0.5, 0.6]);
    // burning forges crackle harder than torches
    for (const [key, be] of world.blockEntities) {
      if (be.kind !== "forge" || !(be.fuelLeft > 0)) continue;
      const [x, y, z] = key.split(",").map(Number);
      if (Math.abs(x - px) <= 10 && Math.abs(y - py) <= 5 && Math.abs(z - pz) <= 10) fires.push([x + 0.5, y + 0.5, z + 0.5, 1.4]);
    }
    this._fires = fires;
  }

  _pop([x, y, z, s]) {
    if (!engine.tryVoice(0.3)) return;
    const d = engine.out("amb", [x, y, z]);
    engine.burst(d, { dur: R(0.02, 0.06), gain: 0.5 * s, type: "crackle", filters: [{ type: "highpass", freq: R(900, 1600), Q: 0.7 }] });
    if (Math.random() < 0.25) engine.burst(d, { dur: R(0.15, 0.3), gain: 0.12 * s, attack: 0.05, curve: "lin", filters: [{ type: "bandpass", freq: R(160, 260), Q: 1 }] });
  }

  // One cricket's chirp: a short run of clean tonal pulses (~30/s pulse rate)
  // at this cricket's own pitch, then silence. A stridulation is a burst of
  // pulses, so a bandpassed sine blip per pulse — NOT a sustained tone.
  _cricketChirp(p) {
    if (!engine.tryVoice(0.6)) return;
    const ang = Math.random() * Math.PI * 2, dist = R(3, 14);
    const pos = [p[0] + Math.cos(ang) * dist, p[1] + R(-1.5, 2), p[2] + Math.sin(ang) * dist];
    const d = engine.out("amb", pos);
    const f = R(4200, 5000) * (Math.random() < 0.5 ? 1 : 0.985);   // this cricket's note
    const pulses = 2 + ((Math.random() * 4) | 0);                   // 2-5 pulses per chirp
    const gap = R(0.028, 0.04);                                     // ~25-36 Hz pulse rate
    const gain = R(0.05, 0.085);
    for (let i = 0; i < pulses; i++) {
      engine.tone(d, { delay: i * gap, freq: f, dur: 0.014, gain, attack: 0.002, filter: { type: "bandpass", freq: f, Q: 12 } });
    }
  }

  _birdChirp(p) {
    if (!engine.tryVoice(1.2)) return;
    const ang = Math.random() * Math.PI * 2, dist = R(9, 20);
    const d = engine.out("amb", [p[0] + Math.cos(ang) * dist, p[1] + R(4, 9), p[2] + Math.sin(ang) * dist]);
    const notes = 2 + ((Math.random() * 4) | 0);
    const base = R(2400, 4100);
    let at = 0;
    for (let i = 0; i < notes; i++) {
      const f = base * R(0.85, 1.2);
      const up = Math.random() < 0.6;
      engine.tone(d, { delay: at, freq: f, sweepTo: f * (up ? R(1.15, 1.5) : R(0.65, 0.85)), dur: R(0.05, 0.1), gain: R(0.1, 0.16), attack: 0.008 });
      if (Math.random() < 0.35) engine.tone(d, { delay: at + 0.02, freq: f * 1.01, sweepTo: f * 1.3, dur: 0.05, gain: 0.06 });
      at += R(0.07, 0.17);
    }
  }

  _drip(p) {
    if (!engine.tryVoice(1.5)) return;
    const ang = Math.random() * Math.PI * 2, dist = R(4, 12);
    const pos = [p[0] + Math.cos(ang) * dist, p[1] + R(1, 4), p[2] + Math.sin(ang) * dist];
    const d = engine.out("amb", pos);
    const f = R(900, 1400);
    // the drip, then two fading echoes off the cave walls
    for (let i = 0; i < 3; i++) {
      engine.tone(d, { delay: i * R(0.21, 0.26), freq: f, sweepTo: f * 0.5, dur: 0.06, gain: 0.16 / (i + 1), attack: 0.003 });
    }
    if (Math.random() < 0.4) engine.tone(d, { delay: 0.05, freq: f * 0.5, sweepTo: f * 0.9, dur: 0.1, gain: 0.05 });  // plop resonance
  }

  // Hard-stop the beds (used when quitting to the menu).
  quiet() {
    if (!this.built) return;
    const t = engine.now();
    this.windGain.gain.setTargetAtTime(0, t, 0.3);
    this.caveGain.gain.setTargetAtTime(0, t, 0.3);
    this._fires = [];
  }
}

export const ambience = new Ambience();
