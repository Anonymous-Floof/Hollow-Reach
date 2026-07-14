// Recipe data. Crafting recipes are either shapeless (a bag of ingredients) or
// shaped (a pattern). `station` is "hand" (works in the 2x2 player grid and the
// workbench) or "workbench" (3x3 only). Smelting recipes run in the forge.

import { TOOL_MATS, ARMOR_MATS } from "./items.js";
import { STAIR_OF, SLAB_OF, VSLAB_OF } from "../world/blocks.js";

// "#planks" is an ingredient tag (see blocks.js): any wood's planks work, so
// sticks/workbench/chest/bed/boat can be built from any wood (even mixed).
export const RECIPES = [
  // --- bootstrap (hand) ---
  { type: "shapeless", in: { log: 1 }, out: { key: "planks", count: 4 }, station: "hand" },
  { type: "shaped", pattern: ["X", "X"], legend: { X: "#planks" }, out: { key: "stick", count: 4 }, station: "hand" },
  { type: "shaped", pattern: ["XX", "XX"], legend: { X: "#planks" }, out: { key: "workbench", count: 1 }, station: "hand" },
  { type: "shaped", pattern: ["E", "S"], legend: { E: "embercoal", S: "stick" }, out: { key: "emberlight", count: 4 }, station: "hand" },
  { type: "shaped", pattern: ["E", "S"], legend: { E: "charcoal", S: "stick" }, out: { key: "emberlight", count: 4 }, station: "hand" },

  // --- stations & building (workbench) ---
  { type: "shaped", pattern: ["XXX", "X X", "XXX"], legend: { X: "cobbled" }, out: { key: "forge", count: 1 }, station: "workbench" },
  { type: "shaped", pattern: ["XXX", "X X", "XXX"], legend: { X: "#planks" }, out: { key: "chest", count: 1 }, station: "workbench" },
  { type: "shaped", pattern: ["XX", "XX"], legend: { X: "greystone" }, out: { key: "bricks", count: 4 }, station: "workbench" },
  { type: "shaped", pattern: ["XX", "XX"], legend: { X: "cobbled" }, out: { key: "polished", count: 4 }, station: "workbench" },
  { type: "shaped", pattern: ["XX", "XX"], legend: { X: "sand" }, out: { key: "sandstone", count: 4 }, station: "workbench" },

  // shaped blocks (stairs/slabs/vslabs + per-wood doors/trapdoors generated below)
  { type: "shaped", pattern: ["X X", "XXX", "X X"], legend: { X: "stick" }, out: { key: "ladder", count: 3 }, station: "workbench" },
  { type: "shaped", pattern: ["WWW", "PPP"], legend: { W: "wool", P: "#planks" }, out: { key: "bed", count: 1 }, station: "workbench" },

  // boat: a hull of planks (P_P / PPP)
  { type: "shaped", pattern: ["P P", "PPP"], legend: { P: "#planks" }, out: { key: "boat", count: 1 }, station: "workbench" },
];

// Per-wood doors (3 per 2x3) and trapdoors (2 per 2x3). Alderwood keeps its
// original "door"/"trapdoor" keys; the new woods get their own.
const WOOD_DOORS = [
  { plank: "planks", door: "door", trap: "trapdoor" },
  { plank: "pine_planks", door: "pine_door", trap: "pine_trapdoor" },
  { plank: "dusk_planks", door: "dusk_door", trap: "dusk_trapdoor" },
];
for (const w of WOOD_DOORS) {
  RECIPES.push(
    { type: "shaped", pattern: ["XX", "XX", "XX"], legend: { X: w.plank }, out: { key: w.door, count: 3 }, station: "workbench" },
    { type: "shaped", pattern: ["XXX", "XXX"], legend: { X: w.plank }, out: { key: w.trap, count: 2 }, station: "workbench" },
  );
}

// Vertical slabs: a slab <-> vertical slab, both ways (1:1, shapeless).
for (const slabKey in VSLAB_OF) {
  RECIPES.push(
    { type: "shapeless", in: { [slabKey]: 1 }, out: { key: VSLAB_OF[slabKey], count: 1 }, station: "hand" },
    { type: "shapeless", in: { [VSLAB_OF[slabKey]]: 1 }, out: { key: slabKey, count: 1 }, station: "hand" },
  );
}

// --- new material families (mirror the originals) ---
// Planks from each new log.
for (const w of ["pine", "dusk"]) {
  RECIPES.push({ type: "shapeless", in: { [`${w}_log`]: 1 }, out: { key: `${w}_planks`, count: 4 }, station: "hand" });
}
// Polished (from base) and bricks (from polished) for each new stone.
for (const s of ["umber", "slate"]) {
  RECIPES.push(
    { type: "shaped", pattern: ["XX", "XX"], legend: { X: `${s}stone` }, out: { key: `polished_${s}`, count: 4 }, station: "workbench" },
    { type: "shaped", pattern: ["XX", "XX"], legend: { X: `polished_${s}` }, out: { key: `bricks_${s}`, count: 4 }, station: "workbench" },
  );
}

// --- stairs (6 per 3-2-1) + slabs (6 per row of 3) for every building material ---
for (const base in STAIR_OF) {
  RECIPES.push({ type: "shaped", pattern: ["X  ", "XX ", "XXX"], legend: { X: base }, out: { key: STAIR_OF[base], count: 6 }, station: "workbench" });
}
for (const base in SLAB_OF) {
  RECIPES.push({ type: "shaped", pattern: ["XXX"], legend: { X: base }, out: { key: SLAB_OF[base], count: 6 }, station: "workbench" });
}

// --- tools & armour, generated per material tier (workbench) ---
const TOOL_PATTERNS = {
  pick: ["XXX", " S ", " S "],
  axe: ["XX", "XS", " S"],
  shovel: ["X", "S", "S"],
  sword: ["X", "X", "S"],
};
const ARMOR_PATTERNS = {
  helmet: ["XXX", "X X"],
  chest: ["X X", "XXX", "XXX"],
  legs: ["XXX", "X X", "X X"],
  boots: ["X X", "X X"],
};

for (const m of TOOL_MATS) {
  for (const [type, pattern] of Object.entries(TOOL_PATTERNS)) {
    RECIPES.push({
      type: "shaped", pattern, legend: { X: m.item, S: "stick" },
      out: { key: `${type}_${m.id}`, count: 1 }, station: "workbench",
    });
  }
}
for (const m of ARMOR_MATS) {
  const item = m.id === "copper" ? "copper_ingot"
    : m.id === "ferralite" ? "ferralite_ingot"
      : m.id === "sunbrass" ? "sunbrass_ingot" : "aetherite";
  for (const [piece, pattern] of Object.entries(ARMOR_PATTERNS)) {
    RECIPES.push({
      type: "shaped", pattern, legend: { X: item },
      out: { key: `${piece}_${m.id}`, count: 1 }, station: "workbench",
    });
  }
}

// --- smelting (forge) ---
export const SMELTING = [
  { in: "log", out: "charcoal", time: 8 },
  { in: "raw_copper", out: "copper_ingot", time: 6 },
  { in: "raw_ferralite", out: "ferralite_ingot", time: 8 },
  { in: "raw_sunbrass", out: "sunbrass_ingot", time: 8 },
  { in: "sand", out: "glass", time: 5 },
  { in: "cobbled", out: "greystone", time: 6 },
  { in: "pork_raw", out: "pork_cooked", time: 6 },
];

// Base burn time (seconds) for the *raw* fuels only. Everything else made from
// these — wooden tools, chests, boats, wooden stairs/doors, torches (coal+stick),
// any wood type — gets its burn time auto-computed from its recipe in
// crafting.fuelValue, so new wooden items need no entry here.
export const FUEL = {
  embercoal: 48, charcoal: 48, log: 12, planks: 9, stick: 3,
};
