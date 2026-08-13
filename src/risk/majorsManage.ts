import { config } from "../config.js";
import type { Sleeve } from "./sleeve.js";

/** Manage params for a sleeve — majors uses week-scale parking rules, not meme churn. */
export function manageForSleeve(sleeve: Sleeve) {
  const m = config().manage;
  if (sleeve !== "majors") return m;
  const mj = config().majors;
  return {
    ...m,
    stop_loss_frac: mj.stop_loss_frac,
    max_age_h: mj.max_age_h,
    above_range_sustain_min: mj.above_range_sustain_min,
    above_range_missed_sustain_min: mj.above_range_missed_sustain_min,
    rotation_fee_daily_min_pct: mj.rotation_fee_daily_min_pct,
    rotation_vol_30m_min_usd: mj.rotation_vol_30m_min_usd,
    below_range_grace_min: mj.below_range_grace_min,
    claim_min_sol: mj.claim_min_sol,
    profit_lock_enabled: mj.profit_lock_enabled,
    escape_hatch_depth_pct: mj.escape_hatch_enabled ? mj.escape_hatch_depth_pct : 999,
    escape_hatch_recovery_pct: mj.escape_hatch_recovery_pct,
  };
}
