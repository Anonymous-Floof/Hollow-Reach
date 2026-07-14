// Day/night cycle. Drives sky gradient colours, a daylight factor (scales
// skylight in the terrain shader) and the fog colour (= horizon).

function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

const DAY_HORIZON = [0.62, 0.76, 0.95];
const DAY_ZENITH = [0.27, 0.52, 0.86];
const NIGHT_HORIZON = [0.06, 0.08, 0.14];
const NIGHT_ZENITH = [0.01, 0.02, 0.05];
const DUSK = [0.85, 0.45, 0.28];

export class Sky {
  constructor() {
    this.time = 0.32;       // 0..1, 0=midnight, 0.5=noon
    this.dayLength = 600;   // seconds for a full cycle
    this.paused = false;
    this.sleep = null;      // { remaining, rate } while fast-forwarding through sleep
    this.advanced = 0;      // in-game days the clock moved this frame (incl. sleep fast-forward)
  }

  update(dt) {
    this.advanced = 0;
    if (this.paused) return;
    // Sleeping fast-forwards game time toward morning. This is the hook for a
    // richer "fast forward" later (slow the rate for a realistic sweep, or tie
    // entity/AI ticks to a global time scale) — beds just call startSleep().
    if (this.sleep) {
      const step = Math.min(this.sleep.remaining, this.sleep.rate * dt);
      this.time = (this.time + step) % 1;
      this.advanced = step;
      this.sleep.remaining -= step;
      if (this.sleep.remaining <= 1e-4) this.sleep = null;
      return;
    }
    const step = dt / this.dayLength;
    this.time = (this.time + step) % 1;
    this.advanced = step;
  }

  isNight() { return this.dayFactor() < 0.25; }
  isSleeping() { return this.sleep !== null; }

  // Fast-forward time to `target` (default dawn ≈ 0.27) over `durationSec`
  // real seconds. The duration is the "delay" while sleeping.
  startSleep(target = 0.27, durationSec = 1.6) {
    let remaining = (target - this.time + 1) % 1;
    if (remaining < 1e-4) remaining = 1;   // already at dawn -> a full day
    this.sleep = { remaining, rate: remaining / durationSec };
  }

  // -1 at midnight, +1 at noon
  sunHeight() { return -Math.cos(this.time * Math.PI * 2); }

  // World-space unit direction to the sun: rises in the east (+x), arcs overhead
  // (with a slight southward tilt), sets in the west. The moon is the opposite.
  sunDir() {
    const a = this.time * Math.PI * 2;
    const x = Math.sin(a), y = -Math.cos(a), z = 0.18;
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  }

  // Extra fog in the early morning: a narrow bump peaking just after dawn (~0.26
  // of the cycle), zero the rest of the day. Drives denser fog in the renderer.
  morningFog() {
    let d = Math.abs(((this.time - 0.26 + 1.5) % 1) - 0.5);  // 0 exactly at dawn
    return clamp01(1 - d / 0.08);
  }

  // 0 (night) .. 1 (full day)
  dayFactor() { return clamp01((this.sunHeight() + 0.2) / 1.2); }

  // value the shader multiplies skylight by (kept above 0 so night isn't pitch black)
  daylight() { return 0.12 + 0.88 * this.dayFactor(); }

  // warm tint strength near sunrise/sunset
  duskFactor() {
    const h = this.sunHeight();
    return clamp01(1 - Math.abs(h) * 4) * clamp01(this.dayFactor() * 3);
  }

  // The primary directional light for deferred shading: the sun while it's up
  // (warm, oranger at dusk), the moon while it's down (cool + dim). dir points
  // toward the light, for N·L.
  celestial() {
    const day = this.dayFactor();
    if (this.sunHeight() > -0.05) {                 // sun up (plus a little twilight)
      const dusk = this.duskFactor();
      const color = lerp3([1.0, 0.97, 0.90], [1.0, 0.58, 0.32], clamp01(dusk * 0.85));
      return { dir: this.sunDir(), color, strength: 1.15 * day };
    }
    const s = this.sunDir();
    return { dir: [-s[0], -s[1], -s[2]], color: [0.52, 0.62, 0.85], strength: 0.16 };
  }

  // Soft hemispheric sky fill (multiplied by baked skylight in the shader). Kept
  // moderate so the directional sun still reads as contrast rather than washing
  // the whole scene out to a flat bright.
  ambientColor() {
    return lerp3([0.05, 0.06, 0.10], [0.40, 0.46, 0.56], this.dayFactor());
  }

  horizon() {
    let c = lerp3(NIGHT_HORIZON, DAY_HORIZON, this.dayFactor());
    return lerp3(c, DUSK, this.duskFactor() * 0.7);
  }
  zenith() { return lerp3(NIGHT_ZENITH, DAY_ZENITH, this.dayFactor()); }
  fogColor() { return this.horizon(); }

  clockString() {
    const mins = Math.floor(this.time * 24 * 60);
    const h = Math.floor(mins / 60), m = mins % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }
}
