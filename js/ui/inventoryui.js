// Inventory + crafting + forge + chest overlay.
//
// Manual controls: left click = pick up / place whole stack / merge / swap;
// right click = pick up half / place one.
//
// "Mouse Tweaks"-style controls (inspired by the Minecraft mod):
//   • Shift+Left click  — quick-move a stack to the other container.
//   • Left-drag         — split the held stack evenly across the slots dragged.
//   • Right-drag        — drop one of the held item into each slot dragged.
//   • Scroll on a slot  — down pushes one item to the other container, up pulls
//                         one matching item in.
//
// Forges and chests are backed by persistent block entities (passed in via
// open()), so they keep their contents — and forges keep smelting — after close.

import { getItem, maxDurability, itemTooltip } from "../game/items.js";
import { matchGrid, consumeGrid, smeltingFor, fuelValue } from "../game/crafting.js";
import { sfx } from "../audio/sfx.js";

export class InventoryUI {
  constructor(inventory, callbacks = {}) {
    this.inv = inventory;
    this.cb = callbacks;
    this.root = document.getElementById("inventory");
    this.inner = document.getElementById("inventory-root");
    this.cursorEl = document.getElementById("held-stack");
    this.mode = null;       // 'inventory' | 'workbench' | 'forge' | 'chest'
    this.craftSize = 2;
    this.craft = [];
    this.cursor = null;
    this.forge = null;      // live block entity while a forge is open
    this.chest = null;      // live block entity while a chest is open
    this.mouse = { x: 0, y: 0 };
    this.drag = null;       // { button, seen:Set, cells:[{cname,idx}] }

    this.tip = document.createElement("div");
    this.tip.className = "tooltip hidden";
    document.getElementById("ui").appendChild(this.tip);

    this.inner.addEventListener("mousedown", (e) => {
      const el = e.target.closest(".islot");
      if (!el) return;
      e.preventDefault();
      const cname = el.dataset.c, idx = Number(el.dataset.i);
      if (e.shiftKey && e.button === 0) { this.quickMove(cname, idx); return; }
      // begin a potential drag-distribute when holding a stack
      if (this.cursor && (e.button === 0 || e.button === 2) && cname !== "result") {
        this.drag = { button: e.button, seen: new Set(), cells: [] };
        this.addDragCell(cname, idx);
        return;
      }
      this.clickSlot(cname, idx, e.button);
    });

    this.inner.addEventListener("wheel", (e) => {
      if (!this.isOpen()) return;
      const el = e.target.closest(".islot");
      if (!el) return;
      e.preventDefault();
      this.scrollSlot(el.dataset.c, Number(el.dataset.i), Math.sign(e.deltaY));
    }, { passive: false });

    document.addEventListener("mousemove", (e) => {
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
      if (!this.isOpen()) return;
      if (this.drag) {
        const el = e.target.closest(".islot");
        if (el) this.addDragCell(el.dataset.c, Number(el.dataset.i));
        this.positionCursor(); this.hideTip();
        return;
      }
      if (this.cursor) { this.positionCursor(); this.hideTip(); }
      else this.updateTip(e.target.closest(".islot"));
    });

    document.addEventListener("mouseup", () => { if (this.drag) this.finishDrag(); });
  }

  range(a, b) { const r = []; for (let i = a; i < b; i++) r.push(i); return r; }

  // ---- hover tooltip ----
  slotForEl(el) {
    if (!el) return null;
    const cname = el.dataset.c, idx = Number(el.dataset.i);
    if (cname === "result") {
      const m = matchGrid(this.craft, this.craftSize, this.station());
      return m ? { key: m.out.key, count: m.out.count } : null;
    }
    const r = this.ref(cname);
    return r ? r.get(idx) : null;
  }
  updateTip(el) {
    const slot = this.slotForEl(el);
    if (!slot) { this.hideTip(); return; }
    const t = itemTooltip(slot.key, { dura: slot.dura, fuel: fuelValue(slot.key) });
    this.tip.innerHTML = `<div class="tname">${t.name}</div>` +
      (t.sub.length ? `<div class="tdesc">${t.sub.join(" · ")}</div>` : "");
    this.tip.classList.remove("hidden");
    this.tip.style.left = (this.mouse.x + 14) + "px";
    this.tip.style.top = (this.mouse.y + 16) + "px";
  }
  hideTip() { this.tip.classList.add("hidden"); }

  isOpen() { return this.mode !== null; }
  station() { return this.mode === "workbench" ? "workbench" : "hand"; }

  open(mode, be = null) {
    this.mode = mode;
    if (mode === "forge") this.forge = be;
    else if (mode === "chest") this.chest = be;
    else {
      this.craftSize = mode === "workbench" ? 3 : 2;
      this.craft = new Array(this.craftSize * this.craftSize).fill(null);
    }
    this.root.classList.remove("hidden");
    this.render();
  }

  close() {
    // Return the cursor + the crafting grid to the inventory. Forge/chest
    // contents stay in their block entity (they persist).
    if (this.cursor) { this.inv.give(this.cursor.key, this.cursor.count, this.cursor.dura); this.cursor = null; }
    if (this.mode === "inventory" || this.mode === "workbench") {
      for (const s of this.craft) if (s) this.inv.give(s.key, s.count, s.dura);
      this.craft = [];
    }
    this.mode = null; this.forge = null; this.chest = null; this.drag = null;
    this.root.classList.add("hidden");
    this.cursorEl.classList.add("hidden");
    this.hideTip();
    this.cb.onClose && this.cb.onClose();
  }

  // Re-render while a forge is open so its smelting bars (advanced by the world)
  // stay live. Skip during a drag so we don't fight the user's pointer.
  tick(dt) { if (this.mode === "forge" && !this.drag) this.render(); }

  // ---- container access ----
  ref(name) {
    const inv = this.inv;
    switch (name) {
      case "inv": return { get: (i) => inv.slots[i], set: (i, v) => (inv.slots[i] = v) };
      case "armor": return { get: (i) => inv.armor[i], set: (i, v) => (inv.armor[i] = v), accept: (i, it) => it && it.type === "armor" && it.armorSlot === i };
      case "craft": return { get: (i) => this.craft[i], set: (i, v) => (this.craft[i] = v) };
      case "chest": return { get: (i) => this.chest.slots[i], set: (i, v) => (this.chest.slots[i] = v) };
      case "fin": return { get: () => this.forge.input, set: (_, v) => (this.forge.input = v) };
      case "ffuel": return { get: () => this.forge.fuel, set: (_, v) => (this.forge.fuel = v) };
      case "fout": return { get: () => this.forge.output, set: (_, v) => (this.forge.output = v), output: true };
      default: return null;
    }
  }
  stackable(key) { return this.inv.stackable(key); }
  max(key) { return this.inv.stackMax(key); }

  clickSlot(cname, idx, button) {
    if (cname === "result") { this.takeResult(); this.afterChange(); return; }
    const r = this.ref(cname);
    if (!r) return;
    let slot = r.get(idx);
    const cur = this.cursor;
    if (slot || cur) sfx.uiSlot();          // tactile tick when a stack moves

    if (r.output) {
      if (slot && (!cur || (cur.key === slot.key && this.stackable(cur.key)))) {
        if (!cur) { this.cursor = slot; r.set(idx, null); }
        else {
          const add = Math.min(this.max(cur.key) - cur.count, slot.count);
          cur.count += add; slot.count -= add;
          if (slot.count <= 0) r.set(idx, null);
        }
      }
      this.afterChange();
      return;
    }

    if (button === 2) {
      if (!cur) {
        if (slot) {
          const half = Math.ceil(slot.count / 2);
          this.cursor = { key: slot.key, count: half, dura: slot.dura };
          slot.count -= half; if (slot.count <= 0) r.set(idx, null);
        }
      } else {
        if (r.accept && !r.accept(idx, getItem(cur.key))) { this.afterChange(); return; }
        if (!slot) { r.set(idx, { key: cur.key, count: 1, dura: cur.dura }); cur.count--; if (cur.count <= 0) this.cursor = null; }
        else if (slot.key === cur.key && this.stackable(cur.key) && slot.count < this.max(cur.key)) {
          slot.count++; cur.count--; if (cur.count <= 0) this.cursor = null;
        }
      }
    } else {
      if (!cur) {
        if (slot) { this.cursor = slot; r.set(idx, null); }
      } else if (r.accept && !r.accept(idx, getItem(cur.key))) {
        // can't place here
      } else if (!slot) {
        r.set(idx, cur); this.cursor = null;
      } else if (slot.key === cur.key && this.stackable(cur.key)) {
        const add = Math.min(this.max(cur.key) - slot.count, cur.count);
        slot.count += add; cur.count -= add;
        if (cur.count <= 0) this.cursor = null;
      } else {
        r.set(idx, cur); this.cursor = slot;
      }
    }
    this.afterChange();
  }

  takeResult() {
    const m = matchGrid(this.craft, this.craftSize, this.station());
    if (!m) return;
    const out = m.out;
    const it = getItem(out.key);
    if (this.cursor) {
      if (this.cursor.key !== out.key || !this.stackable(out.key)) return;
      if (this.cursor.count + out.count > this.max(out.key)) return;
    }
    consumeGrid(this.craft, this.craftSize, m.recipe);
    sfx.craft();
    if (!this.cursor) {
      this.cursor = { key: out.key, count: out.count };
      if (it.type === "tool" || it.type === "armor") this.cursor.dura = it.durability;
    } else {
      this.cursor.count += out.count;
    }
  }

  // ---- Mouse-Tweaks: shift-click quick move ----
  quickMove(cname, idx) {
    if (cname === "result") { this.shiftCraft(); return; }
    const r = this.ref(cname);
    if (!r) return;
    const slot = r.get(idx);
    if (!slot) return;
    const targets = (cname === "inv") ? this.invSourceTargets(slot, idx) : this.toInventoryTargets();
    if (!targets) return;
    this.depositInto(slot, targets);
    if (slot.count <= 0) r.set(idx, null);
    this.afterChange();
  }

  toInventoryTargets() { return [{ cname: "inv", indices: [...this.range(9, 36), ...this.range(0, 9)] }]; }

  invSourceTargets(slot, idx) {
    const it = getItem(slot.key);
    if (this.mode === "chest") return [{ cname: "chest", indices: this.range(0, 27) }];
    if (this.mode === "forge") {
      if (smeltingFor(slot.key)) return [{ cname: "fin", indices: [0] }];
      if (fuelValue(slot.key) > 0) return [{ cname: "ffuel", indices: [0] }];
      return null;
    }
    if (this.mode === "inventory" && it && it.type === "armor" && !this.inv.armor[it.armorSlot]) {
      return [{ cname: "armor", indices: [it.armorSlot] }];
    }
    // shuffle between hotbar (0-8) and main storage (9-35)
    return idx < 9 ? [{ cname: "inv", indices: this.range(9, 36) }] : [{ cname: "inv", indices: this.range(0, 9) }];
  }

  // Move as much of `slot` (mutated in place) into the target slots as fits.
  depositInto(slot, targets) {
    const stack = this.stackable(slot.key);
    const max = this.max(slot.key);
    const item = getItem(slot.key);
    if (stack) {
      for (const t of targets) {
        const r = this.ref(t.cname);
        for (const i of t.indices) {
          if (slot.count <= 0) return;
          if (r.output) continue;
          const d = r.get(i);
          if (d && d.key === slot.key && d.count < max && (!r.accept || r.accept(i, item))) {
            const add = Math.min(max - d.count, slot.count);
            d.count += add; slot.count -= add;
          }
        }
      }
    }
    for (const t of targets) {
      const r = this.ref(t.cname);
      for (const i of t.indices) {
        if (slot.count <= 0) return;
        if (r.output) continue;
        if (!r.get(i) && (!r.accept || r.accept(i, item))) {
          const put = stack ? Math.min(max, slot.count) : 1;
          r.set(i, { key: slot.key, count: put, dura: slot.dura });
          slot.count -= put;
        }
      }
    }
  }

  // Shift-click the crafting result: craft repeatedly into the inventory.
  shiftCraft() {
    let guard = 0, made = 0;
    while (guard++ < 999) {
      const m = matchGrid(this.craft, this.craftSize, this.station());
      if (!m) break;
      const it = getItem(m.out.key);
      if (!this.canAcceptInInv(m.out.key, m.out.count)) break;
      consumeGrid(this.craft, this.craftSize, m.recipe);
      const dura = (it.type === "tool" || it.type === "armor") ? it.durability : undefined;
      this.inv.give(m.out.key, m.out.count, dura);
      made++;
    }
    if (made) sfx.craft();                  // one knock for the whole batch
    this.afterChange();
  }
  canAcceptInInv(key, count) {
    const max = this.max(key); let room = 0;
    for (const s of this.inv.slots) {
      if (!s) room += max;
      else if (s.key === key && this.stackable(key)) room += Math.max(0, max - s.count);
      if (room >= count) return true;
    }
    return room >= count;
  }

  // ---- Mouse-Tweaks: scroll a single item between this slot and the other side ----
  scrollSlot(cname, idx, dir) {
    if (cname === "result") { if (dir > 0) this.quickMove(cname, idx); return; }
    const r = this.ref(cname);
    if (!r) return;
    const slot = r.get(idx);
    if (dir > 0) {
      if (!slot) return;
      const one = { key: slot.key, count: 1, dura: slot.dura };
      const targets = (cname === "inv") ? this.invSourceTargets(slot, idx) : this.toInventoryTargets();
      if (!targets) return;
      this.depositInto(one, targets);
      const moved = 1 - one.count;
      if (moved > 0) { slot.count -= moved; if (slot.count <= 0) r.set(idx, null); }
    } else {
      if (!slot || !this.stackable(slot.key) || slot.count >= this.max(slot.key)) return;
      if (r.output) return;
      const sources = (cname === "inv") ? this.invSourceTargets(slot, idx) : this.toInventoryTargets();
      if (!sources) return;
      for (const t of sources) {
        const sr = this.ref(t.cname);
        let done = false;
        for (const i of t.indices) {
          const ts = sr.get(i);
          if (ts && ts.key === slot.key) { ts.count -= 1; if (ts.count <= 0) sr.set(i, null); slot.count += 1; done = true; break; }
        }
        if (done) break;
      }
    }
    this.afterChange();
  }

  // ---- Mouse-Tweaks: click-drag across slots ----
  addDragCell(cname, idx) {
    if (cname === "result" || cname === "fout") return;
    const key = cname + ":" + idx;
    if (this.drag.seen.has(key)) return;
    this.drag.seen.add(key);
    this.drag.cells.push({ cname, idx });
  }

  finishDrag() {
    const d = this.drag; this.drag = null;
    if (!this.cursor) { this.afterChange(); return; }

    // A drag that only ever touched one slot is just a normal click.
    if (d.cells.length <= 1 || !this.stackable(this.cursor.key)) {
      const c = d.cells[0];
      if (c) this.clickSlot(c.cname, c.idx, d.button);
      else this.afterChange();
      return;
    }

    const item = getItem(this.cursor.key);
    const max = this.max(this.cursor.key);
    const eligible = d.cells.filter((c) => {
      const r = this.ref(c.cname);
      if (!r || r.output) return false;
      if (r.accept && !r.accept(c.idx, item)) return false;
      const s = r.get(c.idx);
      return !s || (s.key === this.cursor.key && s.count < max);
    });
    if (!eligible.length) { this.afterChange(); return; }

    // left = even split across slots; right = one each
    const per = d.button === 0 ? Math.max(1, Math.floor(this.cursor.count / eligible.length)) : 1;
    for (const c of eligible) {
      if (this.cursor.count <= 0) break;
      const r = this.ref(c.cname);
      const s = r.get(c.idx);
      const cur = s ? s.count : 0;
      const add = Math.min(per, max - cur, this.cursor.count);
      if (add <= 0) continue;
      if (s) s.count += add;
      else r.set(c.idx, { key: this.cursor.key, count: add, dura: this.cursor.dura });
      this.cursor.count -= add;
    }
    if (this.cursor.count <= 0) this.cursor = null;
    this.afterChange();
  }

  afterChange() { this.render(); this.positionCursor(); }

  positionCursor() {
    if (!this.cursor) { this.cursorEl.classList.add("hidden"); return; }
    const it = getItem(this.cursor.key);
    this.cursorEl.classList.remove("hidden");
    this.cursorEl.innerHTML =
      `<img class="slot-icon" src="${it ? it.iconURL : ""}">` +
      (this.cursor.count > 1 ? `<span class="slot-count">${this.cursor.count}</span>` : "");
    this.cursorEl.style.left = this.mouse.x + "px";
    this.cursorEl.style.top = this.mouse.y + "px";
  }

  // ---- rendering ----
  slotHTML(cname, idx, slot, extra = "") {
    const it = slot ? getItem(slot.key) : null;
    const icon = it ? `<img class="slot-icon" src="${it.iconURL}">` : "";
    const count = slot && slot.count > 1 ? `<span class="slot-count">${slot.count}</span>` : "";
    let dura = "";
    if (slot && slot.dura !== undefined && maxDurability(slot.key)) {
      dura = `<div class="slot-dura"><i style="width:${Math.round((slot.dura / maxDurability(slot.key)) * 100)}%"></i></div>`;
    }
    return `<div class="islot ${extra}" data-c="${cname}" data-i="${idx}">${icon}${count}${dura}</div>`;
  }

  invPanel() {
    let s = `<div class="inv-panel"><div class="inv-title">Inventory</div>`;
    s += `<div class="slot-grid" style="grid-template-columns:repeat(9,46px)">`;
    for (let i = 9; i < 36; i++) s += this.slotHTML("inv", i, this.inv.slots[i]);
    s += `</div><div style="height:10px"></div>`;
    s += `<div class="slot-grid" style="grid-template-columns:repeat(9,46px)">`;
    for (let i = 0; i < 9; i++) s += this.slotHTML("inv", i, this.inv.slots[i]);
    s += `</div></div>`;
    return s;
  }

  craftPanel() {
    const size = this.craftSize;
    const m = matchGrid(this.craft, size, this.station());
    const result = m ? { key: m.out.key, count: m.out.count } : null;
    let grid = `<div class="slot-grid" style="grid-template-columns:repeat(${size},46px)">`;
    for (let i = 0; i < size * size; i++) grid += this.slotHTML("craft", i, this.craft[i]);
    grid += `</div>`;
    const title = this.mode === "workbench" ? "Workbench" : "Crafting";
    return `<div class="inv-panel"><div class="inv-title">${title}</div>` +
      `<div class="craft-area">${grid}<span class="arrow">&#10148;</span>` +
      this.slotHTML("result", 0, result, "result") + `</div></div>`;
  }

  armorPanel() {
    let s = `<div class="inv-panel"><div class="inv-title">Armour</div>`;
    s += `<div class="slot-grid" style="grid-template-columns:46px">`;
    for (let i = 0; i < 4; i++) s += this.slotHTML("armor", i, this.inv.armor[i], "armor");
    s += `</div></div>`;
    return s;
  }

  forgePanel() {
    const f = this.forge;
    const smelt = f.input ? smeltingFor(f.input.key) : null;
    const fuelPct = f.fuelMax ? Math.max(0, (f.fuelLeft / f.fuelMax) * 100) : 0;
    const progPct = smelt ? Math.min(100, (f.progress / smelt.time) * 100) : 0;
    // bars match the resource slots: smelt progress on top (with input), burn on
    // the bottom (with fuel).
    return `<div class="inv-panel"><div class="inv-title">Forge</div><div class="craft-area">` +
      `<div class="slot-grid" style="grid-template-columns:46px;gap:8px">` +
      this.slotHTML("fin", 0, f.input) + this.slotHTML("ffuel", 0, f.fuel) + `</div>` +
      `<div class="forge-area">` +
      `<div class="fuel-bar" title="Smelting progress"><i style="width:${progPct}%;background:#cfe8cf"></i></div>` +
      `<span class="arrow">&#10148;</span>` +
      `<div class="fuel-bar" title="Fuel burning"><i style="width:${fuelPct}%"></i></div>` +
      `</div>` +
      this.slotHTML("fout", 0, f.output) + `</div></div>`;
  }

  chestPanel() {
    let s = `<div class="inv-panel"><div class="inv-title">Chest</div>`;
    s += `<div class="slot-grid" style="grid-template-columns:repeat(9,46px)">`;
    for (let i = 0; i < 27; i++) s += this.slotHTML("chest", i, this.chest.slots[i]);
    s += `</div></div>`;
    return s;
  }

  render() {
    let top = "";
    if (this.mode === "inventory") top = this.armorPanel() + this.craftPanel();
    else if (this.mode === "workbench") top = this.craftPanel();
    else if (this.mode === "forge") top = this.forgePanel();
    else if (this.mode === "chest") top = this.chestPanel();
    this.inner.innerHTML =
      `<div style="display:flex;flex-direction:column;gap:14px;align-items:center">` +
      `<div style="display:flex;gap:16px;align-items:flex-start">${top}</div>` +
      this.invPanel() +
      `<div style="color:#9aa7b4;font-size:12px">Shift-click moves stacks · drag to split · scroll to nudge · E/Esc to close</div>` +
      `</div>`;
  }
}
