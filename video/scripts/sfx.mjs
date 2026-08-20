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
