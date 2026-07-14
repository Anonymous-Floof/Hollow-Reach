// Main menu, world select / create / import, and the pause menu. The actual
// game start/stop is delegated to callbacks supplied by main.js.

import { listWorlds, loadWorld, deleteWorld } from "../save/storage.js";
import { exportWorld, importWorld } from "../save/transfer.js";
import { migrateSave } from "../save/migrate.js";
import { hashSeed } from "../core/prng.js";
import { listItems, getBlob, deleteItem } from "../save/gallery.js";
import { renderHostPanel, renderJoinPanel } from "./mpui.js";

export class Menu {
  constructor(callbacks) {
    this.cb = callbacks;
    this.root = document.getElementById("menu-root");
    this.pauseRoot = document.getElementById("pause-root");
    this.galleryRoot = document.getElementById("gallery-root");
  }

  // ---------- main menu ----------
  showMain() {
    this.root.innerHTML = `
      <button class="btn primary" id="m-play">Play</button>
      <button class="btn" id="m-join">Join a Friend</button>
      <button class="btn" id="m-gallery">Gallery</button>
      <button class="btn" id="m-settings">Settings</button>
      <button class="btn" id="m-about">About</button>`;
    this.root.querySelector("#m-play").onclick = () => this.showWorlds();
    this.root.querySelector("#m-join").onclick = () => renderJoinPanel(this.root, this.cb.gameRef, () => this.showMain());
    this.root.querySelector("#m-gallery").onclick = () => this.cb.openGallery(false);
    this.root.querySelector("#m-settings").onclick = () => this.cb.openSettings(false);
    this.root.querySelector("#m-about").onclick = () => this.showAbout();
  }

  showAbout() {
    const feats = [
      ["Custom engine", "Its own WebGL2 renderer, mesher and physics — zero third-party code."],
      ["Deferred lighting", "Coloured point lights, a directional sun with cast shadows, SSAO and god-rays."],
      ["Volumetric skies", "Ray-marched clouds with moving shadows, a full day/night cycle, sun, moon and stars."],
      ["Living water", "A flowing-water automaton with reflections, currents and an underwater view."],
      ["Procedural world", "Endless terrain, caves and ore veins, forests, and meadows of grass, flowers and mushrooms."],
      ["Survive & build", "Mine, smelt at the Forge, climb the tool &amp; armour tiers, farm mobs, sleep, and build."],
    ];
    const controls = [
      ["WASD", "Move"], ["Mouse", "Look around"], ["Ctrl", "Sprint"],
      ["Space", "Jump &middot; double-tap to fly"], ["L-click", "Break block"],
      ["R-click", "Place / use / eat"], ["1–9 &middot; Wheel", "Select hotbar"],
      ["E", "Inventory"], ["R", "Recipe book"], ["Q", "Drop item (Ctrl+Q: stack)"],
      ["F2", "Screenshot"], ["F8", "Capture panorama"], ["F3", "Debug overlay"], ["Esc", "Pause"],
    ];
    this.root.innerHTML = `
      <div class="about">
        <p class="lead"><b>Hollowreach</b> is a handcrafted voxel sandbox built entirely
        from scratch in the browser — its own engine, procedural world, textures and
        models, with no game engine and no external libraries.</p>

        <h3>Features</h3>
        <div class="feature-grid">
          ${feats.map((f) => `<div class="feat"><b>${f[0]}</b><span>${f[1]}</span></div>`).join("")}
        </div>

        <h3>Controls</h3>
        <div class="controls-grid">
          ${controls.map((c) => `<div class="k"><span class="kbd">${c[0]}</span></div><div class="v">${c[1]}</div>`).join("")}
        </div>

        <h3>Your worlds</h3>
        <p class="desc">Worlds save automatically to your browser and can be exported to a
        <b>.world</b> file to back up or share with friends, then imported anywhere.</p>
      </div>
      <button class="btn" id="a-back">Back</button>`;
    this.root.querySelector("#a-back").onclick = () => this.showMain();
  }

  // ---------- world select ----------
  async showWorlds() {
    this.root.innerHTML = `<div class="empty-note">Loading worlds…</div>`;
    const worlds = await listWorlds();
    let rows = worlds.length
      ? worlds.map((w) => `
        <div class="world-row" data-id="${w.id}">
          <div>
            <div class="name">${escapeHtml(w.name || "Unnamed")}</div>
            <div class="meta">seed ${w.seed} · saved ${timeAgo(w.savedAt)}</div>
          </div>
          <div class="row">
            <button class="btn small" data-act="load">Play</button>
            <button class="btn small" data-act="export">Export</button>
            <button class="btn small danger" data-act="delete">Delete</button>
          </div>
        </div>`).join("")
      : `<div class="empty-note">No worlds yet — create one below.</div>`;

    this.root.innerHTML = `
      <div class="world-list">${rows}</div>
      <button class="btn primary" id="w-new">Create New World</button>
      <button class="btn" id="w-import">Import World (.world)</button>
      <button class="btn" id="w-back">Back</button>`;

    this.root.querySelector("#w-new").onclick = () => this.showNew();
    this.root.querySelector("#w-back").onclick = () => this.showMain();
    this.root.querySelector("#w-import").onclick = async () => {
      try {
        const save = migrateSave(await importWorld());
        this.cb.importWorld(save);
      } catch (e) { /* cancelled or bad file */ }
    };
    this.root.querySelectorAll(".world-row").forEach((row) => {
      const id = row.dataset.id;
      row.querySelectorAll("button").forEach((btn) => {
        btn.onclick = async () => {
          const act = btn.dataset.act;
          if (act === "load") { const s = await loadWorld(id); if (s) this.cb.loadWorld(migrateSave(s)); }
          else if (act === "export") { const s = await loadWorld(id); if (s) exportWorld(s); }
          else if (act === "delete") { if (confirm("Delete this world permanently?")) { await deleteWorld(id); this.showWorlds(); } }
        };
      });
    });
  }

  showNew() {
    this.root.innerHTML = `
      <label class="field">World name</label>
      <input type="text" id="n-name" maxlength="28" placeholder="New World" />
      <label class="field">Seed (leave blank for random)</label>
      <input type="text" id="n-seed" maxlength="24" placeholder="random" />
      <div class="row end">
        <button class="btn small" id="n-cancel">Cancel</button>
        <button class="btn small primary" id="n-create">Create</button>
      </div>`;
    this.root.querySelector("#n-cancel").onclick = () => this.showWorlds();
    this.root.querySelector("#n-create").onclick = () => {
      const name = (this.root.querySelector("#n-name").value || "New World").trim();
      const seedText = this.root.querySelector("#n-seed").value.trim();
      const seed = seedText ? hashSeed(seedText) : (Math.random() * 0xffffffff) >>> 0;
      this.cb.startNew({ name, seed });
    };
  }

  // ---------- pause ----------
  showPause() {
    const game = this.cb.gameRef;
    const isGuest = game && game.meta && game.meta.remote;
    const netLabel = game && game.net && game.net.isHost
      ? `Multiplayer (${game.net.playerCount()} online)` : "Multiplayer";
    this.pauseRoot.innerHTML = `
      <button class="btn primary" id="p-resume">Resume</button>
      <button class="btn" id="p-mp"></button>
      <button class="btn" id="p-settings">Settings</button>
      <button class="btn" id="p-gallery">Screenshots</button>
      ${isGuest ? "" : `<button class="btn" id="p-export">Export World</button>`}
      <button class="btn" id="p-save">${isGuest ? "Leave World" : "Save &amp; Quit to Menu"}</button>`;
    this.pauseRoot.querySelector("#p-mp").textContent = netLabel;
    this.pauseRoot.querySelector("#p-resume").onclick = () => this.cb.resume();
    this.pauseRoot.querySelector("#p-mp").onclick = () =>
      renderHostPanel(this.pauseRoot, game, () => { if (game) game._mpRefresh = null; this.showPause(); });
    this.pauseRoot.querySelector("#p-settings").onclick = () => this.cb.openSettings(true);
    this.pauseRoot.querySelector("#p-gallery").onclick = () => this.cb.openGallery(true);
    const exp = this.pauseRoot.querySelector("#p-export");
    if (exp) exp.onclick = () => this.cb.exportCurrent();
    this.pauseRoot.querySelector("#p-save").onclick = () => this.cb.saveAndQuit();
  }

  // ---------- gallery (screenshots + panoramas) ----------
  async showGallery() {
    const root = this.galleryRoot;
    root.innerHTML = `<div class="empty-note">Loading…</div>`;
    let items;
    try { items = await listItems(); }
    catch { root.innerHTML = `<div class="empty-note">Gallery storage unavailable.</div>`; return; }
    if (!items.length) {
      root.innerHTML = `<div class="empty-note">No captures yet.<br>Press <span class="kbd">F2</span> in-game for a screenshot, or <span class="kbd">F8</span> for a panorama.</div>`;
      return;
    }
    root.innerHTML = `<div class="gal-grid">` + items.map((it) => `
      <div class="gal-card" data-id="${it.id}" data-kind="${it.kind}">
        <div class="gal-thumb"><img src="${it.thumb}" alt="" loading="lazy" />
          <span class="gal-badge ${it.kind}">${it.kind === "panorama" ? "360°" : "SHOT"}</span></div>
        <div class="gal-info"><span class="gal-world">${escapeHtml(it.world || "—")}</span><span class="gal-date">${timeAgo(it.createdAt)}</span></div>
        <div class="gal-btns">
          <button data-act="view">View</button>
          ${it.kind === "panorama" ? `<button data-act="setbg">Set&nbsp;BG</button>` : ``}
          <button data-act="save">Save</button>
          <button data-act="del" class="danger">✕</button>
        </div>
      </div>`).join("") + `</div>`;

    root.querySelectorAll(".gal-card").forEach((card) => {
      const id = card.dataset.id, kind = card.dataset.kind;
      card.querySelectorAll("button").forEach((btn) => {
        btn.onclick = async () => {
          const act = btn.dataset.act;
          const blob = await getBlob(id);
          if (!blob) return;
          if (act === "view") this._openViewer(kind, blob);
          else if (act === "setbg") { if (blob.faces) this.cb.setMenuBackground(blob.faces); }
          else if (act === "save") downloadDataURL(kind === "panorama" ? blob.faces[4] : blob.data, `hollowreach-${kind}-${id}.jpg`);
          else if (act === "del") { if (confirm("Delete this capture permanently?")) { await deleteItem(id); this.showGallery(); } }
        };
      });
    });
  }

  // Full-screen still viewer (panoramas show their forward face). Click to close.
  _openViewer(kind, blob) {
    const url = kind === "panorama" ? blob.faces[4] : blob.data;
    const v = document.createElement("div");
    v.className = "gal-viewer";
    v.innerHTML = `<img src="${url}" alt="" /><div class="gal-viewer-hint">${kind === "panorama" ? "panorama · forward view" : ""} — click to close</div>`;
    v.onclick = () => v.remove();
    document.getElementById("gallery").appendChild(v);
  }
}

function downloadDataURL(url, filename) {
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function timeAgo(ts) {
  if (!ts) return "—";
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
