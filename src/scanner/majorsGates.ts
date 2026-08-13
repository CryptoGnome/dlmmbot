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
