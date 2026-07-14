// A chunk is a vertical column of voxels CX x WH x CZ. It stores block ids and
// two light channels (skylight + block light). Meshes/GL buffers are attached
// by the renderer side and tracked with dirty flags.

export const CX = 16;   // chunk width  (x)
export const CZ = 16;   // chunk depth  (z)
export const WH = 128;  // world height (y)

export function localIdx(x, y, z) { return (y * CZ + z) * CX + x; }

export function chunkKey(cx, cz) { return cx + "," + cz; }

export class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.voxels = new Uint16Array(CX * WH * CZ);
    // Per-cell metadata byte: orientation/state for shaped blocks (stairs,
    // ladders, trapdoors, doors) and a "persistent" flag for placed leaves.
    this.meta = new Uint8Array(CX * WH * CZ);
    this.skylight = new Uint8Array(CX * WH * CZ);
    this.blocklight = new Uint8Array(CX * WH * CZ);
    this.generated = false;
    this.meshDirty = true;
    this.lightDirty = true;
    // GL mesh handles { vao, vbo, count } for the opaque and translucent passes.
    this.meshOpaque = null;
    this.meshWater = null;
    // Emitter cells (torches / glowing ore) found during the light pass, as
    // {x,y,z (world-centre), id} — the deferred renderer gathers nearby ones into
    // its coloured point-light list each frame instead of rescanning voxels.
    this.emitters = [];
  }

  inBounds(y) { return y >= 0 && y < WH; }

  get(x, y, z) {
    if (y < 0 || y >= WH) return 0;
    return this.voxels[localIdx(x, y, z)];
  }
  set(x, y, z, v) {
    if (y < 0 || y >= WH) return;
    this.voxels[localIdx(x, y, z)] = v;
  }
  getSky(x, y, z) { return y < 0 || y >= WH ? 15 : this.skylight[localIdx(x, y, z)]; }
  getBlockLight(x, y, z) { return y < 0 || y >= WH ? 0 : this.blocklight[localIdx(x, y, z)]; }

  worldX(x) { return this.cx * CX + x; }
  worldZ(z) { return this.cz * CZ + z; }
}
