import { config } from "../config.js";
import type { Candle } from "../scanner/meteora.js";
import type { RangePlan } from "../types.js";

// STRATEGY.md §3 — one-sided SOL bid-ask below current price.
// DLMM bin math: price(binId) = (1 + binStep/10000)^binId

const BINS_PER_POSITION = 69; // one DLMM position account spans <= 69 bins

export function priceToBinId(price: number, binStep: number): number {
  return Math.floor(Math.log(price) / Math.log(1 + binStep / 10_000));
}

export function binIdToPrice(binId: number, binStep: number): number {
  return Math.pow(1 + binStep / 10_000, binId);
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
  candles: Candle[]
): RangePlan {
  const e = config().entry;
  const sw = swing(candles);

  let bottomPrice = currentPrice * (1 - e.max_down_pct / 100);
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

  const maxBinId = priceToBinId(currentPrice, binStep);
  let minBinId = priceToBinId(bottomPrice, binStep);

  // Cap total bins at what max_position_accounts can hold.
  const maxBins = BINS_PER_POSITION * e.max_position_accounts;
  if (maxBinId - minBinId + 1 > maxBins) minBinId = maxBinId - maxBins + 1;

  const binCount = maxBinId - minBinId + 1;
  return {
    minBinId,
    maxBinId,
    binCount,
    positionAccounts: Math.ceil(binCount / BINS_PER_POSITION),
    bottomPricePct: (binIdToPrice(minBinId, binStep) / currentPrice - 1) * 100,
    fibAnchor,
    // ~0.000015 SOL per never-before-funded bin is negligible; the real cost is
    // binArray account creation (~0.075 SOL per array of 70 bins, refundable
    // only if we created it). Estimate worst case; executor refines on-chain.
    estBinRentSol: Math.ceil(binCount / 70) * 0.075,
  };
}
