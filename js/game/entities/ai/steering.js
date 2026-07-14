// Steering helpers for mob movement. (AI backend — built for future advanced
// mobs.) These compute HEADINGS and SPEEDS; the caller applies them to vel and
// yaw (or hands the result to applyMove below). They compose: pick a base
// heading (seek/flee/wander), then filter it (avoidHazards, separation).
//
// Convention matches the existing mobs: heading h is the travel angle where the
// move direction is (cos h, sin h) on xz, and the model yaw is pi/2 - h.

import { badGroundAhead } from "../ai.js";

// heading straight toward a world point
export function seek(e, target) {
  return Math.atan2(target[2] - e.pos[2], target[0] - e.pos[0]);
}

// heading straight away from a world point
export function flee(e, threat) {
  return Math.atan2(e.pos[2] - threat[2], e.pos[0] - threat[0]);
}

// Speed ramp-down near a target so a mob settles instead of orbiting it:
// full speed outside slowRadius, proportional inside, 0 within stopRadius.
export function arriveSpeed(e, target, speed, stopRadius = 1.2, slowRadius = 3) {
  const d = Math.hypot(target[0] - e.pos[0], target[2] - e.pos[2]);
  if (d <= stopRadius) return 0;
  if (d >= slowRadius) return speed;
  return speed * (d - stopRadius) / (slowRadius - stopRadius);
}

// Random-amble wander (the classic grazer motion, reusable): keeps its state in
// `bb` (any plain object — a blackboard or e.data). Returns { heading, speed }.
export function wander(bb, dt, opts = {}) {
  const walkSpeed = opts.walkSpeed ?? 1.2;
  const moveChance = opts.moveChance ?? 0.6;
  bb._wanderT = (bb._wanderT ?? 0) - dt;
  if (bb._wanderT <= 0) {
    bb._wanderT = (opts.minPause ?? 2) + Math.random() * (opts.varPause ?? 3);
    bb._wanderH = Math.random() * Math.PI * 2;
    bb._wanderMove = Math.random() < moveChance;
  }
  return { heading: bb._wanderH, speed: bb._wanderMove ? walkSpeed : 0 };
}

// Turn a desired heading away from shorelines/cliffs. Probes the desired
// direction first, then fans left/right in widening arcs and finally reverses,
// so a chasing mob skirts a hazard instead of stopping dead at it. Returns the
// adjusted heading, or null when every direction is bad (caller should idle).
export function avoidHazards(world, e, heading, maxProbes = 5) {
  const ok = (h) => !badGroundAhead(world, e, Math.cos(h), Math.sin(h));
  if (ok(heading)) return heading;
  for (let i = 1; i <= maxProbes; i++) {
    const off = (Math.PI / 5) * i;
    if (ok(heading + off)) return heading + off;
    if (ok(heading - off)) return heading - off;
  }
  const back = heading + Math.PI;
  return ok(back) ? back : null;
}

// Soft push apart so packs don't stack in one column: a small heading-space
// correction away from nearby same-type entities. Returns an [x,z] force.
export function separation(e, entities, radius = 1.2, strength = 2.5) {
  let fx = 0, fz = 0;
  for (const o of entities) {
    if (o === e || o.dead || o.type !== e.type) continue;
    const dx = e.pos[0] - o.pos[0], dz = e.pos[2] - o.pos[2];
    const d = Math.hypot(dx, dz);
    if (d > radius || d < 1e-4) continue;
    const w = (1 - d / radius) / d;
    fx += dx * w; fz += dz * w;
  }
  return [fx * strength, fz * strength];
}

// Apply a heading+speed to an entity the way existing mobs do (vel on ground or
// afloat, model yaw). Keeps that idiom in one place for FSM states to call.
export function applyMove(e, heading, speed, grounded = true) {
  if (speed > 0 && grounded) {
    e.vel[0] = Math.cos(heading) * speed;
    e.vel[2] = Math.sin(heading) * speed;
  }
  e.yaw = Math.PI / 2 - heading;
}
