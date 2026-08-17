/** Brand lifted from the dashboard + dlmmbot.com so the video matches the product. */
export const C = {
  bg: "#07090B",
  panel: "#0D1114",
  grid: "#1B2227",
  fg: "#E6EDF3",
  dim: "#7D8590",
  muted: "#9BA6B0",
  green: "#00FF85",
  red: "#FF3B5C",
  blue: "#1E90FF",
  amber: "#FFB020",
} as const;

import { loadFont } from "@remotion/google-fonts/JetBrainsMono";

// Loaded at module scope so every frame renders with the face already resolved —
// a font that arrives mid-render produces a few frames of fallback metrics.
const { fontFamily } = loadFont();
export const MONO = `${fontFamily}, ui-monospace, 'SF Mono', Menlo, monospace`;

/** SOL with an explicit sign — the sign is the story in a PnL video. */
export function sol(n: number, dp = 3): string {
  const v = Number(n) || 0;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(dp)}`;
}

export function pct(n: number | null | undefined, dp = 1): string {
  if (n == null) return "—";
  return `${n >= 0 ? "+" : "−"}${Math.abs(n * 100).toFixed(dp)}%`;
}

export const tone = (n: number) => (n >= 0 ? C.green : C.red);

/** 119926 -> "119,926" */
export const commas = (n: number) => Math.round(n).toLocaleString("en-US");
