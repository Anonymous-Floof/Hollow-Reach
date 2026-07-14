// Chunk manager: streams chunks around the player, runs generation/lighting/
// meshing within a per-frame time budget, tracks player edits as deltas (for
// saving), and owns the GL mesh buffers.

import { Chunk, CX, CZ, WH, localIdx, chunkKey } from "./chunk.js";
import { generate, heightAt, SEA_LEVEL } from "./worldgen.js";
import { computeLight } from "./lighting.js";
import { meshChunk } from "./mesher.js";
import { BLOCK, isSolid, isOpaque, emitOf, isLeaf, isLog, getBlock as blockDef } from "./blocks.js";
import { SHAPED, collisionBoxes } from "./shapes.js";
import { GenPool } from "./genpool.js";
import { bePosKey, makeEntity, tickForge } from "../game/blockentities.js";
import { EntityManager } from "../game/entities/manager.js";
import { WaterSim, FALLING } from "./water.js";

const STRIDE = 9 * 4; // bytes per vertex (x,y,z,u,v,shade,sky,block,wave)
const GRASS_PER_DAY = 10; // ~grass blocks that spread per in-game day in the loaded area
const EMPTY_BOXES = [];   // shared "no collision" result (never mutated by callers)

export class World {
  constructor(gl, atlas, seed, renderDist = 8) {
    this.gl = gl;
    this.atlas = atlas;
    this.seed = seed >>> 0;
    this.renderDist = renderDist;
    this.chunks = new Map();      // key -> Chunk
    this.edits = new Map();       // key -> Map(localIndex -> blockId)  (player changes)
    this.pending = new Set();     // chunk keys handed to a worker, not back yet
    // Single-entry chunk memo: consecutive block reads overwhelmingly hit the
    // same chunk, and building a "cx,cz" string key per getBlock call was the
    // single biggest per-frame allocation source. Invalidated whenever the
    // chunks map changes (install/unload/dispose).
    this._mcx = NaN; this._mcz = NaN; this._mc = undefined;
    this._ringR = -1; this._ring = null;   // cached nearest-first stream offsets
    this._boxScratch = [[0, 0, 0, 0, 0, 0]]; // reused full-cube collision box
    this.blockEntities = new Map(); // "x,y,z" -> forge/chest state (persists across chunk reload)
    this.entities = new EntityManager(this); // live entities (item drops, future mobs/boats)
    this.water = new WaterSim(this);  // flowing-water automaton (see world/water.js)

    // ---- multiplayer hooks (inert in single-player) ----
    // netRole: null | "host" | "client". onNetEdit fires for every LOCAL edit
    // (setBlock isEdit / water-sim cell change) so the net layer can replicate
    // it; remote edits arrive through applyRemoteEdit, which never fires the
    // hook — that asymmetry is what prevents echo loops.
    this.netRole = null;
    this.onNetEdit = null;
    this.netCenters = null;   // extra [x,z] stream centres (remote players, host side)
    this._forceUnloadSweep = false;

    // Generation runs on worker threads so streaming never stutters the frame.
    // Falls back to synchronous main-thread generation if Workers are missing.
    this.pool = null;
    try {
      this.pool = new GenPool(this.seed, (data) => this._onGenerated(data));
    } catch (e) {
      console.warn("Generation workers unavailable — generating on main thread.", e);
      this.pool = null;
    }
  }

  // ---- block access (world coordinates) ----
  chunkAt(wx, wz) {
    const cx = Math.floor(wx / CX), cz = Math.floor(wz / CZ);
    if (cx === this._mcx && cz === this._mcz) return this._mc;
    const c = this.chunks.get(chunkKey(cx, cz));
    this._mcx = cx; this._mcz = cz; this._mc = c;
    return c;
  }
  _invalidateChunkMemo() { this._mcx = NaN; this._mc = undefined; }

  getBlock(wx, wy, wz) {
    if (wy < 0) return BLOCK.bedrock;   // solid floor below the world
    if (wy >= WH) return BLOCK.air;
    const c = this.chunkAt(wx, wz);
    if (!c) return BLOCK.air;
    const lx = wx - c.cx * CX, lz = wz - c.cz * CZ;
    return c.voxels[localIdx(lx, wy, lz)];
  }
  getSky(wx, wy, wz) {
    if (wy < 0) return 0;
    if (wy >= WH) return 15;
    const c = this.chunkAt(wx, wz);
    if (!c) return 15;
    const lx = wx - c.cx * CX, lz = wz - c.cz * CZ;
    return c.skylight[localIdx(lx, wy, lz)];
  }
  getBlockLight(wx, wy, wz) {
    if (wy < 0 || wy >= WH) return 0;
    const c = this.chunkAt(wx, wz);
    if (!c) return 0;
    const lx = wx - c.cx * CX, lz = wz - c.cz * CZ;
    return c.blocklight[localIdx(lx, wy, lz)];
  }
  // Light samplers used by the lighting border-seeder. These must return 0 for
  // an *unknown* neighbour chunk (contribute no phantom light) — unlike getSky,
  // which assumes open sky for unloaded columns during meshing.
  getBlockLightWorld(wx, wy, wz) { return this.getBlockLight(wx, wy, wz); }
  getSkyWorld(wx, wy, wz) {
    if (wy < 0) return 0;
    if (wy >= WH) return 15;
    const c = this.chunkAt(wx, wz);
    if (!c) return 0;
    const lx = wx - c.cx * CX, lz = wz - c.cz * CZ;
    return c.skylight[localIdx(lx, wy, lz)];
  }

  solidAt(wx, wy, wz) { return isSolid(this.getBlock(Math.floor(wx), Math.floor(wy), Math.floor(wz))); }

  // World-space collision AABBs for the block at a cell. Full cube for normal
  // solids, custom boxes for shaped blocks, none for air/water/cross/ladders.
  // NOTE: the full-cube (and below-world) result is a REUSED scratch array —
  // valid until the next collisionBoxesAt call. Callers (physics sweeps) iterate
  // it immediately and never retain it.
  collisionBoxesAt(wx, wy, wz) {
    if (wy >= WH) return EMPTY_BOXES;
    if (wy >= 0) {
      const b = blockDef(this.getBlock(wx, wy, wz));
      if (!b || !b.solid) return EMPTY_BOXES;
      if (SHAPED.has(b.render)) {
        const meta = this.getMeta(wx, wy, wz);
        return collisionBoxes(b.render, meta).map((q) => [wx + q[0], wy + q[1], wz + q[2], wx + q[3], wy + q[4], wz + q[5]]);
      }
    }
    const q = this._boxScratch[0];   // full cube (or the solid floor below y=0)
    q[0] = wx; q[1] = wy; q[2] = wz; q[3] = wx + 1; q[4] = wy + 1; q[5] = wz + 1;
    return this._boxScratch;
  }
  isClimbable(wx, wy, wz) {
    const b = blockDef(this.getBlock(Math.floor(wx), Math.floor(wy), Math.floor(wz)));
    return !!(b && b.climb);
  }

  // ---- block entities (forge / chest state) ----
  getBlockEntity(wx, wy, wz) { return this.blockEntities.get(bePosKey(wx, wy, wz)); }
  getOrCreateBlockEntity(wx, wy, wz, kind) {
    const k = bePosKey(wx, wy, wz);
    let be = this.blockEntities.get(k);
    if (!be) { be = makeEntity(kind); if (be) this.blockEntities.set(k, be); }
    return be;
  }
  removeBlockEntity(wx, wy, wz) { this.blockEntities.delete(bePosKey(wx, wy, wz)); }
  // Advance all forges every frame so they smelt with the UI closed.
  // _beFrozen (set by the multiplayer host) pauses forges a guest has open, so
  // their slot edits are authoritative while they hold the lock — no host-side
  // smelting can race a stale slot update into a dupe.
  tickBlockEntities(dt) {
    for (const [k, be] of this.blockEntities) {
      if (be.kind !== "forge") continue;
      if (this._beFrozen && this._beFrozen.has(k)) continue;
      tickForge(be, dt);
    }
  }
  tickEntities(dt, ctx) { this.entities.tick(dt, ctx); }

  // Grass spread: exposed, lit loam next to turf slowly turns to turf. Driven by
  // in-game time (days elapsed, including a bed's fast-forward) rather than wall
  // clock, so sleeping a night advances it just like real time would. Spread is
  // limited to a radius around the player (where it's visible) and to a handful
  // of blocks per in-game day, so it creeps rather than floods.
  spreadGrass(days, px, pz) {
    if (!(days > 0) || this.chunks.size === 0) return;
    this._grassBudget = (this._grassBudget || 0) + days * GRASS_PER_DAY;
    if (this._grassBudget < 1) return;

    // Rejection-sample random nearby columns for eligible loam cells instead of
    // scanning the whole (2R+1)^2 area (the old full scan spiked a frame every
    // time the budget crossed 1). Eligible cells are common when grass has
    // anywhere to creep, so a few hundred tries finds them; when they're rare
    // the budget just carries over (capped) and the creep pace is the same.
    const R = 28;
    const bx = Math.floor(px), bz = Math.floor(pz);
    let n = Math.floor(this._grassBudget);
    let tries = 200 + 120 * n;
    while (n > 0 && tries-- > 0) {
      const x = bx + ((Math.random() * (2 * R + 1)) | 0) - R;
      const z = bz + ((Math.random() * (2 * R + 1)) | 0) - R;
      const y = this._grassSpreadY(x, z);
      if (y < 0) continue;
      this.setBlock(x, y, z, BLOCK.turf, true);
      this._grassBudget -= 1;
      n--;
    }
    if (this._grassBudget > GRASS_PER_DAY) this._grassBudget = GRASS_PER_DAY;   // don't hoard
  }

  // y of an exposed, lit loam cell at the top of column (wx,wz) that has a turf
  // neighbour (so grass can creep onto it), or -1 if not eligible.
  _grassSpreadY(wx, wz) {
    const c = this.chunkAt(wx, wz);
    if (!c) return -1;
    const lx = wx - c.cx * CX, lz = wz - c.cz * CZ;
    let y = -1;
    for (let yy = WH - 1; yy >= 1; yy--) if (isSolid(c.voxels[localIdx(lx, yy, lz)])) { y = yy; break; }
    if (y < 1 || c.voxels[localIdx(lx, y, lz)] !== BLOCK.loam) return -1;
    const above = this.getBlock(wx, y + 1, wz);
    if (isOpaque(above) || above === BLOCK.water) return -1;            // open to the surface
    if (this.getSky(wx, y + 1, wz) < 8 && this.getBlockLight(wx, y + 1, wz) < 8) return -1; // lit
    return this._turfNearby(wx, y, wz) ? y : -1;
  }

  _turfNearby(wx, wy, wz) {
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dz === 0) continue;
          if (this.getBlock(wx + dx, wy + dy, wz + dz) === BLOCK.turf) return true;
        }
    return false;
  }

  // y of the topmost solid block in a column (the ground surface), or -1.
  topSolidY(wx, wz) {
    const c = this.chunkAt(wx, wz);
    if (!c) return -1;
    const lx = wx - c.cx * CX, lz = wz - c.cz * CZ;
    for (let y = WH - 1; y >= 1; y--) if (isSolid(c.voxels[localIdx(lx, y, lz)])) return y;
    return -1;
  }

  // Occasionally spawn a passive grazer (sheep/pig) on grass near the player, in
  // daylight, under a per-type cap. Called on a timer from the main loop.
  trySpawnGrazer(type, px, pz, dayFactor, cap = 8) {
    if (dayFactor < 0.4 || Math.random() > 0.5) return;
    let n = 0;
    for (const e of this.entities.entities) if (e.type === type && !e.dead) n++;
    if (n >= cap) return;
    for (let t = 0; t < 12; t++) {
      const ang = Math.random() * Math.PI * 2, dist = 16 + Math.random() * 16;
      const wx = Math.floor(px + Math.cos(ang) * dist), wz = Math.floor(pz + Math.sin(ang) * dist);
      const ts = this.topSolidY(wx, wz);
      if (ts < 0 || this.getBlock(wx, ts, wz) !== BLOCK.turf) continue;
      if (this.getBlock(wx, ts + 1, wz) !== 0 || this.getBlock(wx, ts + 2, wz) !== 0) continue;
      this.entities.spawn(type, [wx + 0.5, ts + 1, wz + 0.5], {});
      return;
    }
  }
  trySpawnSheep(px, pz, dayFactor) { this.trySpawnGrazer("sheep", px, pz, dayFactor, 8); }
  trySpawnPig(px, pz, dayFactor) { this.trySpawnGrazer("pig", px, pz, dayFactor, 6); }

  // Occasionally spawn a zombie on solid ground near the player at night, capped.
  // Spawns on any walkable surface (not just grass) and never on/in water.
  trySpawnZombie(px, pz, dayFactor) {
    if (dayFactor > 0.35 || Math.random() > 0.5) return;
    let n = 0;
    for (const e of this.entities.entities) if (e.type === "zombie" && !e.dead) n++;
    if (n >= 6) return;
    for (let t = 0; t < 12; t++) {
      const ang = Math.random() * Math.PI * 2, dist = 20 + Math.random() * 20;
      const wx = Math.floor(px + Math.cos(ang) * dist), wz = Math.floor(pz + Math.sin(ang) * dist);
      const ts = this.topSolidY(wx, wz);
      if (ts < 0 || this.getBlock(wx, ts, wz) === BLOCK.water) continue;
      if (this.getBlock(wx, ts + 1, wz) !== 0 || this.getBlock(wx, ts + 2, wz) !== 0) continue;
      this.entities.spawn("zombie", [wx + 0.5, ts + 1, wz + 0.5], {});
      return;
    }
  }

  // Mined block / spilled container -> an instant-collect drop (small pop).
  spawnDrop(wx, wy, wz, key, count = 1, dura) {
    const e = this.entities.spawn("drop", [wx, wy, wz], { key, count, dura, instant: true });
    if (e) e.vel = [(Math.random() - 0.5) * 2, 2.2, (Math.random() - 0.5) * 2];
    return e;
  }

  // Place a rideable boat (from using a boat item).
  spawnBoat(wx, wy, wz) { return this.entities.spawn("boat", [wx, wy, wz], {}); }

  // Player-tossed / death drop -> proximity pickup, thrown along `dir`.
  spawnTossed(wx, wy, wz, dir, key, count = 1, dura) {
    const e = this.entities.spawn("drop", [wx, wy, wz], { key, count, dura, instant: false });
    if (e) e.vel = [dir[0] * 5 + (Math.random() - 0.5), 3 + dir[1] * 3, dir[2] * 5 + (Math.random() - 0.5)];
    return e;
  }

  // ---- metadata (orientation / state for shaped blocks) ----
  getMeta(wx, wy, wz) {
    if (wy < 0 || wy >= WH) return 0;
    const c = this.chunkAt(wx, wz);
    if (!c) return 0;
    const lx = wx - c.cx * CX, lz = wz - c.cz * CZ;
    return c.meta[localIdx(lx, wy, lz)];
  }
  // Change only metadata (e.g. toggling a door/trapdoor) without changing the id.
  setMeta(wx, wy, wz, meta) {
    const cx = Math.floor(wx / CX), cz = Math.floor(wz / CZ);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return;
    const lx = wx - cx * CX, lz = wz - cz * CZ;
    this.setBlock(wx, wy, wz, c.voxels[localIdx(lx, wy, lz)], true, meta);
  }

  // ---- edits ----
  // `meta` is the per-cell metadata byte; edits store id|(meta<<10) so a single
  // map carries both (ids use the low 10 bits — far more than enough).
  setBlock(wx, wy, wz, id, isEdit = true, meta = 0) {
    if (wy < 0 || wy >= WH) return;
    const cx = Math.floor(wx / CX), cz = Math.floor(wz / CZ);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return;
    const lx = wx - cx * CX, lz = wz - cz * CZ;
    const li = localIdx(lx, wy, lz);
    const prevId = c.voxels[li];
    c.voxels[li] = id;
    c.meta[li] = meta;
    if (isEdit) {
      const k = chunkKey(cx, cz);
      let m = this.edits.get(k);
      if (!m) { m = new Map(); this.edits.set(k, m); }
      m.set(li, id | (meta << 10));
      if (this.onNetEdit) this.onNetEdit(wx, wy, wz, id, meta);
    }
    // re-light + re-mesh this chunk and any neighbour sharing the touched border
    this._dirty(cx, cz);
    if (lx === 0) this._dirty(cx - 1, cz);
    if (lx === CX - 1) this._dirty(cx + 1, cz);
    if (lz === 0) this._dirty(cx, cz - 1);
    if (lz === CZ - 1) this._dirty(cx, cz + 1);

    // A light emitter (torch / glowing ore) reaches well past the touched
    // border, so re-light the whole 3x3 chunk neighbourhood when one is placed
    // or removed — otherwise its glow stops dead at the chunk edge until a later
    // edit nudges the neighbour. (computeLight rebuilds from scratch, so this
    // also correctly clears the glow when a torch is mined.)
    if (emitOf(prevId) > 0 || emitOf(id) > 0) {
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++)
          if (dx || dz) this._dirty(cx + dx, cz + dz);
    }

    // let water flow react to the change (a block removed beside the sea, etc.)
    if (this.water) this.water.onEdit(wx, wy, wz);
  }

  // Fast path for the water sim: change a cell's id+meta and remesh it WITHOUT a
  // relight. Air<->water never changes opacity or emitted light, so the baked
  // light the mesh samples is unaffected — only geometry changes. The change is
  // recorded as an edit (so a spill persists and can later recede) and reschedules
  // the surrounding cells.
  setWaterCell(wx, wy, wz, id, meta) {
    if (wy < 0 || wy >= WH) return;
    const cx = Math.floor(wx / CX), cz = Math.floor(wz / CZ);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return;
    const lx = wx - cx * CX, lz = wz - cz * CZ;
    const li = localIdx(lx, wy, lz);
    if (c.voxels[li] === id && c.meta[li] === meta) return;   // no-op
    c.voxels[li] = id;
    c.meta[li] = meta;
    const k = chunkKey(cx, cz);
    let m = this.edits.get(k);
    if (!m) { m = new Map(); this.edits.set(k, m); }
    m.set(li, id | (meta << 10));
    if (this.onNetEdit) this.onNetEdit(wx, wy, wz, id, meta);
    this._dirtyMesh(cx, cz);
    if (lx === 0) this._dirtyMesh(cx - 1, cz);
    if (lx === CX - 1) this._dirtyMesh(cx + 1, cz);
    if (lz === 0) this._dirtyMesh(cx, cz - 1);
    if (lz === CZ - 1) this._dirtyMesh(cx, cz + 1);
    this.water.onEdit(wx, wy, wz);
  }

  // Apply an edit that arrived over the network (authoritative for clients,
  // pre-validated for hosts). Never fires onNetEdit. Always records into the
  // edits map, so it lands correctly even when the chunk isn't generated yet
  // (_installChunk re-applies edits on load).
  applyRemoteEdit(wx, wy, wz, id, meta = 0) {
    if (wy < 0 || wy >= WH) return;
    const cx = Math.floor(wx / CX), cz = Math.floor(wz / CZ);
    const k = chunkKey(cx, cz);
    const lx = wx - cx * CX, lz = wz - cz * CZ;
    const li = localIdx(lx, wy, lz);
    let m = this.edits.get(k);
    if (!m) { m = new Map(); this.edits.set(k, m); }
    m.set(li, id | (meta << 10));
    const c = this.chunks.get(k);
    if (!c) return;                      // will apply when the chunk generates
    const prevId = c.voxels[li];
    if (prevId === id && c.meta[li] === meta) return;
    c.voxels[li] = id;
    c.meta[li] = meta;
    this._dirty(cx, cz);
    if (lx === 0) this._dirty(cx - 1, cz);
    if (lx === CX - 1) this._dirty(cx + 1, cz);
    if (lz === 0) this._dirty(cx, cz - 1);
    if (lz === CZ - 1) this._dirty(cx, cz + 1);
    if (emitOf(prevId) > 0 || emitOf(id) > 0) {
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++)
          if (dx || dz) this._dirty(cx + dx, cz + dz);
    }
    // only the authoritative simulation reacts with flow — clients just display
    if (this.water && this.netRole === "host") this.water.onEdit(wx, wy, wz);
  }

  tickWater(dt) { if (this.water) this.water.tick(dt); }

  // Visible surface height (0..1) of a water cell; 0 for non-water.
  fluidHeight(wx, wy, wz) {
    if (this.getBlock(wx, wy, wz) !== BLOCK.water) return 0;
    if (this.getBlock(wx, wy + 1, wz) === BLOCK.water) return 1.0;   // submerged: full column
    const m = this.getMeta(wx, wy, wz);
    if (m === 0 || (m & FALLING)) return 0.875;                      // source / falling
    return (8 - (m & 7)) / 9;                                        // flowing 1..7
  }

  // Horizontal flow vector [fx,fz] at a water cell: points downstream (from full
  // water toward thinner water, open edges, and drops). Magnitude grows with the
  // height gradient. Used to shove the player and floating entities along.
  waterFlow(wx, wy, wz) {
    if (this.getBlock(wx, wy, wz) !== BLOCK.water) return [0, 0];
    const h = this.fluidHeight(wx, wy, wz);
    let fx = 0, fz = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = wx + dx, nz = wz + dz;
      const nId = this.getBlock(nx, wy, nz);
      if (nId === BLOCK.water) {
        let nh = this.fluidHeight(nx, wy, nz);
        if (this.getBlock(nx, wy - 1, nz) === BLOCK.air) nh = 0;     // it can fall away -> a sink
        fx += dx * (h - nh); fz += dz * (h - nh);
      } else if (nId === BLOCK.air) {
        const w = this.getBlock(nx, wy - 1, nz) === BLOCK.air ? h : h * 0.5;
        fx += dx * w; fz += dz * w;                                  // spill toward the opening
      }
    }
    return [fx, fz];
  }

  _dirty(cx, cz) {
    const c = this.chunks.get(chunkKey(cx, cz));
    if (c) { c.meshDirty = true; c.lightDirty = true; }
  }

  _dirtyMesh(cx, cz) {
    const c = this.chunks.get(chunkKey(cx, cz));
    if (c) c.meshDirty = true;
  }

  // Leaf decay: after a log is removed, any *natural* leaf that's no longer
  // within LEAF_SUPPORT blocks (through other leaves) of a log dissolves. Leaves
  // flagged persistent in metadata (placed by the player) never decay.
  decayLeavesAround(wx, wy, wz) {
    const SUP = 4;           // survives within 4 leaf-steps of a log
    const CR = 5;            // re-check leaves within this radius of the change
    const SR = CR + SUP;     // logs this far out can still support those leaves
    const NB = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

    // Multi-source BFS of "support distance" from every nearby log, through leaves.
    const dist = new Map();
    const q = [];
    for (let dx = -SR; dx <= SR; dx++)
      for (let dy = -SR; dy <= SR; dy++)
        for (let dz = -SR; dz <= SR; dz++) {
          const x = wx + dx, y = wy + dy, z = wz + dz;
          if (isLog(this.getBlock(x, y, z))) { dist.set(x + "," + y + "," + z, 0); q.push(x, y, z, 0); }
        }
    for (let h = 0; h < q.length; h += 4) {
      const x = q[h], y = q[h + 1], z = q[h + 2], d = q[h + 3];
      if (d >= SUP) continue;
      for (const [ax, ay, az] of NB) {
        const nx = x + ax, ny = y + ay, nz = z + az, k = nx + "," + ny + "," + nz;
        if (dist.has(k)) continue;
        if (!isLeaf(this.getBlock(nx, ny, nz))) continue;
        dist.set(k, d + 1); q.push(nx, ny, nz, d + 1);
      }
    }
    // Dissolve unsupported natural leaves in the inner region.
    for (let dx = -CR; dx <= CR; dx++)
      for (let dy = -CR; dy <= CR; dy++)
        for (let dz = -CR; dz <= CR; dz++) {
          const x = wx + dx, y = wy + dy, z = wz + dz;
          if (!isLeaf(this.getBlock(x, y, z))) continue;
          if (this.getMeta(x, y, z) & 1) continue;             // player-placed -> permanent
          if (!dist.has(x + "," + y + "," + z)) this.setBlock(x, y, z, BLOCK.air, true);
        }
  }

  // ---- generation / streaming ----
  // Wrap raw voxels in a Chunk, re-apply the player's saved edits, register it,
  // and flag neighbours for a re-mesh (their border faces may now be exposed).
  _installChunk(cx, cz, voxels) {
    const key = chunkKey(cx, cz);
    if (this.chunks.has(key)) return this.chunks.get(key);
    const c = new Chunk(cx, cz);
    c.voxels.set(voxels);
    c.generated = true;
    const m = this.edits.get(key);
    if (m) for (const [li, packed] of m) { c.voxels[li] = packed & 1023; c.meta[li] = (packed >> 10) & 0x3f; }
    this.chunks.set(key, c);
    this._invalidateChunkMemo();   // the memo may hold "missing" for this slot
    this._streamScan = true;       // new chunk: keep the generation scan alive
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) this._dirty(cx + dx, cz + dz);
    return c;
  }

  // Synchronous generation — used for the spawn area so the player never falls
  // through before a worker reply arrives.
  generateChunkSync(cx, cz) {
    const voxels = new Uint16Array(CX * WH * CZ);
    generate({ cx, cz, voxels }, this.seed);
    return this._installChunk(cx, cz, voxels);
  }

  // Hand a chunk to a worker (or generate inline if the pool is unavailable).
  requestChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    if (this.chunks.has(key) || this.pending.has(key)) return;
    if (!this.pool) { this.generateChunkSync(cx, cz); return; }
    this.pending.add(key);
    this.pool.request(cx, cz);
  }

  _onGenerated({ cx, cz, voxels }) {
    const key = chunkKey(cx, cz);
    this.pending.delete(key);
    if (this.chunks.has(key)) return;  // already primed synchronously
    this._installChunk(cx, cz, voxels);
  }

  // Mark already-built neighbour chunks for a re-mesh so they pick up this
  // chunk's freshly-computed border light (without re-lighting them).
  _remeshLitNeighbors(cx, cz) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const c = this.chunks.get(chunkKey(cx + dx, cz + dz));
      if (c && !c.meshDirty && !c.lightDirty) c.meshDirty = true;
    }
  }

  neighborsReady(cx, cz) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (!this.chunks.has(chunkKey(cx + dx, cz + dz))) return false;
    }
    return true;
  }

  // Generate the spawn area synchronously so the player never falls through.
  primeSpawn(wx, wz) {
    const pcx = Math.floor(wx / CX), pcz = Math.floor(wz / CZ);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        if (!this.chunks.has(chunkKey(pcx + dx, pcz + dz))) this.generateChunkSync(pcx + dx, pcz + dz);
    const c = this.chunks.get(chunkKey(pcx, pcz));
    if (c) { computeLight(c, this); this.buildMesh(c); }
  }

  spawnHeight(wx, wz) {
    return Math.max(heightAt(this.seed, wx, wz), SEA_LEVEL) + 2;
  }

  // Synchronously generate + light + mesh a full RxR chunk region around (wx,wz).
  // Used once at first boot to bake the default menu panorama without waiting on
  // the async worker stream. Blocks briefly (behind the boot screen) — not for
  // per-frame use. Gen a 1-chunk-wider ring so the meshed edge samples real
  // neighbour voxels + light.
  primeArea(wx, wz, R) {
    const pcx = Math.floor(wx / CX), pcz = Math.floor(wz / CZ), G = R + 1;
    for (let dz = -G; dz <= G; dz++)
      for (let dx = -G; dx <= G; dx++)
        if (!this.chunks.has(chunkKey(pcx + dx, pcz + dz))) this.generateChunkSync(pcx + dx, pcz + dz);
    for (let dz = -G; dz <= G; dz++)
      for (let dx = -G; dx <= G; dx++) {
        const c = this.chunks.get(chunkKey(pcx + dx, pcz + dz));
        if (c && c.lightDirty) computeLight(c, this);
      }
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        const c = this.chunks.get(chunkKey(pcx + dx, pcz + dz));
        if (c && c.meshDirty) this.buildMesh(c);
      }
  }

  // Nearest-first ring of chunk offsets for a render distance, cached (the old
  // code rebuilt + sorted this array of ~200-2000 entries every frame).
  _ringOffsets(R) {
    if (this._ringR === R) return this._ring;
    const list = [];
    const r2 = (R + 0.5) * (R + 0.5);
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        const d = dx * dx + dz * dz;
        if (d <= r2) list.push([dx, dz, d]);
      }
    list.sort((a, b) => a[2] - b[2]);
    const flat = new Int16Array(list.length * 2);
    for (let i = 0; i < list.length; i++) { flat[i * 2] = list[i][0]; flat[i * 2 + 1] = list[i][1]; }
    this._ringR = R;
    this._ring = flat;
    return flat;
  }

  // Per-frame streaming. Generation is dispatched to worker threads (cheap to
  // queue). Lighting + meshing run on the main thread under a per-frame TIME
  // budget (ms) rather than a chunk count, so one heavy chunk can never blow the
  // frame: we always finish the chunk we started, then stop once over budget.
  update(px, pz, maxGen = 6, buildMs = 6) {
    const R = this.renderDist;
    const pcx = Math.floor(px / CX), pcz = Math.floor(pz / CZ);
    const offs = this._ringOffsets(R);
    const n = offs.length;

    // Generation scan: only while chunks in range might be missing — after a
    // chunk-boundary crossing / render-distance change, and then each frame
    // until a full pass finds every wanted chunk present.
    if (this._streamScan !== false || pcx !== this._spcx || pcz !== this._spcz || R !== this._sR) {
      this._spcx = pcx; this._spcz = pcz; this._sR = R;
      let gen = 0, missing = false;
      for (let i = 0; i < n; i += 2) {
        const cx = pcx + offs[i], cz = pcz + offs[i + 1];
        const key = chunkKey(cx, cz);
        if (this.chunks.has(key)) continue;
        missing = true;
        if (this.pending.has(key)) continue;
        this.requestChunk(cx, cz);
        if (++gen >= maxGen) break;
      }
      this._streamScan = missing;
    }

    const deadline = performance.now() + buildMs;
    for (let i = 0; i < n; i += 2) {
      const c = this.chunks.get(chunkKey(pcx + offs[i], pcz + offs[i + 1]));
      // cheap flag reads first — at steady state this loop is just map lookups
      if (!c || (!c.lightDirty && !c.meshDirty)) continue;
      if (!this.neighborsReady(c.cx, c.cz)) continue;
      if (c.lightDirty) {
        computeLight(c, this);
        // A chunk's faces sample light from the neighbouring cell they look into,
        // so when THIS chunk's light changes, already-built neighbours have stale
        // (often black) border faces. Re-mesh them. This is what fixes the random
        // black faces and torches that "needed a nudge" to light across borders.
        this._remeshLitNeighbors(c.cx, c.cz);
      } else this.buildMesh(c);
      if (performance.now() >= deadline) break;
    }

    // Host side: keep a small simulation bubble generated around every remote
    // player so their edits/mobs/physics run on real voxels even when they're
    // far from the host. (Not lit or meshed — the host never renders it.)
    if (this.netCenters) {
      for (let ci = 0; ci < this.netCenters.length; ci++) {
        const ncx = Math.floor(this.netCenters[ci][0] / CX), ncz = Math.floor(this.netCenters[ci][1] / CZ);
        for (let dz = -3; dz <= 3; dz++)
          for (let dx = -3; dx <= 3; dx++) {
            const key = chunkKey(ncx + dx, ncz + dz);
            if (!this.chunks.has(key) && !this.pending.has(key)) this.requestChunk(ncx + dx, ncz + dz);
          }
      }
    }

    // chunks only fall out of range when the player crosses a chunk boundary
    // (or the render distance shrinks) — no need to sweep the map every frame
    if (pcx !== this._upcx || pcz !== this._upcz || R !== this._uR || this._forceUnloadSweep) {
      this._upcx = pcx; this._upcz = pcz; this._uR = R;
      this._forceUnloadSweep = false;
      this.unloadFar(pcx, pcz, R + 2);
    }
  }

  unloadFar(pcx, pcz, maxR) {
    const centers = this.netCenters;
    for (const c of this.chunks.values()) {
      if (Math.abs(c.cx - pcx) > maxR || Math.abs(c.cz - pcz) > maxR) {
        // spare chunks inside any remote player's simulation bubble
        if (centers) {
          let near = false;
          for (let i = 0; i < centers.length && !near; i++) {
            near = Math.abs(c.cx - Math.floor(centers[i][0] / CX)) <= 5 &&
                   Math.abs(c.cz - Math.floor(centers[i][1] / CZ)) <= 5;
          }
          if (near) continue;
        }
        this._freeMesh(c.meshOpaque); this._freeMesh(c.meshWater);
        this.chunks.delete(chunkKey(c.cx, c.cz));
        this._invalidateChunkMemo();
      }
    }
  }

  // ---- GL mesh building ----
  buildMesh(c) {
    const { opaque, water } = meshChunk(c, this, this.atlas);
    this._freeMesh(c.meshOpaque); this._freeMesh(c.meshWater);
    c.meshOpaque = this._makeMesh(opaque);
    c.meshWater = this._makeMesh(water);
    c.meshDirty = false;
  }

  _makeMesh(data) {
    if (!data.length) return null;
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 20);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE, 24);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, STRIDE, 28);
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 1, gl.FLOAT, false, STRIDE, 32);
    gl.bindVertexArray(null);
    return { vao, vbo, count: data.length / 9 };
  }

  _freeMesh(m) {
    if (!m) return;
    this.gl.deleteVertexArray(m.vao);
    this.gl.deleteBuffer(m.vbo);
  }

  dispose() {
    if (this.pool) { this.pool.dispose(); this.pool = null; }
    this.pending.clear();
    this.blockEntities.clear();
    this.entities.clear();
    for (const c of this.chunks.values()) { this._freeMesh(c.meshOpaque); this._freeMesh(c.meshWater); }
    this.chunks.clear();
    this._invalidateChunkMemo();
  }
}
