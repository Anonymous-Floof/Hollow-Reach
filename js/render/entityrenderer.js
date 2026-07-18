// Draws entities as small textured cubes with a per-instance model matrix.
// Block-item drops use the block's atlas faces; other items use a flat cube
// tinted by the item's colour. Meshes are built once and cached.

import { createProgram } from "../core/gl.js";
import { GBUF_ENTITY_VS, GBUF_ENTITY_FS } from "../core/shaders_deferred.js";
import { mat4 } from "../core/mat4.js";
import { getBlock, texForFace } from "../world/blocks.js";
import { getItem } from "../game/items.js";
import { CX } from "../world/chunk.js";

const HS = 0.22;   // cube half-size

// face index 0+x 1-x 2+y 3-y 4+z 5-z; [shade, 4 corners as ±1 offsets]
const FACES = [
  { fi: 0, sh: 0.8, c: [[1, -1, -1], [1, -1, 1], [1, 1, 1], [1, 1, -1]] },
  { fi: 1, sh: 0.8, c: [[-1, -1, 1], [-1, -1, -1], [-1, 1, -1], [-1, 1, 1]] },
  { fi: 2, sh: 1.0, c: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]] },
  { fi: 3, sh: 0.55, c: [[-1, -1, 1], [1, -1, 1], [1, -1, -1], [-1, -1, -1]] },
  { fi: 4, sh: 0.85, c: [[1, -1, 1], [-1, -1, 1], [-1, 1, 1], [1, 1, 1]] },
  { fi: 5, sh: 0.85, c: [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1]] },
];

export class EntityRenderer {
  constructor(gl, atlas) {
    this.gl = gl;
    this.atlas = atlas;
    this.prog = createProgram(gl, GBUF_ENTITY_VS, GBUF_ENTITY_FS, ["aPos", "aUV", "aShade", "aSky", "aBlock"]);
    this.blockCubes = new Map();   // blockId -> mesh
    this.flatSprites = new Map();   // blockId -> flat sprite mesh (cross blocks)
    this.flatCube = null;          // shared untextured cube
    this.boatMesh = null;          // shared wooden rowboat (multi-box hull)
    this.sheepMesh = null;         // shared white sheep (body + head + legs)
    this.pigMesh = null;           // shared pink pig
    this.cowMesh = null;           // shared brown-and-white cow
    this.zombieMesh = null;        // shared green zombie (humanoid)
    this.playerMeshes = new Map(); // paletteIdx -> humanoid mesh (remote players)
    this._model = mat4.create();
    // walk-cycle state per entity id (phase/amplitude derived purely from how the
    // entity's position changes, so local mobs, net ghosts and remote players all
    // animate the same way with zero protocol involvement)
    this._anim = new Map();
    this._boneArr = new Float32Array(24);   // 6 bones x (pivot.xyz, angle)
    this._zeroBones = new Float32Array(24);
    this._frameN = 0;
  }

  // Untextured multi-box mesh (a list of {c:[cx,cy,cz], h:[hx,hy,hz], col?:[r,g,b],
  // bone?:idx}). Each box carries its own colour (packed into the unused uv + block
  // slots, read as vCol by the entity shader), so a mob can be multi-toned; the whole
  // mesh is still modulated by uTint at draw time (white normally, red for a hurt
  // flash). A box's bone index rides the aSky slot: the vertex shader rotates bones
  // 1..5 about per-draw pivots (uBones) for walk cycles; bone 0 never moves.
  // Used for blocky mobs like the sheep and zombie.
  _buildMultiBox(boxes) {
    const gl = this.gl;
    const data = [];
    for (const box of boxes) {
      const [cx, cy, cz] = box.c, [hx, hy, hz] = box.h;
      const col = box.col || [1, 1, 1];
      const bone = box.bone || 0;
      for (const f of FACES) {
        const corner = (i) => { const c = f.c[i]; data.push(cx + c[0] * hx, cy + c[1] * hy, cz + c[2] * hz, col[0], col[1], f.sh, bone, col[2]); };
        corner(0); corner(1); corner(2); corner(0); corner(2); corner(3);
      }
    }
    const arr = new Float32Array(data);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 32, 20);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 32, 24);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 32, 28);
    gl.bindVertexArray(null);
    return { vao, vbo, count: arr.length / 8 };
  }

  sheep() {
    if (!this.sheepMesh) {
      // +z = forward: a fluffy cream wool body, a tan face with eyes and
      // drooping ears, and short dark legs with woolly cuffs at the top.
      const WOOL = [0.95, 0.94, 0.90], FACE = [0.84, 0.71, 0.57], SNOUT = [0.74, 0.60, 0.47], LEG = [0.42, 0.34, 0.28], EYE = [0.10, 0.09, 0.08];
      // bones: 1-4 legs (FL FR BL BR, cuffs ride along), 5 head group (graze dip)
      const body = { c: [0, 0.58, -0.02], h: [0.32, 0.30, 0.44], col: WOOL };
      const rump = { c: [0, 0.66, -0.34], h: [0.28, 0.26, 0.12], col: WOOL };   // woolly tail end
      const head = { c: [0, 0.66, 0.50], h: [0.18, 0.19, 0.17], col: FACE, bone: 5 };
      const snout = { c: [0, 0.58, 0.66], h: [0.11, 0.10, 0.07], col: SNOUT, bone: 5 };
      const tuft = { c: [0, 0.84, 0.48], h: [0.17, 0.07, 0.15], col: WOOL, bone: 5 };  // wool fringe over the brow
      const eye = (x) => ({ c: [x, 0.71, 0.672], h: [0.026, 0.032, 0.006], col: EYE, bone: 5 });
      const ear = (x) => ({ c: [x, 0.72, 0.46], h: [0.045, 0.032, 0.065], col: FACE, bone: 5 });
      const cuff = (x, z, b) => ({ c: [x, 0.335, z], h: [0.095, 0.045, 0.095], col: WOOL, bone: b });
      const leg = (x, z, b) => ({ c: [x, 0.17, z], h: [0.08, 0.17, 0.08], col: LEG, bone: b });
      this.sheepMesh = this._buildMultiBox([body, rump, head, snout, tuft,
        eye(0.085), eye(-0.085), ear(0.21), ear(-0.21),
        cuff(0.18, 0.28, 1), cuff(-0.18, 0.28, 2), cuff(0.18, -0.26, 3), cuff(-0.18, -0.26, 4),
        leg(0.18, 0.28, 1), leg(-0.18, 0.28, 2), leg(0.18, -0.26, 3), leg(-0.18, -0.26, 4)]);
    }
    return this.sheepMesh;
  }

  pig() {
    if (!this.pigMesh) {
      // +z = forward: a rounded pink body, a flat snout with nostrils, eyes,
      // perky ears, four little legs and a curly tail nub at the back.
      const BODY = [0.91, 0.60, 0.64], SNOUT = [0.83, 0.49, 0.55], LEG = [0.80, 0.50, 0.54], EYE = [0.12, 0.10, 0.10], NOSE = [0.62, 0.32, 0.38];
      // bones: 1-4 legs (FL FR BL BR), 5 head group (root dip when idle)
      const body = { c: [0, 0.46, 0], h: [0.30, 0.26, 0.42], col: BODY };
      const head = { c: [0, 0.50, 0.46], h: [0.20, 0.19, 0.14], col: BODY, bone: 5 };
      const snout = { c: [0, 0.45, 0.62], h: [0.11, 0.09, 0.05], col: SNOUT, bone: 5 };
      const eye = (x) => ({ c: [x, 0.565, 0.602], h: [0.026, 0.03, 0.006], col: EYE, bone: 5 });
      const nostril = (x) => ({ c: [x, 0.45, 0.673], h: [0.016, 0.026, 0.006], col: NOSE, bone: 5 });
      const ear = (x) => ({ c: [x, 0.70, 0.44], h: [0.05, 0.055, 0.03], col: SNOUT, bone: 5 });
      const tail = { c: [0, 0.56, -0.44], h: [0.028, 0.028, 0.045], col: SNOUT };
      const leg = (x, z, b) => ({ c: [x, 0.13, z], h: [0.08, 0.13, 0.08], col: LEG, bone: b });
      this.pigMesh = this._buildMultiBox([body, head, snout, ear(0.12), ear(-0.12),
        eye(0.09), eye(-0.09), nostril(0.04), nostril(-0.04), tail,
        leg(0.17, 0.26, 1), leg(-0.17, 0.26, 2), leg(0.17, -0.24, 3), leg(-0.17, -0.24, 4)]);
    }
    return this.pigMesh;
  }

  cow() {
    if (!this.cowMesh) {
      // +z = forward: a big barrel body in brown with white patches, a blazed
      // face with pale horns, a pink muzzle and udder, and tall dark legs.
      const BODY = [0.45, 0.32, 0.24], PATCH = [0.93, 0.91, 0.86], HORN = [0.88, 0.85, 0.74];
      const MUZZLE = [0.85, 0.62, 0.60], UDDER = [0.90, 0.68, 0.66], LEG = [0.32, 0.24, 0.19], EYE = [0.10, 0.09, 0.08];
      // bones: 1-4 legs (FL FR BL BR), 5 head group (graze dip)
      const body = { c: [0, 0.86, -0.02], h: [0.36, 0.30, 0.55], col: BODY };
      const patchA = { c: [0.21, 0.94, -0.28], h: [0.16, 0.23, 0.20], col: PATCH };   // hip patch
      const patchB = { c: [-0.18, 0.80, 0.22], h: [0.19, 0.20, 0.18], col: PATCH };   // shoulder patch
      const head = { c: [0, 1.06, 0.68], h: [0.20, 0.20, 0.16], col: BODY, bone: 5 };
      const blaze = { c: [0, 1.10, 0.845], h: [0.07, 0.15, 0.006], col: PATCH, bone: 5 };
      const muzzle = { c: [0, 0.94, 0.82], h: [0.14, 0.09, 0.06], col: MUZZLE, bone: 5 };
      const eye = (x) => ({ c: [x, 1.12, 0.842], h: [0.028, 0.032, 0.006], col: EYE, bone: 5 });
      const horn = (x) => ({ c: [x, 1.26, 0.60], h: [0.035, 0.075, 0.035], col: HORN, bone: 5 });
      const ear = (x) => ({ c: [x, 1.16, 0.60], h: [0.055, 0.035, 0.03], col: BODY, bone: 5 });
      const udder = { c: [0, 0.50, -0.20], h: [0.14, 0.08, 0.16], col: UDDER };
      const tail = { c: [0, 1.02, -0.585], h: [0.03, 0.14, 0.03], col: BODY };
      const leg = (x, z, b) => ({ c: [x, 0.28, z], h: [0.095, 0.28, 0.095], col: LEG, bone: b });
      this.cowMesh = this._buildMultiBox([body, patchA, patchB, head, blaze, muzzle,
        eye(0.105), eye(-0.105), horn(0.155), horn(-0.155), ear(0.24), ear(-0.24), udder, tail,
        leg(0.23, 0.38, 1), leg(-0.23, 0.38, 2), leg(0.23, -0.36, 3), leg(-0.23, -0.36, 4)]);
    }
    return this.cowMesh;
  }

  zombie() {
    if (!this.zombieMesh) {
      // +z = forward: green skin, a tattered shirt torn open over the belly,
      // trousers with ripped hems (bare shins), arms split into sleeve +
      // reaching bare hands, and sunken dark eyes under a heavy brow.
      const SKIN = [0.36, 0.55, 0.34], SKIN_D = [0.30, 0.46, 0.28], SHIRT = [0.22, 0.32, 0.46], PANTS = [0.26, 0.23, 0.34], EYE = [0.08, 0.05, 0.05];
      // bones: 1/2 legs (+x/-x, shin rides its thigh), 3/4 arms (+x/-x)
      const shin = (x, b) => ({ c: [x, 0.14, 0], h: [0.105, 0.14, 0.105], col: SKIN_D, bone: b });  // ripped hems
      const legU = (x, b) => ({ c: [x, 0.52, 0], h: [0.12, 0.24, 0.12], col: PANTS, bone: b });
      const torso = { c: [0, 1.06, 0], h: [0.24, 0.32, 0.14], col: SHIRT };
      const belly = { c: [0.06, 0.88, 0.148], h: [0.10, 0.075, 0.004], col: SKIN_D };      // shirt torn open
      const shoulderRip = { c: [-0.19, 1.30, 0.148], h: [0.05, 0.05, 0.004], col: SKIN_D };
      const head = { c: [0, 1.60, 0.02], h: [0.21, 0.21, 0.21], col: SKIN };
      const brow = { c: [0, 1.70, 0.225], h: [0.16, 0.028, 0.012], col: SKIN_D };
      const eye = (x) => ({ c: [x, 1.645, 0.232], h: [0.035, 0.032, 0.006], col: EYE });
      // arms reach forward (+z): shirt sleeve near the shoulder, bare hands out
      const sleeve = (x, b) => ({ c: [x, 1.20, 0.09], h: [0.105, 0.105, 0.115], col: SHIRT, bone: b });
      const arm = (x, b) => ({ c: [x, 1.20, 0.34], h: [0.10, 0.10, 0.20], col: SKIN, bone: b });
      const hand = (x, b) => ({ c: [x, 1.185, 0.555], h: [0.085, 0.085, 0.045], col: SKIN_D, bone: b });
      this.zombieMesh = this._buildMultiBox([
        shin(-0.13, 2), shin(0.13, 1), legU(-0.13, 2), legU(0.13, 1),
        torso, belly, shoulderRip, head, brow, eye(0.095), eye(-0.095),
        sleeve(-0.32, 4), sleeve(0.32, 3), arm(-0.32, 4), arm(0.32, 3), hand(-0.32, 4), hand(0.32, 3)]);
    }
    return this.zombieMesh;
  }

  // Remote players: a clean humanoid in one of eight shirt colours (picked by
  // hashing the player id, so a player keeps their colour between sessions).
  player(paletteIdx) {
    const idx = ((paletteIdx | 0) % PLAYER_PALETTES.length + PLAYER_PALETTES.length) % PLAYER_PALETTES.length;
    let m = this.playerMeshes.get(idx);
    if (!m) {
      const P = PLAYER_PALETTES[idx];
      const SKIN = [0.85, 0.66, 0.51], SKIN_D = [0.76, 0.57, 0.43], EYE = [0.15, 0.18, 0.30];
      const HAIR = P.hair, SHIRT = P.shirt, PANTS = P.pants;
      // +z = forward, matching the mob convention (see zombie()).
      // bones: 1/2 legs (+x/-x, boots ride along), 3/4 arms, 5 head (pitch look)
      const boot = (x, b) => ({ c: [x, 0.09, 0], h: [0.105, 0.09, 0.115], col: PANTS.map((v) => v * 0.6), bone: b });
      const leg = (x, b) => ({ c: [x, 0.48, 0], h: [0.115, 0.30, 0.115], col: PANTS, bone: b });
      const torso = { c: [0, 1.06, 0], h: [0.24, 0.30, 0.13], col: SHIRT };
      const belt = { c: [0, 0.79, 0], h: [0.245, 0.035, 0.135], col: PANTS.map((v) => v * 0.75) };
      const head = { c: [0, 1.57, 0], h: [0.19, 0.19, 0.19], col: SKIN, bone: 5 };
      const hair = { c: [0, 1.71, -0.02], h: [0.20, 0.075, 0.20], col: HAIR, bone: 5 };  // cap of hair
      const hairBack = { c: [0, 1.58, -0.165], h: [0.20, 0.14, 0.045], col: HAIR, bone: 5 };
      const eye = (x) => ({ c: [x, 1.60, 0.192], h: [0.032, 0.03, 0.006], col: EYE, bone: 5 });
      const brow = { c: [0, 1.665, 0.192], h: [0.13, 0.02, 0.008], col: HAIR, bone: 5 };
      const arm = (x, b) => ({ c: [x, 1.05, 0], h: [0.095, 0.29, 0.095], col: SHIRT, bone: b });
      const hand = (x, b) => ({ c: [x, 0.72, 0], h: [0.09, 0.075, 0.09], col: SKIN_D, bone: b });
      m = this._buildMultiBox([
        boot(-0.125, 2), boot(0.125, 1), leg(-0.125, 2), leg(0.125, 1), torso, belt,
        head, hair, hairBack, eye(0.075), eye(-0.075), brow,
        arm(-0.345, 4), arm(0.345, 3), hand(-0.345, 4), hand(0.345, 3)]);
      this.playerMeshes.set(idx, m);
    }
    return m;
  }

  // A flat double-sided quad (cull is disabled when drawing), for sprite items
  // like the torch so they're a 2D plane instead of a textured cube.
  _buildFlat(uv) {
    const gl = this.gl;
    const [u0, v0, u1, v1] = uv;
    const h = HS;
    const d = [
      -h, -h, 0, u0, v1, 1, 0, 0, h, -h, 0, u1, v1, 1, 0, 0, h, h, 0, u1, v0, 1, 0, 0,
      -h, -h, 0, u0, v1, 1, 0, 0, h, h, 0, u1, v0, 1, 0, 0, -h, h, 0, u0, v0, 1, 0, 0,
    ];
    const arr = new Float32Array(d);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 32, 20);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 32, 24);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 32, 28);
    gl.bindVertexArray(null);
    return { vao, vbo, count: arr.length / 8 };
  }

  flatSprite(blockId) {
    let m = this.flatSprites.get(blockId);
    if (!m) {
      const block = getBlock(blockId);
      m = this._buildFlat(this.atlas.uvForName(block.tex.all));
      this.flatSprites.set(blockId, m);
    }
    return m;
  }

  // Box centred on the origin with per-axis half-extents (hx,hy,hz).
  _buildBox(hx, hy, hz, uvForFace) {
    const gl = this.gl;
    const data = [];
    for (const f of FACES) {
      const uv = uvForFace(f.fi);
      const [u0, v0, u1, v1] = uv;
      const uvc = [[u0, v1], [u1, v1], [u1, v0], [u0, v0]];
      const corner = (i) => {
        const c = f.c[i];
        data.push(c[0] * hx, c[1] * hy, c[2] * hz, uvc[i][0], uvc[i][1], f.sh, 0, 0);
      };
      corner(0); corner(1); corner(2);
      corner(0); corner(2); corner(3);
    }
    const arr = new Float32Array(data);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 32, 20);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 32, 24);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 32, 28);
    gl.bindVertexArray(null);
    return { vao, vbo, count: arr.length / 8 };
  }

  _buildCube(uvForFace) { return this._buildBox(HS, HS, HS, uvForFace); }

  blockCube(blockId) {
    let m = this.blockCubes.get(blockId);
    if (!m) {
      const block = getBlock(blockId);
      m = this._buildCube((fi) => this.atlas.uvForName(texForFace(block, fi)));
      this.blockCubes.set(blockId, m);
    }
    return m;
  }
  unitCube() {
    // Untextured white cube (vCol = white) so the item's colour comes purely from
    // uTint at draw time. Built via the multi-box path which writes a white vCol.
    if (!this.flatCube) this.flatCube = this._buildMultiBox([{ c: [0, 0, 0], h: [HS, HS, HS] }]);
    return this.flatCube;
  }
  boat() {
    if (!this.boatMesh) {
      // +z = forward (the bow). A proper rowboat: dark keel slab, plank side
      // walls and stern, a two-step tapered bow with a small foredeck, pale
      // interior floor and seat bench, and darker gunwale caps along the rims.
      // Origin at the hull bottom (yOff 0); waterline rides at y≈0.18.
      const WOOD = [0.63, 0.47, 0.29], DARK = [0.45, 0.33, 0.20], LIGHT = [0.74, 0.59, 0.40];
      const keel = { c: [0, 0.06, -0.04], h: [0.42, 0.06, 0.60], col: DARK };
      const floor = { c: [0, 0.145, -0.04], h: [0.38, 0.025, 0.56], col: LIGHT };
      const wall = (x) => ({ c: [x, 0.27, -0.06], h: [0.075, 0.15, 0.54], col: WOOD });
      const stern = { c: [0, 0.27, -0.60], h: [0.44, 0.15, 0.075], col: WOOD };
      const bowA = { c: [0, 0.27, 0.53], h: [0.34, 0.15, 0.075], col: WOOD };
      const bowB = { c: [0, 0.29, 0.65], h: [0.20, 0.13, 0.06], col: WOOD };
      const bowTip = { c: [0, 0.32, 0.735], h: [0.08, 0.10, 0.035], col: DARK };
      const rim = (x) => ({ c: [x, 0.435, -0.06], h: [0.085, 0.02, 0.55], col: DARK });
      const sternRim = { c: [0, 0.435, -0.60], h: [0.455, 0.02, 0.09], col: DARK };
      const seat = { c: [0, 0.24, -0.30], h: [0.36, 0.03, 0.11], col: LIGHT };
      const deck = { c: [0, 0.40, 0.55], h: [0.20, 0.022, 0.16], col: LIGHT };
      this.boatMesh = this._buildMultiBox([keel, floor, wall(0.44), wall(-0.44), stern,
        bowA, bowB, bowTip, rim(0.44), rim(-0.44), sternRim, seat, deck]);
    }
    return this.boatMesh;
  }

  // Which mesh/texturing/seat-height to use for an entity. yOff lifts the mesh so
  // its bottom sits at the entity origin.
  modelFor(e) {
    if (e.type === "drop") {
      const it = getItem(e.data.key);
      if (it && it.type === "block") {
        const blk = getBlock(it.blockId);
        if (blk.render === "cross") return { mesh: this.flatSprite(it.blockId), textured: true, tint: [1, 1, 1], yOff: HS };
        return { mesh: this.blockCube(it.blockId), textured: true, tint: [1, 1, 1], yOff: HS };
      }
      const col = it && it.color ? hexToRgb(it.color) : [0.8, 0.8, 0.8];
      return { mesh: this.unitCube(), textured: false, tint: col, yOff: HS };
    }
    if (e.type === "boat") {
      return { mesh: this.boat(), textured: false, tint: [1, 1, 1], yOff: 0 };
    }
    if (e.type === "sheep") {
      const hurt = e.data && e.data.hurtFlash > 0;
      return { mesh: this.sheep(), textured: false, tint: hurt ? [1.4, 0.5, 0.5] : [1, 1, 1], yOff: 0 };
    }
    if (e.type === "pig") {
      const hurt = e.data && e.data.hurtFlash > 0;
      return { mesh: this.pig(), textured: false, tint: hurt ? [1.4, 0.5, 0.5] : [1, 1, 1], yOff: 0 };
    }
    if (e.type === "cow") {
      const hurt = e.data && e.data.hurtFlash > 0;
      return { mesh: this.cow(), textured: false, tint: hurt ? [1.4, 0.5, 0.5] : [1, 1, 1], yOff: 0 };
    }
    if (e.type === "zombie") {
      const hurt = e.data && e.data.hurtFlash > 0;
      return { mesh: this.zombie(), textured: false, tint: hurt ? [1.4, 0.5, 0.5] : [1, 1, 1], yOff: 0 };
    }
    if (e.type === "remote_player") {
      const hurt = e.data && e.data.hurtFlash > 0;
      return { mesh: this.player(e.data.hue || 0), textured: false, tint: hurt ? [1.4, 0.5, 0.5] : [1, 1, 1], yOff: 0 };
    }
    return null;
  }

  // ---- animation ------------------------------------------------------------
  //
  // Per-entity walk state, advanced from wall-clock position deltas. Called from
  // both render passes each frame; the tiny dt on the second call just continues
  // the same integration, so no frame-stamp bookkeeping is needed.
  _animState(e, now) {
    let st = this._anim.get(e.id);
    if (!st) {
      st = {
        t: now, x: e.pos[0], z: e.pos[2],
        phase: Math.random() * Math.PI * 2, amp: 0,
        head: 0, idle: 3 + Math.random() * 6,   // idle < 0 = grazing window
        seen: now,
      };
      this._anim.set(e.id, st);
    }
    const dtMs = now - st.t;
    if (dtMs > 0) {
      const dt = Math.min(0.1, dtMs / 1000);
      const dx = e.pos[0] - st.x, dz = e.pos[2] - st.z;
      let speed = Math.hypot(dx, dz) / dt;
      if (speed > 20) speed = 0;               // teleport/respawn, not a sprint
      const a = ANIM[e.type];
      st.phase += speed * a.stride * dt;
      st.amp += (Math.min(1.15, speed / a.ref) - st.amp) * Math.min(1, dt * 12);
      st.idle -= dt;
      if (st.idle < -2.8) st.idle = 3 + Math.random() * 7;
      // grazers dip their head while standing still (the idle window)
      const dip = (a.graze && st.idle < 0 && st.amp < 0.2) ? 0.55 : 0;
      st.head += (dip - st.head) * Math.min(1, dt * 3.5);
      st.x = e.pos[0]; st.z = e.pos[2]; st.t = now;
    }
    st.seen = now;
    return st;
  }

  // Fill this._boneArr (pivot.xyz + X-rotation angle per bone) for one entity.
  // Returns null for types without bones (drops, boats) — upload zeros for those.
  _bonesFor(e, now) {
    const a = ANIM[e.type];
    if (!a) return null;
    const st = this._animState(e, now);
    const b = this._boneArr;
    b.fill(0);
    const set = (i, px, py, pz, ang) => { const o = i * 4; b[o] = px; b[o + 1] = py; b[o + 2] = pz; b[o + 3] = ang; };
    const sw = Math.sin(st.phase) * st.amp;
    if (e.type === "sheep" || e.type === "pig" || e.type === "cow") {
      // diagonal gait: FL+BR swing together, FR+BL opposite
      const s = sw * 0.75, [lx, fz, bz, hy] = a.legs;
      set(1, lx, a.hip, fz, s); set(2, -lx, a.hip, fz, -s);
      set(3, lx, a.hip, bz, -s); set(4, -lx, a.hip, bz, s);
      set(5, 0, hy, a.neckZ, st.head + sw * 0.05);
    } else if (e.type === "zombie") {
      const s = sw * 0.6;
      set(1, 0.13, 0.76, 0, s); set(2, -0.13, 0.76, 0, -s);
      // arms stay outstretched; a slow shamble-sway plus a touch of walk bob
      const wob = Math.sin(now * 0.0019 + (e.id % 7)) * 0.07;
      set(3, 0.32, 1.28, 0, sw * 0.18 + wob); set(4, -0.32, 1.28, 0, -sw * 0.18 + wob);
    } else if (e.type === "remote_player") {
      const s = sw * 0.8;
      set(1, 0.125, 0.78, 0, s); set(2, -0.125, 0.78, 0, -s);
      set(3, 0.345, 1.32, 0, -s * 0.7); set(4, -0.345, 1.32, 0, s * 0.7);
      // camera pitch is + up; a + bone angle tips the face down, so negate
      set(5, 0, 1.44, 0.06, -(e.pitch || 0) * 0.85);
    }
    return b;
  }

  // Drop walk states for entities that haven't been drawn in a while.
  _pruneAnim(now) {
    if ((++this._frameN & 255) !== 0) return;
    for (const [id, st] of this._anim) if (now - st.seen > 5000) this._anim.delete(id);
  }

  // Render entity meshes depth-only into the sun shadow map (so mobs cast
  // shadows). `prog` is the shared shadow-entity program; uLightVP is set here.
  drawShadow(prog, lightVP, world) {
    const ents = world.entities;
    if (!ents || !ents.entities.length) return;
    const gl = this.gl;
    const now = performance.now();
    gl.useProgram(prog);
    gl.uniformMatrix4fv(prog.uniform("uLightVP"), false, lightVP);
    ents.forEach((e) => {
      const m = this.modelFor(e);
      if (!m) return;
      const bob = (e.data && e.data.bob != null) ? Math.sin(e.data.bob) * 0.06 : 0;
      mat4.modelMatrix(this._model, e.pos[0], e.pos[1] + m.yOff + bob, e.pos[2], e.yaw, 1);
      gl.uniformMatrix4fv(prog.uniform("uModel"), false, this._model);
      gl.uniform4fv(prog.uniform("uBones[0]"), this._bonesFor(e, now) || this._zeroBones);
      gl.bindVertexArray(m.mesh.vao);
      gl.drawArrays(gl.TRIANGLES, 0, m.mesh.count);
    });
    gl.bindVertexArray(null);
  }

  // Render entities into the deferred G-buffer. Surface light is split into the
  // baked sky / block levels at the entity's cell (the composite pass turns those
  // into the final lit colour, matching terrain), so no fog/daylight here.
  drawGBuffer(camera, world, sky) {
    const ents = world.entities;
    if (!ents || !ents.entities.length) return;
    const gl = this.gl, p = this.prog;
    const now = performance.now();
    this._pruneAnim(now);
    gl.useProgram(p);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.uniformMatrix4fv(p.uniform("uViewProj"), false, camera.viewProj);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas.texture);
    gl.uniform1i(p.uniform("uAtlas"), 0);

    ents.forEach((e) => {
      const m = this.modelFor(e);
      if (!m) return;
      const cx = Math.floor(e.pos[0]), cy = Math.floor(e.pos[1] + e.h * 0.5), cz = Math.floor(e.pos[2]);
      const skyL = world.getSky(cx, cy, cz) / 15;
      const blkL = world.getBlockLight(cx, cy, cz) / 15;
      const bob = (e.data && e.data.bob != null) ? Math.sin(e.data.bob) * 0.06 : 0;
      mat4.modelMatrix(this._model, e.pos[0], e.pos[1] + m.yOff + bob, e.pos[2], e.yaw, 1);
      gl.uniformMatrix4fv(p.uniform("uModel"), false, this._model);
      gl.uniform4fv(p.uniform("uBones[0]"), this._bonesFor(e, now) || this._zeroBones);
      gl.uniform1f(p.uniform("uSky"), skyL);
      gl.uniform1f(p.uniform("uBlock"), blkL);
      gl.uniform1f(p.uniform("uTextured"), m.textured ? 1 : 0);
      gl.uniform3f(p.uniform("uTint"), m.tint[0], m.tint[1], m.tint[2]);
      gl.bindVertexArray(m.mesh.vao);
      gl.drawArrays(gl.TRIANGLES, 0, m.mesh.count);
    });
    gl.bindVertexArray(null);
  }
}

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Per-type animation tuning. ref = the speed (blocks/s) that reads as a "full"
// stride; stride = phase radians advanced per block travelled (shorter legs
// scurry faster). legs = [legX, frontZ, backZ, headPivotY] for quadrupeds.
const ANIM = {
  sheep: { ref: 1.7, stride: 3.4, graze: true, hip: 0.38, legs: [0.18, 0.28, -0.26, 0.62], neckZ: 0.40 },
  pig: { ref: 1.6, stride: 3.6, graze: true, hip: 0.27, legs: [0.17, 0.26, -0.24, 0.48], neckZ: 0.34 },
  cow: { ref: 1.4, stride: 2.8, graze: true, hip: 0.56, legs: [0.23, 0.38, -0.36, 0.98], neckZ: 0.52 },
  zombie: { ref: 2.4, stride: 2.2 },
  remote_player: { ref: 4.3, stride: 2.3 },
};

// Shirt/pants/hair palettes for remote players — distinct at a glance.
const PLAYER_PALETTES = [
  { shirt: [0.22, 0.45, 0.78], pants: [0.25, 0.27, 0.38], hair: [0.28, 0.19, 0.12] }, // blue
  { shirt: [0.78, 0.28, 0.24], pants: [0.28, 0.24, 0.30], hair: [0.12, 0.10, 0.09] }, // red
  { shirt: [0.28, 0.62, 0.34], pants: [0.24, 0.28, 0.32], hair: [0.55, 0.38, 0.18] }, // green
  { shirt: [0.80, 0.62, 0.20], pants: [0.30, 0.26, 0.24], hair: [0.20, 0.14, 0.10] }, // gold
  { shirt: [0.55, 0.32, 0.68], pants: [0.24, 0.24, 0.34], hair: [0.10, 0.09, 0.10] }, // purple
  { shirt: [0.25, 0.62, 0.66], pants: [0.26, 0.30, 0.34], hair: [0.62, 0.50, 0.30] }, // teal
  { shirt: [0.85, 0.48, 0.60], pants: [0.30, 0.26, 0.32], hair: [0.32, 0.22, 0.14] }, // pink
  { shirt: [0.88, 0.86, 0.82], pants: [0.22, 0.24, 0.28], hair: [0.16, 0.13, 0.11] }, // white
];
