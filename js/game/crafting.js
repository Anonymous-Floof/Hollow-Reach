// Recipe matching for the crafting grid + smelting lookups for the forge.
// Grids are flat arrays of length size*size whose cells are slot objects
// ({key,count}) or null.

import { RECIPES, SMELTING, FUEL } from "./recipes.js";
import { ingredientMatches, getBlock, tagRepr } from "../world/blocks.js";
import { getItem } from "./items.js";

// Pre-parse shaped patterns into trimmed cell maps once.
const PARSED = RECIPES.map((r) => {
  if (r.type !== "shaped") return r;
  const rows = r.pattern;
  const h = rows.length, w = Math.max(...rows.map((s) => s.length));
  const cells = []; // {r,c,key}
  for (let rr = 0; rr < h; rr++)
    for (let cc = 0; cc < w; cc++) {
      const ch = rows[rr][cc] || " ";
      if (ch !== " " && ch !== ".") cells.push({ r: rr, c: cc, key: r.legend[ch] });
    }
  return { ...r, _w: w, _h: h, _cells: cells };
});

function stationAllows(recipeStation, station) {
  if (recipeStation === "hand") return true;        // hand recipes work anywhere
  return recipeStation === station;                 // workbench recipes need workbench
}

// Find a recipe that matches the grid. Returns { out, recipe } or null.
export function matchGrid(grid, size, station) {
  // bounding box of filled cells
  let minR = 99, maxR = -1, minC = 99, maxC = -1, filled = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i]) {
      const r = (i / size) | 0, c = i % size;
      minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      minC = Math.min(minC, c); maxC = Math.max(maxC, c);
      filled++;
    }
  }
  if (filled === 0) return null;

  for (const r of PARSED) {
    if (!stationAllows(r.station, station)) continue;
    if (r.type === "shapeless") {
      const need = r.in;
      const counts = {};
      for (const cell of grid) if (cell) counts[cell.key] = (counts[cell.key] || 0) + 1;
      const keys = Object.keys(need);
      if (keys.length !== Object.keys(counts).length) continue;
      let ok = true;
      for (const k of keys) if ((counts[k] || 0) !== need[k]) { ok = false; break; }
      if (ok) return { out: r.out, recipe: r };
    } else {
      const bw = maxC - minC + 1, bh = maxR - minR + 1;
      if (bw !== r._w || bh !== r._h) continue;
      if (filled !== r._cells.length) continue;
      let ok = true;
      for (const cell of r._cells) {
        const gi = (minR + cell.r) * size + (minC + cell.c);
        const g = grid[gi];
        if (!g || !ingredientMatches(cell.key, g.key)) { ok = false; break; }
      }
      if (ok) return { out: r.out, recipe: r };
    }
  }
  return null;
}

// Remove one craft worth of ingredients from the grid (decrement each used cell).
export function consumeGrid(grid, size, recipe) {
  if (recipe.type === "shapeless") {
    const used = { ...recipe.in };
    for (let i = 0; i < grid.length; i++) {
      const g = grid[i];
      if (g && used[g.key] > 0) {
        g.count -= 1; used[g.key] -= 1;
        if (g.count <= 0) grid[i] = null;
      }
    }
  } else {
    // re-find bounding box origin
    let minR = 99, minC = 99;
    for (let i = 0; i < grid.length; i++) if (grid[i]) {
      minR = Math.min(minR, (i / size) | 0); minC = Math.min(minC, i % size);
    }
    const parsed = PARSED.find((p) => p === recipe) || recipe;
    for (const cell of parsed._cells) {
      const gi = (minR + cell.r) * size + (minC + cell.c);
      const g = grid[gi];
      if (g) { g.count -= 1; if (g.count <= 0) grid[gi] = null; }
    }
  }
}

export function smeltingFor(key) {
  return SMELTING.find((s) => s.in === key) || null;
}

// Base fuels: the explicit raws in FUEL, plus anything flagged as a plank or log
// (so every wood type — current and future — is a base fuel with no extra entry).
function baseFuel(key) {
  if (FUEL[key]) return FUEL[key];
  const it = getItem(key);
  if (it && it.type === "block") {
    const b = getBlock(it.blockId);
    if (b && b.plank) return 9;
    if (b && b.log) return 12;
  }
  return 0;
}

// Auto-detected burn time. An item is fuel only if SOME recipe makes it entirely
// from fuel ingredients; its burn time = summed ingredient fuel / output count.
// So wooden tools, chests, boats, wooden stairs/doors, and torches (coal+stick)
// all burn automatically, while anything containing stone/metal/wool does not —
// and new wooden recipes need no FUEL entry. Results are cached.
const _fuel = {};
export function fuelValue(key) {
  if (key && key[0] === "#") return fuelValue(tagRepr(key));   // ingredient tag
  if (key in _fuel) return _fuel[key];
  const base = baseFuel(key);
  if (base > 0) { _fuel[key] = base; return base; }
  _fuel[key] = 0;                                              // guard against recipe cycles
  let best = 0;
  for (const r of RECIPES) {
    if (r.out.key !== key) continue;
    const ings = recipeIngredients(r);
    if (!ings.length) continue;
    let total = 0, ok = true;
    for (const ing of ings) {
      const fv = fuelValue(ing.key);
      if (fv <= 0) { ok = false; break; }
      total += fv * ing.count;
    }
    if (ok) { const per = total / (r.out.count || 1); if (per > best) best = per; }
  }
  _fuel[key] = best;
  return best;
}

function recipeIngredients(r) {
  if (r.type === "shapeless") return Object.entries(r.in).map(([key, count]) => ({ key, count }));
  const counts = {};
  for (const row of r.pattern) for (const ch of row) {
    if (ch === " " || ch === ".") continue;
    const k = r.legend[ch];
    if (k) counts[k] = (counts[k] || 0) + 1;
  }
  return Object.entries(counts).map(([key, count]) => ({ key, count }));
}
