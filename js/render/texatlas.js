// Procedurally paints every block texture onto one canvas (the atlas) and
// uploads it as a GL texture. No external image files. Each texture is drawn
// from a deterministic seed so it looks the same every run.
//
// To add a texture: add a painter to PAINTERS keyed by the same name you used
// in blocks.js tex:{}. Unknown names fall back to a magenta "missing" tile.

import { BLOCKS } from "../world/blocks.js";
import { mulberry32, hashSeed } from "../core/prng.js";

const TILE = 16; // pixels per texture tile

// ---------- tiny colour helpers ----------
function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
function css(r, g, b, a = 1) { return `rgba(${clamp8(r) | 0},${clamp8(g) | 0},${clamp8(b) | 0},${a})`; }

function px(ctx, ox, oy, x, y, r, g, b, a = 1) {
  ctx.fillStyle = css(r, g, b, a);
  ctx.fillRect(ox + x, oy + y, 1, 1);
}

// Fill a whole tile with a base colour plus per-pixel brightness jitter.
function noisy(ctx, ox, oy, base, amt, rng) {
  const [r, g, b] = hexToRgb(base);
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      const j = (rng() * 2 - 1) * amt;
      px(ctx, ox, oy, x, y, r + j, g + j, b + j);
    }
}

// Scatter small blobs of colour (used for ore flecks, cobble, pebbles).
function blobs(ctx, ox, oy, color, count, rng, sizeMax = 2) {
  const [r, g, b] = hexToRgb(color);
  for (let i = 0; i < count; i++) {
    const bx = (rng() * TILE) | 0, by = (rng() * TILE) | 0;
    const s = 1 + ((rng() * sizeMax) | 0);
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        const j = (rng() * 2 - 1) * 18;
        px(ctx, ox, oy, (bx + x) % TILE, (by + y) % TILE, r + j, g + j, b + j);
      }
  }
}

// Iron L-brackets riveted into all four corners (shared by the chest tiles).
function chestBrackets(ctx, ox, oy) {
  const arm = (cx, cy, dx, dy) => {
    for (let k = 0; k < 3; k++) {
      px(ctx, ox, oy, cx + k * dx, cy, 136, 138, 146);
      px(ctx, ox, oy, cx, cy + k * dy, 136, 138, 146);
    }
    px(ctx, ox, oy, cx + dx, cy + dy, 108, 110, 118);   // rivet
  };
  arm(0, 0, 1, 1); arm(15, 0, -1, 1); arm(0, 15, 1, -1); arm(15, 15, -1, -1);
}

// ---------- per-texture painters ----------
const PAINTERS = {
  bedrock(ctx, ox, oy, rng) { noisy(ctx, ox, oy, "#2a2c30", 26, rng); blobs(ctx, ox, oy, "#15161a", 18, rng); },
  greystone(ctx, ox, oy, rng) { noisy(ctx, ox, oy, "#7d8189", 16, rng); blobs(ctx, ox, oy, "#6b6f77", 8, rng); },
  cobbled(ctx, ox, oy, rng) {
    noisy(ctx, ox, oy, "#73767d", 10, rng);
    blobs(ctx, ox, oy, "#5a5d63", 10, rng, 3);
    blobs(ctx, ox, oy, "#909499", 8, rng, 2);
  },
  loam(ctx, ox, oy, rng) { noisy(ctx, ox, oy, "#6b4b32", 20, rng); blobs(ctx, ox, oy, "#52391f", 10, rng); },
  turf_top(ctx, ox, oy, rng) { noisy(ctx, ox, oy, "#5d9b41", 22, rng); blobs(ctx, ox, oy, "#6fb14d", 14, rng); blobs(ctx, ox, oy, "#4c8636", 10, rng); },
  turf_side(ctx, ox, oy, rng) {
    noisy(ctx, ox, oy, "#6b4b32", 20, rng);
    const [r, g, b] = hexToRgb("#5d9b41");
    for (let x = 0; x < TILE; x++) {
      const h = 3 + (rng() < 0.5 ? 1 : 0);
      for (let y = 0; y < h; y++) { const j = (rng() * 2 - 1) * 18; px(ctx, ox, oy, x, y, r + j, g + j, b + j); }
    }
  },
  sand(ctx, ox, oy, rng) { noisy(ctx, ox, oy, "#dccea2", 14, rng); blobs(ctx, ox, oy, "#cdbd8a", 8, rng); },
  sandstone(ctx, ox, oy, rng) {
    noisy(ctx, ox, oy, "#d8c896", 8, rng);
    for (let y = 3; y < TILE; y += 5) for (let x = 0; x < TILE; x++) px(ctx, ox, oy, x, y, 180, 162, 116);
  },
  shingle(ctx, ox, oy, rng) { noisy(ctx, ox, oy, "#8a8073", 16, rng); blobs(ctx, ox, oy, "#6f665b", 12, rng, 2); blobs(ctx, ox, oy, "#a39a8b", 8, rng, 1); },
  log_top(ctx, ox, oy, rng) {
    noisy(ctx, ox, oy, "#9c7748", 10, rng);
    const cx = 8, cy = 8;
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const d = Math.hypot(x - cx + 0.5, y - cy + 0.5);
      if (Math.floor(d) % 2 === 0) px(ctx, ox, oy, x, y, 120, 92, 56);
    }
  },
  log_side(ctx, ox, oy, rng) {
    noisy(ctx, ox, oy, "#7d5e38", 12, rng);
    for (let x = 1; x < TILE; x += 4) for (let y = 0; y < TILE; y++) { if (rng() < 0.85) px(ctx, ox, oy, x, y, 92, 68, 40); }
  },
  leaves(ctx, ox, oy, rng) {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      if (rng() < 0.16) continue; // transparent gaps -> cutout, see-through canopy
      const base = rng() < 0.5 ? "#3f7a32" : "#356b2a";
      const [r, g, b] = hexToRgb(base); const j = (rng() * 2 - 1) * 20;
      px(ctx, ox, oy, x, y, r + j, g + j, b + j);
    }
  },
  planks(ctx, ox, oy, rng) {
    noisy(ctx, ox, oy, "#b08a52", 10, rng);
    for (let y = 0; y < TILE; y += 4) for (let x = 0; x < TILE; x++) px(ctx, ox, oy, x, y, 138, 104, 60);
    for (let y = 0; y < TILE; y++) px(ctx, ox, oy, 7, y, 138, 104, 60);
  },
  bricks(ctx, ox, oy, rng) {
    noisy(ctx, ox, oy, "#8a8d93", 8, rng);
    const mortar = () => [60, 62, 66];
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const row = (y / 4) | 0;
      const offset = row % 2 === 0 ? 0 : 4;
      if (y % 4 === 0 || (x + offset) % 8 === 0) { const m = mortar(); px(ctx, ox, oy, x, y, m[0], m[1], m[2]); }
    }
  },
  polished(ctx, ox, oy, rng) {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const v = 132 - y * 2 + (rng() * 2 - 1) * 6;
      px(ctx, ox, oy, x, y, v, v + 2, v + 8);
    }
    for (let i = 0; i < TILE; i++) px(ctx, ox, oy, i, 0, 160, 164, 172);
  },
  glass(ctx, ox, oy, rng) {
    // transparent centre (cutout -> see-through), light frame with corner
    // rivets and a pair of diagonal glints
    for (let i = 0; i < TILE; i++) {
      px(ctx, ox, oy, i, 0, 200, 226, 232); px(ctx, ox, oy, i, TILE - 1, 190, 216, 224);
      px(ctx, ox, oy, 0, i, 200, 226, 232); px(ctx, ox, oy, TILE - 1, i, 190, 216, 224);
    }
    px(ctx, ox, oy, 1, 1, 236, 247, 251); px(ctx, ox, oy, 14, 1, 224, 240, 246);
    px(ctx, ox, oy, 1, 14, 224, 240, 246); px(ctx, ox, oy, 14, 14, 210, 232, 240);
    for (let i = 2; i < 8; i++) px(ctx, ox, oy, i, i, 235, 246, 250);
    for (let i = 4; i < 8; i++) px(ctx, ox, oy, i - 1, i + 2, 224, 240, 246);
    for (let i = 10; i < 13; i++) px(ctx, ox, oy, i, i, 218, 236, 244);
  },
  water(ctx, ox, oy, rng) {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const j = (rng() * 2 - 1) * 12 + Math.sin((x + y) * 0.8) * 6;
      px(ctx, ox, oy, x, y, 40 + j, 90 + j, 170 + j, 0.72);
    }
  },
  torch(ctx, ox, oy, rng) {
    // transparent background; a grained stick with a wrap, charred head and a
    // layered flame (ember base -> orange body -> yellow -> white-hot core)
    for (let y = 7; y < TILE; y++) { px(ctx, ox, oy, 7, y, 128, 94, 54); px(ctx, ox, oy, 8, y, 100, 72, 40); }
    px(ctx, ox, oy, 7, 9, 156, 118, 68); px(ctx, ox, oy, 8, 9, 76, 54, 30);       // binding wrap
    px(ctx, ox, oy, 7, 13, 110, 80, 46);                                          // grain nick
    px(ctx, ox, oy, 7, 6, 56, 44, 34); px(ctx, ox, oy, 8, 6, 42, 32, 26);         // charred head
    px(ctx, ox, oy, 7, 5, 232, 106, 28); px(ctx, ox, oy, 8, 5, 214, 90, 24);      // embers
    px(ctx, ox, oy, 6, 4, 242, 138, 34); px(ctx, ox, oy, 9, 4, 234, 124, 30);     // flame body
    px(ctx, ox, oy, 7, 4, 252, 184, 58); px(ctx, ox, oy, 8, 4, 250, 170, 50);
    px(ctx, ox, oy, 6, 3, 248, 166, 46); px(ctx, ox, oy, 9, 3, 240, 148, 38);
    px(ctx, ox, oy, 7, 3, 255, 226, 120); px(ctx, ox, oy, 8, 3, 255, 212, 98);
    px(ctx, ox, oy, 7, 2, 255, 244, 190); px(ctx, ox, oy, 8, 2, 255, 234, 158);   // hot core
    px(ctx, ox, oy, 8, 1, 255, 208, 108);                                         // licking tip
  },
  workbench_top(ctx, ox, oy, rng) {
    PAINTERS.planks(ctx, ox, oy, mulberry32(hashSeed("planks")));
    // banded edge frame + a carved 3x3 crafting grid + iron corner pins
    for (let i = 0; i < TILE; i++) {
      px(ctx, ox, oy, i, 0, 132, 100, 58); px(ctx, ox, oy, i, 15, 92, 68, 38);
      px(ctx, ox, oy, 0, i, 118, 88, 48); px(ctx, ox, oy, 15, i, 100, 74, 42);
    }
    const groove = (x, y) => px(ctx, ox, oy, x, y, 88, 64, 36);
    for (let i = 3; i <= 12; i++) {
      groove(i, 3); groove(i, 12); groove(3, i); groove(12, i);   // grid frame
      groove(i, 6); groove(i, 9); groove(6, i); groove(9, i);     // cell dividers
    }
    for (let i = 4; i <= 11; i++) if (i !== 6 && i !== 9) px(ctx, ox, oy, i, 4, 196, 158, 100); // carve catches light
    px(ctx, ox, oy, 1, 1, 122, 124, 132); px(ctx, ox, oy, 14, 1, 122, 124, 132);
    px(ctx, ox, oy, 1, 14, 122, 124, 132); px(ctx, ox, oy, 14, 14, 122, 124, 132);
  },
  workbench_side(ctx, ox, oy, rng) {
    PAINTERS.planks(ctx, ox, oy, mulberry32(hashSeed("planks2")));
    // framed panel with a saw and a hammer hung on it
    for (let i = 0; i < TILE; i++) {
      px(ctx, ox, oy, i, 0, 84, 62, 36); px(ctx, ox, oy, i, 15, 74, 54, 30);
      px(ctx, ox, oy, 0, i, 84, 62, 36); px(ctx, ox, oy, 15, i, 84, 62, 36);
    }
    // saw: bright blade, toothed underside, wooden grip
    for (let x = 2; x <= 8; x++) {
      px(ctx, ox, oy, x, 4, 190, 194, 200); px(ctx, ox, oy, x, 5, 158, 162, 170);
      if (x % 2 === 0) px(ctx, ox, oy, x, 6, 150, 154, 162);
    }
    for (let y = 3; y <= 5; y++) { px(ctx, ox, oy, 9, y, 116, 84, 46); px(ctx, ox, oy, 10, y, 92, 66, 36); }
    // hammer: iron head with a lighter face, wooden shaft
    for (let x = 9; x <= 13; x++) { px(ctx, ox, oy, x, 9, 128, 132, 140); px(ctx, ox, oy, x, 10, 100, 104, 112); }
    px(ctx, ox, oy, 13, 9, 156, 160, 168);
    for (let y = 11; y <= 14; y++) { px(ctx, ox, oy, 10, y, 128, 94, 54); px(ctx, ox, oy, 11, y, 104, 74, 42); }
  },
  forge_top(ctx, ox, oy, rng) {
    // mortared stone-block body, recessed vent glowing through iron grate bars
    noisy(ctx, ox, oy, "#7a7e86", 12, rng);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const row = (y / 4) | 0, offset = row % 2 === 0 ? 0 : 4;
      if (y % 4 === 0 || (x + offset) % 8 === 0) px(ctx, ox, oy, x, y, 88, 90, 96);
    }
    for (let y = 4; y <= 11; y++) for (let x = 4; x <= 11; x++) px(ctx, ox, oy, x, y, 24, 20, 18);
    for (let y = 5; y <= 10; y++) for (let x = 5; x <= 10; x++) {
      const heat = Math.max(0, 1 - Math.hypot(x - 7.5, y - 7.5) / 4.2);
      if (rng() < 0.45 + heat * 0.5)
        px(ctx, ox, oy, x, y, 190 + heat * 65, 70 + heat * 120, 16 + heat * 40);
    }
    for (const gx of [6, 9]) for (let y = 4; y <= 11; y++) px(ctx, ox, oy, gx, y, 68, 70, 76);
    for (const gy of [6, 9]) for (let x = 4; x <= 11; x++) px(ctx, ox, oy, x, gy, 62, 64, 70);
  },
  forge_side(ctx, ox, oy, rng) {
    // mortared stone-block body with an arched, lintel-topped firebox; the fire
    // is layered bottom-up: coal bed -> orange body -> yellow tongues -> hot core
    noisy(ctx, ox, oy, "#7a7e86", 12, rng);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const row = (y / 4) | 0, offset = row % 2 === 0 ? 0 : 4;
      if (y % 4 === 0 || (x + offset) % 8 === 0) px(ctx, ox, oy, x, y, 88, 90, 96);
    }
    for (let x = 4; x <= 11; x++) { px(ctx, ox, oy, x, 5, 74, 76, 82); }         // iron lintel
    px(ctx, ox, oy, 3, 5, 60, 62, 68); px(ctx, ox, oy, 12, 5, 60, 62, 68);
    for (let y = 6; y <= 14; y++) for (let x = 4; x <= 11; x++) {
      if (y === 6 && (x < 6 || x > 9)) continue;                                 // arched corners
      px(ctx, ox, oy, x, y, 16, 13, 12);
    }
    for (let x = 5; x <= 10; x++) px(ctx, ox, oy, x, 14, 118 + rng() * 60, 28, 14);
    for (let x = 5; x <= 10; x++) if (rng() < 0.9) px(ctx, ox, oy, x, 13, 224, 88 + rng() * 34, 20);
    for (let x = 5; x <= 10; x++) if (rng() < 0.75) px(ctx, ox, oy, x, 12, 246, 138 + rng() * 32, 30);
    for (let x = 6; x <= 9; x++) if (rng() < 0.7) px(ctx, ox, oy, x, 11, 252, 190, 60);
    for (let x = 6; x <= 9; x++) if (rng() < 0.45) px(ctx, ox, oy, x, 10, 255, 226, 120);
    px(ctx, ox, oy, 7, 10, 255, 240, 170); px(ctx, ox, oy, 8, 11, 255, 236, 156);
    px(ctx, ox, oy, 6, 8, 250, 176, 60);                                          // stray spark
  },
  chest_top(ctx, ox, oy, rng) {
    // warm oak boards bound by an iron strap, brackets riveted at the corners
    noisy(ctx, ox, oy, "#ab7f49", 10, rng);
    for (const yy of [5, 10]) for (let x = 0; x < TILE; x++) px(ctx, ox, oy, x, yy, 134, 98, 52);
    for (let i = 0; i < TILE; i++) {
      px(ctx, ox, oy, i, 0, 122, 88, 46); px(ctx, ox, oy, i, 15, 88, 62, 32);
      px(ctx, ox, oy, 0, i, 104, 74, 38); px(ctx, ox, oy, 15, i, 104, 74, 38);
    }
    for (let y = 0; y < TILE; y++) { px(ctx, ox, oy, 7, y, 130, 132, 140); px(ctx, ox, oy, 8, y, 102, 104, 112); }
    chestBrackets(ctx, ox, oy);
  },
  chest_side(ctx, ox, oy, rng) {
    // horizontal boards, deep lid seam, iron corner brackets, latch with keyhole
    noisy(ctx, ox, oy, "#a97e48", 10, rng);
    for (let x = 0; x < TILE; x++) {
      px(ctx, ox, oy, x, 4, 92, 64, 32);          // lid seam
      px(ctx, ox, oy, x, 5, 158, 116, 64);        // lower lip catches light
      px(ctx, ox, oy, x, 10, 130, 94, 48);        // board join
    }
    for (let i = 0; i < TILE; i++) {
      px(ctx, ox, oy, i, 0, 122, 88, 46); px(ctx, ox, oy, i, 15, 84, 58, 30);
      px(ctx, ox, oy, 0, i, 100, 70, 36); px(ctx, ox, oy, 15, i, 100, 70, 36);
    }
    chestBrackets(ctx, ox, oy);
    // latch plate straddling the seam
    for (let y = 2; y <= 6; y++) for (let x = 6; x <= 9; x++) px(ctx, ox, oy, x, y, 128, 130, 138);
    for (let y = 2; y <= 6; y++) px(ctx, ox, oy, 6, y, 104, 106, 114);
    for (let x = 6; x <= 9; x++) px(ctx, ox, oy, x, 6, 92, 94, 102);
    px(ctx, ox, oy, 7, 2, 170, 172, 180); px(ctx, ox, oy, 8, 2, 170, 172, 180);
    px(ctx, ox, oy, 7, 4, 42, 42, 48); px(ctx, ox, oy, 8, 4, 42, 42, 48);       // keyhole
    px(ctx, ox, oy, 7, 5, 42, 42, 48);
  },
  ladder(ctx, ox, oy, rng) {
    // transparent background (cutout): two rails, chunky rungs with underside
    // shadow, and a nail where each rung meets a rail
    const rail = (x) => { for (let y = 0; y < TILE; y++) { px(ctx, ox, oy, x, y, 150, 116, 66); px(ctx, ox, oy, x + 1, y, 118, 90, 50); } };
    rail(2); rail(12);
    for (let y = 1; y < TILE - 1; y += 4) {
      for (let x = 2; x < 14; x++) { px(ctx, ox, oy, x, y, 160, 124, 72); px(ctx, ox, oy, x, y + 1, 122, 94, 52); }
      px(ctx, ox, oy, 3, y, 104, 80, 44); px(ctx, ox, oy, 12, y, 104, 80, 44);   // nails
    }
  },
  trapdoor(ctx, ox, oy, rng) { trapdoorTex("#b08a52", "#6e5230")(ctx, ox, oy, rng); },
  door(ctx, ox, oy, rng) { doorTex("#b08a52", "#6e5230")(ctx, ox, oy, rng); },
  bed_head_top(ctx, ox, oy, rng) {
    noisy(ctx, ox, oy, "#b5443a", 12, rng);            // red blanket base
    blobs(ctx, ox, oy, "#a03c33", 6, rng, 1);
    for (let x = 0; x < TILE; x++) { px(ctx, ox, oy, x, 0, 124, 74, 42); px(ctx, ox, oy, x, 1, 96, 58, 34); }  // headboard rail
    // plump pillow: dim rounded edge, bright centre, a stitched highlight
    for (let y = 2; y <= 6; y++) for (let x = 2; x <= 13; x++) {
      const edge = y === 2 || y === 6 || x === 2 || x === 13;
      const j = (rng() * 2 - 1) * 6;
      if (edge) px(ctx, ox, oy, x, y, 202 + j, 200 + j, 190 + j);
      else px(ctx, ox, oy, x, y, 238 + j, 236 + j, 226 + j);
    }
    px(ctx, ox, oy, 4, 3, 250, 249, 242); px(ctx, ox, oy, 5, 3, 250, 249, 242);
    // blanket folded over just below the pillow
    for (let x = 0; x < TILE; x++) { px(ctx, ox, oy, x, 8, 150, 58, 50); px(ctx, ox, oy, x, 9, 128, 46, 40); }
  },
  bed_foot_top(ctx, ox, oy, rng) {
    noisy(ctx, ox, oy, "#b5443a", 10, rng);            // red quilt
    // diagonal quilt stitching
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      if ((x + y) % 6 === 0 || (x - y + 32) % 6 === 0) px(ctx, ox, oy, x, y, 150, 58, 50);
    }
    // tucked white sheet at the foot end
    for (let x = 0; x < TILE; x++) {
      px(ctx, ox, oy, x, 13, 128, 46, 40);
      px(ctx, ox, oy, x, 14, 222, 218, 206); px(ctx, ox, oy, x, 15, 192, 188, 176);
    }
  },
  bed_side(ctx, ox, oy, rng) {
    PAINTERS.planks(ctx, ox, oy, mulberry32(hashSeed("bedside")));   // wood frame at the bottom
    // draped blanket with a lit top edge and shadowed hem
    for (let y = 0; y < 8; y++) for (let x = 0; x < TILE; x++) { const j = (rng() * 2 - 1) * 10; px(ctx, ox, oy, x, y, 181 + j, 68 + j, 58 + j); }
    for (let x = 0; x < TILE; x++) {
      px(ctx, ox, oy, x, 0, 205, 86, 74);
      px(ctx, ox, oy, x, 7, 138, 50, 44);
      px(ctx, ox, oy, x, 8, 224, 220, 208);       // white sheet peeking out
      px(ctx, ox, oy, x, 9, 128, 88, 48);         // frame rail
    }
    // shadowed gap under the bed between stout legs
    for (let y = 12; y < TILE; y++) for (let x = 3; x <= 12; x++) px(ctx, ox, oy, x, y, 34, 28, 22);
  },
};

// ---------- parameterised painters for the generated material families ----------
// Each mirrors a hand-written painter above but takes colours, so a new stone or
// wood is just a colour pair.
function stoneTex(base, fleck) {
  return (ctx, ox, oy, rng) => { noisy(ctx, ox, oy, base, 16, rng); blobs(ctx, ox, oy, fleck, 8, rng); };
}
function polishedTex(base) {
  const [r, g, b] = hexToRgb(base);
  return (ctx, ox, oy, rng) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const k = 1 - y * 0.018 + (rng() * 2 - 1) * 0.04;
      px(ctx, ox, oy, x, y, r * k, g * k, b * k);
    }
    for (let i = 0; i < TILE; i++) px(ctx, ox, oy, i, 0, r * 1.25, g * 1.25, b * 1.25); // top highlight
  };
}
function bricksTex(base) {
  const [mr, mg, mb] = hexToRgb(base).map((v) => v * 0.42);
  return (ctx, ox, oy, rng) => {
    noisy(ctx, ox, oy, base, 8, rng);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const row = (y / 4) | 0, offset = row % 2 === 0 ? 0 : 4;
      if (y % 4 === 0 || (x + offset) % 8 === 0) px(ctx, ox, oy, x, y, mr, mg, mb);
    }
  };
}
function plankTex(base, line) {
  const [lr, lg, lb] = hexToRgb(line);
  return (ctx, ox, oy, rng) => {
    noisy(ctx, ox, oy, base, 10, rng);
    for (let y = 0; y < TILE; y += 4) for (let x = 0; x < TILE; x++) px(ctx, ox, oy, x, y, lr, lg, lb);
    for (let y = 0; y < TILE; y++) px(ctx, ox, oy, 7, y, lr, lg, lb);
  };
}
function logTopTex(base) {
  const [rr, rg, rb] = hexToRgb(base).map((v) => v * 0.74);
  return (ctx, ox, oy, rng) => {
    noisy(ctx, ox, oy, base, 10, rng);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (Math.floor(d) % 2 === 0) px(ctx, ox, oy, x, y, rr, rg, rb);
    }
  };
}
function logSideTex(base) {
  const [sr, sg, sb] = hexToRgb(base).map((v) => v * 0.78);
  return (ctx, ox, oy, rng) => {
    noisy(ctx, ox, oy, base, 12, rng);
    for (let x = 1; x < TILE; x += 4) for (let y = 0; y < TILE; y++) if (rng() < 0.85) px(ctx, ox, oy, x, y, sr, sg, sb);
  };
}
function leavesTex(c1, c2) {
  return (ctx, ox, oy, rng) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      if (rng() < 0.16) continue; // cutout gaps
      const [r, g, b] = hexToRgb(rng() < 0.5 ? c1 : c2);
      const j = (rng() * 2 - 1) * 20;
      px(ctx, ox, oy, x, y, r + j, g + j, b + j);
    }
  };
}
PAINTERS.umberstone = stoneTex("#8a6a4a", "#6f543a");
PAINTERS.slatestone = stoneTex("#54606e", "#424c58");
PAINTERS.polished_umber = polishedTex("#9a7a58");
PAINTERS.polished_slate = polishedTex("#64707e");
PAINTERS.bricks_umber = bricksTex("#8a6a4a");
PAINTERS.bricks_slate = bricksTex("#54606e");
PAINTERS.pine_planks = plankTex("#c2a05a", "#a8843e");
PAINTERS.dusk_planks = plankTex("#5a4634", "#463224");
PAINTERS.pine_log_top = logTopTex("#c2a766");
PAINTERS.pine_log_side = logSideTex("#b8924a");
PAINTERS.dusk_log_top = logTopTex("#6a5236");
PAINTERS.dusk_log_side = logSideTex("#4a3a2c");
PAINTERS.pine_leaves = leavesTex("#7a9a4a", "#6a8a3e");
PAINTERS.dusk_leaves = leavesTex("#3a5a3a", "#2e4a2e");
PAINTERS.birch_planks = plankTex("#d8c9a2", "#b3a276");
PAINTERS.birch_log_top = logTopTex("#d9cfae");
// Birch bark: chalk-white with the characteristic dark horizontal scores.
PAINTERS.birch_log_side = (ctx, ox, oy, rng) => {
  noisy(ctx, ox, oy, "#e4dfd2", 8, rng);
  for (let i = 0; i < 9; i++) {
    const y = (rng() * TILE) | 0, x = (rng() * TILE) | 0, w = 2 + ((rng() * 3) | 0);
    for (let k = 0; k < w; k++) px(ctx, ox, oy, (x + k) % TILE, y, 52, 48, 42);
  }
};
PAINTERS.birch_leaves = leavesTex("#8fb055", "#7a9c44");
PAINTERS.palm_planks = plankTex("#c9a06a", "#a37c46");
PAINTERS.palm_log_top = logTopTex("#c2a06a");
// Palm trunk: stacked frond-scar rings instead of vertical grain.
PAINTERS.palm_log_side = (ctx, ox, oy, rng) => {
  noisy(ctx, ox, oy, "#a3855a", 10, rng);
  for (let y = 2; y < TILE; y += 4) {
    for (let x = 0; x < TILE; x++) { px(ctx, ox, oy, x, y, 130, 104, 66); if (rng() < 0.5) px(ctx, ox, oy, x, y + 1, 148, 120, 78); }
  }
};
PAINTERS.palm_leaves = leavesTex("#4fae4a", "#3f9440");

// Wood doors/trapdoors: the wood's planks plus a frame, bevelled panels and
// hardware. The bevel (dark top/left, light bottom/right) makes panels read as
// recessed instead of just outlined.
function doorTex(base, line) {
  const [lr, lg, lb] = hexToRgb(line);
  const [br, bg, bb] = hexToRgb(base);
  return (ctx, ox, oy, rng) => {
    plankTex(base, line)(ctx, ox, oy, mulberry32(hashSeed(base + "door")));
    for (let i = 0; i < TILE; i++) {
      px(ctx, ox, oy, 0, i, lr, lg, lb); px(ctx, ox, oy, TILE - 1, i, lr, lg, lb);
      px(ctx, ox, oy, i, 0, lr, lg, lb); px(ctx, ox, oy, i, TILE - 1, lr, lg, lb);
    }
    const panel = (y0, y1) => {
      for (let y = y0; y <= y1; y++) for (let x = 3; x <= 12; x++) {
        const j = (rng() * 2 - 1) * 8;
        px(ctx, ox, oy, x, y, br * 0.88 + j, bg * 0.88 + j, bb * 0.88 + j);
      }
      for (let x = 3; x <= 12; x++) { px(ctx, ox, oy, x, y0, br * 0.58, bg * 0.58, bb * 0.58); px(ctx, ox, oy, x, y1, br * 1.18, bg * 1.18, bb * 1.18); }
      for (let y = y0; y <= y1; y++) { px(ctx, ox, oy, 3, y, br * 0.62, bg * 0.62, bb * 0.62); px(ctx, ox, oy, 12, y, br * 1.14, bg * 1.14, bb * 1.14); }
    };
    panel(2, 6); panel(9, 13);
    // brass handle with a shadow pixel so it sits proud of the door
    px(ctx, ox, oy, TILE - 5, 10, 240, 208, 110); px(ctx, ox, oy, TILE - 5, 11, 214, 178, 84);
    px(ctx, ox, oy, TILE - 4, 11, br * 0.5, bg * 0.5, bb * 0.5);
  };
}
function trapdoorTex(base, line) {
  const [lr, lg, lb] = hexToRgb(line);
  const [br, bg, bb] = hexToRgb(base);
  return (ctx, ox, oy, rng) => {
    plankTex(base, line)(ctx, ox, oy, mulberry32(hashSeed(base + "trap")));
    for (let i = 0; i < TILE; i++) {
      px(ctx, ox, oy, i, 0, lr, lg, lb); px(ctx, ox, oy, i, TILE - 1, lr, lg, lb);
      px(ctx, ox, oy, 0, i, lr, lg, lb); px(ctx, ox, oy, TILE - 1, i, lr, lg, lb);
    }
    // lit inner chamfer along the top/left of the frame
    for (let i = 1; i < TILE - 1; i++) { px(ctx, ox, oy, i, 1, br * 1.15, bg * 1.15, bb * 1.15); px(ctx, ox, oy, 1, i, br * 1.1, bg * 1.1, bb * 1.1); }
    // X cross-brace with iron studs where it meets the frame
    for (let i = 2; i <= 13; i++) {
      px(ctx, ox, oy, i, i, lr, lg, lb);
      px(ctx, ox, oy, i, 15 - i, lr, lg, lb);
    }
    px(ctx, ox, oy, 2, 2, 126, 128, 136); px(ctx, ox, oy, 13, 2, 126, 128, 136);
    px(ctx, ox, oy, 2, 13, 126, 128, 136); px(ctx, ox, oy, 13, 13, 126, 128, 136);
  };
}
PAINTERS.wool = (ctx, ox, oy, rng) => {
  noisy(ctx, ox, oy, "#ececec", 8, rng);
  blobs(ctx, ox, oy, "#dadada", 16, rng, 2);
  blobs(ctx, ox, oy, "#ffffff", 10, rng, 1);
};
PAINTERS.pine_door = doorTex("#c2a05a", "#7a5e2e");
PAINTERS.dusk_door = doorTex("#5a4634", "#33271a");
PAINTERS.pine_trapdoor = trapdoorTex("#c2a05a", "#7a5e2e");
PAINTERS.dusk_trapdoor = trapdoorTex("#5a4634", "#33271a");
PAINTERS.birch_door = doorTex("#d8c9a2", "#8f8058");
PAINTERS.palm_door = doorTex("#c9a06a", "#7c5c32");
PAINTERS.birch_trapdoor = trapdoorTex("#d8c9a2", "#8f8058");
PAINTERS.palm_trapdoor = trapdoorTex("#c9a06a", "#7c5c32");

// Snowy grass: a clean snow cap over the usual dirt side.
PAINTERS.snow_top = (ctx, ox, oy, rng) => {
  noisy(ctx, ox, oy, "#eef2f6", 6, rng);
  blobs(ctx, ox, oy, "#dde6ee", 8, rng, 1);
};
PAINTERS.snowturf_side = (ctx, ox, oy, rng) => {
  noisy(ctx, ox, oy, "#6b4b32", 20, rng);
  for (let x = 0; x < TILE; x++) {
    const h = 3 + (rng() < 0.5 ? 1 : 0);
    for (let y = 0; y < h; y++) { const j = (rng() * 2 - 1) * 8; px(ctx, ox, oy, x, y, 236 + j, 240 + j, 246 + j); }
  }
};

// Soul Anchor: night-dark stone shot through with a glowing soul-teal core.
PAINTERS.soul_anchor_top = (ctx, ox, oy, rng) => {
  noisy(ctx, ox, oy, "#2c2f3a", 10, rng);
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5);
    if (d < 2.4) px(ctx, ox, oy, x, y, 150, 240, 226);                 // hot core
    else if (d < 4.2 && rng() < 0.8) px(ctx, ox, oy, x, y, 74, 178, 168);
    else if (Math.abs(d - 6.2) < 0.7) px(ctx, ox, oy, x, y, 52, 118, 116);  // faint ring
  }
  for (let i = 0; i < TILE; i++) { px(ctx, ox, oy, i, 0, 60, 64, 78); px(ctx, ox, oy, 0, i, 60, 64, 78); }
};
PAINTERS.soul_anchor_side = (ctx, ox, oy, rng) => {
  noisy(ctx, ox, oy, "#2c2f3a", 10, rng);
  for (let i = 0; i < TILE; i++) { px(ctx, ox, oy, i, 0, 66, 70, 84); px(ctx, ox, oy, i, 15, 22, 24, 30); }
  // a rune-etched channel bleeding light up the face
  for (let y = 3; y <= 13; y++) {
    px(ctx, ox, oy, 7, y, 74, 190, 178); px(ctx, ox, oy, 8, y, 96, 214, 200);
    if (y % 3 === 0) { px(ctx, ox, oy, 6, y, 58, 142, 136); px(ctx, ox, oy, 9, y, 58, 142, 136); }
  }
  px(ctx, ox, oy, 7, 2, 150, 240, 226); px(ctx, ox, oy, 8, 2, 150, 240, 226);
};

// Papyrus: a clutch of tall reeds. Two tiles that share the SAME stem columns
// so stacked segments read as continuous reeds: `papyrus_stem` runs every stem
// the full tile height (used for segments with more papyrus above — see the
// mesher's emitPlant), and `papyrus` (the top segment) carries the stems up to
// feathered umbels at the tips.
const PAPYRUS_STEMS = [[4, 3], [7, 1], [10, 4], [12, 6]];   // [x, crown y on the top tile]
function papyrusStemPx(ctx, ox, oy, rng, sx, y) {
  const g = 120 + (rng() * 2 - 1) * 16;
  px(ctx, ox, oy, sx, y, 106, g + 30, 66);
  if ((y + sx) % 5 === 0) px(ctx, ox, oy, sx, y, 84, 118, 52);   // stem node ring
  if (rng() < 0.2) px(ctx, ox, oy, sx + 1, y, 88, g + 12, 54);
}
PAINTERS.papyrus_stem = (ctx, ox, oy, rng) => {
  for (const [sx] of PAPYRUS_STEMS) {
    for (let y = 0; y < TILE; y++) papyrusStemPx(ctx, ox, oy, rng, sx, y);
  }
};
PAINTERS.papyrus = (ctx, ox, oy, rng) => {
  for (const [sx, top] of PAPYRUS_STEMS) {
    for (let y = top; y < TILE; y++) papyrusStemPx(ctx, ox, oy, rng, sx, y);
    // umbel: a little starburst of lighter fronds at the tip
    for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-2, 0], [2, 0], [-1, 0], [1, 0], [0, -2]]) {
      const yy = top + dy, xx = sx + dx;
      if (yy >= 0 && xx >= 0 && xx < TILE) px(ctx, ox, oy, xx, yy, 150, 190, 96);
    }
  }
};

// Ore painters: greystone base + coloured flecks.
function oreTexture(color, count) {
  return (ctx, ox, oy, rng) => {
    PAINTERS.greystone(ctx, ox, oy, mulberry32(hashSeed("greystone")));
    blobs(ctx, ox, oy, color, count, rng, 2);
  };
}
PAINTERS.ore_embercoal = oreTexture("#1d1d22", 9);
PAINTERS.ore_copper = oreTexture("#c8783a", 9);
PAINTERS.ore_ferralite = oreTexture("#d9cdb8", 9);
PAINTERS.ore_sunbrass = oreTexture("#e8c64a", 8);
PAINTERS.ore_aetherite = oreTexture("#46d8c4", 8);
PAINTERS.ore_sparkstone = oreTexture("#e0432f", 9);
PAINTERS.ore_azurite = oreTexture("#2f6fe0", 9);
PAINTERS.ore_gloamite = oreTexture("#8a52e8", 8);
PAINTERS.ore_verdanite = oreTexture("#46b558", 9);

// ---------- plants & greebles (cross sprites, transparent background) ----------
// These paint onto the tile's transparent canvas leaving gaps -> a cutout X
// billboard. Coordinates: y=0 is the top of the tile, y=15 the base (ground).

// Upright blades rising from the base — grasses and ferns.
function bladeTex(cLo, cHi, opts = {}) {
  const count = opts.count ?? 7;
  const minH = opts.minH ?? 6, varH = opts.varH ?? 7;
  const arch = opts.arch ?? 0.22;   // chance a blade leans as it rises
  return (ctx, ox, oy, rng) => {
    const n = count + ((rng() * 3) | 0);
    for (let i = 0; i < n; i++) {
      let x = 1 + ((rng() * (TILE - 2)) | 0);
      const bh = minH + ((rng() * varH) | 0);
      const [r, g, b] = hexToRgb(rng() < 0.5 ? cLo : cHi);
      for (let k = 0; k < bh; k++) {
        const y = TILE - 1 - k;
        if (y < 1) break;
        if (k > 2 && rng() < arch) x += rng() < 0.5 ? -1 : 1;
        const j = (rng() * 2 - 1) * 16;
        px(ctx, ox, oy, (x + TILE) % TILE, y, r + j, g + j, b + j);
        if (k < bh - 1 && rng() < 0.35) px(ctx, ox, oy, (x + 1 + TILE) % TILE, y, r + j - 10, g + j - 10, b + j - 10);
      }
    }
  };
}

// A stem with a coloured bloom head on top — flowers.
function flowerTex(stem, petal, center) {
  const [sr, sg, sb] = hexToRgb(stem);
  const [pr, pg, pb] = hexToRgb(petal);
  const [cr, cg, cb] = hexToRgb(center);
  return (ctx, ox, oy, rng) => {
    const sx = 7 + ((rng() * 2) | 0);
    for (let y = 6; y < TILE; y++) { const j = (rng() * 2 - 1) * 10; px(ctx, ox, oy, sx, y, sr + j, sg + j, sb + j); }
    px(ctx, ox, oy, sx - 1, 10, sr, sg, sb); px(ctx, ox, oy, sx + 1, 12, sr, sg, sb);   // little leaves
    // bloom: a rough 5-petal ring around (sx,4)
    const head = [[sx, 1], [sx - 1, 2], [sx + 1, 2], [sx - 2, 3], [sx + 2, 3], [sx - 2, 5], [sx + 2, 5], [sx - 1, 6], [sx + 1, 6], [sx, 7]];
    for (const [hx, hy] of head) { const j = (rng() * 2 - 1) * 14; px(ctx, ox, oy, hx, hy, pr + j, pg + j, pb + j); }
    for (const [hx, hy] of [[sx, 3], [sx, 4], [sx - 1, 4], [sx + 1, 4]]) px(ctx, ox, oy, hx, hy, cr, cg, cb);
  };
}

// Short stem + domed cap — mushrooms.
function mushroomTex(cap, spotted) {
  const [cr, cg, cb] = hexToRgb(cap);
  return (ctx, ox, oy, rng) => {
    for (let y = 8; y < 13; y++) { px(ctx, ox, oy, 7, y, 224, 216, 198); px(ctx, ox, oy, 8, y, 208, 198, 178); }
    for (let y = 5; y < 9; y++) for (let x = 4; x < 12; x++) {
      if (y === 5 && (x < 6 || x > 9)) continue;
      const j = (rng() * 2 - 1) * 10; px(ctx, ox, oy, x, y, cr + j, cg + j, cb + j);
    }
    if (spotted) { px(ctx, ox, oy, 6, 6, 236, 236, 226); px(ctx, ox, oy, 9, 7, 236, 236, 226); px(ctx, ox, oy, 8, 6, 236, 236, 226); }
  };
}

// A rounded leafy clump — shrub.
function bushTex(c1, c2) {
  return (ctx, ox, oy, rng) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      if (Math.hypot(x - 8, y - 8.5) > 7) continue;
      if (rng() < 0.14) continue;                       // cutout gaps
      const [r, g, b] = hexToRgb(rng() < 0.5 ? c1 : c2);
      const j = (rng() * 2 - 1) * 18; px(ctx, ox, oy, x, y, r + j, g + j, b + j);
    }
    for (let y = 12; y < TILE; y++) px(ctx, ox, oy, 7, y, 92, 68, 42);   // little stem at the base
  };
}

// Bare brittle twigs — dead bush.
function deadBushTex(ctx, ox, oy, rng) {
  const [r, g, b] = hexToRgb("#8a6a3a");
  const branches = 5 + ((rng() * 3) | 0);
  for (let i = 0; i < branches; i++) {
    let x = 5 + ((rng() * 6) | 0), y = TILE - 1;
    const h = 7 + ((rng() * 6) | 0), dir = rng() < 0.5 ? -1 : 1;
    for (let k = 0; k < h; k++) {
      if (y < 2) break;
      const j = (rng() * 2 - 1) * 14; px(ctx, ox, oy, (x + TILE) % TILE, y, r + j, g + j, b + j);
      y--; if (rng() < 0.5) x += dir;
    }
  }
}

// A scatter of small stones hugging the ground — pebble greeble.
function pebblesTex(ctx, ox, oy, rng) {
  const cols = ["#8a8f96", "#6f747b", "#a2a7ad"];
  for (let i = 0; i < 5; i++) {
    const bx = 2 + ((rng() * (TILE - 5)) | 0), by = TILE - 4 + ((rng() * 3) | 0);
    const s = 2 + ((rng() * 2) | 0);
    const [r, g, b] = hexToRgb(cols[(rng() * cols.length) | 0]);
    for (let y = 0; y < s; y++) for (let x = 0; x < s + 1; x++) {
      const j = (rng() * 2 - 1) * 14; px(ctx, ox, oy, (bx + x) % TILE, Math.min(TILE - 1, by + y), r + j, g + j, b + j);
    }
  }
}

PAINTERS.tall_grass = bladeTex("#4f9438", "#5da844", { count: 8, minH: 7, varH: 6 });
PAINTERS.fern = bladeTex("#3f7a4a", "#4f8f52", { count: 9, minH: 8, varH: 6, arch: 0.4 });
PAINTERS.bush = bushTex("#3f7a32", "#356b2a");
PAINTERS.dead_shrub = deadBushTex;
PAINTERS.pebbles = pebblesTex;
PAINTERS.mushroom_red = mushroomTex("#c23a2f", true);
PAINTERS.mushroom_brown = mushroomTex("#9c7350", false);
PAINTERS.flower_poppy = flowerTex("#3f7a32", "#d23a34", "#241a12");
PAINTERS.flower_daisy = flowerTex("#3f7a32", "#f0f0ea", "#ecc24a");
PAINTERS.flower_cornflower = flowerTex("#3f7a32", "#4a6fe0", "#2a3f8a");
PAINTERS.flower_dandelion = flowerTex("#3f7a32", "#f2c53a", "#c99a24");
PAINTERS.flower_violet = flowerTex("#3f7a32", "#9a5ac2", "#f2c53a");

function missing(ctx, ox, oy) {
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const m = (x < TILE / 2) === (y < TILE / 2);
    px(ctx, ox, oy, x, y, m ? 230 : 20, 20, m ? 230 : 20);
  }
}

// Build the atlas. Returns { texture, uvForName(name) -> [u0,v0,u1,v1] }.
export function buildAtlas(gl) {
  // Gather every texture name referenced by blocks.
  const names = new Set();
  for (const b of BLOCKS) {
    if (!b.tex) continue;
    for (const v of Object.values(b.tex)) names.add(v);
  }
  const list = [...names];
  const cols = Math.ceil(Math.sqrt(list.length));
  const rows = Math.ceil(list.length / cols);
  const canvas = document.createElement("canvas");
  canvas.width = cols * TILE;
  canvas.height = rows * TILE;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  const uv = {};
  list.forEach((name, i) => {
    const cx = i % cols, cy = (i / cols) | 0;
    const ox = cx * TILE, oy = cy * TILE;
    const painter = PAINTERS[name] || missing;
    painter(ctx, ox, oy, mulberry32(hashSeed(name)));
    // Inset by half a texel to avoid neighbour-tile bleeding at grazing angles
    // (NEAREST sampling can otherwise pick up the adjacent tile on tile edges).
    const e = 0.5 / TILE;
    uv[name] = [
      (cx + 0 + e) / cols, (cy + 0 + e) / rows,
      (cx + 1 - e) / cols, (cy + 1 - e) / rows,
    ];
  });

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return {
    texture: tex,
    canvas, // exposed so item icons can sample tiles
    tileSize: TILE,
    cols, rows,
    uvForName(name) { return uv[name] || uv[list[0]]; },
    pixelRect(name) {
      const i = list.indexOf(name);
      if (i < 0) return [0, 0, TILE, TILE];
      return [(i % cols) * TILE, ((i / cols) | 0) * TILE, TILE, TILE];
    },
  };
}
