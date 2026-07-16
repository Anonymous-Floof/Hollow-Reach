// NetClient: joins a hosted world and keeps it in sync.
//
// Latency philosophy ("clientised" actions): everything personal happens
// locally at zero latency — your own movement physics, breaking/placing
// blocks (applied immediately, host validates after the fact), eating,
// crafting, your inventory. The wire only carries corrections (rare) and
// other people's state. What legitimately waits on the host: seeing OTHER
// players' actions, PvP damage, mob combat results and container contents —
// exactly the trade the design asks for.
//
// Trust model: the host is trusted with world data (you chose to join them)
// but every message is still shape-validated (transport.js), the world
// payload is deep-validated below before touching game state, and nothing
// from the wire can reach the DOM as markup or execute as code.

import { Peer } from "./transport.js";
import { encodeSignal, decodeSignal } from "./signal.js";
import { NET_VERSION, MAX_WORLD_TOTAL, cleanPlayerJSON, cleanInvJSON } from "./protocol.js";
import { GhostWorld } from "./ghosts.js";
import { SAVE_VERSION } from "../save/serialize.js";
import { getItem } from "../game/items.js";
import { sfx } from "../audio/sfx.js";

const PROTO = `${SAVE_VERSION}.${NET_VERSION}`;
const POSE_MS = 66;       // ~15Hz own pose
const PING_MS = 2000;
const PSTATE_MS = 20000;  // periodic player/inventory persistence to the host
const BE_PUSH_MS = 500;   // container slot pushes while one is open

// Positional one-shots the host may relay — a fixed whitelist, nothing dynamic.
const SFX_MAP = {
  thwack: (p) => sfx.thwack(p),
  sheep_hurt: (p) => sfx.sheep && sfx.sheep("hurt", p, 1),
  sheep_death: (p) => sfx.sheep && sfx.sheep("death", p, 1),
  pig_hurt: (p) => sfx.pig && sfx.pig("hurt", p, 1),
  pig_death: (p) => sfx.pig && sfx.pig("death", p, 1),
  cow_hurt: (p) => sfx.cow && sfx.cow("hurt", p, 1),
  cow_death: (p) => sfx.cow && sfx.cow("death", p, 1),
  zombie_hurt: (p) => sfx.zombie && sfx.zombie("hurt", p, 1),
  zombie_death: (p) => sfx.zombie && sfx.zombie("death", p, 1),
};

export class NetClient {
  // cb: { onWorld(payload), onDisconnect(reason), onNotify(msg), onRoster() }
  constructor(pid, name, cb) {
    this.isHost = false;
    this.isClient = true;
    this.pid = pid;
    this.name = name;
    this.cb = cb;
    this.peer = new Peer("client");
    this.game = null;          // set by attach() once the world exists
    this.ghosts = null;
    this.roster = new Map();   // pid -> name (includes the host)
    this.rtt = 0;
    this.joined = false;
    this._worldParts = null;
    this._worldSeen = 0;
    this._worldBytes = 0;
    this._poseT = 0; this._pingT = 0; this._pstateT = 0; this._beT = 0;
    this._timeTarget = null;
    this._beOpen = null;       // { x, y, z, be } while a container UI is open
    this._bePending = null;    // { x, y, z, kind } while waiting for the host
    this._closed = false;

    this.peer.onMessage = (msg) => this._onMessage(msg);
    this.peer.onOpen = () => {
      this.peer.send("hello", { ver: PROTO, name: this.name, cid: this.pid });
    };
    this.peer.onClose = () => {
      if (this._closed) return;
      this._closed = true;
      this.cb.onDisconnect(this._rejectReason || "Connection lost");
    };
  }

  // ---- copy-paste join flow ----
  // 1) paste the host's invite -> returns your reply code to send back
  async answerInvite(codeText) {
    const desc = await decodeSignal(codeText);
    if (!desc || desc.type !== "offer") throw new Error("That is not a valid invite code");
    const answer = await this.peer.acceptOffer(desc);
    return encodeSignal(answer);
  }

  // Wire the live game objects once Game.startRemote has built the world.
  attach(game) {
    this.game = game;
    this.ghosts = new GhostWorld(game.world);
    game.world.netRole = "client";
    // every local edit goes straight to the host (the local world already
    // applied it — that's the zero-latency prediction)
    game.world.onNetEdit = (x, y, z, id, meta) => {
      this.peer.send("edit", { x, y, z, id, meta });
    };
  }

  ready() { this.peer.send("ready", {}); this.joined = true; }

  // ---------- messages ----------
  _onMessage(msg) {
    switch (msg.t) {
      case "reject":
        this._rejectReason = msg.reason;
        return;   // onClose follows and reports it
      case "world": return this._onWorldPart(msg);
      case "snap": return this._onSnap(msg);
      case "edit": return this._applyEdit(msg.x, msg.y, msg.z, msg.id, msg.meta);
      case "edits": { for (const e of msg.list) this._applyEdit(e[0], e[1], e[2], e[3], e[4]); return; }
      case "editDeny": return this._applyEdit(msg.x, msg.y, msg.z, msg.id, msg.meta);
      case "tp": return this._onTp(msg);
      case "time": return this._onTime(msg);
      case "give": return this._onGive(msg);
      case "dmg": return this._onDmg(msg);
      case "sfx": { const fn = SFX_MAP[msg.kind]; if (fn) fn(msg.p); return; }
      case "beState": return this._onBEState(msg);
      case "beDeny": return this._onBEDeny(msg);
      case "pjoin":
        this.roster.set(msg.pid, msg.name);
        if (this.ghosts) this.ghosts.setPlayerName(msg.pid, msg.name);
        this.cb.onRoster();
        return;
      case "pleave":
        this.roster.delete(msg.pid);
        this.cb.onRoster();
        return;
      case "notify": return this.cb.onNotify(msg.msg);
      case "pong": this.rtt = Math.max(0, performance.now() - msg.ts); return;
      case "ping": this.peer.sendFast("pong", { ts: msg.ts }); return;
      case "bye":
        this._rejectReason = "The host closed the world";
        this.peer.close();
        return;
      default: return;
    }
  }

  _onWorldPart(msg) {
    if (this.joined) return;
    if (!this._worldParts) {
      this._worldParts = new Array(msg.parts).fill(null);
    }
    if (msg.parts !== this._worldParts.length || msg.part >= this._worldParts.length) return;
    if (this._worldParts[msg.part] !== null) return;
    this._worldBytes += msg.data.length;
    if (this._worldBytes > MAX_WORLD_TOTAL) { this.peer.close(); return; }
    this._worldParts[msg.part] = msg.data;
    this._worldSeen++;
    if (this._worldSeen < this._worldParts.length) return;
    let payload;
    try { payload = JSON.parse(this._worldParts.join("")); } catch { this.peer.close(); return; }
    this._worldParts = null;
    const clean = validateWorldPayload(payload);
    if (!clean) { this._rejectReason = "Host sent an invalid world"; this.peer.close(); return; }
    this.cb.onWorld(clean);
  }

  _onSnap(msg) {
    if (!this.ghosts) return;
    this.ghosts.applySnap(msg, performance.now(), this.pid);
    // ghosts can spawn from a snapshot before/after their pjoin — re-stamp names
    for (const [pid, g] of this.ghosts.players) {
      const n = this.roster.get(pid);
      if (n && g.name !== n) { g.name = n; g.e.data.name = n; }
    }
    this._timeTarget = msg.time;
  }

  _applyEdit(x, y, z, id, meta) {
    if (!this.game) return;
    this.game.world.applyRemoteEdit(x, y, z, id, meta);
  }

  _onTp(msg) {
    if (!this.game) return;
    this.game.player.pos = [msg.p[0], msg.p[1], msg.p[2]];
    this.game.player.vel = [0, 0, 0];
  }

  _onTime(msg) {
    this._timeTarget = msg.t;
    if (!this.game) return;
    // while the host fast-forwards (sleep), ride along exactly
    if (msg.sleeping === 1) this.game.sky.time = msg.t;
  }

  _onGive(msg) {
    if (!this.game || !getItem(msg.key)) return;
    const left = this.game.inventory.give(msg.key, msg.count, msg.dura ?? undefined);
    if (left < msg.count) sfx.pickup();
    // no room for the rest: toss it back out so nothing is voided
    if (left > 0) {
      const e = this.game.player.eye();
      this.peer.send("toss", { p: [e[0], e[1] - 0.2, e[2]], d: [0, 0.2, 0], key: msg.key, count: left, dura: msg.dura });
    }
  }

  _onDmg(msg) {
    if (!this.game) return;
    const p = this.game.player;
    p.damage(msg.amount, { defense: this.game.inventory.totalDefense() });
    p.vel[0] += msg.kb[0]; p.vel[2] += msg.kb[2];
    p.vel[1] = Math.max(p.vel[1], msg.kb[1]);
  }

  _onBEState(msg) {
    const at = (o) => o && o.x === msg.x && o.y === msg.y && o.z === msg.z;
    if (at(this._bePending)) {
      const kind = this._bePending.kind;
      this._bePending = null;
      const be = wireToLocalBE(msg.be);
      if (!be || be.kind !== kind) return;
      this._beOpen = { x: msg.x, y: msg.y, z: msg.z, be };
      this.cb.onBEOpen(kind, msg.x, msg.y, msg.z, be);
    } else if (at(this._beOpen)) {
      // host refresh for an open container (rare — e.g. reconnect edge cases)
      const be = wireToLocalBE(msg.be);
      if (be && be.kind === this._beOpen.be.kind) Object.assign(this._beOpen.be, be);
    }
  }

  _onBEDeny(msg) {
    const at = (o) => o && o.x === msg.x && o.y === msg.y && o.z === msg.z;
    if (at(this._bePending)) this._bePending = null;
    if (at(this._beOpen)) { this._beOpen = null; this.cb.onBEForceClose(); }
    this.cb.onNotify(msg.reason);
  }

  // ---------- outgoing actions (called from game code) ----------
  requestBE(kind, x, y, z) {
    this._bePending = { x, y, z, kind };
    this.peer.send("beReq", { x, y, z, kind });
  }
  closeBE() {
    if (!this._beOpen) return;
    const { x, y, z, be } = this._beOpen;
    this._beOpen = null;
    this.peer.send("beState", { x, y, z, be: localBEToWire(be), final: 1 });
  }
  sendEntityHit(netId, heldKey) {
    this.peer.send("hit", { eid: netId, held: heldKey || "" });
  }
  sendPlayerHit(pid, heldKey) {
    this.peer.send("phit", { pid, held: heldKey || "" });
  }
  sendToss(p, d, key, count, dura) {
    this.peer.send("toss", { p: [p[0], p[1], p[2]], d: [clampD(d[0]), clampD(d[1]), clampD(d[2])], key, count, dura });
  }
  voteSleep(on) { this.peer.send("sleep", { on: on ? 1 : 0 }); }

  sendPState() {
    if (!this.game) return;
    this.peer.send("pstate", {
      player: this.game.player.toJSON(),
      inventory: this.game.inventory.toJSON(),
    });
  }

  // ---------- per-frame ----------
  update(dt) {
    if (!this.game || this._closed) return;
    const now = performance.now();
    this.ghosts.tick(dt, now);

    this._poseT += dt * 1000;
    if (this._poseT >= POSE_MS) {
      this._poseT = 0;
      const p = this.game.player;
      const fl = (p.swimming ? 1 : 0) | (p.flying ? 4 : 0);
      this.peer.sendFast("pose", {
        p: [r2(p.pos[0]), r2(p.pos[1]), r2(p.pos[2])],
        v: [r2(p.vel[0]), r2(p.vel[1]), r2(p.vel[2])],
        yaw: r2(p.yaw), pitch: r2(p.pitch),
        hp: Math.round(p.health), fl,
      });
    }

    this._pingT += dt * 1000;
    if (this._pingT >= PING_MS) { this._pingT = 0; this.peer.sendFast("ping", { ts: performance.now() }); }

    this._pstateT += dt * 1000;
    if (this._pstateT >= PSTATE_MS) { this._pstateT = 0; this.sendPState(); }

    // push open-container slots so the host never lags far behind
    this._beT += dt * 1000;
    if (this._beT >= BE_PUSH_MS && this._beOpen) {
      this._beT = 0;
      const { x, y, z, be } = this._beOpen;
      this.peer.send("beState", { x, y, z, be: localBEToWire(be), final: 0 });
    }

    // ease the local clock toward the host's (snap only when way off)
    if (this._timeTarget != null && !this.game.sky.isSleeping()) {
      const sky = this.game.sky;
      let d = this._timeTarget - sky.time;
      if (d > 0.5) d -= 1; if (d < -0.5) d += 1;
      if (Math.abs(d) > 0.05) sky.time = this._timeTarget;
      else sky.time = (sky.time + d * Math.min(1, dt * 2) + 1) % 1;
    }
  }

  playerCount() { return this.roster.size + 1; }

  dispose(polite = true) {
    this._closed = true;
    if (polite) {
      try { this.sendPState(); } catch { /* closing */ }
      try { this.peer.send("bye", {}); } catch { /* closing */ }
    }
    const finish = () => { try { this.peer.close(); } catch { /* closed */ } };
    if (polite) setTimeout(finish, 200); else finish();
    if (this.ghosts) this.ghosts.clear();
    if (this.game && this.game.world) {
      this.game.world.netRole = null;
      this.game.world.onNetEdit = null;
    }
  }
}

// ---------- world payload validation ----------
// The host's snapshot is save-shaped. Rebuild it field by field; reject the
// whole thing on any surprise. Unknown block keys are tolerated (they map to
// air on apply — same as loading an old save).
function validateWorldPayload(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  if (typeof v.seed !== "number" || !Number.isFinite(v.seed)) return null;
  if (typeof v.name !== "string") return null;
  if (typeof v.time !== "number" || !(v.time >= 0 && v.time <= 1)) return null;
  if (!Array.isArray(v.spawn) || v.spawn.length !== 3 || v.spawn.some((n) => typeof n !== "number" || !Number.isFinite(n))) return null;

  const edits = {};
  if (v.edits) {
    if (typeof v.edits !== "object" || Array.isArray(v.edits)) return null;
    let total = 0;
    for (const key of Object.keys(v.edits)) {
      if (!/^-?\d+,-?\d+$/.test(key)) return null;
      const src = v.edits[key];
      if (!Array.isArray(src) || src.length > 65536) return null;
      total += src.length;
      if (total > 4_000_000) return null;
      const list = [];
      for (const e of src) {
        if (!Array.isArray(e) || e.length < 2 || e.length > 3) return null;
        const [li, bk, meta] = e;
        if (!Number.isInteger(li) || li < 0 || li > 65535) return null;
        if (typeof bk !== "string" || bk.length > 32) return null;
        if (meta !== undefined && (!Number.isInteger(meta) || meta < 0 || meta > 63)) return null;
        list.push(meta ? [li, bk, meta] : [li, bk]);
      }
      edits[key] = list;
    }
  }

  const blockEntities = [];
  if (v.blockEntities) {
    if (!Array.isArray(v.blockEntities) || v.blockEntities.length > 20000) return null;
    for (const e of v.blockEntities) {
      if (!e || typeof e !== "object") return null;
      if (!Array.isArray(e.pos) || e.pos.length !== 3 || e.pos.some((n) => !Number.isInteger(n))) return null;
      const okSlot = (a) => a === null || a === undefined ||
        (Array.isArray(a) && typeof a[0] === "string" && a[0].length <= 40 && Number.isInteger(a[1]) && a[1] >= 1 && a[1] <= 999);
      if (e.kind === "forge") {
        if (![e.input, e.fuel, e.output].every(okSlot)) return null;
        blockEntities.push({ pos: [e.pos[0], e.pos[1], e.pos[2]], kind: "forge",
          input: e.input ?? null, fuel: e.fuel ?? null, output: e.output ?? null,
          fuelLeft: num0(e.fuelLeft), fuelMax: num0(e.fuelMax), progress: num0(e.progress) });
      } else if (e.kind === "chest") {
        if (!Array.isArray(e.slots) || e.slots.length > 54 || !e.slots.every(okSlot)) return null;
        blockEntities.push({ pos: [e.pos[0], e.pos[1], e.pos[2]], kind: "chest", slots: e.slots });
      } else return null;
    }
  }

  const player = v.player ? cleanPlayerJSON(v.player) : null;
  if (v.player && !player) return null;
  const inventory = v.inventory ? cleanInvJSON(v.inventory) : null;
  if (v.inventory && !inventory) return null;

  return {
    name: v.name.slice(0, 28),
    seed: v.seed >>> 0,
    genVer: (typeof v.genVer === "number" && v.genVer >= 1 && v.genVer <= 99) ? (v.genVer | 0) : 1,
    time: v.time,
    spawn: [v.spawn[0], v.spawn[1], v.spawn[2]],
    edits,
    blockEntities,
    player,
    inventory,
  };
}
function num0(n) { return (typeof n === "number" && Number.isFinite(n) && n >= 0) ? n : 0; }

// ---- container wire conversion (client side) ----
const unpackS = (a) => a ? { key: a[0], count: a[1], dura: a[2] ?? undefined } : null;
const packS = (s) => s ? [s.key, s.count, s.dura ?? null] : null;

function wireToLocalBE(w) {
  if (!w) return null;
  if (w.kind === "chest") return { kind: "chest", slots: w.slots.map(unpackS) };
  if (w.kind === "forge") return { kind: "forge", input: unpackS(w.input), fuel: unpackS(w.fuel), output: unpackS(w.output),
    fuelLeft: w.fuelLeft, fuelMax: w.fuelMax, progress: w.progress };
  return null;
}
function localBEToWire(be) {
  if (be.kind === "chest") return { kind: "chest", slots: be.slots.map(packS) };
  return { kind: "forge", input: packS(be.input), fuel: packS(be.fuel), output: packS(be.output),
    fuelLeft: be.fuelLeft || 0, fuelMax: be.fuelMax || 0, progress: be.progress || 0 };
}

function clampD(v) { return Math.max(-2, Math.min(2, v)); }
function r2(v) { return Math.round(v * 100) / 100; }
