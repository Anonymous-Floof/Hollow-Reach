// Item registry: block-items (auto-derived from the block table), raw/refined
// materials, tools, and armour. Also generates a small icon canvas for every
// item procedurally (no image files) for the HUD and inventory.

import { BLOCKS, BLOCK, getBlock, texForFace, TIER } from "../world/blocks.js";

export const ITEMS = {};

function add(item) { ITEMS[item.key] = { count: 0, maxStack: 64, ...item }; return ITEMS[item.key]; }

// ---- block items (everything placeable) ----
const NON_ITEM = new Set(["air", "water", "bedrock"]);
for (const b of BLOCKS) {
  if (NON_ITEM.has(b.key)) continue;
  add({ key: b.key, name: b.name, type: "block", blockId: b.id, iconKind: "block" });
}

// ---- materials ----
const MATERIALS = [
  { key: "stick", name: "Stick", color: "#9c7748", iconKind: "stick" },
  { key: "embercoal", name: "Coal", color: "#1d1d22", iconKind: "lump", fuel: 8 },
  { key: "charcoal", name: "Charcoal", color: "#36322c", iconKind: "lump", fuel: 8 },
  { key: "raw_copper", name: "Raw Copper", color: "#a5612e", iconKind: "nugget" },
  { key: "copper_ingot", name: "Copper Ingot", color: "#c8783a", iconKind: "ingot" },
  { key: "raw_ferralite", name: "Raw Iron", color: "#b9ad95", iconKind: "nugget" },
  { key: "ferralite_ingot", name: "Iron Ingot", color: "#cfd2d6", iconKind: "ingot" },
  { key: "raw_sunbrass", name: "Raw Gold", color: "#c9a838", iconKind: "nugget" },
  { key: "sunbrass_ingot", name: "Gold Ingot", color: "#e8c64a", iconKind: "ingot" },
  { key: "aetherite", name: "Diamond", color: "#46d8c4", iconKind: "gem" },
  { key: "sparkstone", name: "Sparkstone", color: "#e0432f", iconKind: "shard" },
  { key: "azurite", name: "Azurite", color: "#2f6fe0", iconKind: "shard" },
  { key: "gloamite", name: "Gloamite", color: "#8a52e8", iconKind: "shard" },
  { key: "verdanite", name: "Verdanite", color: "#46b558", iconKind: "shard" },
  { key: "leather", name: "Leather", color: "#9a6a3c", iconKind: "leather" },
  { key: "paper", name: "Paper", color: "#ece7d4", iconKind: "paper" },
];
for (const m of MATERIALS) add({ ...m, type: "material" });

// ---- foods (right-click to eat; `food` = hunger points restored) ----
// `risky` foods gamble on eat (see player.eat): rotten flesh might feed or sicken.
// `food` is in hunger POINTS on the 20-point bar (1 pip = 2 points), so a
// cooked meal visibly fills pips. Values echo Minecraft's (porkchop/steak = 8).
const FOODS = [
  { key: "pork_raw", name: "Raw Porkchop", color: "#e08a90", iconKind: "meat", food: 3 },
  { key: "pork_cooked", name: "Cooked Porkchop", color: "#b06a3c", iconKind: "meat", food: 8 },
  { key: "beef_raw", name: "Raw Beef", color: "#c4525a", iconKind: "steak", food: 3 },
  { key: "beef_cooked", name: "Steak", color: "#8a4a2c", iconKind: "steak", food: 8 },
  { key: "rotten_flesh", name: "Rotten Flesh", color: "#7a8c4e", iconKind: "flesh", food: 2, risky: true },
];
for (const f of FOODS) add({ ...f, type: "food" });

// ---- usable items that aren't blocks ----
// A boat: using it (right-click) spawns a rideable boat entity. fuel so it can be
// burned like other wooden things.
add({ key: "boat", name: "Oak Boat", type: "boat", maxStack: 1, color: "#8a6a3a", iconKind: "boat", fuel: 12 });

// Buckets: the empty one scoops still water (or milks a cow); the filled ones
// place/pour back. `fill` tints the icon's contents.
add({ key: "bucket", name: "Bucket", type: "bucket", maxStack: 16, color: "#b8bcc4", iconKind: "bucket" });
add({ key: "water_bucket", name: "Water Bucket", type: "bucket", holds: "water", maxStack: 1, color: "#b8bcc4", fill: "#3f77d9", iconKind: "bucket" });
add({ key: "milk_bucket", name: "Milk Bucket", type: "bucket", holds: "milk", maxStack: 1, color: "#b8bcc4", fill: "#f0eee6", iconKind: "bucket" });

// The Atlas: carrying it unlocks the world map (M), waypoints and the minimap.
add({ key: "atlas", name: "Atlas", type: "atlas", maxStack: 1, color: "#8a5a34", iconKind: "atlas" });

// Wayshard: a sliver of gloamite tuned to the open sky. Use it (right-click) to
// warp to the surface above you — consumed on use.
add({ key: "wayshard", name: "Wayshard", type: "warp", maxStack: 16, color: "#9a6ae8", iconKind: "wayshard" });

// ---- tools ----
// Each tier references the crafting material item it is built from.
// `speed` is the mining-speed multiplier applied only when using the correct
// tool type, and is shared across pick/axe/shovel/sword at a tier so they all
// progress consistently. Kept moderate so mining feels deliberate.
export const TOOL_MATS = [
  { id: "wood",      name: "Wooden", tier: TIER.wood,      item: "planks",          color: "#b08a52", speed: 1.7, dura: 60 },
  { id: "stone",     name: "Stone",  tier: TIER.stone,     item: "cobbled",         color: "#7d8189", speed: 2.4, dura: 130 },
  { id: "copper",    name: "Copper", tier: TIER.copper,    item: "copper_ingot",    color: "#c8783a", speed: 3.2, dura: 200 },
  { id: "ferralite", name: "Iron",   tier: TIER.ferralite, item: "ferralite_ingot", color: "#cfd2d6", speed: 4.2, dura: 360 },
  { id: "sunbrass",  name: "Golden", tier: TIER.sunbrass,  item: "sunbrass_ingot",  color: "#e8c64a", speed: 6.5, dura: 90 },
  { id: "aetherite", name: "Diamond", tier: TIER.aetherite, item: "aetherite",      color: "#46d8c4", speed: 5.2, dura: 820 },
];
const TOOL_TYPES = [
  { type: "pick", name: "Pickaxe", iconKind: "pick" },
  { type: "axe", name: "Axe", iconKind: "axe" },
  { type: "shovel", name: "Shovel", iconKind: "shovel" },
  { type: "sword", name: "Sword", iconKind: "sword" },
];
for (const m of TOOL_MATS) {
  for (const t of TOOL_TYPES) {
    add({
      key: `${t.type}_${m.id}`, name: `${m.name} ${t.name}`, type: "tool",
      maxStack: 1, toolType: t.type, tier: m.tier, speed: m.speed,
      durability: m.dura, color: m.color, iconKind: t.iconKind,
    });
  }
}

// ---- armour (metals only) ----
export const ARMOR_MATS = [
  { id: "copper",    name: "Copper", color: "#c8783a", defense: 1, dura: 120 },
  { id: "ferralite", name: "Iron",   color: "#cfd2d6", defense: 2, dura: 240 },
  { id: "sunbrass",  name: "Golden", color: "#e8c64a", defense: 1, dura: 80 },
  { id: "aetherite", name: "Diamond", color: "#46d8c4", defense: 3, dura: 520 },
];
export const ARMOR_PIECES = [
  { piece: "helmet", name: "Helm", slot: 0, mult: 1 },
  { piece: "chest", name: "Chestguard", slot: 1, mult: 1.6 },
  { piece: "legs", name: "Greaves", slot: 2, mult: 1.4 },
  { piece: "boots", name: "Boots", slot: 3, mult: 0.8 },
];
for (const m of ARMOR_MATS) {
  for (const p of ARMOR_PIECES) {
    add({
      key: `${p.piece}_${m.id}`, name: `${m.name} ${p.name}`, type: "armor",
      maxStack: 1, armorSlot: p.slot, defense: Math.max(1, Math.round(m.defense * p.mult)),
      durability: Math.round(m.dura * p.mult), color: m.color, iconKind: "armor_" + p.piece,
    });
  }
}

export function getItem(key) { return ITEMS[key] || null; }

// Shared item description used by inventory hover + the recipe book, so a tool's
// tier/speed, armour defense, durability and fuel read the same everywhere.
// `opts.dura` overrides the shown durability; `opts.fuel` is the burn time in
// seconds (callers pass it from the FUEL table to avoid an import cycle).
export function itemTooltip(key, opts = {}) {
  if (key && key[0] === "#") return { name: "Any " + key.slice(1).replace(/_/g, " "), sub: [] };
  const it = ITEMS[key];
  if (!it) return { name: key, sub: [] };
  const sub = [];
  if (it.type === "tool") {
    sub.push(`${it.toolType} · tier ${it.tier}`);
    // swords are weapons: show attack damage (see ai.attackDamage), not dig speed
    if (it.toolType === "sword") sub.push(`attack: ${3 + it.tier} damage`);
    else sub.push(`mining speed ×${it.speed}`);
  }
  if (it.type === "armor") sub.push(`+${it.defense} defense`);
  if (it.type === "food") sub.push(it.risky
    ? `food: a gamble (+${it.food} or −${it.food} hunger)`
    : `food: +${it.food} hunger (${it.food / 2} pips)`);
  if (it.type === "warp") sub.push("use: warp to the surface above you");
  if (it.type === "atlas") sub.push("carry it: world map (M) · minimap (N)");
  if (it.key === "bucket") sub.push("scoops still water · milks cows");
  const md = maxDurability(key);
  if (md) { const d = opts.dura !== undefined ? opts.dura : md; sub.push(`${d}/${md} durability`); }
  if (opts.fuel > 0) sub.push(`forge fuel · ${opts.fuel}s`);
  return { name: it.name, sub };
}

export function isTool(key) { const i = ITEMS[key]; return i && i.type === "tool"; }
export function isArmor(key) { const i = ITEMS[key]; return i && i.type === "armor"; }
export function maxDurability(key) { const i = ITEMS[key]; return i ? i.durability : 0; }

// ---------------------------------------------------------------------------
// Procedural icons
// ---------------------------------------------------------------------------
// Non-block items are hand-placed 16×16 pixel sprites blitted at 2× onto the
// 32px canvas, with an automatic 1px dark outline so they pop on any slot
// background. Block items render as a true 2:1 isometric cube sampled
// straight from the atlas (top diamond + two skewed, shaded side faces).
let ICON_ATLAS = null;

export function buildIcons(atlas) {
  ICON_ATLAS = atlas;
  for (const key in ITEMS) {
    const canvas = drawIcon(ITEMS[key]);
    ITEMS[key].iconURL = canvas.toDataURL();
  }
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) * f) | 0;
  const g = Math.min(255, ((n >> 8) & 255) * f) | 0;
  const b = Math.min(255, (n & 255) * f) | 0;
  return `rgb(${r},${g},${b})`;
}

// --- 16×16 sprite grid helpers ---
const G = 16;
const newGrid = () => new Array(G * G).fill(null);
function pset(g, x, y, c) { if (x >= 0 && x < G && y >= 0 && y < G) g[y * G + x] = c; }
function prow(g, x0, x1, y, c) { for (let x = x0; x <= x1; x++) pset(g, x, y, c); }
function pcol(g, x, y0, y1, c) { for (let y = y0; y <= y1; y++) pset(g, x, y, c); }

// 1px outline around every filled pixel (4-neighbour) drawn into empty cells.
function outlined(g, c) {
  const out = g.slice();
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    if (g[y * G + x]) continue;
    if ((x > 0 && g[y * G + x - 1]) || (x < G - 1 && g[y * G + x + 1]) ||
        (y > 0 && g[(y - 1) * G + x]) || (y < G - 1 && g[(y + 1) * G + x])) out[y * G + x] = c;
  }
  return out;
}
function blit(ctx, g) {
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    const c = g[y * G + x];
    if (c) { ctx.fillStyle = c; ctx.fillRect(x * 2, y * 2, 2, 2); }
  }
}

// Shared wood palette for handles, hafts and grips.
const HW = "#a8845a", HM = "#7e6038", HD = "#553f24";

// Vertical two-tone haft with a darker butt end.
function haft(g, y0, y1) {
  pcol(g, 7, y0, y1, HW); pcol(g, 8, y0, y1, HM);
  pset(g, 7, y1, HD); pset(g, 8, y1, HD);
}

// --- sprite painters: (grid, materialColor, item) ---
const SPRITES = {
  stick(g) {
    for (let i = 0; i < 8; i++) { pset(g, 4 + i, 13 - i, HW); pset(g, 5 + i, 13 - i, HM); }
    pset(g, 7, 10, HD);   // knot
  },

  pick(g, col) {
    const M = shade(col, 1.45), m = col, d = shade(col, 0.62);
    haft(g, 3, 14);
    // crescent head: lit along the crown, thickened underneath
    const arc = [[2, 7], [2, 6], [2, 5], [3, 4], [4, 3], [5, 2], [6, 2], [7, 1], [8, 1], [9, 2], [10, 2], [11, 3], [12, 4], [13, 5], [13, 6], [13, 7]];
    for (const [x, y] of arc) pset(g, x, y, y <= 2 ? M : m);
    for (const [x, y] of [[3, 5], [4, 4], [5, 3], [6, 3], [7, 2], [8, 2], [9, 3], [10, 3], [11, 4], [12, 5]]) pset(g, x, y, d);
  },

  axe(g, col) {
    const M = shade(col, 1.45), m = col, d = shade(col, 0.62);
    haft(g, 4, 14);
    // bearded blade on the left of the haft, poll nub on the right
    prow(g, 5, 8, 1, m); prow(g, 3, 8, 2, m); prow(g, 2, 8, 3, m);
    prow(g, 2, 6, 4, m); prow(g, 2, 5, 5, m); prow(g, 3, 4, 6, d);
    pcol(g, 2, 3, 5, M); pset(g, 3, 2, M);   // cutting edge catches light
    pset(g, 9, 2, d); pset(g, 9, 3, d);      // poll
  },

  shovel(g, col) {
    const M = shade(col, 1.45), m = col, d = shade(col, 0.62);
    // spade blade up top, neck, then the haft
    prow(g, 6, 9, 0, M);
    prow(g, 5, 10, 1, m); prow(g, 5, 10, 2, m); prow(g, 5, 10, 3, m);
    prow(g, 6, 9, 4, m); prow(g, 7, 8, 5, m);
    pcol(g, 5, 1, 3, M);                     // lit rim
    pcol(g, 10, 1, 3, d); pset(g, 9, 4, d);  // shaded rim
    haft(g, 6, 14);
  },

  sword(g, col) {
    const M = shade(col, 1.45), m = col;
    // diagonal blade with a lit upper edge, cross-guard, grip and pommel
    pset(g, 14, 1, M);
    for (let i = 0; i < 9; i++) { pset(g, 13 - i, 2 + i, M); pset(g, 14 - i, 3 + i, m); }
    for (const [x, y] of [[2, 9], [3, 10], [4, 11], [5, 12], [6, 13]]) pset(g, x, y, HD);
    pset(g, 3, 10, HM); pset(g, 5, 12, HM);
    pset(g, 3, 12, HM); pset(g, 2, 13, HM);      // grip
    pset(g, 1, 14, HD); pset(g, 2, 14, HD);      // pommel
  },

  ingot(g, col) {
    const M = shade(col, 1.4), m = col, d = shade(col, 0.62);
    prow(g, 5, 12, 5, M);                        // lit top face
    prow(g, 4, 13, 6, shade(col, 1.18));
    for (let y = 7; y <= 10; y++) prow(g, 3, 12, y, m);
    pcol(g, 13, 7, 10, d);                       // right end
    prow(g, 3, 13, 11, d);                       // base shadow
    pset(g, 5, 8, M); pset(g, 6, 7, M);          // gleam
  },

  nugget(g, col) {
    const M = shade(col, 1.4), m = col, d = shade(col, 0.62);
    prow(g, 6, 9, 5, m);
    prow(g, 5, 11, 6, m); prow(g, 4, 11, 7, m);
    prow(g, 4, 12, 8, m); prow(g, 5, 12, 9, m);
    prow(g, 5, 11, 10, d); prow(g, 6, 10, 11, d);
    pset(g, 6, 6, M); pset(g, 7, 6, M); pset(g, 5, 7, M);
  },

  lump(g, col) {
    const M = shade(col, 2.4), m = col, d = shade(col, 0.45);
    prow(g, 6, 9, 4, m);
    prow(g, 5, 10, 5, m); prow(g, 4, 11, 6, m);
    prow(g, 4, 12, 7, m); prow(g, 3, 12, 8, m);
    prow(g, 4, 12, 9, m); prow(g, 4, 11, 10, m);
    prow(g, 5, 10, 11, d); prow(g, 6, 9, 12, d);
    pset(g, 6, 5, M); pset(g, 5, 6, M); pset(g, 6, 6, M);   // glinting facet
    pcol(g, 11, 7, 9, d); pset(g, 12, 8, d);                // fractured face
  },

  gem(g, col) {
    const M = shade(col, 1.5), m = col, d = shade(col, 0.6);
    prow(g, 5, 10, 3, M);                        // table
    prow(g, 4, 11, 4, m);
    prow(g, 3, 12, 5, m);                        // girdle (widest)
    prow(g, 4, 11, 6, m); prow(g, 5, 10, 7, m);
    prow(g, 6, 9, 8, m); prow(g, 7, 8, 9, m);
    prow(g, 7, 8, 10, d);                        // culet point
    pset(g, 4, 4, M); pset(g, 3, 5, M); pset(g, 4, 6, M); pset(g, 5, 7, M);   // lit facets
    pset(g, 11, 4, d); pset(g, 12, 5, d); pset(g, 11, 6, d); pset(g, 10, 7, d);
    pset(g, 6, 4, "#ffffff");                    // sparkle
  },

  shard(g, col) {
    const M = shade(col, 1.5), m = col, d = shade(col, 0.55);
    pset(g, 7, 1, M);
    pcol(g, 6, 3, 12, M); pcol(g, 7, 2, 12, m); pcol(g, 8, 4, 12, d);   // tall spike
    pset(g, 10, 6, M); pcol(g, 10, 7, 12, m); pcol(g, 11, 8, 12, d);    // companion
    prow(g, 5, 12, 13, d);                       // base rubble
  },

  boat(g, col) {
    const M = shade(col, 1.3), m = col, d = shade(col, 0.6);
    prow(g, 1, 14, 8, M);                        // gunwale
    prow(g, 2, 13, 9, m); prow(g, 3, 12, 10, m); prow(g, 4, 11, 11, m);
    prow(g, 5, 10, 12, d);                       // keel
    prow(g, 5, 10, 9, d);                        // shaded interior
    pset(g, 7, 9, HW); pset(g, 8, 9, HW);        // seat plank
  },

  meat(g, col) {
    const M = shade(col, 1.3), m = col, d = shade(col, 0.72);
    // the chop: an oval with a shaded underside and a marbling streak
    for (let y = 2; y <= 12; y++) for (let x = 5; x <= 14; x++) {
      const v = ((x - 9.7) / 4.9) ** 2 + ((y - 7) / 5.1) ** 2;
      if (v > 1) continue;
      pset(g, x, y, v > 0.6 && (x > 10 || y > 8) ? d : m);
    }
    for (const [x, y] of [[8, 4], [8, 5], [9, 6], [9, 7], [10, 8]]) pset(g, x, y, M);
    // protruding bone with a knuckle
    const B = "#efe6d2", Bd = "#cfc2a4";
    pset(g, 6, 10, B); pset(g, 5, 11, B); pset(g, 6, 11, Bd);
    pset(g, 4, 12, B); pset(g, 5, 12, Bd);
    pset(g, 2, 11, B); pset(g, 3, 11, B); pset(g, 2, 12, B); pset(g, 3, 12, Bd);
    pset(g, 2, 13, B); pset(g, 3, 13, Bd);
  },

  flesh(g, col) {
    // ragged, hole-riddled slab in sickly greens and browns
    const m = col, d = shade(col, 0.66), b = "#6e5a38";
    for (let y = 3; y <= 13; y++) for (let x = 2; x <= 13; x++) {
      if ((x === 2 || x === 13) && y % 3 !== 1) continue;     // ragged sides
      if ((y === 3 || y === 13) && x % 3 === 0) continue;     // ragged ends
      if ((x * 3 + y * 5) % 11 === 0) continue;               // rot holes
      pset(g, x, y, (x * 7 + y * 3) % 9 < 3 ? b : (x + y) % 4 === 0 ? d : m);
    }
  },

  paper(g) {
    const P = "#ece7d4", S = "#cfc8ae", L = "#8f886e";
    for (let y = 2; y <= 13; y++) prow(g, 4, 11, y, P);
    for (let y = 2; y <= 13; y++) pset(g, 11, y, S);       // shaded right edge
    prow(g, 4, 11, 13, S);
    pset(g, 11, 2, S); pset(g, 10, 2, S); pset(g, 11, 3, S);  // dog-eared corner
    for (const y of [5, 8, 11]) prow(g, 6, 9, y, L);          // faint script lines
  },

  leather(g, col) {
    const M = shade(col, 1.25), m = col, d = shade(col, 0.62);
    // a tanned hide: irregular blob with darker crinkled edges
    for (let y = 3; y <= 12; y++) for (let x = 3; x <= 12; x++) {
      if ((x === 3 || x === 12) && (y < 5 || y > 10)) continue;
      if ((y === 3 || y === 12) && (x < 5 || x > 10)) continue;
      pset(g, x, y, (x + y * 3) % 7 === 0 ? d : m);
    }
    pset(g, 5, 4, M); pset(g, 6, 4, M); pset(g, 4, 6, M);   // worn sheen
    pset(g, 7, 8, d); pset(g, 9, 6, d); pset(g, 6, 10, d);  // crease marks
  },

  steak(g, col) {
    const M = shade(col, 1.35), m = col, d = shade(col, 0.66), F = "#e8dcc0";
    // a thick-cut slab with a fat rind along the top edge
    for (let y = 4; y <= 12; y++) for (let x = 3; x <= 13; x++) {
      const v = ((x - 8) / 5.4) ** 2 + ((y - 8) / 4.6) ** 2;
      if (v > 1) continue;
      pset(g, x, y, v > 0.62 && (x > 9 || y > 9) ? d : m);
    }
    for (const [x, y] of [[5, 4], [6, 4], [7, 4], [8, 4], [9, 4], [4, 5], [10, 4]]) pset(g, x, y, F);
    for (const [x, y] of [[6, 6], [7, 7], [8, 8], [6, 9]]) pset(g, x, y, M);   // sear marks
  },

  bucket(g, col, item) {
    const M = shade(col, 1.35), m = col, d = shade(col, 0.6);
    // handle arc
    for (const [x, y] of [[5, 3], [6, 2], [7, 2], [8, 2], [9, 2], [10, 3]]) pset(g, x, y, d);
    // tapering pail
    prow(g, 4, 11, 5, M);
    for (let y = 6; y <= 11; y++) { const inz = (y - 6) >> 1; prow(g, 4 + inz, 11 - inz, y, m); }
    prow(g, 6, 9, 12, d);
    pcol(g, 4, 6, 9, M); pcol(g, 11, 6, 9, d);
    // contents peeking over the rim
    if (item && item.fill) { const F = item.fill; prow(g, 5, 10, 5, F); prow(g, 5, 10, 4, shade(F, 1.15)); }
  },

  atlas(g, col) {
    const C = col, Cd = shade(col, 0.62), P = "#e8e2cc", A = "#3f77d9", G = "#c8a23a";
    // a stout leather-bound tome, pages on the right, a compass-rose clasp
    for (let y = 2; y <= 13; y++) prow(g, 3, 11, y, C);
    pcol(g, 3, 2, 13, Cd);                          // spine
    for (let y = 3; y <= 12; y++) { pset(g, 12, y, P); pset(g, 13, y, shade(P, 0.8)); }  // page block
    prow(g, 3, 11, 13, Cd);
    pcol(g, 7, 2, 13, G);                           // gilt band
    pset(g, 9, 6, G); pset(g, 9, 8, G); pset(g, 8, 7, G); pset(g, 10, 7, G);  // rose points
    pset(g, 9, 7, A);                               // compass jewel
  },

  wayshard(g, col) {
    const M = shade(col, 1.5), m = col, d = shade(col, 0.55), W = "#f2ecff";
    // a rising sliver with motes streaming skyward off its tip
    pset(g, 8, 2, W); pset(g, 6, 4, M); pset(g, 10, 5, M);        // motes
    for (let i = 0; i < 8; i++) { pset(g, 7, 5 + i, M); pset(g, 8, 5 + i, m); pset(g, 9, 6 + i, d); }
    pset(g, 8, 4, M);
    prow(g, 6, 10, 13, d);                                        // base chips
  },

  armor_helmet(g, col) {
    const M = shade(col, 1.4), m = col, d = shade(col, 0.62);
    prow(g, 5, 10, 3, M);                        // crown highlight
    prow(g, 4, 11, 4, m);
    for (let y = 5; y <= 8; y++) prow(g, 3, 12, y, m);
    prow(g, 5, 10, 8, d);                        // brow shadow over the face
    for (let y = 9; y <= 11; y++) { prow(g, 3, 4, y, m); prow(g, 11, 12, y, m); }   // cheek guards
    pcol(g, 3, 5, 9, M); pcol(g, 12, 5, 9, d);
  },

  armor_chest(g, col) {
    const M = shade(col, 1.4), m = col, d = shade(col, 0.62);
    prow(g, 2, 5, 3, m); prow(g, 10, 13, 3, m);  // shoulders beside the neck hole
    prow(g, 2, 5, 4, m); prow(g, 10, 13, 4, m);
    for (let y = 5; y <= 12; y++) prow(g, 3, 12, y, m);
    pcol(g, 2, 5, 7, m); pcol(g, 13, 5, 7, m);   // sleeve stubs
    pcol(g, 3, 5, 11, M); pcol(g, 12, 5, 11, d);
    prow(g, 3, 12, 12, d);                       // waist shadow
    pset(g, 6, 5, M); pset(g, 9, 5, d);          // collar rim
  },

  armor_legs(g, col) {
    const M = shade(col, 1.4), m = col, d = shade(col, 0.62);
    prow(g, 3, 12, 3, M);                        // belt highlight
    prow(g, 3, 12, 4, m); prow(g, 3, 12, 5, m);
    for (let y = 6; y <= 13; y++) { prow(g, 3, 6, y, m); prow(g, 9, 12, y, m); }
    pcol(g, 6, 6, 13, d); pcol(g, 9, 6, 13, d);  // inner seams
    pcol(g, 3, 6, 12, M);
    prow(g, 3, 6, 13, d); prow(g, 9, 12, 13, d); // hems
  },

  armor_boots(g, col) {
    const M = shade(col, 1.4), m = col, d = shade(col, 0.62);
    for (let y = 7; y <= 9; y++) { prow(g, 3, 6, y, m); prow(g, 10, 13, y, m); }
    prow(g, 3, 6, 7, M); prow(g, 10, 13, 7, M);  // cuff highlights
    for (let y = 10; y <= 12; y++) { prow(g, 2, 7, y, m); prow(g, 9, 14, y, m); }
    prow(g, 2, 7, 12, d); prow(g, 9, 14, 12, d); // soles
  },
};

function drawIcon(item) {
  const S = 32;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  if (item.iconKind === "block" && ICON_ATLAS) {
    drawBlockIcon(ctx, S, item);
    return c;
  }
  const g = newGrid();
  const paint = SPRITES[item.iconKind];
  const col = item.color || "#cccccc";
  if (paint) paint(g, col, item);
  else for (let y = 5; y <= 10; y++) prow(g, 5, 10, y, col);   // fallback square
  blit(ctx, outlined(g, "rgba(24,18,12,0.82)"));
  return c;
}

function drawBlockIcon(ctx, S, item) {
  const block = getBlock(item.blockId);
  const src = ICON_ATLAS.canvas;
  // Sprite blocks (torch, plants) draw as a flat 2D tile, not a cube.
  if (block.render === "cross") {
    const t = ICON_ATLAS.pixelRect(block.tex.all);
    ctx.drawImage(src, t[0], t[1], 16, 16, 6, 3, 20, 26);
    return;
  }
  // 2:1 isometric cube: left/right faces are vertically-skewed parallelograms,
  // the top is a diamond. setTransform maps texture axes to face edges; faces
  // are darkened per-side so the cube reads with a fixed top-left light.
  const left = ICON_ATLAS.pixelRect(texForFace(block, 4));   // +z face
  const right = ICON_ATLAS.pixelRect(texForFace(block, 0));  // +x face
  const top = ICON_ATLAS.pixelRect(texForFace(block, 2));
  ctx.save();
  ctx.setTransform(0.75, 0.375, 0, 0.75, 2, 8);              // left face
  ctx.drawImage(src, left[0], left[1], 16, 16, 0, 0, 16, 16);
  ctx.fillStyle = "rgba(4,4,14,0.20)"; ctx.fillRect(0, 0, 16, 16);
  ctx.setTransform(0.75, -0.375, 0, 0.75, 14, 14);           // right face
  ctx.drawImage(src, right[0], right[1], 16, 16, 0, 0, 16, 16);
  ctx.fillStyle = "rgba(4,4,14,0.38)"; ctx.fillRect(0, 0, 16, 16);
  ctx.setTransform(0.75, 0.375, 0.75, -0.375, 2, 8);         // top diamond
  ctx.drawImage(src, top[0], top[1], 16, 16, 0, 0, 16, 16);
  ctx.restore();
}
