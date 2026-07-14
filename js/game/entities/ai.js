// Shared movement helpers for walking mobs (sheep, pig, zombie). Kept here so
// every land animal climbs hills the same way and none of them stroll into the
// ocean, and so passive grazers share one wander/flee brain.
//
// Wandering now leans on the AI backend in ./ai/: mobs path (A*, budgeted via
// world.entities.ai) to a reachable spot instead of blindly walking a heading,
// and a stuck watchdog turns them away from walls the old amble ground against.
// The heavier systems there (state machines, hearing, scent) stay dormant.

import { isSolid, BLOCK } from "../../world/blocks.js";
import { getItem } from "../items.js";
import { sfx } from "../../audio/sfx.js";
import { PathFollower } from "./ai/path.js";

// Would stepping along heading (c,s) put the mob into water or over a steep drop?
// Land mobs call this each tick and turn away instead of drowning / falling in.
// (c,s) = (cos heading, sin heading).
export function badGroundAhead(world, e, c, s) {
  const ax = Math.floor(e.pos[0] + c * 0.7);
  const az = Math.floor(e.pos[2] + s * 0.7);
  const fy = Math.floor(e.pos[1] + 0.1);
  // water at foot level or just under the lip -> shoreline, steer away
  if (world.getBlock(ax, fy, az) === BLOCK.water) return true;
  if (world.getBlock(ax, fy - 1, az) === BLOCK.water) return true;
  // scan down for a cliff: a drop of 3+ air blocks (or water below) is a no-go
  let drop = 0;
  for (let y = fy - 1; y >= fy - 4; y--) {
    if (world.getBlock(ax, y, az) === BLOCK.water) return true;
    if (isSolid(world.getBlock(ax, y, az))) break;
    drop++;
  }
  return drop >= 3;
}

// Climbing 1-block hills/ledges is handled centrally by the entity manager's
// auto-step (physics.stepSweep), so AI code only needs to choose a heading.

// Gentle buoyancy: if a mob ends up in water (knockback, bad luck) it bobs up and
// can paddle to shore instead of sinking to the bottom. Returns true if in water.
export function floatInWater(world, e) {
  const fy = Math.floor(e.pos[1] + 0.1);
  if (world.getBlock(Math.floor(e.pos[0]), fy, Math.floor(e.pos[2])) !== BLOCK.water) return false;
  if (e.vel[1] < 2.2) e.vel[1] = 2.2;   // rise toward the surface
  return true;
}

// Damage a player's left-click deals to a mob: swords hit hardest, other tools a
// bit, fists least. Shared by every attackable mob.
export function attackDamage(inventory) {
  const slot = inventory && inventory.selectedSlot ? inventory.selectedSlot() : null;
  const it = slot ? getItem(slot.key) : null;
  if (it && it.type === "tool" && it.toolType === "sword") return 3 + it.tier;
  if (it && it.type === "tool") return 2;
  return 1.5;
}

// Stuck watchdog: `true` when the mob wanted to move but its feet barely did for
// a while — time to pick a new direction instead of grinding against whatever is
// in the way (2-block walls, tree trunks, fences the auto-step can't climb).
// Call exactly once per tick — it records the position sample it compares against.
export function stuck(e, dt, wantSpeed, limit = 0.55) {
  const d = e.data;
  const mx = d._sx != null ? e.pos[0] - d._sx : 0;
  const mz = d._sz != null ? e.pos[2] - d._sz : 0;
  d._sx = e.pos[0]; d._sz = e.pos[2];
  if (wantSpeed > 0 && e.onGround && Math.hypot(mx, mz) < wantSpeed * dt * 0.25) {
    d._stuckT = (d._stuckT || 0) + dt;
    if (d._stuckT > limit) { d._stuckT = 0; return true; }
  } else d._stuckT = 0;
  return false;
}

// Walk along e.data.heading at `speed`, turning away from shorelines/cliffs and
// (via the watchdog) walls. Sets vel + yaw. The mob's changeT is pulled in when
// forced to turn so a fresh plan comes soon.
export function steerHeading(e, dt, ctx, speed, inWater) {
  const d = e.data;
  const jammed = stuck(e, dt, (e.onGround || inWater) ? speed : 0);
  if (speed > 0 && (e.onGround || inWater)) {
    const c = Math.cos(d.heading), s = Math.sin(d.heading);
    if (!inWater && badGroundAhead(ctx.world, e, c, s)) {
      d.heading += Math.PI * (0.5 + Math.random() * 0.5);   // steer off the shoreline / cliff
      if (d.changeT != null) d.changeT = Math.min(d.changeT, 1 + Math.random());
    } else if (jammed) {
      d.heading += Math.PI * (0.35 + Math.random() * 0.8);  // wall — turn away
      if (d.changeT != null) d.changeT = Math.min(d.changeT, 1 + Math.random());
    } else {
      e.vel[0] = c * speed; e.vel[2] = s * speed;           // hills climbed by the manager auto-step
    }
  }
  // model's head points local +z (modelMatrix maps it to world (sin yaw,cos yaw));
  // travel dir is (cos h,sin h), so yaw = pi/2 - heading.
  e.yaw = Math.PI / 2 - d.heading;
}

// One tick of idle wandering, shared by grazers and the off-duty zombie. Prefers
// a short A* path (budgeted through world.entities.ai) to a real, reachable spot
// — so ambling mobs walk routes that exist instead of marching into walls — and
// falls back to the old heading amble when the path cooldown/budget says no.
// The follower lives in e.data but is never serialized (mob serializers whitelist
// their fields), so it simply rebuilds after a save/load.
export function wanderStep(e, dt, ctx, speed, inWater) {
  const d = e.data;
  if (d.follower && !inWater) {
    stuck(e, dt, 0);                       // keep the watchdog's samples fresh
    const st = d.follower.step(e, dt, speed);
    if (st === "moving") return;
    d.follower = null;                     // arrived, or the follower gave up
    d.moving = false;
    d.changeT = st === "stuck" ? 0.2 + Math.random() * 0.4 : 1 + Math.random() * 2.5;
    return;
  }
  if (inWater) d.follower = null;          // paths don't survive a dunking
  d.changeT -= dt;
  if (d.changeT <= 0) {
    d.changeT = 2 + Math.random() * 3;
    d.heading = Math.random() * Math.PI * 2;
    d.moving = Math.random() < 0.6;
    if (d.moving && !inWater) {
      const ai = ctx.world.entities && ctx.world.entities.ai;
      const r = 3 + Math.random() * 6;
      const goal = [e.pos[0] + Math.cos(d.heading) * r, e.pos[1], e.pos[2] + Math.sin(d.heading) * r];
      const path = ai ? ai.requestPath(e, goal, { maxFall: 2, maxDist: 14, maxExpand: 96 }, 0.8) : null;
      if (path && path.points.length > 1) { d.follower = new PathFollower(path); return; }
    }
  }
  steerHeading(e, dt, ctx, d.moving ? speed : 0, inWater);
}

// Shared brain for passive grazers (sheep, pig): path-assisted wandering, flee
// away from the player when spooked (veering around obstacles instead of pinning
// against them), climb hills (manager auto-step) and refuse to wade into water
// or off cliffs. opts = { walkSpeed, fleeSpeed }.
export function grazeUpdate(e, dt, ctx, opts) {
  const d = e.data;
  d.hurtFlash = Math.max(0, (d.hurtFlash || 0) - dt);
  d.flee = Math.max(0, (d.flee || 0) - dt);
  const inWater = floatInWater(ctx.world, e);

  if (d.flee > 0) {                        // panic: run away, no route planning
    d.follower = null;
    const p = ctx.player.pos;
    d._devT = Math.max(0, (d._devT || 0) - dt);
    d.heading = Math.atan2(e.pos[2] - p[2], e.pos[0] - p[0]) + (d._devT > 0 ? d._dev : 0);
    const jammed = stuck(e, dt, (e.onGround || inWater) ? opts.fleeSpeed : 0);
    if (e.onGround || inWater) {
      const c = Math.cos(d.heading), s = Math.sin(d.heading);
      if (jammed || (!inWater && badGroundAhead(ctx.world, e, c, s))) {
        // veer to one side and keep running instead of stalling on the obstacle
        d._dev = (Math.random() < 0.5 ? 1 : -1) * (Math.PI * 0.5 + Math.random() * 0.5);
        d._devT = 0.7;
      } else {
        e.vel[0] = c * opts.fleeSpeed; e.vel[2] = s * opts.fleeSpeed;
      }
    }
    e.yaw = Math.PI / 2 - d.heading;
    return;
  }
  wanderStep(e, dt, ctx, opts.walkSpeed, inWater);
}

// Shared "got hit by the player" reaction for a grazer: damage, hurt flash, flee,
// knockback, tool wear. Returns true if the hit was fatal.
export function grazeHurt(e, ctx) {
  e.data.health -= attackDamage(ctx.inventory);
  e.data.hurtFlash = 0.35;
  e.data.flee = 4;
  const vpos = [e.pos[0], e.pos[1] + e.h * 0.7, e.pos[2]];
  sfx.thwack(vpos);
  const fatal = e.data.health <= 0;
  if (sfx[e.type]) sfx[e.type](fatal ? "death" : "hurt", vpos, e.id);
  const p = ctx.player.pos;
  const dx = e.pos[0] - p[0], dz = e.pos[2] - p[2], l = Math.hypot(dx, dz) || 1;
  e.vel[0] += (dx / l) * 5; e.vel[2] += (dz / l) * 5; e.vel[1] = 4.5;
  const slot = ctx.inventory.selectedSlot && ctx.inventory.selectedSlot();
  const held = slot ? getItem(slot.key) : null;
  if (held && held.type === "tool") ctx.inventory.damageSelectedTool(1);
  return e.data.health <= 0;
}
