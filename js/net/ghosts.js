// Ghost entities: how remote state becomes something you can see.
//
// The host owns every real entity. Ten times a second it broadcasts a full
// snapshot (every live entity + every player pose); receivers mirror those as
// "ghost" entities — rendered and raycastable but never simulated — and render
// them ~150 ms in the past, interpolating between the two snapshots that
// bracket the render time. Full snapshots (not deltas) mean a lost packet
// costs nothing: the next snapshot is the whole truth, including removals.

import { ITEMS } from "../game/items.js";
import { okPid } from "./protocol.js";

// Entity types that travel in snapshots, by index. Same code version on both
// ends (enforced at handshake) -> same table.
export const NET_TYPES = ["drop", "boat", "sheep", "pig", "zombie"];
const NET_TYPE_IDX = new Map(NET_TYPES.map((t, i) => [t, i]));

// Item keys by index for compact drop tuples. ITEMS has deterministic
// insertion order, identical across same-version peers.
let _keys = null, _keyIdx = null;
function keyTable() {
  if (!_keys) {
    _keys = Object.keys(ITEMS);
    _keyIdx = new Map(_keys.map((k, i) => [k, i]));
  }
  return _keys;
}
export function itemKeyToIdx(key) { keyTable(); const i = _keyIdx.get(key); return i === undefined ? -1 : i; }
export function idxToItemKey(i) { const t = keyTable(); return (i >= 0 && i < t.length) ? t[i] : null; }

export const INTERP_DELAY = 150;   // ms behind real time that ghosts render

// How long a player keeps the same colour: hash the pid into a palette index.
export function hueOf(pid) {
  let h = 5381;
  for (let i = 0; i < pid.length; i++) h = ((h << 5) + h + pid.charCodeAt(i)) | 0;
  return Math.abs(h) % 8;
}

// ---- host side: build the wire tuples ----
// [id, typeIdx, x, y, z, yaw, a, b] — a/b are per-type extras.
export function buildEntTuples(entities) {
  const out = [];
  for (const e of entities) {
    if (e.dead || e.ghost) continue;
    const ti = NET_TYPE_IDX.get(e.type);
    if (ti === undefined) continue;
    let a = 0, b = 0;
    if (e.type === "drop") {
      a = Math.max(0, itemKeyToIdx(e.data.key));
      b = Math.min(999, e.data.count || 1);
    } else if (e.type === "sheep" || e.type === "pig" || e.type === "zombie") {
      a = e.data.health || 0;
      b = (e.data.hurtFlash || 0) > 0 ? 1 : 0;
    }
    out.push([e.id, ti, round2(e.pos[0]), round2(e.pos[1]), round2(e.pos[2]), round2(e.yaw), a, b]);
    if (out.length >= 256) break;
  }
  return out;
}
function round2(v) { return Math.round(v * 100) / 100; }

// ---- receiver side: mirror tuples as ghosts + interpolate ----
export class GhostWorld {
  constructor(world) {
    this.world = world;
    this.ents = new Map();       // netId -> ghost entity
    this.players = new Map();    // pid -> { e, name, buf }
  }

  // Apply one validated snapshot. `now` = performance.now() at receipt.
  applySnap(msg, now, selfPid) {
    // entities: full state — anything missing is gone
    const seen = new Set();
    for (const t of msg.ents) {
      const [id, ti, x, y, z, yaw, a, b] = t;
      const type = NET_TYPES[ti];
      if (!type) continue;
      seen.add(id);
      let e = this.ents.get(id);
      if (!e) {
        e = this.world.entities.spawnGhost(id, type, [x, y, z]);
        e._buf = [];
        this.ents.set(id, e);
      }
      if (type === "drop") {
        const key = idxToItemKey(a);
        if (key) e.data.key = key;
        e.data.count = b;
        e.data.bob = e.data.bob || Math.random() * Math.PI * 2;
      } else if (type === "sheep" || type === "pig" || type === "zombie") {
        e.data.health = a;
        if (b) e.data.hurtFlash = 0.3;
      }
      pushSample(e._buf, now, x, y, z, yaw, 0);
    }
    for (const [id, e] of this.ents) {
      if (!seen.has(id)) { e.dead = true; this.ents.delete(id); }
    }

    // players (skip our own echo)
    const pseen = new Set();
    for (const pid of Object.keys(msg.players)) {
      if (pid === selfPid || !okPid(pid)) continue;
      pseen.add(pid);
      const [x, y, z, yaw, pitch, bits, hp, hurt] = msg.players[pid];
      let g = this.players.get(pid);
      if (!g) g = this.addPlayer(pid, "Player", [x, y, z]);
      g.e.data.hp = hp;
      if (hurt) g.e.data.hurtFlash = 0.3;
      g.e.data.bits = bits;
      // camera yaw -> model yaw: the humanoid mesh faces +z, which the model
      // matrix maps to (sin yaw, cos yaw); the camera looks along (-sin, -cos).
      pushSample(g.e._buf, now, x, y, z, yaw + Math.PI, pitch);
    }
    for (const [pid, g] of this.players) {
      if (!pseen.has(pid)) this.removePlayer(pid);
    }
    this._prune();
  }

  // Host side feeds each client's pose straight in (no snap envelope).
  feedPlayerPose(pid, name, msgPose, now) {
    let g = this.players.get(pid);
    if (!g) g = this.addPlayer(pid, name, msgPose.p);
    g.e.data.hp = msgPose.hp;
    g.e.data.bits = msgPose.fl;
    pushSample(g.e._buf, now, msgPose.p[0], msgPose.p[1], msgPose.p[2], msgPose.yaw + Math.PI, msgPose.pitch);
    return g;
  }

  addPlayer(pid, name, pos) {
    const e = this.world.entities.spawnGhost(hashId(pid), "remote_player", pos);
    e.pid = pid;
    e._buf = [];
    e.data.hue = hueOf(pid);
    e.data.name = name;
    const g = { e, name, buf: e._buf };
    this.players.set(pid, g);
    return g;
  }

  removePlayer(pid) {
    const g = this.players.get(pid);
    if (!g) return;
    g.e.dead = true;
    this.players.delete(pid);
    this._prune();
  }

  setPlayerName(pid, name) {
    const g = this.players.get(pid);
    if (g) { g.name = name; g.e.data.name = name; }
  }

  // Per-frame: move every ghost to its interpolated position.
  tick(dt, now) {
    const t = now - INTERP_DELAY;
    for (const e of this.ents.values()) {
      sampleInto(e, t);
      if (e.data.hurtFlash > 0) e.data.hurtFlash = Math.max(0, e.data.hurtFlash - dt);
      if (e.type === "drop") { e.data.bob += dt * 3; e.yaw += dt * 1.6; }
    }
    for (const g of this.players.values()) {
      sampleInto(g.e, t);
      if (g.e.data.hurtFlash > 0) g.e.data.hurtFlash = Math.max(0, g.e.data.hurtFlash - dt);
    }
  }

  // Latest raw (uninterpolated) position — for validation/targeting on the host.
  latestPos(pid) {
    const g = this.players.get(pid);
    if (!g || !g.e._buf.length) return null;
    const s = g.e._buf[g.e._buf.length - 1];
    return [s.x, s.y, s.z];
  }

  clear() {
    for (const e of this.ents.values()) e.dead = true;
    for (const g of this.players.values()) g.e.dead = true;
    this.ents.clear();
    this.players.clear();
    this._prune();
  }

  // Dead ghosts are skipped by the manager's tick, so it never filters them
  // out — sweep them here instead.
  _prune() {
    const list = this.world.entities.entities;
    let any = false;
    for (const e of list) if (e.dead && e.ghost) { any = true; break; }
    if (any) this.world.entities.entities = list.filter((e) => !(e.dead && e.ghost));
  }
}

function hashId(pid) {
  let h = 2166136261;
  for (let i = 0; i < pid.length; i++) { h ^= pid.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 1) + 0x40000000;   // clear of real entity-id space for a very long time
}

function pushSample(buf, t, x, y, z, yaw, pitch) {
  buf.push({ t, x, y, z, yaw, pitch });
  while (buf.length > 30 || (buf.length > 2 && buf[0].t < t - 2000)) buf.shift();
}

// Position the ghost at time t using its sample buffer (lerp between the two
// bracketing samples; hold the last pose if we've run out of fresh data).
function sampleInto(e, t) {
  const buf = e._buf;
  if (!buf || !buf.length) return;
  if (t <= buf[0].t || buf.length === 1) { applySample(e, buf[0]); return; }
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i].t <= t) {
      const a = buf[i], b = buf[i + 1];
      if (!b) { applySample(e, a); return; }
      const f = Math.min(1, (t - a.t) / Math.max(1, b.t - a.t));
      e.pos[0] = a.x + (b.x - a.x) * f;
      e.pos[1] = a.y + (b.y - a.y) * f;
      e.pos[2] = a.z + (b.z - a.z) * f;
      e.yaw = lerpAngle(a.yaw, b.yaw, f);
      e.pitch = a.pitch + (b.pitch - a.pitch) * f;
      return;
    }
  }
  applySample(e, buf[buf.length - 1]);
}
function applySample(e, s) { e.pos[0] = s.x; e.pos[1] = s.y; e.pos[2] = s.z; e.yaw = s.yaw; e.pitch = s.pitch; }
function lerpAngle(a, b, f) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}
