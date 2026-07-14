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

// Public STUN only helps the two sides find each other (NAT hole punching);
// no game data ever touches it. Symmetric-NAT pairs may still fail — that's
// the price of serverless P2P.
const ICE = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];

export class Peer {
  // role: "host" creates the channels (and the offer); "client" receives them.
  constructor(role) {
    this.role = role;
    this.pc = new RTCPeerConnection({ iceServers: ICE });
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
      if (s === "failed" || s === "disconnected" || s === "closed") this._handleClose();
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
    this.open = false;
    try { if (this.rel) this.rel.close(); } catch { /* already closed */ }
    try { if (this.fast) this.fast.close(); } catch { /* already closed */ }
    try { this.pc.close(); } catch { /* already closed */ }
  }
}
