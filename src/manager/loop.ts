import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveBuildLabel } from "../buildLabel.js";
import { config, configToml, currentMode, isLive, onConfigChange, syncFarmerModeFromDisk,
  escapeDrawdownPct, ESCAPE_ARM_DRAWDOWN_PCT, ESCAPE_RECOVER_DRAWDOWN_PCT } from "../config.js";
import { mapGrouped } from "../concurrent.js";
import { reconcileLive } from "./reconcile.js";
import { alert, type AlertKind } from "../alerts.js";
import { blacklist, describeError, getDb, now, pruneHistory, recordConfigSnapshot, recordCreatorRug, recordDecision, REALIZED_PNL_SQL, logError, installProcessErrorHooks } from "../db/db.js";
import { RESIDUAL_SWEEP_MIN_SOL } from "../executor/executor.js";
import type { Executor } from "../executor/executor.js";
import { LiveExecutor } from "../executor/live.js";
import { executeProfitBurn, profitBurnSpendSol, accrueProfitBurn, readProfitBurnAccrued, writeProfitBurnAccrued, PROFIT_BURN } from "../executor/profitBurn.js";
import { PaperExecutor } from "../executor/paper.js";
import { rollupDaily } from "../pnl/rollup.js";
import { fetchSummary } from "../vetting/rugcheck.js";
import { planRange, planTrancheRange, depthReachable } from "../ranges/planner.js";
import { applyBinRentGate } from "../ranges/binRent.js";
import { fetchPool } from "../scanner/meteora.js";
import { fetchCandlesDeep } from "../scanner/candles.js";
import { trendingByMint } from "../scanner/gmgn.js";
import { feeMomentumPart, opportunityScore, structurePart, turnoverPart } from "../scanner/score.js";
import { scan } from "../scanner/scan.js";
import { flowFor, startSmartFlow } from "../scanner/smartflow.js";
import { armFollowChain, hasActiveFollowChain, onFollowLegClosed, tickFollowChains } from "./follow.js";
import { clearHolderWatch, holderCheck } from "./holderwatch.js";
import { sol24hChangePct, solUsdPrice } from "../market.js";
import { circuitBreakerTripped, clusterBrakeTripped, computeBankroll, flatCounterfactualSol, kellyStats, minPositionSol, minReentrySol, openPositionCount, positionSize, regimeFactor, sizingMode, tokenExposureSol } from "../risk/limits.js";
import { applyMicroSize, isMicroMcap, microPoolSharePct, microSleeveExposure } from "../risk/micro.js";
import { enterMajorsPositions } from "./majorsEntry.js";
import { manageForSleeve } from "../risk/majorsManage.js";
import { sleeveAtEntry } from "../risk/sleeve.js";
import type { Position } from "../types.js";
import { vetToken } from "../vetting/vet.js";

// STRATEGY.md §4 — P0–P5 state machine. Live: P0 (TVL/price/rugcheck + GMGN
// holder-watch), P1–P5, escape hatch, follow, micro/majors sleeves, residual
// sweep, heartbeat. Second tranche: dual-range BidAsk below primary (score gate).

function dataDir(): string {
  return process.env.FARMER_DB_PATH
    ? dirname(resolve(process.env.FARMER_DB_PATH))
    : resolve(process.cwd(), "data");
}

function controlPaths(kind: "PAUSE" | "HALT"): string[] {
  const envKey = kind === "PAUSE" ? "FARMER_PAUSE_PATH" : "FARMER_HALT_PATH";
  const primary = process.env[envKey] || resolve(dataDir(), kind);
  const legacy = resolve(process.cwd(), kind);
  return primary === legacy ? [primary] : [primary, legacy];
}

function controlPresent(kind: "PAUSE" | "HALT"): boolean {
  return controlPaths(kind).some((p) => existsSync(p));
}

const LOCK_FILE = resolve(dataDir(), "farmer.lock");
const BUSY_FILE = resolve(dataDir(), "busy.flag");

// Busy flag around executor-critical sections (multi-tx opens/closes). The
// auto-deploy watcher waits up to 120s for this file to vanish before
// `pm2 restart`, and our own SIGTERM handler drains it — a restart landing
// between a zap swap and the add-liquidity leg stranded capital on chain.
let busyDepth = 0;
async function withBusy<T>(fn: () => Promise<T>): Promise<T> {
  busyDepth++;
  if (busyDepth === 1) { try { writeFileSync(BUSY_FILE, String(process.pid)); } catch { /* best effort */ } }
  try {
    return await fn();
  } finally {
    busyDepth--;
    if (busyDepth === 0) { try { rmSync(BUSY_FILE, { force: true }); } catch { /* best effort */ } }
  }
}

// Residual sweep: retry-sell tokens stranded by failed zap-out swaps.
const RESIDUAL_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
// RESIDUAL_SWEEP_MIN_SOL is shared with the close path in executor.ts — the
// close must know the same floor to tell dust from a recoverable strand.
/** DB retention runs hourly; the pruned tables only matter at day granularity. */
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Prune the append-only tables and ALWAYS say what happened. The first version
 * only logged when it removed rows; on a one-day-old install the 30-day age
 * window removed nothing, printed nothing, and the volume filled to ENOSPC
 * overnight while the log looked healthy. Silence must never mean "fine" here.
 */
function runRetention(): void {
  const r = config().scanner;
  const pruned = pruneHistory({
    skippedDays: r.retain_skipped_days ?? 30,
    snapshotDays: r.retain_snapshots_days ?? 3,
    maxBytes: (r.db_max_mb ?? 200) * 1024 * 1024,
  });
  const mb = (b: number) => (b / 1048576).toFixed(1);
  console.log(
    `[farmer] retention: db ${mb(pruned.bytesBefore)}→${mb(pruned.bytesAfter)} MB, ` +
    `pruned ${pruned.decisions} skipped decisions + ${pruned.snapshots} snapshots` +
    (pruned.mode === "size" ? " (SIZE ceiling hit)" : pruned.mode === "age" ? " (age)" : " (nothing eligible)") +
    (pruned.vacuumed ? ", vacuumed" : "")
  );
}

// Per-position manager state. The four that decide an exit are write-through
// to the positions row (see hydrateTimers); the rest are telemetry or
// throttles and are cheap to rebuild.
const aboveRangeSince = new Map<number, number>();   // P3 sustain timer
const belowRangeSince = new Map<number, number>();   // P5 grace timer
const tvlHistory = new Map<number, Array<{ ts: number; tvl: number; price: number }>>(); // P0 TVL-drop window
const decayStreak = new Map<number, number>();        // P2 consecutive decay polls
const stopStreak = new Map<number, number>();         // P1 consecutive under-stop polls while below range
const feeOffsetLogged = new Set<number>();            // P1 fee-offset counterfactual logged once per position
const escapeShapeLogged = new Set<number>();          // escape-hatch shape disagreement logged once per position
const midBandSince = new Map<number, number>();       // young-exit telemetry: sustained below band midpoint
const midBandLogged = new Set<number>();              // young-exit telemetry logged once per position
const rugcheckLastCheck = new Map<number, number>();  // P0 rugcheck-flip throttle
const everInRange = new Set<number>();                // P3 win-vs-missed classification
const fellDeep = new Set<number>();                   // escape hatch armed (also persisted)
const peakPnl = new Map<number, number>();            // give-back telemetry: best fee-inclusive PnL (persisted)
const giveBackLogged = new Set<number>();             // give-back counterfactual logged once (persisted)

/** Positions whose timers have been read back from the DB this process. */
const hydrated = new Set<number>();

/**
 * Read a position exit timer set back out of the DB, once per process.
 *
 * These timers ARE the exit rules memory of "how long has this been true",
 * and holding them only in RAM meant every restart wiped them: a position 14
 * minutes into a 15-minute below-range grace got a fresh 15, a 3-of-4 stop
 * streak went back to 0, and the P0 drain window started empty. Railway
 * redeploys on every merge to main (12 restarts in the 29h of 2026-08-20/21),
 * so this was not a rare edge, and it is asymmetric: above range the position
 * is sitting in SOL and a late exit costs only opportunity, below range it is
 * 100% in a falling token and a late exit costs principal. follow_chains
 * already persists its streaks every tick for exactly this reason; the
 * manager own ladder did not.
 *
 * Rehydrated values are trusted as read. Every exit still re-checks its live
 * condition against the current mark before firing, so the worst a stale
 * timer can do is exit a position that is bad RIGHT NOW sooner than a fresh
 * timer would - the conservative direction for a bot that was blind.
 *
 * The P0 drain window is rebuilt from position_marks instead of a column of
 * its own: that table already records tvl_usd and price per mark, and the
 * window is pruned by timestamp, so a stale read cannot survive its own 10
 * minutes. See loadTvlWindow.
 */
function hydrateTimers(posId: number): void {
  if (hydrated.has(posId)) return;
  hydrated.add(posId);
  const row = getDb().prepare(
    "SELECT above_range_since AS a, below_range_since AS b, stop_streak AS s, decay_streak AS d," +
    " peak_pnl_sol AS p, give_back_logged AS g FROM positions WHERE id = ?"
  ).get(posId) as { a: number | null; b: number | null; s: number | null; d: number | null;
                    p: number | null; g: number | null } | undefined;
  if (!row) return;
  if (row.a != null) aboveRangeSince.set(posId, row.a);
  if (row.b != null) belowRangeSince.set(posId, row.b);
  if (row.s) stopStreak.set(posId, row.s);
  if (row.d) decayStreak.set(posId, row.d);
  if (row.p != null) peakPnl.set(posId, row.p);
  if (row.g) giveBackLogged.add(posId);
}

/** Column each persisted timer writes through to. */
const TIMER_COLUMN = new Map<Map<number, number>, string>([
  [aboveRangeSince, "above_range_since"],
  [belowRangeSince, "below_range_since"],
  [stopStreak, "stop_streak"],
  [decayStreak, "decay_streak"],
]);

/**
 * Set a timer and mirror it to the DB, but only when it actually moved: the
 * common tick is "still 0, still in range", and that one should cost no write.
 */
function setTimer(map: Map<number, number>, posId: number, value: number): void {
  if (map.get(posId) === value) return;
  map.set(posId, value);
  getDb().prepare(`UPDATE positions SET ${TIMER_COLUMN.get(map)!} = ? WHERE id = ?`).run(value, posId);
}

/** Streaks reset to 0, timestamps to NULL - the values hydrateTimers reads as "not running". */
function clearTimer(map: Map<number, number>, posId: number): void {
  if (!map.has(posId)) return;
  map.delete(posId);
  const col = TIMER_COLUMN.get(map)!;
  const empty = col.endsWith("_since") ? null : 0;
  getDb().prepare(`UPDATE positions SET ${col} = ? WHERE id = ?`).run(empty, posId);
}

/** Clear in-memory per-position timers for unit tests (ids reuse across memory DB resets). */
export function resetManagerStateForTests(): void {
  hydrated.clear();
  aboveRangeSince.clear();
  belowRangeSince.clear();
  tvlHistory.clear();
  decayStreak.clear();
  stopStreak.clear();
  feeOffsetLogged.clear();
  escapeShapeLogged.clear();
  midBandSince.clear();
  midBandLogged.clear();
  rugcheckLastCheck.clear();
  everInRange.clear();
  fellDeep.clear();
  peakPnl.clear();
  giveBackLogged.clear();
}

// Watchdog / breaker state.
let lastHealthyTick = Date.now();
let watchdogAlerted = false;
let probeFailures = 0;
let nextAlertAtMin = 0;
// ~30s fuse. Freezing entries is the one action that is strictly safe while
// blind: not entering costs a missed opportunity, whereas adding exposure you
// cannot manage is worse than holding exposure you cannot manage. It also
// targets the failure that has actually happened — the only two failed marks
// in the book sit inside an entry-retry storm (136 "tick error: Simulation
// failed", 30 x 429) hammering the same endpoint the marks needed. The bot
// rate-limited itself out of seeing its own position.
const PROBE_FAILURES_FREEZE_ENTRIES = 2;
let buildSha = "unknown";

/**
 * Liveness beacon for an OUT-OF-PROCESS watcher (deploy/heartbeat-check.cjs).
 * Every alert this bot sends originates inside the bot, so by construction none
 * of them can tell you the bot is gone — and "no Telegram messages" is
 * indistinguishable from a quiet market. Written last in the tick so a stale
 * timestamp means the tick is not completing, not merely that it started.
 * Never throws: a monitoring write must not be able to kill the thing it
 * monitors.
 */
async function writeHeartbeat(exec: Executor, openCount: number): Promise<void> {
  try {
    let walletSol: number | null = null;
    try {
      walletSol = await exec.walletSol();
    } catch { /* keep null */ }
    getDb().prepare(
      "INSERT INTO meta (key, value) VALUES ('heartbeat', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(JSON.stringify({
      ts: now(), pid: process.pid, build: buildSha, mode: exec.mode,
      open: openCount, probeFailures, entriesFrozen: entriesFrozen(),
      walletSol,
    }));
  } catch (e) {
    console.error("[farmer] heartbeat write failed:", (e as Error).message);
  }
}
let breakerAlerted = false;

function clearRangeTimers(posId: number): void {
  aboveRangeSince.delete(posId);
  belowRangeSince.delete(posId);
  tvlHistory.delete(posId);
  decayStreak.delete(posId);
  stopStreak.delete(posId);
  peakPnl.delete(posId);
  giveBackLogged.delete(posId);
  hydrated.delete(posId);
  getDb().prepare(
    "UPDATE positions SET above_range_since = NULL, below_range_since = NULL, stop_streak = 0, decay_streak = 0 WHERE id = ?"
  ).run(posId);
  feeOffsetLogged.delete(posId);
  escapeShapeLogged.delete(posId);
  midBandSince.delete(posId);
  midBandLogged.delete(posId);
  rugcheckLastCheck.delete(posId);
  everInRange.delete(posId);
  fellDeep.delete(posId);
  clearHolderWatch(posId);
}

/**
 * Close a position and send the Telegram PnL report. Every exit path routes
 * through here so no close goes unreported: net PnL (exit + claimed fees -
 * entry), percent, and hold time.
 */
async function closeAndReport(
  exec: Executor,
  pos: Position,
  reason: Parameters<Executor["close"]>[1],
  slippageBps: number,
  kind: AlertKind,
  headline: string,
): Promise<{ exitSol: number; txCostSol: number }> {
  const res = await withBusy(() => exec.close(pos, reason, slippageBps));
  // Re-read fees and actual wallet deltas: the close itself may claim
  // outstanding fees, and open_cost/close_return carry the real rent+tx costs.
  const row = getDb().prepare(
    "SELECT fees_claimed_sol, fees_measured_sol, recovered_sol, open_cost_sol, close_return_sol, fees_at_close_sol, withdrawn_sol, stranded_sol FROM positions WHERE id = ?"
  ).get(pos.id) as {
    fees_claimed_sol: number; fees_measured_sol: number; recovered_sol: number;
    open_cost_sol: number | null; close_return_sol: number | null; fees_at_close_sol: number;
    withdrawn_sol: number; stranded_sol: number;
  } | undefined;
  // Written moments ago by the close itself, so it is always inside the grace
  // window here — no expiry check, unlike REALIZED_PNL_SQL which reads old rows.
  const stranded = row?.stranded_sol ?? 0;
  const feesClaimed = row?.fees_claimed_sol ?? pos.feesClaimedSol;
  const feesAtClose = row?.fees_at_close_sol ?? 0;
  // Display prefers the MEASURED claim credit over the pool-mid mark. Book-wide
  // fees_claimed_sol is 0.1727 against fees_measured_sol 0.1322 — the mark runs
  // ~23% hot, and 2.3x on claudius pos#9 (0.0535 marked, 0.0234 measured). A hot
  // mark printed one line above a measured true-PnL figure is the exact
  // mark-vs-measured confusion that line exists to remove. || not ?? on purpose:
  // 0 means no claim happened, so fall through to the mark (also 0).
  const feesClaimShown = row?.fees_measured_sol || feesClaimed;
  const feesTotal = feesClaimShown + feesAtClose;
  // Prefer measured wallet PnL for the headline when columns exist — mark-based
  // (exit_sol + fees_claimed - entry) is what Kelly historically read, but it
  // diverges badly on empty/P0 closes (Niles/K showed −100% mark vs small
  // measured losses). Book / dash / circuit breaker already use REALIZED_PNL_SQL.
  const markPnl = res.exitSol + feesClaimed - pos.entrySol;
  const measuredPnl = row?.open_cost_sol != null && row?.close_return_sol != null
    ? row.close_return_sol + row.fees_measured_sol + row.withdrawn_sol + row.recovered_sol + stranded - row.open_cost_sol
    : null;
  const pnl = measuredPnl ?? markPnl;
  const pctBase = measuredPnl != null && row?.open_cost_sol ? row.open_cost_sol : pos.entrySol;
  const pct = pctBase > 0 ? (pnl / pctBase) * 100 : 0;
  const holdH = (now() - pos.entryTs) / 3600;
  const hold = holdH < 1 ? `${(holdH * 60).toFixed(0)}m` : `${holdH.toFixed(1)}h`;
  let trueLine = "";
  if (measuredPnl != null && row) {
    trueLine = `\ntrue PnL (measured): ${measuredPnl >= 0 ? "+" : ""}${measuredPnl.toFixed(4)} SOL` +
      ` [in ${row.open_cost_sol!.toFixed(4)} → out ${(row.close_return_sol! + row.fees_measured_sol + row.withdrawn_sol + row.recovered_sol + stranded).toFixed(4)}]`;
    // Say so when part of "out" is still tokens. The figure is provisional until
    // the sweep sells them, and an operator reading a number this close to flat
    // is owed the reason it is not final.
    if (stranded > 0) {
      trueLine += `\nincl. ~${stranded.toFixed(4)} SOL still held as tokens (swap under-filled) — provisional until the sweep sells`;
    }
    if (Math.abs(markPnl - measuredPnl) > 0.02) {
      trueLine += `\nmark PnL (display-only): ${markPnl >= 0 ? "+" : ""}${markPnl.toFixed(4)} SOL`;
    }
  }
  await alert(
    kind,
    `${pos.symbol} pos#${pos.id} closed — ${headline}\n` +
    `PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)\n` +
    `entry ${pos.entrySol.toFixed(3)} → exit ${res.exitSol.toFixed(3)} SOL | fees ${feesTotal.toFixed(4)} SOL` +
    (feesAtClose > 0 ? ` (${feesClaimShown.toFixed(4)} claimed + ${feesAtClose.toFixed(4)} at close)` : "") +
    ` | held ${hold}` +
    trueLine
  );
  // Follow-mode chain accounting: every close of a follow leg routes through
  // here, so this is the one place the chain learns its leg's outcome. Budget
  // reads the measured wallet delta when the columns exist, the mark otherwise.
  if (pos.followChainId != null) {
    const legPnl = measuredPnl ?? markPnl;
    try {
      onFollowLegClosed(pos, reason, legPnl);
    } catch (e) {
      console.error(`[follow] leg-close hook failed for pos#${pos.id}:`, (e as Error).message);
    }
  }
  // Profit burn uses MEASURED wallet PnL only (open_cost → close_return + fees
  // + recovered rent). Never tax mark-only PnL — that overstates winners.
  await maybeProfitBurn(exec, pos, measuredPnl).catch((e) =>
    console.error(`[profit_burn] pos#${pos.id} failed:`, (e as Error).message));
  await accountPnlAlert(exec).catch((e) =>
    console.error("[alert] account summary failed:", (e as Error).message));
  return res;
}

/**
 * Fixed 1% product fee: measured net profit → Jupiter buy GNME → burn immediately.
 * Accrual pot only holds leftover if a swap fails (retry on next flush).
 * Skips when measured columns are missing or PnL ≤ 0.
 */
async function maybeProfitBurn(
  exec: Executor,
  pos: Position,
  measuredPnl: number | null,
): Promise<void> {
  if (measuredPnl == null) {
    console.log(`[profit_burn] skip pos#${pos.id}: no measured wallet PnL (legacy/mark-only close)`);
    return;
  }
  const spend = profitBurnSpendSol(measuredPnl, PROFIT_BURN.profit_frac);
  if (spend == null) return;

  const accrued = accrueProfitBurn(
    spend,
    `pos#${pos.id} ${pos.symbol} pnl=+${measuredPnl.toFixed(6)} share=${spend.toFixed(6)}`,
  );
  console.log(
    `[profit_burn] +${spend.toFixed(6)} SOL from pos#${pos.id} ${pos.symbol} ` +
      `(${(PROFIT_BURN.profit_frac * 100).toFixed(0)}% of +${measuredPnl.toFixed(4)}) → pot ${accrued.toFixed(6)}`,
  );

  await flushProfitBurn(exec, {
    measuredPnlSol: measuredPnl,
    positionId: pos.id,
    symbol: pos.symbol,
  });
}

/** Burn the whole accrued pot (any size > 0). Used after closes and on manage ticks. */
async function flushProfitBurn(
  exec: Executor,
  ctx?: { measuredPnlSol: number; positionId: number; symbol: string },
): Promise<void> {
  const accrued = readProfitBurnAccrued();
  if (!(accrued > 0)) return;

  if (exec.mode !== "live" || !(exec instanceof LiveExecutor)) {
    getDb().prepare(
      "INSERT INTO ledger (ts, kind, sol, note) VALUES (?, 'profit_burn_paper', ?, ?)",
    ).run(
      now(),
      accrued,
      `pot ${accrued.toFixed(6)}${ctx ? ` from pos#${ctx.positionId} ${ctx.symbol}` : ""} (paper — not sent)`,
    );
    writeProfitBurnAccrued(0);
    console.log(
      `[profit_burn] paper: would spend pot ${accrued.toFixed(4)} SOL → burn ${PROFIT_BURN.mint.slice(0, 8)}…`,
    );
    return;
  }

  const result = await executeProfitBurn({
    connection: exec.connection,
    wallet: exec.wallet,
    spendSol: accrued,
    measuredPnlSol: ctx?.measuredPnlSol ?? accrued,
    positionId: ctx?.positionId ?? 0,
    symbol: ctx?.symbol ?? "pot",
  });
  if (!result) {
    console.error(
      `[profit_burn] swap failed with pot ${accrued.toFixed(6)} SOL still accrued — will retry later`,
    );
    return;
  }
  writeProfitBurnAccrued(0);
  // Silent by design — ledger + console only; do not Telegram the usage fee.
  console.log(
    `[profit_burn] spent ${result.spentSol.toFixed(4)} SOL → burned ${result.burnedRaw} ` +
      `sig=${result.signature}`,
  );
}

/**
 * Account-level PnL since the mode's baseline, sent after every close. The
 * baseline (wallet + capital already in positions) is captured once, on the
 * first close after this feature ships, and persisted in meta.
 */
async function accountPnlAlert(exec: Executor): Promise<void> {
  const db = getDb();
  const wallet = await exec.walletSol();
  const openSol = (db.prepare(
    "SELECT COALESCE(SUM(entry_sol), 0) AS s FROM positions WHERE state IN ('open','pending') AND mode = ?"
  ).get(exec.mode) as { s: number }).s;
  const key = `baseline_sol_${exec.mode}`;
  let baseline: number;
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  if (row) {
    baseline = Number(row.value);
  } else {
    baseline = wallet + openSol;
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(key, String(baseline));
  }
  const closed = db.prepare(
    `SELECT COUNT(*) AS c, COALESCE(SUM(${REALIZED_PNL_SQL}), 0) AS r
     FROM positions WHERE exit_ts IS NOT NULL AND mode = ?`
  ).get(exec.mode) as { c: number; r: number };
  const acct = wallet + openSol - baseline; // open positions counted at entry value
  const pct = baseline > 0 ? (acct / baseline) * 100 : 0;
  await alert(
    "account",
    `account since start: ${acct >= 0 ? "+" : ""}${acct.toFixed(4)} SOL (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)\n` +
    `wallet ${wallet.toFixed(3)} + in positions ${openSol.toFixed(3)} vs start ${baseline.toFixed(3)}\n` +
    `closed ${closed.c} | realized on positions ${closed.r >= 0 ? "+" : ""}${closed.r.toFixed(4)} SOL`
  );
}

/** House-money rule (§5/P3): bank realized profit so it leaves the deployable pool. */
function bankProfit(pos: Position, exitSol: number, context: string): void {
  if (!config().manage.house_money_rule) return;
  const profit = exitSol + pos.feesClaimedSol - pos.entrySol;
  if (profit <= 0) return;
  getDb().prepare("INSERT INTO ledger (ts, kind, sol, note) VALUES (?, 'bank', ?, ?)")
    .run(now(), profit, `${context} ${pos.symbol} pos#${pos.id}`);
  console.log(`[bank] +${profit.toFixed(4)} SOL banked (${context} ${pos.symbol}) — release via ledger when desired`);
}

/**
 * P0 TVL-drop check (§4): true if pool TVL fell >= threshold within the window.
 * Measured against the window MEDIAN, not the peak — a violent pump inflates
 * peak readings and made the goon exit (2026-08-07) fire on a healthy pool.
 * Requires the last TWO readings to confirm so one glitchy datapi value can't
 * trigger a safety exit; a real drain persists across consecutive 15s polls.
 */
export interface TvlDrainCheck {
  triggered: boolean;
  /** Recorded on the decision row — this window is in-memory and dies with the process. */
  evidence: {
    samples: number;
    medianTvl: number;
    tvlNow: number;
    tvlDropPct: number;
    medianPrice: number;
    priceNow: number;
    priceChangePct: number;
    vetoedByPriceRise: boolean;
  } | null;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

/**
 * P0 TVL drain, with a price-rise veto.
 *
 * TVL falling is ambiguous on its own, and the tie-breaker is PRICE, not
 * volume. A pool whose price is running up is having its ask-side inventory
 * bought out — TVL falls because the pool is being *traded through*, and the
 * LPs who just got filled walk. A rug drains TVL too, but always alongside a
 * price collapse. Both cases carry heavy volume (a rug is a stampede), so
 * volume cannot separate them — pos#5 GUNICORN drained 40% while printing $85k
 * of 30m volume against $8.5k of TVL, and its price was +261%. It did not rug;
 * it round-tripped.
 *
 * The veto is deliberately asymmetric: staying in a real rug is catastrophic
 * and exiting early costs ~0.002 SOL, so it only suppresses the exit on STRONG
 * evidence of a buy-out (a large price rise). Flat or falling price still fires.
 */
/**
 * Rebuild the P0 drain window from the marks already on disk, so a restart
 * does not blind the rug check until it has re-polled its way to 4 samples.
 * `ts < now()` drops the mark this very tick wrote: tvlDropTriggered pushes
 * that sample itself, and counting it twice would skew the median it is
 * measured against.
 */
function loadTvlWindow(posId: number, windowS: number): Array<{ ts: number; tvl: number; price: number }> {
  return getDb().prepare(
    "SELECT ts, tvl_usd AS tvl, price FROM position_marks WHERE position_id = ? AND ts >= ? AND ts < ? AND tvl_usd > 0 ORDER BY ts"
  ).all(posId, now() - windowS, now()) as Array<{ ts: number; tvl: number; price: number }>;
}

function tvlDropTriggered(posId: number, tvlNow: number, priceNow: number, poolAgeS: number | null): TvlDrainCheck {
  const m = config().manage;
  const windowS = 600; // 10 min per spec
  const hist = tvlHistory.get(posId) ?? loadTvlWindow(posId, windowS);
  hist.push({ ts: now(), tvl: tvlNow, price: priceNow });
  while (hist.length && hist[0]!.ts < now() - windowS) hist.shift();
  tvlHistory.set(posId, hist);
  if (hist.length < 4) return { triggered: false, evidence: null };

  // The trigger reads "40% below the 10-minute median". Two situations make
  // that median meaningless, measured 2026-08-15 with no rug in progress:
  //  - a pool younger than the window: the baseline is its own birth;
  //  - a thin pool: TVL is a handful of LPs, so one repositioning is a 40%
  //    event (same token, same 4 minutes: $8k pool swung 51%, $67k pool 9%).
  // Below either floor the drain read is noise; pool_dead and price_crash still
  // cover a real collapse there.
  const medTvl = median(hist.map((h) => h.tvl));
  const minTvl = m.tvl_drain_min_tvl_usd ?? 20_000;
  const minAgeS = (m.tvl_drain_min_pool_age_min ?? 20) * 60;
  if (medTvl < minTvl || (poolAgeS !== null && poolAgeS < minAgeS)) {
    return { triggered: false, evidence: null };
  }
  const dropped = (t: number) => medTvl > 0 && ((medTvl - t) / medTvl) * 100 >= m.safety_tvl_drop_pct;
  const drained = dropped(tvlNow) && dropped(hist[hist.length - 2]!.tvl);

  const medPrice = median(hist.map((h) => h.price).filter((p) => p > 0));
  const priceChangePct = medPrice > 0 && priceNow > 0 ? ((priceNow - medPrice) / medPrice) * 100 : 0;
  const vetoPct = m.tvl_drain_price_rise_veto_pct ?? 25;
  const vetoedByPriceRise = drained && vetoPct > 0 && priceChangePct >= vetoPct;

  return {
    triggered: drained && !vetoedByPriceRise,
    evidence: {
      samples: hist.length,
      medianTvl: medTvl,
      tvlNow,
      tvlDropPct: medTvl > 0 ? ((medTvl - tvlNow) / medTvl) * 100 : 0,
      medianPrice: medPrice,
      priceNow,
      priceChangePct,
      vetoedByPriceRise,
    },
  };
}

/** P0 RugCheck-flip check, throttled to one call per position per 5 min. */
async function rugcheckFlipped(posId: number, mint: string): Promise<boolean> {
  const last = rugcheckLastCheck.get(posId) ?? 0;
  if (now() - last < 300) return false;
  rugcheckLastCheck.set(posId, now());
  const summary = await fetchSummary(mint);
  return summary !== null && summary.score_normalised >= config().vetting.rugcheck_veto_normalised;
}

export function haltRequested(): boolean {
  return controlPresent("HALT");
}

/** Soft pause: no manage/entry/sweep; leave positions open. */
export function pauseRequested(): boolean {
  return controlPresent("PAUSE");
}

/**
 * Single-instance lock. Incident 2026-08-07: four orphaned loops (Windows
 * process-tree kills only reach the npm wrapper) shared one DB and corrupted
 * each other's positions. Refuses to start while another live PID holds the
 * lock; stale locks (dead PID) are reclaimed.
 */
function acquireInstanceLock(): void {
  mkdirSync(dataDir(), { recursive: true });
  const claim = () => writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
  try {
    claim(); // wx = atomic create-or-fail; the old exists→read→write window let two simultaneous starters both pass
  } catch (e) {
    // Only EEXIST means "someone holds the lock". Anything else — ENOSPC on a
    // full volume (2026-08-16), EROFS, EACCES — is the DISK refusing us, and
    // reporting that as "another instance is running" sends the operator
    // hunting a phantom process. Say what actually happened.
    const code = (e as NodeJS.ErrnoException).code;
    if (code && code !== "EEXIST") {
      throw new Error(`cannot write ${LOCK_FILE} (${code}) — check the data volume (full? read-only?)`);
    }
    const oldPid = Number(readFileSync(LOCK_FILE, "utf8").trim());
    let alive = false;
    try {
      process.kill(oldPid, 0); // signal 0 = existence check
      alive = true;
    } catch (err) {
      // EPERM = the pid exists but belongs to another user — that is an ALIVE
      // instance, not a stale lock to steal.
      alive = (err as NodeJS.ErrnoException).code === "EPERM";
    }
    if (alive && oldPid !== process.pid) {
      throw new Error(
        `another farmer instance is already running (pid ${oldPid}). ` +
        `Stop it first — two instances on one DB corrupt each other's positions.`
      );
    }
    console.log(`[farmer] reclaiming stale lock from dead pid ${oldPid}`);
    rmSync(LOCK_FILE, { force: true });
    claim(); // throws if a concurrent starter won the race — correct outcome
  }
  const release = () => {
    try { rmSync(LOCK_FILE, { force: true }); } catch { /* best effort */ }
    try { rmSync(BUSY_FILE, { force: true }); } catch { /* best effort */ }
  };
  process.on("exit", release);
  const drainThenExit = (code: number) => {
    // Never die mid-executor-call: a SIGTERM between a zap swap and the
    // add-liquidity leg (auto-deploy restarts, PM2 stop) strands capital.
    if (busyDepth === 0) { release(); process.exit(code); }
    console.log(`[farmer] shutdown signal — waiting for in-flight executor call to settle (busy depth ${busyDepth})`);
    const started = Date.now();
    const t = setInterval(() => {
      if (busyDepth === 0 || Date.now() - started > 90_000) {
        clearInterval(t);
        release();
        process.exit(code);
      }
    }, 250);
  };
  process.on("SIGINT", () => drainThenExit(130));
  process.on("SIGTERM", () => drainThenExit(143));
}

function loadOpenPositions(): Position[] {
  // mode filter is load-bearing: the DB is shared across the paper→live
  // promotion flow. A live loop that loads a leftover paper row finds no
  // position_accounts behind it, marks it worthless, and P0-closes it through
  // the LIVE executor — fake full loss, permanent blacklist, breaker food.
  const rows = getDb().prepare(
    `SELECT id, mode, pool, token_mint, symbol, tranche_of, entry_ts, entry_price, entry_sol,
            min_bin_id, max_bin_id, state, fees_claimed_sol, rent_paid_sol, profit_lock_fires,
            exit_ts, exit_sol, exit_reason, follow_chain_id, close_requested_at
     FROM positions WHERE state IN ('open','pending') AND mode = ?`
  ).all(currentMode()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number, mode: r.mode as "paper" | "live",
    poolAddress: r.pool as string, tokenMint: r.token_mint as string,
    symbol: (r.symbol as string) ?? "?", trancheOf: r.tranche_of as number | null,
    entryTs: r.entry_ts as number, entryPrice: r.entry_price as number,
    entrySol: r.entry_sol as number, minBinId: r.min_bin_id as number,
    maxBinId: r.max_bin_id as number, state: r.state as Position["state"],
    feesClaimedSol: r.fees_claimed_sol as number, rentPaidSol: r.rent_paid_sol as number,
    profitLockFires: r.profit_lock_fires as number,
    exitTs: r.exit_ts as number | null, exitSol: r.exit_sol as number | null,
    exitReason: r.exit_reason as Position["exitReason"],
    followChainId: r.follow_chain_id as number | null,
    closeRequestedAt: r.close_requested_at as number | null,
  }));
}

/**
 * How many pools may be marked at once when `manage.mark_concurrency` is unset.
 * Above the book's usual size there is nothing left to overlap (one group per
 * pool), and the peak request rate is what trips a provider's rate limiter —
 * the bot already logs 429 backoff ladders at the serial rate. 1 restores the
 * old strictly-serial behaviour.
 */
/**
 * Is the next scan due? Measured on the server, 2026-08-21, over 637 sweeps.
 *
 * The scan fires from inside the manage tick, so it can only ever start on a
 * poll boundary — and `interval_s` is an exact multiple of `poll_s` (60 = 3 x
 * 15), which put the old `elapsed > interval` test exactly ON the 4th
 * boundary. Whether it passed came down to a millisecond of timer jitter, and
 * losing meant waiting a whole extra poll. The gap histogram was two clean
 * spikes and nothing in between:
 *
 *     59s  x42     73s  x12
 *     60s  x144    74s  x77
 *     61s  x68     75s  x198
 *     62s  x9      76s  x53
 *
 * 288 scans landed on the 4th tick, 348 on the 5th — a coin flip costing 15s,
 * a quarter of the interval, and averaging 7.8s of staleness per scan. That is
 * the whole "tick overrun": not a slow tick (the scanning tick measures the
 * same 15s as any other, and the deferral guard has never once fired) but a
 * boundary the schedule sat exactly on.
 *
 * Half a poll of tolerance snaps it to the nearest tick instead. It cannot
 * fire early: the previous boundary is a full poll below the target, so it
 * stays outside the window by the same half-poll margin.
 */
export function scanDue(sinceLastScanMs: number, intervalMs: number, pollMs: number): boolean {
  return sinceLastScanMs > intervalMs - pollMs / 2;
}

export const DEFAULT_MARK_CONCURRENCY = 4;

/**
 * Default quote-drift tolerance, in bins. 3 bins is 3% on the 100-bp pools
 * memecoins actually list in — wide enough that ordinary jitter between the
 * scan and the open does not cost an entry, tight enough to have caught the
 * 4-bin CatGPT drift that mispriced the whole position.
 */
export const DEFAULT_MAX_QUOTE_DRIFT_BINS = 3;

/**
 * TELEMETRY ONLY — nothing acts on this. How close to the planner's swing high
 * an entry has to be before it is flagged as a top-blast.
 *
 * Measured 2026-08-21 over 85 closed positions matched to their own entry
 * decision, bucketing by entry price / swingHigh:
 *
 *   >=0.97  n=5   win 40%  mean +0.0002 SOL
 *   .90-.97 n=7   win 71%  mean +0.0031
 *   .70-.90 n=29  win 55%  mean +0.0140
 *   <0.70   n=44  win 70%  mean +0.0218
 *
 * The gradient is real but FRAGILE, and the mechanism first proposed for it
 * ("entering high puts the up-exits out of reach") is wrong. Re-checked the
 * same day:
 *
 *  - Dropping positions with <3 recorded marks collapses the two large
 *    buckets to +0.0203 vs +0.0202. The gradient is carried by a cluster of
 *    near-instant closes in the middle bucket, not by entry height.
 *  - Of the 12 entries at >=0.90, SEVEN exited P3_above (price cleared the
 *    range top and held it) and two more P2_rotation. Only one ever armed the
 *    escape hatch — and it escaped and won. Entering high did not put the up
 *    exits out of reach on this book.
 *  - Those 12 entries earned +0.023 SOL in total, and the five at >=0.97
 *    earned +0.0009. A gate would have nothing to save.
 *
 * What actually went wrong on CatGPT was timing: Railway planned off a quote
 * printed 56 s earlier and executed 13 bins higher. The re-quote guard above
 * addresses that; a height rule would not have.
 *
 * So this stays telemetry (same pattern as P1_fee_offset_deferred and
 * young_exit_candidate) and the sample keeps building. §2.3 continues to
 * penalise height as 15% of the soft score.
 */
export const TOP_BLAST_TELEMETRY_FRAC = 0.97;

/**
 * TELEMETRY ONLY — nothing acts on these. A give-back stop: once a position has
 * been up GIVE_BACK_MIN_PEAK_SOL on a fee-inclusive basis, log the moment it
 * hands back to GIVE_BACK_KEEP_FRAC of that peak.
 *
 * Replayed 2026-08-21 over 120 closed positions with recorded marks (mark vs
 * mark, so it isolates timing). At keep=0.75 it changed 22 exits for a net
 * +2.657 SOL: cutting winners early cost -0.360 across 11, avoiding losses
 * gained +3.017 across 11. Unlike the dip-relative escape hatch rejected the
 * same day, it survives the checks — worse on only 10 of 22, median +0.0009,
 * **+0.493 excluding the top four contributors**, +2.13 after a 3% slippage
 * haircut, and flat across thresholds (75%->95% all land 2.6-2.7) rather than
 * balanced on a knife edge.
 *
 * Two reasons it is logged rather than shipped. The measurement is from the
 * SERVER bot, not the Railway one this was asked about. And its two largest
 * contributors are P0 safety exits, where the last mark is near zero and a
 * mark-based counterfactual flatters itself — whether a real exit was
 * executable at the trigger is unproven.
 *
 * Note what this is NOT. The shape usually described — green, then red, then
 * back to break-even, then down again — does not exist in the book: of 25
 * positions that were green and closed red, ZERO returned to break-even after
 * going red (11 closed at their low; the other 14 recovered to a median of
 * -0.054 SOL). There is no second chance to take. The value, if any, is in
 * leaving before the give-back completes.
 */
export const GIVE_BACK_MIN_PEAK_SOL = 0.02;
export const GIVE_BACK_KEEP_FRAC = 0.75;

/**
 * The floor above, capped at a share of the position. 0.02 SOL was measured on
 * the server's book, where the winners are 0.5-0.75 SOL positions; on Railway's
 * meme sleeve an entry is 0.10-0.25 SOL, so a flat 0.02 asks for a +8-20% peak
 * before the experiment will look at all — and CatGPT pos#82 (entry 0.15,
 * 0.0319 SOL of fees banked, stopped at MTM -29% / fee-inclusive -7.4%) sat
 * right on that line. A floor that cannot see the positions the rule is meant
 * to catch collects nothing, so take whichever floor is lower.
 */
export const GIVE_BACK_MIN_PEAK_FRAC = 0.05;

/** Peak a position must have reached before the give-back counterfactual arms. */
export function giveBackPeakFloor(entrySol: number): number {
  return Math.min(GIVE_BACK_MIN_PEAK_SOL, entrySol * GIVE_BACK_MIN_PEAK_FRAC);
}

/** One manager tick over all open positions.
 * Two-pass: mark every position before any close/claim. A sibling exit used to
 * delay peer marks by 50–80s (3/4161 gaps ≥60s, but enough to fail RANGE-SHAPE
 * integrity (a) on max_gap).
 */
export async function managePositions(exec: Executor): Promise<void> {
  const m = config().manage;
  const positions = loadOpenPositions();
  let marksFailed = 0, unrealizedSol = 0;
  const marked: Array<{ pos: Position; mark: Awaited<ReturnType<Executor["mark"]>> }> = [];

  // Network pass. Each position's mark is 4-5 independent round trips (the
  // live one includes a getProgramAccounts, the slowest method any provider
  // sells), and doing them one position at a time made the tick cost their
  // SUM — the reason mean mark gaps measured 16-19s against a 15s poll. Same
  // calls, same rate-limit budget; they just stop queueing behind each other.
  // Same-pool positions still mark one at a time (see mapGrouped).
  const settled = await mapGrouped(
    positions,
    (pos) => pos.poolAddress,
    async (pos) => {
      if (exec instanceof PaperExecutor) await exec.accrueFees(pos, m.poll_s);
      return exec.mark(pos);
    },
    m.mark_concurrency ?? DEFAULT_MARK_CONCURRENCY,
  );

  // Ledger pass, serial and in book order: every write below is cross-position
  // state (the unrealized total, the marks table, the in-range set), and it
  // stays single-threaded so the recorded order cannot depend on which RPC
  // answered first.
  for (const { item: pos, value, error } of settled) {
    try {
      if (error !== undefined) throw error;
      const mark = value!;
      // Adopted rows (reconcile inserts entry_sol = 0, no basis) get their cost
      // basis from the first successful mark — "PnL from adoption point", as the
      // adoption event promises. Without this the row has no P1 stop (value/0),
      // no exposure accounting, and its close would be unknown-PnL forever.
      if (pos.entrySol === 0 && mark.valueSol > 0) {
        getDb().prepare(
          "UPDATE positions SET entry_sol = ?, open_cost_sol = COALESCE(open_cost_sol, ?), entry_price = CASE WHEN entry_price = 0 THEN ? ELSE entry_price END WHERE id = ?"
        ).run(mark.valueSol, mark.valueSol, mark.price, pos.id);
        pos.entrySol = mark.valueSol;
        if (pos.entryPrice === 0) pos.entryPrice = mark.price;
        console.log(`[manager] adopted pos#${pos.id} baseline set from first mark: ${mark.valueSol.toFixed(4)} SOL @ ${mark.price}`);
      }
      unrealizedSol += mark.valueSol - pos.entrySol;
      const valueFrac = pos.entrySol > 0 ? mark.valueSol / pos.entrySol : 1;
      try {
        // Pool health and banked fees ride along: the executor fetched them for
        // P0/P2 on this very tick, so recording them is free, and without them
        // the backtester cannot replay tvl_drain or rotation decay at all.
        getDb().prepare(
          `INSERT INTO position_marks
             (position_id, ts, active_bin_id, price, value_sol, value_frac, unclaimed_fees_sol, in_range,
              tvl_usd, vol_30m_usd, fee_tvl_30m_pct, pool_age_s, fees_claimed_cum_sol)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(pos.id, now(), mark.activeBinId, mark.price, mark.valueSol, valueFrac,
              mark.unclaimedFeesSol, mark.inRange ? 1 : 0,
              mark.tvlUsd, mark.vol30mUsd, mark.feeTvl30mPct, mark.poolAgeS ?? null,
              pos.feesClaimedSol);
      } catch (e) {
        console.error("[manager] position_marks insert failed:", (e as Error).message);
      }
      if (mark.inRange && !everInRange.has(pos.id)) {
        everInRange.add(pos.id);
        getDb().prepare("UPDATE positions SET ever_in_range = 1 WHERE id = ?").run(pos.id);
      }
      marked.push({ pos, mark });
    } catch (e) {
      marksFailed++;
      console.error(`[manager] position ${pos.id} (${pos.symbol}):`, (e as Error).message);
    }
  }
  if (marksFailed > 0) console.warn(`[manager] ${marksFailed}/${positions.length} marks failed this tick`);

  for (const { pos, mark } of marked) {
    try {
      hydrateTimers(pos.id);
      const ageH = (now() - pos.entryTs) / 3600;
      const valueFrac = pos.entrySol > 0 ? mark.valueSol / pos.entrySol : 1;
      const sleeve = sleeveAtEntry(pos);
      const pm = manageForSleeve(sleeve);

      // --- TELEMETRY ONLY: young-launch quick-exit candidate ---
      // 2026-08-20 research (38 clean young-pool closes + Railway's 21): every
      // quicker-exit rule simulated — tighter below-range grace, fee-secured
      // exit, 0.85/0.90 stop, band-depth cuts — tested flat to negative,
      // because winners routinely dip mid-band (apes, EYE, CLUG) then recover
      // and keep printing fees, while the real killers are <5-min flash
      // crashes no band rule sees coming. Backtest n is too small to close the
      // question, so log the trigger the sims found closest to break-even
      // (2 min sustained below band midpoint) and judge it on forward data
      // before ever acting on it. One row per position, meme sleeves only.
      if (sleeve !== "majors" && pos.maxBinId > pos.minBinId && mark.activeBinId != null) {
        const depthFrac = (mark.activeBinId - pos.minBinId) / (pos.maxBinId - pos.minBinId);
        if (depthFrac < 0.5) {
          if (!midBandSince.has(pos.id)) midBandSince.set(pos.id, now());
          const since = midBandSince.get(pos.id) ?? now();
          if (now() - since >= 120 && !midBandLogged.has(pos.id)) {
            midBandLogged.add(pos.id);
            recordDecision(pos.tokenMint, pos.poolAddress, "skipped", "young_exit_candidate", null, {
              posId: pos.id, depthFrac, valueFrac, feesClaimedSol: pos.feesClaimedSol,
              holdMin: (now() - pos.entryTs) / 60, mark, sleeve,
            });
            console.log(`[manager] pos#${pos.id} ${pos.symbol}: 2m sustained below band midpoint (depth ${(depthFrac * 100).toFixed(0)}%) — young-exit candidate logged`);
          }
        } else {
          midBandSince.delete(pos.id);
        }
      }

      // --- TELEMETRY ONLY: give-back stop counterfactual ---
      // Fee-inclusive, matching what the replay measured: mark.valueSol already
      // carries UNCLAIMED fees (see position_marks), and feesClaimedSol is what
      // has been banked. Rent is refunded at close, so it is not in this basis.
      const pnlNow = mark.valueSol + pos.feesClaimedSol - pos.entrySol;
      const prevPeak = peakPnl.get(pos.id);
      if (prevPeak === undefined || pnlNow > prevPeak) {
        peakPnl.set(pos.id, pnlNow);
        getDb().prepare("UPDATE positions SET peak_pnl_sol = ? WHERE id = ?").run(pnlNow, pos.id);
      }
      const peak = peakPnl.get(pos.id)!;
      const peakFloor = giveBackPeakFloor(pos.entrySol);
      if (!giveBackLogged.has(pos.id) && peak >= peakFloor && pnlNow <= peak * GIVE_BACK_KEEP_FRAC) {
        giveBackLogged.add(pos.id);
        getDb().prepare("UPDATE positions SET give_back_logged = 1 WHERE id = ?").run(pos.id);
        recordDecision(pos.tokenMint, pos.poolAddress, "skipped", "give_back_candidate", null, {
          posId: pos.id, symbol: pos.symbol, peakPnlSol: peak, pnlNowSol: pnlNow,
          keepFrac: GIVE_BACK_KEEP_FRAC, minPeakSol: peakFloor,
          feesClaimedSol: pos.feesClaimedSol, valueSol: mark.valueSol, entrySol: pos.entrySol,
          holdMin: (now() - pos.entryTs) / 60, sleeve, mark,
        });
        console.log(
          `[manager] pos#${pos.id} ${pos.symbol}: gave back to ${(peak > 0 ? (pnlNow / peak) * 100 : 0).toFixed(0)}% ` +
          `of a +${peak.toFixed(4)} SOL peak (now ${pnlNow >= 0 ? "+" : ""}${pnlNow.toFixed(4)}) ` +
          `— give-back candidate logged (telemetry only, nothing closed)`
        );
      }

      // --- OPERATOR CLOSE: dashboard "Close now" on this position ---
      // Ahead of the whole P0–P5 ladder on purpose. The operator looked at this
      // position and decided; no rule should get to override that, and running
      // it first means the close cannot be pre-empted by a P0 that would also
      // blacklist the token. Marked `manual`, so it is excluded from the
      // strategy's own exit statistics rather than polluting them.
      if (pos.closeRequestedAt != null) {
        console.log(`[manager] pos#${pos.id} ${pos.symbol}: operator close requested — closing now`);
        await closeAndReport(
          exec, pos, "manual", config().exec.exit_slippage_bps, "close",
          "closed by operator from the dashboard",
        );
        clearRangeTimers(pos.id);
        recordDecision(pos.tokenMint, pos.poolAddress, "exited", "manual_close", null, {
          mark, sleeve, requestedAt: pos.closeRequestedAt, ageH,
        });
        continue;
      }

      // --- P0 SAFETY: pool death, price crash, TVL drain, rugcheck flip, holder watch ---
      // Majors are allowlisted / discovery-gated at entry — RugCheck "Danger" is often a
      // permanent score on established tokens (PUMP etc.), not a flip. Applying the meme
      // veto here false-closed pos#61 in 7s. Keep hard P0 (dead/crash/TVL) for majors.
      const crashed = mark.price > 0 && pos.entryPrice > 0 &&
        ((mark.price - pos.entryPrice) / pos.entryPrice) * 100 <= m.safety_price_crash_pct;
      const drain = mark.tvlUsd > 0
        ? tvlDropTriggered(pos.id, mark.tvlUsd, mark.price, mark.poolAgeS ?? null)
        : { triggered: false, evidence: null } satisfies TvlDrainCheck;
      const tvlDrained = drain.triggered;
      if (drain.evidence?.vetoedByPriceRise) {
        const e = drain.evidence;
        console.log(
          `[manager] pos#${pos.id} ${pos.symbol}: TVL -${e.tvlDropPct.toFixed(0)}% but price ` +
          `+${e.priceChangePct.toFixed(0)}% — traded through, not drained; P0 tvl_drain vetoed`
        );
      }
      const rugFlip = sleeve !== "majors" && !crashed && !tvlDrained && mark.valueSol > 0
        && await rugcheckFlipped(pos.id, pos.tokenMint);
      const holderTrig = sleeve !== "majors" && exec.mode === "live" && !crashed && !tvlDrained && !rugFlip
        ? await holderCheck(pos.id, pos.tokenMint, pos.poolAddress) : null;
      if (mark.valueSol === 0 || crashed || tvlDrained || rugFlip || holderTrig) {
        const trigger = mark.valueSol === 0 ? "pool_dead" : crashed ? "price_crash" : tvlDrained ? "tvl_drain" : rugFlip ? "rugcheck_flip" : `${holderTrig!.kind} (${holderTrig!.detail})`;
        // Timers clear AFTER the close succeeds (here and in P1–P5 below): a
        // throwing close leaves the position open, and pre-clearing restarted
        // the full sustain/grace window per failure — a P5 cut retried only
        // every (grace + failure) minutes while the token kept bleeding.
        await closeAndReport(exec, pos, "P0_safety", config().exec.safety_exit_slippage_bps, "safety_exit", `P0 safety (${trigger})`);
        clearRangeTimers(pos.id);
        // A TVL drain is a LIQUIDITY condition, not evidence of fraud. It fires
        // identically on a thin pool being traded through, on LP churn in a pool
        // minutes old, and on a real rug — and exiting costs ~0.002 SOL either
        // way, so the exit stays. Banning the token AND every future token by
        // its creator, permanently, on that one reading is a different price.
        // GUNICORN (2026-08-15, pos#5): one 40%-in-10-min reading on a 9-minute-old
        // pool banned its creator for good; the token then round-tripped +260% and
        // the pool was still the highest fee/TVL board on the scanner. Cool the
        // token off instead, and keep permanent bans for triggers that actually
        // evidence a rug.
        const rugEvidence = trigger !== "tvl_drain";
        // Don't permanent-blacklist majors allowlist tokens on soft P0 signals.
        if (sleeve !== "majors" || trigger === "pool_dead" || trigger === "price_crash" || trigger === "tvl_drain") {
          const ttlH = rugEvidence ? undefined : (config().manage.tvl_drain_cooldown_h ?? 6);
          blacklist(pos.tokenMint, "token", `P0 safety exit (${trigger})`, ttlH);
          // STRATEGY §4 P0: token + CREATOR. One strike = permanent — the
          // vetting side (creator blacklist + rug_count) has always read this;
          // nothing wrote it until now, so a rugger's next mint sailed through.
          if (sleeve !== "majors" && rugEvidence) {
            const creator = (getDb().prepare("SELECT creator FROM tokens WHERE mint = ?")
              .get(pos.tokenMint) as { creator: string | null } | undefined)?.creator;
            if (creator) recordCreatorRug(creator, `P0 safety exit (${trigger}) on ${pos.symbol}`);
          }
        }
        // The TVL window lives in memory and dies with the process, so without
        // this a tvl_drain exit leaves nothing to audit after the fact.
        recordDecision(pos.tokenMint, pos.poolAddress, "exited", `P0_safety_${trigger}`, null, {
          mark, pos, sleeve, drain: drain.evidence,
        });
        continue;
      }

      // --- P1 STOP LOSS ---
      // P5 below-range grace exists so a WICK does not cut the position, but P1
      // ran ahead of it and read one 15s mark: 4680 pos#11 (2026-08-16) wicked
      // -54% for under two minutes, P5 armed its 15m grace, P1 fired 80s later
      // at -25%, and the token was +58% within the hour — the biggest loss on
      // the book, on a candle that CLOSED at -20%. (The bigger bot hit the same
      // stop on the same wick and only profited because its exit swap
      // under-filled and the residual sweep sold the leftovers after the
      // bounce — luck, not design.)
      //
      // So while the position is BELOW RANGE, the stop must SUSTAIN across
      // consecutive polls before it fires. Keyed on mark.belowRange itself, not
      // on the P5 timer: P1 runs before P5 in the ladder, so on the first tick
      // of a wick the timer is not armed yet — keying on it would fire the stop
      // on tick 1 and defeat the whole point. Inside range the stop is immediate
      // as before: value falling 25% while price is still in our bins is a real
      // drawdown, not a wick.
      //
      // 2026-08-18: `valueFrac` is mark-to-market only — the SOL side plus the
      // token side at spot plus UNCLAIMED fees. Fees already CLAIMED are real
      // SOL in the wallet and were invisible to it. Audit of the 7 P1 stops
      // with marks: six fired with fee-inclusive value at 0.84–0.97 (the
      // position had already paid us; DCN closed +0.0001, Z500 was +76% within
      // 4h) and one — 4680 — at 0.25, a real crash. `stop_loss_count_claimed_fees`
      // switches the value P1 measures; either way the OTHER answer is logged
      // as a decision on every P1 tick, so the knob can be judged from the
      // ledger before it is flipped. Same threshold, same sustain rule.
      const feeInclFrac = pos.entrySol > 0 ? valueFrac + pos.feesClaimedSol / pos.entrySol : valueFrac;
      const countClaimed = m.stop_loss_count_claimed_fees === true;
      const stopFrac = countClaimed ? feeInclFrac : valueFrac;
      // Counterfactual for the OFF case: MTM is under the stop but claimed fees
      // would have held it. One row per position, on the first tick it is true,
      // so a week of these answers "how often, and what happened next".
      if (!countClaimed && valueFrac < pm.stop_loss_frac && feeInclFrac >= pm.stop_loss_frac && !feeOffsetLogged.has(pos.id)) {
        feeOffsetLogged.add(pos.id);
        recordDecision(pos.tokenMint, pos.poolAddress, "skipped", "P1_fee_offset_deferred", null,
          { valueFrac, feeInclFrac, feesClaimedSol: pos.feesClaimedSol, mark, inGrace: mark.belowRange });
        console.log(`[manager] pos#${pos.id} ${pos.symbol}: MTM ${(valueFrac * 100 - 100).toFixed(1)}% under stop, fee-inclusive ${(feeInclFrac * 100 - 100).toFixed(1)}% — stop_loss_count_claimed_fees would defer (logged)`);
      }
      if (stopFrac < pm.stop_loss_frac) {
        const inGrace = mark.belowRange;
        const streak = (stopStreak.get(pos.id) ?? 0) + 1;
        setTimer(stopStreak, pos.id, streak);
        // In range the stop has had NO wick tolerance: one poll under the line
        // exits. Below range it demands `stop_loss_sustain_polls`. Both bots
        // stopped out of positions a single 15s sample apart on 2026-08-26.
        const needed = inGrace
          ? (m.stop_loss_sustain_polls ?? 4)
          : (m.stop_loss_sustain_polls_in_range ?? 1);
        if (streak < needed) {
          if (streak === 1) console.log(`[manager] pos#${pos.id} ${pos.symbol}: under stop (${(stopFrac * 100 - 100).toFixed(1)}%) below range — sustaining ${needed} polls before P1`);
        } else {
          await closeAndReport(exec, pos, "P1_stop", config().exec.exit_slippage_bps, "stop_loss",
            `stop loss at ${(stopFrac * 100 - 100).toFixed(1)}%${inGrace ? ` (sustained ${streak} polls below range)` : ""}`);
          clearRangeTimers(pos.id);
          blacklist(pos.tokenMint, "token", "stop loss cooldown", m.loss_reentry_cooldown_h);
          recordDecision(pos.tokenMint, pos.poolAddress, "exited", "P1_stop", null, { valueFrac, feeInclFrac, countClaimed, mark, sustainedPolls: streak, inGrace });
          continue;
        }
      } else {
        clearTimer(stopStreak, pos.id);
      }

      // --- P2 ROTATION: age limit + consecutive fee/volume decay ---
      if (ageH > pm.max_age_h) {
        await closeAndReport(exec, pos, "P2_rotation", config().exec.exit_slippage_bps, "close", `rotation: max age ${pm.max_age_h}h reached`);
        clearRangeTimers(pos.id);
        recordDecision(pos.tokenMint, pos.poolAddress, "exited", "P2_rotation_age", null, { ageH, sleeve });
        continue;
      }
      const feeDaily = mark.feeTvl30mPct * 48;
      // Meme: either fee or volume dead → rotate (fast capital). Majors: both must
      // be dead — fee alone near the entry floor was churning PUMP/ANSEM every ~5–40m.
      const feeDead = feeDaily < pm.rotation_fee_daily_min_pct;
      const volDead = mark.vol30mUsd < pm.rotation_vol_30m_min_usd;
      const decayed = sleeve === "majors" ? (feeDead && volDead) : (feeDead || volDead);
      const streak = decayed ? (decayStreak.get(pos.id) ?? 0) + 1 : 0;
      setTimer(decayStreak, pos.id, streak);
      if (streak >= pm.rotation_polls) {
        const { exitSol } = await closeAndReport(exec, pos, "P2_rotation", config().exec.exit_slippage_bps, "close", `rotation: fee/volume decay (fee ${feeDaily.toFixed(3)}%/d, vol30m $${mark.vol30mUsd.toFixed(0)})`);
        clearRangeTimers(pos.id);
        bankProfit(pos, exitSol, "P2 rotation");
        recordDecision(pos.tokenMint, pos.poolAddress, "exited", "P2_rotation_decay", null, { feeDaily, vol30m: mark.vol30mUsd, streak, sleeve, feeDead, volDead });
        console.log(`[manager] pos#${pos.id} ${pos.symbol}: rotated out (fee ${feeDaily.toFixed(3)}%/d, vol30m $${mark.vol30mUsd.toFixed(0)}, sleeve=${sleeve})`);
        continue;
      }

      // --- P3 ABOVE RANGE -> TAKE PROFIT (with sustain timer, §4 P3) ---
      if (mark.aboveRange) {
        const dbFlag = (getDb().prepare("SELECT ever_in_range AS e FROM positions WHERE id = ?")
          .get(pos.id) as { e: number } | undefined)?.e === 1;
        const traveled = everInRange.has(pos.id) || dbFlag;
        const sustainMin = traveled ? pm.above_range_sustain_min : pm.above_range_missed_sustain_min;
        const since = aboveRangeSince.get(pos.id);
        if (since === undefined) {
          setTimer(aboveRangeSince, pos.id, now());
        } else if (now() - since >= sustainMin * 60) {
          const classification = traveled ? "win" : "missed";
          const { exitSol } = await closeAndReport(
            exec, pos, "P3_above", config().exec.exit_slippage_bps, "close",
            classification === "win" ? "take-profit (price traveled through range)" : "missed (price jumped over range)"
          );
          clearRangeTimers(pos.id);
          if (classification === "missed")
            getDb().prepare("UPDATE positions SET state='closed_missed' WHERE id=?").run(pos.id);
          else bankProfit(pos, exitSol, "P3 take-profit");
          recordDecision(pos.tokenMint, pos.poolAddress, "exited", `P3_above_${classification}`, null, { mark, sustainedS: now() - since, exitSol, sustainMin, sleeve });
          if (pos.followChainId == null && sleeve !== "majors") armFollowChain(pos, mark.price, mark.vol30mUsd);
        }
        continue;
      }
      clearTimer(aboveRangeSince, pos.id);

      // --- P5 BELOW RANGE (grace timer, §4 P5: wick tolerance) ---
      if (mark.belowRange) {
        const since = belowRangeSince.get(pos.id);
        if (since === undefined) {
          setTimer(belowRangeSince, pos.id, now());
          console.log(`[manager] pos#${pos.id} ${pos.symbol} below range — grace timer started (${pm.below_range_grace_min}m)`);
          if (mark.unclaimedFeesSol >= m.grace_claim_min_sol) {
            try {
              const { claimedSol } = await withBusy(() => exec.claimFees(pos));
              await alert("claim", `${pos.symbol} pos#${pos.id}: grace-start claim — banked ${claimedSol.toFixed(4)} SOL before below-range wait`);
            } catch (e) {
              console.error(`[manager] pos#${pos.id} grace-start claim failed:`, (e as Error).message);
            }
          }
        } else if (now() - since >= pm.below_range_grace_min * 60) {
          await closeAndReport(exec, pos, "P5_below", config().exec.exit_slippage_bps, "below_cut", `below-range cut after ${pm.below_range_grace_min}m grace`);
          clearRangeTimers(pos.id);
          blacklist(pos.tokenMint, "token", "below range cut", m.loss_reentry_cooldown_h);
          recordDecision(pos.tokenMint, pos.poolAddress, "exited", "P5_below", null, { mark, graceS: now() - since });
        }
        continue;
      }
      clearTimer(belowRangeSince, pos.id);

      // --- ESCAPE HATCH (meme only by default) ---
      if (pos.followChainId == null && (sleeve !== "majors" || config().majors.escape_hatch_enabled)) {
        // Two formulations of the same hatch, live-compared (v0.24.0).
        //
        // LIVE (default): a fraction of RANGE DEPTH. Its defect is real — the
        // arming *price* moves with the range width (-26.4% on a 40% range,
        // -19.3% on a 30% one, -8.8% on a rent-shrunk 14% one), which is why
        // the hatch is off on follow legs and why RANGE-WIDTH-DECISION.md makes
        // fixing it the prerequisite for testing a narrower range.
        //
        // `escape_hatch_absolute` switches to drawdown from entry price, which
        // removes that coupling. It ships OFF because it is NOT the no-op that
        // document assumed. Replayed over the 96 closed positions where the
        // depth rule reproduces the real exit, it changes 14: four are
        // measurable and carried by a single row (+0.127 Normie; -0.033 and
        // worse on 3 of 4 without it), and ten are real escapes whose marks
        // END at the escape — no data can say what holding would have done
        // (post-exit bars cover 3 and disagree: +14%, -22%, +34%). No single
        // threshold pair fixes this: the book's range depths run 11-50%, so a
        // sweep bottoms out at 26 of 177 changed. Both answers are logged; a
        // week of live disagreements decides, not this replay.
        const depth = pos.maxBinId - pos.minBinId;
        const frac = depth > 0 ? (pos.maxBinId - mark.activeBinId) / depth : 0;
        const drawPct = escapeDrawdownPct(pos.entryPrice, mark.price);
        const absolute = pm.escape_hatch_absolute === true;
        const armDraw = pm.escape_hatch_drawdown_pct ?? ESCAPE_ARM_DRAWDOWN_PCT;
        const armsNow = absolute ? drawPct >= armDraw : frac >= pm.escape_hatch_depth_pct / 100;
        const wouldArm = absolute ? frac >= pm.escape_hatch_depth_pct / 100 : drawPct >= armDraw;
        if (wouldArm !== armsNow && !escapeShapeLogged.has(pos.id)) {
          escapeShapeLogged.add(pos.id);
          recordDecision(pos.tokenMint, pos.poolAddress, "skipped", "escape_absolute_deferred", null,
            { frac, drawPct, armsNow, wouldArm, absolute, mark, sleeve });
          console.log(`[manager] pos#${pos.id} ${pos.symbol}: hatch formulations disagree — ${(frac * 100).toFixed(0)}% of range depth vs -${drawPct.toFixed(1)}% from entry; escape_hatch_absolute would ${wouldArm ? "arm" : "not arm"} (logged)`);
        }
        if (armsNow) {
          if (!fellDeep.has(pos.id)) {
            fellDeep.add(pos.id);
            getDb().prepare("UPDATE positions SET fell_deep = 1 WHERE id = ?").run(pos.id);
            console.log(`[manager] pos#${pos.id} ${pos.symbol}: -${drawPct.toFixed(1)}% from entry (${(frac * 100).toFixed(0)}% of range) — escape hatch armed`);
          }
        } else if (absolute
          ? drawPct <= (pm.escape_hatch_recovery_drawdown_pct ?? ESCAPE_RECOVER_DRAWDOWN_PCT)
          : frac <= pm.escape_hatch_recovery_pct / 100) {
          const armed = fellDeep.has(pos.id) ||
            (getDb().prepare("SELECT fell_deep AS f FROM positions WHERE id = ?").get(pos.id) as { f: number } | undefined)?.f === 1;
          if (armed) {
            clearRangeTimers(pos.id);
            let rebalanced = false;
            if (exec.escapeRebalance) {
              try {
                rebalanced = (await exec.escapeRebalance(pos, config().exec.exit_slippage_bps)).ok;
              } catch (e) {
                console.error(`[manager] pos#${pos.id} escape rebalance failed:`, (e as Error).message);
              }
            }
            if (rebalanced) {
              getDb().prepare("UPDATE positions SET fell_deep = 0 WHERE id = ?").run(pos.id);
              await alert("close", `${pos.symbol} pos#${pos.id}: escape hatch rebalance — range reset in place`);
              recordDecision(pos.tokenMint, pos.poolAddress, "exited", "escape_rebalance", null, { frac, drawPct, absolute, mark, sleeve });
              continue;
            }
            // Partial rebalance often leaves tokens/wSOL in the wallet and an empty
            // position shell. Sweep residuals onto this row before the close so
            // recovered_sol is attributed (wSOL-aware walletDelta).
            if (exec.sweepResiduals) {
              try {
                await exec.sweepResiduals(RESIDUAL_SWEEP_MIN_SOL);
              } catch (e) {
                console.error(`[manager] pos#${pos.id} pre-close sweep failed:`, (e as Error).message);
              }
            }
            const { exitSol } = await closeAndReport(exec, pos, "escape", config().exec.exit_slippage_bps, "close",
              "escape hatch: deep dip recovered to range top — close and reset");
            bankProfit(pos, exitSol, "escape hatch");
            // Bench the token briefly. The hatch fired because price just fell
            // through most of our range — the token is demonstrably breaching
            // ranges — yet "close and reset" re-bought it on the next tick.
            // TROOPET 2026-08-19 (Railway): escape +0.026 at 20:07:04, re-entry
            // at 20:08:25 47% lower, P0 stop −0.051 six minutes later. Across
            // both bots 6 escapes re-entered inside 60 min (3 same-minute) for
            // net −0.10 SOL. Win exits carry no loss cooldown, so this is the
            // only thing that separates "reset" from "chase".
            const coolMin = config().manage.escape_reentry_cooldown_min ?? 15;
            if (coolMin > 0) blacklist(pos.tokenMint, "token", "escape cooldown", coolMin / 60);
            recordDecision(pos.tokenMint, pos.poolAddress, "exited", "escape_hatch", null, { frac, drawPct, absolute, mark, sleeve, coolMin });
            continue;
          }
        }
      }

      // --- P4 IN RANGE: claim / compound + profit lock ---
      const lastClaimTs = ((getDb().prepare(
        "SELECT MAX(ts) AS t FROM events WHERE position_id = ? AND type = 'claim'"
      ).get(pos.id) as { t: number | null }).t) ?? pos.entryTs;
      if (shouldClaimFees(mark.unclaimedFeesSol, now() - lastClaimTs, {
        claim_min_sol: pm.claim_min_sol,
        claim_min_txcost_mult: m.claim_min_txcost_mult,
        claim_interval_h: m.claim_interval_h,
      })) {
        if (sleeve === "majors" && config().majors.fee_compound && exec.mode === "paper") {
          getDb().prepare("UPDATE positions SET entry_sol = entry_sol + ?, fees_claimed_sol = fees_claimed_sol + ? WHERE id = ?")
            .run(mark.unclaimedFeesSol, mark.unclaimedFeesSol, pos.id);
          getDb().prepare(
            "INSERT INTO events (position_id, ts, type, sol_delta, detail_json) VALUES (?, ?, 'claim', ?, ?)"
          ).run(pos.id, now(), mark.unclaimedFeesSol, JSON.stringify({ kind: "majors_compound" }));
          console.log(`[majors] pos#${pos.id} ${pos.symbol}: compounded ${mark.unclaimedFeesSol.toFixed(4)} SOL fees`);
        } else {
          const { claimedSol } = await withBusy(() => exec.claimFees(pos));
          await alert("claim", `${pos.symbol} pos#${pos.id}: claimed ${claimedSol.toFixed(4)} SOL in fees`);
        }
      }
      if (
        pm.profit_lock_enabled &&
        pos.profitLockFires < m.profit_lock_max_fires &&
        valueFrac >= m.profit_lock_at_frac
      ) {
        const { withdrawnSol } = await withBusy(() => exec.withdraw(pos, m.profit_lock_withdraw_pct * 100));
        await alert("profit_lock", `${pos.symbol} pos#${pos.id}: profit lock at +${((valueFrac - 1) * 100).toFixed(0)}% — withdrew ${withdrawnSol.toFixed(4)} SOL`);
      }
    } catch (e) {
      logError({
        source: "manager",
        code: "position_act",
        message: `position ${pos.id} (${pos.symbol}) act: ${(e as Error).message}`,
        err: e,
        positionId: pos.id,
        symbol: pos.symbol,
        mint: pos.tokenMint,
        pool: pos.poolAddress,
        dedupeSec: 30,
      });
    }
  }

  try {
    await rollupDaily(exec.mode, unrealizedSol);
  } catch (e) {
    console.error("[pnl] rollup failed:", (e as Error).message);
  }
  await flushProfitBurn(exec).catch((e) =>
    console.error("[profit_burn] flush failed:", (e as Error).message));
}

/** Remaining sleep so short ticks keep poll cadence; long ticks never stack extra delay. */
export function pollSleepMs(elapsedMs: number, pollMs: number): number {
  return Math.max(0, pollMs - elapsedMs);
}

/** Estimated cost of one claim round-trip (claim tx + swap-to-SOL leg). */
export const CLAIM_EST_TX_COST_SOL = 0.001;

/**
 * P4 claim decision (STRATEGY §4 P4). Two ways in:
 *   1. fees cleared the headline floor (claim_min_sol), or
 *   2. fees would pay at least claim_min_txcost_mult× the tx cost AND the
 *      position hasn't claimed for claim_interval_h — sub-floor fees shouldn't
 *      sit at pool risk for hours; bank them once the trip pays for itself.
 * Both interval knobs existed in config since launch but were never read.
 */
export function shouldClaimFees(
  unclaimedSol: number,
  lastClaimAgoS: number,
  m: { claim_min_sol: number; claim_min_txcost_mult?: number; claim_interval_h?: number },
): boolean {
  if (unclaimedSol >= m.claim_min_sol) return true;
  const costFloorSol = (m.claim_min_txcost_mult ?? 20) * CLAIM_EST_TX_COST_SOL;
  const intervalS = (m.claim_interval_h ?? 4) * 3600;
  return unclaimedSol >= costFloorSol && lastClaimAgoS >= intervalS;
}

/**
 * Cheap liveness probe, run at the top of every tick. Maintains the blind clock
 * that watchdogCheck reads and the fuse that freezes entries.
 * Never throws — a probe that can break the tick is worse than no probe.
 */
async function rpcProbe(exec: Executor): Promise<void> {
  try {
    await exec.healthProbe();
    if (probeFailures > 0) console.log(`[watchdog] RPC recovered after ${probeFailures} failed probes`);
    probeFailures = 0;
    lastHealthyTick = Date.now();
    // Reset the alert ladder too: without this, a 50-min outage that escalated
    // nextAlertAtMin to ~110 made the NEXT outage's first alert wait ~110
    // blind minutes instead of rpc_blind_after_min.
    nextAlertAtMin = 0;
    if (watchdogAlerted) {
      watchdogAlerted = false;
      await alert("watchdog", `RPC recovered — resuming normal operation`).catch(() => {});
    }
  } catch (e) {
    probeFailures++;
    logError({
      source: "watchdog",
      code: "rpc_probe",
      level: probeFailures >= 3 ? "error" : "warn",
      message: `RPC probe failed (${probeFailures}): ${(e as Error).message.split("\n")[0]}`,
      err: e,
      detail: { probeFailures },
      dedupeSec: 120,
    });
  }
}

/** Entries are frozen well before the watchdog alerts — see watchdogCheck. */
function entriesFrozen(): boolean {
  return probeFailures >= PROBE_FAILURES_FREEZE_ENTRIES;
}

/**
 * Watchdog (§9): alert when the RPC has been unreachable too long. It does NOT
 * liquidate, and the close-all branch that used to live here is deleted rather
 * than config-gated, deliberately.
 *
 * close()'s RPC read-set is a strict SUPERSET of mark()'s — both go through
 * pool() -> refetchStates() -> getPositionsByUserAndLbPair, and close() then
 * additionally needs simulateTransaction, getRecentPrioritizationFees,
 * getLatestBlockhash, send, confirm, Jupiter, and 6x getParsedTransaction. So
 * there is no state of the world in which marking fails but closing succeeds:
 * a close-all can only complete when firing it was a mistake. Routing it
 * through a fallback connection does not fix that, it just moves the
 * requirement onto a less-trusted node — and a lagging node answering
 * getProgramAccounts with a stale empty result is the trigger for the worst
 * write-off path in this codebase (see ourLbPositions).
 *
 * Base rate as of 2026-08-10: 2 failed marks in ~2,710 attempts, both 429s
 * five log lines apart. Longest blind streak ever observed ~30s, against a
 * 300s trigger. The watchdog has never fired.
 *
 * Re-enabling automated liquidation is a code change and a review, not a TOML
 * edit. The pre-committed criteria are in RANGE-SHAPE-DECISION.md's sibling
 * section of the watchdog audit; the short version is that it needs a real
 * recorded incident, a genuinely independent connection, a freshness gate, and
 * position sizes about 10x today's before it is even positive-EV.
 */
export async function watchdogCheck(): Promise<void> {
  const w = config().watchdog;
  const blindMs = Date.now() - lastHealthyTick;
  if (blindMs < w.rpc_blind_after_min * 60_000) return;
  const blindMin = blindMs / 60_000;
  // Ladder rather than a latch: watchdogAlerted used to be set once and cleared
  // only by a healthy tick, so a multi-hour outage produced exactly one message.
  if (blindMin >= nextAlertAtMin) {
    watchdogAlerted = true;
    nextAlertAtMin = blindMin >= 45 ? blindMin + 60 : blindMin >= 15 ? 45 : 15;
    const open = loadOpenPositions();
    await alert("watchdog",
      `RPC blind for ${blindMin.toFixed(0)}m (${probeFailures} failed probes) — entries frozen, ` +
      `${open.length} position(s) UNMANAGED: P0/P1/P3/P5 are all suspended while blind. ` +
      `No automatic close will be attempted; that path was removed deliberately. Manual intervention.`
    ).catch(() => {});
  }
}

/**
 * Current opportunity score of an OPEN position's pool (neutral vetting/timing
 * parts — we're comparing pool heat, not re-vetting). Used by displacement.
 */
async function currentPositionScore(pos: Position): Promise<number | null> {
  const pool = await fetchPool(pos.poolAddress).catch(() => null);
  if (!pool) return null;
  const { score } = opportunityScore({
    feeMomentum: feeMomentumPart(pool),
    turnover: turnoverPart(pool),
    vettingSoft: 0.5,
    timing: 0.5,
    structure: structurePart(pool),
  });
  const gm = (await trendingByMint()).get(pos.tokenMint);
  const g = config().gmgn;
  const bonus = !gm ? 0
    : gm.intervals.has("5m") && gm.intervals.has("1h") ? g.bonus_sustained
    : gm.intervals.has("5m") ? g.bonus_emerging
    : gm.intervals.has("1h") ? g.bonus_fading : 0;
  return Math.min(100, score + bonus);
}

/**
 * Displacement (§5): full book + exceptional candidate -> close the weakest
 * open position IF the candidate beats its current score by a margin, it's old
 * enough, and it isn't underwater (never realize losses to chase). Returns
 * true if a slot was freed.
 */
async function tryDisplacement(exec: Executor, candScore: number, candMint: string): Promise<boolean> {
  const rot = config().rotation;
  if (!rot.displacement_enabled) return false;

  const recent = (getDb().prepare(
    "SELECT COUNT(*) AS c FROM decisions WHERE failed_gate LIKE 'displaced_by%' AND ts > ?"
  ).get(now() - 21_600) as { c: number }).c;
  if (recent >= rot.displacement_max_per_6h) return false;

  let weakest: { pos: Position; score: number; valueFrac: number } | null = null;
  for (const pos of loadOpenPositions()) {
    if (now() - pos.entryTs < rot.displacement_min_hold_min * 60) continue;
    let valueFrac: number;
    try {
      const mark = await exec.mark(pos);
      valueFrac = pos.entrySol > 0 ? mark.valueSol / pos.entrySol : 1;
    } catch { continue; }
    if (valueFrac < rot.displacement_value_frac_min) continue;
    const score = await currentPositionScore(pos);
    if (score === null) continue;
    if (!weakest || score < weakest.score) weakest = { pos, score, valueFrac };
  }

  if (!weakest || candScore < weakest.score + rot.displacement_margin) return false;

  await closeAndReport(exec, weakest.pos, "P2_rotation", config().exec.exit_slippage_bps, "displacement",
    `displaced (score ${weakest.score.toFixed(0)}) for candidate scoring ${candScore.toFixed(0)}`);
  recordDecision(weakest.pos.tokenMint, weakest.pos.poolAddress, "exited", `displaced_by:${candMint}`, weakest.score, {
    candScore, weakestScore: weakest.score, valueFrac: weakest.valueFrac,
  });
  console.log(
    `[rotate] displaced ${weakest.pos.symbol} (score ${weakest.score.toFixed(1)}, pos#${weakest.pos.id}) ` +
    `for candidate scoring ${candScore.toFixed(1)}`
  );
  return true;
}

/** Entry pipeline: scan -> vet -> size -> open, respecting portfolio limits. */
export async function enterNewPositions(exec: Executor): Promise<void> {
  const walletSol = await exec.walletSol();
  if (circuitBreakerTripped(walletSol)) {
    console.log("[risk] circuit breaker tripped — no new entries");
    if (!breakerAlerted) {
      breakerAlerted = true;
      await alert("circuit_breaker", "daily loss limit hit — new entries paused (open positions still managed)");
    }
    return;
  }
  const cluster = clusterBrakeTripped();
  if (cluster) {
    console.log(`[risk] cluster brake — ${cluster.count} lossy hard exits in ${config().sizing.cluster_brake_window_h}h, paused ${cluster.remainingMin}m`);
    if (!breakerAlerted) {
      breakerAlerted = true;
      await alert("circuit_breaker",
        `cluster brake: ${cluster.count}× lossy P0/P1 in ${config().sizing.cluster_brake_window_h}h — ` +
        `new entries paused ${cluster.remainingMin}m (open positions still managed)`
      );
    }
    return;
  }
  breakerAlerted = false;

  // Regime filter (§5): SOL crashing -> halve or pause new-entry sizing.
  const solChange = await sol24hChangePct();
  const regime = solChange === null ? 1 : regimeFactor(solChange);
  if (regime === 0) {
    console.log(`[risk] regime filter: SOL ${solChange?.toFixed(1)}% in 24h — new entries paused`);
    return;
  }

  let bankroll = computeBankroll(walletSol);
  const rot = config().rotation;
  const normalCap = Math.max(0, bankroll.effectiveSlots - rot.alpha_slots);

  let candidates;
  try {
    ({ candidates } = await scan());
  } catch (e) {
    logError({
      source: "scanner",
      code: "sweep_failed",
      message: (e as Error).message,
      err: e,
      dedupeSec: 60,
    });
    return;
  }
  for (const cand of candidates) {
    const opened = openPositionCount();
    // Cheap admission pre-check before spending vetting calls: when the normal
    // book is full, only candidates that could plausibly reach alpha (pre-vet
    // score + max vetting uplift) are worth vetting.
    const maxVetUplift = 0.5 * config().score.w_vetting_soft;
    if (opened >= normalCap && cand.score + maxVetUplift < rot.alpha_score_min) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "slots_full", cand.score, { symbol: cand.symbol });
      continue;
    }
    if (opened >= bankroll.effectiveSlots && !rot.displacement_enabled) break;

    // One owner per token: while a follow chain is live for this mint, the
    // chain decides re-entry timing — the normal pipeline entering in parallel
    // would double exposure and race the chain's up-only discipline.
    if (hasActiveFollowChain(cand.tokenMint, exec.mode)) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "follow_active", cand.score, { symbol: cand.symbol });
      continue;
    }

    // Pool createdAt is a fallback only — vet prefers RugCheck mint detectedAt.
    const poolCreatedAtMs = cand.pool.createdAt ? Date.parse(cand.pool.createdAt) : null;
    // A throwing vet (e.g. a partial RugCheck report) used to escape the
    // candidate loop and kill entries for every LATER candidate that tick.
    let vet: Awaited<ReturnType<typeof vetToken>>;
    try {
      vet = await vetToken(cand.tokenMint, poolCreatedAtMs);
    } catch (e) {
      logError({
        source: "enter", code: "vet_error",
        message: `${cand.symbol} vet threw: ${(e as Error).message}`,
        err: e, mint: cand.tokenMint, symbol: cand.symbol, dedupeSec: 30,
      });
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "vet_error", cand.score, { error: (e as Error).message });
      continue;
    }
    if (vet.verdict !== "pass") {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", vet.hardFailures[0]?.gate ?? "vet", cand.score, { vet, cand });
      continue;
    }

    // Re-blend score with real vetting softness (§2.4).
    const blended = cand.score - 0.5 * config().score.w_vetting_soft + (vet.softScore / 100) * config().score.w_vetting_soft;

    // Bonus discipline (live-experiment guardrail): trending + flow bonuses
    // share one cap, and risk TIERS (alpha, micro bar) are decided on the
    // fundamentals-only base score — bonuses can raise sizing/priority but
    // can never promote a candidate across a risk threshold.
    const trendingBonus = cand.scoreParts["gmgn_trending"] ?? 0;
    const flow = flowFor(cand.tokenMint);
    let flowBonus = 0, flowPenalty = 0;
    let flowNote = "";
    if (flow && !flow.stale) {
      const sf = config().smartflow;
      if (flow.smartWallets >= sf.min_wallets) flowBonus += sf.bonus_wallets;
      if (flow.newJoiners >= sf.min_joiners) flowBonus += sf.bonus_joiners;
      if (flow.kolNames.length > 0) flowBonus += sf.bonus_kol;
      if (flow.netUsd <= -sf.net_sell_penalty_usd) flowPenalty = sf.penalty_net_sell;
      if (flow.smartWallets > 0 || flow.kolNames.length > 0) {
        flowNote = `\nsmart money 30m: ${flow.smartWallets} wallets (+${flow.newJoiners} joining), net $${flow.netUsd.toFixed(0)}` +
          (flow.kolNames.length ? ` | KOL: ${flow.kolNames.slice(0, 3).join(", ")}` : "");
      }
    }
    flowBonus = Math.min(flowBonus, Math.max(0, config().score_caps.bonus_cap_total - trendingBonus));
    const baseScore = Math.max(0, blended - trendingBonus - flowPenalty); // fundamentals only
    let score = Math.max(0, Math.min(100, blended + flowBonus - flowPenalty));

    // Microcap band: $100-200k tokens are riskier — the higher bar must be
    // met on FUNDAMENTALS (base score), not reachable via bonuses.
    const g = config().gates;
    const isMicro = isMicroMcap(cand.pool.marketCapUsd);
    if (isMicro && baseScore < g.mcap_micro_score_min) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "micro_score", baseScore, { mcapUsd: cand.pool.marketCapUsd, required: g.mcap_micro_score_min, score });
      continue;
    }
    if (isMicro && cand.pool.tvlUsd < g.micro_tvl_min_usd) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "micro_tvl", score, { tvlUsd: cand.pool.tvlUsd, required: g.micro_tvl_min_usd, sleeve: "micro" });
      continue;
    }
    const microExp = isMicro ? microSleeveExposure() : null;
    if (isMicro && microExp!.slots >= g.micro_max_slots) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "micro_slots_full", score, { ...microExp, max: g.micro_max_slots });
      continue;
    }

    // Slot admission (§5): normal slots for everyone, alpha slots only for
    // exceptional FUNDAMENTALS; full book -> displacement attempt for alpha only.
    const isAlpha = baseScore >= rot.alpha_score_min;
    const admitted = opened < normalCap || (isAlpha && opened < bankroll.effectiveSlots);
    // Displacement is only PLANNED here — the victim is closed immediately
    // before the open, after every remaining gate has passed. We used to
    // liquidate a healthy earning position first and then skip the candidate
    // on bin_rent/pool_share/open_failed: a close for nothing that still
    // counted against displacement_max_per_6h.
    const needsDisplacement = !admitted && isAlpha;
    if (!admitted && !isAlpha) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "alpha_reserved", score, { opened, normalCap });
      continue;
    }

    const kelly = kellyStats();
    let size = positionSize(bankroll, score, isMicro ? "micro" : "core");
    if (size <= 0) {
      const gate = sizingMode() === "kelly" && kelly.regime === "negative_edge" ? "kelly_negative_edge" : "size_zero";
      if (sizingMode() === "kelly" && kelly.regime === "negative_edge")
        console.log(`[risk] Kelly estimates negative edge (f*=${kelly.fullKelly?.toFixed(3)}, n=${kelly.samples}) — entries blocked`);
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", gate, score, { bankroll, kelly });
      continue;
    }
    // SIZING-MODE-DECISION.md Gate 3 — instrumented-off, same pattern as
    // P1_fee_offset_deferred and escape_absolute_deferred. Records what a flat
    // `kelly_core_unit = "pct"` base would have sized next to the Kelly size
    // actually used. `size` is NOT reassigned; this is telemetry.
    //
    // Logged BEFORE the re-entry ladder and pool-share clamp on purpose: both
    // apply identically to either rule, so comparing after them would measure
    // the clamps rather than the sizing rule.
    //
    // The raw bankroll inputs go in the payload because `kelly_core_pct` is
    // almost certainly NOT calibrated yet: the flat arm must match the trailing
    // MEAN Kelly size or the test measures leverage instead of timing, and that
    // calibration differs ~2x depending on when it is taken. Logging the inputs
    // lets the analysis recalibrate after the fact without re-running the bot.
    //
    // CAPTURED here, EMITTED after the `entered` decision. This line is reached
    // for every candidate on every tick — including ones rejected below by
    // `already_positioned` — so recording here wrote ~1 row per MINUTE per open
    // position instead of one per entry (measured in production 2026-08-26,
    // 6 rows in 6 minutes against a book that had not entered for 80). That
    // floods `decisions` against `db_max_mb` and, worse, would have had the
    // Gate 3 median dominated by repeat evaluations of one candidate.
    const gate3Sizing = {
      kellySol: size,
      flatSol: flatCounterfactualSol(bankroll, score, isMicro ? "micro" : "core"),
      walletSol: bankroll.walletSol,
      deployableSol: bankroll.deployableSol,
      deployedSol: bankroll.deployedSol,
      appliedFraction: kelly.appliedFraction,
      regime: kelly.regime,
      samples: kelly.samples,
      corePct: config().sizing[isMicro ? "kelly_micro_pct" : "kelly_core_pct"],
      sleeve: isMicro ? "micro" : "core",
    };
    // Re-entry ladder (§4 P3): each same-token entry within 24h shrinks by
    // reentry_ladder_mult; hard stop after reentry_max_per_24h re-entries.
    const m = config().manage;
    const priorEntries24h = (getDb().prepare(
      "SELECT COUNT(*) AS c FROM positions WHERE token_mint = ? AND entry_ts > ? AND mode = ?"
    ).get(cand.tokenMint, now() - 86_400, currentMode()) as { c: number }).c;
    if (priorEntries24h > m.reentry_max_per_24h) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "reentry_limit", score, { priorEntries24h });
      continue;
    }
    size *= Math.pow(m.reentry_ladder_mult, priorEntries24h);
    size *= regime; // regime filter halves sizing in a SOL downdraft
    if (isMicro && sizingMode() === "kelly") size = applyMicroSize(size);
    // Viability floor, applied once, here — AFTER the ladder and regime have
    // had their say. A re-entry gets the lower floor because it reuses a token
    // account the first entry already paid rent for (see min_reentry_sol).
    // Both floors scale with equity (minPositionSol) so a small bankroll gets a
    // proportionally smaller floor instead of being silently frozen out; the
    // helpers also absorb the missing-key fallback, which matters because
    // config() is a hot-reloaded raw TOML parse and `size < undefined` is
    // false — a bare read would remove the floor rather than fall back to it.
    const sizeFloor = priorEntries24h > 0
      ? minReentrySol(bankroll.walletSol)
      : minPositionSol(bankroll.walletSol);
    if (size < sizeFloor) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "ladder_below_min", score, { priorEntries24h, size, sizeFloor });
      continue;
    }
    if (isMicro) {
      const capSol = bankroll.walletSol * (g.micro_deploy_cap_pct / 100);
      if (microExp!.deployedSol + size > capSol) {
        recordDecision(cand.tokenMint, cand.pool.address, "skipped", "micro_deploy_cap", score, {
          deployed: microExp!.deployedSol, size, capSol, pct: g.micro_deploy_cap_pct,
        });
        continue;
      }
    }
    // One primary position per token (§5) — tranches are the only sanctioned
    // second position and they're opened by the manager, not the entry pipeline.
    if (tokenExposureSol(cand.tokenMint) > 0) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "already_positioned", score, { symbol: cand.symbol });
      continue;
    }
    // Per-token cap (§5).
    const exposure = tokenExposureSol(cand.tokenMint);
    const cap = (bankroll.deployableSol + bankroll.deployedSol) * (config().sizing.per_token_max_pct / 100);
    if (exposure + size > cap) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "per_token_cap", score, { exposure, cap });
      continue;
    }
    // Pool-share cap (§6): never become a dominant share of the pool — the
    // binding size limit as the bankroll grows. Clamp rather than skip; skip
    // only when the clamped size falls under the minimum. Fail-open if the
    // SOL price feed is down (TVL gates still bound the absolute risk).
    const solUsd = await solUsdPrice();
    if (solUsd !== null && solUsd > 0) {
      const sharePct = isMicro ? microPoolSharePct() : g.max_pool_share_pct;
      const shareCapSol = (cand.pool.tvlUsd * (sharePct / 100)) / solUsd;
      if (size > shareCapSol) {
        if (shareCapSol < sizeFloor) {
          recordDecision(cand.tokenMint, cand.pool.address, "skipped", "pool_share", score, { shareCapSol, size, tvlUsd: cand.pool.tvlUsd });
          continue;
        }
        console.log(`[risk] ${cand.symbol}: size ${size.toFixed(2)} -> ${shareCapSol.toFixed(2)} SOL (pool-share cap ${sharePct}% of $${cand.pool.tvlUsd.toFixed(0)} TVL)`);
        size = shareCapSol;
      }
    }

    // --- STALE QUOTE GUARD ---
    // `cand.pool.price` is the scanner sweep's quote, and everything between
    // that sweep and this line — vetting, holders, RugCheck, the SOL feed —
    // is measured in seconds to minutes. The range top is planned AT that
    // price, and every upside exit is measured from the range top, so a stale
    // quote does not just cost a few basis points: it moves the goalposts.
    //
    // CatGPT 2026-08-21, one pool, two bots. The server entered 15:39:14 with
    // its top at bin -579 and took +0.0102 on a P3 win, then +0.0347 on an
    // escape. Railway entered 15:42:19 off a quote the pool had printed at
    // 15:41:23, putting its top at -566 — 13 bins higher on a 1%-per-bin pool.
    // The same price path then cleared the server's top for the full 10-minute
    // P3 sustain but Railway's for only ~4, and the same bounce landed inside
    // the server's escape band and 19 bins short of Railway's. It stopped out
    // at -39.3%. Nothing about the rules differed; the range was in the wrong
    // place because the quote was a minute old.
    //
    // So: re-quote, and if the pool has moved more than the tolerance, SKIP.
    // Skip rather than re-plan on the fresh price, because re-planning is the
    // wrong instinct here — on the CatGPT drift it would have placed the top 4
    // bins HIGHER still. A pool that has run since we scored it has invalidated
    // the score, not just the price. A failed re-quote falls through on the old
    // one: datapi hiccups must not cost every entry.
    let entryPrice = cand.pool.price;
    const driftLimit = config().entry.max_quote_drift_bins ?? DEFAULT_MAX_QUOTE_DRIFT_BINS;
    if (driftLimit > 0 && entryPrice > 0 && cand.pool.binStep > 0) {
      const fresh = await fetchPool(cand.pool.address).catch(() => null);
      if (fresh && fresh.price > 0) {
        const driftBins = Math.log(fresh.price / entryPrice) / Math.log(1 + cand.pool.binStep / 10_000);
        if (Math.abs(driftBins) > driftLimit) {
          recordDecision(cand.tokenMint, cand.pool.address, "skipped", "quote_stale", score, {
            symbol: cand.symbol, quotedPrice: entryPrice, freshPrice: fresh.price,
            driftBins, driftLimit, binStep: cand.pool.binStep,
          });
          console.log(
            `[enter] ${cand.symbol}: quote moved ${driftBins > 0 ? "+" : ""}${driftBins.toFixed(1)} bins ` +
            `since the scan (limit ${driftLimit}) — skipping rather than chasing`
          );
          continue;
        }
        entryPrice = fresh.price;
      }
    }

    // A fine-step pool cannot hold a range as deep as min_down_pct: planRange
    // would silently truncate to the bin-account ceiling and we would enter with
    // a fraction of the intended range. Checked before the candle fetch so a
    // pool we cannot trade properly costs us nothing.
    const reach = depthReachable(config().entry.min_down_pct, cand.pool.binStep, config().entry.max_position_accounts);
    if (!reach.ok) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "range_too_shallow", score, {
        binStep: cand.pool.binStep, minDownPct: config().entry.min_down_pct, ...reach,
      });
      console.log(`[enter] ${cand.symbol}: skip — step ${cand.pool.binStep} needs ${reach.binsNeeded} bins for -${config().entry.min_down_pct}%, cap is ${reach.maxBins}`);
      continue;
    }

    const candles = await fetchCandlesDeep(cand.pool.address, "5m").catch(() => []);
    const planned = planRange(entryPrice, cand.pool.binStep, candles, cand.pool.decimalsX);
    const rent = await applyBinRentGate({
      range: planned,
      score,
      poolAddress: cand.pool.address,
      price: entryPrice,
      binStep: cand.pool.binStep,
      decimalsX: cand.pool.decimalsX,
      minDownPct: config().entry.min_down_pct,
      sizeSol: size,
    });
    if (!rent.ok) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "bin_rent", score, {
        range: rent.range, rent: rent.meta,
      });
      continue;
    }
    if (rent.meta.shrunk) {
      console.log(
        `[enter] ${cand.symbol}: shrunk range for rent ${rent.meta.est.toFixed(3)}→${rent.range.estBinRentSol.toFixed(3)} SOL ` +
        `(depth → ${rent.range.bottomPricePct.toFixed(0)}%)`
      );
    } else if (rent.meta.actual != null && rent.meta.actual < rent.meta.est) {
      console.log(
        `[enter] ${cand.symbol}: actual bin rent ${rent.meta.actual.toFixed(3)} SOL ` +
        `(est ${rent.meta.est.toFixed(3)}, ${rent.meta.tier} budget ${rent.meta.budget})`
      );
    }
    const range = rent.range;

    if (needsDisplacement) {
      const displaced = await tryDisplacement(exec, score, cand.tokenMint);
      if (!displaced) {
        recordDecision(cand.tokenMint, cand.pool.address, "skipped", "displacement_declined", score, { opened, normalCap });
        continue;
      }
    }

    // A failed open used to throw straight past recordDecision to the tick
    // handler, so 121 bounced entries left no row at all and the funnel could
    // not tell "nothing qualified" from "the transaction did not land". It also
    // abandoned the rest of the candidate list and that tick's residual sweep.
    let pos;
    try {
      pos = await withBusy(() => exec.open({
        poolAddress: cand.pool.address,
        tokenMint: cand.tokenMint,
        symbol: cand.symbol,
        sizeSol: size,
        range,
        entryPrice,
      }));
    } catch (e) {
      const err = e as Error & { code?: string; logs?: string[] };
      const msg = (err.message ?? String(e)).split("\n")[0]!.slice(0, 400);
      logError({
        source: "enter",
        code: "open_failed",
        message: `${cand.symbol} open failed: ${msg}`,
        err: e,
        detail: {
          size,
          range,
          code: err.code ?? null,
          logs: Array.isArray(err.logs) ? err.logs.slice(0, 8) : [],
          score,
        },
        symbol: cand.symbol,
        mint: cand.tokenMint,
        pool: cand.pool.address,
        dedupeSec: 15,
      });
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "open_failed", score, {
        size, range,
        error: msg,
        code: err.code ?? null,
        logs: Array.isArray(err.logs) ? err.logs.slice(0, 8) : [],
      });
      continue;
    }
    // Re-price the bankroll after the fill: the DB now carries the new row, so
    // computeBankroll's deployed sum shrinks deployable for the NEXT candidate.
    // A single pre-sweep snapshot let several entries in one sweep collectively
    // overshoot deployable (paper silently; live via failed sends).
    bankroll = computeBankroll(walletSol);

    // Live-experiment cohort tags (2026-08-07): fee-gate path, mcap band, and
    // bonus composition — evaluated against outcomes after ~5 closes each.
    const feePath = cand.pool.feeTvl24hPct >= g.fee_tvl_24h_min_pct ? "24h" : "recent_hot";
    // Where this entry sat against the swing high the planner used. Derivable
    // from range.fibAnchor + entry_price, but only by parsing nested JSON and
    // joining to positions — recorded flat so the question can be asked with a
    // one-line query while the sample builds.
    const swingHigh = range.fibAnchor?.swingHigh;
    const ofSwingHigh = swingHigh && swingHigh > 0 ? entryPrice / swingHigh : null;
    recordDecision(cand.tokenMint, cand.pool.address, "entered", null, score, {
      size, range, vet: vet.facts, pool: cand.pool, kelly, isAlpha, flow,
      sleeve: isMicro ? "micro" : "meme",
      entryOfSwingHigh: ofSwingHigh,
      experiment: { feePath, isMicro, baseScore, trendingBonus, flowBonus, flowPenalty },
    });
    // TELEMETRY ONLY: SIZING-MODE-DECISION.md Gate 3, one row per ENTRY, using
    // the pre-clamp pair captured before the re-entry ladder and pool-share cap
    // (both apply identically to either sizing rule). `posId` is what separates
    // these from the per-tick rows the first cut of this wrote — read Gate 3
    // over rows that carry one.
    recordDecision(cand.tokenMint, cand.pool.address, "skipped", "sizing_flat_deferred", score, {
      ...gate3Sizing, posId: pos.id, symbol: cand.symbol,
    });
    // TELEMETRY ONLY: what a top-blast gate would have refused. One row per
    // entry that crosses the line; nothing is skipped.
    if (ofSwingHigh !== null && ofSwingHigh >= TOP_BLAST_TELEMETRY_FRAC) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "top_blast_candidate", score, {
        posId: pos.id, symbol: cand.symbol, entryPrice, swingHigh, ofSwingHigh,
        threshold: TOP_BLAST_TELEMETRY_FRAC, sleeve: isMicro ? "micro" : "meme",
        rangeTopBin: range.maxBinId, depthPct: range.bottomPricePct,
      });
      console.log(
        `[enter] ${cand.symbol} pos#${pos.id}: entered at ${(ofSwingHigh * 100).toFixed(1)}% of the swing high ` +
        `— top-blast candidate logged (telemetry only, nothing skipped)`
      );
    }
    await alert("entry",
      `${cand.symbol} pos#${pos.id}: entered ${size.toFixed(2)} SOL @ ${entryPrice.toPrecision(4)} (score ${score.toFixed(0)}/base ${baseScore.toFixed(0)}${isAlpha ? ", alpha" : ""}${isMicro ? ", micro" : ""}${feePath === "recent_hot" ? ", recent-hot" : ""}, range depth ${range.bottomPricePct.toFixed(0)}%)${flowNote}\n` +
      `chart: https://gmgn.ai/sol/token/${cand.tokenMint}`);
    console.log(
      `[enter] ${cand.symbol} score=${score.toFixed(1)} size=${size.toFixed(2)} SOL ` +
      `(kelly:${kelly.regime}@${(kelly.appliedFraction * 100).toFixed(1)}%) ` +
      `range=[${range.minBinId},${range.maxBinId}] (${range.bottomPricePct.toFixed(0)}% depth) pos#${pos.id}`
    );

    // Second tranche — wider BidAsk pocket below primary when score clears the
    // gate and the primary left room above the P0-safe floor.
    const te = config().entry;
    if (te.tranche_enabled && score >= te.tranche_score_min && !isMicro) {
      const tSize = size * (te.tranche_size_pct / 100);
      const tFloor = minPositionSol(bankroll.walletSol);
      const slotsLeft = bankroll.effectiveSlots - openPositionCount();
      const roomCap = (bankroll.deployableSol + bankroll.deployedSol) * (config().sizing.per_token_max_pct / 100);
      const roomTok = roomCap - tokenExposureSol(cand.tokenMint);
      if (tSize >= tFloor && slotsLeft >= 1 && tSize <= roomTok) {
        const tPlan = planTrancheRange(
          entryPrice, cand.pool.binStep, candles, cand.pool.decimalsX, range,
        );
        if (tPlan) {
          const tRent = await applyBinRentGate({
            range: tPlan,
            score,
            poolAddress: cand.pool.address,
            price: entryPrice,
            binStep: cand.pool.binStep,
            decimalsX: cand.pool.decimalsX,
            minDownPct: Math.abs(tPlan.bottomPricePct),
            sizeSol: tSize,
          });
          if (tRent.ok) {
            try {
              const tPos = await withBusy(() => exec.open({
                poolAddress: cand.pool.address,
                tokenMint: cand.tokenMint,
                symbol: cand.symbol,
                sizeSol: tSize,
                range: tRent.range,
                entryPrice,
                trancheOf: pos.id,
              }));
              recordDecision(cand.tokenMint, cand.pool.address, "entered", null, score, {
                tranche: true, primaryId: pos.id, size: tSize, range: tRent.range,
              });
              console.log(
                `[enter] ${cand.symbol} TRANCHE size=${tSize.toFixed(2)} SOL ` +
                `range=[${tRent.range.minBinId},${tRent.range.maxBinId}] ` +
                `(${tRent.range.bottomPricePct.toFixed(0)}% depth) pos#${tPos.id} of #${pos.id}`
              );
              await alert("entry",
                `${cand.symbol} tranche pos#${tPos.id} of #${pos.id}: ${tSize.toFixed(2)} SOL ` +
                `(depth ${tRent.range.bottomPricePct.toFixed(0)}%)`);
            } catch (e) {
              const msg = ((e as Error).message ?? String(e)).split("\n")[0]!.slice(0, 200);
              console.error(`[enter] ${cand.symbol} tranche open failed: ${msg}`);
              recordDecision(cand.tokenMint, cand.pool.address, "skipped", "tranche_open_failed", score, {
                primaryId: pos.id, size: tSize, error: msg,
              });
            }
          }
        }
      }
    }
  }
  await enterMajorsPositions(exec, bankroll);
}

/** Main loop: manage every poll_s, enter every interval_s. */
export async function runLoop(): Promise<void> {
  installProcessErrorHooks("farmer");
  acquireInstanceLock();
  syncFarmerModeFromDisk();
  // Dated trail of the settings every position ran under, for the backtester.
  // Once on boot, then on each hot reload; identical content is not re-stored.
  try {
    recordConfigSnapshot(configToml());
    onConfigChange(() => {
      try {
        if (recordConfigSnapshot(configToml())) console.log("[config] settings change recorded to config_history");
      } catch (e) {
        console.error("[config] snapshot failed:", (e as Error).message);
      }
    });
  } catch (e) {
    console.error("[config] snapshot failed:", (e as Error).message);
  }
  let exec: Executor;
  if (isLive()) {
    const { LiveExecutor } = await import("../executor/live.js");
    const live = new LiveExecutor();
    // Chain is truth: reconcile before the manager touches anything (§7).
    // Retry rather than throw. An escaping throw reaches cli.ts's
    // `main().catch(() => process.exit(1))`, and ecosystem.config.cjs sets
    // restart_delay 5000 with no min_uptime — a tsx cold boot always clears the
    // 1s default, so the unstable-restart counter resets every time and the bot
    // crash-loops forever, silently, with money on chain. That is the most
    // likely way this system ever reaches "cannot see its positions", and no
    // watchdog covers it because the loop never starts.
    let rec = null;
    for (let attempt = 1; attempt <= 5 && rec === null; attempt++) {
      try {
        rec = await reconcileLive(live.connection, live.wallet.publicKey);
      } catch (e) {
        // describeError, not `.message`: the boot-path RPC failure this retry
        // exists for arrives as a bare `fetch failed` with the real reason
        // (ENOTFOUND / ECONNREFUSED / TLS) hidden on `.cause`.
        const msg = describeError(e);
        logError({
          source: "farmer",
          code: "reconcile",
          message: `reconcile attempt ${attempt}/5 failed: ${msg}`,
          err: e,
          detail: { attempt },
          dedupeSec: 0,
        });
        if (attempt === 1) await alert("watchdog", `reconcile failed at boot: ${msg} — retrying`).catch(() => {});
        if (attempt === 5) {
          await alert("watchdog", `reconcile failed 5x at boot — refusing to start. Money may be on chain; check manually.`).catch(() => {});
          throw e;
        }
        await new Promise((r) => setTimeout(r, attempt * 5_000));
      }
    }
    console.log(`[farmer] reconcile: ${rec!.dbOpen} db-open, ${rec!.chainPositions} on-chain, ${rec!.orphanedInDb.length} orphaned, ${rec!.adopted.length} adopted`);
    exec = live;
  } else {
    exec = new PaperExecutor();
  }
  // Log the SHA actually running. "watched it boot" only proves the process
  // restarted, not that it restarted onto the code you just wrote.
  // `--dirty` matters more than the SHA here: pm2 runs the WORKING TREE, not
  // HEAD, so a clean-looking SHA on a dirty checkout is precisely the false
  // reassurance this line exists to prevent.
  try { buildSha = resolveBuildLabel(); } catch { /* keep unknown */ }
  console.log(`[farmer] starting in ${exec.mode} mode (pid ${process.pid}, build ${buildSha})`);
  // Retention BEFORE the first tick: a redeploy onto a full volume must be able
  // to reclaim space before anything tries to write, or every write in the
  // first tick fails and the process crash-loops on ENOSPC.
  try { runRetention(); } catch (e) { console.error("[farmer] startup retention failed:", (e as Error).message); }
  startSmartFlow();
  let lastScan = 0;
  let lastSweep = 0;
  let lastRetention = 0;
  let haltCloseDone = false;
  let haltCloseAttempts = 0;
  let pauseLogged = false;

  for (;;) {
    const tickStart = Date.now();
    // Settings/wizard write FARMER_MODE to the volume .env; paper↔live also
    // needs a different Executor subclass — clean exit and let PM2/Railway
    // respawn onto the matching one.
    syncFarmerModeFromDisk();
    const wantMode = isLive() ? "live" : "paper";
    if (wantMode !== exec.mode) {
      console.log(`[farmer] mode gate is ${wantMode} but executor is ${exec.mode} — restarting`);
      process.exit(0);
    }
    const pollMs = config().manage.poll_s * 1000;
    if (haltRequested()) {
      // Idle (don't exit) so PM2/Railway don't restart-loop while HALT is set.
      if (!haltCloseDone) {
        console.log("[farmer] HALT — closing open positions, then idling until HALT is cleared");
        // Per-position try/catch, and this whole branch sits outside the tick
        // try: one throwing close (likely, since operators HALT during RPC
        // trouble) used to escape runLoop → process.exit(1) → PM2 restart →
        // same position throws again — a silent crash-loop that never even
        // attempted the positions after the poison one. Now we close what we
        // can and retry the rest every idle cycle until the book is empty.
        haltCloseAttempts++;
        let failed = 0;
        for (const pos of loadOpenPositions()) {
          try {
            await closeAndReport(exec, pos, "manual", config().exec.exit_slippage_bps, "close", "manual HALT");
          } catch (e) {
            failed++;
            logError({
              source: "manager", code: "halt_close",
              message: `HALT close failed for pos#${pos.id} ${pos.symbol}: ${(e as Error).message}`,
              err: e, dedupeSec: 60,
            });
          }
        }
        if (failed === 0) {
          haltCloseDone = true;
          haltCloseAttempts = 0;
          await alert("watchdog", "HALT active — positions closed; bot idle until Resume").catch(() => {});
        } else if (haltCloseAttempts === 1 || haltCloseAttempts % 12 === 0) {
          await alert("watchdog",
            `HALT: ${failed} position close(s) failing (attempt ${haltCloseAttempts}) — retrying every cycle until clear`
          ).catch(() => {});
        }
      }
      // Real book count, not 0: HALT can still have open positions while
      // closes fail, and the dashboard/heartbeat checker read this.
      await writeHeartbeat(exec, loadOpenPositions().length);
      await new Promise((r) => setTimeout(r, Math.min(pollMs, 5_000)));
      continue;
    }
    if (haltCloseDone) {
      console.log("[farmer] HALT cleared — resuming manage/entry loop");
      haltCloseDone = false;
    }
    if (pauseRequested()) {
      if (!pauseLogged) {
        console.log("[farmer] PAUSE — trading engine off; positions left open until ON");
        pauseLogged = true;
      }
      // PAUSE explicitly leaves the book open — report the real count.
      await writeHeartbeat(exec, loadOpenPositions().length);
      await new Promise((r) => setTimeout(r, Math.min(pollMs, 5_000)));
      continue;
    }
    if (pauseLogged) {
      console.log("[farmer] PAUSE cleared — trading engine on");
      pauseLogged = false;
    }
    // Probe first and outside the shared try: watchdogCheck used to sit after
    // managePositions inside one try, so a throw from config() or
    // loadOpenPositions() skipped BOTH the health refresh and the watchdog —
    // arming and muting the supervisor in the same instant, leaving only a
    // console line.
    await rpcProbe(exec);
    try { await watchdogCheck(); } catch (e) {
      logError({ source: "watchdog", code: "check", message: (e as Error).message, err: e, dedupeSec: 60 });
    }
    try {
      await managePositions(exec);
      // Follow chains tick at poll cadence, not scanner cadence — dip detection
      // on a 15% retrace needs finer sampling than the 60s scan. Frozen entries
      // freeze follow legs too: both add exposure.
      if (!entriesFrozen()) {
        try {
          await tickFollowChains(exec);
        } catch (e) {
          logError({ source: "follow", code: "tick", message: (e as Error).message, err: e, dedupeSec: 60 });
        }
      }
      const due = scanDue(Date.now() - lastScan, config().scanner.interval_s * 1000, pollMs);
      if (entriesFrozen()) {
        if (due) {
          lastScan = Date.now();
          console.warn(`[farmer] entries frozen — ${probeFailures} consecutive RPC probe failures`);
        }
      } else if (due) {
        // Defer scan when manage already ate the poll window — otherwise a close
        // + fixed sleep stacked to 70–80s mark gaps (RANGE-SHAPE integrity (a)).
        if (Date.now() - tickStart < pollMs) {
          lastScan = Date.now();
          await enterNewPositions(exec);
        } else {
          console.warn(`[farmer] deferring entry scan — tick already ${Date.now() - tickStart}ms (poll ${pollMs}ms)`);
        }
      }
      if (exec.sweepResiduals && Date.now() - lastSweep > RESIDUAL_SWEEP_INTERVAL_MS) {
        if (Date.now() - tickStart < pollMs) {
          lastSweep = Date.now();
          for (const r of await exec.sweepResiduals(RESIDUAL_SWEEP_MIN_SOL)) {
            const tag = r.positionId ? ` pos#${r.positionId}` : "";
            let restated = "";
            if (r.positionId) {
              const p = getDb().prepare(
                "SELECT open_cost_sol o, close_return_sol c, fees_measured_sol f, recovered_sol v, withdrawn_sol w FROM positions WHERE id = ?"
              ).get(r.positionId) as { o: number | null; c: number | null; f: number; v: number; w: number } | undefined;
              if (p?.o != null && p.c != null) {
                restated = `\n${r.symbol} pos#${r.positionId} true PnL now ${(p.c + p.f + p.v + p.w - p.o >= 0 ? "+" : "")}${(p.c + p.f + p.v + p.w - p.o).toFixed(4)} SOL`;
              }
            }
            await alert("claim", `🧹 [sweep] sold stranded ${r.symbol}${tag} residue for ${r.soldSol.toFixed(4)} SOL${restated}`);
          }
        } else {
          console.warn(`[farmer] deferring residual sweep — tick already ${Date.now() - tickStart}ms`);
        }
      }
      if (Date.now() - lastRetention > RETENTION_INTERVAL_MS) {
        lastRetention = Date.now();
        runRetention();
      }
    } catch (e) {
      logError({
        source: "farmer",
        code: "tick",
        message: (e as Error).message,
        err: e,
        dedupeSec: 20,
      });
    }
    await writeHeartbeat(exec, loadOpenPositions().length);
    await new Promise((r) => setTimeout(r, pollSleepMs(Date.now() - tickStart, pollMs)));
  }
}
