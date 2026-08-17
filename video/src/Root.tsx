import React from "react";
import { Composition, staticFile } from "remotion";
import { Daily } from "./Daily";
import { planScenes, totalFrames, type Daily as D } from "./plan";

const FPS = 30;

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Daily"
    component={Daily}
    // Placeholders — calculateMetadata replaces both from public/daily.json.
    durationInFrames={FPS * 28}
    fps={FPS}
    width={1920}
    height={1080}
    defaultProps={{ daily: null as unknown as D }}
    calculateMetadata={async ({ abortSignal }) => {
      const res = await fetch(staticFile("daily.json"), { signal: abortSignal });
      const daily = (await res.json()) as D;
      return { props: { daily }, durationInFrames: totalFrames(planScenes(daily), FPS) };
    }}
  />
);
