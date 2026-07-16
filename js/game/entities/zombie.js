// First monster: a green zombie. It wanders at random; when it SEES a player —
// true voxel line-of-sight, so walls and hills actually hide you — it shambles
// after them, A*-pathing around obstacles, and keeps a short memory of where its
// target was last seen so breaking line of sight means slipping away, not
// instantly turning it off. Strikes on a cooldown when close. Like the sheep it
// climbs hills and avoids water; unlike the sheep it burns away in direct
// sunlight, so they're a night-time threat. Drops rotten flesh on death.

import { getItem } from "../items.js";
import { floatInWater, attackDamage, wanderStep, steerHeading, stuck } from "./ai.js";
import { lineOfSight } from "./ai/senses.js";
import { PathFollower } from "./ai/path.js";
import { sfx } from "../../audio/sfx.js";

const MAX_HP = 16;
const AGGRO = 16;        // blocks: how far it can notice the player
const REACH = 1.7;       // blocks: how close before it can hit
const HIT_DMG = 3;       // damage per strike (before the player's armour)
const MEMORY = 8;        // seconds it hunts the last-seen spot after losing sight
const EYE_Y = 1.62;      // zombie eye height for sight lines

export const zombie = {
  size: { hw: 0.4, h: 1.9 },
  physics: true,
  gravity: 26,
  flags: { ai: true, health: true, hostile: true },

  spawn(e) {
    if (e.data.health == null) e.data.health = MAX_HP;
    e.data.changeT = Math.random() * 2;
    e.data.heading = Math.random() * Math.PI * 2;
    e.data.moving = false;
    e.data.atkCD = 0;
    e.data.burn = 0;
    e.data.hurtFlash = 0;
  },

  hooks: {
    update(e, dt, ctx) {
      const d = e.data;
      d.hurtFlash = Math.max(0, (d.hurtFlash || 0) - dt);
      d.atkCD = Math.max(0, (d.atkCD || 0) - dt);

      // ---- burn in direct sunlight (keeps them to the night) ----
      const sky = ctx.sky;
      if (sky && sky.dayFactor() > 0.5) {
        const hy = Math.floor(e.pos[1] + 1.6);
        const exposed = ctx.world.getSky(Math.floor(e.pos[0]), hy, Math.floor(e.pos[2])) >= 15;
        if (exposed) {
          d.burn = (d.burn || 0) + dt;
          if (d.burn >= 1) { d.burn = 0; d.health -= 2; d.hurtFlash = 0.3; sfx.sizzle(e.pos); }
          if (d.health <= 0) { e.dead = true; return; }   // burned up — no drop
        } else d.burn = 0;
      }

      // ---- target the nearest player in range ----
      // Multiplayer hosts supply ctx.players (the local player + every remote
      // player as a strikeable target); single-player falls back to ctx.player.
      let tgt = null, dist = Infinity, dx = 0, dz = 0, dy = 0;
      const list = ctx.players;
      if (list && list.length) {
        for (const t of list) {
          if (t.health <= 0) continue;
          const ddx = t.pos[0] - e.pos[0], ddz = t.pos[2] - e.pos[2];
          const dd = Math.hypot(ddx, ddz);
          if (dd < dist) { dist = dd; tgt = t; dx = ddx; dz = ddz; dy = Math.abs(t.pos[1] - e.pos[1]); }
        }
      } else if (ctx.player.health > 0) {
        const p = ctx.player.pos;
        dx = p[0] - e.pos[0]; dz = p[2] - e.pos[2];
        dist = Math.hypot(dx, dz);
        dy = Math.abs(p[1] - e.pos[1]);
        tgt = {
          pos: p, health: ctx.player.health,
          hurt: (dmg, kb) => {
            const defense = ctx.inventory && ctx.inventory.totalDefense ? ctx.inventory.totalDefense() : 0;
            ctx.player.damage(dmg, { defense });
            ctx.player.vel[0] += kb[0]; ctx.player.vel[2] += kb[2];
            ctx.player.vel[1] = Math.max(ctx.player.vel[1], kb[1]);
            if (ctx.notify) ctx.notify("A zombie claws at you!");
          },
        };
      }
      // ---- sight: throttled true line-of-sight to the nearest target ----
      // No more x-ray vision: a wall between eye and target means not spotted,
      // and a target that breaks line of sight leaves only a fading memory.
      const inWater = floatInWater(ctx.world, e);
      d.lookT = (d.lookT != null ? d.lookT : Math.random() * 0.25) - dt;
      if (tgt && dist < AGGRO && dy < 6) {
        if (d.lookT <= 0) {
          d.lookT = 0.25;
          const eye = [e.pos[0], e.pos[1] + EYE_Y, e.pos[2]];
          const teye = [tgt.pos[0], tgt.pos[1] + 1.5, tgt.pos[2]];
          d.sees = lineOfSight(ctx.world, eye, teye, AGGRO + 4);
        }
      } else d.sees = false;
      if (d.sees && tgt) {
        d.memX = tgt.pos[0]; d.memY = tgt.pos[1]; d.memZ = tgt.pos[2];
        d.memT = MEMORY;
      } else {
        d.memT = Math.max(0, (d.memT || 0) - dt);
      }

      if ((d.sees && tgt) || d.memT > 0) {
        // ---- hunt: the target if visible, else where it was last seen ----
        const seen = d.sees && tgt;
        const gx = seen ? tgt.pos[0] : d.memX, gy = seen ? tgt.pos[1] : d.memY, gz = seen ? tgt.pos[2] : d.memZ;
        const gdx = gx - e.pos[0], gdz = gz - e.pos[2];
        const gdist = Math.hypot(gdx, gdz);

        if (seen && dist < REACH && dy < 2 && d.atkCD <= 0) {   // strike on cooldown
          d.atkCD = 1.0;
          const l = dist || 1;                                   // shove the target back
          tgt.hurt(HIT_DMG, [(dx / l) * 4, 3, (dz / l) * 4]);
        }

        if (seen && dist < REACH) {
          // planted on the player: stop (no walk-through) and face them
          d.follower = null;
          d.heading = Math.atan2(dz, dx);
          stuck(e, dt, 0);
          e.yaw = Math.PI / 2 - d.heading;
        } else if (!seen && gdist < 1.4) {
          // reached a cold trail with nobody there — give up and mill about
          d.memT = 0;
          d.follower = null;
          wanderStep(e, dt, ctx, 1.2, inWater);
        } else {
          // path toward the goal, replanning when it drifts or the route dies
          const ai = ctx.world.entities && ctx.world.entities.ai;
          const end = d.follower && d.follower.end;
          const needNew = !d.follower || d.follower.done ||
            (end && Math.hypot(end[0] - gx, end[2] - gz) > 3);
          if (needNew && ai && !inWater) {
            const path = ai.requestPath(e, [gx, gy, gz], { maxFall: 3, maxDist: 24 }, 0.5);
            if (path && path.points.length > 1) d.follower = new PathFollower(path);
          }
          if (d.follower && !inWater) {
            stuck(e, dt, 0);
            const st = d.follower.step(e, dt, 2.4);
            if (st !== "moving") {
              d.follower = null;
              if (st === "stuck") d._pathNext = 0;   // replan immediately next tick
            }
          } else {
            // no path yet (cooldown/budget) or paddling — go straight at it
            d.heading = Math.atan2(gdz, gdx);
            steerHeading(e, dt, ctx, 2.4, inWater);
          }
        }
      } else {
        // ---- no target: path-assisted wandering (shared with the grazers) ----
        wanderStep(e, dt, ctx, 1.2, inWater);
      }
    },

    onInteract(e, ctx, button) {
      if (button !== "left") return;
      e.data.health -= attackDamage(ctx.inventory, ctx.player);
      e.data.hurtFlash = 0.35;
      const vpos = [e.pos[0], e.pos[1] + 1.6, e.pos[2]];
      sfx.thwack(vpos);
      sfx.zombie(e.data.health <= 0 ? "death" : "hurt", vpos, e.id);
      const p = ctx.player.pos;                            // knock the zombie back
      const dx = e.pos[0] - p[0], dz = e.pos[2] - p[2], l = Math.hypot(dx, dz) || 1;
      e.vel[0] += (dx / l) * 4; e.vel[2] += (dz / l) * 4; e.vel[1] = 4;
      const slot = ctx.inventory.selectedSlot && ctx.inventory.selectedSlot();
      const held = slot ? getItem(slot.key) : null;
      if (held && held.type === "tool") ctx.inventory.damageSelectedTool(1);
      if (e.data.health <= 0) {
        e.dead = true;
        ctx.world.spawnDrop(e.pos[0], e.pos[1] + 0.6, e.pos[2], "rotten_flesh", 1);
      }
    },
  },

  serialize(e) { return { health: e.data.health }; },
  deserialize(d) { return { health: d.health != null ? d.health : MAX_HP }; },
};
