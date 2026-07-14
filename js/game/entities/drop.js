// Dropped item entity. Two flavours, distinguished by data.instant:
//  • instant (mined blocks / spilled containers): vacuumed into the inventory
//    the moment there's room, with no distance check — so mining feels instant.
//  • non-instant (Q-tossed items, death drops): must be walked over (proximity
//    pickup) and have a longer pre-pickup delay, so you can throw items away to
//    discard them and run back to recover items after death.
// Either way they fall, bob, spin, merge with nearby like drops, and despawn
// after 10 minutes.

import { sfx } from "../../audio/sfx.js";

const MERGE_RANGE2 = 1.6 * 1.6;
const PICKUP_RANGE2 = 1.8 * 1.8;
const DESPAWN = 600;   // 10 minutes

export const drop = {
  size: { hw: 0.18, h: 0.36 },
  physics: true,
  gravity: 26,
  flags: { pickup: true },

  spawn(e) {
    if (e.data.count == null) e.data.count = 1;
    if (e.data.despawn == null) e.data.despawn = DESPAWN;
    if (e.data.instant == null) e.data.instant = true;
    if (e.data.pickupDelay == null) e.data.pickupDelay = e.data.instant ? 0.4 : 1.0;
    e.data.bob = Math.random() * Math.PI * 2;
  },

  hooks: {
    update(e, dt, ctx) {
      e.data.bob += dt * 3;
      e.yaw += dt * 1.6;

      if (e.age >= e.data.despawn) { e.dead = true; return; }
      if (e.age < e.data.pickupDelay) return;

      // merge with a nearby like drop (higher id absorbs the lower)
      ctx.world.entities.forEach((o) => {
        if (o === e || o.type !== "drop" || o.dead) return;
        if (o.data.key !== e.data.key || o.data.instant !== e.data.instant || o.id <= e.id) return;
        const dx = o.pos[0] - e.pos[0], dy = o.pos[1] - e.pos[1], dz = o.pos[2] - e.pos[2];
        if (dx * dx + dy * dy + dz * dz > MERGE_RANGE2) return;
        o.data.count += e.data.count;
        e.dead = true;
      });
      if (e.dead) return;

      // pickup: instant drops collect from anywhere; tossed drops need proximity.
      // (In multiplayer, drops caused by a REMOTE player are spawned with
      // instant:false — see the host's shim world — so they wait to be walked
      // over instead of teleporting into the host's pockets.)
      if (!e.data.instant) {
        const p = ctx.player.pos;
        const dx = p[0] - e.pos[0], dy = (p[1] + 0.9) - e.pos[1], dz = p[2] - e.pos[2];
        if (dx * dx + dy * dy + dz * dz > PICKUP_RANGE2) return;
      }
      const left = ctx.inventory.give(e.data.key, e.data.count, e.data.dura);
      if (left < e.data.count) sfx.pickup();
      if (left <= 0) e.dead = true;
      else e.data.count = left;
    },
  },

  serialize(e) {
    return { key: e.data.key, count: e.data.count, dura: e.data.dura, despawn: e.data.despawn, instant: e.data.instant };
  },
  deserialize(d) {
    // already settled when reloaded → collectable straight away
    return { key: d.key, count: d.count, dura: d.dura, despawn: d.despawn, instant: d.instant, pickupDelay: 0 };
  },
};
