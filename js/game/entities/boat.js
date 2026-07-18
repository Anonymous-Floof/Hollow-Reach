// Rideable boat entity — the first use of the entity system's `rideable` slot.
//  • Right-click to mount, Shift to dismount.
//  • Left-click an empty boat to break it back into a boat item.
//  • Floats on water (buoyancy springs it to the surface), trudges slowly on land.
//  • While ridden, it moves in the direction the player looks (W/S throttle,
//    A/D strafe) and carries the player in its seat.
//
// Vertical motion is handled here (def.gravity = 0) so the buoyancy spring and
// land-gravity don't fight the manager's base gravity. Horizontal motion is set
// here too and swept by the manager next tick.
//
// Multiplayer: guests ride GHOST boats with full client-side prediction —
// clientRideBoat() below runs the same control math against the ghost, the
// guest's pose stream carries the motion to the host, and the host pins the
// real boat under the rider (host.js). e.data.riderPid marks a remote rider on
// the host; e.data.ridden mirrors "someone is in this boat" to guests via the
// snapshot tuple so they don't try to mount an occupied one.

import { BLOCK } from "../../world/blocks.js";
import { sweepAxis } from "../physics.js";

const WATER_SPEED = 6;
const LAND_SPEED = 1.5;
export const SEAT_Y = 0.25;   // player feet offset above the boat origin

function dismount(e, ctx) {
  const p = ctx.player;
  p.mount = null;
  e.data.rider = false;
  // step off to the side the player is facing, lifted clear of the hull
  const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
  p.pos = [e.pos[0] - sin * 0.9, e.pos[1] + 0.6, e.pos[2] - cos * 0.9];
  p.vel = [0, 0, 0];
  if (ctx.notify) ctx.notify("Dismounted");
}

// Shared control math: read WASD relative to the rider's look and return the
// horizontal velocity plus whether the hull sits in water.
function steer(e, player, input, world) {
  const wx = Math.floor(e.pos[0]), wz = Math.floor(e.pos[2]);
  const by = Math.floor(e.pos[1] + 0.05);
  const inWater = world.getBlock(wx, by, wz) === BLOCK.water;
  const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
  let fx = 0, fz = 0;
  if (input.down("KeyW")) { fx -= sin; fz -= cos; }
  if (input.down("KeyS")) { fx += sin; fz += cos; }
  if (input.down("KeyA")) { fx -= cos; fz += sin; }
  if (input.down("KeyD")) { fx += cos; fz -= sin; }
  const len = Math.hypot(fx, fz);
  if (len > 0) { fx /= len; fz /= len; }
  const spd = inWater ? WATER_SPEED : LAND_SPEED;
  return { vx: fx * spd, vz: fz * spd, inWater };
}

// Vertical: buoyancy spring toward the water surface, else gravity.
function buoyancy(e, dt, world, inWater) {
  if (inWater) {
    const wx = Math.floor(e.pos[0]), wz = Math.floor(e.pos[2]);
    let sy = Math.floor(e.pos[1] + 0.05);
    while (world.getBlock(wx, sy + 1, wz) === BLOCK.water) sy++;
    const target = (sy + 0.85) - 0.18;       // hull rides just below the surface
    e.vel[1] = (target - e.pos[1]) * 8;
    if (e.vel[1] > 4) e.vel[1] = 4;
    else if (e.vel[1] < -4) e.vel[1] = -4;
  } else {
    e.vel[1] -= 24 * dt;
  }
}

// Guest-side driver for a ghost boat the local player is riding. The ghost is
// never simulated by the manager, so all integration happens here: steer,
// buoyancy, collision sweeps, then seat the player on top. e.localPin tells
// GhostWorld.tick to leave our simulated position alone (snapshots still track
// the boat for everyone ELSE — the host pins the real one under our pose).
export function clientRideBoat(e, dt, player, input, world, net, notifyFn) {
  if (e.dead) { player.mount = null; return; }
  if (input.pressed("ShiftLeft")) {
    player.mount = null;
    e.localPin = false;
    const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
    player.pos = [e.pos[0] - sin * 0.9, e.pos[1] + 0.6, e.pos[2] - cos * 0.9];
    player.vel = [0, 0, 0];
    if (net) net.sendBoatMount(e.netId, false);
    if (notifyFn) notifyFn("Dismounted");
    return;
  }
  const { vx, vz, inWater } = steer(e, player, input, world);
  e.vel[0] = vx; e.vel[2] = vz;
  buoyancy(e, dt, world, inWater);
  sweepAxis(world, e, 0, e.vel[0] * dt);
  sweepAxis(world, e, 2, e.vel[2] * dt);
  // zero the fall speed on ground contact (as the manager does for real
  // entities) — otherwise it accumulates while grounded and the boat plummets
  // the instant it slides off an edge
  if (sweepAxis(world, e, 1, e.vel[1] * dt)) e.vel[1] = 0;
  e.yaw = player.yaw;
  e.localPin = true;
  player.pos[0] = e.pos[0]; player.pos[1] = e.pos[1] + SEAT_Y; player.pos[2] = e.pos[2];
  player.vel[0] = player.vel[1] = player.vel[2] = 0;
}

export const boat = {
  size: { hw: 0.55, h: 0.42 },
  physics: true,
  gravity: 0,                 // we apply buoyancy / land-gravity ourselves
  flags: { rideable: true },

  spawn(e) {
    if (e.data.rider == null) e.data.rider = false;
  },

  hooks: {
    onInteract(e, ctx, button) {
      // occupied (local rider, remote rider on the host, or mirrored via the
      // snapshot's ridden flag on a ghost): leave it alone
      if (e.data.rider || e.data.riderPid || e.data.ridden) return;
      if (button === "right") {
        if (e.ghost) {
          // guest optimistic mount: ride locally at zero latency, tell the
          // host; a bdeny (someone beat us to it) dismounts us again
          if (!ctx.net || e.netId == null) return;
          e.data.ridden = true;
          ctx.player.mount = e;
          ctx.net.sendBoatMount(e.netId, true);
          if (ctx.notify) ctx.notify("Riding a boat — Shift to dismount");
          return;
        }
        e.data.rider = true;
        ctx.player.mount = e;
        if (ctx.notify) ctx.notify("Riding a boat — Shift to dismount");
      } else if (button === "left") {
        if (e.ghost) return;   // guest boat breaks route through the host (hit msg)
        ctx.world.spawnDrop(e.pos[0], e.pos[1] + 0.2, e.pos[2], "boat", 1);
        e.dead = true;
      }
    },

    update(e, dt, ctx) {
      // a remote guest is riding: host.js pins the boat under their pose each
      // frame — local physics/control would only fight it
      if (e.data.riderPid) return;
      const world = ctx.world;

      if (e.data.rider) {
        const p = ctx.player, input = ctx.input;
        if (input.pressed("ShiftLeft")) {
          dismount(e, ctx);
        } else {
          const { vx, vz } = steer(e, p, input, world);
          e.vel[0] = vx; e.vel[2] = vz;
          e.yaw = p.yaw;
          // carry the player in the seat
          p.pos[0] = e.pos[0]; p.pos[1] = e.pos[1] + SEAT_Y; p.pos[2] = e.pos[2];
          p.vel[0] = p.vel[1] = p.vel[2] = 0;
        }
      } else {
        e.vel[0] *= 0.92; e.vel[2] *= 0.92;     // unridden: coast to a stop
      }

      const wx = Math.floor(e.pos[0]), wz = Math.floor(e.pos[2]);
      const by = Math.floor(e.pos[1] + 0.05);
      buoyancy(e, dt, world, world.getBlock(wx, by, wz) === BLOCK.water);
    },
  },

  // The rider link lives on the live player, never the save: a reloaded boat is
  // always empty and ready to mount.
  serialize() { return {}; },
  deserialize() { return { rider: false }; },
};
