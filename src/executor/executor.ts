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
  /** Seconds since the pool was created; null when the listing has no created_at. Feeds the P0 tvl_drain age floor. */
  poolAgeS?: number | null;
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
  /** Escape hatch hook — always returns ok:false; hatch closes instead of Zap reshape. */
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

/**
 * Floor for the residual sweep: below this a sell costs more in tx fees than it
 * returns, so the sweep deliberately skips it. Lives here rather than in the
 * loop because the close path needs the same number — a leftover under this
 * floor is dust nothing will ever recover, and must not be reported as a
 * recoverable strand.
 */
export const RESIDUAL_SWEEP_MIN_SOL = 0.002;

/**
 * What a close left behind in the wallet, and what to do about it.
 *
 *   "none"   nothing left — a clean close.
 *   "dust"   quoted below the sweep floor. Nothing will ever convert it, so it
 *            is written off at close: no incident, no stranded credit.
 *   "strand" recoverable (or unpriceable). Raises `close_underfilled`, and when
 *            priced, carries a stranded_sol credit until the sweep settles it.
 *
 * An UNQUOTABLE leftover is a strand, not dust: being unable to price it is
 * exactly when we must not assume it is worthless. It still earns no credit —
 * `creditSol` stays 0 — because REALIZED_PNL may only count what we can value.
 */
export function classifyLeftover(
  leftoverTokenSol: number | null,
  markSol: number,
  hasTokens: boolean,
): { kind: "none" | "dust" | "strand"; share: number | null; creditSol: number } {
  if (!hasTokens) return { kind: "none", share: null, creditSol: 0 };
  if (leftoverTokenSol === null || !Number.isFinite(leftoverTokenSol)) {
    return { kind: "strand", share: null, creditSol: 0 };
  }
  const share = markSol > 0 ? leftoverTokenSol / markSol : null;
  if (leftoverTokenSol < RESIDUAL_SWEEP_MIN_SOL) return { kind: "dust", share, creditSol: 0 };
  return { kind: "strand", share, creditSol: leftoverTokenSol };
}
