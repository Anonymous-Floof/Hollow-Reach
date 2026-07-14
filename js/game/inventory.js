// Player inventory: 9 hotbar slots + 27 main slots + 4 armour slots.
// A slot is null or { key, count, dura? }. Tools/armour have a `dura` field and
// never stack.

import { getItem } from "./items.js";

export const HOTBAR = 9;
export const MAIN = 27;

export class Inventory {
  constructor() {
    this.slots = new Array(HOTBAR + MAIN).fill(null); // 0..8 hotbar, 9..35 main
    this.armor = new Array(4).fill(null);
    this.selected = 0;
  }

  selectedSlot() { return this.slots[this.selected]; }

  stackMax(key) { const i = getItem(key); return i ? i.maxStack : 64; }
  stackable(key) { return this.stackMax(key) > 1; }

  // Add up to `count` of an item. Returns the number that did NOT fit.
  give(key, count = 1, dura = undefined) {
    const item = getItem(key);
    if (!item) return count;
    if (dura === undefined && item.type === "tool") dura = item.durability;
    if (dura === undefined && item.type === "armor") dura = item.durability;

    if (this.stackable(key)) {
      const max = this.stackMax(key);
      for (let i = 0; i < this.slots.length && count > 0; i++) {
        const s = this.slots[i];
        if (s && s.key === key && s.count < max) {
          const add = Math.min(max - s.count, count);
          s.count += add; count -= add;
        }
      }
    }
    while (count > 0) {
      const i = this.firstEmpty();
      if (i < 0) break;
      const put = this.stackable(key) ? Math.min(this.stackMax(key), count) : 1;
      this.slots[i] = { key, count: put, dura };
      count -= put;
    }
    return count;
  }

  firstEmpty() {
    for (let i = 0; i < this.slots.length; i++) if (!this.slots[i]) return i;
    return -1;
  }

  countOf(key) {
    let n = 0;
    for (const s of this.slots) if (s && s.key === key) n += s.count;
    return n;
  }

  hasItems(map) {
    for (const [k, v] of Object.entries(map)) if (this.countOf(k) < v) return false;
    return true;
  }

  // Remove items per { key: count }. Assumes hasItems() already checked.
  removeItems(map) {
    for (const [key, amount] of Object.entries(map)) {
      let need = amount;
      for (let i = 0; i < this.slots.length && need > 0; i++) {
        const s = this.slots[i];
        if (s && s.key === key) {
          const take = Math.min(s.count, need);
          s.count -= take; need -= take;
          if (s.count <= 0) this.slots[i] = null;
        }
      }
    }
  }

  // Consume one of the currently selected stack (placing a block).
  consumeSelected() {
    const s = this.selectedSlot();
    if (!s) return;
    s.count -= 1;
    if (s.count <= 0) this.slots[this.selected] = null;
  }

  // Apply wear to the selected tool; returns true if it broke.
  damageSelectedTool(amount = 1) {
    const s = this.selectedSlot();
    if (!s || s.dura === undefined) return false;
    s.dura -= amount;
    if (s.dura <= 0) { this.slots[this.selected] = null; return true; }
    return false;
  }

  totalDefense() {
    let d = 0;
    for (const s of this.armor) if (s) { const it = getItem(s.key); if (it) d += it.defense; }
    return d;
  }

  // Wear every worn armour piece by `amount`; pieces at 0 durability break.
  damageArmor(amount = 1) {
    for (let i = 0; i < this.armor.length; i++) {
      const s = this.armor[i];
      if (!s || s.dura === undefined) continue;
      s.dura -= amount;
      if (s.dura <= 0) this.armor[i] = null;
    }
  }

  toJSON() {
    const pack = (s) => s ? [s.key, s.count, s.dura ?? null] : null;
    return { slots: this.slots.map(pack), armor: this.armor.map(pack), selected: this.selected };
  }

  static fromJSON(data) {
    const inv = new Inventory();
    if (!data) return inv;
    const unpack = (a) => a ? { key: a[0], count: a[1], dura: a[2] ?? undefined } : null;
    if (data.slots) inv.slots = data.slots.map(unpack);
    if (data.armor) inv.armor = data.armor.map(unpack);
    inv.selected = data.selected || 0;
    // guard against version drift in slot counts
    while (inv.slots.length < HOTBAR + MAIN) inv.slots.push(null);
    while (inv.armor.length < 4) inv.armor.push(null);
    return inv;
  }
}
