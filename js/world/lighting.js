// Per-chunk lighting: skylight + block light, both as BFS flood fills so light
// spreads horizontally into mined tunnels and cave mouths (not just straight
// down). Values bake into the mesh, so day/night only scales skylight in the
// shader and never forces a re-mesh.
//
// Lighting is chunk-local with one-cell neighbour seeding: light crosses a
// chunk border by one step per relight. Editing a block dirties the touched
// border neighbours too, so local edits re-converge.
//
// PERF: neighbour light is read through prefetched typed-array references (like
// the mesher), not world.getSkyWorld() string-key lookups.

import { CX, CZ, WH, localIdx, chunkKey } from "./chunk.js";
import { OPAQUE, emitOf } from "./blocks.js";

// Flat direction tables (indexed loops — no per-iteration destructuring in the
// BFS inner loop).
const DIRX = [1, -1, 0, 0, 0, 0];
const DIRY = [0, 0, 1, 0, 0, -1];
const DIRZ = [0, 0, 0, 1, -1, 0];

// Shared BFS: drain `queue` of lit cells, spreading level-1 to non-opaque
// neighbours within this chunk.
//
// Queue entries ARE localIdx values ((y*CZ+z)*CX+x), so neighbour indices are
// plain offsets: ±1 in x, ±CX in z, ±CX*CZ in y (with edge guards decoded via
// bit ops — CX and CZ are 16, so x = i&15, z = (i>>4)&15, y = i>>8).
function flood(queue, level, v) {
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const cur = level[i];
    if (cur <= 1) continue;
    const nv = cur - 1;
    const x = i & 15, z = (i >> 4) & 15, y = i >> 8;
    let ni;
    if (x < 15)     { ni = i + 1;   if (!OPAQUE[v[ni]] && level[ni] < nv) { level[ni] = nv; queue.push(ni); } }
    if (x > 0)      { ni = i - 1;   if (!OPAQUE[v[ni]] && level[ni] < nv) { level[ni] = nv; queue.push(ni); } }
    if (z < 15)     { ni = i + 16;  if (!OPAQUE[v[ni]] && level[ni] < nv) { level[ni] = nv; queue.push(ni); } }
    if (z > 0)      { ni = i - 16;  if (!OPAQUE[v[ni]] && level[ni] < nv) { level[ni] = nv; queue.push(ni); } }
    if (y < WH - 1) { ni = i + 256; if (!OPAQUE[v[ni]] && level[ni] < nv) { level[ni] = nv; queue.push(ni); } }
    if (y > 0)      { ni = i - 256; if (!OPAQUE[v[ni]] && level[ni] < nv) { level[ni] = nv; queue.push(ni); } }
  }
}

// Raise border cells from already-lit neighbour chunks. `nbr` is the prefetched
// 3x3 light array grid; aboveVal is what cells above the world contribute
// (15 sky, 0 block). Unknown neighbour chunks contribute nothing.
function seedBorders(chunk, v, level, queue, nbr, aboveVal) {
  const sample = (lx, ly, lz) => {
    if (ly < 0) return 0;
    if (ly >= WH) return aboveVal;
    let gx = 1, gz = 1;
    if (lx < 0) gx = 0; else if (lx >= CX) gx = 2;
    if (lz < 0) gz = 0; else if (lz >= CZ) gz = 2;
    const a = nbr[gz * 3 + gx];
    return a ? a[localIdx((lx + CX) & 15, ly, (lz + CZ) & 15)] : 0;
  };
  const seed = (x, y, z) => {
    const i = localIdx(x, y, z);
    if (OPAQUE[v[i]]) return;
    let best = 0;
    for (let d = 0; d < 6; d++) {
      const nl = sample(x + DIRX[d], y + DIRY[d], z + DIRZ[d]) - 1;
      if (nl > best) best = nl;
    }
    if (best > level[i]) { level[i] = best; queue.push((y * CZ + z) * CX + x); }
  };
  for (let y = 0; y < WH; y++) {
    for (let x = 0; x < CX; x++) { seed(x, y, 0); seed(x, y, CZ - 1); }
    for (let z = 0; z < CZ; z++) { seed(0, y, z); seed(CX - 1, y, z); }
  }
}

export function computeLight(chunk, world) {
  const v = chunk.voxels;
  const sky = chunk.skylight;
  const blk = chunk.blocklight;
  sky.fill(0);
  blk.fill(0);

  // Prefetch the neighbourhood's light arrays (grid idx = (dz+1)*3 + (dx+1)).
  const cx = chunk.cx, cz = chunk.cz;
  const nSky = new Array(9), nBlk = new Array(9);
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const c = world.chunks.get(chunkKey(cx + dx, cz + dz));
      const gi = (dz + 1) * 3 + (dx + 1);
      nSky[gi] = c ? c.skylight : null;
      nBlk[gi] = c ? c.blocklight : null;
    }

  // ---- skylight: sun pours straight down at full strength, then floods out ----
  const skyQ = [];
  for (let z = 0; z < CZ; z++) {
    for (let x = 0; x < CX; x++) {
      let lit = true;
      for (let y = WH - 1; y >= 0; y--) {
        const i = localIdx(x, y, z);
        if (lit && OPAQUE[v[i]]) lit = false;
        if (lit) { sky[i] = 15; skyQ.push(i); }
      }
    }
  }
  seedBorders(chunk, v, sky, skyQ, nSky, 15);
  flood(skyQ, sky, v);

  // ---- block light: emitters (torches/glowing ore) + neighbour seeding ----
  const blkQ = [];
  const emitters = [];
  const baseX = cx * CX, baseZ = cz * CZ;
  // linear scan: (y,z,x) iteration order IS the localIdx order, so walk the
  // typed array directly and decode coords only for the rare emitter hit
  for (let i = 0; i < v.length; i++) {
    const e = emitOf(v[i]);
    if (e > 0) {
      blk[i] = e;
      blkQ.push(i);
      emitters.push({ x: baseX + (i & 15) + 0.5, y: (i >> 8) + 0.5, z: baseZ + ((i >> 4) & 15) + 0.5, id: v[i] });
    }
  }
  chunk.emitters = emitters;
  seedBorders(chunk, v, blk, blkQ, nBlk, 0);
  flood(blkQ, blk, v);

  chunk.lightDirty = false;
}
