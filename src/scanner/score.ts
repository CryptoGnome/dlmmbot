import { config } from "../config.js";
import type { PoolInfo } from "../types.js";
import type { Candle } from "./meteora.js";

// STRATEGY.md §2.4 — opportunity score 0-100.
// Each part is normalized to 0-1 then weighted. Deliberately simple and
// transparent: every part lands in decisions.features_json for later tuning.

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Fee momentum: is the 30m fee rate holding up vs the 24h baseline? */
export function feeMomentumPart(p: PoolInfo): number {
  const daily30m = p.feeTvl30mPct * 48;
  if (p.feeTvl24hPct <= 0) return 0.5;
  return clamp01(daily30m / (p.feeTvl24hPct * 2)); // 2x the daily baseline = max score
}

/** Turnover: daily volume / TVL, saturating at 20x. */
export function turnoverPart(p: PoolInfo): number {
  return clamp01(p.vol24hUsd / Math.max(p.tvlUsd, 1) / 20);
}

/** Timing (§2.3): freefall and top-blasting penalties from 5m candles. */
export function timingPart(candles: Candle[], currentPrice: number): number {
  if (candles.length < 4) return 0.5; // not enough history — neutral
  const t = config().timing;
  let score = 1;

  const last3 = candles.slice(-3);
  const first = last3[0];
  const ret15m = first && first.open > 0 ? ((currentPrice - first.open) / first.open) * 100 : 0;
  if (ret15m <= t.freefall_15m_max_pct) score -= 0.6;
  else if (ret15m < 0) score -= 0.2 * clamp01(ret15m / t.freefall_15m_max_pct);

  const ath = Math.max(...candles.map((c) => c.high));
  if (ath > 0 && ((ath - currentPrice) / ath) * 100 <= t.ath_proximity_pct) score -= 0.4;

  // Net-selling proxy: red-candle volume share over the last hour.
  const lastHour = candles.slice(-12);
  const vol = lastHour.reduce((s, c) => s + c.volume, 0);
  const redVol = lastHour.reduce((s, c) => s + (c.close < c.open ? c.volume : 0), 0);
  if (vol > 0 && redVol / vol > 0.65) score -= 0.3;

  return clamp01(score);
}

/** Pool structure: bin step fit, fee tier, and fee-collection preference. */
export function structurePart(p: PoolInfo): number {
  let s = 0.4;
  if (p.binStep >= 100 && p.binStep <= 400) s += 0.25;
  if (p.baseFeePct >= 1 && p.baseFeePct <= 3) s += 0.25; // the video's meme sweet spot
  // prefer_quote: fees auto-converted to SOL — no swap needed at claim time.
  if (config().gates.fee_collection === "prefer_quote" && !p.feesBothTokens) s += 0.2;
  return clamp01(s);
}

export function opportunityScore(parts: {
  feeMomentum: number;
  turnover: number;
  vettingSoft: number; // 0-1, from vetting engine (0.5 pre-vet)
  timing: number;
  structure: number;
}): { score: number; weighted: Record<string, number> } {
  const w = config().score;
  const weighted = {
    fee_momentum: parts.feeMomentum * w.w_fee_momentum,
    turnover: parts.turnover * w.w_turnover,
    vetting_soft: parts.vettingSoft * w.w_vetting_soft,
    timing: parts.timing * w.w_timing,
    structure: parts.structure * w.w_pool_structure,
  };
  const score = Object.values(weighted).reduce((a, b) => a + b, 0);
  return { score: Math.round(score * 10) / 10, weighted };
}
