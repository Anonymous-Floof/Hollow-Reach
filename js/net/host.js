// NetHost: runs the authoritative world and fans state out to guests.
//
// Trust model: guests are UNTRUSTED. Every message has already passed the
// protocol shape validator (transport.js); this layer adds the semantics —
// version gate at handshake, movement speed checks, reach checks on edits and
// combat, per-action rate limits, and block/item id whitelists. A guest who
// fails a check gets a correction (rollback / teleport), not a crash.
//
// What the host shares: the world being played (seed, edits, block entities,
// live entity state, time) and player poses. Nothing else — no other saves,
// no storage, no settings.

import { Peer } from "./transport.js";
import { encodeSignal, decodeSignal } from "./signal.js";
import { NET_VERSION, Bucket, okPid, MAX_NAME } from "./protocol.js";
import { GhostWorld, buildEntTuples } from "./ghosts.js";
import { SAVE_VERSION } from "../save/serialize.js";
import { GAME_VERSION } from "../version.js";
import { serializeEntities, bePosKey } from "../game/blockentities.js";
import { BLOCKS, getBlock } from "../world/blocks.js";
import { getItem } from "../game/items.js";
import { defOf } from "../game/entities/registry.js";
import { attackDamage } from "../game/entities/ai.js";
import { SEAT_Y } from "../game/entities/boat.js";
import { CX, CZ } from "../world/chunk.js";

const PROTO = `${SAVE_VERSION}.${NET_VERSION}`;
export const MAX_GUESTS = 7;

const EDIT_REACH = 14;        // blocks: max edit distance from the guest (covers leaf decay)
const HIT_REACH = 8;          // blocks: max melee distance (6 raycast + interp/lag slack)
const BE_REACH = 8;           // blocks: max container distance
const PICKUP_R2 = 1.8 * 1.8;
const SNAP_MS = 100;          // entity snapshot period
const EDIT_FLUSH_MS = 90;     // outgoing edit batch period

export class NetHost {
  // game: the Game instance (world/player/inventory/sky live there).
  constructor(game, hostPid, hostName, onRosterChange) {
    this.isHost = true;
    this.isClient = false;
    this.game = game;
    this.hostPid = hostPid;
    this.hostName = hostName;
    this.onRosterChange = onRosterChange || (() => {});
    this.peers = [];             // per-connection state records
    this.pendingInvites = [];    // Peers created but not yet answered/connected
    this.ghosts = new GhostWorld(game.world);
    this.beLocks = new Map();    // "x,y,z" -> { pid, t }
    this.sleepVotes = new Set(); // pids (incl. hostPid) wanting to sleep
    this.remoteStates = game.remotePlayersStore || {};  // pid -> {name, player, inventory}
    this._snapT = 0;
    this._flushT = 0;
    this._beT = 0;
    this._hostHurt = false;

    const world = game.world;
    world.netRole = "host";
    world.netCenters = [];
    world._beFrozen = this.beLocks;   // forges a guest holds open pause smelting
    // every local edit (host mining/placing, water sim, leaf decay, grass) is
    // queued for every guest — applyRemoteEdit (guest edits) bypasses this hook,
    // and _applyClientEdit queues those manually with the origin excluded.
    world.onNetEdit = (x, y, z, id, meta) => this._queueEdit(x, y, z, id, meta, null);
  }

  activePeers() { return this.peers.filter((p) => p.active && !p.peer.closed); }
  playerCount() { return 1 + this.activePeers().length; }

  // ---------- invite flow (copy-paste signaling) ----------
  async createInvite() {
    if (this.activePeers().length >= MAX_GUESTS) throw new Error("Player limit reached");
    const peer = new Peer("host");
    const desc = await peer.makeOffer();
    const code = await encodeSignal(desc);
    const state = this._makeState(peer);
    this.pendingInvites.push(state);
    peer.onOpen = () => { /* waits for hello */ };
    peer.onClose = () => this._dropPeer(state, false);
    peer.onMessage = (msg, p, ch) => this._onMessage(state, msg, ch);
    return { state, code };
  }
  async acceptAnswer(state, codeText) {
    const desc = await decodeSignal(codeText);
    if (!desc || desc.type !== "answer") throw new Error("That is not a valid reply code");
    await state.peer.acceptAnswer(desc);
  }
  cancelInvite(state) {
    this.pendingInvites = this.pendingInvites.filter((s) => s !== state);
    try { state.peer.close(); } catch { /* already closed */ }
  }

  _makeState(peer) {
    return {
      peer,
      pid: null, name: "Player",
      active: false,              // true after hello+world+ready
      lastPose: null, lastPoseT: 0,
      pcx: null, pcz: null,       // last chunk coords (for unload sweeps)
      hurtFlag: false,
      buckets: {
        edit: new Bucket(40, 120),
        hit: new Bucket(5, 10),
        toss: new Bucket(8, 20),
        be: new Bucket(6, 12),
        pose: new Bucket(40, 80),
        misc: new Bucket(10, 20),
      },
      editQueue: [],
    };
  }

  // ---------- message handling ----------
  _onMessage(st, msg, channel) {
    switch (msg.t) {
      case "hello": return this._onHello(st, msg);
      case "ready": return this._onReady(st);
      case "pose": return this._onPose(st, msg);
      case "edit": return this._onEdit(st, msg);
      case "hit": return this._onHit(st, msg);
      case "phit": return this._onPHit(st, msg);
      case "bmount": return this._onBMount(st, msg);
      case "bspawn": return this._onBSpawn(st, msg);
      case "warp": return this._onWarp(st);
      case "toss": return this._onToss(st, msg);
      case "sleep": return this._onSleep(st, msg);
      case "beReq": return this._onBEReq(st, msg);
      case "beState": return this._onBEState(st, msg);
      case "pstate": return this._onPState(st, msg);
      case "ping": st.peer.sendFast("pong", { ts: msg.ts }); return;
      case "bye": return this._dropPeer(st, true);
      default: return;   // host never accepts host->client message types back
    }
  }

  _onHello(st, msg) {
    if (st.active || st.pid) return;
    if (msg.ver !== PROTO) {
      st.peer.send("reject", { reason: `Version mismatch — the host is running Hollowreach v${GAME_VERSION}; both players need the same game version` });
      setTimeout(() => st.peer.close(), 400);
      return;
    }
    if (!okPid(msg.cid)) { st.peer.send("reject", { reason: "Bad client id" }); setTimeout(() => st.peer.close(), 400); return; }
    if (msg.cid === this.hostPid || this.peers.some((p) => p.pid === msg.cid)) {
      st.peer.send("reject", { reason: "Already connected" });
      setTimeout(() => st.peer.close(), 400);
      return;
    }
    st.pid = msg.cid;
    st.name = (msg.name || "Player").slice(0, MAX_NAME) || "Player";
    this.pendingInvites = this.pendingInvites.filter((s) => s !== st);
    this.peers.push(st);
    this._sendWorld(st);
  }

  _sendWorld(st) {
    const g = this.game, world = g.world;
    const stored = this.remoteStates[st.pid] || null;
    const spawn = g.spawn ? g.spawn.slice() : [8.5, 80, 8.5];
    // serialize the edits map in the save format (block keys, not ids)
    const edits = {};
    for (const [key, m] of world.edits) {
      const arr = [];
      for (const [li, packed] of m) {
        const id = packed & 1023, meta = (packed >> 10) & 0x3f;
        arr.push(meta ? [li, BLOCKS[id] ? BLOCKS[id].key : "air", meta] : [li, BLOCKS[id] ? BLOCKS[id].key : "air"]);
      }
      if (arr.length) edits[key] = arr;
    }
    const payload = JSON.stringify({
      name: (g.meta && g.meta.name || "World").slice(0, 28),
      seed: world.seed >>> 0,
      genVer: world.genVer || 1,
      time: g.sky.time,
      spawn,
      edits,
      blockEntities: serializeEntities(world.blockEntities),
      player: stored ? stored.player : null,
      inventory: stored ? stored.inventory : null,
      ownSpawn: stored && stored.spawn ? stored.spawn : null,   // guest's attuned Soul Anchor
    });
    const SLICE = 48 * 1024;
    const parts = Math.max(1, Math.ceil(payload.length / SLICE));
    for (let i = 0; i < parts; i++) {
      st.peer.send("world", { part: i, parts, data: payload.slice(i * SLICE, (i + 1) * SLICE) });
    }
  }

  _onReady(st) {
    if (st.active || !st.pid) return;
    st.active = true;
    // roster: tell the newcomer about everyone, everyone about the newcomer
    st.peer.send("pjoin", { pid: this.hostPid, name: this.hostName });
    for (const p of this.activePeers()) {
      if (p !== st) st.peer.send("pjoin", { pid: p.pid, name: p.name });
    }
    this._broadcast("pjoin", { pid: st.pid, name: st.name }, st);
    this._broadcast("notify", { msg: `${st.name} joined the world` }, st);
    this.game.onNetNotify(`${st.name} joined the world`);
    this.onRosterChange();
  }

  _onPose(st, msg) {
    if (!st.active || !st.buckets.pose.take()) return;
    const now = performance.now();
    // movement sanity: reject teleport-grade jumps, correct the client back
    if (st.lastPose) {
      const dt = Math.min(2, Math.max(0.01, (now - st.lastPoseT) / 1000));
      const dx = msg.p[0] - st.lastPose[0], dy = msg.p[1] - st.lastPose[1], dz = msg.p[2] - st.lastPose[2];
      const d = Math.hypot(dx, dy, dz);
      if (d > 80 * dt + 8) {
        st.peer.send("tp", { p: [st.lastPose[0], st.lastPose[1], st.lastPose[2]] });
        return;
      }
    }
    st.lastPose = [msg.p[0], msg.p[1], msg.p[2]];
    st.lastPoseT = now;
    st.hp = msg.hp;
    this.ghosts.feedPlayerPose(st.pid, st.name, msg, now);
    // chunk-boundary cross -> allow the world to sweep far chunks
    const pcx = Math.floor(msg.p[0] / CX), pcz = Math.floor(msg.p[2] / CZ);
    if (pcx !== st.pcx || pcz !== st.pcz) { st.pcx = pcx; st.pcz = pcz; this.game.world._forceUnloadSweep = true; }
  }

  _onEdit(st, msg) {
    if (!st.active) return;
    if (!st.buckets.edit.take()) return this._denyEdit(st, msg);
    if (!st.lastPose) return this._denyEdit(st, msg);
    // reach (generous: covers the leaf-decay halo around a felled tree)
    if (Math.abs(msg.x - st.lastPose[0]) > EDIT_REACH ||
        Math.abs(msg.y - st.lastPose[1]) > EDIT_REACH ||
        Math.abs(msg.z - st.lastPose[2]) > EDIT_REACH) return this._denyEdit(st, msg);
    if (!BLOCKS[msg.id]) return this._denyEdit(st, msg);
    // a station block was replaced/removed remotely: spill + drop its block entity
    const world = this.game.world;
    const prev = getBlock(world.getBlock(msg.x, msg.y, msg.z));
    if (prev && prev.station && msg.id !== world.getBlock(msg.x, msg.y, msg.z)) this._spillBE(msg.x, msg.y, msg.z);
    world.applyRemoteEdit(msg.x, msg.y, msg.z, msg.id, msg.meta);
    this._queueEdit(msg.x, msg.y, msg.z, msg.id, msg.meta, st);
  }

  _denyEdit(st, msg) {
    const world = this.game.world;
    st.peer.send("editDeny", {
      x: msg.x, y: msg.y, z: msg.z,
      id: world.getBlock(msg.x, msg.y, msg.z), meta: world.getMeta(msg.x, msg.y, msg.z),
    });
  }

  // Break/replace of a container: spill contents as drops and force-close any
  // guest UI holding it open.
  _spillBE(x, y, z) {
    const world = this.game.world;
    const key = bePosKey(x, y, z);
    const be = world.blockEntities.get(key);
    if (be) {
      const stacks = be.kind === "forge" ? [be.input, be.fuel, be.output] : (be.slots || []);
      for (const s of stacks) if (s) world.spawnDrop(x + 0.5, y + 0.5, z + 0.5, s.key, s.count, s.dura);
      world.removeBlockEntity(x, y, z);
    }
    const lock = this.beLocks.get(key);
    if (lock) {
      this.beLocks.delete(key);
      const holder = this.peers.find((p) => p.pid === lock.pid);
      if (holder) holder.peer.send("beDeny", { x, y, z, reason: "Container was destroyed" });
    }
  }

  _onHit(st, msg) {
    if (!st.active || !st.buckets.hit.take() || !st.lastPose) return;
    const world = this.game.world;
    const e = world.entities.entities.find((en) => en.id === msg.eid && !en.ghost && !en.dead);
    if (!e) return;
    if (dist3(st.lastPose, e.pos) > HIT_REACH) return;
    const def = defOf(e.type);
    if (!def || !def.hooks || !def.hooks.onInteract) return;
    // a ridden boat can't be broken out from under its rider
    if (e.type === "boat" && (e.data.rider || e.data.riderPid)) return;
    const heldOk = msg.held && getItem(msg.held) ? msg.held : null;
    const ctx = this._shimCtx(st, heldOk, msg.crit === 1);
    def.hooks.onInteract(e, ctx, "left");
    const vpos = [e.pos[0], e.pos[1] + e.h * 0.7, e.pos[2]];
    this._relaySfx("thwack", vpos);
    if (e.type === "sheep" || e.type === "pig" || e.type === "cow" || e.type === "zombie") {
      this._relaySfx(`${e.type}_${e.dead ? "death" : "hurt"}`, vpos);
    }
  }

  _onPHit(st, msg) {
    if (!st.active || !st.buckets.hit.take() || !st.lastPose) return;
    if (!okPid(msg.pid)) return;
    const heldOk = msg.held && getItem(msg.held) ? msg.held : null;
    const dmg = attackDamage({ selectedSlot: () => heldOk ? { key: heldOk, count: 1 } : null },
      msg.crit === 1 ? fallingAttacker() : null);
    // victim: the host player, or another guest
    if (msg.pid === this.hostPid) {
      const hp = this.game.player;
      if (dist3(st.lastPose, hp.pos) > HIT_REACH) return;
      const l = Math.hypot(hp.pos[0] - st.lastPose[0], hp.pos[2] - st.lastPose[2]) || 1;
      const kb = [(hp.pos[0] - st.lastPose[0]) / l * 4, 3, (hp.pos[2] - st.lastPose[2]) / l * 4];
      hp.damage(dmg, { defense: this.game.inventory.totalDefense() });
      hp.vel[0] += kb[0]; hp.vel[2] += kb[2]; hp.vel[1] = Math.max(hp.vel[1], kb[1]);
      this._hostHurt = true;
      this._relaySfx("thwack", [hp.pos[0], hp.pos[1] + 1.4, hp.pos[2]]);
      return;
    }
    const victim = this.peers.find((p) => p.pid === msg.pid && p.active);
    if (!victim || !victim.lastPose) return;
    if (dist3(st.lastPose, victim.lastPose) > HIT_REACH) return;
    const l = Math.hypot(victim.lastPose[0] - st.lastPose[0], victim.lastPose[2] - st.lastPose[2]) || 1;
    const kb = [(victim.lastPose[0] - st.lastPose[0]) / l * 4, 3, (victim.lastPose[2] - st.lastPose[2]) / l * 4];
    victim.peer.send("dmg", { amount: dmg, kb });
    victim.hurtFlag = true;
    this._relaySfx("thwack", [victim.lastPose[0], victim.lastPose[1] + 1.4, victim.lastPose[2]]);
  }

  // ctx handed to entity hooks for a REMOTE attacker: a stand-in player at the
  // attacker's position and a stand-in inventory holding their claimed tool.
  // Mutating hooks (damage/tool wear/notify) hit harmless no-ops. The world is
  // wrapped so death drops spawn as walk-over pickups (instant:false) — the
  // kill belongs to the guest, not the host's auto-vacuum. When the guest
  // claims a falling crit, the stand-in carries the mid-fall markers so
  // attackDamage lands the ×1.5 (remote: true keeps the crit snap sound from
  // playing on the host's speakers).
  _shimCtx(st, heldKey, crit) {
    const slot = heldKey ? { key: heldKey, count: 1 } : null;
    const world = this.game.world;
    const w = Object.create(world);
    w.spawnDrop = (x, y, z, key, count = 1, dura) => {
      const e = world.entities.spawn("drop", [x, y, z], { key, count, dura, instant: false, pickupDelay: 0.4 });
      if (e) e.vel = [(Math.random() - 0.5) * 2, 2.2, (Math.random() - 0.5) * 2];
      return e;
    };
    const p = crit ? fallingAttacker() : { vel: [0, 0, 0], onGround: true, remote: true };
    p.pos = st.lastPose.slice(); p.health = 20; p.damage = () => {};
    return {
      world: w,
      player: p,
      inventory: { selectedSlot: () => slot, damageSelectedTool: () => false, totalDefense: () => 0 },
      notify: () => {},
      input: null,
      sky: this.game.sky,
    };
  }

  // A guest asked to ride (on=1) or leave (on=0) a boat.
  _onBMount(st, msg) {
    if (!st.active || !st.buckets.misc.take() || !st.lastPose) return;
    const world = this.game.world;
    const e = world.entities.entities.find((en) => en.id === msg.eid && !en.ghost && !en.dead && en.type === "boat");
    if (msg.on === 0) {
      if (e && e.data.riderPid === st.pid) e.data.riderPid = null;
      return;
    }
    if (!e || e.data.rider || e.data.riderPid || dist3(st.lastPose, e.pos) > HIT_REACH) {
      st.peer.send("bdeny", { eid: msg.eid });
      return;
    }
    e.data.riderPid = st.pid;
  }

  // A guest placed a boat from the item (consumed client-side). Requests that
  // can't be honoured (no pose yet — a just-joined race — or out of reach)
  // refund the item instead of silently voiding it.
  _onBSpawn(st, msg) {
    if (!st.active || !st.buckets.misc.take()) return;
    if (!st.lastPose || dist3(st.lastPose, msg.p) > 10) {
      st.peer.send("give", { key: "boat", count: 1 });
      return;
    }
    this.game.world.spawnBoat(msg.p[0], msg.p[1], msg.p[2]);
  }

  // A guest used a wayshard: a legitimate straight-up teleport that would
  // otherwise trip the movement sanity check. Re-anchor their last-known pose
  // at the surface the host computes for that column — same x/z, so this can't
  // be abused as a free horizontal teleport.
  _onWarp(st) {
    if (!st.active || !st.buckets.misc.take() || !st.lastPose) return;
    const world = this.game.world;
    const ts = world.topSolidY(Math.floor(st.lastPose[0]), Math.floor(st.lastPose[2]));
    if (ts >= 0) st.lastPose = [st.lastPose[0], ts + 1, st.lastPose[2]];
  }

  _onToss(st, msg) {
    if (!st.active || !st.buckets.toss.take() || !st.lastPose) return;
    if (dist3(st.lastPose, msg.p) > 4) return;
    if (!getItem(msg.key)) return;
    const count = Math.min(99, msg.count);
    this.game.world.spawnTossed(msg.p[0], msg.p[1], msg.p[2], msg.d, msg.key, count, msg.dura);
  }

  _onSleep(st, msg) {
    if (!st.active || !st.buckets.misc.take()) return;
    this.voteSleep(st.pid, msg.on === 1);
  }

  // Shared by guests (via _onSleep) and the host player (main.js trySleep).
  voteSleep(pid, on) {
    if (on) this.sleepVotes.add(pid); else this.sleepVotes.delete(pid);
    const total = this.playerCount();
    if (on && this.sleepVotes.size >= total) {
      this.sleepVotes.clear();
      if (!this.game.sky.isNight()) return;
      this.game.sky.startSleep();
      this._broadcast("notify", { msg: "Everyone is asleep — good night" }, null);
      this.game.onNetNotify("Everyone is asleep — good night");
    } else if (on) {
      const m = `${this.sleepVotes.size}/${total} players sleeping`;
      this._broadcast("notify", { msg: m }, null);
      this.game.onNetNotify(m);
    }
  }

  _onBEReq(st, msg) {
    if (!st.active || !st.buckets.be.take() || !st.lastPose) return;
    if (dist3(st.lastPose, [msg.x + 0.5, msg.y + 0.5, msg.z + 0.5]) > BE_REACH) return;
    const world = this.game.world;
    const b = getBlock(world.getBlock(msg.x, msg.y, msg.z));
    if (!b || !b.station || (b.station !== "chest" && b.station !== "forge")) {
      // workbench has no state: let the client open it locally; anything else is a no
      return st.peer.send("beDeny", { x: msg.x, y: msg.y, z: msg.z, reason: "Nothing to open here" });
    }
    const key = bePosKey(msg.x, msg.y, msg.z);
    const lock = this.beLocks.get(key);
    if (lock && lock.pid !== st.pid) {
      return st.peer.send("beDeny", { x: msg.x, y: msg.y, z: msg.z, reason: "Someone else is using this" });
    }
    const be = world.getOrCreateBlockEntity(msg.x, msg.y, msg.z, b.station);
    this.beLocks.set(key, { pid: st.pid, t: performance.now() });
    st.peer.send("beState", { x: msg.x, y: msg.y, z: msg.z, be: beToWire(be), final: 0 });
  }

  _onBEState(st, msg) {
    if (!st.active || !st.buckets.be.take()) return;
    const key = bePosKey(msg.x, msg.y, msg.z);
    const lock = this.beLocks.get(key);
    if (!lock || lock.pid !== st.pid) return;       // must hold the lock
    const world = this.game.world;
    const existing = world.blockEntities.get(key);
    if (!existing || existing.kind !== msg.be.kind) return;
    applyWireBE(existing, msg.be);
    if (msg.final === 1) this.beLocks.delete(key);
  }

  _onPState(st, msg) {
    if (!st.pid || !st.buckets.misc.take()) return;
    this.remoteStates[st.pid] = { name: st.name, player: msg.player, inventory: msg.inventory,
      spawn: msg.spawn || null };
  }

  // ---------- per-frame ----------
  update(dt) {
    const now = performance.now();
    const world = this.game.world;

    // interpolate remote-player ghosts (rendered on the host too)
    this.ghosts.tick(dt, now);

    // boats ridden by guests follow their rider's reported pose (the guest
    // simulates the ride client-side; the real boat is pinned under them here
    // so everyone else sees it move). A vanished/faraway rider releases it.
    for (const e of world.entities.entities) {
      if (e.dead || e.ghost || e.type !== "boat" || !e.data.riderPid) continue;
      const rider = this.peers.find((p) => p.pid === e.data.riderPid && p.active);
      if (!rider || !rider.lastPose || dist3(rider.lastPose, e.pos) > 30) { e.data.riderPid = null; continue; }
      e.pos[0] = rider.lastPose[0];
      e.pos[1] = rider.lastPose[1] - SEAT_Y;
      e.pos[2] = rider.lastPose[2];
      e.vel[0] = e.vel[1] = e.vel[2] = 0;
      const g = this.ghosts.players.get(e.data.riderPid);
      if (g && g.e._buf.length) e.yaw = g.e._buf[g.e._buf.length - 1].yaw - Math.PI;
    }

    // stream/simulation centres follow the guests
    const centers = [];
    for (const p of this.activePeers()) if (p.lastPose) centers.push([p.lastPose[0], p.lastPose[2]]);
    world.netCenters = centers.length ? centers : null;

    // entity snapshots + player poses @10Hz on the lossy channel
    this._snapT += dt * 1000;
    if (this._snapT >= SNAP_MS) {
      this._snapT = 0;
      const players = {};
      const hp = this.game.player;
      const hbits = (hp.swimming ? 1 : 0) | (0 << 1) | (hp.flying ? 4 : 0);
      players[this.hostPid] = [r2(hp.pos[0]), r2(hp.pos[1]), r2(hp.pos[2]), r2(hp.yaw), r2(hp.pitch),
        hbits, Math.round(hp.health), this._hostHurt ? 1 : 0];
      this._hostHurt = false;
      for (const p of this.activePeers()) {
        if (!p.lastPose) continue;
        const g = this.ghosts.players.get(p.pid);
        const yaw = g && g.e._buf.length ? g.e._buf[g.e._buf.length - 1].yaw - Math.PI : 0;
        const pitch = g && g.e._buf.length ? g.e._buf[g.e._buf.length - 1].pitch : 0;
        players[p.pid] = [r2(p.lastPose[0]), r2(p.lastPose[1]), r2(p.lastPose[2]), r2(yaw), r2(pitch),
          0, Math.round(p.hp ?? 20), p.hurtFlag ? 1 : 0];
        p.hurtFlag = false;
      }
      const ents = buildEntTuples(world.entities.entities);
      const snap = { time: this.game.sky.time, ents, players };
      for (const p of this.activePeers()) p.peer.sendFast("snap", snap);
    }

    // outgoing edit batches
    this._flushT += dt * 1000;
    if (this._flushT >= EDIT_FLUSH_MS) {
      this._flushT = 0;
      for (const p of this.activePeers()) {
        while (p.editQueue.length) {
          const slice = p.editQueue.splice(0, 512);
          p.peer.send("edits", { list: slice });
        }
      }
    }

    // award drop pickups to nearby guests (host picks up via drop.js proximity)
    this._awardPickups();

    // stale container-lock cleanup (holder left, wandered off, or timed out).
    // Locked forges are frozen (see world.tickBlockEntities), so no progress
    // pushes are needed while a guest has one open.
    this._beT += dt;
    if (this._beT >= 1) {
      this._beT = 0;
      for (const [key, lock] of this.beLocks) {
        const holder = this.peers.find((p) => p.pid === lock.pid && p.active);
        const [x, y, z] = key.split(",").map(Number);
        const be = world.blockEntities.get(key);
        if (!holder || !be || (holder.lastPose && dist3(holder.lastPose, [x + 0.5, y + 0.5, z + 0.5]) > BE_REACH + 4) ||
            now - lock.t > 120000) {
          this.beLocks.delete(key);
          if (holder) holder.peer.send("beDeny", { x, y, z, reason: "Container closed" });
        }
      }
      // keep the clock in step (cheap, reliable channel)
      const sleeping = this.game.sky.isSleeping() ? 1 : 0;
      this._broadcast("time", { t: this.game.sky.time, sleeping }, null);
    }
    // faster time stream while sleeping so guests see the sky wheel by
    if (this.game.sky.isSleeping()) {
      this._broadcast("time", { t: this.game.sky.time, sleeping: 1 }, null);
    }
  }

  _awardPickups() {
    const world = this.game.world;
    const guests = this.activePeers().filter((p) => p.lastPose);
    if (!guests.length) return;
    for (const e of world.entities.entities) {
      if (e.dead || e.ghost || e.type !== "drop") continue;
      if (e.age < (e.data.pickupDelay ?? 0.5)) continue;
      for (const p of guests) {
        const dx = p.lastPose[0] - e.pos[0], dy = (p.lastPose[1] + 0.9) - e.pos[1], dz = p.lastPose[2] - e.pos[2];
        if (dx * dx + dy * dy + dz * dz > PICKUP_R2) continue;
        p.peer.send("give", { key: e.data.key, count: Math.min(999, e.data.count || 1), dura: e.data.dura });
        e.dead = true;
        break;
      }
    }
  }

  // Combat target list for zombie AI: the host player + every remote player.
  combatTargets() {
    const g = this.game;
    const out = [{
      pos: g.player.pos, health: g.player.health,
      hurt: (dmg, kb) => {
        g.player.damage(dmg, { defense: g.inventory.totalDefense() });
        g.player.vel[0] += kb[0]; g.player.vel[2] += kb[2];
        g.player.vel[1] = Math.max(g.player.vel[1], kb[1]);
        this._hostHurt = true;
        g.onNetNotify("A zombie claws at you!");
      },
    }];
    for (const p of this.activePeers()) {
      if (!p.lastPose) continue;
      out.push({
        pos: p.lastPose, health: p.hp ?? 20,
        hurt: (dmg, kb) => { p.peer.send("dmg", { amount: dmg, kb }); p.hurtFlag = true; },
      });
    }
    return out;
  }

  hostVoteSleep() { this.voteSleep(this.hostPid, true); }

  // [x,z] of every connected guest (for mob spawning near them).
  remoteCenters() {
    const out = [];
    for (const p of this.activePeers()) if (p.lastPose) out.push([p.lastPose[0], p.lastPose[2]]);
    return out;
  }

  // interact.js routes ghost hits here. On the host the only ghosts are remote
  // players, so this IS the PvP path for the host player's own swings.
  sendPlayerHit(pid, heldKey) {
    const victim = this.peers.find((p) => p.pid === pid && p.active);
    if (!victim || !victim.lastPose) return;
    const hp = this.game.player;
    if (dist3(hp.pos, victim.lastPose) > HIT_REACH) return;
    const dmg = attackDamage(this.game.inventory, this.game.player);   // host PvP swings can crit
    const l = Math.hypot(victim.lastPose[0] - hp.pos[0], victim.lastPose[2] - hp.pos[2]) || 1;
    const kb = [(victim.lastPose[0] - hp.pos[0]) / l * 4, 3, (victim.lastPose[2] - hp.pos[2]) / l * 4];
    victim.peer.send("dmg", { amount: dmg, kb });
    victim.hurtFlag = true;
    const held = heldKey ? getItem(heldKey) : null;
    if (held && held.type === "tool") this.game.inventory.damageSelectedTool(1);
    this._relaySfx("thwack", [victim.lastPose[0], victim.lastPose[1] + 1.4, victim.lastPose[2]]);
  }
  sendEntityHit() { /* host hits real entities directly — never reached */ }

  beLockedByGuest(x, y, z) {
    const lock = this.beLocks.get(bePosKey(x, y, z));
    return lock ? lock.pid : null;
  }

  // Snapshot of remote player states for the save file.
  remotePlayersForSave() {
    const out = {};
    for (const pid of Object.keys(this.remoteStates)) {
      const s = this.remoteStates[pid];
      if (s && s.player && s.inventory) out[pid] = s;
    }
    return out;
  }

  roster() {
    return this.activePeers().map((p) => ({ pid: p.pid, name: p.name }));
  }

  kick(pid) {
    const st = this.peers.find((p) => p.pid === pid);
    if (!st) return;
    st.peer.send("reject", { reason: "Kicked by the host" });
    setTimeout(() => { try { st.peer.close(); } catch { /* closed */ } }, 300);
  }

  _relaySfx(kind, p) {
    this._broadcast("sfx", { kind, p: [p[0], p[1], p[2]] }, null);
    // the host hears entity-hook sounds natively; nothing extra locally
  }

  _queueEdit(x, y, z, id, meta, exceptState) {
    // container replaced by a local (host) edit? spill + unlock for guests too
    if (exceptState === null && this.beLocks.has(bePosKey(x, y, z))) this._spillBE(x, y, z);
    for (const p of this.activePeers()) {
      if (p === exceptState) continue;
      p.editQueue.push([x, y, z, id, meta]);
    }
  }

  _broadcast(type, fields, exceptState) {
    for (const p of this.activePeers()) {
      if (p === exceptState) continue;
      p.peer.send(type, fields);
    }
  }

  _dropPeer(st, polite) {
    const wasActive = st.active;
    st.active = false;
    this.peers = this.peers.filter((p) => p !== st);
    this.pendingInvites = this.pendingInvites.filter((p) => p !== st);
    try { st.peer.close(); } catch { /* closed */ }
    if (st.pid) {
      this.ghosts.removePlayer(st.pid);
      this.sleepVotes.delete(st.pid);
      // release any boat they were riding (it resumes normal physics in place)
      for (const e of this.game.world.entities.entities) {
        if (e.type === "boat" && e.data.riderPid === st.pid) e.data.riderPid = null;
      }
      for (const [key, lock] of this.beLocks) if (lock.pid === st.pid) this.beLocks.delete(key);
      if (wasActive) {
        this._broadcast("pleave", { pid: st.pid }, null);
        this._broadcast("notify", { msg: `${st.name} left the world` }, null);
        this.game.onNetNotify(`${st.name} left the world`);
      }
    }
    this.onRosterChange();
  }

  dispose() {
    for (const p of [...this.peers, ...this.pendingInvites]) {
      try { p.peer.send("bye", {}); } catch { /* closing */ }
      try { p.peer.close(); } catch { /* closed */ }
    }
    this.peers = [];
    this.pendingInvites = [];
    this.ghosts.clear();
    const world = this.game.world;
    if (world) {
      world.netRole = null;
      world.onNetEdit = null;
      world.netCenters = null;
    }
  }
}

// ---- block-entity wire conversion (objects <-> [key,count,dura] arrays) ----
const packS = (s) => s ? [s.key, s.count, s.dura ?? null] : null;
const unpackS = (a) => a ? { key: a[0], count: a[1], dura: a[2] ?? undefined } : null;

export function beToWire(be) {
  if (be.kind === "chest") return { kind: "chest", slots: be.slots.map(packS) };
  return { kind: "forge", input: packS(be.input), fuel: packS(be.fuel), output: packS(be.output),
    fuelLeft: be.fuelLeft, fuelMax: be.fuelMax, progress: be.progress };
}

// Apply a validated wire BE onto a live one. Item keys are checked against the
// item registry; junk keys empty the slot rather than entering the world.
export function applyWireBE(be, wire) {
  const clean = (a) => {
    const s = unpackS(a);
    if (!s || !getItem(s.key)) return null;
    s.count = Math.max(1, Math.min(99, s.count));
    return s;
  };
  if (be.kind === "chest" && wire.kind === "chest") {
    for (let i = 0; i < be.slots.length; i++) be.slots[i] = clean(wire.slots[i] ?? null);
  } else if (be.kind === "forge" && wire.kind === "forge") {
    be.input = clean(wire.input); be.fuel = clean(wire.fuel); be.output = clean(wire.output);
    // fuelLeft/progress stay host-authoritative (the forge ticks here)
  }
}

function dist3(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function r2(v) { return Math.round(v * 100) / 100; }

// Stand-in for a guest mid-fall so attackDamage() applies their claimed crit.
// remote: true suppresses the crit sound host-side (it's the guest's hit).
function fallingAttacker() {
  return { vel: [0, -3, 0], onGround: false, flying: false, swimming: false, climbing: false, remote: true };
}
