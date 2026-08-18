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
    defaultProps={{ daily: null as unknown as D, mascot: { open: false, close: false } }}
    calculateMetadata={async ({ abortSignal }) => {
      const res = await fetch(staticFile("daily.json"), { signal: abortSignal });
      const daily = (await res.json()) as D;
      // The mascot bookends are best-effort (scripts/mascot.mjs): probe for
      // each card so a failed or skipped generation degrades to the plain
      // title/outro instead of a broken <Img>.
      const probe = async (f: string) => {
        try { return (await fetch(staticFile(f), { method: "HEAD", signal: abortSignal })).ok; } catch { return false; }
      };
      const [open, close] = await Promise.all([probe("mascot-open.png"), probe("mascot-close.png")]);
      return { props: { daily, mascot: { open, close } }, durationInFrames: totalFrames(planScenes(daily), FPS) };
    }}
  />
);
