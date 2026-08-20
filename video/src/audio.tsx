import React from "react";
import { Audio, Sequence, interpolate, staticFile, useVideoConfig } from "remotion";
import type { Beat, Daily, SceneId } from "./plan";

/**
 * The video's sound, scheduled off the same beat plan as the scenes so it
 * adapts to whatever today's video contains. Design rule: no sound repeats
 * back-to-back — each beat has its own voice, and the data picks variants:
 *
 *   title      power-on chime
 *   dashboard  camera shutter (it IS a screenshot)
 *   headline   coin blip (green day) / low thud (red day), after the whoosh
 *   trend      arpeggio riser or faller — direction = sign of all-time PnL
 *   funnel     accelerating counter whir, synced to the count-up animation
 *   trade      coin cascade (the beat only exists on a notable win)
 *   positions  one UI pip per card — pip-hi for a green card, pip-lo for red
 *   analytics  same pip language, one per exit-reason card, quieter
 *   shipped    one keystroke per release line; a bell if zero errors open
 *   outro      resolving chord — major on a green day, minor on red
 *
 * Transitions: whoosh-low into the headline on a red day, whoosh-up into
 * trade/shipped (good news), plain whoosh otherwise. All files synthesized by
 * scripts/sfx.mjs; a missing file renders silent rather than failing.
 * In-scene frame offsets mirror the delay= constants in scenes/Scenes.tsx.
 */

interface Cue { src: string; frame: number; vol: number; durS?: number }

function cuesFor(id: SceneId, start: number, d: Daily): Cue[] {
  const red = d.today.pnl < 0;
  switch (id) {
    case "title":
      return [{ src: "chime.wav", frame: start + 6, vol: 0.4 }];
    case "dashboard":
      return [{ src: "shutter.wav", frame: start + 8, vol: 0.4 }];
    case "headline":
      return [{ src: red ? "thud.wav" : "blip.wav", frame: start + 10, vol: 0.55 }];
    case "trend":
      return [{ src: d.allTime.pnl >= 0 ? "riser.wav" : "faller.wav", frame: start + 10, vol: 0.4 }];
    case "funnel":
      return [{ src: "counter.wav", frame: start + 6, vol: 0.32, durS: 1.4 }];
    case "trade":
      return [{ src: "coins.wav", frame: start + 8, vol: 0.5 }];
    case "positions":
      return d.open.slice(0, 4).map((p, i) => ({
        src: p.pnl >= 0 ? "pip-hi.wav" : "pip-lo.wav", frame: start + 10 + i * 6, vol: 0.32,
      }));
    case "analytics":
      return d.reasons.slice(0, 4).map((r, i) => ({
        src: r.pnl >= 0 ? "pip-hi.wav" : "pip-lo.wav", frame: start + 10 + i * 6, vol: 0.22,
      }));
    case "shipped": {
      const keys: Cue[] = d.releases.slice(0, 3).map((_, i) => ({
        src: "type.wav", frame: start + 20 + i * 8, vol: 0.42,
      }));
      if (d.errors24h === 0) keys.push({ src: "ding.wav", frame: start + 50, vol: 0.35 });
      return keys;
    }
    case "outro":
      return [{ src: red ? "resolve-minor.wav" : "resolve-major.wav", frame: start + 8, vol: 0.42, durS: 1.9 }];
    default:
      return [];
  }
}

function whooshInto(id: SceneId, red: boolean): string {
  if (id === "headline") return red ? "whoosh-low.wav" : "whoosh-up.wav";
  if (id === "trade" || id === "shipped") return "whoosh-up.wav";
  return "whoosh.wav";
}

export const AudioTrack: React.FC<{ beats: Beat[]; daily: Daily }> = ({ beats, daily }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const red = daily.today.pnl < 0;

  const starts: number[] = [];
  let acc = 0;
  for (const b of beats) { starts.push(acc); acc += Math.round(b.seconds * fps); }

  const cues: Cue[] = beats.flatMap((b, i) => cuesFor(b.id, starts[i], daily));
  const whooshes = beats.slice(1).map((b, i) => ({
    src: whooshInto(b.id, red),
    frame: Math.max(0, starts[i + 1] - Math.round(0.12 * fps)),
  }));

  return (
    <>
      <Audio
        loop
        src={staticFile(red ? "sfx/bed-red.wav" : "sfx/bed-green.wav")}
        volume={(f) =>
          interpolate(
            f,
            [0, Math.round(0.8 * fps), durationInFrames - Math.round(1.5 * fps), durationInFrames - 1],
            [0, 0.16, 0.16, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          )
        }
      />
      {whooshes.map((w, i) => (
        <Sequence key={`wh-${i}`} from={w.frame} durationInFrames={Math.round(0.5 * fps)} layout="none">
          <Audio src={staticFile(`sfx/${w.src}`)} volume={0.4} />
        </Sequence>
      ))}
      {cues.map((c, i) => (
        <Sequence
          key={`cue-${i}`}
          from={c.frame}
          durationInFrames={Math.round((c.durS ?? 0.8) * fps)}
          layout="none"
        >
          <Audio src={staticFile(`sfx/${c.src}`)} volume={c.vol} />
        </Sequence>
      ))}
    </>
  );
};
