import { ComputeBudgetProgram, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { config } from "../config.js";

/**
 * Priority fee + compute budget sizing for the transactions WE build.
 *
 * A prioritization fee is `compute_unit_price × compute_unit_limit`, and the
 * limit is charged as *requested*, not as consumed. Both halves therefore have
 * to be set deliberately:
 *
 * - The DLMM SDK already simulates its own instruction sets and prepends a
 *   `setComputeUnitLimit`, so opens/removes/claims/closes arrive sized. We must
 *   not add a second one — duplicate compute-budget instructions fail the tx.
 * - The zap swap (`buildJupiterSwapTransaction`) returns Jupiter's swap
 *   instruction ALONE — it drops the `computeBudgetInstructions` Jupiter hands
 *   back. With no limit the runtime defaults to 200k × instruction count, which
 *   both over-reserves a cheap swap and under-reserves a multi-hop route (the
 *   latter fails outright on CU exhaustion, which is a landing bug, not a cost
 *   one). Same for the hand-built unwrap/close-account transactions.
 *
 * Jupiter's own `/swap` path (jupiter.ts, profitBurn.ts) sets both halves via
 * `dynamicComputeUnitLimit` + `prioritizationFeeLamports: "auto"` and never
 * goes through here.
 */

// Defaults live in code as well as config.toml: data/config.toml is seeded once
// and never re-seeded, so installs predating these keys read `undefined`.
export const DEFAULT_PERCENTILE = 75;
export const DEFAULT_FLOOR_MICROLAMPORTS = 10_000;
export const DEFAULT_CAP_MICROLAMPORTS = 1_000_000;
export const DEFAULT_RETRY_MULT = 1.5;
export const DEFAULT_CU_MARGIN_PCT = 20;
export const DEFAULT_CU_FALLBACK = 600_000;

/** getRecentPrioritizationFees rejects more than 128 addresses. */
const MAX_LOCKED_ACCOUNTS = 128;

/** Per-transaction ceiling the runtime enforces. */
export const MAX_COMPUTE_UNITS = 1_400_000;

/** ComputeBudget instruction discriminants (first data byte). */
const CU_LIMIT_DISCRIMINANT = 2;
const CU_PRICE_DISCRIMINANT = 3;

export interface PriorityFeeSettings {
  percentile: number;
  floorMicroLamports: number;
  capMicroLamports: number;
  retryMult: number;
  cuMarginPct: number;
  cuFallback: number;
}

export function priorityFeeSettings(): PriorityFeeSettings {
  const e = config().exec;
  return {
    percentile: e.priority_fee_percentile ?? DEFAULT_PERCENTILE,
    floorMicroLamports: e.priority_fee_floor_microlamports ?? DEFAULT_FLOOR_MICROLAMPORTS,
    capMicroLamports: e.priority_fee_cap_microlamports ?? DEFAULT_CAP_MICROLAMPORTS,
    retryMult: e.priority_fee_retry_mult ?? DEFAULT_RETRY_MULT,
    cuMarginPct: e.compute_unit_margin_pct ?? DEFAULT_CU_MARGIN_PCT,
    cuFallback: e.compute_unit_fallback ?? DEFAULT_CU_FALLBACK,
  };
}

/**
 * Percentile of the NONZERO samples, clamped.
 *
 * Nonzero-only because the raw distribution is mostly zeros (unprioritised
 * transactions), whose median says nothing about what it costs to compete.
 * The 75th rather than the median because this fee is paid when we most need
 * the tx to land — a P0/P1 exit during the volatility that triggered it — and
 * underpaying there costs far more than the few thousand lamports it saves.
 */
export function pickFeeMicroLamports(samples: number[], s: PriorityFeeSettings): number {
  const nonzero = samples.filter((f) => Number.isFinite(f) && f > 0).sort((a, b) => a - b);
  if (!nonzero.length) return clampFee(s.floorMicroLamports, s);
  const pct = Math.min(Math.max(s.percentile, 0), 100);
  const idx = Math.min(nonzero.length - 1, Math.floor((pct / 100) * nonzero.length));
  return clampFee(nonzero[idx]!, s);
}

export function clampFee(microLamports: number, s: PriorityFeeSettings): number {
  const cap = Math.max(s.capMicroLamports, s.floorMicroLamports);
  return Math.round(Math.min(Math.max(microLamports, s.floorMicroLamports), cap));
}

/**
 * Bump the price for retry `attempt` (0-based).
 *
 * The retry loop exists for "signed, broadcast, never confirmed" — the failure
 * a too-low fee produces. Re-sending the identical fee is the one thing
 * guaranteed not to fix it.
 */
export function escalate(base: number, attempt: number, s: PriorityFeeSettings): number {
  if (attempt <= 0) return clampFee(base, s);
  const mult = s.retryMult > 1 ? s.retryMult : 1;
  return clampFee(base * Math.pow(mult, attempt), s);
}

/** Writable accounts a tx locks — the contention set the fee actually competes for. */
export function writableAccountsOf(tx: Transaction): PublicKey[] {
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  for (const ix of tx.instructions) {
    for (const k of ix.keys) {
      if (!k.isWritable) continue;
      const b58 = k.pubkey.toBase58();
      if (seen.has(b58)) continue;
      seen.add(b58);
      out.push(k.pubkey);
      if (out.length >= MAX_LOCKED_ACCOUNTS) return out;
    }
  }
  return out;
}

function isComputeBudgetIx(ix: TransactionInstruction, discriminant: number): boolean {
  return ix.programId.equals(ComputeBudgetProgram.programId)
    && ix.data.length > 0
    && ix.data[0] === discriminant;
}

export function hasComputeUnitLimit(tx: Transaction): boolean {
  return tx.instructions.some((ix) => isComputeBudgetIx(ix, CU_LIMIT_DISCRIMINANT));
}

export function computeUnitPriceIxIndex(tx: Transaction): number {
  return tx.instructions.findIndex((ix) => isComputeBudgetIx(ix, CU_PRICE_DISCRIMINANT));
}

/** Minimal slice of Connection this module needs — keeps it stubbable in tests. */
export interface FeeConnection {
  getRecentPrioritizationFees(cfg?: { lockedWritableAccounts?: PublicKey[] }): Promise<Array<{ prioritizationFee: number }>>;
}

/**
 * Fee for the accounts this tx writes, falling back to the network-wide sample.
 *
 * The account-scoped query is the whole point: a global median under-prices a
 * contended pool and over-prices a quiet one, and "contended pool" is exactly
 * the state we transact in.
 */
export async function recentFeeMicroLamports(
  connection: FeeConnection,
  writableAccounts: PublicKey[],
  s: PriorityFeeSettings,
): Promise<number> {
  let samples: Array<{ prioritizationFee: number }> = [];
  if (writableAccounts.length) {
    samples = await connection
      .getRecentPrioritizationFees({ lockedWritableAccounts: writableAccounts })
      .catch(() => []);
  }
  // Empty is a real answer for a cold account, but it is also what an RPC that
  // ignores the filter returns — either way the network sample is the better
  // estimate than falling straight to the floor.
  if (!samples.length) {
    samples = await connection.getRecentPrioritizationFees().catch(() => []);
  }
  return pickFeeMicroLamports(samples.map((f) => f.prioritizationFee), s);
}

export function computeUnitPriceIx(microLamports: number): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
}

/**
 * Set the price on `tx`, replacing any existing one.
 *
 * Replace rather than append: two compute-budget instructions of the same kind
 * fail the transaction. Today nothing upstream sets a price (the DLMM SDK sets
 * only limits, the zap swap sets nothing), but a blind append would turn a
 * future SDK bump into a hard-to-read on-chain failure — and the retry path
 * calls this repeatedly on one transaction by design.
 */
export function setComputeUnitPrice(tx: Transaction, microLamports: number): void {
  const ix = computeUnitPriceIx(microLamports);
  const idx = computeUnitPriceIxIndex(tx);
  if (idx >= 0) tx.instructions[idx] = ix;
  else tx.instructions.push(ix);
}

export function computeUnitLimitIx(units: number): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitLimit({ units: Math.round(units) });
}

/** Minimal slice of Connection needed to size a compute-unit limit. */
export interface SimConnection {
  simulateTransaction(tx: Transaction): Promise<{ value: { unitsConsumed?: number | null; err: unknown } }>;
}

/**
 * Units to request for `tx`: simulated consumption plus margin.
 *
 * Returns null when the tx already carries a limit (the DLMM SDK path) — a
 * second compute-budget instruction of the same kind fails the transaction.
 * A failed or unit-less simulation falls back to a bounded default rather than
 * leaving the implicit 200k-per-instruction default in place, since that
 * default is what under-reserves multi-hop swap routes.
 */
export async function computeUnitLimitFor(
  connection: SimConnection,
  tx: Transaction,
  s: PriorityFeeSettings,
): Promise<number | null> {
  if (hasComputeUnitLimit(tx)) return null;
  // Simulate against the MAXIMUM limit, not the tx as-is. Without an explicit
  // limit the runtime applies 200k × instruction count, so a route that needs
  // more than that fails simulation with CU exhaustion — reporting no usable
  // number for precisely the transactions whose true cost we most need. The
  // probe is a throwaway copy; the caller's tx is untouched.
  const probe = new Transaction();
  probe.recentBlockhash = tx.recentBlockhash;
  probe.feePayer = tx.feePayer;
  probe.add(computeUnitLimitIx(MAX_COMPUTE_UNITS), ...tx.instructions);

  const sim = await connection.simulateTransaction(probe).catch(() => null);
  const consumed = sim?.value?.unitsConsumed;
  if (sim && !sim.value.err && typeof consumed === "number" && consumed > 0) {
    const margin = Math.max(s.cuMarginPct, 0);
    return Math.min(Math.ceil(consumed * (1 + margin / 100)), MAX_COMPUTE_UNITS);
  }
  return Math.min(Math.max(s.cuFallback, 1), MAX_COMPUTE_UNITS);
}
