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

  const binCount = maxBinId - minBinId + 1;
  return {
    minBinId,
    maxBinId,
    binCount,
    positionAccounts: Math.ceil(binCount / BINS_PER_POSITION),
    bottomPricePct: (binIdToPrice(minBinId, binStep, decimalsX) / currentPrice - 1) * 100,
    fibAnchor,
    // ~0.000015 SOL per never-before-funded bin is negligible; the real cost is
    // binArray account creation (~0.075 SOL per array of 70 bins, refundable
    // only if we created it). Estimate worst case; executor refines on-chain.
    estBinRentSol: Math.ceil(binCount / 70) * 0.075,
  };
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
  const binCount = maxBinId - minBinId + 1;
  return {
    minBinId,
    maxBinId,
    binCount,
    positionAccounts: Math.ceil(binCount / BINS_PER_POSITION),
    bottomPricePct: (binIdToPrice(minBinId, binStep, decimalsX) / currentPrice - 1) * 100,
    fibAnchor: null,
    estBinRentSol: Math.ceil(binCount / 70) * 0.075,
  };
}
