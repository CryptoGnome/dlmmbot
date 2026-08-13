import { getDb, now, upsertTokenMeta } from "../db/db.js";
import { fetchPool } from "../scanner/meteora.js";
import { binIdToPrice, priceToBinId } from "../ranges/planner.js";
import type { ExitReason, Position, RangeShape } from "../types.js";
import type { Executor, OpenParams, PositionMark } from "./executor.js";
import { escapeRebalanceDeltas } from "./rebalance.js";

// Paper executor (STRATEGY.md §8): simulates a one-sided SOL bid-ask position
// against LIVE pool data. Fees are estimated from the pool's realized
// fee_tvl_ratio scaled by our share of TVL — conservative (assumes our
// liquidity earns at the pool-average rate, ignores bin-level concentration).

const PAPER_TX_COST_SOL = 0.0006; // priority fee + base fee estimate per tx
const START_BALANCE_SOL = 10;     // virtual wallet

interface PoolLive {
  price: number;
  tvlUsd: number;
  feeTvl30mPct: number;
  vol30mUsd: number;
  binStep: number;
  decimalsX: number;
}

// A pool is considered DEAD (rug-level) only below this TVL. Anything else —
// including falling out of scanner rankings — is not death. Lesson from
// incident 2026-08-07: rank-based lookup falsely marked a live pool as rugged.
const POOL_DEAD_TVL_USD = 250;

async function livePool(address: string): Promise<PoolLive | null> {
  const p = await fetchPool(address); // throws on transient errors (caller skips tick)
  if (!p || p.tvlUsd < POOL_DEAD_TVL_USD) return null; // null = genuinely dead
  return { price: p.price, tvlUsd: p.tvlUsd, feeTvl30mPct: p.feeTvl30mPct, vol30mUsd: p.vol30mUsd, binStep: p.binStep, decimalsX: p.decimalsX };
}

export class PaperExecutor implements Executor {
  readonly mode = "paper" as const;
  private binStepByPool = new Map<string, number>();
  private rangeShapeByPos = new Map<number, RangeShape>();

  async open(params: OpenParams): Promise<Position> {
    const db = getDb();
    const res = db.prepare(
      `INSERT INTO positions (mode, pool, token_mint, symbol, tranche_of, entry_ts, entry_price, entry_sol,
        min_bin_id, max_bin_id, state, rent_paid_sol, open_cost_sol)
       VALUES ('paper', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    ).run(
      params.poolAddress, params.tokenMint, params.symbol, params.trancheOf ?? null,
      now(), params.entryPrice, params.sizeSol,
      params.range.minBinId, params.range.maxBinId, params.range.estBinRentSol,
      params.sizeSol + PAPER_TX_COST_SOL
    );
    const id = Number(res.lastInsertRowid);
    this.rangeShapeByPos.set(id, params.range.shape ?? "bidask");
    upsertTokenMeta(params.tokenMint, { symbol: params.symbol });
    return {
      id,
      mode: "paper",
      poolAddress: params.poolAddress,
      tokenMint: params.tokenMint,
      symbol: params.symbol,
      trancheOf: params.trancheOf ?? null,
      entryTs: now(),
      entryPrice: params.entryPrice,
      entrySol: params.sizeSol,
      minBinId: params.range.minBinId,
      maxBinId: params.range.maxBinId,
      state: "open",
      feesClaimedSol: 0,
      rentPaidSol: params.range.estBinRentSol,
      profitLockFires: 0,
      exitTs: null, exitSol: null, exitReason: null,
    };
  }

  async mark(position: Position): Promise<PositionMark> {
    const pool = await livePool(position.poolAddress);
    if (!pool) {
      // Pool genuinely dead (404 or TVL < dead threshold) — danger mark.
      return {
        valueSol: 0, unclaimedFeesSol: 0, activeBinId: 0, price: 0,
        inRange: false, aboveRange: false, belowRange: true,
        tvlUsd: 0, feeTvl30mPct: 0, vol30mUsd: 0,
      };
    }
    this.binStepByPool.set(position.poolAddress, pool.binStep);
    const activeBinId = priceToBinId(pool.price, pool.binStep, pool.decimalsX);
    const aboveRange = activeBinId > position.maxBinId;
    const belowRange = activeBinId < position.minBinId;

    // Simulated value: SOL still in untouched bins + token accumulated in
    // touched bins valued at current price. Simplified linear bid-ask model.
    const value = this.simulateValue(position, pool.price, pool.binStep, pool.decimalsX);
    const fees = await this.simulateFees(position, pool);
    return {
      valueSol: value + fees,
      unclaimedFeesSol: fees,
      activeBinId,
      price: pool.price,
      inRange: !aboveRange && !belowRange,
      aboveRange,
      belowRange,
      tvlUsd: pool.tvlUsd,
      feeTvl30mPct: pool.feeTvl30mPct,
      vol30mUsd: pool.vol30mUsd,
    };
  }

  private simulateValue(position: Position, price: number, binStep: number, decimalsX: number): number {
    const shape = this.rangeShapeByPos.get(position.id) ?? "bidask";
    const { minBinId, maxBinId, entrySol } = position;
    const n = maxBinId - minBinId + 1;
    if (n <= 0) return entrySol;
    const activeBinId = priceToBinId(price, binStep, decimalsX);
    const totalW = shape === "spot" ? n : (n * (n + 1)) / 2;
    let value = 0;
    for (let i = 0; i < n; i++) {
      const binId = maxBinId - i;
      const w = shape === "spot" ? 1 / totalW : (i + 1) / totalW;
      const solInBin = entrySol * w;
      if (binId > activeBinId) {
        const binPrice = binIdToPrice(binId, binStep, decimalsX);
        value += (solInBin / binPrice) * price;
      } else {
        value += solInBin;
      }
    }
    return value;
  }

  /** Fees accrue at the pool's 30m fee/TVL rate × our (approx) share, per poll interval. */
  private async simulateFees(position: Position, pool: PoolLive): Promise<number> {
    const db = getDb();
    const row = db.prepare(
      "SELECT COALESCE(SUM(sol_delta), 0) AS accrued FROM events WHERE position_id = ? AND type = 'claim'"
    ).get(position.id) as { accrued: number };
    // Accrual is advanced by the manager loop calling accrueFees(); mark()
    // reports what has accrued but not been claimed.
    const accruedRow = db.prepare(
      "SELECT COALESCE(SUM(sol_delta), 0) AS a FROM events WHERE position_id = ? AND type = 'deposit'"
    ).get(position.id) as { a: number };
    return Math.max(0, accruedRow.a - row.accrued);
  }

  /** Called once per manager poll to accrue simulated fees (recorded as 'deposit' events). */
  async accrueFees(position: Position, pollSeconds: number): Promise<void> {
    const pool = await livePool(position.poolAddress);
    if (!pool) return;
    const activeBinId = priceToBinId(pool.price, pool.binStep, pool.decimalsX);
    if (activeBinId > position.maxBinId || activeBinId < position.minBinId) return; // out of range earns nothing
    // Pool-average accrual: fee_tvl_30m% of our deployed value per 30 min.
    const ratePerSec = pool.feeTvl30mPct / 100 / 1800;
    const accrual = position.entrySol * ratePerSec * pollSeconds;
    if (accrual > 0) {
      getDb().prepare(
        "INSERT INTO events (position_id, ts, type, sol_delta, detail_json) VALUES (?, ?, 'deposit', ?, ?)"
      ).run(position.id, now(), accrual, JSON.stringify({ kind: "paper_fee_accrual", pollSeconds }));
    }
  }

  async claimFees(position: Position): Promise<{ claimedSol: number; txCostSol: number }> {
    const mark = await this.mark(position);
    const claimed = mark.unclaimedFeesSol;
    if (claimed > 0) {
      getDb().prepare(
        `INSERT INTO events (position_id, ts, type, sol_delta, tx_cost_sol) VALUES (?, ?, 'claim', ?, ?)`
      ).run(position.id, now(), claimed, PAPER_TX_COST_SOL);
      getDb().prepare(
        "UPDATE positions SET fees_claimed_sol = fees_claimed_sol + ? WHERE id = ?"
      ).run(claimed, position.id);
    }
    return { claimedSol: claimed, txCostSol: PAPER_TX_COST_SOL };
  }

  async withdraw(position: Position, bps: number): Promise<{ withdrawnSol: number; txCostSol: number }> {
    const mark = await this.mark(position);
    const withdrawn = (mark.valueSol - mark.unclaimedFeesSol) * (bps / 10_000);
    getDb().prepare(
      `INSERT INTO events (position_id, ts, type, sol_delta, tx_cost_sol, detail_json) VALUES (?, ?, 'profit_lock', ?, ?, ?)`
    ).run(position.id, now(), withdrawn, PAPER_TX_COST_SOL, JSON.stringify({ bps }));
    getDb().prepare(
      "UPDATE positions SET entry_sol = entry_sol * (1 - ? / 10000.0), profit_lock_fires = profit_lock_fires + 1 WHERE id = ?"
    ).run(bps, position.id);
    return { withdrawnSol: withdrawn, txCostSol: PAPER_TX_COST_SOL };
  }

  async escapeRebalance(position: Position, _slippageBps: number): Promise<{ ok: boolean }> {
    const mark = await this.mark(position);
    const { newMinBinId, newMaxBinId } = escapeRebalanceDeltas(
      position.minBinId, position.maxBinId, mark.activeBinId,
    );
    getDb().prepare("UPDATE positions SET min_bin_id = ?, max_bin_id = ?, fell_deep = 0 WHERE id = ?")
      .run(newMinBinId, newMaxBinId, position.id);
    getDb().prepare(
      "INSERT INTO events (position_id, ts, type, detail_json) VALUES (?, ?, 'rebalance', ?)"
    ).run(position.id, now(), JSON.stringify({ kind: "escape_rebalance", bins: [newMinBinId, newMaxBinId] }));
    return { ok: true };
  }

  async close(position: Position, reason: ExitReason, _slippageBps: number): Promise<{ exitSol: number; txCostSol: number }> {
    const mark = await this.mark(position);
    const stateByReason: Record<ExitReason, string> = {
      P0_safety: "closed_safety", P1_stop: "closed_stop", P2_rotation: "closed_rotation",
      P3_above: "closed_win", P5_below: "closed_below", escape: "closed_escape", manual: "closed_manual",
    };
    getDb().prepare(
      `UPDATE positions SET state = ?, exit_ts = ?, exit_sol = ?, exit_reason = ?, close_return_sol = ? WHERE id = ?`
    ).run(stateByReason[reason], now(), mark.valueSol, reason, mark.valueSol - PAPER_TX_COST_SOL, position.id);
    getDb().prepare(
      `INSERT INTO events (position_id, ts, type, sol_delta, tx_cost_sol) VALUES (?, ?, ?, ?, ?)`
    ).run(position.id, now(), reason === "P0_safety" ? "safety_exit" : "withdraw", mark.valueSol, PAPER_TX_COST_SOL);
    return { exitSol: mark.valueSol, txCostSol: PAPER_TX_COST_SOL };
  }

  /** Paper mode has no chain to be blind to; always healthy. */
  async healthProbe(): Promise<number> {
    return 0;
  }

  async walletSol(): Promise<number> {
    // Virtual wallet: start balance + realized PnL + claimed fees - costs.
    const db = getDb();
    const realized = (db.prepare(
      `SELECT COALESCE(SUM(exit_sol - entry_sol), 0) AS r FROM positions WHERE mode='paper' AND exit_ts IS NOT NULL`
    ).get() as { r: number }).r;
    const fees = (db.prepare(
      `SELECT COALESCE(SUM(fees_claimed_sol), 0) AS f FROM positions WHERE mode='paper'`
    ).get() as { f: number }).f;
    return START_BALANCE_SOL + realized + fees;
  }
}
