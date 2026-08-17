/**
 * Pull today's numbers from the live dashboard API into public/daily.json.
 *
 * The video is a pure function of this file, so a render is reproducible and
 * `npm run daily` is the whole pipeline. Nothing here talks to the chain — the
 * dashboard already reconciles the ledger (REALIZED_PNL_SQL) and we trust it.
 *
 *   DASH_URL    default https://dlmmbot-production.up.railway.app
 *   DASH_TOKEN  required
 *   DAY_ONE     first day of the challenge, YYYY-MM-DD (default 2026-08-14)
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "public", "daily.json");

const BASE = process.env.DASH_URL ?? "https://dlmmbot-production.up.railway.app";
const TOKEN = process.env.DASH_TOKEN;
const DAY_ONE = process.env.DAY_ONE ?? "2026-08-14";

if (!TOKEN) {
  console.error("DASH_TOKEN is required (the dashboard bearer token).");
  process.exit(1);
}

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
};

const [watch, hist] = await Promise.all([get("/api/watch"), get("/api/history")]);

// "Today" is the bot's own day boundary (UTC), matching how it buckets the ledger.
const today = new Date(watch.at).toISOString().slice(0, 10);
const dayNum = Math.floor((Date.parse(today) - Date.parse(DAY_ONE)) / 86_400_000) + 1;

const closes = (hist.ladder ?? []).filter((r) => r.at >= today);
const byPnl = [...closes].sort((a, b) => b.pnl - a.pnl);
const best = byPnl[0] ?? null;
const worst = byPnl[byPnl.length - 1] ?? null;
const activity = (hist.activity ?? []).find((d) => d.day === today) ?? {};
const equity = (hist.equity ?? []).find((d) => d.day === today) ?? {};
const head = hist.stats?.headline ?? {};

// Exit-reason mix drives the Analytics beat; only reasons that fired today.
const reasonLabel = {
  P0_safety: "Safety exit", P1_stop: "Stop loss", P2_rotation: "Rotation",
  P3_above: "Take-profit", P5_below: "Below range", escape: "Escape hatch", manual: "Manual",
};
const reasons = Object.entries(
  closes.reduce((a, r) => {
    a[r.exit_reason] = a[r.exit_reason] ?? { n: 0, pnl: 0 };
    a[r.exit_reason].n += 1;
    a[r.exit_reason].pnl += r.pnl;
    return a;
  }, {}),
).map(([k, v]) => ({ reason: reasonLabel[k] ?? k, n: v.n, pnl: round(v.pnl) }))
 .sort((a, b) => b.n - a.n);

// Releases shipped today — the "what we fixed" beat. Tag names + one-liners.
const releases = (watch.build?.releases ?? [])
  .filter((r) => (r.at ?? "").slice(0, 10) === today)
  .map((r) => ({ tag: r.tag, title: (r.name ?? "").replace(/^v[\d.]+\s*—\s*/, "") }));

const open = (watch.open ?? []).map((p) => ({
  symbol: p.symbol,
  sleeve: p.sleeve ?? "meme",
  status: p.range_status ?? p.mark?.status ?? "unknown",
  pnl: round(p.mark?.total_pnl_sol ?? 0),
}));

function round(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

/**
 * Realized PnL over trailing windows, from the daily equity series.
 *
 * `cum_sol` is cumulative, so a window is just the difference between its
 * endpoints — no re-summing, and it agrees with the dashboard by construction.
 * `full` says whether the bot has actually been running that long: on a 4-day-
 * old book "90 days" is the whole history, and the video should say so rather
 * than imply three months of track record.
 */
const equitySeries = (hist.equity ?? []).filter((e) => e.day <= today);
const historyDays = equitySeries.length;
const cumAt = (i) => Number(equitySeries[i]?.cum_sol ?? 0);
const latestCum = historyDays ? cumAt(historyDays - 1) : 0;

function window(days) {
  if (!historyDays) return { days, pnl: 0, full: false };
  const startIdx = historyDays - 1 - days;
  const base = startIdx >= 0 ? cumAt(startIdx) : 0;
  return { days, pnl: round(latestCum - base), full: startIdx >= 0 };
}

const trend = {
  historyDays,
  windows: [window(7), window(30), window(90)],
  // Daily realized PnL, oldest→newest — enough to draw a sparkline natively.
  series: equitySeries.map((e) => ({ day: e.day, pnl: round(e.sol), cum: round(e.cum_sol) })),
};

const daily = {
  generatedAt: new Date().toISOString(),
  day: today,
  dayNumber: dayNum,
  version: watch.build?.version ?? null,
  balance: {
    total: round(watch.balance?.total_sol),
    wallet: round(watch.balance?.wallet_sol),
    open: round(watch.balance?.deployed_sol),
    rent: round(watch.balance?.rent_in_flight_sol),
    usd: Math.round(watch.balance?.total_usd ?? 0),
    solUsd: Math.round(watch.balance?.sol_usd ?? 0),
  },
  today: {
    pnl: round(equity.sol),
    pct: equity.day_pct ?? null,
    closes: closes.length,
    entries: activity.entered ?? 0,
    scanned: activity.skipped ?? 0,
  },
  allTime: {
    pnl: round(head.pnl_sol),
    closes: head.closes ?? 0,
    winRate: head.win_rate ?? null,
  },
  best: best && { symbol: best.symbol, pnl: round(best.pnl), reason: reasonLabel[best.exit_reason] ?? best.exit_reason },
  worst: worst && { symbol: worst.symbol, pnl: round(worst.pnl), reason: reasonLabel[worst.exit_reason] ?? worst.exit_reason },
  reasons,
  releases,
  open,
  trend,
  errors24h: watch.error_stats?.count_24h ?? 0,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(daily, null, 2)}\n`);
console.log(`day ${dayNum} (${today}): ${daily.today.closes} closes, ${daily.today.pnl >= 0 ? "+" : ""}${daily.today.pnl} SOL, ${daily.releases.length} release(s)`);
console.log(`wrote ${OUT}`);
