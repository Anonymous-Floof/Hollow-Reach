// Shared AI world-services, one instance per world at `world.entities.ai`.
// (AI backend — the hub the per-mob systems plug into.)
//
//   sounds : SoundBus    — transient sound events mobs can hear. Anything may
//                          emit: `world.entities.ai.sounds.emit(pos, 12, "break")`.
//   scent  : ScentField  — decaying trail of player positions for smell-tracking.
//   pathBudget           — { left } shared A* expansion budget, refilled every
//                          tick, so a crowd of pathing mobs splits one frame's
//                          allowance instead of each spiking the frame.
//
// requestPath() is the polite way for a mob to path: per-entity replan cooldown
// + the shared budget, so calling it every tick is safe.
//
// The manager ticks this before entities each frame; it also drops the player's
// scent automatically, so smell works with zero per-mob setup.

import { SoundBus, ScentField } from "./senses.js";
import { findPath } from "./path.js";

const PATH_BUDGET_PER_TICK = 1500;   // total A* node expansions per frame
const SCENT_PERIOD = 0.3;            // seconds between player scent drops

export class AIServices {
  constructor(world) {
    this.world = world;
    this.sounds = new SoundBus();
    this.scent = new ScentField();
    this.pathBudget = { left: PATH_BUDGET_PER_TICK };
    this._scentT = 0;
  }

  tick(dt, ctx) {
    this.pathBudget.left = PATH_BUDGET_PER_TICK;
    this.sounds.tick(dt);
    this.scent.tick(dt);
    // the player continuously lays scent while alive (grounded or not — a trail
    // over a jump is still a trail)
    this._scentT -= dt;
    if (this._scentT <= 0 && ctx && ctx.player && ctx.player.health > 0) {
      this._scentT = SCENT_PERIOD;
      this.scent.deposit(ctx.player.pos, "player");
    }
  }

  // Budgeted, throttled pathfind for one entity. Returns a fresh path object at
  // most every `cooldown` seconds per entity (null between — keep following the
  // old one). opts are forwarded to findPath.
  requestPath(e, goalPos, opts = {}, cooldown = 0.6) {
    const d = e.data;
    // scent.now doubles as a monotonically-increasing AI clock
    if (d._pathNext != null && d._pathNext > this.scent.now) return null;
    d._pathNext = this.scent.now + cooldown;
    return findPath(this.world, e.pos, goalPos, opts, this.pathBudget);
  }
}
