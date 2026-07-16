// The sound library: every game event, synthesised. Each designer is a small
// recipe of noise bursts and tuned partials — the goal is that a stone knock,
// a wood tok, a glass shatter and a sheep's bleat are recognisably *those
// sounds*, not generic beeps. All calls no-op until the engine is unlocked.
//
// Sound-design notes (why these recipes sound right):
//  • impacts   = filtered noise transient + a low "body" thump; the bandpass
//                centre is the material's voice (stone ~900 Hz, wood ~320 Hz).
//  • wood      = two narrow resonances (like a struck board's modes).
//  • glass     = a cluster of inharmonic high sine partials with random decays.
//  • creatures = a sawtooth larynx driven through 1-2 sweeping bandpass
//                "formants" (a throat), plus breath noise. Tremolo ≈ a bleat.
//  • water     = noise swept down + little rising sine "droplets".

import { engine } from "./engine.js";

const R = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// ---------------------------------------------------------------------------
// Which acoustic family a block belongs to. Derived from the block def so new
// blocks automatically sound right (tool hints at material, with overrides).
// ---------------------------------------------------------------------------
export function materialOf(block) {
  const k = block.key || "";
  if (block.plant) return "grass";
  if (block.leaf) return "leaves";
  if (k === "glass") return "glass";
  if (k === "wool" || block.render === "bed") return "cloth";
  if (k === "sand" || k === "shingle") return k === "sand" ? "sand" : "gravel";
  if (k.startsWith("ore_")) return "ore";
  if (k === "emberlight" || k === "ladder") return "wood";
  if (block.tool === "axe" || block.plank || block.log) return "wood";
  if (block.tool === "shovel") return "dirt";
  return "stone";                                   // picks + everything else
}

// ---------------------------------------------------------------------------
// Per-material impact designers. `s` scales loudness/length: dig ticks use
// ~0.5, steps ~0.3, breaks 1.0. `d` is the destination node.
// ---------------------------------------------------------------------------
const IMPACT = {
  stone(d, s) {
    const f = R(580, 820);
    engine.burst(d, { dur: 0.055 * s + 0.03, gain: 0.5 * s, filters: [{ type: "bandpass", freq: f, Q: 1.0 }] });
    engine.burst(d, { dur: 0.07, gain: 0.45 * s, filters: [{ type: "lowpass", freq: 200, Q: 0.8 }] });
  },
  ore(d, s) {
    IMPACT.stone(d, s);
    engine.tone(d, { freq: R(1900, 2600), dur: 0.09, gain: 0.06 * s });   // metallic glint
  },
  wood(d, s) {
    const f0 = R(150, 195);
    engine.burst(d, { dur: 0.05 * s + 0.025, gain: 0.55 * s, filters: [{ type: "bandpass", freq: f0, Q: 5 }] });
    engine.burst(d, { dur: 0.04 * s + 0.02, gain: 0.4 * s, filters: [{ type: "bandpass", freq: f0 * 2.3, Q: 6 }] });
    engine.burst(d, { dur: 0.012, gain: 0.22 * s, filters: [{ type: "highpass", freq: 1800, Q: 0.7 }] });
  },
  dirt(d, s) {
    engine.burst(d, { dur: 0.08 * s + 0.04, gain: 0.5 * s, attack: 0.006, filters: [{ type: "lowpass", freq: R(280, 380), Q: 0.8 }] });
    engine.burst(d, { dur: 0.05, gain: 0.14 * s, filters: [{ type: "bandpass", freq: 900, Q: 0.6 }] });
  },
  sand(d, s) {
    for (let i = 0; i < 3; i++) {
      engine.burst(d, { delay: i * R(0.014, 0.03), dur: R(0.03, 0.06), gain: 0.2 * s, filters: [{ type: "bandpass", freq: R(2300, 3600), Q: 0.8 }] });
    }
    engine.burst(d, { dur: 0.09 * s, gain: 0.2 * s, filters: [{ type: "lowpass", freq: 500, Q: 0.6 }] });
  },
  gravel(d, s) {
    for (let i = 0; i < 4; i++) {
      engine.burst(d, { delay: i * R(0.015, 0.035), dur: R(0.025, 0.05), gain: 0.28 * s, filters: [{ type: "bandpass", freq: R(900, 1600), Q: 1.4 }] });
    }
  },
  grass(d, s) {
    engine.burst(d, { dur: 0.1 * s + 0.05, gain: 0.3 * s, attack: 0.02, curve: "lin", filters: [{ type: "highpass", freq: 1500, Q: 0.6 }] });
  },
  leaves(d, s) {
    engine.burst(d, { dur: 0.12 * s + 0.06, gain: 0.32 * s, attack: 0.025, curve: "lin", filters: [{ type: "highpass", freq: 1200, Q: 0.6 }] });
    engine.burst(d, { delay: 0.04, dur: 0.08, gain: 0.16 * s, filters: [{ type: "highpass", freq: 2500, Q: 0.7 }] });
  },
  cloth(d, s) {
    engine.burst(d, { dur: 0.1 * s + 0.04, gain: 0.34 * s, attack: 0.012, filters: [{ type: "lowpass", freq: 420, Q: 0.6 }] });
  },
  glass(d, s) {
    engine.tone(d, { freq: R(2200, 2800), dur: 0.07, gain: 0.2 * s });
    engine.burst(d, { dur: 0.03, gain: 0.14 * s, filters: [{ type: "highpass", freq: 3000, Q: 0.7 }] });
  },
};

// Breaking is the impact plus material-specific debris.
const BREAK = {
  glass(d) {
    // The shatter: a cluster of bright inharmonic partials, each with its own
    // random decay, over a high splash of noise.
    for (let i = 0; i < 7; i++) {
      engine.tone(d, { delay: R(0, 0.05), freq: R(1600, 6800), dur: R(0.06, 0.3), gain: R(0.05, 0.13) });
    }
    engine.burst(d, { dur: 0.22, gain: 0.3, filters: [{ type: "highpass", freq: 2800, Q: 0.6 }] });
    engine.burst(d, { delay: 0.05, dur: 0.14, gain: 0.12, filters: [{ type: "highpass", freq: 4000, Q: 0.6 }] });
  },
  wood(d) {
    engine.burst(d, { dur: 0.018, gain: 0.5, filters: [{ type: "highpass", freq: 1300, Q: 0.7 }] });   // the crack
    IMPACT.wood(d, 1);
    engine.burst(d, { delay: 0.06, dur: 0.12, gain: 0.2, filters: [{ type: "bandpass", freq: 350, Q: 2 }] });
  },
  stone(d) {
    // rock gives way: a sharp crack, a heavy low boom, then chunks tumbling
    engine.burst(d, { dur: 0.02, gain: 0.45, filters: [{ type: "highpass", freq: 900, Q: 0.7 }] });
    engine.burst(d, { dur: 0.1, gain: 0.55, filters: [{ type: "bandpass", freq: R(420, 560), Q: 1.0 }] });
    engine.burst(d, { dur: 0.18, gain: 0.6, attack: 0.006, filters: [{ type: "lowpass", freq: 170, Q: 0.9 }] });
    engine.tone(d, { freq: 95, sweepTo: 52, dur: 0.16, gain: 0.32 });
    for (let i = 0; i < 5; i++) {                    // rubble settling, falling in pitch
      const f = R(280, 620);
      engine.burst(d, { delay: 0.06 + i * R(0.035, 0.06), dur: R(0.04, 0.09), gain: R(0.14, 0.24), filters: [{ type: "bandpass", freq: f, Q: 1.3, sweepTo: f * 0.6, sweepT: 0.08 }] });
    }
  },
  ore(d) { BREAK.stone(d); engine.tone(d, { delay: 0.02, freq: R(1900, 2600), dur: 0.12, gain: 0.07 }); },
  generic(d, mat) {
    (IMPACT[mat] || IMPACT.stone)(d, 1);
    // rubble/debris tail, staggered and falling in pitch
    const base = mat === "dirt" ? 350 : 600;
    for (let i = 0; i < 3; i++) {
      engine.burst(d, { delay: 0.04 + i * R(0.03, 0.05), dur: R(0.04, 0.08), gain: R(0.12, 0.2), filters: [{ type: "bandpass", freq: base * R(0.6, 1.1), Q: 1.2 }] });
    }
  },
};

// ---------------------------------------------------------------------------
// The public facade. Every method guards on engine readiness and the voice cap.
// ---------------------------------------------------------------------------
function go(dur, bus, pos) {
  if (!engine.ready() || !engine.tryVoice(dur)) return null;
  return engine.out(bus, pos);
}

export const sfx = {
  // ---- blocks ----
  blockHit(block, pos) {                    // rhythmic dig tick while mining
    const d = go(0.15, "sfx", pos);
    if (d) (IMPACT[materialOf(block)] || IMPACT.stone)(d, 0.45);
  },
  blockBreak(block, pos) {
    const d = go(0.5, "sfx", pos);
    if (!d) return;
    const mat = materialOf(block);
    if (BREAK[mat]) BREAK[mat](d);
    else BREAK.generic(d, mat);
  },
  blockPlace(block, pos) {
    const d = go(0.2, "sfx", pos);
    if (d) (IMPACT[materialOf(block)] || IMPACT.stone)(d, 0.7);
  },
  step(block, sprint) {
    const d = go(0.12, "sfx");
    if (!d) return;
    // steps live at the feet: no panner, just quiet short impacts
    (IMPACT[materialOf(block)] || IMPACT.stone)(d, sprint ? 0.34 : 0.26);
  },
  wadeStep() {
    const d = go(0.25, "sfx");
    if (!d) return;
    engine.burst(d, { dur: 0.16, gain: 0.22, attack: 0.02, filters: [{ type: "bandpass", freq: R(700, 1100), Q: 0.7, sweepTo: 400, sweepT: 0.16 }] });
    engine.tone(d, { delay: R(0.03, 0.08), freq: R(700, 1100), sweepTo: R(1300, 1900), dur: 0.05, gain: 0.05 });
  },

  // ---- doors / containers / stations ----
  doorToggle(block, open, pos) {
    const d = go(0.55, "sfx", pos);
    if (!d) return;
    // hinge creak = stick-slip: a bending tone juddered by a fast deep tremolo
    // (~15 Hz, near-full depth) so it grinds rather than whines; the squeak
    // partial rides an octave-and-a-bit up, then the latch clacks at the end.
    const up = open ? 1.25 : 0.8;                  // opening creaks up, closing down
    const f0 = (block.render === "trapdoor" ? 130 : 105) * R(0.94, 1.06);
    const trem = { tremRate: R(14, 17), tremDepth: 0.9 };
    engine.tone(d, {
      wave: "sawtooth", freq: f0, sweepTo: f0 * up, dur: 0.38, gain: 0.34, attack: 0.04, ...trem,
      filter: { type: "bandpass", freq: 620, Q: 1.2, sweepTo: 620 * up, sweepT: 0.38 },
    });
    engine.tone(d, {                               // the squeak on top
      wave: "sawtooth", freq: f0 * 2.7, sweepTo: f0 * 2.7 * up, dur: 0.34, gain: 0.12, attack: 0.05, ...trem,
      filter: { type: "bandpass", freq: 1300, Q: 2 },
    });
    engine.burst(d, { dur: 0.34, gain: 0.16, attack: 0.04, curve: "lin", filters: [{ type: "bandpass", freq: 480, Q: 1.2 }] });
    // the latch (kept under the creak now)
    engine.burst(d, { delay: 0.34, dur: 0.02, gain: 0.22, filters: [{ type: "bandpass", freq: 1500, Q: 2 }] });
    engine.burst(d, { delay: 0.365, dur: 0.03, gain: 0.16, filters: [{ type: "bandpass", freq: 700, Q: 2 }] });
  },
  chestOpen(pos) {
    const d = go(0.65, "sfx", pos);
    if (!d) return;
    // a heavier, slower hinge than a door: low grind rising as the lid lifts
    const trem = { tremRate: R(12, 14), tremDepth: 0.85 };
    engine.tone(d, {
      wave: "sawtooth", freq: 78, sweepTo: 118, dur: 0.52, gain: 0.32, attack: 0.06, ...trem,
      filter: { type: "bandpass", freq: 460, Q: 1.1, sweepTo: 700, sweepT: 0.52 },
    });
    engine.tone(d, {
      wave: "sawtooth", freq: 205, sweepTo: 310, dur: 0.48, gain: 0.11, attack: 0.07, ...trem,
      filter: { type: "bandpass", freq: 1100, Q: 2 },
    });
    engine.burst(d, { dur: 0.45, gain: 0.14, attack: 0.06, curve: "lin", filters: [{ type: "bandpass", freq: 420, Q: 1.1 }] });
  },
  chestClose(pos) {
    const d = go(0.5, "sfx", pos);
    if (!d) return;
    const trem = { tremRate: 13, tremDepth: 0.85 };
    engine.tone(d, {
      wave: "sawtooth", freq: 112, sweepTo: 72, dur: 0.26, gain: 0.28, attack: 0.02, ...trem,
      filter: { type: "bandpass", freq: 620, Q: 1.2, sweepTo: 380, sweepT: 0.26 },
    });
    engine.burst(d, { dur: 0.24, gain: 0.12, attack: 0.03, curve: "lin", filters: [{ type: "bandpass", freq: 480, Q: 1.2 }] });
    engine.burst(d, { delay: 0.24, dur: 0.08, gain: 0.5, filters: [{ type: "lowpass", freq: 260, Q: 1 }] });   // lid thud
    engine.tone(d, { delay: 0.24, freq: 130, sweepTo: 70, dur: 0.08, gain: 0.2 });
    engine.burst(d, { delay: 0.255, dur: 0.02, gain: 0.16, filters: [{ type: "bandpass", freq: 1200, Q: 2 }] });
  },
  craft() {
    const d = go(0.4, "sfx");
    if (!d) return;
    IMPACT.wood(d, 0.5);
    engine.burst(d, { delay: 0.1, dur: 0.14, gain: 0.16, filters: [{ type: "bandpass", freq: 500, Q: 2, sweepTo: 1900, sweepT: 0.14 }] });   // the "zip" of assembly
    setTimeout(() => { const d2 = go(0.1, "sfx"); if (d2) IMPACT.wood(d2, 0.4); }, 190);
  },
  smeltDone(pos) {
    const d = go(0.3, "sfx", pos);
    if (!d) return;
    engine.tone(d, { freq: 1320, dur: 0.18, gain: 0.07 });
    engine.tone(d, { delay: 0.02, freq: 1980, dur: 0.24, gain: 0.05 });
  },

  // ---- player ----
  hurt() {
    const d = go(0.3, "sfx");
    if (!d) return;
    // a short "uhh": saw larynx dropping through a closing formant + breath
    const f0 = R(120, 145);
    engine.tone(d, {
      wave: "sawtooth", freq: f0, sweepTo: f0 * 0.62, dur: 0.17, gain: 0.2, attack: 0.012,
      filter: { type: "bandpass", freq: 640, Q: 2.2, sweepTo: 380, sweepT: 0.17 },
    });
    engine.burst(d, { dur: 0.1, gain: 0.1, filters: [{ type: "bandpass", freq: 1400, Q: 0.8 }] });
  },
  died() {
    const d = go(0.8, "sfx");
    if (!d) return;
    const f0 = 130;
    engine.tone(d, {
      wave: "sawtooth", freq: f0, sweepTo: 48, dur: 0.7, gain: 0.18, attack: 0.02,
      vibRate: 5, vibDepth: 8, filter: { type: "bandpass", freq: 560, Q: 2, sweepTo: 220, sweepT: 0.7 },
    });
    engine.burst(d, { dur: 0.5, gain: 0.08, attack: 0.05, curve: "lin", filters: [{ type: "lowpass", freq: 500, Q: 0.7 }] });
  },
  land(intensity) {                          // 0..1 with fall height
    const d = go(0.25, "sfx");
    if (!d) return;
    const s = 0.35 + intensity * 0.65;
    engine.burst(d, { dur: 0.1, gain: 0.5 * s, filters: [{ type: "lowpass", freq: 180, Q: 0.8 }] });
    engine.tone(d, { freq: 74, sweepTo: 46, dur: 0.12, gain: 0.3 * s });
    if (intensity > 0.45) engine.burst(d, { delay: 0.03, dur: 0.08, gain: 0.2 * s, filters: [{ type: "bandpass", freq: 700, Q: 1 }] });
  },
  eat() {
    const d = go(1.0, "sfx");
    if (!d) return;
    for (let i = 0; i < 3; i++) {            // munch, munch, munch…
      engine.burst(d, { delay: i * 0.22 + R(0, 0.03), dur: 0.07, gain: 0.32, attack: 0.008, filters: [{ type: "lowpass", freq: R(650, 950) - i * 120, Q: 1.2 }] });
      engine.burst(d, { delay: i * 0.22 + 0.03, dur: 0.05, gain: 0.14, filters: [{ type: "bandpass", freq: R(1400, 2100), Q: 0.9 }] });
    }
    engine.tone(d, { delay: 0.72, freq: 260, sweepTo: 88, dur: 0.13, gain: 0.14, filter: { type: "lowpass", freq: 700, Q: 1 } });  // gulp
  },
  splash(big) {
    const d = go(0.6, "sfx");
    if (!d) return;
    const s = big ? 1 : 0.55;
    engine.burst(d, { dur: 0.3, gain: 0.4 * s, attack: 0.012, filters: [{ type: "bandpass", freq: 2400, Q: 0.6, sweepTo: 420, sweepT: 0.3 }] });
    for (let i = 0; i < 3; i++) {            // droplets plink back down
      engine.tone(d, { delay: 0.1 + i * R(0.05, 0.09), freq: R(650, 1250), sweepTo: R(1500, 2400), dur: 0.045, gain: 0.06 * s });
    }
  },
  bubbles() {                                // sporadic underwater blips
    const d = go(0.3, "sfx");
    if (!d) return;
    for (let i = 0; i < 2; i++) {
      engine.tone(d, { delay: i * R(0.08, 0.16), freq: R(180, 340), sweepTo: R(600, 1100), dur: R(0.05, 0.1), gain: 0.05, filter: { type: "lowpass", freq: 900, Q: 1 } });
    }
  },
  pickup() {
    const d = go(0.15, "sfx");
    if (!d) return;
    const f = R(480, 620);
    engine.tone(d, { freq: f, sweepTo: f * 1.9, dur: 0.09, gain: 0.14, attack: 0.004 });
    engine.burst(d, { dur: 0.012, gain: 0.08, filters: [{ type: "highpass", freq: 2000, Q: 0.7 }] });
  },
  toss() {
    const d = go(0.15, "sfx");
    if (d) engine.burst(d, { dur: 0.12, gain: 0.16, attack: 0.03, curve: "lin", filters: [{ type: "bandpass", freq: 600, Q: 1, sweepTo: 1500, sweepT: 0.12 }] });
  },
  swing() {                                  // melee whoosh
    const d = go(0.15, "sfx");
    if (d) engine.burst(d, { dur: 0.13, gain: 0.13, attack: 0.04, curve: "lin", filters: [{ type: "bandpass", freq: 380, Q: 1.4, sweepTo: 950, sweepT: 0.13 }] });
  },
  thwack(pos) {                              // a hit landing on a mob
    const d = go(0.15, "sfx", pos);
    if (!d) return;
    engine.burst(d, { dur: 0.07, gain: 0.42, filters: [{ type: "lowpass", freq: 500, Q: 1 }] });
    engine.tone(d, { freq: 200, sweepTo: 90, dur: 0.07, gain: 0.2 });
  },
  shutter() {                                // F2 camera
    const d = go(0.15, "ui");
    if (!d) return;
    engine.burst(d, { dur: 0.02, gain: 0.3, filters: [{ type: "bandpass", freq: 2600, Q: 2 }] });
    engine.burst(d, { delay: 0.07, dur: 0.025, gain: 0.24, filters: [{ type: "bandpass", freq: 1700, Q: 2 }] });
  },

  // ---- mob voices ----
  sheep(kind, pos, seed = 1) {
    const d = go(1.0, "sfx", pos);
    if (!d) return;
    // the bleat: a LOW larynx (200-260 Hz — higher reads as an insect) chopped
    // hard by ~9.5 Hz amplitude tremolo (the "eh-eh-eh"), voiced through open
    // /a/ formants at ~700/1100 Hz. No pitch vibrato — that's what buzzes.
    const f0 = R(205, 255) * (0.92 + (seed % 7) * 0.025) * (kind === "hurt" ? 1.2 : kind === "death" ? 0.85 : 1);
    const dur = kind === "hurt" ? 0.35 : kind === "death" ? 0.9 : R(0.6, 0.75);
    const droop = kind === "death" ? 0.6 : 0.82;
    const trem = { tremRate: R(9, 10.5), tremDepth: 0.85 };
    engine.tone(d, {                                 // chest/body of the voice
      wave: "sawtooth", freq: f0, sweepTo: f0 * droop, dur, gain: 0.3, attack: 0.07, ...trem,
      filter: { type: "lowpass", freq: 1300, Q: 0.8 },
    });
    engine.tone(d, {                                 // open-mouth /a/ formant
      wave: "sawtooth", freq: f0 * 1.008, sweepTo: f0 * droop, dur, gain: 0.16, attack: 0.07, ...trem,
      filter: { type: "bandpass", freq: 700, Q: 1.6 },
    });
    engine.tone(d, {                                 // upper formant, quiet colour
      wave: "sawtooth", freq: f0 * 0.994, sweepTo: f0 * droop, dur, gain: 0.07, attack: 0.09, ...trem,
      filter: { type: "bandpass", freq: 1150, Q: 2.5 },
    });
    engine.burst(d, { dur, gain: 0.05, attack: 0.08, curve: "lin", filters: [{ type: "bandpass", freq: 1100, Q: 0.8 }] });  // breath
  },
  pig(kind, pos, seed = 1) {
    const d = go(0.4, "sfx", pos);
    if (!d) return;
    // the oink: a snorty grunt — nasal formant swings up then down fast
    const f0 = R(95, 125) * (0.92 + (seed % 5) * 0.04) * (kind === "hurt" ? 1.35 : kind === "death" ? 0.8 : 1);
    const dur = kind === "hurt" ? 0.18 : kind === "death" ? 0.42 : 0.26;
    engine.burst(d, { dur: 0.05, gain: 0.14, filters: [{ type: "highpass", freq: 2000, Q: 0.7 }] });   // nostril snort
    engine.tone(d, {
      wave: "sawtooth", freq: f0, sweepTo: f0 * 0.8, dur, gain: 0.2, attack: 0.02,
      vibRate: 26, vibDepth: f0 * 0.15,
      filter: { type: "bandpass", freq: 800, Q: 2.6, sweepTo: 1350, sweepT: dur * 0.45 },
    });
    engine.tone(d, {
      wave: "sawtooth", freq: f0 * 0.996, dur: dur * 0.9, delay: dur * 0.1, gain: 0.08,
      filter: { type: "bandpass", freq: 1400, Q: 3, sweepTo: 700, sweepT: dur * 0.9 },
    });
  },
  // Critical hit: a bright metallic snap over the regular thwack.
  crit() {
    const d = go(0.3, "sfx");
    if (!d) return;
    engine.tone(d, { wave: "sine", freq: 1900, sweepTo: 900, dur: 0.12, gain: 0.14, attack: 0.004 });
    engine.tone(d, { delay: 0.04, wave: "sine", freq: 2600, sweepTo: 1300, dur: 0.1, gain: 0.08 });
    engine.burst(d, { dur: 0.05, gain: 0.12, filters: [{ type: "highpass", freq: 2400, Q: 1 }] });
  },

  // Wayshard warp: a rising two-voice shimmer with an airy whoosh.
  warp() {
    const d = go(0.9, "sfx");
    if (!d) return;
    engine.tone(d, { wave: "sine", freq: 320, sweepTo: 1500, dur: 0.5, gain: 0.16, attack: 0.02 });
    engine.tone(d, { wave: "sine", freq: 480, sweepTo: 2200, dur: 0.55, gain: 0.09, attack: 0.06 });
    engine.burst(d, { dur: 0.5, gain: 0.12, attack: 0.05, filters: [{ type: "highpass", freq: 900, Q: 0.7 }] });
    engine.tone(d, { delay: 0.45, wave: "sine", freq: 1800, sweepTo: 2600, dur: 0.2, gain: 0.05 });
  },

  cow(kind, pos, seed = 1) {
    const dur = kind === "hurt" ? 0.4 : kind === "death" ? 1.1 : R(0.8, 1.15);
    const d = go(dur + 0.2, "sfx", pos);
    if (!d) return;
    // the moo: a deep chesty larynx swelling up a shade as the mouth opens (a
    // bandpass "throat" sweeping from a closed m-hum up to a round oo), then
    // sagging. Slow, mild vibrato — anything faster reads as a bleat.
    const f0 = R(88, 112) * (0.94 + (seed % 6) * 0.03) * (kind === "hurt" ? 1.3 : kind === "death" ? 0.78 : 1);
    engine.tone(d, {
      wave: "sawtooth", freq: f0 * 0.85, sweepTo: f0 * (kind === "death" ? 0.6 : 0.96), dur, gain: 0.26, attack: 0.12,
      vibRate: 3.4, vibDepth: f0 * 0.04,
      filter: { type: "lowpass", freq: 900, Q: 0.8 },
    });
    engine.tone(d, {                                 // the opening mouth
      wave: "sawtooth", freq: f0 * 0.852, sweepTo: f0 * 0.95, dur, gain: 0.15, attack: 0.14,
      filter: { type: "bandpass", freq: 300, Q: 1.7, sweepTo: 560, sweepT: dur * 0.6 },
    });
    engine.burst(d, { dur: dur * 0.7, gain: 0.04, attack: 0.15, curve: "lin", filters: [{ type: "bandpass", freq: 700, Q: 0.8 }] });  // breath
  },
  zombie(kind, pos, seed = 1) {
    const dur = kind === "death" ? 1.3 : kind === "hurt" ? 0.32 : R(0.85, 1.2);
    const d = go(dur + 0.2, "sfx", pos);
    if (!d) return;
    // the groan: a low ragged saw sagging in pitch through two dark formants
    const f0 = (kind === "hurt" ? R(110, 135) : R(72, 95)) * (0.94 + (seed % 6) * 0.025);
    const drop = kind === "death" ? 0.45 : 0.72;
    engine.tone(d, {
      wave: "sawtooth", freq: f0, sweepTo: f0 * drop, dur, gain: 0.16, attack: kind === "hurt" ? 0.015 : 0.09,
      vibRate: 4.2, vibDepth: f0 * 0.08, tremRate: 6.5, tremDepth: 0.3,
      filter: { type: "bandpass", freq: 520, Q: 1.9, sweepTo: 330, sweepT: dur },
    });
    engine.tone(d, {
      wave: "sawtooth", freq: f0 * 1.007, sweepTo: f0 * drop, dur, gain: 0.07, attack: 0.09,
      filter: { type: "bandpass", freq: 1150, Q: 3, sweepTo: 760, sweepT: dur },
    });
    engine.burst(d, { dur, gain: 0.05, attack: 0.1, curve: "lin", filters: [{ type: "bandpass", freq: 900, Q: 0.7, sweepTo: 500, sweepT: dur }] });
  },
  sizzle(pos) {                              // zombie burning in the sun
    const d = go(0.5, "sfx", pos);
    if (!d) return;
    engine.burst(d, { dur: 0.4, gain: 0.2, attack: 0.02, curve: "lin", type: "crackle", filters: [{ type: "highpass", freq: 1300, Q: 0.7 }] });
    engine.burst(d, { dur: 0.3, gain: 0.08, filters: [{ type: "bandpass", freq: 3200, Q: 0.8 }] });
  },

  // ---- UI ----
  uiClick() {
    const d = go(0.08, "ui");
    if (!d) return;
    engine.burst(d, { dur: 0.018, gain: 0.2, filters: [{ type: "bandpass", freq: 1350, Q: 2.2 }] });
    engine.tone(d, { freq: 1900, dur: 0.03, gain: 0.05 });
  },
  uiSlot() {                                 // inventory slot tick (very quiet)
    const d = go(0.06, "ui");
    if (d) engine.burst(d, { dur: 0.014, gain: 0.13, filters: [{ type: "bandpass", freq: 900, Q: 2 }] });
  },
};
