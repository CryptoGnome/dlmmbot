import { openDb, REALIZED_PNL_SQL } from "../db/db.js";
import type { CohortFilter, SimMark, Trace, TraceFlag } from "./types.js";

/**
 * Turn a farmer.db into replayable position traces.
 *
 * Age at entry comes from `tokens.first_seen` — our scanner's first sight of the
 * mint. The `pools` table looks like the natural source and is NOT: joined by
 * address it returns nulls for every closed position's pool (2026-08-20), so
 * every position silently lands in an "unknown age" bucket.
 */

interface PositionRow {
  id: number; symbol: string | null; token_mint: string; pool: string;
  entry_ts: number; exit_ts: number; entry_price: number; entry_sol: number;
  min_bin_id: number; max_bin_id: number; ever_in_range: number;
  exit_reason: string | null; pnl: number | null;
  close_return_sol: number | null; recovered_sol: number | null;
  tok_first: number | null;
}

interface MarkRow {
  ts: number; active_bin_id: number | null; price: number | null;
  value_sol: number | null; value_frac: number | null;
  unclaimed_fees_sol: number | null; in_range: number | null;
  tvl_usd: number | null; vol_30m_usd: number | null; fee_tvl_30m_pct: number | null;
  pool_age_s: number | null; fees_claimed_cum_sol: number | null;
}

/** Exit reasons the mark-replay ladder cannot reproduce (no TVL/fee/volume in marks). */
const UNREPLAYABLE = ["P0_safety", "P2_rotation", "manual", "escape_rebalance"];

function buildMarks(rows: MarkRow[], minBin: number, maxBin: number): SimMark[] {
  const width = maxBin - minBin;
  let cum = 0, prevUnclaimed = 0;
  return rows.map((r) => {
    // Unclaimed fees reset to ~0 on every claim, so the running total is the
    // sum of increases. A claim between two polls is invisible either way;
    // this is the same accumulator the ledger's fees_measured_sol lands on.
    const unclaimed = r.unclaimed_fees_sol ?? 0;
    if (unclaimed > prevUnclaimed) cum += unclaimed - prevUnclaimed;
    prevUnclaimed = unclaimed;
    const bin = r.active_bin_id;
    const depthFrac = bin == null || width <= 0 ? null : (bin - minBin) / width;
    return {
      ts: r.ts,
      binId: bin,
      price: r.price ?? 0,
      valueSol: r.value_sol ?? 0,
      valueFrac: r.value_frac ?? 1,
      cumFeesSol: cum,
      unclaimedSol: unclaimed,
      inRange: r.in_range === 1,
      belowRange: bin != null && bin < minBin,
      aboveRange: bin != null && bin > maxBin,
      depthFrac,
      tvlUsd: r.tvl_usd, vol30mUsd: r.vol_30m_usd, feeTvl30mPct: r.fee_tvl_30m_pct,
      poolAgeS: r.pool_age_s, claimedCumSol: r.fees_claimed_cum_sol,
    };
  });
}

/**
 * Quality flags. `marks_end_zero_but_recovered` is the expensive one: on
 * 2026-08-20 a mid-band exit rule scored +0.94 SOL across 39 positions and
 * 0.81 of that came from Niles #63 alone, whose marks end at value 0 (the
 * position was emptied) while the real close recovered 0.60 SOL through the
 * residual sweep. Any counterfactual "exit earlier" on that row compares a
 * live position against a zero and books the difference as profit.
 */
function flagsFor(p: PositionRow, marks: SimMark[]): TraceFlag[] {
  const flags: TraceFlag[] = [];
  if (marks.length < 8) flags.push("few_marks");
  if (p.max_bin_id <= p.min_bin_id) flags.push("no_bins");
  const last = marks[marks.length - 1];
  const recovered = (p.recovered_sol ?? 0) + (p.close_return_sol ?? 0);
  if (last && last.valueSol <= 0.001 && recovered > 0.02) flags.push("marks_end_zero_but_recovered");
  if (marks.length >= 2) {
    const span = marks[marks.length - 1]!.ts - marks[0]!.ts;
    const life = p.exit_ts - p.entry_ts;
    if (life > 600 && span < life * 0.5) flags.push("sparse_coverage");
  }
  if (UNREPLAYABLE.some((r) => (p.exit_reason ?? "").startsWith(r))) flags.push("unreplayable_exit");
  return flags;
}

export function loadTraces(dbPath: string, book: string): Trace[] {
  const db = openDb(dbPath);
  try {
    const rows = db.prepare(`
      SELECT p.id, p.symbol, p.token_mint, p.pool, p.entry_ts, p.exit_ts, p.entry_price,
             p.entry_sol, p.min_bin_id, p.max_bin_id, p.ever_in_range, p.exit_reason,
             p.close_return_sol, p.recovered_sol,
             (${REALIZED_PNL_SQL}) AS pnl,
             t.first_seen AS tok_first
        FROM positions p
        LEFT JOIN tokens t ON t.mint = p.token_mint
       WHERE p.mode = 'live' AND p.exit_ts IS NOT NULL
       ORDER BY p.id
    `).all() as PositionRow[];
    const markStmt = db.prepare(`
      SELECT ts, active_bin_id, price, value_sol, value_frac, unclaimed_fees_sol, in_range,
             tvl_usd, vol_30m_usd, fee_tvl_30m_pct, pool_age_s, fees_claimed_cum_sol
        FROM position_marks WHERE position_id = ? ORDER BY ts
    `);
    // Sleeve comes from the entry decision, bound per position rather than as a
    // correlated subquery: SQLite will not resolve an outer column inside a
    // subquery's ORDER BY, which is exactly how `risk/sleeve.ts` reads it too.
    const sleeveStmt = db.prepare(`
      SELECT json_extract(features_json, '$.sleeve') AS sleeve FROM decisions
       WHERE mint = ? AND pool = ? AND action = 'entered' AND ts BETWEEN ? AND ?
       ORDER BY ABS(ts - ?) LIMIT 1
    `);
    return rows.map((p) => {
      const marks = buildMarks(markStmt.all(p.id) as MarkRow[], p.min_bin_id, p.max_bin_id);
      const tag = (sleeveStmt.get(p.token_mint, p.pool, p.entry_ts - 300, p.entry_ts + 300, p.entry_ts) as
        { sleeve: string | null } | undefined)?.sleeve;
      const sleeve = tag === "majors" || tag === "micro" ? tag : "meme";
      return {
        id: p.id, book, symbol: p.symbol ?? "?", mint: p.token_mint, pool: p.pool,
        sleeve, entryTs: p.entry_ts, exitTs: p.exit_ts, entryPrice: p.entry_price,
        entrySol: p.entry_sol, minBinId: p.min_bin_id, maxBinId: p.max_bin_id,
        everInRange: p.ever_in_range === 1,
        actualPnl: p.pnl ?? 0, actualReason: p.exit_reason ?? "unknown",
        ageMin: p.tok_first != null ? (p.entry_ts - p.tok_first) / 60 : null,
        marks, flags: flagsFor(p, marks),
      } satisfies Trace;
    });
  } finally {
    db.close();
  }
}

export function applyCohort(traces: Trace[], f: CohortFilter): Trace[] {
  const minMarks = f.minMarks ?? 8;
  return traces.filter((t) => {
    if (t.marks.length < minMarks) return false;
    if (!f.includeFlagged && t.flags.some((x) => x !== "unreplayable_exit")) return false;
    if (f.sleeve && !f.sleeve.includes(t.sleeve)) return false;
    if (f.book && !f.book.includes(t.book)) return false;
    if (f.sinceTs != null && t.exitTs < f.sinceTs) return false;
    if (f.ageMaxMin != null && (t.ageMin == null || t.ageMin >= f.ageMaxMin)) return false;
    if (f.ageMinMin != null && (t.ageMin == null || t.ageMin < f.ageMinMin)) return false;
    return true;
  });
}

/**
 * What the cohort filter dropped and why, so a thin run is never silent.
 * Quality drops and filter drops are counted separately: a trace excluded by
 * `--since` is not a data-quality problem, and reporting it as one would make
 * every filtered run look like the ledger is full of unusable rows.
 */
export function cohortSummary(all: Trace[], kept: Trace[], f: CohortFilter = {}): string {
  const keptSet = new Set(kept);
  const minMarks = f.minMarks ?? 8;
  const byFlag = new Map<string, number>();
  let filtered = 0;
  for (const t of all) {
    if (keptSet.has(t)) continue;
    const quality = t.flags.filter((x) => x !== "unreplayable_exit");
    if (t.marks.length < minMarks) byFlag.set("too_few_marks", (byFlag.get("too_few_marks") ?? 0) + 1);
    else if (!f.includeFlagged && quality.length) {
      for (const fl of quality) byFlag.set(fl, (byFlag.get(fl) ?? 0) + 1);
    } else filtered++;
  }
  const quality = [...byFlag.entries()].map(([k, v]) => `${k}=${v}`).join(" ");
  const parts = [`${kept.length} traces kept`];
  if (quality) parts.push(`${[...byFlag.values()].reduce((a, b) => a + b, 0)} unusable (${quality})`);
  if (filtered) parts.push(`${filtered} outside the cohort filters`);
  const unreplayable = kept.filter((t) => t.flags.includes("unreplayable_exit")).length;
  if (unreplayable) parts.push(`${unreplayable} kept but exited by a rule the replay cannot reproduce`);
  return parts.join(", ");
}

/**
 * Share of the cohort whose marks carry pool health (TVL / volume / fee rate).
 * Recording started in v0.19.1, so this climbs from zero as positions close.
 * Until it is high, P0 `tvl_drain` and P2 decay stay out of the replay and
 * every run says so rather than quietly pretending those exits do not exist.
 */
export function poolMetricCoverage(traces: Trace[]): { withMetrics: number; total: number } {
  const withMetrics = traces.filter((t) => t.marks.some((m) => m.tvlUsd != null)).length;
  return { withMetrics, total: traces.length };
}
