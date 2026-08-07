import { config } from "../config.js";
import type { GateFailure, PoolInfo } from "../types.js";
import type { RawPoolExtras } from "./meteora.js";

// STRATEGY.md §2.1 — pool hard gates. Returns every failure (not just the
// first) so the decisions log shows the full picture for tuning.

const DAY_MS = 86_400_000;

export function poolGates(p: PoolInfo & { extras: RawPoolExtras }): GateFailure[] {
  const g = config().gates;
  const fails: GateFailure[] = [];
  const fail = (gate: string, value: unknown, limit: unknown) =>
    fails.push({ gate, value: String(value), limit: String(limit) });

  if (p.tvlUsd < g.tvl_min_usd) fail("tvl_min", p.tvlUsd.toFixed(0), g.tvl_min_usd);
  if (p.tvlUsd > g.tvl_max_usd) fail("tvl_max", p.tvlUsd.toFixed(0), g.tvl_max_usd);

  // Hard floor; the 100-200k micro band additionally needs a higher score at
  // entry time (mcap_micro_score_min, checked in the entry pipeline where the
  // final blended score exists). Missing MC data fails conservatively.
  if (!(p.marketCapUsd >= g.mcap_min_usd))
    fail("mcap_min", (p.marketCapUsd ?? 0).toFixed(0), g.mcap_min_usd);

  // Pool younger than 24h: 24h window under-measures — use lifetime-scaled ratio.
  const ageMs = p.createdAt ? Date.now() - Date.parse(p.createdAt) : null;
  const feeTvl24h =
    ageMs !== null && ageMs < DAY_MS && ageMs > 0
      ? p.feeTvl24hPct * (DAY_MS / ageMs)
      : p.feeTvl24hPct;
  // Recently-awakened path: a sleepy 24h average is forgiven when the 30m AND
  // 1h rates both clear the bar — hot now, sustained for at least an hour.
  // (Not 4h: fee events run hours, and entering at hour four is the tail.
  // Flash-pump downside is bounded by the timing filter, stop, and P5 grace.)
  const feeTvl30mDaily = p.feeTvl30mPct * 48;
  const feeTvl1hDaily = p.feeTvl1hPct * 24;
  const feeTvl4hDaily = p.feeTvl4hPct * 6;
  const recentlyHot = feeTvl30mDaily >= g.fee_tvl_24h_min_pct && feeTvl1hDaily >= g.fee_tvl_24h_min_pct;
  if (feeTvl24h < g.fee_tvl_24h_min_pct && !recentlyHot)
    fail("fee_tvl_24h", `${feeTvl24h.toFixed(1)} (30m ${feeTvl30mDaily.toFixed(1)}/1h ${feeTvl1hDaily.toFixed(1)}/4h ${feeTvl4hDaily.toFixed(1)})`, g.fee_tvl_24h_min_pct);

  if (feeTvl30mDaily < g.fee_tvl_30m_daily_min_pct)
    fail("fee_tvl_30m_daily", feeTvl30mDaily.toFixed(1), g.fee_tvl_30m_daily_min_pct);

  if (p.vol30mUsd < g.vol_30m_min_usd) fail("vol_30m", p.vol30mUsd.toFixed(0), g.vol_30m_min_usd);

  const hourlyAvg = p.vol24hUsd / 24;
  const trend = hourlyAvg > 0 ? p.vol1hUsd / hourlyAvg : 1;
  if (trend < g.vol_trend_min) fail("vol_trend", trend.toFixed(2), g.vol_trend_min);

  if (p.baseFeePct < g.base_fee_min_pct) fail("base_fee_min", p.baseFeePct, g.base_fee_min_pct);
  if (p.baseFeePct > g.base_fee_max_pct) fail("base_fee_max", p.baseFeePct, g.base_fee_max_pct);

  const isNewToken = ageMs !== null && ageMs < 7 * DAY_MS;
  if (isNewToken && p.binStep < g.bin_step_min_new)
    fail("bin_step_new", p.binStep, g.bin_step_min_new);

  if (g.fee_collection === "both_only" && !p.feesBothTokens)
    fail("fee_collection", `collect_fee_mode=${p.extras.collectFeeMode}`, "0 (both tokens)");
  if (g.fee_collection === "quote_only" && p.feesBothTokens)
    fail("fee_collection", `collect_fee_mode=${p.extras.collectFeeMode}`, "1 (quote/SOL only)");

  if (!g.quote_mints.includes(p.mintY)) fail("quote_mint", p.mintY, g.quote_mints.join("|"));

  // Cheap freebie from the pool listing — full authority check happens in vetting.
  if (!p.extras.freezeAuthorityDisabled)
    fail("freeze_authority_listing", "enabled", "disabled");

  return fails;
}

/** §6: our position must not become a dominant share of the pool. */
export function poolShareGate(p: PoolInfo, positionSolUsd: number): GateFailure | null {
  const maxPct = config().gates.max_pool_share_pct;
  const sharePct = (positionSolUsd / Math.max(p.tvlUsd, 1)) * 100;
  return sharePct > maxPct
    ? { gate: "pool_share", value: sharePct.toFixed(1), limit: String(maxPct) }
    : null;
}
