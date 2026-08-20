import React from "react";
import { Audio, Sequence, interpolate, staticFile, useVideoConfig } from "remotion";
import type { Beat, Daily } from "./plan";

/**
 * The video's sound: a low music bed for the whole run, a whoosh on every
 * beat change, and one stinger on the headline — coin blip on a green day,
 * low thud on a red one. All synthesized by scripts/sfx.mjs; if the files
 * are missing (sfx step skipped), render silent rather than fail.
 *
 * Levels: the bed sits at ~0.16 so it reads as texture under the numbers,
 * not as a soundtrack; transitions and stingers peak around 0.5.
 */
export const AudioTrack: React.FC<{ beats: Beat[]; daily: Daily }> = ({ beats, daily }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const red = daily.today.pnl < 0;

  // Beat start frames; skip the whoosh into the outro's mascot card gently.
  const starts: number[] = [];
  let acc = 0;
  for (const b of beats) { starts.push(acc); acc += Math.round(b.seconds * fps); }

  const headlineIdx = beats.findIndex((b) => b.id === "headline");
  const headlineStart = headlineIdx >= 0 ? starts[headlineIdx] : null;

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
      {starts.slice(1).map((start, i) => (
        <Sequence
          key={`wh-${i}`}
          from={Math.max(0, start - Math.round(0.12 * fps))}
          durationInFrames={Math.round(0.4 * fps)}
          layout="none"
        >
          <Audio src={staticFile("sfx/whoosh.wav")} volume={0.45} />
        </Sequence>
      ))}
      {headlineStart != null && (
        <Sequence
          from={headlineStart + Math.round(0.35 * fps)}
          durationInFrames={Math.round(0.6 * fps)}
          layout="none"
        >
          <Audio src={staticFile(red ? "sfx/thud.wav" : "sfx/blip.wav")} volume={0.55} />
        </Sequence>
      )}
    </>
  );
};
