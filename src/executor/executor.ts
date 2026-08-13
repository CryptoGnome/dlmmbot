import type { ExitReason, Position, RangePlan } from "../types.js";

// Executor interface — one implementation per mode. The manager only talks to
// this interface; it never knows whether fills are simulated or on-chain.

export interface OpenParams {
  poolAddress: string;
  tokenMint: string;
  symbol: string;
  sizeSol: number;
  range: RangePlan;
  entryPrice: number;
  trancheOf?: number;
}

export interface PositionMark {
  /** Mark-to-market value of the position in SOL (both sides + unclaimed fees). */
  valueSol: number;
  unclaimedFeesSol: number;
  activeBinId: number;
  price: number;
  inRange: boolean;
  aboveRange: boolean; // price above our top (win/missed case)
  belowRange: boolean;
  // Pool health at mark time — feeds P0 (TVL drop) and P2 (fee decay).
  tvlUsd: number;
  feeTvl30mPct: number;
  vol30mUsd: number;
}

export interface Executor {
  readonly mode: "paper" | "live";
  open(params: OpenParams): Promise<Position>;
  mark(position: Position): Promise<PositionMark>;
  claimFees(position: Position): Promise<{ claimedSol: number; txCostSol: number }>;
  /** Partial withdraw without closing (profit lock). bps of liquidity. */
  withdraw(position: Position, bps: number): Promise<{ withdrawnSol: number; txCostSol: number }>;
  /** Full exit: withdraw 100%, zap token side to SOL, close accounts. */
  close(position: Position, reason: ExitReason, slippageBps: number): Promise<{ exitSol: number; txCostSol: number }>;
  /** In-place escape hatch reshape (live: Zap rebalance; paper: simulated). */
  escapeRebalance?(position: Position, slippageBps: number): Promise<{ ok: boolean }>;
  walletSol(): Promise<number>;
  /**
   * Cheapest possible "is the RPC answering" check — returns the current slot.
   * A dedicated probe rather than reusing mark(): the book is flat ~87% of
   * wall-clock, and the old health signal (`positions.length === 0 ||
   * marksOk > 0`) treated every flat tick as healthy, so it could not see an
   * outage at all while flat. It was also a global OR over a book that has
   * never held more than 2 positions, so with n=1 any position-specific fault
   * read as a book-wide outage.
   */
  healthProbe(): Promise<number>;
  /** Live only: sell stranded token balances left by failed zap-out swaps. */
  sweepResiduals?(minSol: number): Promise<Array<{ mint: string; symbol: string; soldSol: number; positionId: number | null }>>;
}
