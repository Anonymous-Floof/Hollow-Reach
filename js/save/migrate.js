// Save migration. Each entry MIGRATIONS[n] upgrades a save from version n to
// n+1. On load we run every migration from the file's version up to the current
// SAVE_VERSION, so old saves keep working as the game evolves.
//
// Example for the future:
//   MIGRATIONS[1] = (s) => { s.player.stamina = 20; return s; };

import { SAVE_VERSION } from "./serialize.js";

const MIGRATIONS = {
  // v1 -> v2: block entities (forges/chests) were added; old saves simply have none.
  1: (s) => { s.blockEntities = s.blockEntities || []; return s; },
  // v2 -> v3: world entities (item drops, …) were added; old saves have none.
  2: (s) => { s.entities = s.entities || []; return s; },
};

export function migrateSave(save) {
  let s = save;
  let v = s.version || 1;
  while (v < SAVE_VERSION) {
    const m = MIGRATIONS[v];
    if (m) s = m(s);
    v++;
    s.version = v;
  }
  if (v > SAVE_VERSION) {
    console.warn(`Save is from a newer version (${v}) than this build (${SAVE_VERSION}); loading anyway.`);
  }
  return s;
}
