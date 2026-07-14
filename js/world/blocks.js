// Central block registry. Everything (worldgen, meshing, lighting, mining,
// crafting, saving) keys off this table. To add a block: append one entry and,
// if it needs a new texture, add a painter in render/texatlas.js with the same
// texture name. IDs are assigned by array order but saves use the stable `key`.

// Tool tiers (numeric). Higher = better. Used for the mining progression gate.
export const TIER = {
  hand: 0,
  wood: 1,
  stone: 2,
  copper: 3,
  ferralite: 4,
  sunbrass: 4, // side-grade: same gate as ferralite but fast & fragile
  aetherite: 5,
};

// render: 'cube' (full block), 'cross' (X-shaped, e.g. torch), 'liquid', or null (air).
// tex: { all } or { top, side, bottom }. opaque=false marks see-through blocks
// (leaves/glass/water) that don't cull neighbour faces and don't block light.
const DEF = [
  { key: "air", name: "Air", render: null, solid: false, opaque: false },

  { key: "bedrock", name: "Bedrock", render: "cube", solid: true, opaque: true,
    tex: { all: "bedrock" }, hardness: Infinity, tool: "pick", minTier: 99, drop: "" },

  { key: "greystone", name: "Stone", render: "cube", solid: true, opaque: true,
    tex: { all: "greystone" }, hardness: 1.5, tool: "pick", minTier: TIER.wood, drop: "cobbled" },

  { key: "cobbled", name: "Cobblestone", render: "cube", solid: true, opaque: true,
    tex: { all: "cobbled" }, hardness: 2.0, tool: "pick", minTier: TIER.wood, drop: "cobbled" },

  { key: "loam", name: "Dirt", render: "cube", solid: true, opaque: true,
    tex: { all: "loam" }, hardness: 1.0, tool: "shovel", minTier: 0, drop: "loam" },

  { key: "turf", name: "Grass Block", render: "cube", solid: true, opaque: true,
    tex: { top: "turf_top", side: "turf_side", bottom: "loam" }, hardness: 1.0, tool: "shovel", minTier: 0, drop: "loam" },

  { key: "sand", name: "Sand", render: "cube", solid: true, opaque: true,
    tex: { all: "sand" }, hardness: 0.8, tool: "shovel", minTier: 0, drop: "sand" },

  { key: "sandstone", name: "Sandstone", render: "cube", solid: true, opaque: true,
    tex: { all: "sandstone" }, hardness: 1.2, tool: "pick", minTier: TIER.wood, drop: "sandstone" },

  { key: "shingle", name: "Gravel", render: "cube", solid: true, opaque: true,
    tex: { all: "shingle" }, hardness: 0.9, tool: "shovel", minTier: 0, drop: "shingle" },

  { key: "log", name: "Oak Log", render: "cube", solid: true, opaque: true, log: true,
    tex: { top: "log_top", side: "log_side", bottom: "log_top" }, hardness: 1.2, tool: "axe", minTier: 0, drop: "log" },

  { key: "leaves", name: "Oak Leaves", render: "cube", solid: true, opaque: false, leaf: true,
    tex: { all: "leaves" }, hardness: 0.3, tool: null, minTier: 0, drop: "" },

  { key: "planks", name: "Oak Planks", render: "cube", solid: true, opaque: true, plank: true,
    tex: { all: "planks" }, hardness: 1.0, tool: "axe", minTier: 0, drop: "planks" },

  { key: "bricks", name: "Stone Bricks", render: "cube", solid: true, opaque: true,
    tex: { all: "bricks" }, hardness: 1.6, tool: "pick", minTier: TIER.wood, drop: "bricks" },

  { key: "polished", name: "Polished Stone", render: "cube", solid: true, opaque: true,
    tex: { all: "polished" }, hardness: 1.6, tool: "pick", minTier: TIER.wood, drop: "polished" },

  { key: "wool", name: "White Wool", render: "cube", solid: true, opaque: true,
    tex: { all: "wool" }, hardness: 0.5, tool: null, minTier: 0, drop: "wool" },

  { key: "glass", name: "Glass", render: "cube", solid: true, opaque: false,
    tex: { all: "glass" }, hardness: 0.4, tool: null, minTier: 0, drop: "glass" },

  { key: "water", name: "Water", render: "liquid", solid: false, opaque: false,
    tex: { all: "water" }, hardness: Infinity, tool: null, minTier: 99, drop: "" },

  { key: "emberlight", name: "Torch", render: "cross", solid: false, opaque: false,
    tex: { all: "torch" }, hardness: 0.1, tool: null, minTier: 0, drop: "emberlight", light: 14, lightColor: [1.0, 0.62, 0.26] },

  // ---- ores (embedded in stone) ----
  { key: "ore_embercoal", name: "Coal Ore", render: "cube", solid: true, opaque: true,
    tex: { all: "ore_embercoal" }, hardness: 1.9, tool: "pick", minTier: TIER.wood, drop: "embercoal" },

  { key: "ore_copper", name: "Copper Ore", render: "cube", solid: true, opaque: true,
    tex: { all: "ore_copper" }, hardness: 2.0, tool: "pick", minTier: TIER.wood, drop: "raw_copper" },

  { key: "ore_ferralite", name: "Iron Ore", render: "cube", solid: true, opaque: true,
    tex: { all: "ore_ferralite" }, hardness: 2.4, tool: "pick", minTier: TIER.stone, drop: "raw_ferralite" },

  { key: "ore_sunbrass", name: "Gold Ore", render: "cube", solid: true, opaque: true,
    tex: { all: "ore_sunbrass" }, hardness: 2.4, tool: "pick", minTier: TIER.copper, drop: "raw_sunbrass" },

  { key: "ore_aetherite", name: "Diamond Ore", render: "cube", solid: true, opaque: true,
    tex: { all: "ore_aetherite" }, hardness: 2.8, tool: "pick", minTier: TIER.ferralite, drop: "aetherite" },

  { key: "ore_sparkstone", name: "Sparkstone Ore", render: "cube", solid: true, opaque: true,
    tex: { all: "ore_sparkstone" }, hardness: 2.2, tool: "pick", minTier: TIER.ferralite, drop: "sparkstone", dropCount: 4, light: 6, lightColor: [0.45, 0.85, 0.98] },

  { key: "ore_azurite", name: "Azurite Ore", render: "cube", solid: true, opaque: true,
    tex: { all: "ore_azurite" }, hardness: 2.2, tool: "pick", minTier: TIER.stone, drop: "azurite", dropCount: 5 },

  // ---- crafting stations ----
  { key: "workbench", name: "Workbench", render: "cube", solid: true, opaque: true,
    tex: { top: "workbench_top", side: "workbench_side", bottom: "planks" }, hardness: 1.2, tool: "axe", minTier: 0, drop: "workbench", station: "workbench" },

  { key: "forge", name: "Forge", render: "cube", solid: true, opaque: true,
    tex: { top: "forge_top", side: "forge_side", bottom: "greystone" }, hardness: 2.0, tool: "pick", minTier: TIER.wood, drop: "forge", station: "forge" },

  { key: "chest", name: "Chest", render: "cube", solid: true, opaque: true,
    tex: { top: "chest_top", side: "chest_side", bottom: "planks" }, hardness: 1.4, tool: "axe", minTier: 0, drop: "chest", station: "chest" },

  // ---- shaped blocks (orientation/state via metadata; see world/shapes.js) ----
  { key: "greystone_stairs", name: "Stone Stairs", render: "stair", solid: true, opaque: false,
    tex: { all: "greystone" }, hardness: 1.5, tool: "pick", minTier: TIER.wood, drop: "greystone_stairs" },

  { key: "plank_stairs", name: "Oak Stairs", render: "stair", solid: true, opaque: false,
    tex: { all: "planks" }, hardness: 1.0, tool: "axe", minTier: 0, drop: "plank_stairs" },

  { key: "ladder", name: "Ladder", render: "ladder", solid: false, opaque: false, climb: true,
    tex: { all: "ladder" }, hardness: 0.4, tool: null, minTier: 0, drop: "ladder" },

  { key: "trapdoor", name: "Oak Trapdoor", render: "trapdoor", solid: true, opaque: false, toggle: true,
    tex: { all: "trapdoor" }, hardness: 0.8, tool: "axe", minTier: 0, drop: "trapdoor" },

  { key: "door", name: "Oak Door", render: "door", solid: true, opaque: false, toggle: true, tall: true,
    tex: { all: "door" }, hardness: 0.8, tool: "axe", minTier: 0, drop: "door" },

  { key: "bed", name: "Bed", render: "bed", solid: true, opaque: false, sleep: true,
    // top uses the head (pillow) tile by default; the mesher swaps in the foot
    // (blanket) tile for the foot cell. `foot` is here only so the atlas paints it.
    tex: { top: "bed_head_top", foot: "bed_foot_top", side: "bed_side", bottom: "planks" }, hardness: 0.6, tool: "axe", minTier: 0, drop: "bed" },
];

// ---------------------------------------------------------------------------
// Generated material families. New stones and woods behave exactly like the
// originals (Greystone / Alderwood) but are recoloured; then every "building"
// material gets a matching stair + slab. Generating these from tables keeps the
// hand-written list short and makes adding another type a one-line change.
// ---------------------------------------------------------------------------

// New stone families: base + polished + bricks (all pick-mined, drop themselves).
const STONE_FAMILIES = [
  { id: "umber", name: "Umberstone" },
  { id: "slate", name: "Slatestone" },
];
for (const s of STONE_FAMILIES) {
  DEF.push(
    { key: `${s.id}stone`, name: s.name, render: "cube", solid: true, opaque: true,
      tex: { all: `${s.id}stone` }, hardness: 1.5, tool: "pick", minTier: TIER.wood, drop: `${s.id}stone` },
    { key: `polished_${s.id}`, name: `Polished ${s.name}`, render: "cube", solid: true, opaque: true,
      tex: { all: `polished_${s.id}` }, hardness: 1.6, tool: "pick", minTier: TIER.wood, drop: `polished_${s.id}` },
    { key: `bricks_${s.id}`, name: `${s.name} Bricks`, render: "cube", solid: true, opaque: true,
      tex: { all: `bricks_${s.id}` }, hardness: 1.6, tool: "pick", minTier: TIER.wood, drop: `bricks_${s.id}` },
  );
}

// New wood families: log + planks + leaves (same behaviour as Alderwood).
const WOOD_FAMILIES = [
  { id: "pine", name: "Pine" },
  { id: "dusk", name: "Walnut" },
];
for (const wd of WOOD_FAMILIES) {
  DEF.push(
    { key: `${wd.id}_log`, name: `${wd.name} Log`, render: "cube", solid: true, opaque: true, log: true,
      tex: { top: `${wd.id}_log_top`, side: `${wd.id}_log_side`, bottom: `${wd.id}_log_top` }, hardness: 1.2, tool: "axe", minTier: 0, drop: `${wd.id}_log` },
    { key: `${wd.id}_planks`, name: `${wd.name} Planks`, render: "cube", solid: true, opaque: true, plank: true,
      tex: { all: `${wd.id}_planks` }, hardness: 1.0, tool: "axe", minTier: 0, drop: `${wd.id}_planks` },
    { key: `${wd.id}_leaves`, name: `${wd.name} Leaves`, render: "cube", solid: true, opaque: false, leaf: true,
      tex: { all: `${wd.id}_leaves` }, hardness: 0.3, tool: null, minTier: 0, drop: "" },
    // each wood gets its own door + trapdoor (Alderwood keeps the original keys)
    { key: `${wd.id}_door`, name: `${wd.name} Door`, render: "door", solid: true, opaque: false, toggle: true, tall: true,
      tex: { all: `${wd.id}_door` }, hardness: 0.8, tool: "axe", minTier: 0, drop: `${wd.id}_door` },
    { key: `${wd.id}_trapdoor`, name: `${wd.name} Trapdoor`, render: "trapdoor", solid: true, opaque: false, toggle: true,
      tex: { all: `${wd.id}_trapdoor` }, hardness: 0.8, tool: "axe", minTier: 0, drop: `${wd.id}_trapdoor` },
  );
}

// ---------------------------------------------------------------------------
// Plants & greebles: cross-rendered decoration scattered by worldgen to make the
// surface feel alive. `plant:true` -> the mesher draws an X-billboard tuft (see
// mesher emitPlant); solid:false so you walk through them and opaque:false so
// they don't block light. `replaceable:true` lets a placed block/plant overwrite
// them in-place (like Minecraft grass). Instant-break (hardness 0), no tool.
// `plantH` = billboard height in blocks; drop "" means it yields nothing when
// broken (grass/fern/pebbles), otherwise it drops the given item.
// ---------------------------------------------------------------------------
const PLANTS = [
  { key: "tall_grass", name: "Tall Grass", h: 0.92, drop: "" },
  { key: "fern", name: "Fern", h: 0.90, drop: "" },
  { key: "bush", name: "Shrub", h: 0.82, drop: "" },
  { key: "dead_shrub", name: "Dead Bush", h: 0.80, drop: "stick" },
  { key: "pebbles", name: "Pebbles", h: 0.26, drop: "" },
  { key: "mushroom_red", name: "Red Mushroom", h: 0.50 },
  { key: "mushroom_brown", name: "Brown Mushroom", h: 0.50 },
  { key: "flower_poppy", name: "Poppy", h: 0.70 },
  { key: "flower_daisy", name: "Daisy", h: 0.66 },
  { key: "flower_cornflower", name: "Cornflower", h: 0.72 },
  { key: "flower_dandelion", name: "Dandelion", h: 0.64 },
  { key: "flower_violet", name: "Violet", h: 0.60 },
];
for (const p of PLANTS) {
  DEF.push({
    key: p.key, name: p.name, render: "cross", solid: false, opaque: false,
    plant: true, replaceable: true, plantH: p.h, plantR: 0.45,
    tex: { all: p.key }, hardness: 0, tool: null, minTier: 0,
    drop: p.drop !== undefined ? p.drop : p.key,
  });
}

// Materials that get a stair + slab. The two pre-existing stairs keep their
// original keys (saves stay valid); we only add their slabs.
const BUILD_MATS = [
  { key: "planks", tool: "axe", tier: 0, hardness: 1.0, stair: "plank_stairs" },
  { key: "pine_planks", tool: "axe", tier: 0, hardness: 1.0 },
  { key: "dusk_planks", tool: "axe", tier: 0, hardness: 1.0 },
  { key: "greystone", tool: "pick", tier: TIER.wood, hardness: 1.5, stair: "greystone_stairs" },
  { key: "cobbled", tool: "pick", tier: TIER.wood, hardness: 2.0 },
  { key: "polished", tool: "pick", tier: TIER.wood, hardness: 1.6 },
  { key: "bricks", tool: "pick", tier: TIER.wood, hardness: 1.6 },
  { key: "sandstone", tool: "pick", tier: TIER.wood, hardness: 1.2 },
];
for (const s of STONE_FAMILIES) {
  BUILD_MATS.push(
    { key: `${s.id}stone`, tool: "pick", tier: TIER.wood, hardness: 1.5 },
    { key: `polished_${s.id}`, tool: "pick", tier: TIER.wood, hardness: 1.6 },
    { key: `bricks_${s.id}`, tool: "pick", tier: TIER.wood, hardness: 1.6 },
  );
}

// base key -> stair/slab/vslab key (consumed by recipes.js + crafting).
export const STAIR_OF = {};
export const SLAB_OF = {};
export const VSLAB_OF = {};   // slab key -> vertical-slab key (and reverse via SLAB_FROM_VSLAB)
export const SLAB_FROM_VSLAB = {};
const texOf = (key) => { const b = DEF.find((d) => d.key === key); return (b && b.tex && (b.tex.all || b.tex.side)) || key; };
const nameOf = (key) => { const b = DEF.find((d) => d.key === key); return (b && b.name) || key; };
for (const m of BUILD_MATS) {
  const stairKey = m.stair || `${m.key}_stairs`;
  const slabKey = `${m.key}_slab`;
  const vslabKey = `${m.key}_vslab`;
  STAIR_OF[m.key] = stairKey;
  SLAB_OF[m.key] = slabKey;
  VSLAB_OF[slabKey] = vslabKey;
  SLAB_FROM_VSLAB[vslabKey] = slabKey;
  const tex = { all: texOf(m.key) };
  if (!m.stair) {
    DEF.push({ key: stairKey, name: `${nameOf(m.key)} Stairs`, render: "stair", solid: true, opaque: false,
      tex, hardness: m.hardness, tool: m.tool, minTier: m.tier, drop: stairKey });
  }
  DEF.push({ key: slabKey, name: `${nameOf(m.key)} Slab`, render: "slab", solid: true, opaque: false,
    tex, hardness: m.hardness, tool: m.tool, minTier: m.tier, drop: slabKey });
  DEF.push({ key: vslabKey, name: `${nameOf(m.key)} Vertical Slab`, render: "vslab", solid: true, opaque: false,
    tex, hardness: m.hardness, tool: m.tool, minTier: m.tier, drop: vslabKey });
}

// Assign ids and build lookup maps.
export const BLOCKS = DEF.map((b, id) => ({
  id,
  dropCount: 1,
  light: 0,
  lightColor: [1.0, 0.85, 0.6],   // default emitter tint (warm); overridden per-block
  ...b,
  breakable: Number.isFinite(b.hardness),
}));

export const BLOCK = {}; // key -> id
for (const b of BLOCKS) BLOCK[b.key] = b.id;

export const AIR = BLOCK.air;

// Ingredient tags let a recipe accept a whole family (e.g. "#planks" = any wood's
// planks) instead of one key. A recipe legend/ingredient value starting with "#"
// is a tag; `ingredientMatches` resolves it.
export const TAGS = {
  planks: BLOCKS.filter((b) => b.plank).map((b) => b.key),
};
export function ingredientMatches(reqKey, slotKey) {
  if (reqKey && reqKey[0] === "#") { const t = TAGS[reqKey.slice(1)]; return !!t && t.includes(slotKey); }
  return reqKey === slotKey;
}
export function tagRepr(reqKey) {                 // a representative member, for icons/labels
  if (reqKey && reqKey[0] === "#") { const t = TAGS[reqKey.slice(1)]; return (t && t[0]) || reqKey; }
  return reqKey;
}

// Flat property tables for the hottest per-voxel queries (lighting BFS, mesher
// face culling, collision). A typed-array index beats an object-property chain
// in those inner loops; out-of-range ids read undefined -> falsy, matching the
// old guards.
export const OPAQUE = Uint8Array.from(BLOCKS, (b) => (b.opaque ? 1 : 0));
export const SOLID = Uint8Array.from(BLOCKS, (b) => (b.solid ? 1 : 0));
export const EMIT = Uint8Array.from(BLOCKS, (b) => b.light | 0);

export function getBlock(id) { return BLOCKS[id] || BLOCKS[AIR]; }
export function blockByKey(key) { return BLOCKS[BLOCK[key]] ?? null; }
export function isOpaque(id) { return OPAQUE[id] === 1; }
export function isSolid(id) { return SOLID[id] === 1; }
export function emitOf(id) { return EMIT[id] || 0; }
export function lightColorOf(id) { return (BLOCKS[id] && BLOCKS[id].lightColor) || [1.0, 0.85, 0.6]; }
export function isLeaf(id) { return !!(BLOCKS[id] && BLOCKS[id].leaf); }
export function isLog(id) { return !!(BLOCKS[id] && BLOCKS[id].log); }
export function isPlant(id) { return !!(BLOCKS[id] && BLOCKS[id].plant); }
// Replaceable blocks (tall grass, flowers) get overwritten in place when a block
// is placed "into" them, instead of the new block landing on the near face.
export function isReplaceable(id) { return !!(BLOCKS[id] && BLOCKS[id].replaceable); }

// Which texture name to use for a given face. faceDir: 0+x 1-x 2+y(top) 3-y(bottom) 4+z 5-z
export function texForFace(block, faceDir) {
  const t = block.tex;
  if (!t) return "missing";
  if (t.all) return t.all;
  if (faceDir === 2) return t.top || t.side || t.all;
  if (faceDir === 3) return t.bottom || t.side || t.all;
  return t.side || t.all;
}
