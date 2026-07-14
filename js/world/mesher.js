// Turns a chunk's voxels into renderable geometry. Only faces exposed to
// air/transparent neighbours are emitted. Produces two interleaved vertex
// buffers: opaque (cutout) and water (translucent).
//
// Vertex layout (9 floats): x, y, z, u, v, shade, sky, blockLight, wave
// shade already folds in face brightness * ambient occlusion.
// wave = atmospheric motion flag read by the terrain VS: 0 static, 1 leaf sway,
// 2 water-surface ripple.
//
// PERF: two things that used to dominate are gone here:
//  1) neighbour voxel/light reads go through prefetched typed-array refs to the
//     3x3 chunk neighbourhood, never world.getBlock() (which builds a "cx,cz"
//     string key per call).
//  2) vertices are written straight into a growable Float32Array — no per-vertex
//     sub-arrays and no final Float32Array.from() of a giant JS array.

import { CX, CZ, WH, localIdx, chunkKey } from "./chunk.js";
import { getBlock, OPAQUE, texForFace, BLOCK } from "./blocks.js";
import { SHAPED, renderBoxes } from "./shapes.js";
import { hash2i } from "../core/prng.js";

// face index: 0+x 1-x 2+y 3-y 4+z 5-z  (matches texForFace)
const FACES = [
  { dir: [1, 0, 0], n: 0, sgn: 1, t: 2, b: 1, shade: 0.68 },
  { dir: [-1, 0, 0], n: 0, sgn: -1, t: 2, b: 1, shade: 0.68 },
  { dir: [0, 1, 0], n: 1, sgn: 1, t: 0, b: 2, shade: 1.0 },
  { dir: [0, -1, 0], n: 1, sgn: -1, t: 0, b: 2, shade: 0.5 },
  { dir: [0, 0, 1], n: 2, sgn: 1, t: 0, b: 1, shade: 0.85 },
  { dir: [0, 0, -1], n: 2, sgn: -1, t: 0, b: 1, shade: 0.85 },
];

const AO_LEVELS = [0.5, 0.7, 0.86, 1.0];

// Surface height of a still / source water block (a touch below the cell top, so
// it reads as a liquid with a meniscus rather than a solid cube face).
const WATER_FULL = 0.875;

// Top-face UV rotation for a bed by facing (0:+x 1:-x 2:+z 3:-z) so the pillow
// end always points the way the bed is laid. Verified visually per facing.
const BED_TOP_ROT = [1, 3, 0, 2];

// Growable interleaved vertex buffer (9 floats/vertex; `w` = wave flag, default 0).
class VertBuf {
  constructor() { this.a = new Float32Array(9 * 256); this.n = 0; }
  _grow(need) {
    if (this.n + need <= this.a.length) return;
    let cap = this.a.length * 2;
    while (cap < this.n + need) cap *= 2;
    const b = new Float32Array(cap);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  vert(x, y, z, u, v, s, sk, bl, w = 0) {
    this._grow(9);
    const a = this.a; let n = this.n;
    a[n] = x; a[n + 1] = y; a[n + 2] = z; a[n + 3] = u; a[n + 4] = v;
    a[n + 5] = s; a[n + 6] = sk; a[n + 7] = bl; a[n + 8] = w;
    this.n = n + 9;
  }
  result() { return this.a.subarray(0, this.n); }
}

export function meshChunk(chunk, world, atlas) {
  const opaque = new VertBuf();
  const water = new VertBuf();
  const cx = chunk.cx, cz = chunk.cz;

  // Prefetch the neighbourhood once. grid index = (dz+1)*3 + (dx+1).
  const vox = new Array(9), sky = new Array(9), blk = new Array(9), met = new Array(9);
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const c = world.chunks.get(chunkKey(cx + dx, cz + dz));
      const gi = (dz + 1) * 3 + (dx + 1);
      vox[gi] = c ? c.voxels : null;
      sky[gi] = c ? c.skylight : null;
      blk[gi] = c ? c.blocklight : null;
      met[gi] = c ? c.meta : null;
    }
  const center = vox[4];

  const pick = (lx, lz) => {
    let gx = 1, gz = 1;
    if (lx < 0) gx = 0; else if (lx >= CX) gx = 2;
    if (lz < 0) gz = 0; else if (lz >= CZ) gz = 2;
    return gz * 3 + gx;
  };
  // (lx+CX)&15 == the old (lx+CX)%CX for the -1..CX range these see: CX=CZ=16.
  const voxAt = (lx, ly, lz) => {
    if (ly < 0) return BLOCK.bedrock;
    if (ly >= WH) return BLOCK.air;
    const a = vox[pick(lx, lz)];
    return a ? a[localIdx((lx + CX) & 15, ly, (lz + CZ) & 15)] : BLOCK.air;
  };
  const skyAt = (lx, ly, lz) => {
    if (ly < 0) return 0;
    if (ly >= WH) return 15;
    const a = sky[pick(lx, lz)];
    return a ? a[localIdx((lx + CX) & 15, ly, (lz + CZ) & 15)] : 15;
  };
  const blkAt = (lx, ly, lz) => {
    if (ly < 0 || ly >= WH) return 0;
    const a = blk[pick(lx, lz)];
    return a ? a[localIdx((lx + CX) & 15, ly, (lz + CZ) & 15)] : 0;
  };
  const metaAt = (lx, ly, lz) => {
    if (ly < 0 || ly >= WH) return 0;
    const a = met[pick(lx, lz)];
    return a ? a[localIdx((lx + CX) & 15, ly, (lz + CZ) & 15)] : 0;
  };
  const opaqueAt = (lx, ly, lz) => OPAQUE[voxAt(lx, ly, lz)] === 1;
  const isWaterAt = (lx, ly, lz) => voxAt(lx, ly, lz) === BLOCK.water;

  // Visible surface height (0..1) of a water cell; -1 if it isn't water. A cell
  // with water above is "submerged" and rendered as a full column (1.0) so the
  // body has no internal seam; a source / falling cell sits at FULL; a flowing
  // cell (level 1..7) drops toward the thin film at 1/9.
  const fluidH = (lx, ly, lz) => {
    if (!isWaterAt(lx, ly, lz)) return -1;
    if (isWaterAt(lx, ly + 1, lz)) return 1.0;
    const m = metaAt(lx, ly, lz);
    if (m === 0 || (m & 8)) return WATER_FULL;
    return (8 - (m & 7)) / 9;
  };
  // Height of one top corner = average of the (up to four) water cells meeting at
  // it. Land cells are skipped, so the surface droops smoothly toward shores.
  const cornerH = (lx, ly, lz, sx, sz) => {
    let sum = 0, cnt = 0;
    const a = fluidH(lx, ly, lz);            if (a >= 0) { sum += a; cnt++; }
    const b = fluidH(lx + sx, ly, lz);       if (b >= 0) { sum += b; cnt++; }
    const c = fluidH(lx, ly, lz + sz);       if (c >= 0) { sum += c; cnt++; }
    const d = fluidH(lx + sx, ly, lz + sz);  if (d >= 0) { sum += d; cnt++; }
    return cnt ? sum / cnt : WATER_FULL;
  };

  for (let y = 0; y < WH; y++) {
    for (let z = 0; z < CZ; z++) {
      for (let x = 0; x < CX; x++) {
        const id = center[localIdx(x, y, z)];
        if (id === 0) continue;
        const b = getBlock(id);
        const wx = cx * CX + x, wy = y, wz = cz * CZ + z;

        if (b.render === "cross") {
          if (b.plant) emitPlant(opaque, wx, wy, wz, atlas, b, chunk, x, y, z);
          else emitCross(opaque, wx, wy, wz, atlas, b, chunk, x, y, z);
          continue;
        }
        if (SHAPED.has(b.render)) {
          emitBoxes(opaque, x, y, z, wx, wy, wz, b, chunk.meta[localIdx(x, y, z)], atlas, opaqueAt, skyAt, blkAt);
          continue;
        }

        if (b.render === "liquid") {
          emitWater(water, x, y, z, wx, wy, wz, atlas, fluidH, cornerH, isWaterAt, opaqueAt, skyAt, blkAt);
          continue;
        }

        for (let fi = 0; fi < 6; fi++) {
          const f = FACES[fi];
          const alx = x + f.dir[0], aly = y + f.dir[1], alz = z + f.dir[2];
          if (!faceVisible(id, voxAt(alx, aly, alz), b)) continue;
          emitFace(opaque, wx, wy, wz, fi, f, atlas, b, skyAt, blkAt, opaqueAt, alx, aly, alz);
        }
      }
    }
  }

  return { opaque: opaque.result(), water: water.result() };
}

function faceVisible(selfId, neighborId, selfBlock) {
  if (neighborId === 0) return true;            // air
  if (OPAQUE[neighborId]) return false;         // fully hidden
  return neighborId !== selfId;                 // merge same transparent (glass/leaves/water)
}

// alx/aly/alz are the chunk-local coords of the air cell this face looks into.
function emitFace(out, wx, wy, wz, fi, f, atlas, block, skyAt, blkAt, opaqueAt, alx, aly, alz) {
  const uv = atlas.uvForName(texForFace(block, fi));
  const u0 = uv[0], v0 = uv[1], u1 = uv[2], v1 = uv[3];
  // atmospheric motion: leaves sway as a whole, water ripples only on its top
  // surface (so the static side faces keep the column sealed against terrain).
  const wave = block.leaf ? 1 : (block.render === "liquid" && fi === 2 ? 2 : 0);

  const nAxis = f.n, tAxis = f.t, bAxis = f.b;
  const dt0 = tAxis === 0 ? 1 : 0, dt1 = tAxis === 1 ? 1 : 0, dt2 = tAxis === 2 ? 1 : 0;
  const db0 = bAxis === 0 ? 1 : 0, db1 = bAxis === 1 ? 1 : 0, db2 = bAxis === 2 ? 1 : 0;
  const nOff = f.sgn > 0 ? 1 : 0;

  // The face looks into one air cell; that cell always contributes light.
  const skyC = skyAt(alx, aly, alz), blkC = blkAt(alx, aly, alz);

  // Per-corner attributes (i = tangent, j = bitangent). Light is SMOOTHED: each
  // vertex averages the (non-occluded) cells touching that corner on the air
  // side — the classic Minecraft "smooth lighting", so light flows across faces
  // instead of stepping per face.
  const px = [0, 0, 0, 0], py = [0, 0, 0, 0], pz = [0, 0, 0, 0];
  const cu = [0, 0, 0, 0], cv = [0, 0, 0, 0], cs = [0, 0, 0, 0];
  const csk = [0, 0, 0, 0], cbl = [0, 0, 0, 0];
  let k = 0;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      let x = wx, y = wy, z = wz;
      if (nAxis === 0) x += nOff; else if (nAxis === 1) y += nOff; else z += nOff;
      x += dt0 * i + db0 * j; y += dt1 * i + db1 * j; z += dt2 * i + db2 * j;
      const si = 2 * i - 1, sj = 2 * j - 1;
      // the three neighbour cells sharing this corner (on the air side)
      const ix = alx + dt0 * si, iy = aly + dt1 * si, iz = alz + dt2 * si;             // edge along tangent
      const jx = alx + db0 * sj, jy = aly + db1 * sj, jz = alz + db2 * sj;             // edge along bitangent
      const dx = alx + dt0 * si + db0 * sj, dy = aly + dt1 * si + db1 * sj, dz = alz + dt2 * si + db2 * sj; // diagonal
      const su = opaqueAt(ix, iy, iz) ? 1 : 0;
      const sv = opaqueAt(jx, jy, jz) ? 1 : 0;
      const sc = opaqueAt(dx, dy, dz) ? 1 : 0;
      const ao = (su && sv) ? 0 : 3 - (su + sv + sc);
      // average light over the air cell + each non-opaque neighbour (the diagonal
      // only counts when it isn't sealed off by both edge blocks).
      let ssum = skyC, bsum = blkC, cnt = 1;
      if (!su) { ssum += skyAt(ix, iy, iz); bsum += blkAt(ix, iy, iz); cnt++; }
      if (!sv) { ssum += skyAt(jx, jy, jz); bsum += blkAt(jx, jy, jz); cnt++; }
      if (!sc && !(su && sv)) { ssum += skyAt(dx, dy, dz); bsum += blkAt(dx, dy, dz); cnt++; }
      px[k] = x; py[k] = y; pz[k] = z;
      cu[k] = i ? u1 : u0; cv[k] = j ? v0 : v1; cs[k] = f.shade * AO_LEVELS[ao];
      csk[k] = ssum / cnt / 15; cbl[k] = bsum / cnt / 15;
      k++;
    }
  }

  // corners [0,1,2,3] = [i0j0, i1j0, i0j1, i1j1] -> triangles (0,1,3) (0,3,2)
  const order = [0, 1, 3, 0, 3, 2];
  for (let o = 0; o < 6; o++) {
    const c = order[o];
    out.vert(px[c], py[c], pz[c], cu[c], cv[c], cs[c], csk[c], cbl[c], wave);
  }
}

// Water: a variable-height liquid. The top surface is a quad whose four corners
// take the averaged height of the water around them (so flowing water visibly
// slopes down as it thins and droops toward shores). Side faces are emitted only
// where a cell is open to air and span from the cell floor up to the sloped top
// edge; bottom faces appear only under an overhang. Neighbouring water merges
// (no internal faces), matching the old translucent-merge behaviour.
function emitWater(out, lx, ly, lz, wx, wy, wz, atlas, fluidH, cornerH, isWaterAt, opaqueAt, skyAt, blkAt) {
  const uv = atlas.uvForName("water");
  const u0 = uv[0], v0 = uv[1], u1 = uv[2], v1 = uv[3];

  const h00 = wy + cornerH(lx, ly, lz, -1, -1);   // corner at (wx,   wz)
  const h10 = wy + cornerH(lx, ly, lz, +1, -1);   // corner at (wx+1, wz)
  const h01 = wy + cornerH(lx, ly, lz, -1, +1);   // corner at (wx,   wz+1)
  const h11 = wy + cornerH(lx, ly, lz, +1, +1);   // corner at (wx+1, wz+1)
  const X0 = wx, X1 = wx + 1, Z0 = wz, Z1 = wz + 1;
  const submerged = isWaterAt(lx, ly + 1, lz);

  // A general quad (two tris) with a flat tile UV. p* are [x,y,z]; wA is the wave
  // flag for the first edge (p0,p1), wB for the second (p2,p3) — sides pass wA=0
  // (static floor edge) and wB=2 so their top edge ripples in lockstep with the
  // surface and the two never pull apart.
  const quad = (p0, p1, p2, p3, shade, sk, bl, wA, wB) => {
    const W = (p, u, v, w) => out.vert(p[0], p[1], p[2], u, v, shade, sk, bl, w);
    W(p0, u0, v1, wA); W(p1, u1, v1, wA); W(p2, u1, v0, wB);
    W(p0, u0, v1, wA); W(p2, u1, v0, wB); W(p3, u0, v0, wB);
  };

  // ---- top surface (omit when submerged: the column carries on upward) ----
  if (!submerged) {
    const sk = skyAt(lx, ly + 1, lz) / 15, bl = blkAt(lx, ly + 1, lz) / 15;
    // corners CCW seen from above: (X0,Z0)(X1,Z0)(X1,Z1)(X0,Z1)
    quad([X0, h00, Z0], [X1, h10, Z0], [X1, h11, Z1], [X0, h01, Z1], 1.0, sk, bl, 2, 2);
  }

  // ---- side faces (only where the neighbour is open air / non-water) ----
  // p0,p1 = floor edge (always static), p2,p3 = top edge following the slope. The
  // top edge only ripples (wave 2) on the actual surface cell; a submerged column
  // keeps a static full-height edge so deep walls tile seamlessly.
  const topWave = submerged ? 0 : 2;
  const sideOpen = (ax, ay, az) => !isWaterAt(ax, ay, az) && !opaqueAt(ax, ay, az);

  // +x
  if (sideOpen(lx + 1, ly, lz)) {
    const sk = skyAt(lx + 1, ly, lz) / 15, bl = blkAt(lx + 1, ly, lz) / 15;
    quad([X1, wy, Z0], [X1, wy, Z1], [X1, h11, Z1], [X1, h10, Z0], 0.68, sk, bl, 0, topWave);
  }
  // -x
  if (sideOpen(lx - 1, ly, lz)) {
    const sk = skyAt(lx - 1, ly, lz) / 15, bl = blkAt(lx - 1, ly, lz) / 15;
    quad([X0, wy, Z1], [X0, wy, Z0], [X0, h00, Z0], [X0, h01, Z1], 0.68, sk, bl, 0, topWave);
  }
  // +z
  if (sideOpen(lx, ly, lz + 1)) {
    const sk = skyAt(lx, ly, lz + 1) / 15, bl = blkAt(lx, ly, lz + 1) / 15;
    quad([X1, wy, Z1], [X0, wy, Z1], [X0, h01, Z1], [X1, h11, Z1], 0.85, sk, bl, 0, topWave);
  }
  // -z
  if (sideOpen(lx, ly, lz - 1)) {
    const sk = skyAt(lx, ly, lz - 1) / 15, bl = blkAt(lx, ly, lz - 1) / 15;
    quad([X0, wy, Z0], [X1, wy, Z0], [X1, h10, Z0], [X0, h00, Z0], 0.85, sk, bl, 0, topWave);
  }
  // bottom (only under an overhang — i.e. open air below): flat, static.
  if (sideOpen(lx, ly - 1, lz)) {
    const sk = skyAt(lx, ly - 1, lz) / 15, bl = blkAt(lx, ly - 1, lz) / 15;
    quad([X0, wy, Z1], [X1, wy, Z1], [X1, wy, Z0], [X0, wy, Z0], 0.5, sk, bl, 0, 0);
  }
}

// Shaped blocks (stairs/ladders/trapdoors/doors): emit each sub-box as a small
// textured cuboid. Faces flush with the cell boundary are culled against opaque
// neighbours; light is sampled from the block's own (non-opaque) cell.
function emitBoxes(out, lx, ly, lz, wx, wy, wz, block, meta, atlas, opaqueAt, skyAt, blkAt) {
  const boxes = renderBoxes(block.render, meta);
  if (!boxes) return;
  const skyL = skyAt(lx, ly, lz) / 15;
  const blkL = blkAt(lx, ly, lz) / 15;

  // Bed: the foot cell (meta bit2 = 0) shows the blanket tile on its top face;
  // the head cell shows the pillow tile (the block's default top texture).
  const texName = (fi) => {
    if (block.render === "bed" && fi === 2 && !(meta & 4)) return block.tex.foot;
    return texForFace(block, fi);
  };
  // The bed's top texture must turn with the block, so the pillow always sits at
  // the head end. Rotate the four top-face UV corners by facing (foot->head dir).
  const bedRot = block.render === "bed" ? BED_TOP_ROT[meta & 3] : 0;
  const quad = (fi, shade, p0, p1, p2, p3) => {
    const uv = atlas.uvForName(texName(fi));
    const u0 = uv[0], v0 = uv[1], u1 = uv[2], v1 = uv[3];
    let c = [[u0, v1], [u1, v1], [u1, v0], [u0, v0]];      // UVs for p0,p1,p2,p3
    if (fi === 2 && bedRot) c = [c[bedRot & 3], c[(bedRot + 1) & 3], c[(bedRot + 2) & 3], c[(bedRot + 3) & 3]];
    const P = [p0, p1, p2, p3];
    const w = (i) => out.vert(P[i][0], P[i][1], P[i][2], c[i][0], c[i][1], shade, skyL, blkL);
    w(0); w(1); w(2); w(0); w(2); w(3);
  };

  for (const bx of boxes) {
    const x0 = wx + bx[0], y0 = wy + bx[1], z0 = wz + bx[2];
    const x1 = wx + bx[3], y1 = wy + bx[4], z1 = wz + bx[5];
    const flush0 = (v) => v === 0, flush1 = (v) => v === 1;

    if (!(flush1(bx[3]) && opaqueAt(lx + 1, ly, lz))) quad(0, 0.68, [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]);
    if (!(flush0(bx[0]) && opaqueAt(lx - 1, ly, lz))) quad(1, 0.68, [x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]);
    if (!(flush1(bx[4]) && opaqueAt(lx, ly + 1, lz))) quad(2, 1.00, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]);
    if (!(flush0(bx[1]) && opaqueAt(lx, ly - 1, lz))) quad(3, 0.50, [x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]);
    if (!(flush1(bx[5]) && opaqueAt(lx, ly, lz + 1))) quad(4, 0.85, [x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]);
    if (!(flush0(bx[2]) && opaqueAt(lx, ly, lz - 1))) quad(5, 0.85, [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]);
  }
}

// Torch: a thin post rendered as two crossed billboards running base -> top.
// meta 0 = standing on the floor; 1-4 = mounted on a wall (1:+x 2:-x 3:+z 4:-z
// into-room direction) so it sits against the wall and leans out and up.
const TORCH_DIR = [null, [1, 0], [-1, 0], [0, 1], [0, -1]];
function emitCross(out, wx, wy, wz, atlas, block, chunk, lx, ly, lz) {
  const uv = atlas.uvForName(block.tex.all);
  const u0 = uv[0], v0 = uv[1], u1 = uv[2], v1 = uv[3];
  const skyL = chunk.skylight[localIdx(lx, ly, lz)] / 15;
  const blkL = chunk.blocklight[localIdx(lx, ly, lz)] / 15;
  const s = 1.0, hw = 0.09, H = 0.625;

  let bx = wx + 0.5, bz = wz + 0.5, by = wy;          // base (floor torch)
  let tx = wx + 0.5, tz = wz + 0.5, ty = wy + H;      // top
  const d = TORCH_DIR[chunk.meta[localIdx(lx, ly, lz)] & 7];
  if (d) {
    by = wy + 0.18;                                   // sit up the wall a little
    bx = wx + 0.5 - d[0] * 0.42; bz = wz + 0.5 - d[1] * 0.42;   // base against the wall
    tx = wx + 0.5 + d[0] * 0.18; tz = wz + 0.5 + d[1] * 0.18;   // top leans into the room
    ty = by + H;
  }
  // a billboard whose horizontal span is along (ox,oz): bottom edge at base, top at top
  const plane = (ox, oz) => {
    out.vert(bx - ox, by, bz - oz, u0, v1, s, skyL, blkL);
    out.vert(bx + ox, by, bz + oz, u1, v1, s, skyL, blkL);
    out.vert(tx + ox, ty, tz + oz, u1, v0, s, skyL, blkL);
    out.vert(bx - ox, by, bz - oz, u0, v1, s, skyL, blkL);
    out.vert(tx + ox, ty, tz + oz, u1, v0, s, skyL, blkL);
    out.vert(tx - ox, ty, tz - oz, u0, v0, s, skyL, blkL);
  };
  plane(hw, 0);   // faces ±z
  plane(0, hw);   // faces ±x
}

// Plant (tall grass / flower / mushroom / greeble): an X of two crossed
// billboards rising from the ground to plantH. Each plant gets a small
// deterministic offset + rotation from its world position so a meadow doesn't
// look grid-stamped. The base verts are static (wave 0, planted) and the top
// verts carry the leaf-sway flag (wave 1) so tufts bend in the wind from the top
// while staying rooted. Unshaded (like the torch); lighting comes from the cell.
function emitPlant(out, wx, wy, wz, atlas, block, chunk, lx, ly, lz) {
  const uv = atlas.uvForName(block.tex.all);
  const u0 = uv[0], v0 = uv[1], u1 = uv[2], v1 = uv[3];
  const skyL = chunk.skylight[localIdx(lx, ly, lz)] / 15;
  const blkL = chunk.blocklight[localIdx(lx, ly, lz)] / 15;
  const H = block.plantH || 0.9, r = block.plantR || 0.45;

  // deterministic per-cell jitter: nudge off-centre and spin the X a little
  const ang = hash2i(0x91b7, wx, wz) * 1.5707963;
  const ox = (hash2i(0x33a1, wx, wz) - 0.5) * 0.22;
  const oz = (hash2i(0x77c5, wx, wz) - 0.5) * 0.22;
  const cxp = wx + 0.5 + ox, czp = wz + 0.5 + oz, y0 = wy, y1 = wy + H;
  const ca = Math.cos(ang) * r, sa = Math.sin(ang) * r;

  // one billboard spanning ±(dx,dz) horizontally, y0..y1 vertically
  const quad = (dx, dz) => {
    out.vert(cxp - dx, y0, czp - dz, u0, v1, 1.0, skyL, blkL, 0);
    out.vert(cxp + dx, y0, czp + dz, u1, v1, 1.0, skyL, blkL, 0);
    out.vert(cxp + dx, y1, czp + dz, u1, v0, 1.0, skyL, blkL, 1);
    out.vert(cxp - dx, y0, czp - dz, u0, v1, 1.0, skyL, blkL, 0);
    out.vert(cxp + dx, y1, czp + dz, u1, v0, 1.0, skyL, blkL, 1);
    out.vert(cxp - dx, y1, czp - dz, u0, v0, 1.0, skyL, blkL, 1);
  };
  quad(ca, sa);
  quad(-sa, ca);
}
