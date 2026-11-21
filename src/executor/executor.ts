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
  /**
   * "active" (default): the range top re-anchors to the live active bin,
   * width preserved — the primary's rule. "planned": open exactly the planned
   * bins, which must sit strictly below the active bin — a tranche pocket
   * under its primary. Paper always opens the planned bins.
   */
  anchor?: "active" | "planned";
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

/**
 * What a multi-account open actually put on chain when a later account failed.
 *
 * The planner asks for up to two position accounts and open() sends one tx per
 * account. Until 2026-11-21 a failure on the second threw away the fact that
 * the first had landed: no row, no exit rules, and 0.47 / 0.75 SOL sat
 * unmanaged for 7.5 h and 33 h (CatGPT 09-07, biketyson 09-15) until a restart
 * adopted them. The landed part is a smaller, valid position — record it.
 * Returns null when nothing landed, which is the only case open() may throw.
 */
export function landedOpenShape(
  landed: Array<{ min: number; max: number; share: number }>,
  plannedSizeSol: number,
): { sizeSol: number; minBin: number; maxBin: number } | null {
  if (landed.length === 0) return null;
  const share = Math.min(1, landed.reduce((s, c) => s + c.share, 0));
  return {
    sizeSol: plannedSizeSol * share,
    minBin: Math.min(...landed.map((c) => c.min)),
    maxBin: Math.max(...landed.map((c) => c.max)),
  };
}

/**
 * Split one rent-reclaim tx's measured wallet delta across the accounts it
 * closed, in proportion to the lamports each held. The shares always sum to
 * the delta, so the book gains exactly what the wallet did (tx fee included).
 * A null delta means the tx could not be fetched: the rent still came back, so
 * fall back to the lamports themselves rather than recording zero.
 */
export function splitRentReclaim(lamports: number[], deltaSol: number | null): number[] {
  const total = lamports.reduce((s, l) => s + Math.max(0, l), 0);
  if (lamports.length === 0) return [];
  if (deltaSol === null || !Number.isFinite(deltaSol)) return lamports.map((l) => Math.max(0, l) / 1e9);
  if (total <= 0) return lamports.map(() => deltaSol / lamports.length);
  return lamports.map((l) => (Math.max(0, l) / total) * deltaSol);
}

/**
 * Cost basis of a position adopted from chain, from the wallet deltas of the
 * txs that created its accounts. Null unless EVERY delta is known and the net
 * is an outflow — a partial sum would understate the cost and book a phantom
 * profit, which is the bug this replaces (pos#309: first-mark basis 0.629 vs
 * 0.471 actually paid, hiding 0.158 SOL of real PnL).
 */
export function openCostFromTxDeltas(deltasSol: Array<number | null>): number | null {
  if (deltasSol.length === 0 || deltasSol.some((d) => d === null || !Number.isFinite(d))) return null;
  const net = (deltasSol as number[]).reduce((s, d) => s + d, 0);
  return net < 0 ? -net : null;
}

/**
 * Network + priority fees actually paid for a set of txs, from the fees
 * walletDelta saw when it fetched them. Null when any is unknown, so a caller
 * falls back to its estimate instead of reporting part of the cost as all of it.
 */
export function sumKnownFeesSol(sigs: string[], feeLamportsBySig: ReadonlyMap<string, number>): number | null {
  let lamports = 0;
  for (const sig of sigs) {
    const fee = feeLamportsBySig.get(sig);
    if (fee === undefined) return null;
    lamports += fee;
  }
  return lamports / 1e9;
}

/** Bins one position account holds (SDK limit is 70; one is kept spare). */
export const BINS_PER_ACCOUNT = 69;

/**
 * Bins of the `index`-th position account of a range, top account first. Always
 * derived from the range as it stands NOW: open() re-anchors the range when the
 * first account hits bin slippage, and a later account built from the original
 * top would overlap the first or leave a gap by the size of the shift.
 */
export function chunkBins(index: number, curMin: number, curMax: number): { min: number; max: number } {
  const total = curMax - curMin + 1;
  const start = index * BINS_PER_ACCOUNT;
  const end = Math.min(start + BINS_PER_ACCOUNT - 1, total - 1);
  return { min: curMax - end, max: curMax - start };
}

/**
 * On-chain position accounts in a pool where the DB already has an open row,
 * sorted into: `attach` — funded and unknown to every row, so it can only be
 * part of that open position (a later account whose tx fate was unknown and
 * then landed); `foreign` — funded but still owned by some other, closed row,
 * which must be looked at by a human rather than grafted onto a live position.
 */
export function strayChainAccounts(
  chain: Array<{ pubkey: string; hasLiquidity: boolean }>,
  trackedByOpenRows: ReadonlySet<string>,
  trackedByAnyRow: ReadonlySet<string>,
): { attach: string[]; foreign: string[] } {
  const attach: string[] = [], foreign: string[] = [];
  for (const a of chain) {
    if (!a.hasLiquidity || trackedByOpenRows.has(a.pubkey)) continue;
    (trackedByAnyRow.has(a.pubkey) ? foreign : attach).push(a.pubkey);
  }
  return { attach, foreign };
}
