// Per-frame audio orchestration, driven from the game loop. Owns the things
// that need continuous game state rather than a discrete event: the 3D
// listener pose, the underwater muffle, footsteps (a stride-distance
// accumulator over the block underfoot), entering-water splashes, ambient mob
// calls, and the ambience beds. Discrete events (mining, doors, hits…) call
// the sfx facade directly from where they happen.

import { engine } from "./engine.js";
import { sfx } from "./sfx.js";
import { ambience } from "./ambience.js";
import { getBlock, AIR, BLOCK } from "../world/blocks.js";

const R = (a, b) => a + Math.random() * (b - a);

// how far apart (blocks) mob idle calls schedule, per type
const CALL_GAP = { sheep: [8, 22], pig: [7, 20], zombie: [5, 14] };

class Director {
  constructor() {
    this._stride = 0;
    this._wasInWater = false;
    this._mobCallCD = 0;
  }

  // game: the Game instance (world, player, sky, _underwater, state).
  update(dt, game) {
    if (!engine.ready() || !game.world || !game.player) return;
    const { world, player, sky } = game;
    const active = game.state === "playing";

    engine.updateListener(player.eye(), player.yaw);
    engine.setUnderwater(game._underwater || 0);

    ambience.update(dt, { world, player, sky, underwater: game._underwater || 0, active });

    if (!active) return;

    // ---- footsteps: a stride-length accumulator over the block underfoot ----
    const hspeed = Math.hypot(player.vel[0], player.vel[2]);
    const feetInWater = world.getBlock(Math.floor(player.pos[0]), Math.floor(player.pos[1] + 0.05), Math.floor(player.pos[2])) === BLOCK.water;
    const walking = hspeed > 0.6 && !player.flying && (player.onGround || player.climbing) && !player.swimming;
    if (walking) {
      this._stride += hspeed * dt;
      const strideLen = player.sprinting ? 2.4 : 1.9;
      if (this._stride >= strideLen) {
        this._stride = 0;
        if (feetInWater) sfx.wadeStep();
        else {
          // the block under the feet gives the step its material
          const bx = Math.floor(player.pos[0]), bz = Math.floor(player.pos[2]);
          let id = world.getBlock(bx, Math.floor(player.pos[1] - 0.05), bz);
          if (id === AIR) id = world.getBlock(bx, Math.floor(player.pos[1] - 1.05), bz);
          if (player.climbing) id = BLOCK.ladder;
          if (id !== AIR) sfx.step(getBlock(id), player.sprinting);
        }
      }
    } else this._stride *= 0.9;

    // ---- splash on entering water (harder fall = bigger splash) ----
    const inWater = player.inWater(world);
    if (inWater && !this._wasInWater) sfx.splash(player.vel[1] < -6);
    this._wasInWater = inWater;

    // ---- ambient mob calls: each nearby mob keeps its own randomized clock ----
    this._mobCallCD -= dt;
    world.entities.forEach((e) => {
      const gap = CALL_GAP[e.type];
      if (!gap) return;
      const dx = e.pos[0] - player.pos[0], dz = e.pos[2] - player.pos[2];
      if (dx * dx + dz * dz > 24 * 24) return;
      if (e.data._callT == null) e.data._callT = R(1.5, gap[1]);
      e.data._callT -= dt;
      if (e.data._callT <= 0) {
        e.data._callT = R(gap[0], gap[1]);
        if (this._mobCallCD <= 0) {              // never a whole choir at once
          this._mobCallCD = 0.9;
          sfx[e.type]("say", [e.pos[0], e.pos[1] + e.h * 0.7, e.pos[2]], e.id);
        }
      }
    });
  }

  // Quitting to the menu: settle every bed, forget transient state.
  stop() {
    ambience.quiet();
    this._stride = 0;
    this._wasInWater = false;
  }
}

export const director = new Director();
