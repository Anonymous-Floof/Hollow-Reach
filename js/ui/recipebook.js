// Recipe browser. Reads the same RECIPES / SMELTING / FUEL data the crafting
// system uses, so new recipes show up automatically. To keep it usable as the
// list grows it has: category tabs, a fuzzy search box, and family grouping —
// near-identical recipes (all stairs, all pickaxe tiers, a torch's two fuels…)
// collapse into one card you cycle through. Hover any icon for the full tooltip.

import { RECIPES, SMELTING } from "../game/recipes.js";
import { getItem, itemTooltip } from "../game/items.js";
import { getBlock, tagRepr } from "../world/blocks.js";
import { fuelValue } from "../game/crafting.js";

const FAMILY_NAMES = {
  "fam:stairs": "Stairs", "fam:slabs": "Slabs", "fam:vslabs": "Vertical Slabs",
  "fam:doors": "Doors", "fam:trapdoors": "Trapdoors", "fam:bricks": "Bricks", "fam:polished": "Polished Stone",
  "fam:tool:pick": "Pickaxes", "fam:tool:axe": "Axes", "fam:tool:shovel": "Shovels", "fam:tool:sword": "Swords",
  "fam:armor:0": "Helmets", "fam:armor:1": "Chestplates", "fam:armor:2": "Leggings", "fam:armor:3": "Boots",
};
const TABS = [
  ["all", "All"], ["building", "Building"], ["tools", "Tools"],
  ["armour", "Armour"], ["materials", "Materials"], ["smelting", "Smelting"],
];

// Group near-identical recipes so they cycle in one card.
function familyKey(outKey) {
  const it = getItem(outKey);
  if (it && it.type === "tool") return "fam:tool:" + it.toolType;
  if (it && it.type === "armor") return "fam:armor:" + it.armorSlot;
  if (it && it.type === "block") {
    const b = getBlock(it.blockId);
    if (b) {
      if (b.render === "stair") return "fam:stairs";
      if (b.render === "slab") return "fam:slabs";
      if (b.render === "vslab") return "fam:vslabs";
      if (b.render === "door") return "fam:doors";
      if (b.render === "trapdoor") return "fam:trapdoors";
    }
  }
  if (/^bricks(_|$)/.test(outKey)) return "fam:bricks";
  if (/^polished(_|$)/.test(outKey)) return "fam:polished";
  return outKey;
}
function categoryOf(outKey) {
  const it = getItem(outKey);
  if (!it) return "materials";
  if (it.type === "tool") return "tools";
  if (it.type === "armor") return "armour";
  if (it.type === "block") return "building";
  return "materials";
}
// Fuzzy = query chars appear in order somewhere in the string.
function fuzzy(q, s) {
  q = q.toLowerCase(); s = s.toLowerCase();
  if (!q) return true;
  let i = 0;
  for (let c = 0; c < s.length && i < q.length; c++) if (s[c] === q[i]) i++;
  return i === q.length;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

export class RecipeBook {
  constructor() {
    this.root = document.getElementById("recipebook");
    this.inner = document.getElementById("recipebook-root");
    this.built = false;
    this.tab = "all";
    this.query = "";
    this.cur = new Map();        // family key -> current entry index
    this.families = new Map();
    this.order = [];
    this.tip = document.createElement("div");
    this.tip.className = "tooltip hidden";
    document.getElementById("ui").appendChild(this.tip);
  }

  isOpen() { return !this.root.classList.contains("hidden"); }
  open() {
    if (!this.built) { this.buildData(); this.buildShell(); this.built = true; }
    this.query = ""; if (this.searchEl) this.searchEl.value = "";
    this.renderResults();
    this.root.classList.remove("hidden");
  }
  close() { this.root.classList.add("hidden"); this.hideTip(); }

  itemName(key) {
    if (key && key[0] === "#") return "Any " + key.slice(1).replace(/_/g, " ");
    const it = getItem(key); return it ? it.name : key;
  }
  icon(key, out) {
    const it = getItem(tagRepr(key));
    const src = it && it.iconURL ? it.iconURL : "";
    return `<img class="rb-icon${out ? " rb-icon-out" : ""}" src="${src}" data-key="${esc(key)}" alt="">`;
  }
  shapedInputs(r) {
    const w = Math.max(...r.pattern.map((s) => s.length));
    let g = `<div class="rb-grid" style="grid-template-columns:repeat(${w},24px)">`;
    for (const row of r.pattern)
      for (let c = 0; c < w; c++) {
        const ch = row[c] || " ";
        g += (ch === " " || ch === ".") ? `<div class="rb-cell empty"></div>` : `<div class="rb-cell">${this.icon(r.legend[ch])}</div>`;
      }
    return g + `</div>`;
  }
  shapelessInputs(r) {
    let s = `<div class="rb-chips">`;
    for (const [k, n] of Object.entries(r.in)) s += `<span class="rb-chip">${this.icon(k)}${n > 1 ? `<i>${n}</i>` : ""}</span>`;
    return s + `</div>`;
  }

  buildData() {
    const addEntry = (fk, category, entry) => {
      let f = this.families.get(fk);
      if (!f) { f = { key: fk, name: FAMILY_NAMES[fk] || this.itemName(entry.out.key), category, entries: [] }; this.families.set(fk, f); }
      f.entries.push(entry);
    };
    for (const r of RECIPES) {
      const inputs = r.type === "shaped" ? this.shapedInputs(r) : this.shapelessInputs(r);
      addEntry(familyKey(r.out.key), categoryOf(r.out.key), { inputs, out: r.out, name: this.itemName(r.out.key), station: r.station });
    }
    for (const s of SMELTING) {
      addEntry("smelt:" + s.out, "smelting", { inputs: `<div class="rb-chips">${this.icon(s.in)}</div>`, out: { key: s.out, count: 1 }, name: this.itemName(s.out), station: "forge" });
    }
    this.order = [...this.families.values()];
  }

  buildShell() {
    const tabs = TABS.map(([id, label]) => `<button class="rb-tab${id === this.tab ? " active" : ""}" data-tab="${id}">${label}</button>`).join("");
    const fuels = "coal, charcoal, and anything wooden (logs, planks, tools, chests, boats, torches…)";
    this.inner.innerHTML =
      `<div class="rb-controls">
         <input class="rb-search" type="text" placeholder="Search recipes…" autocomplete="off">
         <div class="rb-tabs">${tabs}</div>
       </div>
       <div class="rb-results"></div>
       <div class="rb-foot">Tip: many recipes group — use the ‹ › arrows to cycle materials/tiers. Forge fuels: ${fuels}.</div>`;
    this.searchEl = this.inner.querySelector(".rb-search");
    this.results = this.inner.querySelector(".rb-results");

    this.searchEl.addEventListener("input", () => { this.query = this.searchEl.value; this.renderResults(); });
    this.searchEl.addEventListener("keydown", (e) => { if (e.code === "Escape") this.searchEl.blur(); });
    this.inner.querySelector(".rb-tabs").addEventListener("click", (e) => {
      const b = e.target.closest(".rb-tab"); if (!b) return;
      this.tab = b.dataset.tab;
      for (const t of this.inner.querySelectorAll(".rb-tab")) t.classList.toggle("active", t.dataset.tab === this.tab);
      this.renderResults();
    });
    this.results.addEventListener("click", (e) => {
      const a = e.target.closest(".rb-arrow"); if (!a) return;
      const f = this.families.get(a.dataset.fam); if (!f) return;
      const n = f.entries.length;
      this.cur.set(f.key, (((this.cur.get(f.key) || 0) + Number(a.dataset.dir)) % n + n) % n);
      const card = this.results.querySelector(`.rb-card[data-fam="${cssEsc(f.key)}"]`);
      if (card) card.outerHTML = this.cardHTML(f);
    });
    this.results.addEventListener("mouseover", (e) => { const ic = e.target.closest(".rb-icon"); if (ic) this.showTip(ic.dataset.key, e); });
    this.results.addEventListener("mousemove", (e) => { if (!this.tip.classList.contains("hidden")) this.moveTip(e); });
    this.results.addEventListener("mouseout", (e) => { if (e.target.closest(".rb-icon")) this.hideTip(); });
  }

  cardHTML(f) {
    const n = f.entries.length;
    let cur = this.cur.get(f.key) || 0; if (cur >= n) cur = 0;
    const e = f.entries[cur], out = e.out;
    const cnt = out.count > 1 ? `<b>${out.count}&times;</b> ` : "";
    const cyc = n > 1
      ? `<span class="rb-cyc"><button class="rb-arrow" data-fam="${esc(f.key)}" data-dir="-1">‹</button><span class="rb-idx">${cur + 1}/${n}</span><button class="rb-arrow" data-fam="${esc(f.key)}" data-dir="1">›</button></span>`
      : "";
    return `<div class="rb-card" data-fam="${esc(f.key)}">
      <div class="rb-in">${e.inputs}</div>
      <span class="rb-go">&#10148;</span>
      <div class="rb-out">${this.icon(out.key, true)}<div class="rb-meta"><span class="rb-name">${cnt}${esc(e.name)}</span>${cyc}</div></div>
    </div>`;
  }

  renderResults() {
    const q = this.query.trim();
    const cards = [];
    for (const f of this.order) {
      if (this.tab !== "all" && f.category !== this.tab) continue;
      if (q && !fuzzy(q, f.name)) {
        let hit = -1;
        for (let i = 0; i < f.entries.length; i++) if (fuzzy(q, f.entries[i].name)) { hit = i; break; }
        if (hit < 0) continue;
        this.cur.set(f.key, hit);     // jump the card to the matching variant
      }
      cards.push(this.cardHTML(f));
    }
    this.results.innerHTML = cards.length ? cards.join("") : `<div class="rb-empty">No recipes match “${esc(q)}”.</div>`;
  }

  // ---- tooltip (shared style with the inventory) ----
  showTip(key, ev) {
    const t = itemTooltip(key, { fuel: fuelValue(tagRepr(key)) });
    this.tip.innerHTML = `<div class="tname">${esc(t.name)}</div>` + (t.sub.length ? `<div class="tdesc">${esc(t.sub.join(" · "))}</div>` : "");
    this.tip.classList.remove("hidden");
    this.moveTip(ev);
  }
  moveTip(ev) { this.tip.style.left = (ev.clientX + 14) + "px"; this.tip.style.top = (ev.clientY + 16) + "px"; }
  hideTip() { this.tip.classList.add("hidden"); }
}

function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }
