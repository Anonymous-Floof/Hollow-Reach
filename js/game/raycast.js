// Voxel ray cast (Amanatides & Woo DDA). Used to find the block the player is
// looking at and the adjacent cell to place into.

import { getBlock } from "../world/blocks.js";

// Returns null or { x, y, z, nx, ny, nz } where (x,y,z) is the hit block and
// (nx,ny,nz) is the empty neighbour cell on the near side (placement target).
// `hitLiquid` makes the ray stop on water too (bucket scooping/pouring).
export function raycast(world, origin, dir, maxDist = 6, hitLiquid = false) {
  let x = Math.floor(origin[0]), y = Math.floor(origin[1]), z = Math.floor(origin[2]);
  const stepX = Math.sign(dir[0]), stepY = Math.sign(dir[1]), stepZ = Math.sign(dir[2]);

  const tDeltaX = stepX !== 0 ? Math.abs(1 / dir[0]) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dir[1]) : Infinity;
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dir[2]) : Infinity;

  const boundary = (o, s) => s > 0 ? (Math.floor(o) + 1 - o) : (o - Math.floor(o));
  let tMaxX = stepX !== 0 ? boundary(origin[0], stepX) * tDeltaX : Infinity;
  let tMaxY = stepY !== 0 ? boundary(origin[1], stepY) * tDeltaY : Infinity;
  let tMaxZ = stepZ !== 0 ? boundary(origin[2], stepZ) * tDeltaZ : Infinity;

  let nx = 0, ny = 0, nz = 0;
  let t = 0;
  while (t <= maxDist) {
    const id = world.getBlock(x, y, z);
    const b = getBlock(id);
    if (id !== 0 && (hitLiquid || b.render !== "liquid")) {
      // contact point on the entered face (lets placement read where on the face
      // the cursor landed — e.g. upper vs lower half for slabs/stairs).
      return {
        x, y, z, nx: x + nx, ny: y + ny, nz: z + nz, dist: t,
        hpx: origin[0] + dir[0] * t, hpy: origin[1] + dir[1] * t, hpz: origin[2] + dir[2] * t,
      };
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
    } else {
      z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
    }
  }
  return null;
}
