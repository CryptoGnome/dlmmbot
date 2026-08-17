import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadSans } from "@remotion/google-fonts/IBMPlexSans";

/**
 * Design tokens copied verbatim from the dashboard's own stylesheet
 * (dashboard/src/index.css @theme). Do not eyeball these — the first cut used
 * hand-picked near-blacks and greys and every one of them was slightly off,
 * which read as "not quite our site" on screen. If the dashboard's palette
 * changes, change it here too.
 */
export const C = {
  bg: "#0D0D0D",
  panel: "#141414",
  grid: "#2A2A2A",
  fg: "#FFFFFF",
  muted: "#A3A3A3",
  dim: "#6B6B6B",
  accent: "#1E90FF",
  sol: "#B56BFF",
  green: "#00FF85",   // --color-ok
  hover: "#FF0099",
  warn: "#FFB020",
  red: "#FF4D6A",     // --color-danger
} as const;

// Loaded at module scope so every frame renders with the faces already
// resolved — a font arriving mid-render produces frames with fallback metrics.
const mono = loadMono();
const sans = loadSans();

/**
 * Font roles follow the site: body/labels are mono, while headings and the big
 * stat numbers are sans (`h1, h2, .font-display` in index.css). Using mono for
 * everything was the other reason the video read as off-brand.
 */
export const MONO = `${mono.fontFamily}, ui-monospace, 'SF Mono', Menlo, monospace`;
export const SANS = `${sans.fontFamily}, ui-sans-serif, system-ui, sans-serif`;

/** Panels on the site are square-cornered; matching that matters more than it sounds. */
export const PANEL_RADIUS = 0;

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
