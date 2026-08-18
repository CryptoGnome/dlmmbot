import { config } from "../config.js";
import type { Candle } from "../scanner/meteora.js";
import type { RangePlan } from "../types.js";
import { binArraysSpanned, binIdToPrice, priceToBinId, swing } from "./planner.js";

const BINS_PER_POSITION = 69;
const BIN_ARRAY_RENT_SOL = 0.075;

function buildMajorsPlan(
  minBinId: number, maxBinId: number, centerPrice: number, binStep: number, decimalsX: number,
  shape: RangePlan["shape"],
): RangePlan {
  const binCount = maxBinId - minBinId + 1;
  return {
    minBinId, maxBinId, binCount,
    positionAccounts: Math.ceil(binCount / BINS_PER_POSITION),
    bottomPricePct: (binIdToPrice(minBinId, binStep, decimalsX) / centerPrice - 1) * 100,
    topPricePct: 0,
    shape,
    fibAnchor: null,
    estBinRentSol: binArraysSpanned(minBinId, maxBinId) * BIN_ARRAY_RENT_SOL,
  };
}

/**
 * Majors range: one-sided below price, top at the active bin (STRATEGY §10).
 *
 * Until 2026-08-18 this planned `range_above_pct` of bins ABOVE the active
 * bin. A SOL-only deposit cannot fund those — DLMM puts the quote token only
 * in bins at or below active — and on-chain inspection of all 21 live majors
 * positions found every above-active bin empty. They cost a second position
 * account on 13 of 21 opens (rent tied up) and an extra bin-array on 6
 * (rent gone), for zero liquidity. `range_above_pct` is now ignored.
 *
 * Shape comes from `majors.strategy_shape` — the executor honours whatever
 * the plan says, so this is the one place a majors position's shape is chosen.
 */
export function planMajorsRange(
  currentPrice: number, binStep: number, decimalsX: number,
): RangePlan {
  const mj = config().majors;
  const activeBin = priceToBinId(currentPrice, binStep, decimalsX);
  const belowBin = Math.max(1, Math.round(mj.range_below_pct / (binStep / 100)));
  const maxBinId = activeBin;
  let minBinId = activeBin - belowBin;
  const maxBins = BINS_PER_POSITION * config().entry.max_position_accounts;
  if (maxBinId - minBinId + 1 > maxBins) minBinId = maxBinId - maxBins + 1;
  return buildMajorsPlan(minBinId, maxBinId, currentPrice, binStep, decimalsX, mj.strategy_shape ?? "spot");
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
  return planMajorsRange(price, binStep, decimalsX);
}
