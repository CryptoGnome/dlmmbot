import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config, isLive } from "../config.js";
import { reconcileLive } from "./reconcile.js";
import { alert, type AlertKind } from "../alerts.js";
import { blacklist, getDb, now, recordDecision } from "../db/db.js";
import type { Executor } from "../executor/executor.js";
import { PaperExecutor } from "../executor/paper.js";
import { rollupDaily } from "../pnl/rollup.js";
import { fetchSummary } from "../vetting/rugcheck.js";
import { planRange } from "../ranges/planner.js";
import { fetchCandles, fetchPool } from "../scanner/meteora.js";
import { trendingByMint } from "../scanner/gmgn.js";
import { feeMomentumPart, opportunityScore, structurePart, turnoverPart } from "../scanner/score.js";
import { scan } from "../scanner/scan.js";
import { flowFor, startSmartFlow } from "../scanner/smartflow.js";
import { clearHolderWatch, holderCheck } from "./holderwatch.js";
import { sol24hChangePct, solUsdPrice } from "../market.js";
import { circuitBreakerTripped, computeBankroll, kellyStats, openPositionCount, positionSize, regimeFactor, tokenExposureSol } from "../risk/limits.js";
import type { Position } from "../types.js";
import { vetToken } from "../vetting/vet.js";

// STRATEGY.md §4 — the P0-P5 state machine, strict priority order.
// Scaffold status: entry pipeline + P1/P2/P3(basic)/P4-claim/P5 are functional
// in paper mode. P0 safety triggers, escape hatch, tranches, re-entry ladder,
// and the regime filter are TODO(phase 2) — marked inline.

const HALT_FILE = resolve(process.cwd(), "HALT");
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

// Watchdog / breaker state.
let lastHealthyTick = Date.now();
let watchdogAlerted = false;
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
    "SELECT fees_claimed_sol, fees_measured_sol, recovered_sol, open_cost_sol, close_return_sol FROM positions WHERE id = ?"
  ).get(pos.id) as {
    fees_claimed_sol: number; fees_measured_sol: number; recovered_sol: number;
    open_cost_sol: number | null; close_return_sol: number | null;
  } | undefined;
  const fees = row?.fees_claimed_sol ?? pos.feesClaimedSol;
  const pnl = res.exitSol + fees - pos.entrySol;
  const pct = pos.entrySol > 0 ? (pnl / pos.entrySol) * 100 : 0;
  const holdH = (now() - pos.entryTs) / 3600;
  const hold = holdH < 1 ? `${(holdH * 60).toFixed(0)}m` : `${holdH.toFixed(1)}h`;
  // True PnL: measured wallet flows only — what the wallet actually gained,
  // never a pool-mid mark. `pnl` above stays marked so the headline number
  // matches what Kelly reads.
  let trueLine = "";
  if (row?.open_cost_sol != null && row?.close_return_sol != null) {
    const truePnl = row.close_return_sol + row.fees_measured_sol + row.recovered_sol - row.open_cost_sol;
    trueLine = `\ntrue PnL (measured): ${truePnl >= 0 ? "+" : ""}${truePnl.toFixed(4)} SOL` +
      ` [in ${row.open_cost_sol.toFixed(4)} → out ${(row.close_return_sol + row.fees_measured_sol + row.recovered_sol).toFixed(4)}]`;
  }
  await alert(
    kind,
    `${pos.symbol} pos#${pos.id} closed — ${headline}\n` +
    `PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)\n` +
    `entry ${pos.entrySol.toFixed(3)} → exit ${res.exitSol.toFixed(3)} SOL | fees ${fees.toFixed(4)} SOL | held ${hold}` +
    trueLine
  );
  await accountPnlAlert(exec).catch((e) =>
    console.error("[alert] account summary failed:", (e as Error).message));
  return res;
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
    `SELECT COUNT(*) AS c, COALESCE(SUM(exit_sol + fees_claimed_sol - entry_sol), 0) AS r
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
            exit_ts, exit_sol, exit_reason
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
  }));
}

/** One manager tick over all open positions. */
export async function managePositions(exec: Executor): Promise<void> {
  const m = config().manage;
  const positions = loadOpenPositions();
  let marksOk = 0, marksFailed = 0, unrealizedSol = 0;

  for (const pos of positions) {
    try {
      if (exec instanceof PaperExecutor) await exec.accrueFees(pos, m.poll_s);
      const mark = await exec.mark(pos);
      marksOk++;
      unrealizedSol += mark.valueSol - pos.entrySol;
      const ageH = (now() - pos.entryTs) / 3600;
      const valueFrac = pos.entrySol > 0 ? mark.valueSol / pos.entrySol : 1;
      // Persisted (not just in-memory): restarts must not forget a position
      // was in range, or P3 exits misclassify win as missed (pos#2 incident).
      if (mark.inRange && !everInRange.has(pos.id)) {
        everInRange.add(pos.id);
        getDb().prepare("UPDATE positions SET ever_in_range = 1 WHERE id = ?").run(pos.id);
      }

      // --- P0 SAFETY: pool death, price crash, TVL drain, rugcheck flip ---
      // TODO(phase 2, live): wallet-dump / new-whale via tx stream.
      const crashed = mark.price > 0 && pos.entryPrice > 0 &&
        ((mark.price - pos.entryPrice) / pos.entryPrice) * 100 <= m.safety_price_crash_pct;
      const tvlDrained = mark.tvlUsd > 0 && tvlDropTriggered(pos.id, mark.tvlUsd);
      const rugFlip = !crashed && !tvlDrained && mark.valueSol > 0 && await rugcheckFlipped(pos.id, pos.tokenMint);
      // Holder watch (live only): wallet-dump / new-whale via GMGN snapshots.
      const holderTrig = exec.mode === "live" && !crashed && !tvlDrained && !rugFlip
        ? await holderCheck(pos.id, pos.tokenMint) : null;
      if (mark.valueSol === 0 || crashed || tvlDrained || rugFlip || holderTrig) {
        const trigger = mark.valueSol === 0 ? "pool_dead" : crashed ? "price_crash" : tvlDrained ? "tvl_drain" : rugFlip ? "rugcheck_flip" : `${holderTrig!.kind} (${holderTrig!.detail})`;
        clearRangeTimers(pos.id);
        await closeAndReport(exec, pos, "P0_safety", config().exec.safety_exit_slippage_bps, "safety_exit", `P0 safety (${trigger})`);
        blacklist(pos.tokenMint, "token", `P0 safety exit (${trigger})`);
        recordDecision(pos.tokenMint, pos.poolAddress, "exited", `P0_safety_${trigger}`, null, { mark, pos });
        continue;
      }

      // --- P1 STOP LOSS ---
      if (valueFrac < m.stop_loss_frac) {
        clearRangeTimers(pos.id);
        await closeAndReport(exec, pos, "P1_stop", config().exec.exit_slippage_bps, "stop_loss", `stop loss at ${(valueFrac * 100 - 100).toFixed(1)}%`);
        blacklist(pos.tokenMint, "token", "stop loss cooldown", m.loss_reentry_cooldown_h);
        recordDecision(pos.tokenMint, pos.poolAddress, "exited", "P1_stop", null, { valueFrac, mark });
        continue;
      }

      // --- P2 ROTATION: age limit + consecutive fee/volume decay ---
      if (ageH > m.max_age_h) {
        clearRangeTimers(pos.id);
        await closeAndReport(exec, pos, "P2_rotation", config().exec.exit_slippage_bps, "close", `rotation: max age ${m.max_age_h}h reached`);
        recordDecision(pos.tokenMint, pos.poolAddress, "exited", "P2_rotation_age", null, { ageH });
        continue;
      }
      const feeDaily = mark.feeTvl30mPct * 48;
      const decayed = feeDaily < m.rotation_fee_daily_min_pct || mark.vol30mUsd < m.rotation_vol_30m_min_usd;
      const streak = decayed ? (decayStreak.get(pos.id) ?? 0) + 1 : 0;
      decayStreak.set(pos.id, streak);
      if (streak >= m.rotation_polls) {
        clearRangeTimers(pos.id);
        const { exitSol } = await closeAndReport(exec, pos, "P2_rotation", config().exec.exit_slippage_bps, "close", `rotation: fee/volume decay (fee ${feeDaily.toFixed(1)}%/d, vol30m $${mark.vol30mUsd.toFixed(0)})`);
        bankProfit(pos, exitSol, "P2 rotation");
        recordDecision(pos.tokenMint, pos.poolAddress, "exited", "P2_rotation_decay", null, { feeDaily, vol30m: mark.vol30mUsd, streak });
        console.log(`[manager] pos#${pos.id} ${pos.symbol}: rotated out (fee ${feeDaily.toFixed(1)}%/d, vol30m $${mark.vol30mUsd.toFixed(0)})`);
        continue;
      }

      // --- P3 ABOVE RANGE -> TAKE PROFIT (with sustain timer, §4 P3) ---
      // TODO(phase 2): win-vs-missed classification, house-money banking.
      if (mark.aboveRange) {
        const since = aboveRangeSince.get(pos.id);
        if (since === undefined) {
          aboveRangeSince.set(pos.id, now());
        } else if (now() - since >= m.above_range_sustain_min * 60) {
          // Win = price traveled through our range (fees + round-trip profit);
          // missed = price pumped without ever touching us (capital idled).
          const dbFlag = (getDb().prepare("SELECT ever_in_range AS e FROM positions WHERE id = ?")
            .get(pos.id) as { e: number } | undefined)?.e === 1;
          const classification = everInRange.has(pos.id) || dbFlag ? "win" : "missed";
          clearRangeTimers(pos.id);
          const { exitSol } = await closeAndReport(
            exec, pos, "P3_above", config().exec.exit_slippage_bps, "close",
            classification === "win" ? "take-profit (price traveled through range)" : "missed (price jumped over range)"
          );
          if (classification === "missed")
            getDb().prepare("UPDATE positions SET state='closed_missed' WHERE id=?").run(pos.id);
          else bankProfit(pos, exitSol, "P3 take-profit");
          recordDecision(pos.tokenMint, pos.poolAddress, "exited", `P3_above_${classification}`, null, { mark, sustainedS: now() - since, exitSol });
        }
        continue; // above range: nothing earns; wait out the sustain window
      }
      aboveRangeSince.delete(pos.id); // back in (or below) range — reset timer

      // --- P5 BELOW RANGE (grace timer, §4 P5: wick tolerance) ---
      if (mark.belowRange) {
        const since = belowRangeSince.get(pos.id);
        if (since === undefined) {
          belowRangeSince.set(pos.id, now());
          console.log(`[manager] pos#${pos.id} ${pos.symbol} below range — grace timer started (${m.below_range_grace_min}m)`);
          // Bank fees at the top of the drop: claim converts token-side fees
          // to SOL now instead of letting them ride a dump through the grace
          // window. Failure is non-fatal — the grace timer still runs.
          if (mark.unclaimedFeesSol >= m.grace_claim_min_sol) {
            try {
              const { claimedSol } = await exec.claimFees(pos);
              await alert("claim", `${pos.symbol} pos#${pos.id}: grace-start claim — banked ${claimedSol.toFixed(4)} SOL before below-range wait`);
            } catch (e) {
              console.error(`[manager] pos#${pos.id} grace-start claim failed:`, (e as Error).message);
            }
          }
        } else if (now() - since >= m.below_range_grace_min * 60) {
          clearRangeTimers(pos.id);
          await closeAndReport(exec, pos, "P5_below", config().exec.exit_slippage_bps, "below_cut", `below-range cut after ${m.below_range_grace_min}m grace`);
          blacklist(pos.tokenMint, "token", "below range cut", m.loss_reentry_cooldown_h);
          recordDecision(pos.tokenMint, pos.poolAddress, "exited", "P5_below", null, { mark, graceS: now() - since });
        }
        continue; // below range: nothing earns; wait out the grace window
      }
      belowRangeSince.delete(pos.id); // back in range — wick survived, reset

      // --- ESCAPE HATCH (§4, Gmet's reshape simplified): price fell through
      // the deep part of our range, then recovered to the top slice — close
      // now, selling the accumulated token side near/above average acquisition
      // and realizing fees, instead of waiting to round-trip back down.
      {
        const depth = pos.maxBinId - pos.minBinId;
        const frac = depth > 0 ? (pos.maxBinId - mark.activeBinId) / depth : 0; // 0 = top, 1 = bottom
        if (frac >= m.escape_hatch_depth_pct / 100) {
          if (!fellDeep.has(pos.id)) {
            fellDeep.add(pos.id);
            getDb().prepare("UPDATE positions SET fell_deep = 1 WHERE id = ?").run(pos.id);
            console.log(`[manager] pos#${pos.id} ${pos.symbol}: fell through ${(frac * 100).toFixed(0)}% of range — escape hatch armed`);
          }
        } else if (frac <= m.escape_hatch_recovery_pct / 100) {
          const armed = fellDeep.has(pos.id) ||
            (getDb().prepare("SELECT fell_deep AS f FROM positions WHERE id = ?").get(pos.id) as { f: number } | undefined)?.f === 1;
          if (armed) {
            clearRangeTimers(pos.id);
            const { exitSol } = await closeAndReport(exec, pos, "escape", config().exec.exit_slippage_bps, "close",
              "escape hatch: deep dip recovered to range top — reset");
            bankProfit(pos, exitSol, "escape hatch");
            recordDecision(pos.tokenMint, pos.poolAddress, "exited", "escape_hatch", null, { frac, mark });
            continue;
          }
        }
      }

      // --- P4 IN RANGE: claim + profit lock ---
      if (mark.unclaimedFeesSol >= m.claim_min_sol) {
        const { claimedSol } = await exec.claimFees(pos);
        await alert("claim", `${pos.symbol} pos#${pos.id}: claimed ${claimedSol.toFixed(4)} SOL in fees`);
      }
      if (
        m.profit_lock_enabled &&
        pos.profitLockFires < m.profit_lock_max_fires &&
        valueFrac >= m.profit_lock_at_frac
      ) {
        const { withdrawnSol } = await exec.withdraw(pos, m.profit_lock_withdraw_pct * 100); // pct -> bps
        await alert("profit_lock", `${pos.symbol} pos#${pos.id}: profit lock at +${((valueFrac - 1) * 100).toFixed(0)}% — withdrew ${withdrawnSol.toFixed(4)} SOL`);
      }
      // TODO(phase 2): escape hatch, hybrid/compound fee destination.
    } catch (e) {
      marksFailed++;
      console.error(`[manager] position ${pos.id} (${pos.symbol}):`, (e as Error).message);
    }
  }

  // Watchdog health: blind = positions exist but every mark failed.
  if (positions.length === 0 || marksOk > 0) {
    lastHealthyTick = Date.now();
    watchdogAlerted = false;
  }

  // Daily PnL rollup (§7) — keeps today's row current for promotion tracking.
  try {
    await rollupDaily(exec.mode, unrealizedSol);
  } catch (e) {
    console.error("[pnl] rollup failed:", (e as Error).message);
  }
}

/** Watchdog (§9): alert (and optionally close all) when marking is blind too long. */
export async function watchdogCheck(exec: Executor): Promise<void> {
  const w = config().watchdog;
  const blindMs = Date.now() - lastHealthyTick;
  if (blindMs < w.rpc_blind_after_min * 60_000) return;
  if (!watchdogAlerted) {
    watchdogAlerted = true;
    await alert("watchdog", `marking blind for ${(blindMs / 60000).toFixed(0)}m — ${w.rpc_blind_close_all ? "attempting close-all" : "manual intervention needed"}`);
  }
  if (w.rpc_blind_close_all && exec.mode === "live") {
    // TODO(live executor): route close-all through the fallback RPC connection.
    for (const pos of loadOpenPositions()) {
      try { await closeAndReport(exec, pos, "manual", config().exec.safety_exit_slippage_bps, "watchdog", "watchdog close-all (RPC blind)"); } catch { /* keep trying next tick */ }
    }
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
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "slots_full", cand.score, {});
      continue;
    }
    if (opened >= bankroll.effectiveSlots && !rot.displacement_enabled) break;

    const createdAtMs = cand.pool.createdAt ? Date.parse(cand.pool.createdAt) : null;
    const vet = await vetToken(cand.tokenMint, createdAtMs);
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
    const isMicro = cand.pool.marketCapUsd < g.mcap_micro_max_usd;
    if (isMicro && baseScore < g.mcap_micro_score_min) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "micro_score", baseScore, { mcapUsd: cand.pool.marketCapUsd, required: g.mcap_micro_score_min, score });
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
    // One primary position per token (§5) — tranches are the only sanctioned
    // second position and they're opened by the manager, not the entry pipeline.
    if (tokenExposureSol(cand.tokenMint) > 0) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "already_positioned", score, {});
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
      const shareCapSol = (cand.pool.tvlUsd * (g.max_pool_share_pct / 100)) / solUsd;
      if (size > shareCapSol) {
        if (shareCapSol < sizeFloor) {
          recordDecision(cand.tokenMint, cand.pool.address, "skipped", "pool_share", score, { shareCapSol, size, tvlUsd: cand.pool.tvlUsd });
          continue;
        }
        console.log(`[risk] ${cand.symbol}: size ${size.toFixed(2)} -> ${shareCapSol.toFixed(2)} SOL (pool-share cap ${g.max_pool_share_pct}% of $${cand.pool.tvlUsd.toFixed(0)} TVL)`);
        size = shareCapSol;
      }
    }

    const candles = await fetchCandles(cand.pool.address, "5m").catch(() => []);
    const range = planRange(cand.pool.price, cand.pool.binStep, candles, cand.pool.decimalsX);
    if (range.estBinRentSol > config().entry.bin_rent_budget_sol * 3) {
      // Rent budget is a soft-cap in paper mode; TODO(phase 2): shrink range instead.
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "bin_rent", score, { range });
      continue;
    }

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
      const msg = (e as Error).message.split("\n")[0]!.slice(0, 300);
      console.error(`[enter] ${cand.symbol} open failed: ${msg}`);
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "open_failed", score, { size, range, error: msg });
      continue;
    }
    // Live-experiment cohort tags (2026-08-07): fee-gate path, mcap band, and
    // bonus composition — evaluated against outcomes after ~5 closes each.
    const feePath = cand.pool.feeTvl24hPct >= g.fee_tvl_24h_min_pct ? "24h" : "recent_hot";
    recordDecision(cand.tokenMint, cand.pool.address, "entered", null, score, {
      size, range, vet: vet.facts, pool: cand.pool, kelly, isAlpha, flow,
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
  }
}

/** Main loop: manage every poll_s, enter every interval_s. */
export async function runLoop(): Promise<void> {
  acquireInstanceLock();
  let exec: Executor;
  if (isLive()) {
    const { LiveExecutor } = await import("../executor/live.js");
    const live = new LiveExecutor();
    // Chain is truth: reconcile before the manager touches anything (§7).
    const rec = await reconcileLive(live.connection, live.wallet.publicKey);
    console.log(`[farmer] reconcile: ${rec.dbOpen} db-open, ${rec.chainPositions} on-chain, ${rec.orphanedInDb.length} orphaned, ${rec.adopted.length} adopted`);
    exec = live;
  } else {
    exec = new PaperExecutor();
  }
  console.log(`[farmer] starting in ${exec.mode} mode (pid ${process.pid})`);
  startSmartFlow();
  let lastScan = 0;
  let lastSweep = 0;

  for (;;) {
    if (haltRequested()) {
      console.log("[farmer] HALT file present — closing all positions and stopping");
      for (const pos of loadOpenPositions()) await closeAndReport(exec, pos, "manual", config().exec.exit_slippage_bps, "close", "manual HALT");
      return;
    }
    try {
      await managePositions(exec);
      await watchdogCheck(exec);
      if (Date.now() - lastScan > config().scanner.interval_s * 1000) {
        lastScan = Date.now();
        await enterNewPositions(exec);
      }
      if (exec.sweepResiduals && Date.now() - lastSweep > RESIDUAL_SWEEP_INTERVAL_MS) {
        lastSweep = Date.now();
        for (const r of await exec.sweepResiduals(RESIDUAL_SWEEP_MIN_SOL)) {
          const tag = r.positionId ? ` pos#${r.positionId}` : "";
          // No ledger insert here. sweepResiduals already credits the same
          // lamports to positions.recovered_sol, and `banked` is subtracted from
          // deployable in computeBankroll — so banking it too counted the sweep
          // twice AND shrank the working bankroll by recovered principal. Two of
          // the ledger's first twelve rows (0.0367 SOL) are this double-count.
          // A sweep lands after the close alert, so that alert's true PnL was
          // short by exactly this. Restate it rather than leave the wrong
          // number as the last word on the position.
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
      }
    } catch (e) {
      console.error("[farmer] tick error:", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, config().manage.poll_s * 1000));
  }
}
