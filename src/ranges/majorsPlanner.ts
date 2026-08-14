import { config } from "../config.js";
import type { Candle } from "../scanner/meteora.js";
import type { RangePlan } from "../types.js";
import { binArraysSpanned, binIdToPrice, priceToBinId, swing } from "./planner.js";

const BINS_PER_POSITION = 69;
const BIN_ARRAY_RENT_SOL = 0.075;

function buildSpotPlan(
  minBinId: number, maxBinId: number, centerPrice: number, binStep: number, decimalsX: number,
): RangePlan {
  const binCount = maxBinId - minBinId + 1;
  return {
    minBinId, maxBinId, binCount,
    positionAccounts: Math.ceil(binCount / BINS_PER_POSITION),
    bottomPricePct: (binIdToPrice(minBinId, binStep, decimalsX) / centerPrice - 1) * 100,
    topPricePct: (binIdToPrice(maxBinId, binStep, decimalsX) / centerPrice - 1) * 100,
    shape: "spot",
    fibAnchor: null,
    estBinRentSol: binArraysSpanned(minBinId, maxBinId) * BIN_ARRAY_RENT_SOL,
  };
}

/** Spot range centered on price — uniform liquidity (STRATEGY §10). */
export function planMajorsSpotRange(
  currentPrice: number, binStep: number, decimalsX: number,
): RangePlan {
  const mj = config().majors;
  const centerBin = priceToBinId(currentPrice, binStep, decimalsX);
  const belowBin = Math.max(1, Math.round(mj.range_below_pct / (binStep / 100)));
  const aboveBin = Math.max(0, Math.round(mj.range_above_pct / (binStep / 100)));
  let minBinId = centerBin - belowBin;
  let maxBinId = centerBin + aboveBin;
  const maxBins = BINS_PER_POSITION * config().entry.max_position_accounts;
  if (maxBinId - minBinId + 1 > maxBins) minBinId = maxBinId - maxBins + 1;
  return buildSpotPlan(minBinId, maxBinId, currentPrice, binStep, decimalsX);
}

export function rsi(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i]!.close - slice[i - 1]!.close;
    if (d >= 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

export function swingPosition(price: number, candles: Candle[]): number | null {
  const sw = swing(candles);
  if (!sw || sw.high <= sw.low) return null;
  return Math.max(0, Math.min(1, (price - sw.low) / (sw.high - sw.low)));
}

export interface MajorsEntryTiming {
  ok: boolean;
  rsi: number | null;
  swingPos: number | null;
  reason?: string;
}

/** Enter on dips (RSI or lower swing), skip local highs. */
export function majorsEntryTiming(candles: Candle[], price: number): MajorsEntryTiming {
  const mj = config().majors;
  const r = rsi(candles, mj.entry_rsi_period);
  const sp = swingPosition(price, candles);

  if (sp !== null && sp > mj.entry_swing_avoid_top) {
    return { ok: false, rsi: r, swingPos: sp, reason: "majors_swing_high" };
  }
  const rsiOk = r !== null && r <= mj.entry_rsi_max;
  const swingOk = sp !== null && sp <= mj.entry_swing_position_max;
  if (!rsiOk && !swingOk) {
    return { ok: false, rsi: r, swingPos: sp, reason: r === null ? "majors_rsi_warmup" : "majors_entry_timing" };
  }
  return { ok: true, rsi: r, swingPos: sp };
}

export function majorsRangeForPool(
  price: number, binStep: number, decimalsX: number,
): RangePlan {
  return planMajorsSpotRange(price, binStep, decimalsX);
}
