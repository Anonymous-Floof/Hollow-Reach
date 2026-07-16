// First-person player: AABB physics against the voxel world, walking/jumping,
// a creative-style fly toggle (double-tap space), health + fall damage.

import { BLOCK } from "../world/blocks.js";
import { lookDir } from "../core/mat4.js";
import { sweepAxis, bodyOverlaps } from "./physics.js";
import { sfx } from "../audio/sfx.js";

const HW = 0.3;     // half width
const H = 1.8;      // height
const EYE = 1.62;   // eye height above feet
const GRAVITY = 28;
const JUMP = 8.6;
const WALK = 4.5;
const FLY = 11;
const SWIM = 3.8;        // horizontal swim speed
const SWIM_UP = 4.6;     // ascend speed while holding jump in water
const SWIM_DOWN = 3.4;   // dive speed while holding sneak in water
const SWIM_SINK = 1.1;   // gentle passive sink terminal velocity in water
const FLOW_PUSH = 7.0;   // how hard a water current shoves the player downstream
const CLIMB = 3.2;       // ladder climb / descend speed
const STEP = 0.6;        // auto-step height on land (walk up stairs/slabs)
const EPS = 1e-3;

export class Player {
  constructor(x, y, z) {
    this.pos = [x, y, z];
    this.vel = [0, 0, 0];
    this.hw = HW;          // collision half-width / height (read by physics.js)
    this.h = H;
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.flying = false;
    this.mount = null;     // boat/other rideable currently carrying the player
    this.maxHealth = 20;
    this.health = 20;
    this._lastSpace = -1;
    this._fallStart = null;
    this._regenT = 0;       // accumulates toward the next +1 HP
    this._regenDelay = 0;   // seconds to wait after taking damage before regen
    this.sensitivity = 0.0024;
    // hunger: a visible food bar + a hidden saturation buffer that drains first.
    this.maxHunger = 20;
    this.hunger = 20;
    this.saturation = 5;
    this._exhaustion = 0;   // accumulates from time/activity; each 4 drains a point
    this._starveT = 0;
    // breath: seconds of air; runs down while the head is underwater, then drowns.
    this.maxBreath = 10;
    this.breath = 10;
    this._drownT = 0;
    // per-frame flags/overrides set from settings (see update()).
    this.hungerOn = false;
    this.stepHeight = STEP;
    this.inventory = null;  // set when the world starts, so a hit can wear armour
    // view bob: phase advances with walking speed, magnitude eases in/out so the
    // camera (and held item) sway gently while moving and settle when still.
    this._bobPhase = 0;
    this._bobMag = 0;
  }

  eye() { return [this.pos[0], this.pos[1] + EYE, this.pos[2]]; }
  forward() { return lookDir(this.yaw, this.pitch); }

  // True when the player's mid-body is inside a water cell (drives swimming).
  inWater(world) {
    return world.getBlock(Math.floor(this.pos[0]), Math.floor(this.pos[1] + 0.9), Math.floor(this.pos[2])) === BLOCK.water;
  }

  look(dx, dy, invertY) {
    this.yaw -= dx * this.sensitivity;
    this.pitch += (invertY ? dy : -dy) * this.sensitivity;
    const lim = Math.PI / 2 - 0.01;
    if (this.pitch > lim) this.pitch = lim;
    if (this.pitch < -lim) this.pitch = -lim;
  }

  update(dt, input, world, opts) {
    // While riding, the mount drives our position (boat.update seats us); the
    // player's own walking/gravity is suspended. Looking is handled by the caller.
    if (this.mount) { this.vel[0] = this.vel[1] = this.vel[2] = 0; this.onGround = true; return; }

    // settings-driven per-frame flags
    this.hungerOn = !!(opts && opts.hunger);
    this.stepHeight = (opts && opts.stepHeight) || STEP;
    const canFly = !opts || opts.flightAllowed !== false;
    if (!canFly && this.flying) { this.flying = false; this.vel[1] = 0; }   // flight just turned off

    // fly toggle on double space (only when flight is allowed)
    if (input.pressed("Space")) {
      const now = performance.now();
      if (canFly && now - this._lastSpace < 300) { this.flying = !this.flying; this.vel[1] = 0; }
      this._lastSpace = now;
    }

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let fx = 0, fz = 0;
    if (input.down("KeyW")) { fx -= sin; fz -= cos; }
    if (input.down("KeyS")) { fx += sin; fz += cos; }
    if (input.down("KeyA")) { fx -= cos; fz += sin; }
    if (input.down("KeyD")) { fx += cos; fz -= sin; }
    const len = Math.hypot(fx, fz);
    if (len > 0) { fx /= len; fz /= len; }

    const wasGround = this.onGround;
    const swimming = !this.flying && this.inWater(world);
    this.swimming = swimming;
    const onLadder = !this.flying && !swimming && this.onLadder(world);
    this.climbing = onLadder;
    const sneak = input.down("ShiftLeft") && !this.flying && !swimming;
    let speed = this.flying ? FLY : (swimming ? SWIM : (sneak ? WALK * 0.45 : WALK));
    // Sprint: hold Ctrl while moving (not sneaking/swimming) for 1.3x speed.
    this.sprinting = !swimming && !sneak && len > 0 && input.down("ControlLeft");
    if (this.sprinting) speed *= 1.3;
    this.vel[0] = fx * speed;
    this.vel[2] = fz * speed;

    if (this.flying) {
      let vy = 0;
      if (input.down("Space")) vy += 1;
      if (input.down("ShiftLeft")) vy -= 1;
      this.vel[1] = vy * FLY;
    } else if (swimming) {
      // buoyant: weak gravity, gentle capped sink, Space rises / Shift dives
      this.vel[1] -= GRAVITY * 0.22 * dt;
      if (this.vel[1] < -SWIM_SINK) this.vel[1] = -SWIM_SINK;
      if (input.down("Space")) this.vel[1] = SWIM_UP;
      else if (input.down("ShiftLeft")) this.vel[1] = -SWIM_DOWN;
    } else if (onLadder) {
      // cling to the ladder: climb with W/Space, descend with Shift, else slow slide
      if (input.down("KeyW") || input.down("Space")) this.vel[1] = CLIMB;
      else if (input.down("ShiftLeft")) this.vel[1] = -CLIMB;
      else this.vel[1] = -CLIMB * 0.25;
      this._fallStart = null;
    } else {
      this.vel[1] -= GRAVITY * dt;
      if (input.down("Space") && this.onGround) { this.vel[1] = JUMP; this.onGround = false; }
    }

    // track fall for damage (never accrues while flying, swimming, or on a ladder)
    if (!this.flying && !swimming && !onLadder) {
      if (this.vel[1] < 0 && this._fallStart === null && !this.onGround) this._fallStart = this.pos[1];
    } else {
      this._fallStart = null;
    }

    // a water current drags the player downstream (works whether wading or swimming)
    if (!this.flying) {
      const fcx = Math.floor(this.pos[0]), fcz = Math.floor(this.pos[2]), fcy = Math.floor(this.pos[1] + 0.1);
      if (world.getBlock(fcx, fcy, fcz) === BLOCK.water) {
        const [fx, fz] = world.waterFlow(fcx, fcy, fcz);
        this.vel[0] += fx * FLOW_PUSH; this.vel[2] += fz * FLOW_PUSH;
      }
    }

    this.onGround = false;
    const movingInto = len > 0;
    this.stepMove(world, 0, this.vel[0] * dt, swimming, movingInto, wasGround);
    this.stepMove(world, 2, this.vel[2] * dt, swimming, movingInto, wasGround);
    const hitGround = this.moveAxis(world, 1, this.vel[1] * dt);

    if (hitGround && this.vel[1] < 0) {
      this.land(opts);
      this.vel[1] = 0;
    } else if (hitGround && this.vel[1] > 0) {
      this.vel[1] = 0; // bonked head
    }

    // void damage
    if (this.pos[1] < -20) { this.damage(4 * dt, opts, true); }

    // view bob: only while actually walking/sprinting on the ground
    const hspeed = Math.hypot(this.vel[0], this.vel[2]);
    const bobbing = !this.flying && !this.swimming && this.onGround && hspeed > 0.5;
    const target = bobbing ? Math.min(1.4, hspeed / WALK) : 0;   // sprint bobs a touch more
    this._bobMag += (target - this._bobMag) * Math.min(1, dt * 8);
    if (bobbing) this._bobPhase += hspeed * dt * 1.65;

    this.survival(dt, world, opts);
  }

  // Current bob phase + eased magnitude (for the held-item viewmodel sway).
  bobState() { return { phase: this._bobPhase, mag: this._bobMag }; }

  // World-space offset to add to the camera eye for the walking head-bob. Kept
  // off the interaction eye() so aim/raycast stay rock-steady.
  viewBobOffset() {
    const m = this._bobMag;
    if (m <= 0.001) return [0, 0, 0];
    const vert = Math.sin(this._bobPhase * 2.0) * 0.05 * m;     // a dip per footfall
    const horiz = Math.cos(this._bobPhase) * 0.045 * m;         // sway side to side
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);    // camera right (yaw only)
    return [rx * horiz, vert, rz * horiz];
  }

  // Breath/drowning, hunger drain + starvation, and (now hunger-gated) regen.
  survival(dt, world, opts) {
    // ---- breath: drain underwater, then drown; refill in air ----
    if (this.headInWater(world)) {
      this.breath -= dt;
      if (this.breath <= 0) { this.breath = 0; this._drownT += dt; if (this._drownT >= 1) { this._drownT = 0; this.damage(2, opts, true); } }
    } else {
      this.breath = Math.min(this.maxBreath, this.breath + dt * 5);
      this._drownT = 0;
    }

    // ---- hunger: time/activity burns saturation then food; empty = starve ----
    if (this.hungerOn) {
      let rate = 0.15;                       // base drain per second
      if (this.sprinting) rate += 0.4;       // sprinting is hungry work
      if (this.swimming) rate += 0.15;
      this._exhaustion += rate * dt;
      while (this._exhaustion >= 4) {
        this._exhaustion -= 4;
        if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
        else this.hunger = Math.max(0, this.hunger - 1);
      }
      if (this.hunger <= 0) {
        this._starveT += dt;
        if (this._starveT >= 4) { this._starveT = 0; this.damage(1, opts, true); }   // starvation, ignores armour
      } else this._starveT = 0;
    }

    // ---- regeneration: a few seconds after the last hit; needs to be well-fed
    // when the hunger system is on (and healing then costs food). ----
    if (this._regenDelay > 0) this._regenDelay -= dt;
    const wellFed = !this.hungerOn || this.hunger >= 18;
    if (this._regenDelay <= 0 && wellFed && this.health > 0 && this.health < this.maxHealth) {
      this._regenT += dt;
      if (this._regenT >= 2.5) { this._regenT = 0; this.heal(1); if (this.hungerOn) this._exhaustion += 3; }
    } else {
      this._regenT = 0;
    }
  }

  // True when the player's eye (head) cell is water — drives breath/drowning.
  headInWater(world) {
    const e = this.eye();
    return world.getBlock(Math.floor(e[0]), Math.floor(e[1]), Math.floor(e[2])) === BLOCK.water;
  }

  // Eat a food item: apply its hunger (or, with hunger off, a small heal). risky
  // foods gamble (rotten flesh: 50/50 +1 hunger or −2). Returns true if consumed.
  eat(item) {
    if (!this.hungerOn) {                       // hunger disabled: food just heals a bit
      if (this.health >= this.maxHealth) return false;
      this.heal(item.risky ? (Math.random() < 0.5 ? 1 : 0) : Math.ceil(item.food / 2));
      return true;
    }
    if (item.risky) {
      // the gamble is symmetric around the tooltip's number
      if (Math.random() < 0.5) this.addFood(item.food, 0);
      else { this.hunger = Math.max(0, this.hunger - item.food); this.saturation = Math.min(this.saturation, this.hunger); }
      return true;
    }
    if (this.hunger >= this.maxHunger) return false;   // already full — don't waste it
    this.addFood(item.food, item.food * 0.6);
    return true;
  }
  addFood(food, sat) {
    this.hunger = Math.min(this.maxHunger, this.hunger + food);
    this.saturation = Math.min(this.hunger, this.saturation + sat);
  }

  land(opts) {
    this.onGround = true;
    if (this._fallStart !== null) {
      const dist = this._fallStart - this.pos[1];
      this._fallStart = null;
      if (dist > 1.4) sfx.land(Math.min(1, (dist - 1.4) / 10));   // thud scales with the drop
      if (opts && opts.fallDamage && dist > 3.5) {
        let dmg = Math.floor(dist - 3.5);
        dmg = Math.max(0, dmg - (opts.defense || 0) * 0.5);
        if (dmg > 0) this.damage(dmg, opts);
      }
    }
  }

  damage(amount, opts, ignoreArmor = false) {
    if (!ignoreArmor && opts && opts.defense) amount *= 1 - Math.min(0.7, opts.defense * 0.04);
    if (amount <= 0) return;
    this.health = Math.max(0, this.health - amount);
    this._regenDelay = 6;   // pause regeneration briefly after a hit
    sfx.hurt();
    // armour soaks the blow and wears for it (drowning/starvation/void pass
    // ignoreArmor, so those don't chew through your gear).
    if (!ignoreArmor && this.inventory) this.inventory.damageArmor(1);
    if (opts && opts.onHurt) opts.onHurt();
  }

  heal(a) { this.health = Math.min(this.maxHealth, this.health + a); }

  // Horizontal move with an auto-step: if blocked while grounded, try lifting a
  // small ledge (stairs/slabs) and continuing; while swimming, lift a full block
  // to climb out at a shore (only if you'd surface into open air).
  stepMove(world, axis, delta, swimming, movingInto, grounded) {
    const blocked = this.moveAxis(world, axis, delta);
    if (!blocked || !movingInto || !(swimming || grounded)) return blocked;

    const stepH = swimming ? 1.0 : this.stepHeight;
    const savedAxis = this.pos[axis], savedY = this.pos[1];
    this.pos[1] += stepH + EPS;
    if (this.overlaps(world)) { this.pos[1] = savedY; return true; }   // no headroom
    if (!this.moveAxis(world, axis, delta)) {
      if (!swimming) return false;                  // stepped onto a ledge; gravity reseats
      const headAir = world.getBlock(Math.floor(this.pos[0]), Math.floor(this.pos[1] + H), Math.floor(this.pos[2])) === 0;
      if (headAir) { this.vel[1] = Math.max(this.vel[1], 0); return false; }
    }
    this.pos[axis] = savedAxis; this.pos[1] = savedY;   // revert the probe
    return true;
  }

  // Player movement/collision shares the entity physics (physics.js): the
  // player is just a body { pos, hw, h }.
  moveAxis(world, axis, delta) { return sweepAxis(world, this, axis, delta); }
  overlaps(world) { return bodyOverlaps(world, this); }

  // True when the player's body overlaps a climbable (ladder) cell.
  onLadder(world) {
    const p = this.pos;
    const x0 = Math.floor(p[0] - HW), x1 = Math.floor(p[0] + HW - EPS);
    const y0 = Math.floor(p[1]), y1 = Math.floor(p[1] + H - EPS);
    const z0 = Math.floor(p[2] - HW), z1 = Math.floor(p[2] + HW - EPS);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++)
          if (world.isClimbable(x, y, z)) return true;
    return false;
  }

  toJSON() {
    return {
      pos: this.pos.slice(), yaw: this.yaw, pitch: this.pitch, health: this.health, flying: this.flying,
      hunger: this.hunger, saturation: this.saturation,
    };
  }
  loadJSON(d) {
    if (!d) return;
    this.pos = d.pos ? d.pos.slice() : this.pos;
    this.yaw = d.yaw || 0; this.pitch = d.pitch || 0;
    this.health = d.health ?? this.maxHealth;
    this.flying = !!d.flying;
    this.hunger = d.hunger ?? this.maxHunger;
    this.saturation = d.saturation ?? 5;
  }
}
