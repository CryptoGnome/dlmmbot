import { Connection, PublicKey } from "@solana/web3.js";
import { createRequire } from "node:module";
import { config, env } from "../config.js";
import type { RangePlan } from "../types.js";
import { fitPlanToRentBudget } from "./planner.js";

/** Worst-case estimate used by planners (matches planner.ts). */
export const BIN_ARRAY_RENT_SOL = 0.075;

interface QuoteResult {
  binArraysCount: number;
  binArrayCost: number;
}

interface DlmmPool {
  quoteCreatePosition(params: {
    strategy: { minBinId: number; maxBinId: number };
  }): Promise<QuoteResult>;
}

interface DlmmStatic {
  create(connection: Connection, dlmm: PublicKey): Promise<DlmmPool>;
}

const dlmmMod = createRequire(import.meta.url)("@meteora-ag/dlmm") as {
  default?: DlmmStatic;
} & DlmmStatic;
const DLMM: DlmmStatic = dlmmMod.default ?? dlmmMod;

let sharedConn: Connection | null = null;
function rpc(): Connection {
  if (!sharedConn) {
    sharedConn = new Connection(env().rpcUrl, { commitment: "confirmed" });
  }
  return sharedConn;
}

/** Soft = one array; hard = two arrays when score ≥ hard_score_min. */
export function tierBinRentBudget(score: number): { budgetSol: number; tier: "soft" | "hard" } {
  const e = config().entry;
  const soft = e.bin_rent_budget_sol;
  const hard = e.bin_rent_hard_sol ?? soft * 2;
  const minScore = e.bin_rent_hard_score_min ?? 80;
  if (score >= minScore) return { budgetSol: hard, tier: "hard" };
  return { budgetSol: soft, tier: "soft" };
}

export type BinRentQuoteSource = "quote" | "estimate" | "error";

export interface ActualBinRent {
  actualSol: number;
  arrays: number;
  source: BinRentQuoteSource;
}

/**
 * On-chain count of uninitialized bin arrays × SDK fee.
 * On RPC failure: fall back to worst-case estimate (fail closed).
 */
export async function quoteActualBinArrayRent(
  poolAddress: string,
  minBinId: number,
  maxBinId: number,
  estimateSol: number,
): Promise<ActualBinRent> {
  try {
    const pool = await DLMM.create(rpc(), new PublicKey(poolAddress));
    const q = await pool.quoteCreatePosition({
      strategy: { minBinId, maxBinId },
    });
    return {
      actualSol: q.binArrayCost,
      arrays: q.binArraysCount,
      source: "quote",
    };
  } catch {
    return {
      actualSol: estimateSol,
      arrays: Math.ceil(estimateSol / BIN_ARRAY_RENT_SOL - 1e-12) || 0,
      source: "error",
    };
  }
}

export interface BinRentGateMeta {
  est: number;
  actual: number | null;
  budget: number;
  tier: "soft" | "hard";
  source: BinRentQuoteSource | "none";
  shrunk: boolean;
}

export type BinRentGateResult =
  | { ok: true; range: RangePlan; meta: BinRentGateMeta }
  | { ok: false; range: RangePlan; meta: BinRentGateMeta };

/**
 * Soft shrink to bin_rent_budget_sol; if still over, quote actual arrays and
 * allow when actual ≤ score-tier budget (soft 1 array / hard 2 arrays).
 */
export async function applyBinRentGate(opts: {
  range: RangePlan;
  score: number;
  poolAddress: string;
  price: number;
  binStep: number;
  decimalsX: number;
  minDownPct: number;
  /** Test hook — defaults to on-chain quote. */
  quote?: typeof quoteActualBinArrayRent;
}): Promise<BinRentGateResult> {
  const softBudget = config().entry.bin_rent_budget_sol;
  const { budgetSol, tier } = tierBinRentBudget(opts.score);
  let range = opts.range;
  let shrunk = false;

  if (range.estBinRentSol <= softBudget) {
    return {
      ok: true,
      range,
      meta: { est: range.estBinRentSol, actual: null, budget: softBudget, tier: "soft", source: "none", shrunk },
    };
  }

  const fitted = fitPlanToRentBudget(
    range, softBudget, opts.price, opts.binStep, opts.decimalsX, opts.minDownPct,
  );
  if (fitted && fitted.estBinRentSol <= softBudget) {
    return {
      ok: true,
      range: fitted,
      meta: {
        est: opts.range.estBinRentSol,
        actual: null,
        budget: softBudget,
        tier: "soft",
        source: "none",
        shrunk: true,
      },
    };
  }

  const quote = opts.quote ?? quoteActualBinArrayRent;
  const quoted = await quote(
    opts.poolAddress, range.minBinId, range.maxBinId, range.estBinRentSol,
  );
  const meta: BinRentGateMeta = {
    est: range.estBinRentSol,
    actual: quoted.actualSol,
    budget: budgetSol,
    tier,
    source: quoted.source,
    shrunk,
  };

  if (quoted.actualSol <= budgetSol) {
    return { ok: true, range, meta };
  }
  return { ok: false, range, meta };
}
