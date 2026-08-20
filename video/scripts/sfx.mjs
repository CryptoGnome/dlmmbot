/**
 * Synthesize the video's sounds into public/sfx/ — no downloaded assets, no
 * licensing, byte-identical on every run (no randomness; the noise source is
 * a fixed LCG). Chiptune palette on purpose: it matches the pixel mascot.
 *
 *   whoosh.wav     beat transition — filtered noise sweep, ~0.35s
 *   blip.wav       win stinger — square-wave coin arpeggio, ~0.28s
 *   thud.wav       red-day stinger — low sine drop, ~0.45s
 *   bed-green.wav  8s seamless music loop, A major pentatonic
 *   bed-red.wav    8s seamless music loop, A minor
 *
 * Output is gitignored (like shots/ and icons/) and rebuilt by `npm run daily`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "sfx");
fs.mkdirSync(OUT, { recursive: true });

const SR = 44100;

function writeWav(name, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`[sfx] ${name} (${(n / SR).toFixed(2)}s)`);
}

/** Deterministic noise — Math.random would break byte-identical builds. */
function lcg(seed = 1) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

// ---- whoosh: noise through a falling one-pole lowpass, symmetric envelope ----
{
  const dur = 0.35, n = Math.round(SR * dur), rand = lcg(7);
  const out = new Float64Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const cutoff = 5500 * Math.pow(0.06, t) + 220;           // 5.7k -> ~550Hz
    const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SR);
    lp += a * (rand() - lp);
    out[i] = lp * Math.sin(Math.PI * t) ** 1.5 * 0.9;        // swell in, out
  }
  writeWav("whoosh.wav", out);
}

// ---- blip: square-wave coin arpeggio (C6 E6 G6 C7), fast decay per note ----
{
  const notes = [1046.5, 1318.5, 1568.0, 2093.0], noteDur = 0.07;
  const n = Math.round(SR * noteDur * notes.length);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const k = Math.min(notes.length - 1, Math.floor(t / noteDur));
    const tn = t - k * noteDur;
    const sq = Math.sign(Math.sin(2 * Math.PI * notes[k] * t)) || 1;
    out[i] = sq * Math.exp(-tn * 34) * 0.32;
  }
  writeWav("blip.wav", out);
}

// ---- thud: sine dropping 150 -> 48Hz with a touch of second harmonic ----
{
  const dur = 0.45, n = Math.round(SR * dur);
  const out = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 150 * Math.pow(48 / 150, t / dur);
    phase += (2 * Math.PI * f) / SR;
    out[i] = (Math.sin(phase) + 0.25 * Math.sin(2 * phase)) * Math.exp(-t * 7) * 0.85;
  }
  writeWav("thud.wav", out);
}

// ---- music beds: 8s seamless loops @120bpm — triangle arp + sine bass ----
// Tails are cut at note boundaries, so the loop point is silent-safe.
function bed(name, chords) {
  const dur = 8, n = SR * dur, out = new Float64Array(n);
  const beat = 0.5;                                           // 120bpm, 16 beats
  const tri = (f, t) => 2 * Math.abs(2 * ((f * t) % 1) - 1) - 1;
  for (let b = 0; b < 16; b++) {
    const chord = chords[Math.floor(b / 4)];
    // bass: root every other beat, soft attack so it doesn't knock
    if (b % 2 === 0) {
      const start = Math.round(b * beat * SR), len = Math.round(beat * 1.8 * SR);
      for (let i = 0; i < len && start + i < n; i++) {
        const t = i / SR;
        const env = Math.min(1, t / 0.04) * Math.exp(-t * 2.2);
        out[start + i] += Math.sin(2 * Math.PI * (chord[0] / 2) * t) * env * 0.30;
      }
    }
    // arp: two eighth-notes per beat cycling chord tones an octave up
    for (let e = 0; e < 2; e++) {
      const idx = (b * 2 + e) % chord.length;
      const f = chord[idx] * 2;
      const start = Math.round((b + e / 2) * beat * SR), len = Math.round(0.22 * SR);
      for (let i = 0; i < len && start + i < n; i++) {
        const t = i / SR;
        const env = Math.min(1, t / 0.012) * Math.exp(-t * 9);
        out[start + i] += tri(f, t) * env * 0.16;
      }
    }
  }
  // gentle master lowpass to sit under the voice of the visuals
  let lp = 0;
  const a = 1 - Math.exp((-2 * Math.PI * 2400) / SR);
  for (let i = 0; i < n; i++) { lp += a * (out[i] - lp); out[i] = lp; }
  writeWav(name, out);
}
const A = 220, Cs = 277.18, C = 261.63, D = 293.66, E = 329.63, F = 349.23, G = 392.0, B = 246.94;
bed("bed-green.wav", [[A, Cs, E, G * 1.0], [D, F * 1.008, A, D * 2], [A, Cs, E, A * 2], [E, G, B, E * 2]].map((c, i) => (i === 1 ? [D, 370.0, A, D * 2] : c))); // A - D(F#) - A - E : major
bed("bed-red.wav", [[A, C, E, A * 2], [F, A, C, F * 2], [C, E, G, C * 2], [E, G, B, E * 2]]);   // Am - F - C - E

// ============================ per-beat sound kit ============================
// One voice per scene, so the video never plays the same sound twice in a row.
// Same rules as above: pure synthesis, fixed seeds, byte-identical builds.

const sine = (f, t) => Math.sin(2 * Math.PI * f * t);
const sq = (f, t) => Math.sign(Math.sin(2 * Math.PI * f * t)) || 1;
const tri2 = (f, t) => 2 * Math.abs(2 * ((f * t) % 1) - 1) - 1;

/** mix helper: render notes [{f, at, dur, amp, wave, decay, attack}] into one buffer */
function renderNotes(totalS, notes, wave = tri2) {
  const n = Math.round(SR * totalS), out = new Float64Array(n);
  for (const nt of notes) {
    const start = Math.round(nt.at * SR), len = Math.round((nt.dur ?? 0.2) * SR);
    const w = nt.wave ?? wave, atk = nt.attack ?? 0.008, dec = nt.decay ?? 10;
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / SR;
      out[start + i] += w(nt.f, t) * Math.min(1, t / atk) * Math.exp(-t * dec) * (nt.amp ?? 0.3);
    }
  }
  return out;
}

// whoosh-up: the existing whoosh reversed — filter opens instead of closing
{
  const dur = 0.35, n = Math.round(SR * dur), rand = lcg(11);
  const out = new Float64Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const cutoff = 300 + 5200 * Math.pow(t, 2.2);
    const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SR);
    lp += a * (rand() - lp);
    out[i] = lp * Math.sin(Math.PI * t) ** 1.5 * 0.9;
  }
  writeWav("whoosh-up.wav", out);
}

// whoosh-low: darker, slower — the transition into a red headline
{
  const dur = 0.45, n = Math.round(SR * dur), rand = lcg(13);
  const out = new Float64Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const cutoff = 1600 * Math.pow(0.05, t) + 90;
    const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SR);
    lp += a * (rand() - lp);
    out[i] = lp * Math.sin(Math.PI * t) ** 1.2 * 1.1;
  }
  writeWav("whoosh-low.wav", out);
}

// chime: two-note power-on for the title card (A5 -> E6, bell-ish)
writeWav("chime.wav", renderNotes(0.7, [
  { f: 880, at: 0, dur: 0.5, amp: 0.22, decay: 6, wave: (f, t) => sine(f, t) + 0.3 * sine(2 * f, t) },
  { f: 1318.5, at: 0.11, dur: 0.55, amp: 0.20, decay: 5, wave: (f, t) => sine(f, t) + 0.3 * sine(2 * f, t) },
]));

// shutter: two high-passed noise ticks — the dashboard screenshot beat
{
  const dur = 0.16, n = Math.round(SR * dur), rand = lcg(17);
  const out = new Float64Array(n);
  let lp = 0;
  const a = 1 - Math.exp((-2 * Math.PI * 1200) / SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const raw = rand();
    lp += a * (raw - lp);
    const hp = raw - lp; // crude highpass
    const inTick = (t < 0.012) || (t > 0.07 && t < 0.088);
    out[i] = inTick ? hp * 0.8 : 0;
  }
  writeWav("shutter.wav", out);
}

// riser / faller: 5-note arpeggio for the equity trend — direction is the data
{
  const up = [220, 277.18, 329.63, 440, 554.37];          // A major up
  const down = [440, 392, 329.63, 261.63, 220];           // A minor down
  const mk = (seq) => renderNotes(0.75, seq.map((f, i) => ({ f: f * 2, at: i * 0.11, dur: 0.28, amp: 0.16, decay: 9 })));
  writeWav("riser.wav", mk(up));
  writeWav("faller.wav", mk(down));
}

// counter: accelerating tick whir, exactly 40 frames @30fps = 1.333s — synced
// to the funnel's count-up animation (useCountUp dur=40)
{
  const dur = 40 / 30, n = Math.round(SR * dur), rand = lcg(23);
  const out = new Float64Array(n);
  let t = 0.0;
  while (t < dur - 0.02) {
    const prog = t / dur;
    const start = Math.round(t * SR);
    for (let i = 0; i < Math.round(0.004 * SR); i++) {
      out[start + i] += (rand() * 0.5 + 0.5 * sine(2100, i / SR)) * Math.exp(-i / SR * 900) * 0.5;
    }
    t += 0.085 - 0.062 * prog; // gap shrinks 85ms -> 23ms
  }
  writeWav("counter.wav", out);
}

// coins: 5-note ascending cascade — the standout-trade beat
writeWav("coins.wav", renderNotes(0.5, [1046.5, 1318.5, 1568, 2093, 2637].map((f, i) => ({ f, at: i * 0.075, dur: 0.12, amp: 0.16, decay: 26, wave: sq }))));

// pip-hi / pip-lo: tiny UI ticks for cards — pitch says green or red
writeWav("pip-hi.wav", renderNotes(0.12, [{ f: 1320, at: 0, dur: 0.09, amp: 0.22, decay: 40, wave: sq }]));
writeWav("pip-lo.wav", renderNotes(0.14, [{ f: 620, at: 0, dur: 0.11, amp: 0.22, decay: 32, wave: sq }]));

// type: keystroke — one per release line on the shipped beat
{
  const dur = 0.07, n = Math.round(SR * dur), rand = lcg(29);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = (rand() * 0.6 + 0.4 * sine(190, t)) * Math.exp(-t * 160) * 0.7;
  }
  writeWav("type.wav", out);
}

// ding: zero-errors bell on the shipped beat
writeWav("ding.wav", renderNotes(0.6, [{ f: 1568, at: 0, dur: 0.55, amp: 0.2, decay: 6, wave: (f, t) => sine(f, t) + 0.25 * sine(2.76 * f, t) }]));

// resolve: the outro chord — major on a green day, minor on red
{
  const pad = (fs) => renderNotes(1.8, fs.map((f) => ({ f, at: 0, dur: 1.7, amp: 0.11, attack: 0.09, decay: 2.2, wave: (fq, t) => 0.6 * tri2(fq, t) + 0.4 * sine(fq, t) })));
  writeWav("resolve-major.wav", pad([220, 277.18, 329.63, 440]));
  writeWav("resolve-minor.wav", pad([220, 261.63, 329.63, 440]));
}
