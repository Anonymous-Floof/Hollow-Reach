// A tiny fixed-size pool of generation workers with a FIFO job queue. The world
// streamer hands it chunk coords; it replies (via onChunk) with the generated
// voxel buffer whenever a worker finishes. Kept deliberately generic so the
// same pattern can later host threaded lighting/meshing or AI ticks.

export class GenPool {
  constructor(seed, onChunk, genVer = 0) {
    this.seed = seed >>> 0;
    this.genVer = genVer;
    this.onChunk = onChunk;
    this.queue = [];        // [cx, cz] jobs waiting for a free worker
    this.workers = [];
    this.busy = [];

    const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
    const n = Math.max(1, Math.min(4, cores - 1));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL("./genworker.js", import.meta.url), { type: "module" });
      const idx = i;
      w.onmessage = (e) => { this.busy[idx] = false; this.onChunk(e.data); this._pump(); };
      w.onerror = (e) => { this.busy[idx] = false; console.error("gen worker error", e.message); this._pump(); };
      this.workers.push(w);
      this.busy.push(false);
    }
  }

  request(cx, cz) { this.queue.push([cx, cz]); this._pump(); }

  _pump() {
    for (let i = 0; i < this.workers.length && this.queue.length; i++) {
      if (this.busy[i]) continue;
      const [cx, cz] = this.queue.shift();
      this.busy[i] = true;
      this.workers[i].postMessage({ cx, cz, seed: this.seed, ver: this.genVer });
    }
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.queue = [];
  }
}
