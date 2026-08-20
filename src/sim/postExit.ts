import type { Database } from "better-sqlite3";

/**
 * Post-exit price paths, backfilled from GeckoTerminal.
 *
 * A position's `position_marks` stop the moment it closes, so the backtester
 * can compare exiting EARLIER against what happened, but has nothing to say
 * about holding LONGER — which is the half of the question that keeps coming
 * up ("did that safety exit cut a recovery?"). These bars fill that gap.
 *
 * Two rules make the data trustworthy:
 *
 * 1. **Calibrate before use.** GeckoTerminal is not our price feed. Every
 *    fetch overlaps the minutes BEFORE the exit, where we have our own recorded
 *    marks, and the ratio between them is stored. Around 1.0 means the same
 *    convention (SOL per token); a tight non-unit ratio still works as a scale
 *    factor; a noisy one means the series is not comparable and the position is
 *    marked `miscalibrated` rather than quietly used.
 * 2. **Say when there is no data.** A position whose exit is younger than the
 *    window, or whose pool has no bars, is recorded as such. Silence must not
 *    read as "nothing happened after we sold".
 */

const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
/** Minutes of pre-exit overlap fetched for calibration. */
export const OVERLAP_MIN = 20;
/** GeckoTerminal returns at most 100 minute bars per call. */
const MAX_BARS = 100;

export type BackfillStatus =
  | "ok" | "too_recent" | "no_bars" | "no_overlap" | "miscalibrated" | "error";

export interface Bar { ts: number; open: number; high: number; low: number; close: number }

export interface BackfillResult {
  positionId: number;
  status: BackfillStatus;
  bars: number;
  calibRatio: number | null;
  calibN: number;
  detail?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GeckoTerminal minute bars ending at `beforeTs`, with 429 back-off. */
export async function fetchBars(
  pool: string, beforeTs: number, limit: number,
  fetchImpl: typeof fetch = fetch, attempt = 0,
): Promise<Bar[] | null> {
  const url = `${GT}/pools/${pool}/ohlcv/minute?before_timestamp=${beforeTs}` +
    `&limit=${Math.min(limit, MAX_BARS)}&currency=token&token=base`;
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (res.status === 429) {
    if (attempt >= 2) return null;
    await sleep(15_000);
    return fetchBars(pool, beforeTs, limit, fetchImpl, attempt + 1);
  }
  if (!res.ok) return null;
  const json = await res.json() as { data?: { attributes?: { ohlcv_list?: number[][] } } };
  const list = json?.data?.attributes?.ohlcv_list ?? [];
  return list
    .map((k) => ({ ts: k[0]!, open: k[1]!, high: k[2]!, low: k[3]!, close: k[4]! }))
    .filter((b) => Number.isFinite(b.ts) && Number.isFinite(b.close))
    .sort((a, b) => a.ts - b.ts);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Compare the bars against our own marks over the pre-exit overlap.
 * Returns the median ratio (ours ÷ theirs) and how tight it is; a spread wider
 * than 25% of the median means the two series are not measuring the same thing.
 */
export function calibrate(
  bars: Bar[], marks: Array<{ ts: number; price: number }>,
): { ratio: number | null; n: number; tight: boolean } {
  const ratios: number[] = [];
  for (const m of marks) {
    if (!(m.price > 0)) continue;
    // The bar covering this mark's minute.
    let bar: Bar | null = null;
    for (const b of bars) if (b.ts <= m.ts && m.ts < b.ts + 60) { bar = b; break; }
    if (!bar || !(bar.close > 0)) continue;
    ratios.push(m.price / bar.close);
  }
  if (ratios.length < 3) return { ratio: null, n: ratios.length, tight: false };
  const mid = median(ratios);
  const spread = median(ratios.map((r) => Math.abs(r - mid)));
  return { ratio: mid, n: ratios.length, tight: mid > 0 && spread / mid <= 0.25 };
}

interface Candidate {
  id: number; pool: string; exit_ts: number;
}

/** Closed positions still needing a backfill for this window. */
export function pending(db: Database, windowMin: number, refetch: boolean, limit: number): Candidate[] {
  const rows = db.prepare(`
    SELECT p.id, p.pool, p.exit_ts
      FROM positions p
      LEFT JOIN post_exit_backfill b ON b.position_id = p.id
     WHERE p.mode = 'live' AND p.exit_ts IS NOT NULL
       AND (? = 1 OR b.position_id IS NULL OR (b.status = 'too_recent' AND b.window_min <= ?))
     ORDER BY p.exit_ts DESC
     LIMIT ?
  `).all(refetch ? 1 : 0, windowMin, limit) as Candidate[];
  return rows;
}

export function storeResult(
  db: Database, positionId: number, windowMin: number, bars: Bar[], r: BackfillResult,
): void {
  const tx = db.transaction(() => {
    if (bars.length) {
      const ins = db.prepare(
        `INSERT OR REPLACE INTO post_exit_prices (position_id, ts, open, high, low, close)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const b of bars) ins.run(positionId, b.ts, b.open, b.high, b.low, b.close);
    }
    db.prepare(
      `INSERT OR REPLACE INTO post_exit_backfill
         (position_id, fetched_ts, window_min, bars, calib_ratio, calib_n, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(positionId, Math.floor(Date.now() / 1000), windowMin, r.bars, r.calibRatio, r.calibN, r.status);
  });
  tx();
}

/**
 * Backfill one position. Bars are stored even when calibration fails, so a
 * later run can re-judge them without paying for the fetch again.
 */
export async function backfillOne(
  db: Database, c: Candidate, windowMin: number,
  nowTs: number, fetchImpl: typeof fetch = fetch,
): Promise<BackfillResult> {
  const base: BackfillResult = { positionId: c.id, status: "ok", bars: 0, calibRatio: null, calibN: 0 };
  // Bars for the window do not exist yet — record it and let a later run retry.
  if (nowTs < c.exit_ts + windowMin * 60) {
    const r = { ...base, status: "too_recent" as const };
    storeResult(db, c.id, windowMin, [], r);
    return r;
  }
  const bars = await fetchBars(c.pool, c.exit_ts + windowMin * 60, windowMin + OVERLAP_MIN, fetchImpl);
  if (bars === null) {
    const r = { ...base, status: "error" as const, detail: "fetch failed" };
    storeResult(db, c.id, windowMin, [], r);
    return r;
  }
  if (!bars.length) {
    const r = { ...base, status: "no_bars" as const };
    storeResult(db, c.id, windowMin, [], r);
    return r;
  }
  const marks = db.prepare(
    `SELECT ts, price FROM position_marks
      WHERE position_id = ? AND price > 0 AND ts >= ? ORDER BY ts`
  ).all(c.id, c.exit_ts - OVERLAP_MIN * 60) as Array<{ ts: number; price: number }>;
  const cal = calibrate(bars, marks);
  const status: BackfillStatus = cal.ratio == null ? "no_overlap" : cal.tight ? "ok" : "miscalibrated";
  const r: BackfillResult = {
    positionId: c.id, status, bars: bars.length, calibRatio: cal.ratio, calibN: cal.n,
  };
  storeResult(db, c.id, windowMin, bars, r);
  return r;
}

// ---- reading it back ----

export interface PostExitPath {
  positionId: number;
  /** Bars after the exit, already scaled into our own price units. */
  after: Bar[];
  calibRatio: number;
}

export function loadPath(db: Database, positionId: number, exitTs: number): PostExitPath | null {
  const meta = db.prepare(
    "SELECT calib_ratio, status FROM post_exit_backfill WHERE position_id = ?"
  ).get(positionId) as { calib_ratio: number | null; status: string } | undefined;
  if (!meta || meta.status !== "ok" || meta.calib_ratio == null) return null;
  const k = meta.calib_ratio;
  const bars = db.prepare(
    "SELECT ts, open, high, low, close FROM post_exit_prices WHERE position_id = ? AND ts >= ? ORDER BY ts"
  ).all(positionId, exitTs) as Bar[];
  if (!bars.length) return null;
  return {
    positionId,
    calibRatio: k,
    after: bars.map((b) => ({
      ts: b.ts, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k,
    })),
  };
}

export interface Recovery {
  /** Highest price in the window, as a multiple of the price we sold at. */
  maxMult: number;
  /** Lowest price in the window, same basis — what staying in would have cost. */
  minMult: number;
  /** Price at the end of the window, same basis. */
  endMult: number;
  /** Minutes until the high, or null if the high was the first bar. */
  minutesToHigh: number | null;
  /** Did price get back to where we entered? The whole range sits below entry,
   *  so reaching it again means the position would have converted fully to SOL. */
  regainedEntry: boolean;
  bars: number;
}

/**
 * Model-free read of what happened after the exit. Deliberately no attempt to
 * price the LP position at future prices: that needs the bin-by-bin liquidity
 * and would turn a measurement into a model. Direction, extremes and whether
 * price came back to entry are enough to answer "did we cut this too early?".
 */
export function recovery(path: PostExitPath, exitPrice: number, entryPrice: number, windowMin: number): Recovery | null {
  if (!(exitPrice > 0)) return null;
  const start = path.after[0]!.ts;
  const inWindow = path.after.filter((b) => b.ts <= start + windowMin * 60);
  if (!inWindow.length) return null;
  const highs = inWindow.map((b) => b.high);
  const maxIdx = highs.indexOf(Math.max(...highs));
  const high = highs[maxIdx]!;
  return {
    maxMult: high / exitPrice,
    minMult: Math.min(...inWindow.map((b) => b.low)) / exitPrice,
    endMult: inWindow[inWindow.length - 1]!.close / exitPrice,
    minutesToHigh: maxIdx > 0 ? Math.round((inWindow[maxIdx]!.ts - start) / 60) : null,
    regainedEntry: entryPrice > 0 && high >= entryPrice,
    bars: inWindow.length,
  };
}
