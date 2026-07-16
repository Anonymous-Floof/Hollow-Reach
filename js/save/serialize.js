// Converts a live world/player/inventory into a compact, version-stable save
// object and back. Only player-changed blocks are stored (the rest regenerates
// from the seed). Blocks are stored by their stable string `key`, not numeric
// id, so reordering the block table in future versions never corrupts saves.

import { BLOCKS, BLOCK, AIR } from "../world/blocks.js";
import { serializeEntities, deserializeEntities } from "../game/blockentities.js";

export const SAVE_VERSION = 3;

export function serialize(world, player, inventory, meta) {
  const edits = {};
  for (const [key, m] of world.edits) {
    const arr = [];
    for (const [li, packed] of m) {
      const id = packed & 1023, meta = (packed >> 10) & 0x3f;
      const blockKey = BLOCKS[id] ? BLOCKS[id].key : "air";
      arr.push(meta ? [li, blockKey, meta] : [li, blockKey]);
    }
    if (arr.length) edits[key] = arr;
  }
  return {
    version: SAVE_VERSION,
    id: meta.id,
    name: meta.name,
    seed: world.seed,
    genVersion: world.genVer || 1,
    // player-set spawn point (Soul Anchor) — absent means "derive the default"
    spawn: meta.spawn || undefined,
    // atlas map waypoints (custom + death markers)
    waypoints: meta.waypoints && meta.waypoints.length ? meta.waypoints : undefined,
    // chunks ever generated — the atlas only maps explored ground (fog of war)
    explored: world.explored && world.explored.size ? [...world.explored] : undefined,
    createdAt: meta.createdAt || Date.now(),
    savedAt: Date.now(),
    player: player.toJSON(),
    inventory: inventory.toJSON(),
    time: meta.time ?? 0.32,
    edits,
    blockEntities: serializeEntities(world.blockEntities),
    entities: world.entities.serialize(),
    // multiplayer guests' progress (position/inventory by player id), so a
    // friend rejoining this world picks up where they left off
    remotePlayers: meta.remotePlayers || undefined,
  };
}

// Rebuild the world's block-entity map (forges/chests) from a save.
export function deserializeBlockEntities(save) {
  return deserializeEntities(save.blockEntities);
}

// Returns { seed, player, inventory, editsMap, time, name, id, createdAt }.
export function deserializeEdits(save) {
  const map = new Map();
  if (save.edits) {
    for (const k in save.edits) {
      const m = new Map();
      for (const [li, blockKey, meta] of save.edits[k]) {
        const id = BLOCK[blockKey] ?? AIR;
        m.set(li, id | ((meta || 0) << 10));
      }
      map.set(k, m);
    }
  }
  return map;
}
