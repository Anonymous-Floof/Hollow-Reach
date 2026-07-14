// A pink pig: a passive grazer like the sheep (same shared wander/flee brain),
// but it drops a Raw Porkchop on death — eat it raw for a little food, or smelt
// it into a Cooked Porkchop for more.

import { grazeUpdate, grazeHurt } from "./ai.js";

const MAX_HP = 10;

export const pig = {
  size: { hw: 0.45, h: 0.9 },
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
    update(e, dt, ctx) { grazeUpdate(e, dt, ctx, { walkSpeed: 1.6, fleeSpeed: 3.2 }); },

    onInteract(e, ctx, button) {
      if (button !== "left") return;
      if (grazeHurt(e, ctx)) {
        e.dead = true;
        ctx.world.spawnDrop(e.pos[0], e.pos[1] + 0.4, e.pos[2], "pork_raw", 1);
        if (ctx.notify) ctx.notify("The pig drops a porkchop.");
      }
    },
  },

  serialize(e) { return { health: e.data.health }; },
  deserialize(d) { return { health: d.health != null ? d.health : MAX_HP }; },
};
