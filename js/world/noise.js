// Perlin-style gradient noise (2D + 3D) seeded from a numeric seed, plus fbm.
// Self-contained; no dependencies.

import { mulberry32 } from "../core/prng.js";

export class Noise {
  constructor(seed) {
    // Build a shuffled permutation table from the seed.
    const rng = mulberry32(seed >>> 0);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  static fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  static lerp(a, b, t) { return a + t * (b - a); }

  grad2(hash, x, y) {
    switch (hash & 3) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      default: return -x - y;
    }
  }

  grad3(hash, x, y, z) {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }

  // 2D Perlin noise in roughly [-1, 1].
  noise2(x, y) {
    const p = this.perm;
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = Noise.fade(x), v = Noise.fade(y);
    const aa = p[p[X] + Y], ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y], bb = p[p[X + 1] + Y + 1];
    const x1 = Noise.lerp(this.grad2(aa, x, y),     this.grad2(ba, x - 1, y),     u);
    const x2 = Noise.lerp(this.grad2(ab, x, y - 1), this.grad2(bb, x - 1, y - 1), u);
    return Noise.lerp(x1, x2, v);
  }

  // 3D Perlin noise in roughly [-1, 1].
  noise3(x, y, z) {
    const p = this.perm;
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = Noise.fade(x), v = Noise.fade(y), w = Noise.fade(z);
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z;
    const B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    const L = Noise.lerp;
    return L(
      L(
        L(this.grad3(p[AA], x, y, z),       this.grad3(p[BA], x - 1, y, z),       u),
        L(this.grad3(p[AB], x, y - 1, z),   this.grad3(p[BB], x - 1, y - 1, z),   u), v),
      L(
        L(this.grad3(p[AA + 1], x, y, z - 1),     this.grad3(p[BA + 1], x - 1, y, z - 1),     u),
        L(this.grad3(p[AB + 1], x, y - 1, z - 1), this.grad3(p[BB + 1], x - 1, y - 1, z - 1), u), v),
      w);
  }

  // Fractal Brownian motion (layered noise). Returns roughly [-1, 1].
  fbm2(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise2(x * freq, y * freq);
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  }

  fbm3(x, y, z, octaves = 4, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise3(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  }
}
