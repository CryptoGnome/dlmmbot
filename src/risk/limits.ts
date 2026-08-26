import { config, currentMode } from "../config.js";
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

// Defaults live here as well as in config.toml on purpose: config() is a
// hot-reloaded raw TOML parse cast to Config, so an install whose volume
// config predates these keys reads `undefined`. Falling back to the *old*
// flat behaviour would leave exactly the operators this scaling exists for
// stuck on it, so the fallback is the new behaviour.
const DEFAULT_MIN_POSITION_PCT = 1.0;
const DEFAULT_MIN_POSITION_FLOOR_SOL = 0.05;
const DEFAULT_RESERVE_MAX_PCT = 25;

/**
 * Viability floor for one position, scaled to the bankroll (§5).
 *
 * A flat 0.3 SOL floor quietly switched the bot off below ~30 SOL. It is read
 * in four places that compound: `kellyWalletBase` floors the Kelly base at it,
 * `positionSize` rejects anything under it AND raises the 10%-of-wallet cap to
 * it, and `effectiveSlots` divides by it. So a 2 SOL wallet either never
 * entered at all (reserve → 0 deployable) or entered at 15% of equity with the
 * risk cap bypassed, and *no* bankroll under 20 SOL could take a 60-70 score,
 * because half of a base pinned to the floor is always below the floor.
 *
 * Scaling by equity fixes all four at once. The absolute floor is what per-
 * trade overhead demands: a fresh mint's token-account rent + fees measured
 * 0.00212 SOL, ~4% of 0.05 SOL — the point below which fees cannot plausibly
 * beat costs no matter how good the pool is.
 */
export function minPositionSol(equitySol: number): number {
  const s = config().sizing;
  const target = s.min_position_sol;
  const pct = s.min_position_pct ?? DEFAULT_MIN_POSITION_PCT;
  const hard = s.min_position_floor_sol ?? DEFAULT_MIN_POSITION_FLOOR_SOL;
  if (!(pct > 0) || !(equitySol > 0)) return target;
  // `min(hard, target)` — an operator who deliberately sets a target below the
  // hard floor gets their number, not a floor raised above it.
  return Math.max(Math.min(hard, target), Math.min(target, equitySol * (pct / 100)));
}

/** Re-entry floor (reused token account is cheaper); never above the entry floor. */
export function minReentrySol(equitySol: number): number {
  const s = config().sizing;
  return Math.min(s.min_reentry_sol ?? s.min_position_sol, minPositionSol(equitySol));
}

/**
 * Operational reserve, held back for rent and fees.
 *
 * The flat part is capped at a share of equity: `reserve_sol = 1.0` against a
 * 1 SOL wallet reserved the entire bankroll and produced zero deployable and
 * zero slots — the bot looked alive and could never enter. Capping leaves the
 * flat reserve untouched for any wallet at or above `reserve_sol / max_pct`
 * (4 SOL at the defaults), so existing books see no change.
 */
export function reserveSol(equitySol: number): number {
  const s = config().sizing;
  const maxPct = s.reserve_max_pct ?? DEFAULT_RESERVE_MAX_PCT;
  const flat = maxPct > 0 ? Math.min(s.reserve_sol, equitySol * (maxPct / 100)) : s.reserve_sol;
  return flat + equitySol * (s.reserve_pct / 100);
}

export function computeBankroll(walletSol: number): Bankroll {
  const s = config().sizing;
  const db = getDb();

  const banked = (db.prepare(
    "SELECT COALESCE(SUM(CASE kind WHEN 'bank' THEN sol ELSE -sol END), 0) AS b FROM ledger"
  ).get() as { b: number }).b;

  const deployed = (db.prepare(
    "SELECT COALESCE(SUM(entry_sol), 0) AS d FROM positions WHERE state IN ('pending','open','closing') AND mode = ?"
  ).get(currentMode()) as { d: number }).d;

  // Normalize to total equity: LiveExecutor.walletSol() is the FREE native
  // balance (deployed capital has already left the wallet), while paper's
  // virtual wallet is total equity. Without this, live subtracted `deployed`
  // twice — shrinking deployable and effectiveSlots — and Kelly's base
  // (walletSol × fraction) differed between the modes the promotion gate
  // exists to compare.
  const equity = currentMode() === "live" ? walletSol + deployed : walletSol;
  const reserve = reserveSol(equity);
  const deployable = Math.max(0, equity - reserve - banked - deployed);
  // Guard the divisor: a 0 floor (an operator disabling it) turned an empty
  // book into 0/0 = NaN, and `NaN < 1` is false — the slot check in
  // positionSize would have waved the entry through.
  const floor = minPositionSol(equity);
  return {
    walletSol: equity,
    bankedSol: banked,
    deployedSol: deployed,
    deployableSol: deployable,
    effectiveSlots: floor > 0
      ? Math.min(s.max_positions, Math.floor((deployable + deployed) / floor))
      : s.max_positions,
  };
}

export type FixedSleeve = "core" | "micro" | "majors" | "follow";

/** Global Kelly vs Fixed switch (default Kelly). */
export function sizingMode(): "kelly" | "fixed" {
  return config().sizing.mode === "fixed" ? "fixed" : "kelly";
}

/**
 * Fixed-mode size for one sleeve: exact SOL or % of deployable, then clamp to
 * deployable + max wallet frac. Returns 0 if below min_position_sol (no silent bump).
 */
export function fixedSleeveSize(
  sleeve: FixedSleeve,
  deployableSol: number,
  walletSol: number,
): number {
  const s = config().sizing;
  const unit = s[`fixed_${sleeve}_unit`];
  const raw = unit === "pct"
    ? deployableSol * (s[`fixed_${sleeve}_pct`] / 100)
    : s[`fixed_${sleeve}_sol`];
  const floor = minPositionSol(walletSol);
  if (!(raw > 0) || raw < floor) return 0;
  const maxByWallet = walletSol * s.kelly_max_position_frac;
  const cap = maxByWallet >= floor ? maxByWallet : floor;
  const size = Math.min(raw, deployableSol, cap);
  return size >= floor ? size : 0;
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
  // mode filter: paper fills must never drive live sizing (or vice versa) —
  // the shared promotion-flow DB makes cross-mode samples a real hazard.
  // REALIZED_PNL IS NOT NULL: unknown-exit rows (force-close, orphans) would
  // otherwise reach JS as ret=null, and `null <= 0` is true — a zero-loss
  // sample fabricated from a row whose PnL we explicitly don't know.
  const raw = getDb().prepare(
    `SELECT token_mint, pool, entry_ts, (${REALIZED_PNL_SQL}) / entry_sol AS ret
     FROM positions
     WHERE exit_ts IS NOT NULL AND entry_sol > 0 AND follow_chain_id IS NULL
       AND mode = ? AND (${REALIZED_PNL_SQL}) IS NOT NULL
     ORDER BY exit_ts DESC LIMIT ?`
  ).all(currentMode(), s.kelly_lookback * 3) as Array<{ token_mint: string; pool: string; entry_ts: number; ret: number }>;
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

/** Kelly-mode base for one sleeve before score tilt and wallet caps. */
export function kellySleeveBase(
  sleeve: FixedSleeve,
  deployableSol: number,
  kellyBase: number,
): number {
  const s = config().sizing;
  const unit = s[`kelly_${sleeve}_unit`];
  if (unit === "sol") return s[`kelly_${sleeve}_sol`];
  if (unit === "pct") return deployableSol * (s[`kelly_${sleeve}_pct`] / 100);
  return kellyBase * (s[`kelly_${sleeve}_mult`] ?? 1);
}

function kellyWalletBase(bankroll: Bankroll): number {
  const s = config().sizing;
  if (!s.kelly_enabled) {
    return (bankroll.deployableSol + bankroll.deployedSol) / bankroll.effectiveSlots;
  }
  const k = kellyStats();
  if (k.regime === "negative_edge" && s.kelly_block_negative) return 0;
  return Math.max(bankroll.walletSol * k.appliedFraction, minPositionSol(bankroll.walletSol));
}

/** Position size for meme core or micro; 0 = don't enter. */
export function positionSize(
  bankroll: Bankroll,
  score: number,
  sleeve: "core" | "micro" = "core",
): number {
  const s = config().sizing;
  if (bankroll.effectiveSlots < 1) return 0;
  const mult = score >= 85 ? s.score_mult_high : score >= 70 ? s.score_mult_mid : score >= 60 ? s.score_mult_low : 0;
  if (mult === 0) return 0;

  if (sizingMode() === "fixed") {
    return fixedSleeveSize(sleeve, bankroll.deployableSol, bankroll.walletSol);
  }

  const kellyBase = kellyWalletBase(bankroll);
  if (kellyBase <= 0) return 0;
  const base = kellySleeveBase(sleeve, bankroll.deployableSol, kellyBase);

  const floor = minPositionSol(bankroll.walletSol);
  const size = Math.min(
    base * mult,
    bankroll.walletSol * s.kelly_max_position_frac >= floor
      ? bankroll.walletSol * s.kelly_max_position_frac
      : floor,
    bankroll.deployableSol,
  );
  return size >= floor ? size : 0;
}

/**
 * Flat-sizing counterfactual — what `kelly_core_unit = "pct"` would have sized
 * this entry. **Measurement only**: nothing reads the result, `positionSize` is
 * untouched, and no caller may size from it. Gate 3 of SIZING-MODE-DECISION.md.
 *
 * The clamp below is deliberately DUPLICATED from `positionSize` rather than
 * extracted into a shared helper. Sizing is the most risk-critical path in the
 * repo; a refactor to serve a telemetry function could change what the bot
 * actually bets, while a duplicate that drifts can only mislabel a log line.
 * If `positionSize`'s clamp changes, change this too — the unit test pins them
 * together at equal base.
 *
 * `"pct"` and not `"sol"` because the hypothesis is "do not let recent outcomes
 * move the size", not "do not scale with the bankroll". Note the consequence:
 * a pct-of-deployable base shrinks as capital gets committed, so this arm is
 * flat with respect to the win-rate ESTIMATE, not constant in SOL.
 */
export function flatCounterfactualSol(
  bankroll: Bankroll,
  score: number,
  sleeve: "core" | "micro" = "core",
): number {
  const s = config().sizing;
  if (bankroll.effectiveSlots < 1) return 0;
  const mult = score >= 85 ? s.score_mult_high : score >= 70 ? s.score_mult_mid : score >= 60 ? s.score_mult_low : 0;
  if (mult === 0) return 0;

  const base = bankroll.deployableSol * (s[`kelly_${sleeve}_pct`] / 100);
  const floor = minPositionSol(bankroll.walletSol);
  const size = Math.min(
    base * mult,
    bankroll.walletSol * s.kelly_max_position_frac >= floor
      ? bankroll.walletSol * s.kelly_max_position_frac
      : floor,
    bankroll.deployableSol,
  );
  return size >= floor ? size : 0;
}

export function openPositionCount(): number {
  return (getDb().prepare(
    "SELECT COUNT(*) AS c FROM positions WHERE state IN ('pending','open','closing') AND mode = ?"
  ).get(currentMode()) as { c: number }).c;
}

export function tokenExposureSol(mint: string): number {
  return (getDb().prepare(
    "SELECT COALESCE(SUM(entry_sol),0) AS s FROM positions WHERE token_mint = ? AND state IN ('pending','open','closing') AND mode = ?"
  ).get(mint, currentMode()) as { s: number }).s;
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
     FROM positions WHERE exit_ts IS NOT NULL AND exit_ts > ? AND mode = ?`
  ).get(dayAgo, currentMode()) as { pnl: number }).pnl;
  return realized < 0 && Math.abs(realized) > walletSol * (s.circuit_daily_loss_pct / 100);
}

/**
 * Cluster brake: N *lossy* hard exits (P0/P1) inside a window pauses new entries.
 * Wallet-% breaker missed Aug 12 (−0.159 on a ~24 SOL book); this fires on
 * a loss *cluster* before the dollar threshold — not every safety exit.
 *
 * Counts only P0/P1 where realized / entry ≤ −cluster_brake_loss_pct
 * (successful dumps / near-flat empties do not trip the book).
 *
 * Operator clear: meta `cluster_brake_cleared_at` = unix seconds. Hard exits
 * at or before that ts are ignored (future lossy P0/P1 still trip normally).
 */
export function clusterBrakeTripped(): { count: number; remainingMin: number } | null {
  const s = config().sizing;
  if (!s.cluster_brake_exits || s.cluster_brake_exits <= 0) return null;
  const windowS = (s.cluster_brake_window_h || 6) * 3600;
  const pauseS = (s.cluster_brake_pause_h || 6) * 3600;
  const lossFrac = (s.cluster_brake_loss_pct ?? 10) / 100;
  const clearedRaw = getDb().prepare(
    "SELECT value FROM meta WHERE key='cluster_brake_cleared_at'"
  ).get() as { value: string } | undefined;
  const clearedAt = clearedRaw ? Number(clearedRaw.value) : 0;
  const since = Math.max(now() - windowS, Number.isFinite(clearedAt) ? clearedAt : 0);
  const rows = getDb().prepare(
    `SELECT exit_ts FROM positions
     WHERE exit_reason IN ('P0_safety','P1_stop') AND exit_ts IS NOT NULL AND exit_ts > ?
       AND entry_sol > 0 AND mode = ?
       AND (${REALIZED_PNL_SQL}) / entry_sol <= ?
     ORDER BY exit_ts DESC`
  ).all(since, currentMode(), -lossFrac) as Array<{ exit_ts: number }>;
  if (rows.length < s.cluster_brake_exits) return null;
  // Pause measured from the NEWEST exit. Anchoring on the Nth-most-recent
  // (oldest of the cluster) made the brake inert whenever pause_h < window_h:
  // four exits spread over 3h with a 2h pause gave elapsed >= pause at the
  // moment the 4th exit landed — no pause at all, in exactly the spread-out
  // dump the brake was added for after Aug 12.
  const tripTs = rows[0]!.exit_ts;
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
