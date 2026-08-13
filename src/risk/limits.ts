import { config } from "../config.js";
import { getDb, now, REALIZED_PNL_SQL } from "../db/db.js";
import { sleeveAtEntry } from "./sleeve.js";

// STRATEGY.md §5 — sizing, portfolio limits, circuit breaker, regime filter.

export interface Bankroll {
  walletSol: number;      // total SOL in the wallet
  bankedSol: number;      // house-money ledger, excluded from deployable
  deployedSol: number;    // sum of open position entry values
  deployableSol: number;  // what new entries may draw from
  effectiveSlots: number; // min(max_positions, floor(deployable / min_position))
}

export function computeBankroll(walletSol: number): Bankroll {
  const s = config().sizing;
  const db = getDb();

  const banked = (db.prepare(
    "SELECT COALESCE(SUM(CASE kind WHEN 'bank' THEN sol ELSE -sol END), 0) AS b FROM ledger"
  ).get() as { b: number }).b;

  const deployed = (db.prepare(
    "SELECT COALESCE(SUM(entry_sol), 0) AS d FROM positions WHERE state IN ('pending','open','closing')"
  ).get() as { d: number }).d;

  const reserve = s.reserve_sol + walletSol * (s.reserve_pct / 100);
  const deployable = Math.max(0, walletSol - reserve - banked - deployed);
  return {
    walletSol,
    bankedSol: banked,
    deployedSol: deployed,
    deployableSol: deployable,
    effectiveSlots: Math.min(s.max_positions, Math.floor((deployable + deployed) / s.min_position_sol)),
  };
}

// ---- Kelly criterion sizing (§5) ----
// f* = p − q/b  where p = win rate, q = 1−p, b = avgWin/avgLoss (return odds).
// Estimated from our OWN rolling closed-position ledger; scaled by
// kelly_fraction (half-Kelly default). Estimation error makes over-betting
// catastrophic (long-run growth goes negative past full Kelly), so the
// fraction, the per-position cap, and the negative-edge brake all bias small.

export interface KellyStats {
  samples: number;
  winRate: number | null;
  avgWinFrac: number | null;   // mean positive return, fraction of entry
  avgLossFrac: number | null;  // mean |negative return|
  fullKelly: number | null;    // f*
  appliedFraction: number;     // per-position fraction of wallet actually used
  regime: "cold_start" | "kelly" | "negative_edge";
}

export function kellyStats(): KellyStats {
  const s = config().sizing;
  // follow_chain_id IS NULL: follow-mode legs keep their own ledger (the
  // follow_chains table) — a different entry distribution polluting this
  // estimator was the same mistake STRATEGY §10 forbids for majors mode.
  const raw = getDb().prepare(
    `SELECT token_mint, pool, entry_ts, (${REALIZED_PNL_SQL}) / entry_sol AS ret
     FROM positions
     WHERE exit_ts IS NOT NULL AND entry_sol > 0 AND follow_chain_id IS NULL
     ORDER BY exit_ts DESC LIMIT ?`
  ).all(s.kelly_lookback * 3) as Array<{ token_mint: string; pool: string; entry_ts: number; ret: number }>;
  const rows = raw.filter((r) =>
    sleeveAtEntry({ tokenMint: r.token_mint, poolAddress: r.pool, entryTs: r.entry_ts }) !== "majors"
  ).slice(0, s.kelly_lookback);

  const n = rows.length;
  if (!s.kelly_enabled || n < s.kelly_min_samples) {
    return {
      samples: n, winRate: null, avgWinFrac: null, avgLossFrac: null,
      fullKelly: null, appliedFraction: s.kelly_cold_start_frac, regime: "cold_start",
    };
  }

  const wins = rows.filter((r) => r.ret > 0).map((r) => r.ret);
  const losses = rows.filter((r) => r.ret <= 0).map((r) => -r.ret);
  const p = wins.length / n;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;

  // Degenerate ledgers: all wins -> no loss estimate, cap at max; all losses -> zero.
  if (avgLoss === 0) {
    return { samples: n, winRate: p, avgWinFrac: avgWin, avgLossFrac: 0, fullKelly: null, appliedFraction: s.kelly_max_position_frac, regime: "kelly" };
  }
  if (avgWin === 0) {
    return { samples: n, winRate: p, avgWinFrac: 0, avgLossFrac: avgLoss, fullKelly: 0, appliedFraction: 0, regime: "negative_edge" };
  }

  const b = avgWin / avgLoss;
  const fullKelly = p - (1 - p) / b;
  const applied = Math.min(Math.max(fullKelly * s.kelly_fraction, 0), s.kelly_max_position_frac);
  return {
    samples: n, winRate: p, avgWinFrac: avgWin, avgLossFrac: avgLoss, fullKelly,
    appliedFraction: applied,
    regime: fullKelly <= 0 ? "negative_edge" : "kelly",
  };
}

/** Kelly-based position size with score tilt (§5); 0 = don't enter. */
export function positionSize(bankroll: Bankroll, score: number): number {
  const s = config().sizing;
  if (bankroll.effectiveSlots < 1) return 0;
  const mult = score >= 85 ? s.score_mult_high : score >= 70 ? s.score_mult_mid : score >= 60 ? s.score_mult_low : 0;
  if (mult === 0) return 0;

  let base: number;
  if (s.kelly_enabled) {
    const k = kellyStats();
    if (k.regime === "negative_edge" && s.kelly_block_negative) return 0;
    base = bankroll.walletSol * k.appliedFraction;
    // Small-bankroll floor: below min_position_sol fees can't beat tx+rent
    // overhead, so the floor wins over strict Kelly (logged via decisions).
    base = Math.max(base, s.min_position_sol);
  } else {
    base = (bankroll.deployableSol + bankroll.deployedSol) / bankroll.effectiveSlots;
  }

  const size = Math.min(
    base * mult,
    bankroll.walletSol * s.kelly_max_position_frac >= s.min_position_sol
      ? bankroll.walletSol * s.kelly_max_position_frac
      : s.min_position_sol,
    bankroll.deployableSol
  );
  return size >= s.min_position_sol ? size : 0;
}

export function openPositionCount(): number {
  return (getDb().prepare(
    "SELECT COUNT(*) AS c FROM positions WHERE state IN ('pending','open','closing')"
  ).get() as { c: number }).c;
}

export function tokenExposureSol(mint: string): number {
  return (getDb().prepare(
    "SELECT COALESCE(SUM(entry_sol),0) AS s FROM positions WHERE token_mint = ? AND state IN ('pending','open','closing')"
  ).get(mint) as { s: number }).s;
}

/** Circuit breaker: realized loss over rolling 24h vs bankroll (§5). */
export function circuitBreakerTripped(walletSol: number): boolean {
  const s = config().sizing;
  const dayAgo = now() - 86_400;
  // Measured wallet delta, not the notional mark. The mark omits rent, gas and
  // swap slippage, so it read 08-08 as -0.026 SOL on a day the wallet gained
  // +0.097 — a breaker steering on that is not measuring the thing it protects
  // against. Rows predating the measured columns fall back to the old formula.
  const realized = (getDb().prepare(
    `SELECT COALESCE(SUM(${REALIZED_PNL_SQL}), 0) AS pnl
     FROM positions WHERE exit_ts IS NOT NULL AND exit_ts > ?`
  ).get(dayAgo) as { pnl: number }).pnl;
  return realized < 0 && Math.abs(realized) > walletSol * (s.circuit_daily_loss_pct / 100);
}

/**
 * Cluster brake: N hard exits (P0/P1) inside a window pauses new entries.
 * Wallet-% breaker missed Aug 12 (−0.159 on a ~24 SOL book); this fires on
 * the loss *pattern* before the dollar threshold.
 *
 * Operator clear: meta `cluster_brake_cleared_at` = unix seconds. Hard exits
 * at or before that ts are ignored (future P0/P1 still trip normally).
 */
export function clusterBrakeTripped(): { count: number; remainingMin: number } | null {
  const s = config().sizing;
  if (!s.cluster_brake_exits || s.cluster_brake_exits <= 0) return null;
  const windowS = (s.cluster_brake_window_h || 6) * 3600;
  const pauseS = (s.cluster_brake_pause_h || 6) * 3600;
  const clearedRaw = getDb().prepare(
    "SELECT value FROM meta WHERE key='cluster_brake_cleared_at'"
  ).get() as { value: string } | undefined;
  const clearedAt = clearedRaw ? Number(clearedRaw.value) : 0;
  const since = Math.max(now() - windowS, Number.isFinite(clearedAt) ? clearedAt : 0);
  const rows = getDb().prepare(
    `SELECT exit_ts FROM positions
     WHERE exit_reason IN ('P0_safety','P1_stop') AND exit_ts IS NOT NULL AND exit_ts > ?
     ORDER BY exit_ts DESC`
  ).all(since) as Array<{ exit_ts: number }>;
  if (rows.length < s.cluster_brake_exits) return null;
  // Pause measured from the Nth-most-recent hard exit (the one that tripped).
  const tripTs = rows[s.cluster_brake_exits - 1]!.exit_ts;
  const elapsed = now() - tripTs;
  if (elapsed >= pauseS) return null;
  return { count: rows.length, remainingMin: Math.ceil((pauseS - elapsed) / 60) };
}

/** Regime filter (§5): scale factor for new-entry sizing from SOL 24h move. */
export function regimeFactor(sol24hChangePct: number): number {
  const s = config().sizing;
  if (!s.regime_filter) return 1;
  if (sol24hChangePct <= s.regime_sol_24h_pause_pct) return 0;   // pause new entries
  if (sol24hChangePct <= s.regime_sol_24h_halve_pct) return 0.5; // halve sizes
  return 1;
}
