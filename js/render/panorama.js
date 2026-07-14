// Static menu panorama: a skybox built from six captured face images. This is
// what replaced the live world render behind the main menu — near-zero cost (six
// textured quads a frame) and it shows the player's own last-played world.
//
// The six faces are 90°-FOV cube views captured by renderer.capturePanorama at
// the SAME orientations defined here, so the capture and the skybox agree and the
// edges line up. Face order everywhere: [+X, -X, +Y, -Y, +Z, -Z].

import { createProgram } from "../core/gl.js";
import { mat4 } from "../core/mat4.js";

// Per-face look direction + up vector. The ±Y faces need a non-world up so the
// four side faces tile seamlessly around them.
export const PANO_DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
export const PANO_UPS = [[0, 1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0], [0, 1, 0]];

const SKY_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
uniform mat4 uVP;
out vec2 vUV;
void main(){ vUV = aUV; gl_Position = (uVP * vec4(aPos, 1.0)).xyww; }`;
// .xyww forces depth = w -> gl_FragCoord.z = 1 (far plane), so the skybox sits
// behind anything else without needing depth writes.

const SKY_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 frag;
void main(){ frag = vec4(texture(uTex, vUV).rgb, 1.0); }`;

const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export class Skybox {
  constructor(gl) {
    this.gl = gl;
    this.prog = createProgram(gl, SKY_VS, SKY_FS, ["aPos", "aUV"]);
    this._ready = false;
    this.tex = [];
    this._vp = mat4.create();

    // Build the cube: for each face, four corners = center ± right ± up, mapped so
    // image +u = camera right and image +v(down) = -up (matching the flipped
    // capture). Two triangles per face; 6 verts × 6 faces.
    const verts = [];
    for (let f = 0; f < 6; f++) {
      const c = PANO_DIRS[f], up = PANO_UPS[f], r = cross3(c, up);
      const corner = (sr, su) => [c[0] + sr * r[0] + su * up[0], c[1] + sr * r[1] + su * up[1], c[2] + sr * r[2] + su * up[2]];
      const TL = corner(-1, +1), TR = corner(+1, +1), BL = corner(-1, -1), BR = corner(+1, -1);
      const push = (p, u, v) => verts.push(p[0], p[1], p[2], u, v);
      push(TL, 0, 0); push(BL, 0, 1); push(TR, 1, 0);
      push(TR, 1, 0); push(BL, 0, 1); push(BR, 1, 1);
    }
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.bindVertexArray(null);
  }

  // Load the six face data URLs and upload them as textures. `onReady` fires once
  // all six have decoded. Safe to call again to swap in a new panorama.
  setFaces(faces, onReady) {
    const gl = this.gl;
    this._ready = false;
    const next = [];
    let loaded = 0, failed = false;
    for (let i = 0; i < 6; i++) {
      const img = new Image();
      img.onload = () => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        next[i] = t;
        if (++loaded === 6 && !failed) {
          this._disposeTextures();
          this.tex = next;
          this._ready = true;
          if (onReady) onReady();
        }
      };
      img.onerror = () => { failed = true; };
      img.src = faces[i];
    }
  }

  ready() { return this._ready; }

  // Draw the skybox from a camera at the origin looking (yaw, pitch). Depth test
  // off, cull off — it's a full-surround backdrop drawn before anything else.
  render(yaw, pitch, fovDeg, W, H) {
    if (!this._ready) return;
    const gl = this.gl;
    mat4.perspective(this._proj || (this._proj = mat4.create()), (fovDeg * Math.PI) / 180, W / H, 0.05, 10);
    mat4.fromYawPitch(this._view || (this._view = mat4.create()), [0, 0, 0], yaw, pitch);
    mat4.multiply(this._vp, this._proj, this._view);

    gl.viewport(0, 0, W, H);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.prog.uniform("uVP"), false, this._vp);
    gl.uniform1i(this.prog.uniform("uTex"), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.vao);
    for (let f = 0; f < 6; f++) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex[f]);
      gl.drawArrays(gl.TRIANGLES, f * 6, 6);
    }
    gl.bindVertexArray(null);
    gl.depthMask(true);
  }

  _disposeTextures() { for (const t of this.tex) if (t) this.gl.deleteTexture(t); this.tex = []; }
  dispose() {
    this._disposeTextures();
    this.gl.deleteBuffer(this.vbo);
    this.gl.deleteVertexArray(this.vao);
    this._ready = false;
  }
}
