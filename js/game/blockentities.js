// Block entities: per-position state that lives in the World (not the voxel
// array), so it survives chunk unload/reload and is saved. Forges keep smelting
// while their UI is closed; chests store items. Both spill their contents when
// the block is mined.

import { smeltingFor, fuelValue } from "./crafting.js";

export const CHEST_SLOTS = 27;

export function bePosKey(x, y, z) { return x + "," + y + "," + z; }

export function makeForge() {
  return { kind: "forge", input: null, fuel: null, output: null, fuelLeft: 0, fuelMax: 0, progress: 0 };
}
export function makeChest() {
  return { kind: "chest", slots: new Array(CHEST_SLOTS).fill(null) };
}

// Which block keys carry which block entity.
export function entityKindFor(blockKey) {
  if (blockKey === "forge") return "forge";
  if (blockKey === "chest") return "chest";
  return null;
}
export function makeEntity(kind) {
  return kind === "forge" ? makeForge() : kind === "chest" ? makeChest() : null;
}

// Advance one forge by dt seconds. Pure state machine over its three slots;
// runs every frame from World.tickBlockEntities whether or not the UI is open.
export function tickForge(f, dt) {
  const smelt = f.input ? smeltingFor(f.input.key) : null;
  const canOut = smelt && (!f.output || (f.output.key === smelt.out && f.output.count < 64));
  if (!canOut) { f.progress = 0; if (f.fuelLeft <= 0) f.fuelMax = 0; return; }

  if (f.fuelLeft <= 0 && f.fuel) {
    const v = fuelValue(f.fuel.key);
    if (v > 0) {
      f.fuelLeft += v; f.fuelMax = v;
      f.fuel.count--; if (f.fuel.count <= 0) f.fuel = null;
    }
  }
  if (f.fuelLeft > 0) {
    f.fuelLeft -= dt;
    f.progress += dt;
    if (f.progress >= smelt.time) {
      f.progress = 0;
      if (!f.output) f.output = { key: smelt.out, count: 1 };
      else f.output.count++;
      f.input.count--; if (f.input.count <= 0) f.input = null;
    }
  } else {
    f.progress = 0;
  }
}

// Every stack a block entity holds (for spilling on break).
export function entityContents(be) {
  if (!be) return [];
  if (be.kind === "forge") return [be.input, be.fuel, be.output].filter(Boolean);
  if (be.kind === "chest") return be.slots.filter(Boolean);
  return [];
}

// ---- save / load ----
const packSlot = (s) => s ? [s.key, s.count, s.dura ?? null] : null;
const unpackSlot = (a) => a ? { key: a[0], count: a[1], dura: a[2] ?? undefined } : null;

export function serializeEntities(map) {
  const out = [];
  for (const [key, be] of map) {
    const [x, y, z] = key.split(",").map(Number);
    if (be.kind === "forge") {
      out.push({ pos: [x, y, z], kind: "forge",
        input: packSlot(be.input), fuel: packSlot(be.fuel), output: packSlot(be.output),
        fuelLeft: be.fuelLeft, fuelMax: be.fuelMax, progress: be.progress });
    } else if (be.kind === "chest") {
      out.push({ pos: [x, y, z], kind: "chest", slots: be.slots.map(packSlot) });
    }
  }
  return out;
}

export function deserializeEntities(arr) {
  const map = new Map();
  if (!arr) return map;
  for (const e of arr) {
    const [x, y, z] = e.pos;
    let be;
    if (e.kind === "forge") {
      be = makeForge();
      be.input = unpackSlot(e.input); be.fuel = unpackSlot(e.fuel); be.output = unpackSlot(e.output);
      be.fuelLeft = e.fuelLeft || 0; be.fuelMax = e.fuelMax || 0; be.progress = e.progress || 0;
    } else if (e.kind === "chest") {
      be = makeChest();
      if (e.slots) be.slots = e.slots.map(unpackSlot);
      while (be.slots.length < CHEST_SLOTS) be.slots.push(null);
    } else continue;
    map.set(bePosKey(x, y, z), be);
  }
  return map;
}
