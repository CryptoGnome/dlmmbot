// Core domain types shared across modules.

/** Normalized view of a DLMM pool from the Meteora datapi. */
export interface PoolInfo {
  address: string;
  name: string;
  mintX: string;            // base token
  mintY: string;            // quote token (SOL in meme mode)
  binStep: number;
  baseFeePct: number;
  dynamicFeePct: number | null;
  tvlUsd: number;
  price: number;            // pool price (Y per X)
  decimalsX: number;        // base token decimals — bin math needs the raw-unit price
  vol30mUsd: number;
  vol1hUsd: number;
  vol24hUsd: number;
  feeTvl30mPct: number;     // ratio for the window, in %
  feeTvl24hPct: number;
  feesBothTokens: boolean;
  createdAt: string | null;
}

export interface GateFailure { gate: string; value: string; limit: string }

export interface Candidate {
  pool: PoolInfo;
  tokenMint: string;
  symbol: string;
  score: number;                 // 0-100 opportunity score
  scoreParts: Record<string, number>;
  gateFailures: GateFailure[];   // empty = passed pool gates
}

export type VetVerdict = "pass" | "fail" | "error";

export interface VetResult {
  mint: string;
  verdict: VetVerdict;
  hardFailures: GateFailure[];
  softScore: number;             // 0-100, feeds opportunity score w_vetting_soft
  facts: {
    mintAuthority: string | null;
    freezeAuthority: string | null;
    tokenProgram: string;
    token2022Extensions: string[];
    singleHolderPct: number | null;
    top10Pct: number | null;
    holderCount: number | null;
    insiderClusterPct: number | null;
    creatorAddress: string | null;
    creatorRugCount: number | null;
    rugcheckScoreNormalised: number | null;
    rugcheckRisks: Array<{ name: string; score: number; level: string }>;
    launchpad: string | null;
    tokenAgeMinutes: number | null;
  };
}

export interface RangePlan {
  minBinId: number;
  maxBinId: number;              // active bin at entry (range top)
  binCount: number;
  positionAccounts: number;      // 1..entry.max_position_accounts
  bottomPricePct: number;        // e.g. -55 (% below entry price)
  fibAnchor: { swingHigh: number; swingLow: number; level: number } | null;
  estBinRentSol: number;
}

export type PositionState =
  | "pending" | "open" | "closing"
  | "closed_win" | "closed_missed" | "closed_stop" | "closed_safety"
  | "closed_rotation" | "closed_below" | "closed_manual";

export type ExitReason = "P0_safety" | "P1_stop" | "P2_rotation" | "P3_above" | "P5_below" | "manual";

export interface Position {
  id: number;
  mode: "paper" | "live";
  poolAddress: string;
  tokenMint: string;
  symbol: string;
  trancheOf: number | null;
  entryTs: number;
  entryPrice: number;
  entrySol: number;
  minBinId: number;
  maxBinId: number;
  state: PositionState;
  feesClaimedSol: number;
  rentPaidSol: number;
  profitLockFires: number;
  exitTs: number | null;
  exitSol: number | null;
  exitReason: ExitReason | null;
}

export type EventType =
  | "open" | "claim" | "rebalance" | "profit_lock" | "escape_hatch"
  | "safety_exit" | "stop_loss" | "rotation" | "take_profit" | "below_cut"
  | "deposit" | "withdraw";

export type DecisionAction = "entered" | "skipped" | "exited";
