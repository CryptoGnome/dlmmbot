import type { Config } from "../config.js";

/** One 15s manager poll, enriched with everything the ladder reads. */
export interface SimMark {
  ts: number;
  binId: number | null;
  price: number;
  valueSol: number;
  valueFrac: number;
  /** Fees earned since entry: claimed plus whatever is currently unclaimed. */
  cumFeesSol: number;
  /** Fees sitting unclaimed in the position right now — already inside valueSol. */
  unclaimedSol: number;
  inRange: boolean;
  belowRange: boolean;
  aboveRange: boolean;
  /** 0 = bottom bin, 1 = top bin, <0 below the range, >1 above it. */
  depthFrac: number | null;
}

/** Why a trace cannot be trusted for counterfactuals. */
export type TraceFlag =
  | "few_marks"
  | "marks_end_zero_but_recovered"
  | "no_bins"
  | "sparse_coverage"
  | "unreplayable_exit";

export interface Trace {
  id: number;
  book: string;
  symbol: string;
  mint: string;
  pool: string;
  sleeve: "meme" | "micro" | "majors";
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  entrySol: number;
  minBinId: number;
  maxBinId: number;
  everInRange: boolean;
  /** Realized PnL from the ledger (REALIZED_PNL_SQL). */
  actualPnl: number;
  actualReason: string;
  /** Minutes between our first sight of the token and entry; null if unknown. */
  ageMin: number | null;
  marks: SimMark[];
  flags: TraceFlag[];
}

/** The subset of exit reasons this simulator can reproduce from marks alone. */
export type SimReason =
  | "price_crash"
  | "P1_stop"
  | "P2_age"
  | "P3_above"
  | "P5_below"
  | "escape"
  | "held";

export interface Replay {
  /** Index into trace.marks where the rule fired; null = held to the last mark. */
  firedIdx: number | null;
  reason: SimReason;
  /** Proceeds at the exit point: position value + fees banked by then. */
  proceedsSol: number;
  /** SOL taken off the table by profit-lock withdrawals before the exit. */
  bankedSol: number;
}

export interface Outcome {
  trace: Trace;
  base: Replay;
  variant: Replay;
  /** variant − base, in SOL, on the same measurement basis. */
  delta: number;
  /** Counterfactual PnL: actual + delta. */
  simPnl: number;
}

export interface CohortFilter {
  sleeve?: Trace["sleeve"][];
  ageMaxMin?: number;
  ageMinMin?: number;
  book?: string[];
  minMarks?: number;
  sinceTs?: number;
  /** Keep traces flagged as untrustworthy (off by default). */
  includeFlagged?: boolean;
}

export type ConfigOverlay = Record<string, unknown>;

export interface Scenario {
  label: string;
  overlay: ConfigOverlay;
  config: Config;
}
