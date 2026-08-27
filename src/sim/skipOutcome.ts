import type { Database } from "better-sqlite3";
import { fetchBars, type Bar } from "./postExit.js";

/**
 * What a token did AFTER the scanner rejected it.
 *
 * `decisions.outcome_backfill_json` was declared in the initial schema with the
 * comment "filled later: what the token did after" and then never written — 0
 * of 218,328 rows on the live book. Without it, judging a gate means asking
 * whether the tokens it blocked would have paid, and the only answer available
 * is "the rows are gone". This fills the column.
 *
 * Two things make the naive version useless:
 *
 *  1. VOLUME. 93% of skip rows are one gate (`fee_tvl_24h`, 203k rows) logged
 *     once per pool per sweep. Backfilling per row would be ~200k API calls to
 *     re-fetch the same handful of price paths. We collapse to EPISODES —
 *     one (mint, pool, gate) per `EPISODE_BUCKET_S` — and anchor on the first
 *     sweep of each. A token blocked for six straight hours is one fetch.
 *
 *  2. EVICTION. Skip rows are pruned, and the size ceiling has been evicting
 *     them at ~30 hours on the live book, far inside the 30-day age window. A
 *     result written here would be deleted before anyone read it, so
 *     `pruneHistory` now spares rows that carry one (db.ts).
 *
 * We store the raw path — peak, trough, close, how much of it traded below the
 * skip price — and NOT verdicts like "would have hit P0". Thresholds move;
 * measurements should not have to be re-fetched when they do.
 */

/**
 * One backfill per (mint, pool, gate) per this many seconds.
 *
 * Bucketed on a fixed epoch, so a blockade longer than the bucket is split into
 * several episodes rather than collapsing into one. That is the intent: Pistacio
 * was rejected for 21 straight hours, and a single anchor at hour 0 would
 * describe none of hours 6-21.
 */
export const EPISODE_BUCKET_S = 6 * 3600;
/** `fetchBars` tops out at 100 minute bars per call; leave room for the anchor. */
export const MAX_WINDOW_MIN = 90;
/** A first bar further than this from the skip is not a usable anchor price. */
const MAX_ANCHOR_LAG_S = 600;

export type SkipStatus = "ok" | "too_recent" | "no_bars" | "no_anchor" | "error";

export interface SkipCandidate {
  /** decisions.id of the episode's first sweep — the row the result lands on. */
  id: number;
  mint: string;
  pool: string;
  failedGate: string;
  ts: number;
  /** Sweeps in this episode — 330 blocked reads very differently from 2. */
  sweeps: number;
  bestScore: number | null;
}

export interface SkipOutcome {
  v: 1;
  status: SkipStatus;
  windowMin: number;
  fetchedTs: number;
  sweeps: number;
  bestScore: number | null;
  /** Null unless status is "ok". */
  skipPrice: number | null;
  peakPct: number | null;
  troughPct: number | null;
  closePct: number | null;
  bars: number;
  /** Bars whose low traded under the skip price — traversal a below-spot LP would have seen. */
  barsBelowSkip: number | null;
  /** Seconds between the skip and the first bar used as the anchor. */
  anchorLagS: number | null;
}

/**
 * Episodes whose window has elapsed and that carry no result yet.
 *
 * `MIN(id)` is the episode's first sweep: `decisions.id` is AUTOINCREMENT and
 * the table is append-only, so id order is ts order. `HAVING` drops episodes
 * where any row already has a result, which is what makes a re-run resumable.
 */
export function pendingSkips(
  db: Database, windowMin: number, refetch: boolean, limit: number, nowTs: number,
  gate: string | null = null,
): SkipCandidate[] {
  const cutoff = nowTs - windowMin * 60;
  // The gate filter belongs in SQL, not after LIMIT: one gate is 93% of the
  // table, so a post-hoc filter spends the whole limit on `fee_tvl_24h` and
  // returns two rows for the gate you asked about.
  return db.prepare(`
    SELECT MIN(id) AS id, mint, pool, failed_gate AS failedGate, MIN(ts) AS ts,
           COUNT(*) AS sweeps, MAX(score) AS bestScore
      FROM decisions
     WHERE action = 'skipped' AND failed_gate IS NOT NULL AND pool IS NOT NULL
       AND ts <= ? AND (? IS NULL OR failed_gate = ?)
     GROUP BY mint, pool, failed_gate, ts / ${EPISODE_BUCKET_S}
    HAVING ? = 1 OR SUM(CASE WHEN outcome_backfill_json IS NOT NULL THEN 1 ELSE 0 END) = 0
     ORDER BY ts DESC
     LIMIT ?
  `).all(cutoff, gate, gate, refetch ? 1 : 0, limit) as SkipCandidate[];
}

/** Reduce the forward bars to the path stats, anchored on the first bar's open. */
export function summarize(
  c: SkipCandidate, bars: Bar[], windowMin: number, fetchedTs: number,
): SkipOutcome {
  const base = {
    v: 1 as const, windowMin, fetchedTs, sweeps: c.sweeps, bestScore: c.bestScore,
    skipPrice: null, peakPct: null, troughPct: null, closePct: null,
    barsBelowSkip: null, anchorLagS: null,
  };
  const fwd = bars.filter((b) => b.ts >= c.ts);
  if (!fwd.length) return { ...base, status: "no_bars", bars: 0 };

  const first = fwd[0]!;
  const anchorLagS = first.ts - c.ts;
  // A pool that stopped trading for an hour after the skip leaves a first bar
  // whose open is a different market than the one we rejected. Keep the row so
  // a wider window can retry it, but do not pretend the anchor is the skip.
  if (anchorLagS > MAX_ANCHOR_LAG_S)
    return { ...base, status: "no_anchor", bars: fwd.length, anchorLagS };

  const skipPrice = first.open;
  if (!(skipPrice > 0)) return { ...base, status: "no_anchor", bars: fwd.length, anchorLagS };

  const pct = (v: number) => ((v / skipPrice - 1) * 100);
  return {
    ...base,
    status: "ok",
    skipPrice,
    peakPct: pct(Math.max(...fwd.map((b) => b.high))),
    troughPct: pct(Math.min(...fwd.map((b) => b.low))),
    closePct: pct(fwd[fwd.length - 1]!.close),
    bars: fwd.length,
    barsBelowSkip: fwd.filter((b) => b.low < skipPrice).length,
    anchorLagS,
  };
}

/** Write the result onto the episode's anchor row. */
export function storeOutcome(db: Database, id: number, o: SkipOutcome): void {
  db.prepare("UPDATE decisions SET outcome_backfill_json = ? WHERE id = ?")
    .run(JSON.stringify(o), id);
}

/**
 * Fetch and store one episode. `too_recent` is written like any other status so
 * the next run can tell "not yet" from "never tried" without re-fetching.
 */
export async function backfillSkip(
  db: Database, c: SkipCandidate, windowMin: number, nowTs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<SkipOutcome> {
  const endTs = c.ts + windowMin * 60;
  const fetchedTs = nowTs;
  const base = {
    v: 1 as const, windowMin, fetchedTs, sweeps: c.sweeps, bestScore: c.bestScore,
    skipPrice: null, peakPct: null, troughPct: null, closePct: null,
    bars: 0, barsBelowSkip: null, anchorLagS: null,
  };
  if (endTs > nowTs) {
    const o: SkipOutcome = { ...base, status: "too_recent" };
    storeOutcome(db, c.id, o);
    return o;
  }
  let bars: Bar[] | null;
  try {
    bars = await fetchBars(c.pool, endTs, windowMin + 5, fetchImpl);
  } catch {
    const o: SkipOutcome = { ...base, status: "error" };
    storeOutcome(db, c.id, o);
    return o;
  }
  const o = bars?.length
    ? summarize(c, bars, windowMin, fetchedTs)
    : ({ ...base, status: bars === null ? "error" : "no_bars" } as SkipOutcome);
  storeOutcome(db, c.id, o);
  return o;
}
