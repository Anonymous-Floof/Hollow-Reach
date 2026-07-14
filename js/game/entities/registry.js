// Entity type registry — the same data-driven pattern as BLOCKS / ITEMS /
// RECIPES. Each definition describes an entity *kind*; instances carry only
// their state. To add a new entity (mob, boat, projectile…), write a def with
// the relevant hooks/flags and register it here.
//
// Definition shape (all optional except size):
//   size:    { hw, h }                  collision/AABB half-width + height
//   physics: bool                       apply gravity + world collision each tick
//   gravity: number                     accel (default 24) when physics
//   spawn:   (e) => void                initialise instance data on creation
//   hooks: {
//     update:     (e, dt, ctx) => void  per-tick behaviour (AI, pickup, …)
//     onInteract: (e, ctx, button) => void   left/right click when targeted
//     onContact:  (e, player) => void   touch (combat/pickup) — reserved
//   }
//   serialize/deserialize: (e)/(data)   persistence (default: shallow data copy)
//   flags:   { pickup, rideable, tether, ai, ... }   capability markers
//
// ctx passed to hooks = { world, player, inventory, input, notify }.

import { drop } from "./drop.js";
import { boat } from "./boat.js";
import { sheep } from "./sheep.js";
import { pig } from "./pig.js";
import { zombie } from "./zombie.js";

// Another player, seen over the network. Always a ghost (net-driven, no local
// physics or hooks) — combat against one is routed to the host by interact.js,
// so it deliberately has no onInteract.
const remote_player = {
  size: { hw: 0.3, h: 1.8 },
  physics: false,
  gravity: 0,
  flags: {},
};

export const ENTITY_TYPES = {
  drop,
  boat,
  sheep,
  pig,
  zombie,
  remote_player,
};

export function defOf(type) { return ENTITY_TYPES[type] || null; }
