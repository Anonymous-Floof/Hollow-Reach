// Multiplayer wire protocol: message schemas + strict validation.
//
// SECURITY MODEL. Everything that arrives over a data channel is hostile until
// proven otherwise — a "friend" may be running a modified client. The rules:
//   • Messages are JSON with a whitelisted shape per type. decode() returns a
//     FRESH object built field-by-field from the schema — unknown fields are
//     dropped on the floor, so remote data can never smuggle extra keys
//     (__proto__, constructor, …) into game objects.
//   • Every number is checked finite and range-clamped; every string is
//     length-clamped. Anything malformed rejects the whole message.
//   • Raw message size is capped before JSON.parse is even attempted.
//   • Display strings (names, world names) must only ever reach the DOM via
//     textContent / createTextNode — never innerHTML.
// The host additionally applies *semantic* validation (reach, rate limits,
// block-id whitelists) in host.js; this module only guarantees shape.

export const NET_VERSION = 1;

// Hard caps (bytes of raw channel data). The world snapshot is streamed in
// parts, so ordinary messages stay small.
export const MAX_MSG = 64 * 1024;          // any single message
export const MAX_WORLD_TOTAL = 24 * 1024 * 1024; // reassembled world snapshot

export const MAX_NAME = 20;                 // player display name
export const MAX_WORLD_NAME = 28;
export const MAX_REASON = 80;

// ---- schema field kinds ----
// num(lo,hi)      finite number clamped-checked to [lo,hi]
// int(lo,hi)      integer in [lo,hi]
// str(maxLen)     string, length-capped
// bool            boolean
// vec3(lo,hi)     [x,y,z] of finite numbers in range
// arr(el,maxLen)  array of element kind
// raw(maxLen)     pre-validated JSON-safe payload (only used for save-shaped
//                 blobs that get their own dedicated deep validator below)
const num = (lo, hi) => ({ k: "num", lo, hi });
const int = (lo, hi) => ({ k: "int", lo, hi });
const str = (max) => ({ k: "str", max });
const bool = { k: "bool" };
const vec3 = (lo, hi) => ({ k: "vec3", lo, hi });
const arr = (el, max) => ({ k: "arr", el, max });
const opt = (f) => ({ ...f, opt: true });

const POS = 2e6;      // |coordinate| sanity bound (far beyond reachable terrain)
const V = 2e3;        // |velocity| sanity bound

// One live entity in a snapshot: [id, typeIdx, x, y, z, yaw, a, b]
// (a,b are per-type extras: drops pack an item index + count, mobs pack
// health + hurt-flash, players pack pitch + anim bits).
const ENT_TUPLE = { k: "ent" };

// ---- message schemas ----
// Client -> host unless noted. (h→c) = host to client. (both) = either way.
export const SCHEMAS = {
  // handshake
  hello:    { ver: str(24), name: str(MAX_NAME), cid: str(48) },
  reject:   { reason: str(MAX_REASON) },                             // h→c
  world:    { part: int(0, 4095), parts: int(1, 4096), data: str(MAX_MSG) }, // h→c chunked snapshot
  ready:    {},                                                       // c→h: snapshot applied

  // continuous state
  pose:     { p: vec3(-POS, POS), v: vec3(-V, V), yaw: num(-64, 64), pitch: num(-4, 4),
              hp: num(0, 40), fl: int(0, 15) },                      // c→h @15Hz; fl bits: swim|sneak<<1|fly<<2
  snap:     { time: num(0, 1), ents: arr(ENT_TUPLE, 256),
              players: { k: "players" } },                            // h→c @10Hz
  time:     { t: num(0, 1), sleeping: int(0, 1) },                    // h→c authoritative clock
  ping:     { ts: num(0, 1e15) },                                     // (both)
  pong:     { ts: num(0, 1e15) },

  // world edits
  edit:     { x: int(-POS, POS), y: int(0, 512), z: int(-POS, POS),
              id: int(0, 1023), meta: int(0, 63) },                   // (both; c→h validated, h→c authoritative)
  edits:    { list: arr({ k: "edit5" }, 512) },                       // batched [[x,y,z,id,meta],...]
  editDeny: { x: int(-POS, POS), y: int(0, 512), z: int(-POS, POS),
              id: int(0, 1023), meta: int(0, 63) },                   // h→c rollback (authoritative cell)

  // actions
  hit:      { eid: int(-1e9, 1e9), held: str(40) },                   // attack a host-owned entity (mob)
  phit:     { pid: str(48), held: str(40) },                          // attack another player (PvP)
  tp:       { p: vec3(-POS, POS) },                                   // h→c forced position (failed movement validation)
  toss:     { p: vec3(-POS, POS), d: vec3(-2, 2), key: str(40),
              count: int(1, 999), dura: opt(int(0, 9999)) },          // spawn a tossed drop
  give:     { key: str(40), count: int(1, 999), dura: opt(int(0, 9999)) }, // h→c pickup award
  dmg:      { amount: num(0, 100), kb: vec3(-40, 40) },               // h→c: you took a hit
  sleep:    { on: int(0, 1) },                                        // sleep vote
  sfx:      { kind: str(24), p: vec3(-POS, POS) },                    // h→c positional one-shots (mob hurt etc. handled via snap; kept minimal)

  // block entities (chest / forge)
  beReq:    { x: int(-POS, POS), y: int(0, 512), z: int(-POS, POS), kind: str(8) },
  beState:  { x: int(-POS, POS), y: int(0, 512), z: int(-POS, POS),
              be: { k: "be" }, final: int(0, 1) },                    // (both) final=1 -> close+unlock
  beDeny:   { x: int(-POS, POS), y: int(0, 512), z: int(-POS, POS), reason: str(MAX_REASON) },

  // player persistence + lifecycle
  pstate:   { player: { k: "pjson" }, inventory: { k: "ijson" } },    // c→h periodic (for host-side save)
  bye:      {},                                                       // (both)
  pjoin:    { pid: str(48), name: str(MAX_NAME) },                    // h→c roster add
  pleave:   { pid: str(48) },                                         // h→c roster remove
  notify:   { msg: str(120) },                                        // h→c toast (textContent only)
};

// ---- primitive checks ----
function okNum(v, lo, hi) { return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi; }
function okInt(v, lo, hi) { return okNum(v, lo, hi) && Number.isInteger(v); }
function okStr(v, max) { return typeof v === "string" && v.length <= max; }
function okVec3(v, lo, hi) {
  return Array.isArray(v) && v.length === 3 && okNum(v[0], lo, hi) && okNum(v[1], lo, hi) && okNum(v[2], lo, hi);
}

// A slot as it travels the wire: null or [key, count, dura|null].
function cleanSlot(s) {
  if (s === null || s === undefined) return null;
  if (!Array.isArray(s) || s.length < 2 || s.length > 3) return undefined;
  if (!okStr(s[0], 40) || !okInt(s[1], 1, 999)) return undefined;
  const dura = s[2] == null ? null : (okInt(s[2], 0, 99999) ? s[2] : undefined);
  if (dura === undefined) return undefined;
  return [s[0], s[1], dura];
}

// Block-entity payload: rebuilt fresh, never passed through.
function cleanBE(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  if (v.kind === "chest") {
    if (!Array.isArray(v.slots) || v.slots.length > 54) return undefined;
    const slots = [];
    for (const s of v.slots) { const c = cleanSlot(s); if (c === undefined) return undefined; slots.push(c); }
    return { kind: "chest", slots };
  }
  if (v.kind === "forge") {
    const input = cleanSlot(v.input), fuel = cleanSlot(v.fuel), output = cleanSlot(v.output);
    if (input === undefined || fuel === undefined || output === undefined) return undefined;
    if (!okNum(v.fuelLeft ?? 0, 0, 1e6) || !okNum(v.fuelMax ?? 0, 0, 1e6) || !okNum(v.progress ?? 0, 0, 1e6)) return undefined;
    return { kind: "forge", input, fuel, output,
      fuelLeft: v.fuelLeft ?? 0, fuelMax: v.fuelMax ?? 0, progress: v.progress ?? 0 };
  }
  return undefined;
}

// player.toJSON shape (subset, rebuilt fresh). Exported: the client also runs
// it over the host's world payload.
export function cleanPlayerJSON(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  if (!okVec3(v.pos, -POS, POS)) return undefined;
  return {
    pos: [v.pos[0], v.pos[1], v.pos[2]],
    yaw: okNum(v.yaw, -64, 64) ? v.yaw : 0,
    pitch: okNum(v.pitch, -4, 4) ? v.pitch : 0,
    health: okNum(v.health, 0, 40) ? v.health : 20,
    flying: v.flying === true,
    hunger: okNum(v.hunger, 0, 40) ? v.hunger : 20,
    saturation: okNum(v.saturation, 0, 40) ? v.saturation : 5,
  };
}

// inventory.toJSON shape (rebuilt fresh).
export function cleanInvJSON(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  if (!Array.isArray(v.slots) || v.slots.length > 40) return undefined;
  if (!Array.isArray(v.armor) || v.armor.length > 4) return undefined;
  const slots = [], armor = [];
  for (const s of v.slots) { const c = cleanSlot(s); if (c === undefined) return undefined; slots.push(c); }
  for (const s of v.armor) { const c = cleanSlot(s); if (c === undefined) return undefined; armor.push(c); }
  return { slots, armor, selected: okInt(v.selected, 0, 8) ? v.selected : 0 };
}

// Snapshot entity tuple: [id, typeIdx, x, y, z, yaw, a, b]
function cleanEnt(v) {
  if (!Array.isArray(v) || v.length !== 8) return undefined;
  if (!okInt(v[0], 0, 1e9) || !okInt(v[1], 0, 63)) return undefined;
  for (let i = 2; i <= 7; i++) if (!okNum(v[i], -POS, POS)) return undefined;
  return [v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]];
}

// Snapshot players map: { pid: [x,y,z,yaw,pitch,flBits,hp,hurt] } — rebuilt
// key-by-key with pid format enforcement (never a raw object walk into game state).
const PID_RE = /^[A-Za-z0-9_-]{4,48}$/;
export function okPid(pid) {
  // the dunder exclusions keep a hostile pid from ever naming a prototype slot
  // in any plain object it might be used to key
  return typeof pid === "string" && PID_RE.test(pid) &&
    !pid.startsWith("__") && pid !== "constructor" && pid !== "prototype";
}
function cleanPlayers(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out = Object.create(null);
  let n = 0;
  for (const pid of Object.keys(v)) {
    if (!okPid(pid)) return undefined;
    if (++n > 32) return undefined;
    const t = v[pid];
    if (!Array.isArray(t) || t.length !== 8) return undefined;
    for (let i = 0; i < 5; i++) if (!okNum(t[i], -POS, POS)) return undefined;
    if (!okInt(t[5], 0, 15) || !okNum(t[6], 0, 40) || !okInt(t[7], 0, 1)) return undefined;
    out[pid] = [t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7]];
  }
  return out;
}

// Batched edit tuple [x,y,z,id,meta]
function cleanEdit5(v) {
  if (!Array.isArray(v) || v.length !== 5) return undefined;
  if (!okInt(v[0], -POS, POS) || !okInt(v[1], 0, 512) || !okInt(v[2], -POS, POS)) return undefined;
  if (!okInt(v[3], 0, 1023) || !okInt(v[4], 0, 63)) return undefined;
  return [v[0], v[1], v[2], v[3], v[4]];
}

function cleanField(f, v) {
  switch (f.k) {
    case "num": return okNum(v, f.lo, f.hi) ? v : undefined;
    case "int": return okInt(v, f.lo, f.hi) ? v : undefined;
    case "str": return okStr(v, f.max) ? v : undefined;
    case "bool": return typeof v === "boolean" ? v : undefined;
    case "vec3": return okVec3(v, f.lo, f.hi) ? [v[0], v[1], v[2]] : undefined;
    case "arr": {
      if (!Array.isArray(v) || v.length > f.max) return undefined;
      const out = [];
      for (const el of v) { const c = cleanField(f.el, el); if (c === undefined) return undefined; out.push(c); }
      return out;
    }
    case "ent": return cleanEnt(v);
    case "edit5": return cleanEdit5(v);
    case "be": return cleanBE(v);
    case "pjson": return cleanPlayerJSON(v);
    case "ijson": return cleanInvJSON(v);
    case "players": return cleanPlayers(v);
    default: return undefined;
  }
}

// ---- encode / decode ----
export function encode(type, fields) {
  return JSON.stringify({ t: type, ...fields });
}

// Returns { t, ...cleanFields } or null if the message is malformed in any way.
export function decode(raw) {
  if (typeof raw !== "string" || raw.length > MAX_MSG) return null;
  let msg;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  const schema = Object.prototype.hasOwnProperty.call(SCHEMAS, msg.t) ? SCHEMAS[msg.t] : null;
  if (!schema) return null;
  const out = { t: msg.t };
  for (const key of Object.keys(schema)) {
    const f = schema[key];
    const v = msg[key];
    if (v === undefined || v === null) {
      if (f.opt) { out[key] = undefined; continue; }
      return null;
    }
    const c = cleanField(f, v);
    if (c === undefined) return null;
    out[key] = c;
  }
  return out;
}

// Simple token bucket for per-peer rate limiting.
export class Bucket {
  constructor(rate, burst) { this.rate = rate; this.burst = burst; this.level = burst; this.last = performance.now(); }
  take(n = 1) {
    const now = performance.now();
    this.level = Math.min(this.burst, this.level + (now - this.last) / 1000 * this.rate);
    this.last = now;
    if (this.level < n) return false;
    this.level -= n;
    return true;
  }
}

// Stable per-browser identity for reconnecting into a host's saved slot.
// Random, not fingerprinting — just a coat-check ticket.
export function localPlayerId() {
  try {
    let id = localStorage.getItem("hollowreach.pid");
    if (!id || !okPid(id)) {
      id = "p" + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "0123456789abcdefghjkmnpqrstvwxyz"[b & 31]).join("");
      localStorage.setItem("hollowreach.pid", id);
    }
    return id;
  } catch {
    return "p" + Math.random().toString(36).slice(2, 14);
  }
}

export function getPlayerName() {
  try {
    const n = localStorage.getItem("hollowreach.pname");
    if (n && typeof n === "string") return n.slice(0, MAX_NAME);
  } catch { /* storage unavailable */ }
  return "Player";
}
export function setPlayerName(n) {
  let s = ""; for (const ch of String(n || "")) { const c = ch.codePointAt(0); if (c >= 32 && c !== 127) s += ch; }
  const clean = s.trim().slice(0, MAX_NAME) || "Player";
  try { localStorage.setItem("hollowreach.pname", clean); } catch { /* ignore */ }
  return clean;
}
