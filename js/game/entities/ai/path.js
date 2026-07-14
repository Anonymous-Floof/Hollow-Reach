// A* pathfinding over the voxel grid, for walking mobs. (AI backend — built for
// future advanced mobs; nothing is required to use it yet.)
//
// A "node" is a STANDING CELL: integer (x,y,z) where the mob's feet would be.
// A cell is standable when the body fits (height` cells of non-solid) and the
// block under the feet is solid (or water, for swimmers). Moves considered:
//
//   • 4 cardinal walks (same level)
//   • 4 diagonals (only when both adjacent cardinals are open — no corner cuts)
//   • step UP one block (the entity manager's auto-step climbs these)
//   • drop DOWN up to `maxFall` blocks (cheap for 1, pricier the further down)
//   • swim through water cells when `swim` is set (no floor needed, slower)
//
// The search is BUDGETED: it expands at most `budget.left` nodes (shared across
// all mobs in a frame via AIServices) and returns the best PARTIAL path toward
// the goal when it runs out or the goal is unreachable — chasing mobs can start
// moving somewhere useful instead of standing still. Waypoints are cell centres.
//
// Typical use (from a mob's update):
//   const path = findPath(world, e.pos, targetPos, { maxFall: 3 });
//   if (path) e.data.follower = new PathFollower(path);
//   ... e.data.follower.step(e, dt, 2.4);   // steers vel/yaw along the path

import { isSolid, BLOCK } from "../../../world/blocks.js";

const SQRT2 = Math.SQRT2;

// 4 cardinals then 4 diagonals; diagonals carry the indices of the two
// cardinals that must both be open at the same level (no cutting corners).
const DIRS = [
  { dx: 1, dz: 0, cost: 1 }, { dx: -1, dz: 0, cost: 1 },
  { dx: 0, dz: 1, cost: 1 }, { dx: 0, dz: -1, cost: 1 },
  { dx: 1, dz: 1, cost: SQRT2, need: [0, 2] }, { dx: 1, dz: -1, cost: SQRT2, need: [0, 3] },
  { dx: -1, dz: 1, cost: SQRT2, need: [1, 2] }, { dx: -1, dz: -1, cost: SQRT2, need: [1, 3] },
];

const DEFAULTS = {
  height: 2,        // body height in cells (zombie/player-sized)
  maxFall: 3,       // won't path over drops taller than this
  swim: false,      // true = water cells are traversable (slow)
  avoidWater: true, // true = never enter water (ignored when swim is set)
  maxExpand: 640,   // per-call expansion cap (also capped by budget.left)
  maxDist: 48,      // give up beyond this straight-line distance from start
};

// ---- world queries ---------------------------------------------------------

function solidAt(world, x, y, z) { return isSolid(world.getBlock(x, y, z)); }
function waterAt(world, x, y, z) { return world.getBlock(x, y, z) === BLOCK.water; }

// Can a body of `height` cells stand with its feet at (x,y,z)? Returns:
// 0 = no; 1 = yes, on solid ground; 2 = yes, floating in water (swimmers only).
function standable(world, x, y, z, o) {
  for (let i = 0; i < o.height; i++) {
    if (solidAt(world, x, y + i, z)) return 0;
    if (!o.swim && waterAt(world, x, y + i, z) && o.avoidWater) return 0;
  }
  if (solidAt(world, x, y - 1, z)) return 1;
  if (o.swim && (waterAt(world, x, y - 1, z) || waterAt(world, x, y, z))) return 2;
  return 0;
}

// ---- binary min-heap on f-score -------------------------------------------

class Heap {
  constructor() { this.a = []; }
  push(n) {
    const a = this.a; a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      const t = a[p]; a[p] = a[i]; a[i] = t; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        const t = a[m]; a[m] = a[i]; a[i] = t; i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

// octile distance on xz + a vertical term — admissible-enough for game paths
function heuristic(x, y, z, gx, gy, gz) {
  const dx = Math.abs(x - gx), dz = Math.abs(z - gz);
  return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz) + Math.abs(y - gy) * 0.6;
}

// ---- the search ------------------------------------------------------------

// findPath(world, startPos, goalPos, opts?, budget?) -> {found, points, cost} | null
//   startPos/goalPos: world-space [x,y,z] (floats fine — snapped to cells).
//   budget: optional shared { left: n } — decremented by nodes expanded, so many
//           mobs pathing in one frame split the frame's total work fairly.
// Returns null only when the START cell itself is invalid; otherwise always at
// least a partial path toward the goal (found=false marks partials).
export function findPath(world, startPos, goalPos, opts = {}, budget = null) {
  const o = { ...DEFAULTS, ...opts };
  const sx = Math.floor(startPos[0]), sy = Math.floor(startPos[1] + 0.01), sz = Math.floor(startPos[2]);
  const gx = Math.floor(goalPos[0]), gy = Math.floor(goalPos[1] + 0.01), gz = Math.floor(goalPos[2]);

  // snap a slightly-off start (mid-jump, inside a step) down to footing
  let fy = sy;
  if (!standable(world, sx, fy, sz, o)) {
    if (standable(world, sx, fy - 1, sz, o)) fy = sy - 1;
    else if (standable(world, sx, fy + 1, sz, o)) fy = sy + 1;
    else return null;
  }

  let allow = Math.min(o.maxExpand, budget ? budget.left : Infinity);
  if (allow <= 0) return null;

  const key = (x, y, z) => ((x - sx + 256) << 18) | ((z - sz + 256) << 9) | (y + 256 - sy);
  const open = new Heap();
  const nodes = new Map();   // key -> node {x,y,z,g,f,parent,closed}

  const start = { x: sx, y: fy, z: sz, g: 0, f: heuristic(sx, fy, sz, gx, gy, gz), parent: null, closed: false };
  nodes.set(key(sx, fy, sz), start);
  open.push(start);
  let best = start;          // closest-to-goal node seen (for partial paths)
  let goal = null;
  let expanded = 0;

  const visit = (x, y, z, g, parent, hint) => {
    const k = key(x, y, z);
    let n = nodes.get(k);
    if (n && n.closed) return;
    if (n && n.g <= g) return;
    const h = heuristic(x, y, z, gx, gy, gz);
    if (!n) { n = { x, y, z, g, f: g + h, parent, closed: false }; nodes.set(k, n); }
    else { n.g = g; n.f = g + h; n.parent = parent; }
    open.push(n);
    if (h < heuristic(best.x, best.y, best.z, gx, gy, gz)) best = n;
    if (hint) n.hint = hint;   // "up"/"down" — followers can pre-jump on these
  };

  while (open.size && expanded < allow) {
    const cur = open.pop();
    if (cur.closed) continue;
    cur.closed = true;
    expanded++;

    if (cur.x === gx && cur.z === gz && Math.abs(cur.y - gy) <= 1) { goal = cur; break; }
    // range guard: don't flood the whole loaded world on unreachable goals
    if (Math.abs(cur.x - sx) > o.maxDist || Math.abs(cur.z - sz) > o.maxDist) continue;

    const openLevel = [];   // per-cardinal "walkable at same level" for diagonals
    for (let i = 0; i < DIRS.length; i++) {
      const d = DIRS[i];
      if (d.need && !(openLevel[d.need[0]] && openLevel[d.need[1]])) continue;
      const nx = cur.x + d.dx, nz = cur.z + d.dz;
      const inWater = o.swim && standable(world, cur.x, cur.y, cur.z, o) === 2;
      const stepCost = d.cost * (inWater ? 1.8 : 1);   // swimming is slower

      // same level
      const level = standable(world, nx, cur.y, nz, o);
      if (i < 4) openLevel[i] = !!level;
      if (level) { visit(nx, cur.y, nz, cur.g + stepCost * (level === 2 ? 1.8 : 1), cur); continue; }

      if (d.need) continue;   // diagonals only move on the level — keeps moves simple

      // step up one block: headroom above the current cell + a standable target
      if (!solidAt(world, cur.x, cur.y + o.height, cur.z) && standable(world, nx, cur.y + 1, nz, o)) {
        visit(nx, cur.y + 1, nz, cur.g + stepCost + 0.4, cur, "up");
        continue;
      }
      // drop: clear column on the far side down to footing within maxFall
      if (!solidAt(world, nx, cur.y + o.height - 1, nz)) {
        let dy = 0, blocked = false;
        for (; dy <= o.maxFall; dy++) {
          const yy = cur.y - dy;
          const st = standable(world, nx, yy, nz, o);
          if (st) { visit(nx, yy, nz, cur.g + stepCost + 0.35 * dy * (st === 2 ? 0.5 : 1), cur, dy > 0 ? "down" : null); break; }
          if (solidAt(world, nx, yy, nz)) { blocked = true; break; }   // wall, not a drop
        }
        void blocked;
      }
    }
  }
  if (budget) budget.left -= expanded;

  const end = goal || (best !== start ? best : null);
  if (!end) return { found: false, points: [], cost: 0 };
  const points = [];
  for (let n = end; n; n = n.parent) points.push([n.x + 0.5, n.y, n.z + 0.5, n.hint || null]);
  points.reverse();
  return { found: !!goal, points, cost: end.g };
}

// ---- follower ---------------------------------------------------------------
//
// Steers an entity along a path: sets vel x/z toward the next waypoint, hops at
// "up" hints taller than the manager's auto-step, watches for being stuck, and
// reports when it's finished or needs a replan. Owns no timers beyond itself, so
// it can live in e.data (it is NOT serialized — rebuild after load).

export class PathFollower {
  constructor(path) {
    this.points = path.points;
    this.found = path.found;
    this.i = 1;                    // points[0] is the start cell
    this.stuckT = 0;
    this.lastD = Infinity;
  }

  get done() { return this.i >= this.points.length; }
  get target() { return this.done ? null : this.points[this.i]; }
  // final planned cell (useful to test whether the goal has since moved)
  get end() { return this.points.length ? this.points[this.points.length - 1] : null; }

  // Advance along the path. Returns "moving" | "done" | "stuck".
  step(e, dt, speed) {
    if (this.done) return "done";
    const wp = this.points[this.i];
    const dx = wp[0] - e.pos[0], dz = wp[2] - e.pos[2];
    const dxz = Math.hypot(dx, dz);

    // reached this waypoint (xz close, roughly the right level) -> next
    if (dxz < 0.4 && Math.abs(wp[1] - e.pos[1]) < 1.3) {
      this.i++;
      this.stuckT = 0; this.lastD = Infinity;
      return this.done ? "done" : "moving";
    }

    const heading = Math.atan2(dz, dx);
    e.vel[0] = Math.cos(heading) * speed;
    e.vel[2] = Math.sin(heading) * speed;
    e.yaw = Math.PI / 2 - heading;   // model convention: head points local +z

    // hop when the next cell is above us and we're grounded (auto-step usually
    // handles it; the hop covers lips/fences the sweep can't slide over)
    if (e.onGround && wp[1] > e.pos[1] + 0.6 && dxz < 1.1) e.vel[1] = 8.2;

    // stuck watchdog: no progress toward the waypoint for a while
    if (dxz > this.lastD - 0.02) {
      this.stuckT += dt;
      if (this.stuckT > 1.2) return "stuck";
    } else { this.stuckT = 0; this.lastD = dxz; }
    return "moving";
  }
}
