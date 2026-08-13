import { config, SOL_MINT } from "../config.js";
import type { GateFailure, PoolInfo } from "../types.js";
import type { RawPoolExtras } from "./meteora.js";

const DAY_MS = 86_400_000;

/** Relaxed pool gates for whitelist majors (STRATEGY §10 v0). SOL-quoted only. */
export function majorsPoolGates(p: PoolInfo & { extras: RawPoolExtras }): GateFailure[] {
  const mj = config().majors;
  const fails: GateFailure[] = [];
  const fail = (gate: string, value: unknown, limit: unknown) =>
    fails.push({ gate, value: String(value), limit: String(limit) });

  if (p.mintY !== SOL_MINT) fail("majors_quote", p.mintY, SOL_MINT);
  if (p.tvlUsd < mj.tvl_min_usd) fail("majors_tvl_min", p.tvlUsd.toFixed(0), mj.tvl_min_usd);
  if (p.tvlUsd > mj.tvl_max_usd) fail("majors_tvl_max", p.tvlUsd.toFixed(0), mj.tvl_max_usd);

  const ageMs = p.createdAt ? Date.now() - Date.parse(p.createdAt) : null;
  const feeTvl24h =
    ageMs !== null && ageMs < DAY_MS && ageMs > 0
      ? p.feeTvl24hPct * (DAY_MS / ageMs)
      : p.feeTvl24hPct;
  const feeTvl30mDaily = p.feeTvl30mPct * 48;
  if (feeTvl24h < mj.fee_tvl_24h_min_pct)
    fail("majors_fee_tvl_24h", feeTvl24h.toFixed(2), mj.fee_tvl_24h_min_pct);
  if (feeTvl30mDaily < mj.fee_tvl_30m_daily_min_pct)
    fail("majors_fee_tvl_30m", feeTvl30mDaily.toFixed(2), mj.fee_tvl_30m_daily_min_pct);
  if (p.vol30mUsd < mj.vol_30m_min_usd) fail("majors_vol_30m", p.vol30mUsd.toFixed(0), mj.vol_30m_min_usd);

  if (p.baseFeePct > config().gates.base_fee_max_pct)
    fail("base_fee_max", p.baseFeePct, config().gates.base_fee_max_pct);

  return fails;
}

export function majorsSymbol(p: PoolInfo): string {
  return (p.name.split("-")[0] ?? p.name).toUpperCase();
}

/** Discovery admission: symbol allowlist and/or high mcap, plus minimum pool age. */
export function majorsDiscoveryEligible(p: PoolInfo & { extras: RawPoolExtras }): boolean {
  const mj = config().majors;
  const sym = majorsSymbol(p);
  const allow = mj.symbol_allowlist.map((s) => s.toUpperCase());
  const bySymbol = allow.length > 0 && allow.includes(sym);
  const byMcap = mj.mcap_min_usd > 0 && p.marketCapUsd >= mj.mcap_min_usd;
  if (!bySymbol && !byMcap) return false;
  if (mj.age_min_days <= 0) return true;
  const ageMs = p.createdAt ? Date.now() - Date.parse(p.createdAt) : null;
  return ageMs !== null && ageMs >= mj.age_min_days * DAY_MS;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Majors parking score on the shared 0–100 decisions scale.
 * Fee-led (not meme opportunityScore): 55% 24h fee/TVL + 45% 30m annualized.
 * Saturates at 0.5%/d per leg — typical hot parking pool lands ~60–90.
 * Old formula (`fee24*10 + fee30m*48`) ranked correctly but printed ~1–6 next to meme 70–90.
 */
export function majorsScore(p: PoolInfo): number {
  const daily30m = p.feeTvl30mPct * 48;
  const score = clamp01(p.feeTvl24hPct / 0.5) * 55 + clamp01(daily30m / 0.5) * 45;
  return Math.round(score * 10) / 10;
}
