import { config } from "../config.js";
import { alert } from "../alerts.js";
import { getDb, isBlacklisted, now, recordDecision, logError } from "../db/db.js";
import type { Executor } from "../executor/executor.js";
import { txErrorDetail } from "../executor/live.js";
import { sol24hChangePct } from "../market.js";
import { planFollowRange } from "../ranges/planner.js";
import { fetchPool } from "../scanner/meteora.js";
import { circuitBreakerTripped, computeBankroll, openPositionCount, regimeFactor } from "../risk/limits.js";
import type { Position } from "../types.js";
import { vetToken } from "../vetting/vet.js";

// Follow mode (2026-08-11): up-only swapless re-entry after a P3 up-and-out
// close. The 17 recorded up-and-out closes averaged +0.005 SOL on ~20min holds
// while their pools kept printing for 6-25h; simulated over those real price
// paths, chasing is NEGATIVE-EV in every unguarded configuration — median
// retrace inside a hot window is 26% (p75 34%), so tight "top blast" ranges
// get run through and every immediate re-bid buys a fade. The one configuration
// at/above breakeven at measured fee rates, and the one implemented here:
//
//   arm only while vol_30m >= min_vol_30m_usd (4x the entry floor),
//   wait for a retrace_arm_pct dip from the post-exit high before re-bidding,
//   re-enter one-sided bid-ask range_depth_pct below price (single account),
//   after the first leg, require a NEW chain high before re-arming (up-only —
//     this condition alone separated +EV from -EV in the sim),
//   end the chain on any non-P3 close, max_legs, or the loss budget.
//
// A P3 close leaves the position 100% SOL, so every re-entry here is swapless.

/** Per-chain cooldown after a failed leg open — avoids 4 sims every 15s. */
const openFailUntil = new Map<number, number>();

interface ChainRow {
  id: number;
  mode: string;
  pool: string;
  token_mint: string;
  symbol: string;
  origin_position_id: number;
  started_ts: number;
  state: "awaiting_high" | "awaiting_dip" | "leg_open";
  legs: number;
  chain_pnl_sol: number;
  chain_high: number;
  high_mark: number;
  arm_peak: number | null;
  cold_streak: number;
  last_leg_position_id: number | null;
}

/** True if this mint has a live follow chain (any state but done). */
export function hasActiveFollowChain(mint: string, mode: string): boolean {
  return getDb().prepare(
    "SELECT 1 FROM follow_chains WHERE token_mint = ? AND mode = ? AND state != 'done' LIMIT 1"
  ).get(mint, mode) !== undefined;
}

function endChain(chain: ChainRow, reason: string): void {
  getDb().prepare(
    "UPDATE follow_chains SET state = 'done', end_reason = ?, updated_ts = ? WHERE id = ?"
  ).run(reason, now(), chain.id);
  console.log(`[follow] chain#${chain.id} ${chain.symbol} ended (${reason}) — ${chain.legs} leg(s), chain PnL ${chain.chain_pnl_sol >= 0 ? "+" : ""}${chain.chain_pnl_sol.toFixed(4)} SOL`);
  if (chain.legs > 0) {
    alert("info",
      `follow chain ${chain.symbol} ended (${reason}): ${chain.legs} leg(s), ` +
      `chain PnL ${chain.chain_pnl_sol >= 0 ? "+" : ""}${chain.chain_pnl_sol.toFixed(4)} SOL`
    ).catch(() => {});
  }
}

/**
 * Arm a chain after a P3 up-and-out close (win or missed — both mean the pool
 * out-ran us). No-op unless follow.enabled; never arms a second chain for a
 * mint that already has one, and never for a blacklisted token.
 */
export function armFollowChain(pos: Position, exitPrice: number): void {
  const f = config().follow;
  if (!f?.enabled) return;
  if (pos.trancheOf !== null) return;
  if (isBlacklisted(pos.tokenMint)) return;
  if (hasActiveFollowChain(pos.tokenMint, pos.mode)) return;
  // First leg needs no new high — the price that just out-ran us IS the high;
  // it starts straight in awaiting_dip measured from here.
  getDb().prepare(
    `INSERT INTO follow_chains (mode, pool, token_mint, symbol, origin_position_id, started_ts,
       state, chain_high, high_mark, arm_peak, updated_ts)
     VALUES (?, ?, ?, ?, ?, ?, 'awaiting_dip', ?, ?, ?, ?)`
  ).run(pos.mode, pos.poolAddress, pos.tokenMint, pos.symbol, pos.id, now(),
        exitPrice, exitPrice, exitPrice, now());
  console.log(`[follow] armed chain for ${pos.symbol} after pos#${pos.id} up-and-out (high ${exitPrice.toPrecision(4)})`);
}

/**
 * Called from closeAndReport for every close of a follow leg. P3 up-and-out
 * continues the chain (back to awaiting_high); anything else ends it — a stop,
 * safety, or below-cut on a leg is the reversal the chain was betting against.
 */
export function onFollowLegClosed(pos: Position, reason: string, pnlSol: number): void {
  const chain = getDb().prepare(
    "SELECT * FROM follow_chains WHERE id = ? AND state != 'done'"
  ).get(pos.followChainId) as ChainRow | undefined;
  if (!chain) return;
  const f = config().follow;
  const pnl = chain.chain_pnl_sol + pnlSol;
  getDb().prepare("UPDATE follow_chains SET chain_pnl_sol = ?, updated_ts = ? WHERE id = ?")
    .run(pnl, now(), chain.id);
  chain.chain_pnl_sol = pnl;
  if (reason !== "P3_above") return endChain(chain, `leg_${reason}`);
  if (chain.legs >= f.max_legs) return endChain(chain, "max_legs");
  if (pnl <= -f.chain_loss_budget_sol) return endChain(chain, "loss_budget");
  // Continue: demand a new chain high before the next dip-wait (up-only).
  getDb().prepare(
    "UPDATE follow_chains SET state = 'awaiting_high', high_mark = chain_high, arm_peak = NULL, updated_ts = ? WHERE id = ?"
  ).run(now(), chain.id);
  console.log(`[follow] chain#${chain.id} ${chain.symbol}: leg ${chain.legs} closed up-and-out (+${pnlSol.toFixed(4)}) — awaiting new high above ${chain.chain_high.toPrecision(4)}`);
}

/** One poll over all live chains: track highs, arm on dips, open legs. */
export async function tickFollowChains(exec: Executor): Promise<void> {
  const f = config().follow;
  if (!f?.enabled) return;
  const db = getDb();
  const chains = db.prepare(
    "SELECT * FROM follow_chains WHERE mode = ? AND state != 'done'"
  ).all(exec.mode) as ChainRow[];

  for (const chain of chains) {
    try {
      if (now() - chain.started_ts > f.chain_max_age_h * 3600) { endChain(chain, "expired"); continue; }
      if (isBlacklisted(chain.token_mint)) { endChain(chain, "blacklisted"); continue; }

      let pool;
      try {
        pool = await fetchPool(chain.pool);
      } catch {
        continue; // transient datapi failure — never end a chain on one
      }
      if (!pool || pool.price <= 0) { endChain(chain, "pool_gone"); continue; }

      chain.chain_high = Math.max(chain.chain_high, pool.price);

      // Hot-window end: the chain only exists while the pool has real flow.
      if (pool.vol30mUsd < config().gates.vol_30m_min_usd) {
        chain.cold_streak += 1;
        if (chain.cold_streak >= f.cold_polls_end) { endChain(chain, "volume_died"); continue; }
      } else {
        chain.cold_streak = 0;
      }

      if (chain.state === "leg_open") {
        // Leg is managed by the normal P0-P5 loop; we only keep the high fresh.
        db.prepare("UPDATE follow_chains SET chain_high = ?, cold_streak = ?, updated_ts = ? WHERE id = ?")
          .run(chain.chain_high, chain.cold_streak, now(), chain.id);
        continue;
      }

      if (chain.state === "awaiting_high") {
        if (pool.price >= chain.high_mark) {
          chain.state = "awaiting_dip";
          chain.arm_peak = pool.price;
          console.log(`[follow] chain#${chain.id} ${chain.symbol}: new chain high ${pool.price.toPrecision(4)} — awaiting ${f.retrace_arm_pct}% dip`);
        }
        db.prepare("UPDATE follow_chains SET state = ?, chain_high = ?, arm_peak = ?, cold_streak = ?, updated_ts = ? WHERE id = ?")
          .run(chain.state, chain.chain_high, chain.arm_peak, chain.cold_streak, now(), chain.id);
        continue;
      }

      // awaiting_dip: ratchet the local peak, fire on the retrace.
      chain.arm_peak = Math.max(chain.arm_peak ?? pool.price, pool.price);
      db.prepare("UPDATE follow_chains SET chain_high = ?, arm_peak = ?, cold_streak = ?, updated_ts = ? WHERE id = ?")
        .run(chain.chain_high, chain.arm_peak, chain.cold_streak, now(), chain.id);
      const dipped = pool.price <= chain.arm_peak * (1 - f.retrace_arm_pct / 100);
      if (!dipped) continue;

      const coolUntil = openFailUntil.get(chain.id) ?? 0;
      if (now() < coolUntil) continue;

      // Arming gates — current-window heat only, by design: the stale 24h
      // fee/TVL average is exactly what kept the bot out of its best pools
      // after a profitable close (TVL growth dilutes it while the pool prints).
      const g = config().gates;
      const recentlyHot = pool.feeTvl30mPct * 48 >= g.fee_tvl_24h_min_pct &&
                          pool.feeTvl1hPct * 24 >= g.fee_tvl_24h_min_pct;
      if (pool.vol30mUsd < f.min_vol_30m_usd || !recentlyHot) continue; // dip without heat — keep waiting

      await openFollowLeg(exec, chain, pool.price, pool.binStep, pool.decimalsX, pool.createdAt);
    } catch (e) {
      console.error(`[follow] chain#${chain.id} ${chain.symbol} tick failed:`, (e as Error).message);
    }
  }
}

async function openFollowLeg(
  exec: Executor,
  chain: ChainRow,
  price: number,
  binStep: number,
  decimalsX: number,
  poolCreatedAt: string | null,
): Promise<void> {
  const f = config().follow;
  const db = getDb();

  // Portfolio-level brakes all still apply — follow legs are real capital.
  const walletSol = await exec.walletSol();
  if (circuitBreakerTripped(walletSol)) return;
  const solChange = await sol24hChangePct();
  const regime = solChange === null ? 1 : regimeFactor(solChange);
  if (regime === 0) return;
  const size = f.leg_size_sol * regime;
  if (size < config().sizing.min_reentry_sol) return;
  const bankroll = computeBankroll(walletSol);
  if (bankroll.deployableSol < size) return;
  if (openPositionCount() >= bankroll.effectiveSlots) return;

  // Fresh safety vetting each leg — a chain must never out-live the token's
  // integrity. A hard vet FAILURE is terminal for the chain; a vet ERROR
  // (rugcheck/RPC down) is a wait, not a verdict.
  const vet = await vetToken(chain.token_mint, poolCreatedAt ? Date.parse(poolCreatedAt) : null);
  if (vet.verdict === "error") return;
  if (vet.verdict !== "pass") {
    endChain(chain, `vet_${vet.hardFailures[0]?.gate ?? "failed"}`);
    return;
  }

  const range = planFollowRange(price, binStep, f.range_depth_pct, decimalsX);
  let pos: Position;
  try {
    pos = await exec.open({
      poolAddress: chain.pool,
      tokenMint: chain.token_mint,
      symbol: chain.symbol,
      sizeSol: size,
      range,
      entryPrice: price,
    });
  } catch (e) {
    const detail = txErrorDetail(e);
    const cool = config().follow.open_fail_cooldown_s || 300;
    openFailUntil.set(chain.id, now() + cool);
    logError({
      source: "follow",
      code: "open_failed",
      message: `chain#${chain.id} ${chain.symbol} leg open failed: ${detail.summary}`,
      err: e,
      detail: { chainId: chain.id, code: detail.code, logs: detail.logs, cool },
      symbol: chain.symbol,
      mint: chain.token_mint,
      pool: chain.pool,
      dedupeSec: cool,
    });
    recordDecision(chain.token_mint, chain.pool, "skipped", "open_failed", null, {
      follow: true, chainId: chain.id, error: detail.summary, code: detail.code, logs: detail.logs,
    });
    return; // transient — the dip condition will still hold next tick if real
  }
  const legN = chain.legs + 1;
  db.prepare("UPDATE positions SET follow_chain_id = ? WHERE id = ?").run(chain.id, pos.id);
  db.prepare(
    "UPDATE follow_chains SET state = 'leg_open', legs = ?, last_leg_position_id = ?, updated_ts = ? WHERE id = ?"
  ).run(legN, pos.id, now(), chain.id);
  recordDecision(chain.token_mint, chain.pool, "entered", null, null, {
    follow: { chainId: chain.id, leg: legN, chainHigh: chain.chain_high, armPeak: chain.arm_peak, price, size },
  });
  await alert("entry",
    `${chain.symbol} pos#${pos.id}: FOLLOW leg ${legN}/${f.max_legs} — ${size.toFixed(2)} SOL @ ${price.toPrecision(4)} ` +
    `(${((price / chain.arm_peak! - 1) * 100).toFixed(0)}% off local high, depth ${range.bottomPricePct.toFixed(0)}%)\n` +
    `chart: https://gmgn.ai/sol/token/${chain.token_mint}`);
  console.log(`[follow] chain#${chain.id} ${chain.symbol}: opened leg ${legN} pos#${pos.id} at ${price.toPrecision(4)}, range [${range.minBinId},${range.maxBinId}]`);
}
