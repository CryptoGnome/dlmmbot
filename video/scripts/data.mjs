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
 *   PERIOD_DAYS 1 (default) = today's numbers; N>1 = a recap of the last N
 *               days ending today. Day-scoped figures (closes, PnL, releases)
 *               then aggregate over the window; the day number and balance
 *               are unchanged because they are points, not sums.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "public", "daily.json");

const BASE = process.env.DASH_URL ?? "https://dlmmbot-production.up.railway.app";
const TOKEN = process.env.DASH_TOKEN;
const DAY_ONE = process.env.DAY_ONE ?? "2026-08-14";
const PERIOD_DAYS = Math.max(1, Math.floor(Number(process.env.PERIOD_DAYS ?? 1)) || 1);

if (!TOKEN) {
  console.error("DASH_TOKEN is required (the dashboard bearer token).");
  process.exit(1);
}

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
};

// The history range only needs to cover the window; 30d is the API's widest
// day-bucketed range and the default, so a recap never asks for more.
const [watch, hist] = await Promise.all([get("/api/watch"), get(`/api/history?range=${PERIOD_DAYS <= 7 ? "7d" : "30d"}`)]);

/**
 * Token icons for the beats that feature a token (best trade, open positions).
 *
 * The dashboard already resolves and caches an icon URL per mint (token_meta
 * on /api/watch), so this costs no new API calls. But those URLs are IPFS
 * gateways and random CDNs — slow, flaky, one of them literally starts with
 * "Https://" — and a Remotion render must be deterministic, so each icon is
 * fetched ONCE here into public/icons/<mint>.<ext> and the video references
 * the local file. A fetch that fails just means no icon: the beat falls back
 * to the ticker alone, same best-effort rule as the mascot cards.
 */
const ICONS = resolve(HERE, "..", "public", "icons");
async function localIcon(mint) {
  const meta = watch.token_meta?.[mint];
  const url = (meta?.icon_url ?? "").trim();
  if (!url) return null;
  mkdirSync(ICONS, { recursive: true });
  // Reuse a previous day's fetch — icons don't change and IPFS is slow.
  for (const ext of ["png", "jpg", "webp", "gif"]) {
    if (existsSync(resolve(ICONS, `${mint}.${ext}`))) return `icons/${mint}.${ext}`;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch(url.replace(/^Https:/, "https:"), { signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("gif") ? "gif" : "jpg";
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) return null; // an error page, not an image
    writeFileSync(resolve(ICONS, `${mint}.${ext}`), buf);
    return `icons/${mint}.${ext}`;
  } catch {
    return null;
  }
}

// "Today" is the bot's own day boundary (UTC), matching how it buckets the ledger.
const today = new Date(watch.at).toISOString().slice(0, 10);
const dayNum = Math.floor((Date.parse(today) - Date.parse(DAY_ONE)) / 86_400_000) + 1;

// First day of the window, inclusive. PERIOD_DAYS=1 makes it today.
const since = new Date(Date.parse(today) - (PERIOD_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
const inWindow = (day) => day >= since && day <= today;
const period = PERIOD_DAYS > 1;

const closes = (hist.ladder ?? []).filter((r) => r.at >= since);
const byPnl = [...closes].sort((a, b) => b.pnl - a.pnl);
// A recap's standout is a TOKEN over the window, not one close: the ladder is
// capped at the last 40 closes, so "best close in 30 days" is not knowable
// from it, while stats.tokens_best spans the whole range.
const tokenPick = (row) => row && {
  symbol: row.symbol, mint: row.mint, pnl: row.pnl,
  exit_reason: `${row.n} trade${row.n === 1 ? "" : "s"}`,
  note: `${row.wins} won, ${row.losses} lost across ${row.n} trades`,
};
const best = period ? tokenPick(hist.stats?.tokens_best?.[0]) ?? null : byPnl[0] ?? null;
const worst = period ? tokenPick(hist.stats?.tokens_worst?.[0]) ?? null : byPnl[byPnl.length - 1] ?? null;
const sum = (rows, key) => rows.filter((d) => inWindow(d.day)).reduce((s, d) => s + (Number(d[key]) || 0), 0);
const activity = period
  ? { entered: sum(hist.activity ?? [], "entered"), skipped: sum(hist.activity ?? [], "skipped") }
  : (hist.activity ?? []).find((d) => d.day === today) ?? {};
const exitsIn = (hist.exits ?? []).filter((d) => inWindow(d.day));
const exitPnl = exitsIn.reduce((s, d) => s + (Number(d.pnl) || 0), 0);
const exitEntry = exitsIn.reduce((s, d) => s + (Number(d.entry_sol) || 0), 0);
const equity = period
  ? { sol: sum(hist.equity ?? [], "sol"), day_pct: exitEntry > 0 ? Math.round((exitPnl / exitEntry) * 1e6) / 1e6 : null }
  : (hist.equity ?? []).find((d) => d.day === today) ?? {};
const periodCloses = period ? exitsIn.reduce((s, d) => s + (Number(d.n) || 0), 0) : closes.length;
const head = hist.stats?.headline ?? {};

// Exit-reason mix drives the Analytics beat; only reasons that fired today.
const reasonLabel = {
  P0_safety: "Safety exit", P1_stop: "Stop loss", P2_rotation: "Rotation",
  P3_above: "Take-profit", P5_below: "Below range", escape: "Escape hatch", give_back: "Give-back stop", manual: "Manual",
};
// Over a window the API's by-reason table is the truth (the ladder is capped).
const reasons = (period
  ? (hist.exit_by_reason ?? []).map((r) => ({ reason: reasonLabel[r.reason] ?? r.reason, n: r.n, pnl: round(r.pnl) }))
  : Object.entries(
    closes.reduce((a, r) => {
      a[r.exit_reason] = a[r.exit_reason] ?? { n: 0, pnl: 0 };
      a[r.exit_reason].n += 1;
      a[r.exit_reason].pnl += r.pnl;
      return a;
    }, {}),
  ).map(([k, v]) => ({ reason: reasonLabel[k] ?? k, n: v.n, pnl: round(v.pnl) })))
 // A recap ranks by money moved so the rules that lost show beside the ones
 // that won; four most-frequent rules over 30 days were all green, which
 // read as cherry-picking on a flat book.
 .sort((a, b) => (period ? Math.abs(b.pnl) - Math.abs(a.pnl) : b.n - a.n));

// Releases shipped today — the "what we fixed" beat. Tag names + one-liners.
const releases = (watch.build?.releases ?? [])
  .filter((r) => inWindow((r.at ?? "").slice(0, 10)))
  .map((r) => ({ tag: r.tag, title: (r.name ?? "").replace(/^v[\d.]+\s*—\s*/, "") }));

const open = [];
for (const p of watch.open ?? []) {
  open.push({
    symbol: p.symbol,
    mint: p.mint ?? p.token_mint ?? null,
    icon: await localIcon(p.mint ?? p.token_mint),
    sleeve: p.sleeve ?? "meme",
    status: p.range_status ?? p.mark?.status ?? "unknown",
    pnl: round(p.mark?.total_pnl_sol ?? 0),
  });
}
const bestIcon = best ? await localIcon(best.mint) : null;
const worstIcon = worst ? await localIcon(worst.mint) : null;

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
  periodDays: PERIOD_DAYS,
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
    closes: periodCloses,
    entries: activity.entered ?? 0,
    scanned: activity.skipped ?? 0,
  },
  allTime: {
    pnl: round(head.pnl_sol),
    closes: head.closes ?? 0,
    winRate: head.win_rate ?? null,
  },
  best: best && { symbol: best.symbol, icon: bestIcon, pnl: round(best.pnl), reason: reasonLabel[best.exit_reason] ?? best.exit_reason, note: best.note ?? null },
  worst: worst && { symbol: worst.symbol, icon: worstIcon, pnl: round(worst.pnl), reason: reasonLabel[worst.exit_reason] ?? worst.exit_reason, note: worst.note ?? null },
  reasons,
  releases,
  open,
  trend,
  errors24h: watch.error_stats?.count_24h ?? 0,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(daily, null, 2)}\n`);
console.log(`day ${dayNum} (${today}${period ? `, last ${PERIOD_DAYS} days` : ""}): ${daily.today.closes} closes, ${daily.today.pnl >= 0 ? "+" : ""}${daily.today.pnl} SOL, ${daily.releases.length} release(s)`);
console.log(`wrote ${OUT}`);
