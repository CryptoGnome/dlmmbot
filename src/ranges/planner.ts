import { config } from "../config.js";
import type { Candle } from "../scanner/meteora.js";
import type { RangePlan } from "../types.js";

// STRATEGY.md §3 — one-sided SOL bid-ask below current price.
// DLMM bin math: rawPrice(binId) = (1 + binStep/10000)^binId, where rawPrice is
// in RAW units (lamports of Y per base unit of X) — NOT the UI price the datapi
// reports. rawPrice = uiPrice * 10^(9 - decimalsX) for a SOL quote. Feeding the
// UI price directly shifts every bin by 10^(9-decimalsX): incident 2026-08-07,
// live HTZ position (6-decimal token) placed 1000x below market, ~857 bins off.

const BINS_PER_POSITION = 69; // one DLMM position account spans <= 69 bins
const SOL_DECIMALS = 9;
/** Worst-case bin-array rent; matches estBinRentSol in planRange / planFollowRange. */
const BIN_ARRAY_RENT_SOL = 0.075;
const BINS_PER_ARRAY_EST = 70;

// Margin between the deepest bin we will fund and the P0 price-crash exit.
// P0 force-closes the position at safety_price_crash_pct, so any bin below that
// line can never trade — and in a bid-ask ladder those are the bins holding the
// MOST capital (weight rises with depth). ZEUS pos#24: a -64.8% range against a
// -60% trigger left 13 of 106 bins unreachable, but 22.9% of the position — 0.069
// SOL — parked in them, idle for the whole hold. The margin keeps the last few
// fundable bins on the live side of the trigger rather than exactly on it.
const SAFETY_MARGIN_PCT = 10;

export function priceToBinId(uiPrice: number, binStep: number, decimalsX: number): number {
  const rawPrice = uiPrice * 10 ** (SOL_DECIMALS - decimalsX);
  return Math.floor(Math.log(rawPrice) / Math.log(1 + binStep / 10_000));
}

export function binIdToPrice(binId: number, binStep: number, decimalsX: number): number {
  return Math.pow(1 + binStep / 10_000, binId) * 10 ** (decimalsX - SOL_DECIMALS);
}

function buildPlan(
  minBinId: number,
  maxBinId: number,
  currentPrice: number,
  binStep: number,
  decimalsX: number,
  fibAnchor: RangePlan["fibAnchor"],
): RangePlan {
  const binCount = maxBinId - minBinId + 1;
  return {
    minBinId,
    maxBinId,
    binCount,
    positionAccounts: Math.ceil(binCount / BINS_PER_POSITION),
    bottomPricePct: (binIdToPrice(minBinId, binStep, decimalsX) / currentPrice - 1) * 100,
    shape: "bidask",
    fibAnchor,
    estBinRentSol: binArraysSpanned(minBinId, maxBinId) * BIN_ARRAY_RENT_SOL,
  };
}

/**
 * Bin arrays actually touched by [minBinId, maxBinId]. On-chain arrays are
 * fixed 70-bin segments aligned at floor(binId/70)*70 — so a 70-bin range
 * spans TWO arrays unless it happens to start on an array boundary (~1 in 70).
 * The old ceil(binCount/70) systematically under-charged the common case, and
 * binRent skips the on-chain quote exactly when the estimate fits the soft
 * budget — the gate was blind precisely where the estimate was wrong.
 */
export function binArraysSpanned(minBinId: number, maxBinId: number): number {
  return Math.floor(maxBinId / BINS_PER_ARRAY_EST) - Math.floor(minBinId / BINS_PER_ARRAY_EST) + 1;
}

/**
 * Raise the range bottom (fewer bins) until estimated bin-array rent fits
 * budgetSol. Never shallower than minDownPct — return null if rent and depth
 * cannot both be satisfied (caller skips with bin_rent).
 */
export function fitPlanToRentBudget(
  plan: RangePlan,
  budgetSol: number,
  currentPrice: number,
  binStep: number,
  decimalsX: number,
  minDownPct: number,
): RangePlan | null {
  if (plan.estBinRentSol <= budgetSol) return plan;
  const maxArrays = Math.floor(budgetSol / BIN_ARRAY_RENT_SOL + 1e-12);
  if (maxArrays < 1) return null;
  // Aligned inversion of binArraysSpanned: the lowest minBinId that keeps the
  // range within maxArrays fixed 70-bin segments is the first bin of the
  // lowest allowed array.
  const minBinForRent = (Math.floor(plan.maxBinId / BINS_PER_ARRAY_EST) - maxArrays + 1) * BINS_PER_ARRAY_EST;
  const minBinForDepth = priceToBinId(currentPrice * (1 - minDownPct / 100), binStep, decimalsX);
  // Higher minBinId = shallower. Rent forces minBinForRent; depth requires
  // minBinId <= minBinForDepth. Impossible when rent floor is above depth floor.
  if (minBinForRent > minBinForDepth) return null;
  return buildPlan(minBinForRent, plan.maxBinId, currentPrice, binStep, decimalsX, plan.fibAnchor);
}

/** Swing high/low from candles (max 24h lookback of 5m candles). */
export function swing(candles: Candle[]): { high: number; low: number } | null {
  if (candles.length < 6) return null;
  return {
    high: Math.max(...candles.map((c) => c.high)),
    low: Math.min(...candles.map((c) => c.low)),
  };
}

/** Fib retracement level measured from the swing high, toward/below the low. */
export function fibLevel(high: number, low: number, level: number): number {
  return high - (high - low) * level;
}

/**
 * Can a range `downPct` deep even be built on this pool?
 *
 * Bins are geometric, so a fine-step pool needs far more of them to span the
 * same price move: -40% is 52 bins at step 100, but 256 at step 20 and 512 at
 * step 10, against a ceiling of BINS_PER_POSITION * max_position_accounts
 * (138 today). `planRange` silently truncates to that ceiling, which is how
 * ANSEM/PUMP/MET/ORE positions ended up 11-15% deep while `min_down_pct` said
 * 40 — a third of the intended range, with no signal that anything was wrong.
 *
 * `fitPlanToRentBudget` already refuses to shrink past the depth floor; this
 * closes the same hole on the bin-count side, before we pay for candles.
 */
export function depthReachable(
  downPct: number,
  binStep: number,
  maxPositionAccounts: number,
): { binsNeeded: number; maxBins: number; ok: boolean } {
  const maxBins = BINS_PER_POSITION * maxPositionAccounts;
  if (!(downPct > 0) || downPct >= 100 || !(binStep > 0)) {
    return { binsNeeded: 0, maxBins, ok: true };
  }
  const binsNeeded = Math.ceil(
    Math.log(1 / (1 - downPct / 100)) / Math.log(1 + binStep / 10_000),
  );
  return { binsNeeded, maxBins, ok: binsNeeded <= maxBins };
}

/**
 * Plan the entry range: top = active bin (current price), bottom = the
 * SHALLOWER of fib(entry.fib_bottom) and -max_down_pct, floored at
 * -min_down_pct so the range is never a thin sliver.
 */
export function planRange(
  currentPrice: number,
  binStep: number,
  candles: Candle[],
  decimalsX: number
): RangePlan {
  const e = config().entry;
  const sw = swing(candles);

  // Never plan deeper than P0 will let price travel. Derived rather than left
  // to config so the two numbers cannot drift apart again; clamped above
  // min_down_pct so a tight safety threshold can't invert the range.
  const safetyCapPct = Math.abs(config().manage.safety_price_crash_pct) - SAFETY_MARGIN_PCT;
  const maxDownPct = Math.max(e.min_down_pct, Math.min(e.max_down_pct, safetyCapPct));

  let bottomPrice = currentPrice * (1 - maxDownPct / 100);
  let fibAnchor: RangePlan["fibAnchor"] = null;
  if (sw && sw.low < currentPrice) {
    const fib = fibLevel(sw.high, sw.low, e.fib_bottom);
    if (fib > 0 && fib < currentPrice) {
      bottomPrice = Math.max(bottomPrice, fib); // shallower of the two
      fibAnchor = { swingHigh: sw.high, swingLow: sw.low, level: e.fib_bottom };
    }
  }
  // Never shallower than min_down_pct.
  bottomPrice = Math.min(bottomPrice, currentPrice * (1 - e.min_down_pct / 100));

  const maxBinId = priceToBinId(currentPrice, binStep, decimalsX);
  let minBinId = priceToBinId(bottomPrice, binStep, decimalsX);

  // Cap total bins at what max_position_accounts can hold.
  const maxBins = BINS_PER_POSITION * e.max_position_accounts;
  if (maxBinId - minBinId + 1 > maxBins) minBinId = maxBinId - maxBins + 1;

  return buildPlan(minBinId, maxBinId, currentPrice, binStep, decimalsX, fibAnchor);
}

/**
 * Second tranche (Gmet dual-range): BidAsk pocket *below* the primary, down to
 * the P0-safe floor (tranche_max_down_pct, clamped by safety margin). Returns
 * null when the primary already fills that floor — no room for a second leg.
 */
export function planTrancheRange(
  currentPrice: number,
  binStep: number,
  candles: Candle[],
  decimalsX: number,
  primary: RangePlan,
): RangePlan | null {
  const e = config().entry;
  const safetyCapPct = Math.abs(config().manage.safety_price_crash_pct) - SAFETY_MARGIN_PCT;
  const targetDown = Math.max(
    e.min_down_pct,
    Math.min(e.tranche_max_down_pct ?? 70, safetyCapPct),
  );

  // Sit immediately under the primary so capital is not double-stacked.
  const maxBinId = primary.minBinId - 1;

  let bottomPrice = currentPrice * (1 - targetDown / 100);
  let fibAnchor: RangePlan["fibAnchor"] = null;
  const sw = swing(candles);
  if (sw && sw.low < currentPrice) {
    // 0.786 extension below the swing low — STRATEGY.md §3 second tranche.
    const ext = sw.low - (sw.high - sw.low) * e.fib_bottom;
    if (ext > 0) {
      const floor = currentPrice * (1 - safetyCapPct / 100);
      bottomPrice = Math.min(bottomPrice, Math.max(ext, floor));
      fibAnchor = { swingHigh: sw.high, swingLow: sw.low, level: e.fib_bottom };
    }
  }

  let minBinId = priceToBinId(bottomPrice, binStep, decimalsX);
  if (minBinId > maxBinId) return null;

  const maxBins = BINS_PER_POSITION * e.max_position_accounts;
  if (maxBinId - minBinId + 1 > maxBins) minBinId = maxBinId - maxBins + 1;
  if (minBinId > maxBinId) return null;
  // Skip dust pockets — need a real BidAsk ladder, not a few bins.
  if (maxBinId - minBinId + 1 < 10) return null;

  return buildPlan(minBinId, maxBinId, currentPrice, binStep, decimalsX, fibAnchor);
}

/**
 * Follow-mode range (manager/follow.ts): fixed depth below current price, no
 * fib/swing input — a follow leg re-bids under a price that just made a new
 * high, where the recent swing low sits below the chain's loss budget anyway.
 * Allows the same account split as the main planner: at bin step >= 55 a 30%
 * depth fits one 69-bin account, but a fine-step pool (ANSEM-SOL, step ~20)
 * clamped to one account comes out ~-13% deep — a shallowness the follow sim
 * shows gets run through by the median 26% hot-window retrace.
 */
export function planFollowRange(
  currentPrice: number,
  binStep: number,
  depthPct: number,
  decimalsX: number
): RangePlan {
  const maxBinId = priceToBinId(currentPrice, binStep, decimalsX);
  let minBinId = priceToBinId(currentPrice * (1 - depthPct / 100), binStep, decimalsX);
  const maxBins = BINS_PER_POSITION * config().entry.max_position_accounts;
  if (maxBinId - minBinId + 1 > maxBins) minBinId = maxBinId - maxBins + 1;
  return buildPlan(minBinId, maxBinId, currentPrice, binStep, decimalsX, null);
}
