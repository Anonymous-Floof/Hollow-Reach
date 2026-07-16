// Module worker: runs the (pure, CPU-heavy) terrain generation off the main
// thread so streaming new chunks never stalls rendering. It only touches the
// voxel typed array — no DOM, no WebGL — which is exactly why worldgen was kept
// dependency-free. The filled buffer is transferred back (zero-copy).

import { generate } from "./worldgen.js";
import { CX, CZ, WH } from "./chunk.js";

self.onmessage = (e) => {
  const { cx, cz, seed, ver } = e.data;
  const voxels = new Uint16Array(CX * WH * CZ);
  // generate() only needs { cx, cz, voxels }; build a bare stand-in.
  generate({ cx, cz, voxels }, seed, ver);
  self.postMessage({ cx, cz, voxels }, [voxels.buffer]);
};
