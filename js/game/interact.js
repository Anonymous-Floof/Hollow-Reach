// Break/place interaction. Raycasts each frame to find the targeted block,
// accumulates break progress (modulated by tool + hardness with the mining-tier
// gate), and places the selected block item.

import { raycast } from "./raycast.js";
import { getBlock, AIR, isReplaceable } from "../world/blocks.js";
import { getItem } from "./items.js";
import { entityContents } from "./blockentities.js";
import { defOf } from "./entities/registry.js";
import { sfx } from "../audio/sfx.js";

const HW = 0.3, H = 1.8;

// Facing -> step from the bed's foot cell to its head cell (0:+x 1:-x 2:+z 3:-z).
const BED_DIR = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class Interact {
  constructor() {
    this.selection = null;
    this.target = null;
    this.progress = 0;
    this.breakFrac = 0;
    this._attackCD = 0;   // seconds until the next melee swing can land
    this._digSoundT = 0;  // rhythm clock for the mining tick sound
  }

  update(dt, input, player, world, inventory, opts) {
    if (this._attackCD > 0) this._attackCD -= dt;
    const eye = player.eye();
    const dir = player.forward();
    const hit = raycast(world, eye, dir, 6);

    // An interactable entity (boat/mob) closer than the targeted block takes the
    // click. Drops have no onInteract, so this is inert for them.
    const eHit = world.entities ? world.entities.raycast(eye, dir, 6) : null;
    // Ghost entities (multiplayer mirrors) never run hooks locally: attacks are
    // routed to the host, which owns the real entity. The local swing sound is
    // the only prediction — damage numbers stay authoritative.
    if (eHit && eHit.entity.ghost && (!hit || eHit.dist < hit.dist)) {
      this.selection = null; this.reset();
      if (opts.net && input.buttons.left && this._attackCD <= 0) {
        sfx.swing();
        const slot = inventory.selectedSlot();
        const held = slot ? slot.key : "";
        if (eHit.entity.pid) opts.net.sendPlayerHit(eHit.entity.pid, held);
        else if (eHit.entity.netId != null) opts.net.sendEntityHit(eHit.entity.netId, held);
        this._attackCD = 0.45;
      }
      return;
    }
    if (eHit && (!hit || eHit.dist < hit.dist)) {
      const edef = defOf(eHit.entity.type);
      if (edef && edef.hooks && edef.hooks.onInteract) {
        this.selection = null; this.reset();
        const ctx = { world, player, inventory, notify: opts.notify, input };
        if (input.clicks.right) edef.hooks.onInteract(eHit.entity, ctx, "right");
        else if (input.buttons.left && this._attackCD <= 0) {   // cooldown so holding LMB doesn't instakill
          sfx.swing();
          edef.hooks.onInteract(eHit.entity, ctx, "left");
          this._attackCD = 0.45;
        }
        return;
      }
    }

    // ---- eating: right-click with food, works even when aiming at the sky ----
    // (an interactive block — station/sleep/toggle — still takes priority).
    if (input.clicks.right) {
      const slot = inventory.selectedSlot();
      const it = slot ? getItem(slot.key) : null;
      if (it && it.type === "food") {
        const tb = hit ? getBlock(world.getBlock(hit.x, hit.y, hit.z)) : null;
        const blockHandles = tb && (tb.station || tb.sleep || tb.toggle) && !input.down("ShiftLeft");
        if (!blockHandles && opts.onEat && opts.onEat(it)) { inventory.consumeSelected(); return; }
      }
    }

    this.selection = hit ? { x: hit.x, y: hit.y, z: hit.z } : null;
    if (!hit) { this.reset(); return; }
    const id = world.getBlock(hit.x, hit.y, hit.z);
    const b = getBlock(id);

    // ---- breaking ----
    if (input.buttons.left && b.breakable) {
      if (!this.target || this.target.x !== hit.x || this.target.y !== hit.y || this.target.z !== hit.z) {
        this.target = { x: hit.x, y: hit.y, z: hit.z };
        this.progress = 0;
      }
      const slot = inventory.selectedSlot();
      const tool = slot ? getItem(slot.key) : null;
      // Only the *correct* tool speeds up mining. A block with no designated
      // tool (leaves, glass, torches) always mines at hand speed — using e.g. an
      // axe on leaves is no faster than bare hands.
      let speed = 1;
      if (tool && tool.type === "tool" && b.tool !== null && tool.toolType === b.tool) speed = tool.speed;
      const breakTime = b.hardness / speed;
      this.progress += dt;
      this.breakFrac = Math.min(1, this.progress / breakTime);
      // rhythmic dig ticks while chipping away (not on insta-broken blocks)
      this._digSoundT -= dt;
      if (this._digSoundT <= 0 && breakTime > 0.25) {
        this._digSoundT = 0.24;
        sfx.blockHit(b, [hit.x + 0.5, hit.y + 0.5, hit.z + 0.5]);
      }
      if (this.progress >= breakTime) {
        sfx.blockBreak(b, [hit.x + 0.5, hit.y + 0.5, hit.z + 0.5]);
        this.complete(world, inventory, hit, b, tool, opts);
        this.reset();
      }
    } else {
      this.target = null; this.progress = 0; this.breakFrac = 0; this._digSoundT = 0;
    }

    // ---- placing / using stations / toggling ----
    if (input.clicks.right) {
      if (b.station && !input.down("ShiftLeft")) {
        opts.onOpenStation(b.station, hit.x, hit.y, hit.z);
      } else if (b.sleep && !input.down("ShiftLeft")) {
        opts.onSleep();
      } else if (b.toggle && !input.down("ShiftLeft")) {
        this.toggle(world, hit, b);
      } else {
        this.tryPlace(world, inventory, player, hit, opts);
      }
    }
  }

  // Open/close a door or trapdoor (doors flip both halves together).
  toggle(world, hit, b) {
    world.setMeta(hit.x, hit.y, hit.z, world.getMeta(hit.x, hit.y, hit.z) ^ 1);
    sfx.doorToggle(b, (world.getMeta(hit.x, hit.y, hit.z) & 1) !== 0, [hit.x + 0.5, hit.y + 0.5, hit.z + 0.5]);
    if (b.tall) {
      const upper = (world.getMeta(hit.x, hit.y, hit.z) & 2) !== 0;
      const oy = upper ? hit.y - 1 : hit.y + 1;
      if (getBlock(world.getBlock(hit.x, oy, hit.z)).tall) {
        world.setMeta(hit.x, oy, hit.z, world.getMeta(hit.x, oy, hit.z) ^ 1);
      }
    }
  }

  reset() { this.target = null; this.progress = 0; this.breakFrac = 0; }

  complete(world, inventory, hit, b, tool, opts) {
    // A block only *requires* a tool when it has a mining tier above hand (0).
    // Soft blocks (turf, loam, wood, sand…) always drop, by hand or any tool —
    // the matching tool just mines them faster.
    const gated = b.minTier > 0;
    const correctTool = tool && tool.type === "tool" && tool.toolType === b.tool;
    const canDrop = b.drop !== "" &&
      (!gated || (correctTool && tool.tier >= b.minTier));
    if (canDrop) {
      const dropKey = b.drop || b.key;
      world.spawnDrop(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, dropKey, b.dropCount || 1);
    } else if (gated && opts.notify) {
      const need = ["", "wood", "stone", "copper", "iron"][Math.min(4, b.minTier)] || "better";
      opts.notify(`Needs a ${need}+ tier ${b.tool || "tool"} to harvest`);
    }
    // Spill any block-entity contents (forge/chest) out as item drops, then remove it.
    if (b.station) {
      const be = world.getBlockEntity(hit.x, hit.y, hit.z);
      for (const s of entityContents(be)) world.spawnDrop(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, s.key, s.count, s.dura);
      world.removeBlockEntity(hit.x, hit.y, hit.z);
    }
    // Doors are two cells — remove the partner half too.
    if (b.tall) {
      const upper = (world.getMeta(hit.x, hit.y, hit.z) & 2) !== 0;
      const oy = upper ? hit.y - 1 : hit.y + 1;
      if (getBlock(world.getBlock(hit.x, oy, hit.z)).tall) world.setBlock(hit.x, oy, hit.z, AIR, true);
    }
    // Beds are two horizontal cells — remove the partner (foot<->head) too.
    if (b.render === "bed") {
      const meta = world.getMeta(hit.x, hit.y, hit.z);
      const [dx, dz] = BED_DIR[meta & 3];
      const isHead = (meta & 4) !== 0;
      const ox = isHead ? hit.x - dx : hit.x + dx;
      const oz = isHead ? hit.z - dz : hit.z + dz;
      if (getBlock(world.getBlock(ox, hit.y, oz)).render === "bed") world.setBlock(ox, hit.y, oz, AIR, true);
    }
    world.setBlock(hit.x, hit.y, hit.z, AIR, true);
    if (b.log) world.decayLeavesAround(hit.x, hit.y, hit.z);
    if (tool && tool.type === "tool") inventory.damageSelectedTool(1);
  }

  tryPlace(world, inventory, player, hit, opts) {
    const slot = inventory.selectedSlot();
    if (!slot) return;
    const item = getItem(slot.key);
    if (!item) return;

    // Boats aren't blocks — using one spawns a boat entity in the empty cell
    // (it floats if that's water, otherwise it falls and rests on the ground).
    if (item.type === "boat") {
      // (v1 multiplayer: boat entities live on the host and can't be spawned or
      // ridden by guests yet — riding transfers physics authority, a later pass)
      if (world.netRole === "client") { if (opts.notify) opts.notify("Boats aren't synced in multiplayer yet"); return; }
      world.spawnBoat(hit.nx + 0.5, hit.ny, hit.nz + 0.5);
      inventory.consumeSelected();
      sfx.splash(false);
      return;
    }

    if (item.type !== "block") return;
    // Aiming at a replaceable plant (grass/flower) places into that cell, swapping
    // the plant out; otherwise the block lands on the near face as usual.
    let cx = hit.nx, cy = hit.ny, cz = hit.nz;
    if (isReplaceable(world.getBlock(hit.x, hit.y, hit.z))) { cx = hit.x; cy = hit.y; cz = hit.z; }
    const existing = world.getBlock(cx, cy, cz);
    if (existing !== AIR && getBlock(existing).render !== "liquid" && !isReplaceable(existing)) return;
    const placed = getBlock(item.blockId);
    if (placed.solid && this.intersectsPlayer(cx, cy, cz, player)) return;

    // bit0 marks a player-placed leaf so it's exempt from natural leaf decay.
    const meta = placed.leaf ? 1 : this.placementMeta(placed.render, player, hit);

    // Beds occupy two horizontal cells (foot + head, extending away from the player).
    if (placed.render === "bed") {
      const f = this.facingOf(player);
      const [dx, dz] = BED_DIR[f];
      const hx = cx + dx, hz = cz + dz;
      const hExisting = world.getBlock(hx, cy, hz);
      if (hExisting !== AIR && getBlock(hExisting).render !== "liquid") return;
      if (this.intersectsPlayer(hx, cy, hz, player)) return;
      world.setBlock(cx, cy, cz, item.blockId, true, f);        // foot (bit2 = 0)
      world.setBlock(hx, cy, hz, item.blockId, true, f | 4);    // head (bit2 = 1)
      inventory.consumeSelected();
      sfx.blockPlace(placed, [cx + 0.5, cy + 0.5, cz + 0.5]);
      return;
    }

    // Doors occupy two stacked cells.
    if (placed.tall) {
      if (world.getBlock(cx, cy + 1, cz) !== AIR) return;
      if (this.intersectsPlayer(cx, cy + 1, cz, player)) return;
      world.setBlock(cx, cy, cz, item.blockId, true, meta);
      world.setBlock(cx, cy + 1, cz, item.blockId, true, meta | 2); // bit1 = upper
      inventory.consumeSelected();
      sfx.blockPlace(placed, [cx + 0.5, cy + 0.5, cz + 0.5]);
      return;
    }

    world.setBlock(cx, cy, cz, item.blockId, true, meta);
    inventory.consumeSelected();
    sfx.blockPlace(placed, [cx + 0.5, cy + 0.5, cz + 0.5]);
  }

  // Cardinal the player is facing: 0:+x 1:-x 2:+z 3:-z.
  facingOf(player) {
    const f = player.forward();
    if (Math.abs(f[0]) >= Math.abs(f[2])) return f[0] >= 0 ? 0 : 1;
    return f[2] >= 0 ? 2 : 3;
  }

  // Orientation/state metadata for a freshly placed shaped block.
  placementMeta(render, player, hit) {
    const f = this.facingOf(player);
    const fnx = hit.nx - hit.x, fny = hit.ny - hit.y, fnz = hit.nz - hit.z; // clicked-face normal
    // Where on the clicked cell the cursor landed: top half if we clicked the
    // underside of a block, or the upper half of a side face.
    const fracY = (hit.hpy != null ? hit.hpy : hit.y) - hit.y;
    const topHalf = fny === -1 || (fny === 0 && fracY > 0.5);
    if (render === "slab") return topHalf ? 1 : 0;
    if (render === "stair") return f | (topHalf ? 4 : 0);   // bit2 = upside-down
    if (render === "vslab") {
      if (fnx === 1) return 0; if (fnx === -1) return 1;     // hug the wall we clicked
      if (fnz === 1) return 2; if (fnz === -1) return 3;
      return [1, 0, 3, 2][f];                                // floor/ceiling -> face the player
    }
    if (render === "cross") {                                // torch: wall-mount faces into the room
      if (fnx === 1) return 1; if (fnx === -1) return 2;
      if (fnz === 1) return 3; if (fnz === -1) return 4;
      return 0;                                              // floor (standing)
    }
    if (render === "door") return f << 2;
    if (render === "trapdoor") {
      const top = fny === -1 ? 1 : 0;   // placed under a block -> hinge at top
      return (top << 1) | (f << 2);
    }
    if (render === "ladder") {
      if (fnx === -1) return 0; if (fnx === 1) return 1;   // hug the wall we clicked
      if (fnz === -1) return 2; if (fnz === 1) return 3;
      return f ^ 1;                                         // floor/ceiling -> wall behind
    }
    return 0;
  }

  intersectsPlayer(cx, cy, cz, player) {
    const p = player.pos;
    return (cx + 1 > p[0] - HW && cx < p[0] + HW &&
      cy + 1 > p[1] && cy < p[1] + H &&
      cz + 1 > p[2] - HW && cz < p[2] + HW);
  }
}
