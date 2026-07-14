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

import { BLOCK } from "../../world/blocks.js";

const WATER_SPEED = 6;
const LAND_SPEED = 1.5;
const SEAT_Y = 0.25;        // player feet offset above the boat origin

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
      if (e.data.rider) return;                 // dismount (Shift) before re-using
      if (button === "right") {
        e.data.rider = true;
        ctx.player.mount = e;
        if (ctx.notify) ctx.notify("Riding a boat — Shift to dismount");
      } else if (button === "left") {
        ctx.world.spawnDrop(e.pos[0], e.pos[1] + 0.2, e.pos[2], "boat", 1);
        e.dead = true;
      }
    },

    update(e, dt, ctx) {
      const world = ctx.world;
      const wx = Math.floor(e.pos[0]), wz = Math.floor(e.pos[2]);
      const by = Math.floor(e.pos[1] + 0.05);
      const inWater = world.getBlock(wx, by, wz) === BLOCK.water;

      if (e.data.rider) {
        const p = ctx.player, input = ctx.input;
        if (input.pressed("ShiftLeft")) {
          dismount(e, ctx);
        } else {
          const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
          let fx = 0, fz = 0;
          if (input.down("KeyW")) { fx -= sin; fz -= cos; }
          if (input.down("KeyS")) { fx += sin; fz += cos; }
          if (input.down("KeyA")) { fx -= cos; fz += sin; }
          if (input.down("KeyD")) { fx += cos; fz -= sin; }
          const len = Math.hypot(fx, fz);
          if (len > 0) { fx /= len; fz /= len; }
          const spd = inWater ? WATER_SPEED : LAND_SPEED;
          e.vel[0] = fx * spd; e.vel[2] = fz * spd;
          e.yaw = p.yaw;
          // carry the player in the seat
          p.pos[0] = e.pos[0]; p.pos[1] = e.pos[1] + SEAT_Y; p.pos[2] = e.pos[2];
          p.vel[0] = p.vel[1] = p.vel[2] = 0;
        }
      } else {
        e.vel[0] *= 0.92; e.vel[2] *= 0.92;     // unridden: coast to a stop
      }

      // vertical: buoyancy spring toward the water surface, else gravity
      if (inWater) {
        let sy = by;
        while (world.getBlock(wx, sy + 1, wz) === BLOCK.water) sy++;
        const target = (sy + 0.85) - 0.18;       // hull rides just below the surface
        e.vel[1] = (target - e.pos[1]) * 8;
        if (e.vel[1] > 4) e.vel[1] = 4;
        else if (e.vel[1] < -4) e.vel[1] = -4;
      } else {
        e.vel[1] -= 24 * dt;
      }
    },
  },

  // The rider link lives on the live player, never the save: a reloaded boat is
  // always empty and ready to mount.
  serialize() { return {}; },
  deserialize() { return { rider: false }; },
};
