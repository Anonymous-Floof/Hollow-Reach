// Owns all live entities for a world: spawn/remove, per-frame tick (base physics
// + the type's update hook), ray picking, and save/load. Lives at world.entities.

import { defOf } from "./registry.js";
import { sweepAxis, stepSweep } from "../physics.js";
import { BLOCK } from "../../world/blocks.js";
import { AIServices } from "./ai/services.js";

const MOB_STEP = 1.0;   // walking mobs auto-climb a full 1-block hill/ledge
const ENT_FLOW = 26;    // how hard a current drags a floating entity downstream

let _nextId = 1;

export class EntityManager {
  constructor(world) {
    this.world = world;
    this.entities = [];
    // shared AI world-services (sound events, scent trail, path budget) — see
    // ai/services.js; mob brains reach them via ctx.world.entities.ai
    this.ai = new AIServices(world);
  }

  spawn(type, pos, data = {}) {
    const def = defOf(type);
    if (!def) return null;
    const e = {
      id: _nextId++,
      type,
      pos: [pos[0], pos[1], pos[2]],
      vel: [0, 0, 0],
      yaw: 0, pitch: 0,
      hw: def.size.hw, h: def.size.h,
      onGround: false,
      age: 0,
      dead: false,
      data: { ...data },
    };
    if (def.spawn) def.spawn(e);
    this.entities.push(e);
    return e;
  }

  remove(e) { e.dead = true; }
  clear() { this.entities = []; }

  // A ghost is a network-mirrored entity: rendered and raycastable, but never
  // ticked here — the net layer drives its position by interpolating remote
  // snapshots. Ghost ids are negative so they can never collide with local ids.
  spawnGhost(netId, type, pos) {
    const def = defOf(type);
    const size = def ? def.size : { hw: 0.3, h: 1.8 };
    const e = {
      id: -netId - 1,
      netId,
      type,
      ghost: true,
      pos: [pos[0], pos[1], pos[2]],
      vel: [0, 0, 0],
      yaw: 0, pitch: 0,
      hw: size.hw, h: size.h,
      onGround: false,
      age: 0,
      dead: false,
      data: {},
    };
    this.entities.push(e);
    return e;
  }

  tick(dt, ctx) {
    const world = this.world;
    this.ai.tick(dt, ctx);   // refresh path budget, decay sounds, lay player scent
    let anyDead = false;
    for (const e of this.entities) {
      if (e.dead) { anyDead = true; continue; }
      // Ghosts are driven by remote snapshots (net layer), never simulated here.
      if (e.ghost) continue;
      // Freeze entities whose chunk isn't loaded (e.g. death drops you've walked
      // away from): no physics/age, so they stay put until you return.
      if (!world.chunkAt(e.pos[0], e.pos[2])) continue;
      e.age += dt;
      const def = defOf(e.type);
      if (def.physics) {
        if (def.gravity !== 0) e.vel[1] -= (def.gravity || 24) * dt;
        // a water current carries floating/submerged entities downstream; gravity-
        // bound entities also get partial buoyancy so they bob rather than sink.
        const bx = Math.floor(e.pos[0]), bz = Math.floor(e.pos[2]), by = Math.floor(e.pos[1] + e.h * 0.5);
        if (world.getBlock(bx, by, bz) === BLOCK.water) {
          if (def.gravity !== 0) { e.vel[1] += (def.gravity || 24) * dt * 0.65; if (e.vel[1] < -1.4) e.vel[1] = -1.4; }
          const [fx, fz] = world.waterFlow(bx, by, bz);
          e.vel[0] += fx * ENT_FLOW * dt; e.vel[2] += fz * ENT_FLOW * dt;
          e.vel[0] *= 0.92; e.vel[2] *= 0.92;   // water drag keeps the drift bounded
        }
        const grounded = e.onGround;        // last frame's footing — gates the auto-step
        e.onGround = false;
        // grounded walkers auto-step a ledge/hill; airborne ones just sweep
        if (grounded && def.flags && def.flags.ai) {
          stepSweep(world, e, 0, e.vel[0] * dt, MOB_STEP);
          stepSweep(world, e, 2, e.vel[2] * dt, MOB_STEP);
        } else {
          sweepAxis(world, e, 0, e.vel[0] * dt);
          sweepAxis(world, e, 2, e.vel[2] * dt);
        }
        const hitY = sweepAxis(world, e, 1, e.vel[1] * dt);
        if (hitY) {
          if (e.vel[1] < 0) e.onGround = true;
          e.vel[1] = 0;
        }
        if (e.onGround) { e.vel[0] *= 0.5; e.vel[2] *= 0.5; }   // ground friction
      }
      if (def.hooks && def.hooks.update) def.hooks.update(e, dt, ctx);
      if (e.dead) anyDead = true;
    }
    if (anyDead) this.entities = this.entities.filter((e) => !e.dead);
  }

  // Nearest entity whose AABB the ray hits within maxDist. Returns {entity,dist}.
  raycast(origin, dir, maxDist) {
    let best = null, bestT = maxDist;
    for (const e of this.entities) {
      if (e.dead) continue;
      const t = rayAABB(origin, dir,
        e.pos[0] - e.hw, e.pos[1], e.pos[2] - e.hw,
        e.pos[0] + e.hw, e.pos[1] + e.h, e.pos[2] + e.hw);
      if (t !== null && t < bestT) { bestT = t; best = e; }
    }
    return best ? { entity: best, dist: bestT } : null;
  }

  forEach(fn) { for (const e of this.entities) if (!e.dead) fn(e); }

  // ---- save / load ----
  serialize() {
    const out = [];
    for (const e of this.entities) {
      if (e.dead || e.ghost) continue;   // ghosts belong to the network, not the save
      const def = defOf(e.type);
      out.push({
        type: e.type,
        pos: e.pos.slice(),
        vel: e.vel.slice(),
        yaw: e.yaw,
        data: def.serialize ? def.serialize(e) : { ...e.data },
      });
    }
    return out;
  }

  load(arr) {
    this.entities = [];
    if (!arr) return;
    for (const s of arr) {
      const def = defOf(s.type);
      if (!def) continue;
      const data = def.deserialize ? def.deserialize(s.data || {}) : (s.data || {});
      const e = this.spawn(s.type, s.pos, data);
      if (e) {
        if (s.vel) e.vel = s.vel.slice();
        if (s.yaw != null) e.yaw = s.yaw;
      }
    }
  }
}

// Slab-method ray vs AABB. Returns entry distance t >= 0, or null if no hit.
function rayAABB(o, d, x0, y0, z0, x1, y1, z1) {
  const lo = [x0, y0, z0], hi = [x1, y1, z1];
  let tmin = 0, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
    } else {
      let t1 = (lo[i] - o[i]) / d[i], t2 = (hi[i] - o[i]) / d[i];
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}
