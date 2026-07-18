// One WebRTC peer connection wrapped for game use: two data channels
// ("rel" reliable-ordered for world/actions, "fast" unreliable-unordered for
// pose/snapshots), non-trickle offer/answer helpers for the copy-paste
// signaling flow, and per-message decode through the protocol validator so
// nothing malformed ever reaches game code.
//
// The DTLS layer encrypts everything; possession of the pasted code is the
// admission ticket. There is no other way in.

import { decode, encode, MAX_MSG } from "./protocol.js";
import { gatherComplete } from "./signal.js";

// STUN discovers each side's public address for NAT hole punching; no game
// data ever touches it. When a direct path can't be punched (strict/symmetric
// NAT, port-forward-limited routers), a TURN relay is the only fix — there is
// no reliable free public one (Open Relay is gone), so the player can paste
// their own relay credentials in the Multiplayer panel (see getRelayConfig).
// A relay only ever carries the DTLS-encrypted stream, and only one side of a
// connection needs to have one configured.
const STUN = [{
  urls: [
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
    "stun:stun.cloudflare.com:3478",
  ]
}];

const DISCONNECT_GRACE_MS = 12000;   // how long ICE gets to recover before we give up

// ---- user-configured TURN relay (persisted locally, never sent anywhere) ----
const RELAY_KEY = "hollowreach.relay";

// Normalise one pasted relay address into an RTCIceServer url. Providers
// present these every which way ("relay.example.com:1234", "turn:host:1234",
// a full "turn:host:123?transport=tcp"), so a bare host[:port] is assumed to be
// turn: rather than rejected. Returns null for things that clearly aren't a
// relay (a stun:/http:// address, or junk).
export function normalizeRelayUrl(raw) {
  const s = String(raw || "").trim().replace(/^["']|["']$/g, "");
  if (!s) return null;
  const scheme = /^(turns?):(.*)$/i.exec(s);
  if (scheme) return scheme[1].toLowerCase() + ":" + scheme[2];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null;   // https://…, ws://…
  // Any OTHER explicit scheme (stun:, sip:…) isn't a relay. Note a bare
  // "host:port" is not a scheme even though a hostname is made of
  // scheme-legal characters — what follows the colon there is just a port.
  if (/^[a-z][a-z0-9+.-]*:(?!\d{1,5}(\?|$))/i.test(s)) return null;
  // bare host[:port][?transport=…] — must at least look like a hostname/IP
  if (!/^[a-z0-9.-]+(:\d{1,5})?(\?[\w=&-]*)?$/i.test(s)) return null;
  return "turn:" + s;
}

// Parse the saved/entered url field into the list ICE will actually use.
function parseRelayUrls(field) {
  const out = [];
  for (const tok of String(field || "").split(/[\s,]+/)) {
    const u = normalizeRelayUrl(tok);
    if (u && !out.includes(u)) out.push(u);
    if (out.length >= 4) break;
  }
  return out;
}

export function getRelayConfig() {
  try {
    const raw = localStorage.getItem(RELAY_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    const urls = parseRelayUrls(v.urls);
    if (!urls.length) return null;
    const cfg = { urls };
    if (v.username) cfg.username = String(v.username).slice(0, 256);
    if (v.credential) cfg.credential = String(v.credential).slice(0, 256);
    return cfg;
  } catch {
    return null;
  }
}

// Save (or clear, with an empty urls string) the relay config. Returns the
// parsed config actually in effect, or null.
export function setRelayConfig(urls, username, credential) {
  try {
    if (!urls || !String(urls).trim()) { localStorage.removeItem(RELAY_KEY); return null; }
    localStorage.setItem(RELAY_KEY, JSON.stringify({
      urls: String(urls).trim(),
      username: String(username || "").trim(),
      credential: String(credential || "").trim(),
    }));
  } catch { /* storage unavailable */ }
  return getRelayConfig();
}

function iceServers() {
  const relay = getRelayConfig();
  return relay ? [...STUN, relay] : STUN;
}

export class Peer {
  // role: "host" creates the channels (and the offer); "client" receives them.
  constructor(role) {
    this.role = role;
    this.pc = new RTCPeerConnection({ iceServers: iceServers() });
    this.rel = null;      // reliable ordered channel
    this.fast = null;     // unreliable unordered channel
    this.open = false;
    this.closed = false;
    this.onMessage = null;   // (msg, peer, channelLabel) — msg is already validated
    this.onOpen = null;
    this.onClose = null;
    this._openCount = 0;

    this.pc.addEventListener("connectionstatechange", () => {
      const s = this.pc.connectionState;
      if (s === "failed" || s === "closed") this._handleClose();
      else if (s === "disconnected") {
        // often transient (wifi blip, route change): give ICE a window to
        // recover before declaring the peer gone
        clearTimeout(this._discoT);
        this._discoT = setTimeout(() => {
          if (this.pc.connectionState !== "connected") this._handleClose();
        }, DISCONNECT_GRACE_MS);
      } else if (s === "connected") clearTimeout(this._discoT);
    });

    if (role === "host") {
      this._wire(this.pc.createDataChannel("rel", { ordered: true }), "rel");
      this._wire(this.pc.createDataChannel("fast", { ordered: false, maxRetransmits: 0 }), "fast");
    } else {
      this.pc.addEventListener("datachannel", (e) => {
        if (e.channel.label === "rel" || e.channel.label === "fast") this._wire(e.channel, e.channel.label);
        else { try { e.channel.close(); } catch { /* unexpected channel — refuse */ } }
      });
    }
  }

  _wire(ch, label) {
    ch.binaryType = "arraybuffer";
    this[label] = ch;
    ch.onopen = () => {
      this._openCount++;
      if (this._openCount === 2 && !this.closed) { this.open = true; if (this.onOpen) this.onOpen(this); }
    };
    ch.onclose = () => this._handleClose();
    ch.onmessage = (e) => {
      if (this.closed) return;
      // binary frames are not part of the protocol — drop them outright
      if (typeof e.data !== "string") return;
      if (e.data.length > MAX_MSG) return;
      const msg = decode(e.data);
      if (!msg) return;                       // malformed/unknown: silently dropped
      if (this.onMessage) this.onMessage(msg, this, label);
    };
  }

  _handleClose() {
    if (this.closed) return;
    clearTimeout(this._discoT);
    this.closed = true;
    this.open = false;
    if (this.onClose) this.onClose(this);
  }

  // ---- signaling (non-trickle: wait for all candidates, then hand over one blob) ----
  async makeOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await gatherComplete(this.pc);
    return this.pc.localDescription;
  }
  async acceptOffer(desc) {
    await this.pc.setRemoteDescription({ type: "offer", sdp: desc.sdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await gatherComplete(this.pc);
    return this.pc.localDescription;
  }
  async acceptAnswer(desc) {
    await this.pc.setRemoteDescription({ type: "answer", sdp: desc.sdp });
  }

  // ---- sending (encode() guarantees our own messages are schema-shaped) ----
  send(type, fields) { this._tx(this.rel, type, fields); }
  sendFast(type, fields) { this._tx(this.fast, type, fields); }
  _tx(ch, type, fields) {
    if (!ch || ch.readyState !== "open") return false;
    // Backpressure: if the reliable buffer is badly behind, the peer is gone or
    // on a terrible link; dropping fast-channel traffic is always safe.
    if (ch === this.fast && ch.bufferedAmount > 1 << 16) return false;
    if (ch.bufferedAmount > 1 << 22) return false;
    try { ch.send(encode(type, fields)); return true; } catch { return false; }
  }

  close() {
    this.closed = true;
    clearTimeout(this._discoT);
    this.open = false;
    try { if (this.rel) this.rel.close(); } catch { /* already closed */ }
    try { if (this.fast) this.fast.close(); } catch { /* already closed */ }
    try { this.pc.close(); } catch { /* already closed */ }
  }
}
