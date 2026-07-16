// A brown-and-white cow: the biggest passive grazer (same shared wander/flee
// brain as the sheep/pig). Drops raw beef and leather on death, and can be
// milked — right-click with an empty bucket for a bucket of milk.

import { grazeUpdate, grazeHurt } from "./ai.js";
import { sfx } from "../../audio/sfx.js";

const MAX_HP = 12;

export const cow = {
  size: { hw: 0.55, h: 1.35 },
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
    update(e, dt, ctx) { grazeUpdate(e, dt, ctx, { walkSpeed: 1.4, fleeSpeed: 3.0 }); },

    onInteract(e, ctx, button) {
      if (button === "right") {
        // milking: swap an empty bucket for a milk bucket
        const slot = ctx.inventory.selectedSlot && ctx.inventory.selectedSlot();
        if (slot && slot.key === "bucket") {
          ctx.inventory.consumeSelected();
          ctx.inventory.give("milk_bucket", 1);
          sfx.splash(false);
          if (ctx.notify) ctx.notify("You milk the cow.");
        }
        return;
      }
      if (button !== "left") return;
      if (grazeHurt(e, ctx)) {
        e.dead = true;
        const beef = 1 + (Math.random() < 0.5 ? 1 : 0);
        ctx.world.spawnDrop(e.pos[0], e.pos[1] + 0.5, e.pos[2], "beef_raw", beef);
        const hide = (Math.random() * 3) | 0;   // 0-2
        if (hide > 0) ctx.world.spawnDrop(e.pos[0], e.pos[1] + 0.5, e.pos[2], "leather", hide);
        if (ctx.notify) ctx.notify(hide > 0 ? "The cow drops beef and leather." : "The cow drops beef.");
      }
    },
  },

  serialize(e) { return { health: e.data.health }; },
  deserialize(d) { return { health: d.health != null ? d.health : MAX_HP }; },
};
