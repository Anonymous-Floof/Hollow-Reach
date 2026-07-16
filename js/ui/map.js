// The Atlas: a fullscreen top-down world map (M), custom + death waypoints
// with in-world floating markers, and a corner minimap — all unlocked by
// carrying the Atlas item.
//
// Rendering model: the world is drawn one CHUNK TILE at a time (a 16x16 canvas,
// one pixel per block — true block colours averaged from the texture atlas,
// with slope/relief shading and depth-tinted water). Tiles are cached and only
// re-rendered when an edit dirties their chunk (world.mapDirty). Loaded chunks
// draw from real voxels (so builds show up); unexplored chunks are *predicted*
// from the seed via worldgen.surfacePreview, so the map can sketch terra
// incognita without generating it.

import { BLOCKS, BLOCK, texForFace } from "../world/blocks.js";
import { surfacePreview, SEA_LEVEL } from "../world/worldgen.js";
import { CX, CZ, WH, localIdx, chunkKey } from "../world/chunk.js";
import { Settings } from "./settings.js";

const WP_COLORS = ["#e8c84a", "#52b6e8", "#7ade6a", "#e07ad0", "#f08748", "#a48aff", "#f0f0f0"];
const WATER_RGB = [43, 93, 165];
const TILE_BUDGET = 10;          // tiles (re)rendered per redraw while the map is open
const REDRAW_MS = 30;            // shared fps cap for BOTH the fullscreen map and the minimap
const MM_SIZE = 168;             // minimap canvas size (px, 1px = 1 block)
const FOG = "#10141b";           // unexplored chunks (fog of war)

export class WorldMap {
  constructor(game, atlas) {
    this.game = game;
    this.atlas = atlas;
    this.colors = null;          // per-block-id average RGB from the atlas
    this.tiles = new Map();      // "cx,cz" -> { cv, loaded }
    this.zoom = 3;               // screen pixels per block
    this.center = [0, 0];        // world x/z at the canvas centre
    this.drag = null;
    this.isOpen = false;
    this._built = false;
    this._markers = [];          // in-world DOM tags
    this._markerRoot = null;
    this._mm = null;             // minimap canvas
    this._mmT = 99;              // minimap redraw clock (ms, same cadence as the fullscreen map)
    this._scratchRow = new Float32Array(CX);
  }

  hasAtlas() {
    const inv = this.game.inventory;
    if (!inv) return false;
    for (const s of inv.slots) if (s && s.key === "atlas") return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Block colours: average each block's top-face tile from the atlas canvas.
  // ---------------------------------------------------------------------------
  _ensureColors() {
    if (this.colors) return;
    const cv = this.atlas.canvas;
    const ctx = cv.getContext("2d");
    const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const n = BLOCKS.length;
    this.colors = new Uint8Array(n * 3);
    for (const b of BLOCKS) {
      if (!b.tex) continue;
      const [tx, ty, tw, th] = this.atlas.pixelRect(texForFace(b, 2));
      let r = 0, g = 0, bl = 0, cnt = 0;
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const i = ((ty + y) * cv.width + tx + x) * 4;
          if (img[i + 3] < 40) continue;         // skip cutout pixels
          r += img[i]; g += img[i + 1]; bl += img[i + 2]; cnt++;
        }
      }
      if (!cnt) continue;
      const o = b.id * 3;
      this.colors[o] = r / cnt; this.colors[o + 1] = g / cnt; this.colors[o + 2] = bl / cnt;
    }
    // water gets a hand-picked deep blue (its tile is translucent)
    const wo = BLOCK.water * 3;
    this.colors[wo] = WATER_RGB[0]; this.colors[wo + 1] = WATER_RGB[1]; this.colors[wo + 2] = WATER_RGB[2];
  }

  // ---------------------------------------------------------------------------
  // Column sampling: the map's view of one world column.
  // Returns { id, h, water } — surface block, its height, water depth above it.
  // ---------------------------------------------------------------------------
  _sampleLoaded(chunk, lx, lz) {
    let water = 0;
    for (let y = WH - 1; y >= 0; y--) {
      const id = chunk.voxels[localIdx(lx, y, lz)];
      if (id === 0) continue;
      const b = BLOCKS[id];
      if (!b || b.render === "cross") continue;    // plants don't hide the ground
      if (id === BLOCK.water) { water++; continue; }
      return { id, h: y, water };
    }
    return { id: BLOCK.bedrock, h: 0, water };
  }

  _samplePreview(world, wx, wz) {
    const p = surfacePreview(world.seed, wx, wz, world.genVer);
    if (p.key === "water") {
      return { id: BLOCK.greystone, h: Math.max(2, p.h), water: Math.max(1, SEA_LEVEL - p.h) };
    }
    return { id: BLOCK[p.key] ?? BLOCK.turf, h: p.h, water: 0 };
  }

  _surfaceHeight(world, wx, wz) {
    const c = world.chunkAt(wx, wz);
    if (c) {
      const s = this._sampleLoaded(c, wx - c.cx * CX, wz - c.cz * CZ);
      return s.h + s.water;
    }
    const p = this._samplePreview(world, wx, wz);
    return p.h + p.water;
  }

  // ---------------------------------------------------------------------------
  // Chunk tiles.
  // ---------------------------------------------------------------------------
  _renderTile(world, cx, cz) {
    this._ensureColors();
    const cv = document.createElement("canvas");
    cv.width = CX; cv.height = CZ;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(CX, CZ);
    const chunk = world.chunks.get(chunkKey(cx, cz));
    const baseX = cx * CX, baseZ = cz * CZ;

    // heights of the row north of the tile (for relief shading of row 0)
    const north = this._scratchRow;
    for (let x = 0; x < CX; x++) north[x] = this._surfaceHeight(world, baseX + x, baseZ - 1);

    for (let z = 0; z < CZ; z++) {
      for (let x = 0; x < CX; x++) {
        const wx = baseX + x, wz = baseZ + z;
        const s = chunk ? this._sampleLoaded(chunk, x, z) : this._samplePreview(world, wx, wz);
        const o = s.id * 3;
        let r = this.colors[o], g = this.colors[o + 1], b = this.colors[o + 2];
        if (s.water > 0) {
          const k = Math.min(0.88, 0.42 + s.water * 0.055);   // deeper = bluer/darker
          r = r * (1 - k) + WATER_RGB[0] * k * (1 - s.water * 0.02);
          g = g * (1 - k) + WATER_RGB[1] * k * (1 - s.water * 0.02);
          b = b * (1 - k) + WATER_RGB[2] * k;
        }
        // relief: brighter when this column steps up from its northern
        // neighbour, darker when it drops (classic cartographic hillshade)
        const hs = s.h + s.water;
        const dh = hs - north[x];
        const m = dh > 0 ? Math.min(1.22, 1 + dh * 0.07) : dh < 0 ? Math.max(0.72, 1 + dh * 0.07) : 1;
        north[x] = hs;
        const i = (z * CX + x) * 4;
        img.data[i] = Math.min(255, r * m);
        img.data[i + 1] = Math.min(255, g * m);
        img.data[i + 2] = Math.min(255, b * m);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return { cv, loaded: !!chunk };
  }

  // Drop tiles whose chunk changed since they were drawn (edits, chunk loads).
  _consumeDirty(world) {
    if (!world.mapDirty || world.mapDirty.size === 0) return;
    for (const key of world.mapDirty) this.tiles.delete(key);
    world.mapDirty.clear();
  }

  // Returns a tile canvas, null (budget exhausted, try next redraw), or "fog"
  // for chunks the player has never generated — the atlas only maps explored
  // ground, so unexplored terrain stays hidden AND costs nothing to draw.
  _tileAt(world, cx, cz, budget) {
    const key = chunkKey(cx, cz);
    if (!world.explored.has(key)) return "fog";
    let t = this.tiles.get(key);
    // a preview tile upgrades to the real thing once its chunk is loaded
    if (t && !t.loaded && world.chunks.has(key) && budget.n > 0) { this.tiles.delete(key); t = null; }
    if (!t) {
      if (budget.n <= 0) return null;
      budget.n--;
      t = this._renderTile(world, cx, cz);
      this.tiles.set(key, t);
      if (this.tiles.size > 9000) {                 // bounded cache
        for (const k of this.tiles.keys()) { this.tiles.delete(k); if (this.tiles.size <= 8000) break; }
      }
    }
    return t;
  }

  // ---------------------------------------------------------------------------
  // Fullscreen map.
  // ---------------------------------------------------------------------------
  _build() {
    if (this._built) return;
    this._built = true;
    this.cv = document.getElementById("map-canvas");
    this.side = document.getElementById("map-side");

    this.cv.addEventListener("mousedown", (e) => {
      this.drag = { x: e.clientX, y: e.clientY, moved: false, button: e.button };
    });
    addEventListener("mousemove", (e) => {
      if (!this.drag || !this.isOpen) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
      if (this.drag.moved) {
        this.center[0] -= dx / this.zoom;
        this.center[1] -= dy / this.zoom;
        this.drag.x = e.clientX; this.drag.y = e.clientY;
      }
    });
    addEventListener("mouseup", (e) => {
      if (!this.drag || !this.isOpen) return;
      const d = this.drag; this.drag = null;
      if (d.moved) return;
      const [wx, wz] = this._screenToWorld(e.clientX, e.clientY);
      if (d.button === 2) this._deleteNear(wx, wz);
      else if (d.button === 0 && e.target === this.cv) this._addWaypoint(wx, wz);
    });
    this.cv.addEventListener("contextmenu", (e) => e.preventDefault());
    this.cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const dir = Math.sign(e.deltaY);
      const steps = [1, 2, 3, 4, 6, 8];
      let i = steps.indexOf(this.zoom);
      i = Math.max(0, Math.min(steps.length - 1, i - dir));
      this.zoom = steps[i];
    }, { passive: false });
  }

  _screenToWorld(sx, sy) {
    const r = this.cv.getBoundingClientRect();
    return [
      this.center[0] + (sx - r.left - r.width / 2) / this.zoom,
      this.center[1] + (sy - r.top - r.height / 2) / this.zoom,
    ];
  }

  open() {
    this._build();
    this.isOpen = true;
    const p = this.game.player.pos;
    this.center = [p[0], p[2]];
    this.cv.width = innerWidth;
    this.cv.height = innerHeight;
    this._renderPanel();
  }

  close() { this.isOpen = false; this.drag = null; }

  // Called from the main loop each frame while the map screen is up. Redraws
  // are throttled to REDRAW_MS (shared with the minimap) so the map never eats
  // the frame budget.
  update(dt) {
    if (!this.isOpen) return;
    const world = this.game.world;
    if (!world) return;
    this._redrawT = (this._redrawT || 0) + (dt || 0.016) * 1000;
    if (this._redrawT < REDRAW_MS) return;
    this._redrawT = 0;
    if (this.cv.width !== innerWidth || this.cv.height !== innerHeight) {
      this.cv.width = innerWidth; this.cv.height = innerHeight;
    }
    this._consumeDirty(world);
    const ctx = this.cv.getContext("2d");
    const w = this.cv.width, h = this.cv.height;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#0b0e13";
    ctx.fillRect(0, 0, w, h);

    const z = this.zoom;
    const cx0 = Math.floor((this.center[0] - w / 2 / z) / CX);
    const cx1 = Math.floor((this.center[0] + w / 2 / z) / CX);
    const cz0 = Math.floor((this.center[1] - h / 2 / z) / CZ);
    const cz1 = Math.floor((this.center[1] + h / 2 / z) / CZ);
    const budget = { n: TILE_BUDGET };
    const ccx = (cx0 + cx1) / 2, ccz = (cz0 + cz1) / 2;

    // near-centre first, so detail fills out from where the player is looking
    const order = [];
    for (let tz = cz0; tz <= cz1; tz++) for (let tx = cx0; tx <= cx1; tx++) {
      order.push([tx, tz, (tx - ccx) * (tx - ccx) + (tz - ccz) * (tz - ccz)]);
    }
    order.sort((a, b) => a[2] - b[2]);

    for (const [tx, tz] of order) {
      const t = this._tileAt(world, tx, tz, budget);
      const sx = Math.round((tx * CX - this.center[0]) * z + w / 2);
      const sy = Math.round((tz * CZ - this.center[1]) * z + h / 2);
      if (t === "fog") { ctx.fillStyle = FOG; ctx.fillRect(sx, sy, CX * z, CZ * z); continue; }
      if (!t) { ctx.fillStyle = "#141a22"; ctx.fillRect(sx, sy, CX * z, CZ * z); continue; }
      ctx.drawImage(t.cv, sx, sy, CX * z, CZ * z);
    }

    // waypoints
    for (const wp of this.game.waypoints || []) {
      const sx = (wp.x - this.center[0]) * z + w / 2;
      const sy = (wp.z - this.center[1]) * z + h / 2;
      if (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20) continue;
      this._diamond(ctx, sx, sy, 6, wp.color || WP_COLORS[0]);
      ctx.font = "12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(8,10,14,0.75)";
      const label = wp.death ? "☠ " + wp.name : wp.name;
      const tw = ctx.measureText(label).width;
      ctx.fillRect(sx - tw / 2 - 4, sy - 24, tw + 8, 15);
      ctx.fillStyle = "#e8edf2";
      ctx.fillText(label, sx, sy - 12.5);
    }

    // the player: a heading arrow
    const p = this.game.player;
    const px = (p.pos[0] - this.center[0]) * z + w / 2;
    const py = (p.pos[2] - this.center[1]) * z + h / 2;
    this._arrow(ctx, px, py, Math.atan2(-Math.sin(p.yaw), Math.cos(p.yaw)), 8, "#ffffff");
  }

  _diamond(ctx, x, y, r, color) {
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(10,12,16,0.9)";
    ctx.stroke();
  }

  _arrow(ctx, x, y, ang, r, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(0, -r); ctx.lineTo(r * 0.7, r); ctx.lineTo(0, r * 0.45); ctx.lineTo(-r * 0.7, r);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(10,12,16,0.9)";
    ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Waypoints.
  // ---------------------------------------------------------------------------
  _addWaypoint(wx, wz) {
    const g = this.game;
    if (!g.waypoints) g.waypoints = [];
    if (g.waypoints.length >= 64) return;
    const y = this._surfaceHeight(g.world, Math.floor(wx), Math.floor(wz));
    const n = g.waypoints.filter((w) => !w.death).length + 1;
    g.waypoints.push({
      x: Math.round(wx * 10) / 10, y, z: Math.round(wz * 10) / 10,
      name: "Waypoint " + n,
      color: WP_COLORS[(n - 1) % WP_COLORS.length],
    });
    this._renderPanel();
  }

  _deleteNear(wx, wz) {
    const g = this.game;
    if (!g.waypoints) return;
    const tol = 12 / this.zoom;   // ~12 screen px
    let best = -1, bestD = tol;
    for (let i = 0; i < g.waypoints.length; i++) {
      const d = Math.hypot(g.waypoints[i].x - wx, g.waypoints[i].z - wz);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { g.waypoints.splice(best, 1); this._renderPanel(); }
  }

  onWaypointsChanged() { if (this.isOpen) this._renderPanel(); }

  // Side panel: rename / recolour / centre / delete. All names go through
  // input values + textContent — never innerHTML.
  _renderPanel() {
    const side = this.side;
    side.innerHTML = "";
    const title = document.createElement("h3");
    title.textContent = "Waypoints";
    side.appendChild(title);

    const list = document.createElement("div");
    list.className = "wp-list";
    const wps = this.game.waypoints || [];
    if (!wps.length) {
      const p = document.createElement("p");
      p.className = "wp-hint";
      p.textContent = "Click anywhere on the map to drop a waypoint.";
      list.appendChild(p);
    }
    for (const wp of wps) {
      const row = document.createElement("div");
      row.className = "wp-row";

      const sw = document.createElement("button");
      sw.className = "wp-swatch";
      sw.style.background = wp.color || WP_COLORS[0];
      sw.title = "Change colour";
      sw.onclick = () => {
        const i = WP_COLORS.indexOf(wp.color);
        wp.color = WP_COLORS[(i + 1) % WP_COLORS.length];
        sw.style.background = wp.color;
      };
      row.appendChild(sw);

      const name = document.createElement("input");
      name.type = "text";
      name.maxLength = 24;
      name.value = wp.name;
      name.oninput = () => { wp.name = name.value; };
      row.appendChild(name);

      const go = document.createElement("button");
      go.className = "btn small";
      go.textContent = "◎";
      go.title = "Centre the map here";
      go.onclick = () => { this.center = [wp.x, wp.z]; };
      row.appendChild(go);

      const del = document.createElement("button");
      del.className = "btn small";
      del.textContent = "✕";
      del.title = "Delete";
      del.onclick = () => {
        const i = this.game.waypoints.indexOf(wp);
        if (i >= 0) this.game.waypoints.splice(i, 1);
        this._renderPanel();
      };
      row.appendChild(del);
      list.appendChild(row);
    }
    side.appendChild(list);

    const hint = document.createElement("p");
    hint.className = "wp-hint";
    hint.textContent = "Click: add · right-click: remove · drag: pan · scroll: zoom · M/Esc: close";
    side.appendChild(hint);
  }

  // ---------------------------------------------------------------------------
  // HUD side: the corner minimap + in-world floating markers.
  // Called every rendered frame while a world is up.
  // ---------------------------------------------------------------------------
  tickHud(dt, camera) {
    const g = this.game;
    const has = g.world && g.player && this.hasAtlas();

    // minimap
    const wantMm = has && Settings.get("minimap") && !this.isOpen;
    if (!this._mm) {
      this._mm = document.getElementById("minimap");
      this._mmCtx = this._mm.getContext("2d");
      this._mm.width = this._mm.height = MM_SIZE;
    }
    this._mm.classList.toggle("hidden", !wantMm);
    if (wantMm) {
      this._mmT += (dt || 0.016) * 1000;
      if (this._mmT >= REDRAW_MS) { this._mmT = 0; this._drawMinimap(); }
    }

    // in-world markers
    if (!this._markerRoot) {
      this._markerRoot = document.createElement("div");
      this._markerRoot.id = "waypoint-tags";
      document.getElementById("ui").appendChild(this._markerRoot);
    }
    if (!has || this.isOpen) { this._clearMarkers(); return; }
    this._updateMarkers(camera);
  }

  _drawMinimap() {
    const g = this.game, world = g.world;
    this._consumeDirty(world);
    const ctx = this._mmCtx, S = MM_SIZE;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#0b0e13";
    ctx.fillRect(0, 0, S, S);
    const px = g.player.pos[0], pz = g.player.pos[2];
    const cx0 = Math.floor((px - S / 2) / CX), cx1 = Math.floor((px + S / 2) / CX);
    const cz0 = Math.floor((pz - S / 2) / CZ), cz1 = Math.floor((pz + S / 2) / CZ);
    const budget = { n: 6 };
    for (let tz = cz0; tz <= cz1; tz++) {
      for (let tx = cx0; tx <= cx1; tx++) {
        const t = this._tileAt(world, tx, tz, budget);
        if (!t || t === "fog") continue;     // fog stays the dark backdrop
        ctx.drawImage(t.cv, Math.round(tx * CX - px + S / 2), Math.round(tz * CZ - pz + S / 2));
      }
    }
    // waypoint blips, clamped to the rim so off-screen ones point the way
    for (const wp of g.waypoints || []) {
      let dx = wp.x - px, dz = wp.z - pz;
      const d = Math.max(Math.abs(dx), Math.abs(dz));
      const lim = S / 2 - 6;
      if (d > lim) { dx = dx / d * lim; dz = dz / d * lim; }
      this._diamond(ctx, S / 2 + dx, S / 2 + dz, 3.5, wp.color || WP_COLORS[0]);
    }
    const p = this.game.player;
    this._arrow(ctx, S / 2, S / 2, Math.atan2(-Math.sin(p.yaw), Math.cos(p.yaw)), 6, "#ffffff");
  }

  _clearMarkers() {
    for (const m of this._markers) m.el.remove();
    this._markers = [];
  }

  _updateMarkers(camera) {
    const g = this.game;
    const wps = g.waypoints || [];
    // keep the DOM pool in sync with the waypoint list
    while (this._markers.length < wps.length) {
      const el = document.createElement("div");
      el.className = "waypoint-tag";
      this._markerRoot.appendChild(el);
      this._markers.push({ el });
    }
    while (this._markers.length > wps.length) this._markers.pop().el.remove();

    const vp = camera.viewProj, w = innerWidth, h = innerHeight;
    const p = g.player.pos;
    for (let i = 0; i < wps.length; i++) {
      const wp = wps[i], m = this._markers[i];
      const x = wp.x, y = (wp.y || 64) + 1.6, z = wp.z;
      const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
      if (cw <= 0.1) { m.el.style.display = "none"; continue; }
      const cx = (vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / cw;
      const cy = (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / cw;
      if (cx < -1.05 || cx > 1.05 || cy < -1.05 || cy > 1.05) { m.el.style.display = "none"; continue; }
      const dist = Math.hypot(wp.x - p[0], wp.z - p[2]);
      const label = (wp.death ? "☠ " : "◆ ") + wp.name + " · " + Math.round(dist) + "m";
      if (m.el.textContent !== label) m.el.textContent = label;
      m.el.style.display = "";
      m.el.style.color = wp.color || WP_COLORS[0];
      m.el.style.opacity = dist < 12 ? "0.45" : "0.92";
      m.el.style.transform =
        `translate(-50%, -100%) translate(${((cx + 1) / 2 * w) | 0}px, ${((1 - cy) / 2 * h) | 0}px)`;
    }
  }

  // A world is being torn down — drop every per-world visual.
  reset() {
    this.tiles.clear();
    this._clearMarkers();
    if (this._mm) this._mm.classList.add("hidden");
    this.isOpen = false;
  }
}
