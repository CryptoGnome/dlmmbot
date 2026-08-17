/**
 * Which scenes fire today, and for how long.
 *
 * The daily variety the brief asks for comes from here, not from the scenes:
 * a beat only earns its seconds if the day actually produced it. No standout
 * trade -> no trade beat. Nothing shipped -> no changelog beat. Duration is
 * derived from the plan so the render is always as long as the day deserves,
 * and never longer than X's 30s sweet spot.
 */
export interface Daily {
  day: string;
  dayNumber: number;
  version: string | null;
  balance: { total: number; wallet: number; open: number; rent: number; usd: number; solUsd: number };
  today: { pnl: number; pct: number | null; closes: number; entries: number; scanned: number };
  allTime: { pnl: number; closes: number; winRate: number | null };
  best: { symbol: string; pnl: number; reason: string } | null;
  worst: { symbol: string; pnl: number; reason: string } | null;
  reasons: Array<{ reason: string; n: number; pnl: number }>;
  releases: Array<{ tag: string; title: string }>;
  open: Array<{ symbol: string; sleeve: string; status: string; pnl: number }>;
  errors24h: number;
}

export type SceneId =
  | "title" | "headline" | "funnel" | "trade" | "positions" | "analytics" | "shipped" | "outro";

export interface Beat { id: SceneId; seconds: number }

/** A standout trade is worth a beat; noise is not. */
const NOTABLE_SOL = 0.01;
export const MAX_SECONDS = 30;

export function planScenes(d: Daily): Beat[] {
  const beats: Beat[] = [
    { id: "title", seconds: 2.5 },
    { id: "headline", seconds: 5 },
    { id: "funnel", seconds: 4 },
  ];

  if (d.best && d.best.pnl >= NOTABLE_SOL) beats.push({ id: "trade", seconds: 4 });
  if (d.open.length > 0) beats.push({ id: "positions", seconds: 3.5 });
  if (d.today.closes > 0) beats.push({ id: "analytics", seconds: 4.5 });
  if (d.releases.length > 0) beats.push({ id: "shipped", seconds: 4 });

  beats.push({ id: "outro", seconds: 2.5 });

  // Never exceed 30s: shave the flexible middle beats proportionally rather
  // than dropping one, so a busy day still shows everything it earned.
  const total = beats.reduce((s, b) => s + b.seconds, 0);
  if (total <= MAX_SECONDS) return beats;
  const fixed = beats.filter((b) => b.id === "title" || b.id === "outro");
  const flex = beats.filter((b) => b.id !== "title" && b.id !== "outro");
  const fixedSecs = fixed.reduce((s, b) => s + b.seconds, 0);
  const budget = MAX_SECONDS - fixedSecs;
  const flexTotal = flex.reduce((s, b) => s + b.seconds, 0);
  const k = budget / flexTotal;
  return beats.map((b) =>
    b.id === "title" || b.id === "outro" ? b : { ...b, seconds: Math.max(2, b.seconds * k) },
  );
}

export const totalFrames = (beats: Beat[], fps: number) =>
  beats.reduce((s, b) => s + Math.round(b.seconds * fps), 0);
