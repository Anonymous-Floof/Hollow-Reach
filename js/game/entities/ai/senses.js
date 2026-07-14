// Mob perception. (AI backend — built for future advanced mobs.)
//
// Three senses, each answering "what do I know about the world right now?":
//
//   • SIGHT   — range + field-of-view cone + true voxel line-of-sight, so mobs
//               can't see through hills, and sneaking up from behind works.
//   • HEARING — queries the world SoundBus (AIServices) for recent sound events
//               (footsteps, block breaks, combat...) within earshot.
//   • SMELL   — samples the ScentField trail the player leaves behind, so a
//               tracker can follow WHERE the player has been, not where they are.
//
// `Senses` bundles the three into one `perceive(e, ctx)` call that returns a
// percept object plus a short-term memory (last known player position), which is
// what state machines should branch on. Sight lines are the expensive part, so
// perceive() throttles itself (default 5 Hz, per-entity phase offset).

import { isSolid } from "../../../world/blocks.js";

// True when no solid block sits between a and b (both world-space [x,y,z]).
// Amanatides & Woo DDA, same walk as game/raycast.js but stops at solids only
// (liquids/glass-through-foliage stay visible) and just answers yes/no.
export function lineOfSight(world, a, b, maxDist = 64) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return true;
  if (dist > maxDist) return false;
  const d = [dx / dist, dy / dist, dz / dist];
  let x = Math.floor(a[0]), y = Math.floor(a[1]), z = Math.floor(a[2]);
  const ex = Math.floor(b[0]), ey = Math.floor(b[1]), ez = Math.floor(b[2]);
  const stepX = Math.sign(d[0]), stepY = Math.sign(d[1]), stepZ = Math.sign(d[2]);
  const tD = (i) => d[i] !== 0 ? Math.abs(1 / d[i]) : Infinity;
  const tDeltaX = tD(0), tDeltaY = tD(1), tDeltaZ = tD(2);
  const bound = (o, s) => s > 0 ? (Math.floor(o) + 1 - o) : (o - Math.floor(o));
  let tMaxX = stepX !== 0 ? bound(a[0], stepX) * tDeltaX : Infinity;
  let tMaxY = stepY !== 0 ? bound(a[1], stepY) * tDeltaY : Infinity;
  let tMaxZ = stepZ !== 0 ? bound(a[2], stepZ) * tDeltaZ : Infinity;
  let t = 0;
  while (t <= dist) {
    if (x === ex && y === ey && z === ez) return true;   // reached the target cell
    if ((x !== Math.floor(a[0]) || y !== Math.floor(a[1]) || z !== Math.floor(a[2]))
        && isSolid(world.getBlock(x, y, z))) return false;
    if (tMaxX < tMaxY && tMaxX < tMaxZ) { x += stepX; t = tMaxX; tMaxX += tDeltaX; }
    else if (tMaxY < tMaxZ) { y += stepY; t = tMaxY; tMaxY += tDeltaY; }
    else { z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; }
  }
  return true;
}

// ---- sound events (the "bus" lives in AIServices) ---------------------------

export class SoundBus {
  constructor() {
    this.events = [];    // { x,y,z, loudness (radius blocks), type, age }
  }

  // Anything can announce a sound: emit(pos, loudnessBlocks, "footstep"|"break"|...)
  emit(pos, loudness, type = "generic") {
    this.events.push({ x: pos[0], y: pos[1], z: pos[2], loudness, type, age: 0 });
    if (this.events.length > 256) this.events.shift();   // hard cap, oldest out
  }

  tick(dt) {
    for (const ev of this.events) ev.age += dt;
    // sounds are momentary but linger long enough for throttled AIs to notice
    this.events = this.events.filter((ev) => ev.age < 2.5);
  }

  // Loudest audible event at `pos` (hearMult scales the mob's ear sensitivity).
  // Returns { x,y,z, type, age, strength 0..1 } or null.
  loudestAt(pos, hearMult = 1) {
    let best = null, bestS = 0;
    for (const ev of this.events) {
      const d = Math.hypot(ev.x - pos[0], ev.y - pos[1], ev.z - pos[2]);
      const range = ev.loudness * hearMult;
      if (d >= range) continue;
      const s = (1 - d / range) * (1 - ev.age / 2.5);
      if (s > bestS) { bestS = s; best = ev; }
    }
    return best ? { x: best.x, y: best.y, z: best.z, type: best.type, age: best.age, strength: bestS } : null;
  }
}

// ---- scent trail -------------------------------------------------------------
//
// A sparse, decaying grid of "someone was here" markers. AIServices drops one at
// the player's feet a few times a second; each marker carries the time it was
// laid, so FRESHER = CLOSER TO THE PLAYER. A tracking mob standing on the trail
// follows the neighbouring cell with the freshest stamp and ends up walking the
// player's actual route (around lakes, up the real slope) with no pathfinding.

export class ScentField {
  constructor() {
    this.cells = new Map();   // "x,y,z" -> { t: timeLaid, e: emitter tag }
    this.now = 0;
    this.life = 45;           // seconds a scent cell lasts
  }

  key(x, y, z) { return x + "," + y + "," + z; }

  deposit(pos, emitter = "player") {
    const x = Math.floor(pos[0]), y = Math.floor(pos[1] + 0.01), z = Math.floor(pos[2]);
    this.cells.set(this.key(x, y, z), { t: this.now, e: emitter });
    if (this.cells.size > 4096) {           // bounded: drop the stalest half
      const cut = this.now - this.life * 0.5;
      for (const [k, c] of this.cells) if (c.t < cut) this.cells.delete(k);
    }
  }

  tick(dt) {
    this.now += dt;
    // amortized cleanup: full sweeps are cheap at this size, do one every ~4s
    if ((this._sweepT = (this._sweepT || 0) + dt) > 4) {
      this._sweepT = 0;
      const cut = this.now - this.life;
      for (const [k, c] of this.cells) if (c.t < cut) this.cells.delete(k);
    }
  }

  // Scent strength 0..1 at a cell (0 = none/expired).
  sample(x, y, z, emitter = null) {
    const c = this.cells.get(this.key(Math.floor(x), Math.floor(y), Math.floor(z)));
    if (!c || (emitter && c.e !== emitter)) return 0;
    return Math.max(0, 1 - (this.now - c.t) / this.life);
  }

  // Freshest scent cell within Chebyshev radius r of pos (small r — it's a scan).
  // Returns { x,y,z, strength } or null.
  freshestNear(pos, r = 2, emitter = null) {
    const cx = Math.floor(pos[0]), cy = Math.floor(pos[1] + 0.01), cz = Math.floor(pos[2]);
    let best = null, bestT = -Infinity;
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -1; dy <= 1; dy++) {
      const c = this.cells.get(this.key(cx + dx, cy + dy, cz + dz));
      if (!c || (emitter && c.e !== emitter)) continue;
      if (c.t > bestT) { bestT = c.t; best = { x: cx + dx, y: cy + dy, z: cz + dz }; }
    }
    if (!best) return null;
    return { ...best, strength: Math.max(0, 1 - (this.now - bestT) / this.life) };
  }

  // Trail following: from the mob's cell, the neighbouring cell whose scent is
  // FRESHER than where it stands (i.e. the direction the player walked). Returns
  // { x,y,z } to move toward, or null when the trail is cold / this is its end.
  nextTrailCell(pos, emitter = null) {
    const cx = Math.floor(pos[0]), cy = Math.floor(pos[1] + 0.01), cz = Math.floor(pos[2]);
    const hereC = this.cells.get(this.key(cx, cy, cz));
    let hereT = hereC && (!emitter || hereC.e === emitter) ? hereC.t : -Infinity;
    let best = null, bestT = hereT;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const c = this.cells.get(this.key(cx + dx, cy + dy, cz + dz));
        if (!c || (emitter && c.e !== emitter)) continue;
        if (c.t > bestT) { bestT = c.t; best = { x: cx + dx, y: cy + dy, z: cz + dz }; }
      }
    }
    return best;
  }
}

// ---- combined senses ---------------------------------------------------------

const SENSE_DEFAULTS = {
  viewRange: 20,      // blocks
  fovDeg: 140,        // vision cone (centred on facing); 360 = eyes everywhere
  eyeHeight: 1.6,     // where this mob's eyes sit above its feet
  hearMult: 1.0,      // ear sensitivity (scales each sound's loudness radius)
  smell: false,       // can this mob track scent trails?
  memorySec: 6,       // how long a lost target stays "last known"
  hz: 5,              // perceive() re-evaluates this many times per second
};

export class Senses {
  constructor(config = {}) {
    this.cfg = { ...SENSE_DEFAULTS, ...config };
  }

  // Evaluate all senses for entity `e`. Needs ctx.{world, player} and (for
  // hearing/smell) ctx.world.entities.ai. State is kept in e.data.percept so it
  // survives between the throttled evaluations; the same object is returned:
  //   { visible, dist, heard, scent, lastKnown: {x,y,z,age}|null }
  perceive(e, dt, ctx) {
    const P = e.data.percept || (e.data.percept = {
      visible: false, dist: Infinity, heard: null, scent: null,
      lastKnown: null, _t: Math.random() / this.cfg.hz,   // random phase: staggers mobs
    });
    if (P.lastKnown) {
      P.lastKnown.age += dt;
      if (P.lastKnown.age > this.cfg.memorySec) P.lastKnown = null;
    }
    P._t -= dt;
    if (P._t > 0) return P;
    P._t += 1 / this.cfg.hz;

    const world = ctx.world, player = ctx.player;
    const ai = world.entities && world.entities.ai;

    // ---- sight ----
    P.visible = false;
    if (player && player.health > 0) {
      const eye = [e.pos[0], e.pos[1] + this.cfg.eyeHeight, e.pos[2]];
      const tgt = [player.pos[0], player.pos[1] + 1.5, player.pos[2]];
      const dx = tgt[0] - eye[0], dy = tgt[1] - eye[1], dz = tgt[2] - eye[2];
      P.dist = Math.hypot(dx, dy, dz);
      if (P.dist < this.cfg.viewRange) {
        let inCone = true;
        if (this.cfg.fovDeg < 360) {
          // facing from the model convention: yaw = pi/2 - heading
          const h = Math.PI / 2 - e.yaw;
          const facing = [Math.cos(h), 0, Math.sin(h)];
          const flat = Math.hypot(dx, dz) || 1;
          const cos = (facing[0] * dx + facing[2] * dz) / flat;
          inCone = cos > Math.cos((this.cfg.fovDeg * Math.PI) / 360);
        }
        if (inCone && lineOfSight(world, eye, tgt, this.cfg.viewRange)) P.visible = true;
      }
      if (P.visible) P.lastKnown = { x: player.pos[0], y: player.pos[1], z: player.pos[2], age: 0 };
    }

    // ---- hearing ----
    P.heard = ai ? ai.sounds.loudestAt(e.pos, this.cfg.hearMult) : null;
    if (P.heard && !P.visible) {
      // a heard sound refreshes a vaguer memory (where the noise came from)
      if (!P.lastKnown || P.lastKnown.age > 1)
        P.lastKnown = { x: P.heard.x, y: P.heard.y, z: P.heard.z, age: 0.5 };
    }

    // ---- smell ----
    P.scent = (this.cfg.smell && ai) ? ai.scent.freshestNear(e.pos, 2) : null;

    return P;
  }
}
