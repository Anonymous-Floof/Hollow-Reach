// In-world HUD: hotbar, health hearts, break-progress indicator, held-item
// name flash, and the F3 debug panel.

import { getItem, maxDurability } from "../game/items.js";
import { getBlock } from "../world/blocks.js";
import { CX, CZ } from "../world/chunk.js";

export class HUD {
  constructor() {
    this.el = document.getElementById("hud");
    this.hotbarEl = document.getElementById("hotbar");
    this.heartsEl = document.getElementById("hearts");
    this.hungerEl = document.getElementById("hunger");
    this.breathEl = document.getElementById("breath");
    this.debugEl = document.getElementById("debug");
    this.breakEl = document.getElementById("break-overlay");
    this.heldLabel = document.getElementById("held-item-label");
    this.showDebug = false;
    this.slots = [];
    this._lastSel = -1;
    this._labelTimer = null;
    this.buildHotbar();
  }

  buildHotbar() {
    this.hotbarEl.innerHTML = "";
    this.slots = [];
    for (let i = 0; i < 9; i++) {
      const d = document.createElement("div");
      d.className = "hslot";
      d.innerHTML = `<img class="slot-icon"><span class="slot-count"></span><div class="slot-dura hidden"><i></i></div>`;
      this.hotbarEl.appendChild(d);
      // cache the child refs + a change signature so update() only touches the
      // DOM when a slot actually changes (it runs every frame)
      d._icon = d.querySelector(".slot-icon");
      d._cnt = d.querySelector(".slot-count");
      d._dura = d.querySelector(".slot-dura");
      d._duraFill = d._dura.querySelector("i");
      d._sig = null;
      this.slots.push(d);
    }
    // dirty-check state for the other per-frame HUD widgets
    this._heartsSig = null;
    this._hungerSig = null;
    this._breathSig = null;
    this._breakSig = null;
  }

  show(v) { this.el.classList.toggle("hidden", !v); }
  toggleDebug() { this.showDebug = !this.showDebug; this.debugEl.classList.toggle("hidden", !this.showDebug); }

  flashHeld(name) {
    this.heldLabel.textContent = name;
    this.heldLabel.style.opacity = "1";
    clearTimeout(this._labelTimer);
    this._labelTimer = setTimeout(() => { this.heldLabel.style.opacity = "0"; }, 1200);
  }

  // Runs every frame, so every widget below is dirty-checked: build a cheap
  // signature of what would be rendered and skip the DOM entirely when it
  // matches the last frame. The rendered result is identical.
  update(player, inventory, world, sky, fps, target, breakFrac) {
    // hotbar
    for (let i = 0; i < 9; i++) {
      const slot = inventory.slots[i];
      const el = this.slots[i];
      const sel = i === inventory.selected;
      const sig = slot ? `${slot.key}|${slot.count}|${slot.dura ?? ""}|${sel}` : `empty|${sel}`;
      if (sig === el._sig) continue;
      el._sig = sig;
      el.classList.toggle("sel", sel);
      const img = el._icon, cnt = el._cnt, dura = el._dura;
      if (slot) {
        const it = getItem(slot.key);
        img.src = it ? it.iconURL : "";
        img.style.display = "";
        cnt.textContent = slot.count > 1 ? slot.count : "";
        if (slot.dura !== undefined && maxDurability(slot.key)) {
          dura.classList.remove("hidden");
          el._duraFill.style.width = Math.round((slot.dura / maxDurability(slot.key)) * 100) + "%";
        } else dura.classList.add("hidden");
      } else {
        img.src = ""; img.style.display = "none"; cnt.textContent = ""; dura.classList.add("hidden");
      }
    }

    // held-item label on selection change
    if (inventory.selected !== this._lastSel) {
      this._lastSel = inventory.selected;
      const s = inventory.selectedSlot();
      if (s) { const it = getItem(s.key); if (it) this.flashHeld(it.name); }
    }

    // hearts (10 hearts, each = 2 hp)
    if (player.health !== this._heartsSig) {
      this._heartsSig = player.health;
      let hearts = "";
      for (let i = 0; i < 10; i++) {
        const full = player.health >= (i + 1) * 2 - 0.01;
        const half = !full && player.health >= i * 2 + 1;
        const color = full ? "#e0463a" : half ? "#b8463a" : "#3a2526";
        hearts += `<span class="heart" style="color:${color}">${full || half ? "♥" : "♡"}</span>`;
      }
      this.heartsEl.innerHTML = hearts;
    }

    // hunger (10 pips, each = 2 food points) — shown only when hunger is enabled
    const hungerSig = player.hungerOn ? player.hunger : -1;
    if (hungerSig !== this._hungerSig) {
      this._hungerSig = hungerSig;
      let hungerHtml = "";
      if (player.hungerOn) {
        for (let i = 0; i < 10; i++) {
          const full = player.hunger >= (i + 1) * 2 - 0.01;
          const half = !full && player.hunger >= i * 2 + 1;
          const color = full ? "#d2901f" : half ? "#9c6a22" : "#2e241a";
          hungerHtml += `<span class="pip" style="color:${color}">${full || half ? "◆" : "◇"}</span>`;
        }
      }
      this.hungerEl.innerHTML = hungerHtml;
    }

    // breath bubbles — only while submerged / topping back up (hidden when full)
    const breathSig = player.breath < player.maxBreath - 0.01
      ? Math.ceil((player.breath / player.maxBreath) * 10) : -1;
    if (breathSig !== this._breathSig) {
      this._breathSig = breathSig;
      let breathHtml = "";
      if (breathSig >= 0) {
        for (let i = 0; i < breathSig; i++) breathHtml += `<span class="pip" style="color:#6ec8ff">●</span>`;
      }
      this.breathEl.innerHTML = breathHtml;
    }

    // break progress bar at crosshair
    const breakSig = breakFrac > 0 ? Math.round(breakFrac * 100) : -1;
    if (breakSig !== this._breakSig) {
      const wasOff = this._breakSig === -1 || this._breakSig === null;
      this._breakSig = breakSig;
      if (breakSig >= 0) {
        if (wasOff) {
          this.breakEl.style.cssText = `position:fixed;left:50%;top:calc(50% + 16px);transform:translateX(-50%);width:40px;height:5px;background:#000;border-radius:3px;overflow:hidden`;
          this.breakEl.innerHTML = `<div style="height:100%;width:${breakSig}%;background:#cfe8cf"></div>`;
        } else {
          this.breakEl.firstChild.style.width = breakSig + "%";
        }
      } else {
        this.breakEl.style.cssText = "display:none";
      }
    }

    // debug
    if (this.showDebug) {
      const p = player.pos;
      const cx = Math.floor(p[0] / CX), cz = Math.floor(p[2] / CZ);
      let tname = "—";
      if (target) { const b = getBlock(world.getBlock(target.x, target.y, target.z)); tname = b.name; }
      const dirs = ["S", "SW", "W", "NW", "N", "NE", "E", "SE"];
      const facing = dirs[Math.round(((player.yaw % (Math.PI * 2)) / (Math.PI / 4))) & 7];
      const net = this.netInfo
        ? `\nnet ${this.netInfo.role}   players ${this.netInfo.players}` +
          (this.netInfo.role === "client" ? `   ping ${this.netInfo.ping}ms` : "")
        : "";
      this.debugEl.textContent =
        `Hollowreach  ${fps} fps\n` +
        `xyz ${p[0].toFixed(1)} ${p[1].toFixed(1)} ${p[2].toFixed(1)}\n` +
        `chunk ${cx}, ${cz}   facing ${facing}\n` +
        `time ${sky.clockString()}   chunks ${world.chunks.size}\n` +
        `looking at ${tname}\n` +
        `health ${player.health.toFixed(1)}   ${player.flying ? "flying" : "walking"}` + net;
    }
  }
}
