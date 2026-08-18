import React from "react";
import { Series, useVideoConfig } from "remotion";
import { SCENES } from "./scenes/Scenes";
import { planScenes, type Daily as D } from "./plan";

/** Composes today's beats back-to-back. Scene frames are relative to each Series.Sequence. */
export const Daily: React.FC<{ daily: D; mascot: { open: boolean; close: boolean } }> = ({ daily, mascot }) => {
  const { fps } = useVideoConfig();
  const beats = planScenes(daily);
  return (
    <Series>
      {beats.map((b, i) => {
        const Scene = SCENES[b.id];
        return (
          <Series.Sequence key={`${b.id}-${i}`} durationInFrames={Math.round(b.seconds * fps)}>
            <Scene d={daily} mascot={mascot} />
          </Series.Sequence>
        );
      })}
    </Series>
  );
};
