// First animal: a white sheep. A passive grazer (shared wander/flee brain in
// ai.js) that drops a white wool block on death — the wool you need (with planks)
// to craft a bed. Combat routes through the generic entity onInteract.

import { grazeUpdate, grazeHurt } from "./ai.js";

const MAX_HP = 8;

export const sheep = {
  size: { hw: 0.45, h: 1.0 },
  physics: true,
  gravity: 26,
  flags: { ai: true, health: true },

  spawn(e) {
    if (e.data.health == null) e.data.health = MAX_HP;
    e.data.changeT = Math.random() * 2;
    e.data.heading = Math.random() * Math.PI * 2;
    e.data.moving = false;
    e.data.flee = 0;
    e.data.hurtFlash = 0;
  },

  hooks: {
    update(e, dt, ctx) { grazeUpdate(e, dt, ctx, { walkSpeed: 1.7, fleeSpeed: 3.4 }); },

    onInteract(e, ctx, button) {
      if (button !== "left") return;
      if (grazeHurt(e, ctx)) {
        e.dead = true;
        ctx.world.spawnDrop(e.pos[0], e.pos[1] + 0.4, e.pos[2], "wool", 1);
        if (ctx.notify) ctx.notify("The sheep drops its wool.");
      }
    },
  },

  serialize(e) { return { health: e.data.health }; },
  deserialize(d) { return { health: d.health != null ? d.health : MAX_HP }; },
};
