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
  /** `icon` is a public/ path (icons/<mint>.png) or null when the fetch failed — render the ticker alone. */
  best: { symbol: string; icon?: string | null; pnl: number; reason: string } | null;
  worst: { symbol: string; icon?: string | null; pnl: number; reason: string } | null;
  reasons: Array<{ reason: string; n: number; pnl: number }>;
  releases: Array<{ tag: string; title: string }>;
  open: Array<{ symbol: string; mint?: string | null; icon?: string | null; sleeve: string; status: string; pnl: number }>;
  trend: {
    historyDays: number;
    /** `full` is false when the bot hasn't been running that long yet. */
    windows: Array<{ days: number; pnl: number; full: boolean }>;
    series: Array<{ day: string; pnl: number; cum: number }>;
  };
  errors24h: number;
}

export type SceneId =
  | "title" | "dashboard" | "headline" | "trend" | "funnel" | "trade"
  | "positions" | "analytics" | "shipped" | "outro";

export interface Beat { id: SceneId; seconds: number }

/** A standout trade is worth a beat; noise is not. */
const NOTABLE_SOL = 0.01;

/**
 * X's ceiling for this format. Not a target — a typical day lands near 45s and
 * should stay there. The 30s cap this started with forced the shave to squeeze
 * every beat to ~2.6s, which read as rushed; the room is for letting beats
 * breathe, not for padding the run time.
 */
export const MAX_SECONDS = 120;

export function planScenes(d: Daily): Beat[] {
  const beats: Beat[] = [
    { id: "title", seconds: 3 },
    // Early on purpose: show what the thing actually looks like before quoting
    // numbers at people who have never seen it.
    { id: "dashboard", seconds: 4.5 },
    { id: "headline", seconds: 6 },
    { id: "trend", seconds: 5.5 },
    { id: "funnel", seconds: 5 },
  ];

  if (d.best && d.best.pnl >= NOTABLE_SOL) beats.push({ id: "trade", seconds: 5 });
  if (d.open.length > 0) beats.push({ id: "positions", seconds: 4.5 });
  if (d.today.closes > 0) beats.push({ id: "analytics", seconds: 5 });
  if (d.releases.length > 0) beats.push({ id: "shipped", seconds: 4.5 });

  beats.push({ id: "outro", seconds: 3 });

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
