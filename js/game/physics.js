// Shared swept-AABB collision against the voxel world (full cubes + shaped-block
// boxes via world.collisionBoxesAt). Used by both the player and entities so
// there is exactly one collision implementation.
//
// A "body" is any object with { pos:[x,y,z], hw, h }: hw = half width (x/z),
// h = height. The body is treated as an axis-aligned box from
// [x-hw, y, z-hw] to [x+hw, y+h, z+hw].

const EPS = 1e-3;

// Does the AABB [lo,hi] overlap any solid block box?
export function aabbBlocked(world, lo, hi) {
  const x0 = Math.floor(lo[0]), x1 = Math.floor(hi[0] - EPS);
  const y0 = Math.floor(lo[1]), y1 = Math.floor(hi[1] - EPS);
  const z0 = Math.floor(lo[2]), z1 = Math.floor(hi[2] - EPS);
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (const b of world.collisionBoxesAt(x, y, z))
          if (hi[0] > b[0] && lo[0] < b[3] && hi[1] > b[1] && lo[1] < b[4] && hi[2] > b[2] && lo[2] < b[5]) return true;
  return false;
}

export function bodyOverlaps(world, body) {
  const p = body.pos, hw = body.hw, h = body.h;
  return aabbBlocked(world, [p[0] - hw, p[1], p[2] - hw], [p[0] + hw, p[1] + h, p[2] + hw]);
}

// Like sweepAxis, but with an instant auto-step: if the horizontal move is
// blocked, try lifting the body up to `stepH` and completing the move (so a
// walking mob climbs a ledge/hill in one frame, keeping its momentum, the same
// way the player walks up stairs). Reverts the probe if there's no room.
// Only call for horizontal axes (0 or 2) on a grounded body.
export function stepSweep(world, body, axis, delta, stepH) {
  const blocked = sweepAxis(world, body, axis, delta);
  if (!blocked || delta === 0) return blocked;
  const savedAxis = body.pos[axis], savedY = body.pos[1];
  body.pos[1] += stepH + EPS;
  if (bodyOverlaps(world, body)) { body.pos[1] = savedY; return true; }   // no headroom to step into
  if (!sweepAxis(world, body, axis, delta)) return false;                 // stepped up onto the ledge
  body.pos[axis] = savedAxis; body.pos[1] = savedY;                       // move still blocked — revert probe
  return true;
}

// Move `body` (mutates body.pos) along one axis by `delta`, resolving against
// the nearest blocking face. Returns true if the move was blocked.
export function sweepAxis(world, body, axis, delta) {
  if (delta === 0) return false;
  const p = body.pos, hw = body.hw, h = body.h;
  p[axis] += delta;
  const lo = [p[0] - hw, p[1], p[2] - hw];
  const hi = [p[0] + hw, p[1] + h, p[2] + hw];
  const x0 = Math.floor(lo[0]), x1 = Math.floor(hi[0] - EPS);
  const y0 = Math.floor(lo[1]), y1 = Math.floor(hi[1] - EPS);
  const z0 = Math.floor(lo[2]), z1 = Math.floor(hi[2] - EPS);
  let hit = false;
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (const b of world.collisionBoxesAt(x, y, z)) {
          if (axis !== 0 && !(hi[0] > b[0] && lo[0] < b[3])) continue;
          if (axis !== 1 && !(hi[1] > b[1] && lo[1] < b[4])) continue;
          if (axis !== 2 && !(hi[2] > b[2] && lo[2] < b[5])) continue;
          if (!(hi[axis] > b[axis] && lo[axis] < b[axis + 3])) continue;
          if (delta > 0) p[axis] = b[axis] - (axis === 1 ? h : hw) - EPS;
          else p[axis] = (axis === 1 ? b[axis + 3] : b[axis + 3] + hw) + EPS;
          hit = true;
          lo[axis] = axis === 1 ? p[1] : p[axis] - hw;
          hi[axis] = axis === 1 ? p[1] + h : p[axis] + hw;
        }
  return hit;
}
