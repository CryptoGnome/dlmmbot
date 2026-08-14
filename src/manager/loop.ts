import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config, isLive } from "../config.js";
import { reconcileLive } from "./reconcile.js";
import { alert, type AlertKind } from "../alerts.js";
import { blacklist, getDb, now, recordDecision, REALIZED_PNL_SQL, logError, installProcessErrorHooks } from "../db/db.js";
import type { Executor } from "../executor/executor.js";
import { LiveExecutor } from "../executor/live.js";
import { executeProfitBurn, profitBurnSpendSol, accrueProfitBurn, readProfitBurnAccrued, writeProfitBurnAccrued } from "../executor/profitBurn.js";
import { PaperExecutor } from "../executor/paper.js";
import { rollupDaily } from "../pnl/rollup.js";
import { fetchSummary } from "../vetting/rugcheck.js";
import { planRange, planTrancheRange } from "../ranges/planner.js";
import { applyBinRentGate } from "../ranges/binRent.js";
import { fetchCandles, fetchPool } from "../scanner/meteora.js";
import { trendingByMint } from "../scanner/gmgn.js";
import { feeMomentumPart, opportunityScore, structurePart, turnoverPart } from "../scanner/score.js";
import { scan } from "../scanner/scan.js";
import { flowFor, startSmartFlow } from "../scanner/smartflow.js";
import { armFollowChain, hasActiveFollowChain, onFollowLegClosed, tickFollowChains } from "./follow.js";
import { clearHolderWatch, holderCheck } from "./holderwatch.js";
import { sol24hChangePct, solUsdPrice } from "../market.js";
import { circuitBreakerTripped, clusterBrakeTripped, computeBankroll, kellyStats, openPositionCount, positionSize, regimeFactor, tokenExposureSol } from "../risk/limits.js";
import { applyMicroSize, isMicroMcap, microPoolSharePct, microSleeveExposure } from "../risk/micro.js";
import { enterMajorsPositions } from "./majorsEntry.js";
import { manageForSleeve } from "../risk/majorsManage.js";
import { sleeveAtEntry } from "../risk/sleeve.js";
import type { Position } from "../types.js";
import { vetToken } from "../vetting/vet.js";

// STRATEGY.md §4 — P0–P5 state machine. Live: P0 (TVL/price/rugcheck + GMGN
// holder-watch), P1–P5, escape hatch, follow, micro/majors sleeves, residual
// sweep, heartbeat. Second tranche: dual-range BidAsk below primary (score gate).

const HALT_FILE = resolve(process.cwd(), "HALT");
const PAUSE_FILE = resolve(process.cwd(), "PAUSE");
const LOCK_FILE = resolve(process.cwd(), "data", "farmer.lock");

// Residual sweep: retry-sell tokens stranded by failed zap-out swaps.
const RESIDUAL_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const RESIDUAL_SWEEP_MIN_SOL = 0.002; // below this, tx fees eat the proceeds

// Per-position manager state (all in-memory; rebuilt after restart).
const aboveRangeSince = new Map<number, number>();   // P3 sustain timer
const belowRangeSince = new Map<number, number>();   // P5 grace timer
const tvlHistory = new Map<number, Array<{ ts: number; tvl: number }>>(); // P0 TVL-drop window
const decayStreak = new Map<number, number>();        // P2 consecutive decay polls
const rugcheckLastCheck = new Map<number, number>();  // P0 rugcheck-flip throttle
const everInRange = new Set<number>();                // P3 win-vs-missed classification
const fellDeep = new Set<number>();                   // escape hatch armed (also persisted)

/** Clear in-memory per-position timers for unit tests (ids reuse across memory DB resets). */
export function resetManagerStateForTests(): void {
  aboveRangeSince.clear();
  belowRangeSince.clear();
  tvlHistory.clear();
  decayStreak.clear();
  rugcheckLastCheck.clear();
  everInRange.clear();
  fellDeep.clear();
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
  const res = await exec.close(pos, reason, slippageBps);
  // Re-read fees and actual wallet deltas: the close itself may claim
  // outstanding fees, and open_cost/close_return carry the real rent+tx costs.
  const row = getDb().prepare(
    "SELECT fees_claimed_sol, fees_measured_sol, recovered_sol, open_cost_sol, close_return_sol, fees_at_close_sol FROM positions WHERE id = ?"
  ).get(pos.id) as {
    fees_claimed_sol: number; fees_measured_sol: number; recovered_sol: number;
    open_cost_sol: number | null; close_return_sol: number | null; fees_at_close_sol: number;
  } | undefined;
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
    ? row.close_return_sol + row.fees_measured_sol + row.recovered_sol - row.open_cost_sol
    : null;
  const pnl = measuredPnl ?? markPnl;
  const pctBase = measuredPnl != null && row?.open_cost_sol ? row.open_cost_sol : pos.entrySol;
  const pct = pctBase > 0 ? (pnl / pctBase) * 100 : 0;
  const holdH = (now() - pos.entryTs) / 3600;
  const hold = holdH < 1 ? `${(holdH * 60).toFixed(0)}m` : `${holdH.toFixed(1)}h`;
  let trueLine = "";
  if (measuredPnl != null && row) {
    trueLine = `\ntrue PnL (measured): ${measuredPnl >= 0 ? "+" : ""}${measuredPnl.toFixed(4)} SOL` +
      ` [in ${row.open_cost_sol!.toFixed(4)} → out ${(row.close_return_sol! + row.fees_measured_sol + row.recovered_sol).toFixed(4)}]`;
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
 * 1% of measured net profit → Jupiter buy burn-mint → burn immediately.
 * Accrual pot only holds leftover if a swap fails (retry on next flush).
 * Skips when measured columns are missing or PnL ≤ 0.
 */
async function maybeProfitBurn(
  exec: Executor,
  pos: Position,
  measuredPnl: number | null,
): Promise<void> {
  const cfg = config().profit_burn;
  if (!cfg?.enabled) return;
  if (measuredPnl == null) {
    console.log(`[profit_burn] skip pos#${pos.id}: no measured wallet PnL (legacy/mark-only close)`);
    return;
  }
  const spend = profitBurnSpendSol(measuredPnl, cfg.profit_frac);
  if (spend == null) return;

  const accrued = accrueProfitBurn(
    spend,
    `pos#${pos.id} ${pos.symbol} pnl=+${measuredPnl.toFixed(6)} share=${spend.toFixed(6)}`,
  );
  console.log(
    `[profit_burn] +${spend.toFixed(6)} SOL from pos#${pos.id} ${pos.symbol} ` +
      `(${(cfg.profit_frac * 100).toFixed(0)}% of +${measuredPnl.toFixed(4)}) → pot ${accrued.toFixed(6)}`,
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
  const cfg = config().profit_burn;
  if (!cfg?.enabled) return;
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
      `[profit_burn] paper: would spend pot ${accrued.toFixed(4)} SOL → burn ${cfg.mint.slice(0, 8)}…`,
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
  console.log(
    `[profit_burn] spent ${result.spentSol.toFixed(4)} SOL → burned ${result.burnedRaw} ` +
      `swap=${result.swapSig} burn=${result.burnSig}`,
  );
  await alert(
    "profit_burn",
    `profit burn pot ${result.spentSol.toFixed(4)} SOL` +
      (ctx ? ` (last leg ${ctx.symbol} pos#${ctx.positionId})` : "") +
      `\nburned → ${cfg.mint}\nswap ${result.swapSig}\nburn ${result.burnSig}`,
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
function tvlDropTriggered(posId: number, tvlNow: number): boolean {
  const m = config().manage;
  const windowS = 600; // 10 min per spec
  const hist = tvlHistory.get(posId) ?? [];
  hist.push({ ts: now(), tvl: tvlNow });
  while (hist.length && hist[0]!.ts < now() - windowS) hist.shift();
  tvlHistory.set(posId, hist);
  if (hist.length < 4) return false;
  const sorted = hist.map((h) => h.tvl).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const dropped = (t: number) => median > 0 && ((median - t) / median) * 100 >= m.safety_tvl_drop_pct;
  return dropped(tvlNow) && dropped(hist[hist.length - 2]!.tvl);
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
  return existsSync(HALT_FILE);
}

/** Soft pause: no manage/entry/sweep; leave positions open. */
export function pauseRequested(): boolean {
  return existsSync(PAUSE_FILE);
}

/**
 * Single-instance lock. Incident 2026-08-07: four orphaned loops (Windows
 * process-tree kills only reach the npm wrapper) shared one DB and corrupted
 * each other's positions. Refuses to start while another live PID holds the
 * lock; stale locks (dead PID) are reclaimed.
 */
function acquireInstanceLock(): void {
  mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
  if (existsSync(LOCK_FILE)) {
    const oldPid = Number(readFileSync(LOCK_FILE, "utf8").trim());
    let alive = false;
    try {
      process.kill(oldPid, 0); // signal 0 = existence check
      alive = true;
    } catch {
      alive = false;
    }
    if (alive && oldPid !== process.pid) {
      throw new Error(
        `another farmer instance is already running (pid ${oldPid}). ` +
        `Stop it first — two instances on one DB corrupt each other's positions.`
      );
    }
    console.log(`[farmer] reclaiming stale lock from dead pid ${oldPid}`);
  }
  writeFileSync(LOCK_FILE, String(process.pid));
  const release = () => { try { rmSync(LOCK_FILE, { force: true }); } catch { /* best effort */ } };
  process.on("exit", release);
  process.on("SIGINT", () => { release(); process.exit(130); });
  process.on("SIGTERM", () => { release(); process.exit(143); });
}

function loadOpenPositions(): Position[] {
  const rows = getDb().prepare(
    `SELECT id, mode, pool, token_mint, symbol, tranche_of, entry_ts, entry_price, entry_sol,
            min_bin_id, max_bin_id, state, fees_claimed_sol, rent_paid_sol, profit_lock_fires,
            exit_ts, exit_sol, exit_reason, follow_chain_id
     FROM positions WHERE state IN ('open','pending')`
  ).all() as Array<Record<string, unknown>>;
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
  }));
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

  for (const pos of positions) {
    try {
      if (exec instanceof PaperExecutor) await exec.accrueFees(pos, m.poll_s);
      const mark = await exec.mark(pos);
      unrealizedSol += mark.valueSol - pos.entrySol;
      const valueFrac = pos.entrySol > 0 ? mark.valueSol / pos.entrySol : 1;
      try {
        getDb().prepare(
          `INSERT INTO position_marks
             (position_id, ts, active_bin_id, price, value_sol, value_frac, unclaimed_fees_sol, in_range)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(pos.id, now(), mark.activeBinId, mark.price, mark.valueSol, valueFrac,
              mark.unclaimedFeesSol, mark.inRange ? 1 : 0);
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
      const ageH = (now() - pos.entryTs) / 3600;
      const valueFrac = pos.entrySol > 0 ? mark.valueSol / pos.entrySol : 1;
      const sleeve = sleeveAtEntry(pos);
      const pm = manageForSleeve(sleeve);

      // --- P0 SAFETY: pool death, price crash, TVL drain, rugcheck flip, holder watch ---
      // Majors are allowlisted / discovery-gated at entry — RugCheck "Danger" is often a
      // permanent score on established tokens (PUMP etc.), not a flip. Applying the meme
      // veto here false-closed pos#61 in 7s. Keep hard P0 (dead/crash/TVL) for majors.
      const crashed = mark.price > 0 && pos.entryPrice > 0 &&
        ((mark.price - pos.entryPrice) / pos.entryPrice) * 100 <= m.safety_price_crash_pct;
      const tvlDrained = mark.tvlUsd > 0 && tvlDropTriggered(pos.id, mark.tvlUsd);
      const rugFlip = sleeve !== "majors" && !crashed && !tvlDrained && mark.valueSol > 0
        && await rugcheckFlipped(pos.id, pos.tokenMint);
      const holderTrig = sleeve !== "majors" && exec.mode === "live" && !crashed && !tvlDrained && !rugFlip
        ? await holderCheck(pos.id, pos.tokenMint) : null;
      if (mark.valueSol === 0 || crashed || tvlDrained || rugFlip || holderTrig) {
        const trigger = mark.valueSol === 0 ? "pool_dead" : crashed ? "price_crash" : tvlDrained ? "tvl_drain" : rugFlip ? "rugcheck_flip" : `${holderTrig!.kind} (${holderTrig!.detail})`;
        clearRangeTimers(pos.id);
        await closeAndReport(exec, pos, "P0_safety", config().exec.safety_exit_slippage_bps, "safety_exit", `P0 safety (${trigger})`);
        // Don't permanent-blacklist majors allowlist tokens on soft P0 signals.
        if (sleeve !== "majors" || trigger === "pool_dead" || trigger === "price_crash" || trigger === "tvl_drain") {
          blacklist(pos.tokenMint, "token", `P0 safety exit (${trigger})`);
        }
        recordDecision(pos.tokenMint, pos.poolAddress, "exited", `P0_safety_${trigger}`, null, { mark, pos, sleeve });
        continue;
      }

      // --- P1 STOP LOSS ---
      if (valueFrac < pm.stop_loss_frac) {
        clearRangeTimers(pos.id);
        await closeAndReport(exec, pos, "P1_stop", config().exec.exit_slippage_bps, "stop_loss", `stop loss at ${(valueFrac * 100 - 100).toFixed(1)}%`);
        blacklist(pos.tokenMint, "token", "stop loss cooldown", m.loss_reentry_cooldown_h);
        recordDecision(pos.tokenMint, pos.poolAddress, "exited", "P1_stop", null, { valueFrac, mark });
        continue;
      }

      // --- P2 ROTATION: age limit + consecutive fee/volume decay ---
      if (ageH > pm.max_age_h) {
        clearRangeTimers(pos.id);
        await closeAndReport(exec, pos, "P2_rotation", config().exec.exit_slippage_bps, "close", `rotation: max age ${pm.max_age_h}h reached`);
        recordDecision(pos.tokenMint, pos.poolAddress, "exited", "P2_rotation_age", null, { ageH, sleeve });
        continue;
      }
      const feeDaily = mark.feeTvl30mPct * 48;
      const decayed = feeDaily < pm.rotation_fee_daily_min_pct || mark.vol30mUsd < pm.rotation_vol_30m_min_usd;
      const streak = decayed ? (decayStreak.get(pos.id) ?? 0) + 1 : 0;
      decayStreak.set(pos.id, streak);
      if (streak >= pm.rotation_polls) {
        clearRangeTimers(pos.id);
        const { exitSol } = await closeAndReport(exec, pos, "P2_rotation", config().exec.exit_slippage_bps, "close", `rotation: fee/volume decay (fee ${feeDaily.toFixed(3)}%/d, vol30m $${mark.vol30mUsd.toFixed(0)})`);
        bankProfit(pos, exitSol, "P2 rotation");
        recordDecision(pos.tokenMint, pos.poolAddress, "exited", "P2_rotation_decay", null, { feeDaily, vol30m: mark.vol30mUsd, streak });
        console.log(`[manager] pos#${pos.id} ${pos.symbol}: rotated out (fee ${feeDaily.toFixed(3)}%/d, vol30m $${mark.vol30mUsd.toFixed(0)})`);
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
          aboveRangeSince.set(pos.id, now());
        } else if (now() - since >= sustainMin * 60) {
          const classification = traveled ? "win" : "missed";
          clearRangeTimers(pos.id);
          const { exitSol } = await closeAndReport(
            exec, pos, "P3_above", config().exec.exit_slippage_bps, "close",
            classification === "win" ? "take-profit (price traveled through range)" : "missed (price jumped over range)"
          );
          if (classification === "missed")
            getDb().prepare("UPDATE positions SET state='closed_missed' WHERE id=?").run(pos.id);
          else bankProfit(pos, exitSol, "P3 take-profit");
          recordDecision(pos.tokenMint, pos.poolAddress, "exited", `P3_above_${classification}`, null, { mark, sustainedS: now() - since, exitSol, sustainMin, sleeve });
          if (pos.followChainId == null && sleeve !== "majors") armFollowChain(pos, mark.price);
        }
        continue;
      }
      aboveRangeSince.delete(pos.id);

      // --- P5 BELOW RANGE (grace timer, §4 P5: wick tolerance) ---
      if (mark.belowRange) {
        const since = belowRangeSince.get(pos.id);
        if (since === undefined) {
          belowRangeSince.set(pos.id, now());
          console.log(`[manager] pos#${pos.id} ${pos.symbol} below range — grace timer started (${pm.below_range_grace_min}m)`);
          if (mark.unclaimedFeesSol >= m.grace_claim_min_sol) {
            try {
              const { claimedSol } = await exec.claimFees(pos);
              await alert("claim", `${pos.symbol} pos#${pos.id}: grace-start claim — banked ${claimedSol.toFixed(4)} SOL before below-range wait`);
            } catch (e) {
              console.error(`[manager] pos#${pos.id} grace-start claim failed:`, (e as Error).message);
            }
          }
        } else if (now() - since >= pm.below_range_grace_min * 60) {
          clearRangeTimers(pos.id);
          await closeAndReport(exec, pos, "P5_below", config().exec.exit_slippage_bps, "below_cut", `below-range cut after ${pm.below_range_grace_min}m grace`);
          blacklist(pos.tokenMint, "token", "below range cut", m.loss_reentry_cooldown_h);
          recordDecision(pos.tokenMint, pos.poolAddress, "exited", "P5_below", null, { mark, graceS: now() - since });
        }
        continue;
      }
      belowRangeSince.delete(pos.id);

      // --- ESCAPE HATCH (meme only by default) ---
      if (pos.followChainId == null && (sleeve !== "majors" || config().majors.escape_hatch_enabled)) {
        const depth = pos.maxBinId - pos.minBinId;
        const frac = depth > 0 ? (pos.maxBinId - mark.activeBinId) / depth : 0;
        if (frac >= pm.escape_hatch_depth_pct / 100) {
          if (!fellDeep.has(pos.id)) {
            fellDeep.add(pos.id);
            getDb().prepare("UPDATE positions SET fell_deep = 1 WHERE id = ?").run(pos.id);
            console.log(`[manager] pos#${pos.id} ${pos.symbol}: fell through ${(frac * 100).toFixed(0)}% of range — escape hatch armed`);
          }
        } else if (frac <= pm.escape_hatch_recovery_pct / 100) {
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
              recordDecision(pos.tokenMint, pos.poolAddress, "exited", "escape_rebalance", null, { frac, mark, sleeve });
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
              "escape hatch: deep dip recovered to range top — reset (close fallback)");
            bankProfit(pos, exitSol, "escape hatch");
            recordDecision(pos.tokenMint, pos.poolAddress, "exited", "escape_hatch", null, { frac, mark, sleeve });
            continue;
          }
        }
      }

      // --- P4 IN RANGE: claim / compound + profit lock ---
      if (mark.unclaimedFeesSol >= pm.claim_min_sol) {
        if (sleeve === "majors" && config().majors.fee_compound && exec.mode === "paper") {
          getDb().prepare("UPDATE positions SET entry_sol = entry_sol + ?, fees_claimed_sol = fees_claimed_sol + ? WHERE id = ?")
            .run(mark.unclaimedFeesSol, mark.unclaimedFeesSol, pos.id);
          getDb().prepare(
            "INSERT INTO events (position_id, ts, type, sol_delta, detail_json) VALUES (?, ?, 'claim', ?, ?)"
          ).run(pos.id, now(), mark.unclaimedFeesSol, JSON.stringify({ kind: "majors_compound" }));
          console.log(`[majors] pos#${pos.id} ${pos.symbol}: compounded ${mark.unclaimedFeesSol.toFixed(4)} SOL fees`);
        } else {
          const { claimedSol } = await exec.claimFees(pos);
          await alert("claim", `${pos.symbol} pos#${pos.id}: claimed ${claimedSol.toFixed(4)} SOL in fees`);
        }
      }
      if (
        pm.profit_lock_enabled &&
        pos.profitLockFires < m.profit_lock_max_fires &&
        valueFrac >= m.profit_lock_at_frac
      ) {
        const { withdrawnSol } = await exec.withdraw(pos, m.profit_lock_withdraw_pct * 100);
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

  const bankroll = computeBankroll(walletSol);
  const rot = config().rotation;
  const normalCap = Math.max(0, bankroll.effectiveSlots - rot.alpha_slots);

  const { candidates } = await scan();
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
    const vet = await vetToken(cand.tokenMint, poolCreatedAtMs);
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
    let admitted = opened < normalCap || (isAlpha && opened < bankroll.effectiveSlots);
    if (!admitted && isAlpha) admitted = await tryDisplacement(exec, score, cand.tokenMint);
    if (!admitted) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", isAlpha ? "displacement_declined" : "alpha_reserved", score, { opened, normalCap });
      continue;
    }

    const kelly = kellyStats();
    let size = positionSize(bankroll, score);
    if (size <= 0) {
      const gate = kelly.regime === "negative_edge" ? "kelly_negative_edge" : "size_zero";
      if (kelly.regime === "negative_edge")
        console.log(`[risk] Kelly estimates negative edge (f*=${kelly.fullKelly?.toFixed(3)}, n=${kelly.samples}) — entries blocked`);
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", gate, score, { bankroll, kelly });
      continue;
    }
    // Re-entry ladder (§4 P3): each same-token entry within 24h shrinks by
    // reentry_ladder_mult; hard stop after reentry_max_per_24h re-entries.
    const m = config().manage;
    const priorEntries24h = (getDb().prepare(
      "SELECT COUNT(*) AS c FROM positions WHERE token_mint = ? AND entry_ts > ?"
    ).get(cand.tokenMint, now() - 86_400) as { c: number }).c;
    if (priorEntries24h > m.reentry_max_per_24h) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "reentry_limit", score, { priorEntries24h });
      continue;
    }
    size *= Math.pow(m.reentry_ladder_mult, priorEntries24h);
    size *= regime; // regime filter halves sizing in a SOL downdraft
    if (isMicro) size = applyMicroSize(size);
    // Viability floor, applied once, here — AFTER the ladder and regime have
    // had their say. A re-entry gets the lower floor because it reuses a token
    // account the first entry already paid rent for (see min_reentry_sol).
    // `?? min_position_sol`, not a bare read: config() is a hot-reloaded raw
    // TOML parse cast to Config, so a missing key is undefined at runtime — and
    // `size < undefined` is false, which would remove the floor entirely rather
    // than fall back to it.
    const sizeFloor = priorEntries24h > 0
      ? (config().sizing.min_reentry_sol ?? config().sizing.min_position_sol)
      : config().sizing.min_position_sol;
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

    const candles = await fetchCandles(cand.pool.address, "5m").catch(() => []);
    const planned = planRange(cand.pool.price, cand.pool.binStep, candles, cand.pool.decimalsX);
    const rent = await applyBinRentGate({
      range: planned,
      score,
      poolAddress: cand.pool.address,
      price: cand.pool.price,
      binStep: cand.pool.binStep,
      decimalsX: cand.pool.decimalsX,
      minDownPct: config().entry.min_down_pct,
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

    // A failed open used to throw straight past recordDecision to the tick
    // handler, so 121 bounced entries left no row at all and the funnel could
    // not tell "nothing qualified" from "the transaction did not land". It also
    // abandoned the rest of the candidate list and that tick's residual sweep.
    let pos;
    try {
      pos = await exec.open({
        poolAddress: cand.pool.address,
        tokenMint: cand.tokenMint,
        symbol: cand.symbol,
        sizeSol: size,
        range,
        entryPrice: cand.pool.price,
      });
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
    // Live-experiment cohort tags (2026-08-07): fee-gate path, mcap band, and
    // bonus composition — evaluated against outcomes after ~5 closes each.
    const feePath = cand.pool.feeTvl24hPct >= g.fee_tvl_24h_min_pct ? "24h" : "recent_hot";
    recordDecision(cand.tokenMint, cand.pool.address, "entered", null, score, {
      size, range, vet: vet.facts, pool: cand.pool, kelly, isAlpha, flow,
      sleeve: isMicro ? "micro" : "meme",
      experiment: { feePath, isMicro, baseScore, trendingBonus, flowBonus, flowPenalty },
    });
    await alert("entry",
      `${cand.symbol} pos#${pos.id}: entered ${size.toFixed(2)} SOL @ ${cand.pool.price.toPrecision(4)} (score ${score.toFixed(0)}/base ${baseScore.toFixed(0)}${isAlpha ? ", alpha" : ""}${isMicro ? ", micro" : ""}${feePath === "recent_hot" ? ", recent-hot" : ""}, range depth ${range.bottomPricePct.toFixed(0)}%)${flowNote}\n` +
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
      const tFloor = config().sizing.min_position_sol;
      const slotsLeft = bankroll.effectiveSlots - openPositionCount();
      const roomCap = (bankroll.deployableSol + bankroll.deployedSol) * (config().sizing.per_token_max_pct / 100);
      const roomTok = roomCap - tokenExposureSol(cand.tokenMint);
      if (tSize >= tFloor && slotsLeft >= 1 && tSize <= roomTok) {
        const tPlan = planTrancheRange(
          cand.pool.price, cand.pool.binStep, candles, cand.pool.decimalsX, range,
        );
        if (tPlan) {
          const tRent = await applyBinRentGate({
            range: tPlan,
            score,
            poolAddress: cand.pool.address,
            price: cand.pool.price,
            binStep: cand.pool.binStep,
            decimalsX: cand.pool.decimalsX,
            minDownPct: Math.abs(tPlan.bottomPricePct),
          });
          if (tRent.ok) {
            try {
              const tPos = await exec.open({
                poolAddress: cand.pool.address,
                tokenMint: cand.tokenMint,
                symbol: cand.symbol,
                sizeSol: tSize,
                range: tRent.range,
                entryPrice: cand.pool.price,
                trancheOf: pos.id,
              });
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
        const msg = (e as Error).message.split("\n")[0];
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
  try { buildSha = execSync("git describe --always --dirty", { encoding: "utf8" }).trim(); } catch { /* not a checkout */ }
  console.log(`[farmer] starting in ${exec.mode} mode (pid ${process.pid}, build ${buildSha})`);
  startSmartFlow();
  let lastScan = 0;
  let lastSweep = 0;
  let haltCloseDone = false;
  let pauseLogged = false;

  for (;;) {
    const tickStart = Date.now();
    const pollMs = config().manage.poll_s * 1000;
    if (haltRequested()) {
      // Idle (don't exit) so PM2/Railway don't restart-loop while HALT is set.
      if (!haltCloseDone) {
        console.log("[farmer] HALT — closing open positions, then idling until HALT is cleared");
        for (const pos of loadOpenPositions()) {
          await closeAndReport(exec, pos, "manual", config().exec.exit_slippage_bps, "close", "manual HALT");
        }
        haltCloseDone = true;
        await alert("watchdog", "HALT active — positions closed; bot idle until Resume").catch(() => {});
      }
      await writeHeartbeat(exec, 0);
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
      await writeHeartbeat(exec, 0);
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
      if (entriesFrozen()) {
        if (Date.now() - lastScan > config().scanner.interval_s * 1000) {
          lastScan = Date.now();
          console.warn(`[farmer] entries frozen — ${probeFailures} consecutive RPC probe failures`);
        }
      } else if (Date.now() - lastScan > config().scanner.interval_s * 1000) {
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
                "SELECT open_cost_sol o, close_return_sol c, fees_measured_sol f, recovered_sol v FROM positions WHERE id = ?"
              ).get(r.positionId) as { o: number | null; c: number | null; f: number; v: number } | undefined;
              if (p?.o != null && p.c != null) {
                restated = `\n${r.symbol} pos#${r.positionId} true PnL now ${(p.c + p.f + p.v - p.o >= 0 ? "+" : "")}${(p.c + p.f + p.v - p.o).toFixed(4)} SOL`;
              }
            }
            await alert("claim", `🧹 [sweep] sold stranded ${r.symbol}${tag} residue for ${r.soldSol.toFixed(4)} SOL${restated}`);
          }
        } else {
          console.warn(`[farmer] deferring residual sweep — tick already ${Date.now() - tickStart}ms`);
        }
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
