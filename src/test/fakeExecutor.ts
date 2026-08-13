import type { ExitReason, Position } from "../types.js";
import type { Executor, OpenParams, PositionMark } from "../executor/executor.js";
import { getDb, now } from "../db/db.js";

/** In-memory Executor for manager/follow contract tests — no RPC, no datapi. */
export class FakeExecutor implements Executor {
  readonly mode: "paper" | "live";
  marks = new Map<number, PositionMark>();
  closed: Array<{ id: number; reason: ExitReason }> = [];
  escapeRebalanced: number[] = [];
  withdrawn: Array<{ id: number; bps: number }> = [];
  opens: OpenParams[] = [];
  wallet = 20;
  openError: Error | null = null;
  nextOpenId = 9000;

  constructor(mode: "paper" | "live" = "paper") {
    this.mode = mode;
  }

  setMark(id: number, mark: Partial<PositionMark> & Pick<PositionMark, "valueSol" | "price" | "activeBinId">): void {
    this.marks.set(id, {
      unclaimedFeesSol: 0,
      inRange: true,
      aboveRange: false,
      belowRange: false,
      tvlUsd: 50_000,
      feeTvl30mPct: 1,
      vol30mUsd: 80_000,
      ...mark,
    });
  }

  async open(params: OpenParams): Promise<Position> {
    this.opens.push(params);
    if (this.openError) throw this.openError;
    const id = this.nextOpenId++;
    const res = getDb().prepare(
      `INSERT INTO positions (
         mode, pool, token_mint, symbol, entry_ts, entry_price, entry_sol,
         min_bin_id, max_bin_id, state, fees_claimed_sol, rent_paid_sol, open_cost_sol
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)`
    ).run(
      this.mode, params.poolAddress, params.tokenMint, params.symbol,
      now(), params.entryPrice, params.sizeSol,
      params.range.minBinId, params.range.maxBinId,
      params.range.estBinRentSol, params.sizeSol,
    );
    const realId = Number(res.lastInsertRowid);
    this.setMark(realId, {
      valueSol: params.sizeSol,
      price: params.entryPrice,
      activeBinId: params.range.maxBinId,
    });
    return {
      id: realId, mode: this.mode, poolAddress: params.poolAddress,
      tokenMint: params.tokenMint, symbol: params.symbol, trancheOf: null,
      entryTs: now(), entryPrice: params.entryPrice, entrySol: params.sizeSol,
      minBinId: params.range.minBinId, maxBinId: params.range.maxBinId,
      state: "open", feesClaimedSol: 0, rentPaidSol: params.range.estBinRentSol,
      profitLockFires: 0, exitTs: null, exitSol: null, exitReason: null,
    };
  }

  async mark(position: Position): Promise<PositionMark> {
    const m = this.marks.get(position.id);
    if (!m) throw new Error(`FakeExecutor: no mark for pos#${position.id}`);
    return m;
  }

  async claimFees(): Promise<{ claimedSol: number; txCostSol: number }> {
    return { claimedSol: 0, txCostSol: 0 };
  }

  async withdraw(position: Position, bps: number): Promise<{ withdrawnSol: number; txCostSol: number }> {
    this.withdrawn.push({ id: position.id, bps });
    getDb().prepare("UPDATE positions SET profit_lock_fires = profit_lock_fires + 1 WHERE id = ?").run(position.id);
    return { withdrawnSol: 0.09, txCostSol: 0.001 };
  }

  async escapeRebalance(position: Position, _slippageBps: number): Promise<{ ok: boolean }> {
    this.escapeRebalanced.push(position.id);
    getDb().prepare("UPDATE positions SET fell_deep = 0 WHERE id = ?").run(position.id);
    return { ok: true };
  }

  async close(position: Position, reason: ExitReason, _slippageBps: number): Promise<{ exitSol: number; txCostSol: number }> {
    this.closed.push({ id: position.id, reason });
    const mark = this.marks.get(position.id);
    const exitSol = mark?.valueSol ?? position.entrySol;
    const stateByReason: Record<ExitReason, string> = {
      P0_safety: "closed_safety", P1_stop: "closed_stop", P2_rotation: "closed_rotation",
      P3_above: "closed_win", P5_below: "closed_below", escape: "closed_escape", manual: "closed_manual",
    };
    getDb().prepare(
      `UPDATE positions SET state = ?, exit_ts = ?, exit_sol = ?, exit_reason = ?, close_return_sol = ? WHERE id = ?`
    ).run(stateByReason[reason], now(), exitSol, reason, exitSol, position.id);
    return { exitSol, txCostSol: 0.001 };
  }

  async walletSol(): Promise<number> {
    return this.wallet;
  }

  async healthProbe(): Promise<number> {
    return 1;
  }
}
