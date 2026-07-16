// Deterministic world generation. Given (chunk, seed) it fills the chunk's
// voxels identically every time, so saves only need to store the seed plus the
// blocks the player changed.
//
// GENERATION IS VERSIONED. Saves record the generator version they were created
// with, and every public function takes `ver` (defaulting to the newest). v1 is
// the original meadow-only generator; v2 adds climate-driven biomes (desert /
// snowfield / forest / birch grove / palm coasts), ridged mountains, ravines,
// flooded deep caverns, gravel/dirt pockets and shoreline papyrus. Old worlds
// keep generating with v1 so their terrain never shifts under player builds.

import { Noise } from "./noise.js";
import { hash2i, hash3i } from "../core/prng.js";
import { CX, CZ, WH, localIdx } from "./chunk.js";
import { BLOCK, isLeaf, isReplaceable } from "./blocks.js";

export const SEA_LEVEL = 46;
export const GEN_VERSION = 2;

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
      // ---- v2 fields ----
      temp: new Noise(seed ^ 0x3c5a),       // climate temperature
      moist: new Noise(seed ^ 0x66b1),      // climate moisture
      mount: new Noise(seed ^ 0x14e9),      // where mountain ranges live (mask)
      ridge: new Noise(seed ^ 0x7f23),      // ridged peaks inside the mask
      ravine: new Noise(seed ^ 0x2ba7),     // thin surface canyons
    };
  }
  return cache;
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Climate & biomes (v2). Two low-frequency fields — temperature and moisture —
// partition the surface. Each biome changes ground cover, tree species/density
// and relief; underground is shared.
// ---------------------------------------------------------------------------
export const BIOME = { MEADOW: 0, FOREST: 1, BIRCH: 2, DESERT: 3, SNOW: 4 };
export const BIOME_NAMES = ["Meadow", "Forest", "Birch Grove", "Desert", "Snowfield"];

// Low frequency on purpose: base wavelength ~800 blocks, so a biome reads as a
// REGION you travel to, not confetti. Two octaves keep borders a little wobbly.
function climateT(c, wx, wz) { return c.temp.fbm2(wx * 0.0012, wz * 0.0012, 2); }
function climateM(c, wx, wz) { return c.moist.fbm2(wx * 0.0014 + 37, wz * 0.0014 - 11, 2); }

// Thresholds tuned to the measured field distribution (3-octave fbm here runs
// roughly ±0.26 at the 10th/90th percentile — NOT ±1), so every biome actually
// shows up: snow ~8%, desert ~7%, birch ~10%, forest ~15%, meadow the rest.
function biomeOf(T, M) {
  if (T < -0.30) return BIOME.SNOW;
  if (T > 0.26 && M < 0.10) return BIOME.DESERT;
  if (T < -0.13 && M > 0.02) return BIOME.BIRCH;
  if (M > 0.16) return BIOME.FOREST;
  return BIOME.MEADOW;
}

export function biomeAt(seed, wx, wz, ver = GEN_VERSION) {
  if (ver < 2) return BIOME.MEADOW;
  const c = ensure(seed);
  return biomeOf(climateT(c, wx, wz), climateM(c, wx, wz));
}

// Everything a column needs from the 2D fields, computed once.
function columnInfo(c, wx, wz, ver) {
  const cont = c.terrain.fbm2(wx * 0.0055, wz * 0.0055, 4);     // broad continents
  const hills = c.hills.fbm2(wx * 0.021, wz * 0.021, 3) * 0.55; // local bumps
  let h, biome = BIOME.MEADOW, T = 0;
  if (ver >= 2) {
    T = climateT(c, wx, wz);
    biome = biomeOf(T, climateM(c, wx, wz));
    const flat = biome === BIOME.DESERT ? 0.55 : 1;             // dunes, not crags
    // Mountain ranges: a ridged field sharpened inside a rare low-freq mask, so
    // most of the world stays gentle but ranges rise to real peaks.
    const mmask = smoothstep(0.10, 0.45, c.mount.fbm2(wx * 0.0016 + 91, wz * 0.0016 - 53, 2));
    let ridged = 0;
    if (mmask > 0.001) {
      ridged = Math.pow(Math.max(0, 1 - Math.abs(c.ridge.fbm2(wx * 0.008, wz * 0.008, 3))), 2.6) * 38 * mmask;
    }
    h = SEA_LEVEL + cont * 24 + hills * 14 * flat + ridged;
  } else {
    h = SEA_LEVEL + cont * 24 + hills * 14;
  }
  h = Math.floor(h);
  if (h < 4) h = 4;
  if (h > WH - 14) h = WH - 14;
  return { h, biome, T };
}

// Surface height of the terrain column at world (wx, wz).
export function heightAt(seed, wx, wz, ver = GEN_VERSION) {
  return columnInfo(ensure(seed), wx, wz, ver).h;
}

// Ravines (v2): a thin band of a low-frequency field carves a canyon from the
// surface down into the deeps. Returns 0 (none) or the canyon floor y.
const RAVINE_BAND = 0.016;
function ravineFloor(c, wx, wz, h) {
  if (h <= SEA_LEVEL + 2) return 0;                  // never crack open the sea floor
  const rv = c.ravine.fbm2(wx * 0.0045 + 7, wz * 0.0045 - 3, 2);
  if (Math.abs(rv) >= RAVINE_BAND) return 0;
  // depth varies along the crack so the floor undulates
  const d = c.ravine.fbm2(wx * 0.02 - 40, wz * 0.02 + 25, 2);
  return Math.max(8, 14 + Math.floor(d * 5));
}

// Ore vein lookup. Deepest/rarest checked first so they win ties. Higher
// `scale` = higher-frequency noise = smaller, more broken-up veins; higher
// `threshold` = a smaller fraction of cells qualify = rarer overall. Tuned so
// ore is a find, not a guarantee, and veins are a handful of blocks (not ~32).
// Densities (measured fraction of in-band cells that become this ore):
// embercoal ~1.2%, copper ~0.85%, ferralite ~0.55%, azurite ~0.47%,
// sunbrass ~0.30%, sparkstone ~0.22%, aetherite ~0.15%. The higher `scale`
// (vs. the original ~0.09) keeps veins small — a handful of blocks, not ~32.
// Gloamite/verdanite (iter 28) generate in every world version so old saves can
// still craft the Soul Anchor and Wayshard.
// Retuned (iter 28 polish): v2's big deep caverns + ravines expose far more
// stone face than the old tight tunnels did, so every ore got rarer (threshold
// +0.03-0.04) and higher-frequency (larger `scale` = veins of 1-3 blocks, not
// 5-8). A single ravine should show a few glints, not a full anchor's worth.
const ORES = [
  { key: "ore_aetherite", yMin: 3,  yMax: 16, scale: 0.19, threshold: 0.73, s: [11, 0, 23] },
  { key: "ore_gloamite",  yMin: 3,  yMax: 18, scale: 0.19, threshold: 0.72, s: [55, 13, 88] },
  { key: "ore_sparkstone", yMin: 3, yMax: 20, scale: 0.19, threshold: 0.71, s: [40, 5, 70] },
  { key: "ore_sunbrass",  yMin: 4,  yMax: 28, scale: 0.18, threshold: 0.69, s: [80, 9, 14] },
  { key: "ore_azurite",   yMin: 4,  yMax: 36, scale: 0.18, threshold: 0.67, s: [3, 50, 31] },
  { key: "ore_verdanite", yMin: 6,  yMax: 44, scale: 0.18, threshold: 0.67, s: [21, 60, 47] },
  { key: "ore_ferralite", yMin: 5,  yMax: 46, scale: 0.18, threshold: 0.66, s: [60, 22, 90] },
  { key: "ore_copper",    yMin: 6,  yMax: 60, scale: 0.17, threshold: 0.62, s: [17, 33, 5] },
  { key: "ore_embercoal", yMin: 8,  yMax: 84, scale: 0.17, threshold: 0.60, s: [99, 71, 41] },
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
// v2 also seams in the odd pocket of gravel or packed dirt.
function stoneAt(c, wx, wy, wz, ver) {
  const base = oreAt(c, wx, wy, wz);
  if (base !== BLOCK.greystone) return base;          // ore wins the cell
  if (ver >= 2) {
    const p = c.stonevar.fbm3(wx * 0.035 + 50, wy * 0.035, wz * 0.035 - 50, 2);
    if (p > 0.52) return BLOCK.shingle;               // gravel pocket
    if (p < -0.54) return BLOCK.loam;                 // packed-dirt pocket
  }
  const n = c.stonevar.fbm3(wx * 0.02, wy * 0.02, wz * 0.02, 2);
  if (n > 0.3) return BLOCK.umberstone;
  if (n < -0.3) return BLOCK.slatestone;
  return BLOCK.greystone;
}

// Is this underground cell carved out into a cave?
function isCave(c, wx, wy, wz, ver) {
  // blobby caverns; v2 lowers the threshold with depth so the deeps open into
  // proper caverns while the near-surface stays tight.
  const blob = c.cave.fbm3(wx * 0.045, wy * 0.06, wz * 0.045, 3);
  let th = 0.55;
  if (ver >= 2 && wy < 30) th = Math.max(0.42, 0.55 - (30 - wy) * 0.005);
  if (blob > th) return true;
  // thin spaghetti tunnels (ridged noise)
  const t = Math.abs(c.cave2.noise3(wx * 0.05, wy * 0.07, wz * 0.05));
  if (t < 0.045) return true;
  return false;
}

// Water line for flooded deep caverns (v2): carved space at/below this level
// fills with still water instead of air.
const DEEP_WATER_Y = 12;

export function generate(chunk, seed, ver = GEN_VERSION) {
  const c = ensure(seed);
  const v = chunk.voxels;
  const baseX = chunk.cx * CX, baseZ = chunk.cz * CZ;

  for (let z = 0; z < CZ; z++) {
    for (let x = 0; x < CX; x++) {
      const wx = baseX + x, wz = baseZ + z;
      const { h, biome } = columnInfo(c, wx, wz, ver);
      const beach = h <= SEA_LEVEL + 1;
      const rvFloor = ver >= 2 ? ravineFloor(c, wx, wz, h) : 0;

      for (let y = 0; y < WH; y++) {
        let id = BLOCK.air;
        if (y < 2) {
          id = BLOCK.bedrock;
        } else if (y <= h) {
          const depth = h - y;
          if (beach) {
            id = depth <= 2 ? BLOCK.sand : (depth <= 4 ? BLOCK.sandstone : BLOCK.greystone);
          } else if (ver >= 2 && biome === BIOME.DESERT) {
            id = depth <= 2 ? BLOCK.sand : (depth <= 6 ? BLOCK.sandstone : stoneAt(c, wx, y, wz, ver));
          } else if (depth === 0) {
            id = (ver >= 2 && biome === BIOME.SNOW) ? BLOCK.snowturf : BLOCK.turf;
          } else if (depth <= 3) {
            id = BLOCK.loam;
          } else {
            id = stoneAt(c, wx, y, wz, ver);
          }
          // ravines slice from the surface into the deeps (v2)
          if (rvFloor && y >= rvFloor && id !== BLOCK.bedrock) {
            id = y <= DEEP_WATER_Y ? BLOCK.water : BLOCK.air;
          }
          // carve caves out of underground solid (not the very top, not bedrock)
          else if (id !== BLOCK.bedrock && depth >= 1 && y > 2 && isCave(c, wx, y, wz, ver)) {
            if (y <= SEA_LEVEL && depth <= 2) {
              // keep the sea floor sealed
            } else {
              id = (ver >= 2 && y <= DEEP_WATER_Y) ? BLOCK.water : BLOCK.air;
            }
          }
        } else if (y <= SEA_LEVEL) {
          id = BLOCK.water;
        }
        v[localIdx(x, y, z)] = id;
      }
    }
  }

  stampTrees(chunk, seed, ver);
  stampFoliage(chunk, seed, ver);
  if (ver >= 2) stampPapyrus(chunk, seed, ver);
  chunk.generated = true;
}

// ---------------------------------------------------------------------------
// Trees. Stamped by scanning a margin around the chunk so canopies that
// originate just outside still appear seamlessly (3 covers the palm fronds).
// v2 picks species + density per biome; v1 keeps the original mixed stand.
// ---------------------------------------------------------------------------

// v2 species tables: [maxRoll, pickSpecies(wsel)]
function treeSpecFor(biome, wsel) {
  switch (biome) {
    case BIOME.FOREST:
      return { density: 0.050, kind: wsel < 0.35 ? "pine" : wsel < 0.44 ? "dusk" : "oak" };
    case BIOME.BIRCH:
      return { density: 0.045, kind: wsel < 0.78 ? "birch" : "oak" };
    case BIOME.SNOW:
      return { density: 0.020, kind: "pine" };
    case BIOME.DESERT:
      return { density: 0, kind: "oak" };
    default: // meadow
      return { density: 0.014, kind: wsel < 0.10 ? "pine" : wsel < 0.20 ? "dusk" : wsel < 0.28 ? "birch" : "oak" };
  }
}
const TREE_BLOCKS = {
  oak: () => [BLOCK.log, BLOCK.leaves],
  pine: () => [BLOCK.pine_log, BLOCK.pine_leaves],
  dusk: () => [BLOCK.dusk_log, BLOCK.dusk_leaves],
  birch: () => [BLOCK.birch_log, BLOCK.birch_leaves],
};

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

function stampTrees(chunk, seed, ver) {
  const c = ensure(seed);
  const MARGIN = ver >= 2 ? 3 : 2;
  const minX = chunk.cx * CX - MARGIN, maxX = chunk.cx * CX + CX + MARGIN;
  const minZ = chunk.cz * CZ - MARGIN, maxZ = chunk.cz * CZ + CZ + MARGIN;
  for (let wx = minX; wx < maxX; wx++) {
    for (let wz = minZ; wz < maxZ; wz++) {
      const r = hash2i(seed ^ 0x5eed, wx, wz);
      if (r >= 0.06) continue;                     // early out: above any density

      if (ver < 2) {
        if (r >= 0.018) continue;
        const { h } = columnInfo(c, wx, wz, ver);
        if (h <= SEA_LEVEL + 1) continue;          // no trees on beaches / in water
        const wsel = hash2i(seed ^ 0xbeef, wx, wz);
        const kind = wsel < 0.15 ? "pine" : wsel < 0.3 ? "dusk" : "oak";
        stampCanopyTree(chunk, seed, wx, wz, h, kind);
        continue;
      }

      const { h, biome, T } = columnInfo(c, wx, wz, ver);
      if (h <= SEA_LEVEL + 1) {
        // warm beaches grow the odd palm above the tide line
        if (h === SEA_LEVEL + 1 && T > 0.22 && r < 0.012) stampPalm(chunk, seed, wx, wz, h);
        continue;
      }
      if (ravineFloor(c, wx, wz, h)) continue;    // the ground here is carved away
      const wsel = hash2i(seed ^ 0xbeef, wx, wz);
      const spec = treeSpecFor(biome, wsel);
      if (r >= spec.density) continue;
      stampCanopyTree(chunk, seed, wx, wz, h, spec.kind);
    }
  }
}

// The classic round-canopy tree shared by oak/pine/dusk/birch.
function stampCanopyTree(chunk, seed, wx, wz, h, kind) {
  const [logId, leafId] = TREE_BLOCKS[kind]();
  const height = 4 + Math.floor(hash2i(seed ^ 0xa11, wx, wz) * 3); // 4..6
  const topY = h + height;
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
  for (let t = 1; t <= height; t++) setIfInChunk(chunk, wx, h + t, wz, logId, true);
}

// A palm: a taller bare trunk crowned by radiating fronds with drooping tips.
function stampPalm(chunk, seed, wx, wz, h) {
  const height = 5 + Math.floor(hash2i(seed ^ 0xa17, wx, wz) * 3); // 5..7
  const topY = h + height;
  const leaf = BLOCK.palm_leaves, log = BLOCK.palm_log;
  setIfInChunk(chunk, wx, topY + 1, wz, leaf, false);              // crown tuft
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {     // four fronds
    setIfInChunk(chunk, wx + dx, topY, wz + dz, leaf, false);
    setIfInChunk(chunk, wx + dx * 2, topY, wz + dz * 2, leaf, false);
    setIfInChunk(chunk, wx + dx * 3, topY - 1, wz + dz * 3, leaf, false);   // drooping tip
  }
  for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {   // short diagonals
    setIfInChunk(chunk, wx + dx, topY, wz + dz, leaf, false);
  }
  for (let t = 1; t <= height; t++) setIfInChunk(chunk, wx, h + t, wz, log, true);
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
  if (ground === BLOCK.snowturf) {                    // snowfields: sparse and bare
    if (r < 0.006) return BLOCK.pebbles;
    if (r < 0.009) return BLOCK.dead_shrub;
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

function stampFoliage(chunk, seed, ver) {
  const c = ensure(seed);
  const baseX = chunk.cx * CX, baseZ = chunk.cz * CZ;
  for (let z = 0; z < CZ; z++) {
    for (let x = 0; x < CX; x++) {
      const wx = baseX + x, wz = baseZ + z;
      const h = columnInfo(c, wx, wz, ver).h;
      if (h + 1 >= WH) continue;
      if (chunk.voxels[localIdx(x, h + 1, z)] !== BLOCK.air) continue;   // occupied (trunk/leaf/water)
      const ground = chunk.voxels[localIdx(x, h, z)];
      const plant = pickFoliage(c, seed, wx, wz, ground);
      if (plant) chunk.voxels[localIdx(x, h + 1, z)] = plant;
    }
  }
}

// Papyrus (v2): reed clumps 1-3 tall on shore cells — ground at/next to the
// waterline with open water in a neighbouring column. Runs after foliage and
// overwrites any grass tuft that landed on the same cell.
function stampPapyrus(chunk, seed, ver) {
  const c = ensure(seed);
  const baseX = chunk.cx * CX, baseZ = chunk.cz * CZ;
  for (let z = 0; z < CZ; z++) {
    for (let x = 0; x < CX; x++) {
      const wx = baseX + x, wz = baseZ + z;
      const r = hash2i(seed ^ 0x9a90, wx, wz);
      if (r >= 0.20) continue;
      const { h, biome } = columnInfo(c, wx, wz, ver);
      if (biome === BIOME.SNOW) continue;
      if (h < SEA_LEVEL || h > SEA_LEVEL + 1) continue;   // right at the waterline
      const ground = chunk.voxels[localIdx(x, h, z)];
      if (ground !== BLOCK.sand && ground !== BLOCK.turf && ground !== BLOCK.loam) continue;
      // needs open water in an adjacent column
      let shore = false;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (columnInfo(c, wx + dx, wz + dz, ver).h < SEA_LEVEL) { shore = true; break; }
      }
      if (!shore) continue;
      const tall = 1 + Math.floor((r / 0.20) * 3);        // 1..3
      for (let k = 1; k <= tall; k++) {
        if (h + k >= WH) break;
        const i = localIdx(x, h + k, z);
        const cur = chunk.voxels[i];
        // the base reed may replace a grass tuft the foliage pass planted;
        // anything else (trunk, leaf, water) ends the clump
        if (cur !== BLOCK.air && !(k === 1 && isReplaceable(cur))) break;
        chunk.voxels[i] = BLOCK.papyrus;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Map support: predict the surface of an unexplored column without generating
// the chunk. Cheap (2D fields + a handful of hashes), deterministic, and close
// enough to the real thing that the atlas can sketch terra incognita.
// Returns { key, h } — a block key for colouring and the surface height.
// ---------------------------------------------------------------------------
export function surfacePreview(seed, wx, wz, ver = GEN_VERSION) {
  const c = ensure(seed);
  const info = columnInfo(c, wx, wz, ver);
  const { h, biome, T } = info;
  if (h < SEA_LEVEL) return { key: "water", h };
  if (ver >= 2 && ravineFloor(c, wx, wz, h)) return { key: "greystone", h: 14 };

  // tree canopies: any tree rooted within 2 cells shades this column
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const tx = wx + dx, tz = wz + dz;
      const r = hash2i(seed ^ 0x5eed, tx, tz);
      if (r >= 0.06) continue;
      const ti = (dx || dz) ? columnInfo(c, tx, tz, ver) : info;
      if (ti.h <= SEA_LEVEL + 1) continue;
      if (ver >= 2 && ravineFloor(c, tx, tz, ti.h)) continue;   // no tree rooted in a ravine
      let kind = null;
      if (ver < 2) {
        if (r < 0.018) {
          const wsel = hash2i(seed ^ 0xbeef, tx, tz);
          kind = wsel < 0.15 ? "pine" : wsel < 0.3 ? "dusk" : "oak";
        }
      } else {
        const spec = treeSpecFor(ti.biome, hash2i(seed ^ 0xbeef, tx, tz));
        if (r < spec.density) kind = spec.kind;
      }
      if (kind) return { key: kind === "oak" ? "leaves" : `${kind}_leaves`, h: ti.h + 5 };
    }
  }

  const beach = h <= SEA_LEVEL + 1;
  if (beach) return { key: "sand", h };
  if (ver >= 2 && biome === BIOME.DESERT) return { key: "sand", h };
  if (ver >= 2 && biome === BIOME.SNOW) return { key: "snowturf", h };
  return { key: "turf", h };
}
