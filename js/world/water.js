// Flowing-water cellular automaton (Minecraft-style). Water lives in the voxel
// grid as BLOCK.water; its *level* is carried in the per-cell metadata byte:
//
//   meta == 0           -> a SOURCE block (full, permanent, regenerates).
//   meta & FALLING (8)  -> water descending from above (rendered full, spreads
//                          sideways at the bottom as if it were a source).
//   meta & 7  (1..7)    -> a flowing level; 1 = nearly full, 7 = the thinnest
//                          film before it dries up.
//
// The sim is event-driven: cells are only re-evaluated when something near them
// changes (an edit, or a neighbouring water cell updating). Still oceans never
// tick. Each tick processes a bounded batch so a big spill can't stall a frame.
//
// Two forces drive convergence:
//   • recompute  — a flowing cell recomputes the level it *should* be from its
//                  neighbours; if nothing feeds it any more it dries up. This is
//                  what makes water recede when you remove its source.
//   • spread     — a settled water cell pushes water down (preferentially) and
//                  then outward into empty cells, one level thinner each step.
//
// Every change reschedules the touched cell's neighbours, so the field settles
// to a steady state and then goes quiet.

import { BLOCK, isSolid } from "./blocks.js";

export const FALLING = 8;     // meta bit3: this cell is a falling column
export const MAX_LEVEL = 7;   // thinnest flowing film; can't spread further
const DRY = -1;               // sentinel: cell should hold no water

const TICK = 0.16;            // seconds between water update batches (~6/s)
const MAX_UPDATES = 1200;     // cells processed per batch (rest carry over)

const HDIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class WaterSim {
  constructor(world) {
    this.world = world;
    this.queue = [];            // flat [x,y,z, x,y,z, ...] of cells to re-evaluate
    this.queued = new Set();    // dedupe key set, mirrors `queue`
    this.acc = 0;
  }

  _key(x, y, z) { return x + "," + y + "," + z; }

  schedule(x, y, z) {
    const k = this._key(x, y, z);
    if (this.queued.has(k)) return;
    this.queued.add(k);
    this.queue.push(x, y, z);
  }

  // Re-evaluate a cell and its six neighbours (called after any block change).
  onEdit(x, y, z) {
    this.schedule(x, y, z);
    this.schedule(x + 1, y, z); this.schedule(x - 1, y, z);
    this.schedule(x, y + 1, z); this.schedule(x, y - 1, z);
    this.schedule(x, y, z + 1); this.schedule(x, y, z - 1);
  }

  tick(dt) {
    this.acc += dt;
    if (this.acc < TICK) return;
    // process at most one batch per tick (don't try to catch up a huge backlog
    // in a single frame); leftover stays queued for following ticks.
    this.acc = Math.min(this.acc - TICK, TICK);

    const batch = this.queue;
    this.queue = [];
    this.queued = new Set();

    const limit = MAX_UPDATES * 3;
    let i = 0;
    for (; i < batch.length && i < limit; i += 3) this._process(batch[i], batch[i + 1], batch[i + 2]);
    // carry any overflow into the next batch
    for (; i < batch.length; i += 3) this.schedule(batch[i], batch[i + 1], batch[i + 2]);
  }

  _process(x, y, z) {
    const w = this.world;
    const id = w.getBlock(x, y, z);
    if (id !== BLOCK.water) return;   // only water cells own behaviour

    const meta = w.getMeta(x, y, z);
    const source = meta === 0;

    if (!source) {
      const nm = this._recompute(x, y, z);
      if (nm === DRY) { w.setWaterCell(x, y, z, BLOCK.air, 0); return; }
      if (nm !== meta) { w.setWaterCell(x, y, z, BLOCK.water, nm); return; }
    }
    // settled (a source, or flowing at the correct level): push water onward
    const falling = source || (meta & FALLING) !== 0;
    const level = source ? 0 : (meta & 7);
    this._spread(x, y, z, level, falling);
  }

  // The level a flowing cell should hold, given its neighbours (or DRY / 0=source).
  _recompute(x, y, z) {
    const w = this.world;
    if (w.getBlock(x, y + 1, z) === BLOCK.water) return FALLING;   // fed from above

    let minAdj = 99, srcCount = 0;
    for (const [dx, dz] of HDIRS) {
      if (w.getBlock(x + dx, y, z + dz) !== BLOCK.water) continue;
      const nm = w.getMeta(x + dx, y, z + dz);
      const nLevel = (nm === 0 || (nm & FALLING)) ? 0 : (nm & 7);   // source/falling act as full
      if (nm === 0) srcCount++;
      if (nLevel + 1 < minAdj) minAdj = nLevel + 1;
    }
    // two adjacent sources over solid ground merge into a new source ("infinite water")
    if (srcCount >= 2 && isSolid(w.getBlock(x, y - 1, z))) return 0;
    if (minAdj > MAX_LEVEL) return DRY;
    return minAdj;
  }

  // Push water from a settled cell: straight down if the cell below can accept it,
  // otherwise outward into empty/thinner neighbours, one level thinner per step.
  _spread(x, y, z, level, falling) {
    const w = this.world;

    // 1) descend — water prefers to fall, but only into a cell that can take more
    // water (open air, or a shallow flowing cell). Full water below (a source or
    // an existing falling column) can't accept any, so we fall through to spread
    // sideways — this is what lets sea-level sources creep onto adjacent shore.
    const belowId = w.getBlock(x, y - 1, z);
    if (belowId === BLOCK.air) {
      w.setWaterCell(x, y - 1, z, BLOCK.water, FALLING);
      return;
    }
    if (belowId === BLOCK.water) {
      const bm = w.getMeta(x, y - 1, z);
      if (bm !== 0 && bm !== FALLING) {            // a shallow flowing cell: deepen to a full column
        w.setWaterCell(x, y - 1, z, BLOCK.water, FALLING);
        return;
      }
      // else: source / already-falling below — can't descend, spread sideways
    }

    // 2) spread horizontally, one level thinner
    if (!falling && level >= MAX_LEVEL) return;   // too thin to continue
    const next = (falling ? 1 : level + 1) & 7;
    for (const [dx, dz] of HDIRS) {
      const nx = x + dx, nz = z + dz;
      const nId = w.getBlock(nx, y, nz);
      if (nId === BLOCK.air) {
        w.setWaterCell(nx, y, nz, BLOCK.water, next);
      } else if (nId === BLOCK.water) {
        const nm = w.getMeta(nx, y, nz);
        // deepen a thinner flowing neighbour (never touch sources / falling)
        if (nm !== 0 && !(nm & FALLING) && (nm & 7) > next) w.setWaterCell(nx, y, nz, BLOCK.water, next);
      }
    }
  }
}
