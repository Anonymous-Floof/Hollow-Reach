// Keyboard + mouse input with pointer lock. Tracks held keys, per-frame edge
// presses, mouse look deltas, button states, and wheel ticks.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();         // currently held (event.code)
    this.justPressed = new Set();  // pressed this frame (cleared each frame)
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.locked = false;
    this.buttons = { left: false, right: false };
    this.clicks = { left: false, right: false };       // edge: pressed this frame
    this.enabled = false;          // only capture gameplay input while playing
    this._onLockChange = null;

    addEventListener("keydown", (e) => {
      if (e.repeat) return;
      // Don't capture gameplay keys while the user is typing in a text field
      // (world-name box, recipe-book search) — otherwise letters move the player
      // or close menus mid-type.
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      this.keys.add(e.code);
      this.justPressed.add(e.code);
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));

    addEventListener("mousemove", (e) => {
      if (this.locked) {
        this.mouseDX += e.movementX || 0;
        this.mouseDY += e.movementY || 0;
      }
    });

    addEventListener("mousedown", (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.buttons.left = true; this.clicks.left = true; }
      if (e.button === 2) { this.buttons.right = true; this.clicks.right = true; }
    });
    addEventListener("mouseup", (e) => {
      if (e.button === 0) this.buttons.left = false;
      if (e.button === 2) this.buttons.right = false;
    });

    addEventListener("wheel", (e) => {
      if (this.locked) this.wheel += Math.sign(e.deltaY);
    }, { passive: true });

    addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        this.buttons.left = this.buttons.right = false;
      }
      if (this._onLockChange) this._onLockChange(this.locked);
    });
  }

  requestLock() {
    if (this.locked) return;
    // Chrome returns a promise that rejects during the brief post-unlock
    // cooldown; swallow it so a failed re-lock just falls back to click-to-lock.
    const p = this.canvas.requestPointerLock();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }
  exitLock() {
    if (this.locked) document.exitPointerLock();
  }
  onLockChange(fn) { this._onLockChange = fn; }

  pressed(code) { return this.justPressed.has(code); }
  down(code) { return this.keys.has(code); }

  // Consume accumulated mouse look delta.
  takeMouse() {
    const d = [this.mouseDX, this.mouseDY];
    this.mouseDX = 0; this.mouseDY = 0;
    return d;
  }
  takeWheel() { const w = this.wheel; this.wheel = 0; return w; }

  // Call at the end of each frame to clear edge-triggered state.
  endFrame() {
    this.justPressed.clear();
    this.clicks.left = false;
    this.clicks.right = false;
  }
}
