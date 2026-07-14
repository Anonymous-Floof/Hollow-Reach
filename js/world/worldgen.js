// Deterministic world generation. Given (chunk, seed) it fills the chunk's
// voxels identically every time, so saves only need to store the seed plus the
// blocks the player changed.

import { Noise } from "./noise.js";
import { hash2i, hash3i } from "../core/prng.js";
import { CX, CZ, WH, localIdx } from "./chunk.js";
import { BLOCK, isLeaf } from "./blocks.js";

export const SEA_LEVEL = 46;

// Cache noise generators per seed (generate() is called for every chunk).
let cache = { seed: null };
function ensure(seed) {
  if (cache.seed !== seed) {
    cache = {
      seed,
      terrain: new Noise(seed),
      hills: new Noise(seed ^ 0x9e37),
      cave: new Noise(seed ^ 0x1b3f),
      cave2: new Noise(seed ^ 0x77d1),
      ore: new Noise(seed ^ 0x2c91),
      stonevar: new Noise(seed ^ 0x5a17),   // chooses umber/slate stone blobs
      flora: new Noise(seed ^ 0x0f10),      // moisture / meadow patchiness for foliage
    };
  }
  return cache;
}

// Surface height of the terrain column at world (wx, wz).
export function heightAt(seed, wx, wz) {
  const c = ensure(seed);
  const cont = c.terrain.fbm2(wx * 0.0055, wz * 0.0055, 4);     // broad continents
  const hills = c.hills.fbm2(wx * 0.021, wz * 0.021, 3) * 0.55; // local bumps
  let h = SEA_LEVEL + cont * 24 + hills * 14;
  h = Math.floor(h);
  if (h < 4) h = 4;
  if (h > WH - 14) h = WH - 14;
  return h;
}

// Ore vein lookup. Deepest/rarest checked first so they win ties. Higher
// `scale` = higher-frequency noise = smaller, more broken-up veins; higher
// `threshold` = a smaller fraction of cells qualify = rarer overall. Tuned so
// ore is a find, not a guarantee, and veins are a handful of blocks (not ~32).
// Densities (measured fraction of in-band cells that become this ore):
// embercoal ~1.2%, copper ~0.85%, ferralite ~0.55%, azurite ~0.47%,
// sunbrass ~0.30%, sparkstone ~0.22%, aetherite ~0.15%. The higher `scale`
// (vs. the original ~0.09) keeps veins small — a handful of blocks, not ~32.
const ORES = [
  { key: "ore_aetherite", yMin: 3,  yMax: 16, scale: 0.16, threshold: 0.69, s: [11, 0, 23] },
  { key: "ore_sparkstone", yMin: 3, yMax: 20, scale: 0.16, threshold: 0.67, s: [40, 5, 70] },
  { key: "ore_sunbrass",  yMin: 4,  yMax: 28, scale: 0.15, threshold: 0.65, s: [80, 9, 14] },
  { key: "ore_azurite",   yMin: 4,  yMax: 36, scale: 0.15, threshold: 0.63, s: [3, 50, 31] },
  { key: "ore_ferralite", yMin: 5,  yMax: 46, scale: 0.15, threshold: 0.62, s: [60, 22, 90] },
  { key: "ore_copper",    yMin: 6,  yMax: 60, scale: 0.14, threshold: 0.59, s: [17, 33, 5] },
  { key: "ore_embercoal", yMin: 8,  yMax: 84, scale: 0.14, threshold: 0.57, s: [99, 71, 41] },
];

function oreAt(c, wx, wy, wz) {
  for (const o of ORES) {
    if (wy < o.yMin || wy > o.yMax) continue;
    const n = c.ore.noise3((wx + o.s[0]) * o.scale, (wy + o.s[1]) * o.scale, (wz + o.s[2]) * o.scale);
    if (n > o.threshold) return BLOCK[o.key];
  }
  return BLOCK.greystone;
}

// Deep stone: an ore if one rolls here, otherwise a smooth-noise blob picks one
// of the stone variants (umber / slate) so the underground isn't all greystone.
function stoneAt(c, wx, wy, wz) {
  const base = oreAt(c, wx, wy, wz);
  if (base !== BLOCK.greystone) return base;          // ore wins the cell
  const n = c.stonevar.fbm3(wx * 0.02, wy * 0.02, wz * 0.02, 2);
  if (n > 0.3) return BLOCK.umberstone;
  if (n < -0.3) return BLOCK.slatestone;
  return BLOCK.greystone;
}

// Is this underground cell carved out into a cave?
function isCave(c, wx, wy, wz) {
  // blobby caverns
  const blob = c.cave.fbm3(wx * 0.045, wy * 0.06, wz * 0.045, 3);
  if (blob > 0.55) return true;
  // thin spaghetti tunnels (ridged noise)
  const t = Math.abs(c.cave2.noise3(wx * 0.05, wy * 0.07, wz * 0.05));
  if (t < 0.045) return true;
  return false;
}

export function generate(chunk, seed) {
  const c = ensure(seed);
  const v = chunk.voxels;
  const baseX = chunk.cx * CX, baseZ = chunk.cz * CZ;

  for (let z = 0; z < CZ; z++) {
    for (let x = 0; x < CX; x++) {
      const wx = baseX + x, wz = baseZ + z;
      const h = heightAt(seed, wx, wz);
      const beach = h <= SEA_LEVEL + 1;

      for (let y = 0; y < WH; y++) {
        let id = BLOCK.air;
        if (y < 2) {
          id = BLOCK.bedrock;
        } else if (y <= h) {
          const depth = h - y;
          if (beach) {
            id = depth <= 2 ? BLOCK.sand : (depth <= 4 ? BLOCK.sandstone : BLOCK.greystone);
          } else if (depth === 0) {
            id = BLOCK.turf;
          } else if (depth <= 3) {
            id = BLOCK.loam;
          } else {
            id = stoneAt(c, wx, y, wz);
          }
          // carve caves out of underground solid (not the very top, not bedrock)
          if (id !== BLOCK.bedrock && depth >= 1 && y > 2 && isCave(c, wx, y, wz)) {
            id = (y <= SEA_LEVEL && depth <= 2) ? id : BLOCK.air;
          }
        } else if (y <= SEA_LEVEL) {
          id = BLOCK.water;
        }
        v[localIdx(x, y, z)] = id;
      }
    }
  }

  stampTrees(chunk, seed);
  stampFoliage(chunk, seed);
  chunk.generated = true;
}

// Trees are stamped by scanning a 2-block margin around the chunk so canopies
// that originate just outside still appear seamlessly.
function treeAt(seed, wx, wz) {
  return hash2i(seed ^ 0x5eed, wx, wz) < 0.018;
}

function setIfInChunk(chunk, wx, wy, wz, id, force) {
  const lx = wx - chunk.cx * CX, lz = wz - chunk.cz * CZ;
  if (lx < 0 || lx >= CX || lz < 0 || lz >= CZ || wy < 0 || wy >= WH) return;
  const i = localIdx(lx, wy, lz);
  if (!force) {
    const cur = chunk.voxels[i];
    if (cur !== BLOCK.air && !isLeaf(cur)) return;
  }
  chunk.voxels[i] = id;
}

function stampTrees(chunk, seed) {
  const minX = chunk.cx * CX - 2, maxX = chunk.cx * CX + CX + 2;
  const minZ = chunk.cz * CZ - 2, maxZ = chunk.cz * CZ + CZ + 2;
  for (let wx = minX; wx < maxX; wx++) {
    for (let wz = minZ; wz < maxZ; wz++) {
      if (!treeAt(seed, wx, wz)) continue;
      const h = heightAt(seed, wx, wz);
      if (h <= SEA_LEVEL + 1) continue; // no trees on beaches / in water
      const height = 4 + Math.floor(hash2i(seed ^ 0xa11, wx, wz) * 3); // 4..6
      const topY = h + height;
      // pick a wood species for this tree (mostly alder, some pine / dusk)
      const wsel = hash2i(seed ^ 0xbeef, wx, wz);
      const logId = wsel < 0.15 ? BLOCK.pine_log : wsel < 0.3 ? BLOCK.dusk_log : BLOCK.log;
      const leafId = wsel < 0.15 ? BLOCK.pine_leaves : wsel < 0.3 ? BLOCK.dusk_leaves : BLOCK.leaves;
      // leaf canopy
      for (let dy = -2; dy <= 1; dy++) {
        const ly = topY + dy;
        const rad = dy >= 0 ? 1 : 2;
        for (let lx = -rad; lx <= rad; lx++) {
          for (let lz = -rad; lz <= rad; lz++) {
            if (dy < 0 && Math.abs(lx) === rad && Math.abs(lz) === rad &&
                hash3i(seed, wx + lx, ly, wz + lz) < 0.5) continue; // rounded corners
            setIfInChunk(chunk, wx + lx, ly, wz + lz, leafId, false);
          }
        }
      }
      // trunk (overwrites leaves)
      for (let t = 1; t <= height; t++) setIfInChunk(chunk, wx, h + t, wz, logId, true);
    }
  }
}

// ---------------------------------------------------------------------------
// Foliage & greebles: a light dusting of cross-billboard plants over the surface
// so the world reads as lived-in rather than bare. Purely per-column and inside
// the chunk (a plant is one cell, no cross-chunk overhang like tree canopies), so
// it stays deterministic and seamless. A low-frequency moisture field makes grass
// thick in wet hollows and sparse on dry rises; a second field carves out flower
// meadows; sand gets the odd dead bush. Runs after trees so it never grows inside
// a trunk (that cell is no longer air) and fills the gaps between them instead.
// ---------------------------------------------------------------------------
const FLOWERS = [
  BLOCK.flower_poppy, BLOCK.flower_daisy, BLOCK.flower_cornflower,
  BLOCK.flower_dandelion, BLOCK.flower_violet,
];

function pickFoliage(c, seed, wx, wz, ground) {
  const r = hash2i(seed ^ 0x0f0a, wx, wz);            // per-cell presence roll
  if (ground === BLOCK.sand) {
    if (r < 0.010) return BLOCK.dead_shrub;           // sparse desert/beach twigs
    if (r < 0.015) return BLOCK.pebbles;
    return 0;
  }
  if (ground !== BLOCK.turf) return 0;                // only grass grows plants

  const lush = 0.5 + c.flora.fbm2(wx * 0.012, wz * 0.012, 3) * 0.5;   // 0 dry .. 1 wet
  // Secondary rolls MUST offset their coordinates, not just tweak the seed: hash2i
  // barely avalanches a single seed-bit flip, so `hash2i(seed^A, wx, wz)` and
  // `hash2i(seed^B, wx, wz)` come out correlated. Shifting the coords decorrelates
  // them (otherwise the sub-type picks below track `r` and the tails never fire).
  // rare shade mushrooms in the wettest hollows
  if (lush > 0.62 && r < 0.006) {
    return hash2i(seed ^ 0x0f0f, wx + 53, wz + 199) < 0.5 ? BLOCK.mushroom_red : BLOCK.mushroom_brown;
  }
  // flower meadows: a coarse patch field gates them; each ~12-block region favours
  // one dominant bloom so beds read as coherent colour rather than confetti.
  const patch = c.flora.fbm2(wx * 0.05 + 40, wz * 0.05 - 25, 2);
  if (patch > 0.30 && r < 0.05) {
    const rk = hash2i(seed ^ 0x0f0d, Math.floor(wx / 12), Math.floor(wz / 12));
    const dominant = FLOWERS[(rk * FLOWERS.length) | 0];
    if (hash2i(seed ^ 0x0f0e, wx + 17, wz + 83) < 0.72) return dominant;
    return FLOWERS[(hash2i(seed ^ 0x0f0c, wx + 211, wz + 149) * FLOWERS.length) | 0];
  }
  // grasses: density tracks moisture; ferns favour wet ground, the odd shrub/pebble
  const grassChance = 0.08 + lush * 0.22;             // ~8% dry .. ~30% lush
  if (r < grassChance) {
    const t = hash2i(seed ^ 0x0f0b, wx + 101, wz + 57);
    if (lush > 0.6 && t < 0.18) return BLOCK.fern;
    if (t < 0.05) return BLOCK.bush;
    if (t > 0.985) return BLOCK.pebbles;
    return BLOCK.tall_grass;
  }
  return 0;
}

function stampFoliage(chunk, seed) {
  const c = ensure(seed);
  const baseX = chunk.cx * CX, baseZ = chunk.cz * CZ;
  for (let z = 0; z < CZ; z++) {
    for (let x = 0; x < CX; x++) {
      const wx = baseX + x, wz = baseZ + z;
      const h = heightAt(seed, wx, wz);
      if (h + 1 >= WH) continue;
      if (chunk.voxels[localIdx(x, h + 1, z)] !== BLOCK.air) continue;   // occupied (trunk/leaf/water)
      const ground = chunk.voxels[localIdx(x, h, z)];
      const plant = pickFoliage(c, seed, wx, wz, ground);
      if (plant) chunk.voxels[localIdx(x, h + 1, z)] = plant;
    }
  }
}
