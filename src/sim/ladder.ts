import type { Config } from "../config.js";
import type { Replay, SimMark, SimReason, Trace } from "./types.js";

/**
 * The mark-replayable half of the P0–P5 ladder in `manager/loop.ts`, run over
 * recorded `position_marks` instead of live executor marks.
 *
 * REPLAYABLE (everything a 15s mark carries: price, value, bins, fees):
 *   P0 price_crash · P1 stop (+ below-range sustain, + fee-inclusive variant)
 *   P2 max_age     · P3 above-range sustain · P5 below-range grace
 *   escape hatch   · profit lock (approximated, see below)
 *
 * NOT REPLAYABLE — marks carry no TVL, pool fee rate, volume, holder or
 * RugCheck data, so these can never be simulated from this table:
 *   P0 tvl_drain / pool_dead / rugcheck_flip / holder-watch · P2 fee-volume
 *   decay · follow chains · entry gates and sizing (no data for trades we
 *   never took).
 * Positions whose real exit came from one of those are marked
 * `unreplayable_exit` at load and excluded from fidelity scoring.
 *
 * Sleeve overrides mirror `risk/majorsManage.ts`.
 */

interface Params {
  stopLossFrac: number;
  stopSustainPolls: number;
  countClaimedFees: boolean;
  maxAgeH: number;
  aboveSustainMin: number;
  aboveMissedSustainMin: number;
  belowGraceMin: number;
  escapeDepthPct: number;
  escapeRecoveryPct: number;
  priceCrashPct: number;
  profitLockEnabled: boolean;
  profitLockAtFrac: number;
  profitLockWithdrawPct: number;
  profitLockMaxFires: number;
}

export function paramsFor(cfg: Config, sleeve: Trace["sleeve"]): Params {
  const m = cfg.manage;
  const mj = cfg.majors;
  const majors = sleeve === "majors";
  return {
    stopLossFrac: majors ? mj.stop_loss_frac : m.stop_loss_frac,
    stopSustainPolls: m.stop_loss_sustain_polls ?? 4,
    countClaimedFees: m.stop_loss_count_claimed_fees === true,
    maxAgeH: majors ? mj.max_age_h : m.max_age_h,
    aboveSustainMin: majors ? mj.above_range_sustain_min : m.above_range_sustain_min,
    aboveMissedSustainMin: majors ? mj.above_range_missed_sustain_min : m.above_range_missed_sustain_min,
    belowGraceMin: majors ? mj.below_range_grace_min : m.below_range_grace_min,
    escapeDepthPct: majors && !mj.escape_hatch_enabled ? 999
      : majors ? mj.escape_hatch_depth_pct : m.escape_hatch_depth_pct,
    escapeRecoveryPct: majors ? mj.escape_hatch_recovery_pct : m.escape_hatch_recovery_pct,
    priceCrashPct: m.safety_price_crash_pct,
    profitLockEnabled: majors ? mj.profit_lock_enabled : m.profit_lock_enabled,
    profitLockAtFrac: m.profit_lock_at_frac,
    profitLockWithdrawPct: m.profit_lock_withdraw_pct,
    profitLockMaxFires: m.profit_lock_max_fires,
  };
}

/**
 * Fees already CLAIMED by this mark — real SOL in the wallet. `valueSol` is
 * mark-to-market and already contains whatever is still UNCLAIMED, so claimed
 * is the running total minus what is currently sitting in the position.
 * Adding the running total to `valueSol` (the obvious-looking move, and what
 * the ad-hoc scripts of 2026-08-20 did) counts unclaimed fees twice.
 */
function claimedBy(m: SimMark): number {
  return Math.max(0, m.cumFeesSol - m.unclaimedSol);
}

/**
 * Proceeds if we exited at this mark: the position marked to market, plus fees
 * already banked, plus anything profit-lock withdrew. Deltas between two
 * replays share this basis, so slippage, rent and residual sweeps — which the
 * marks never saw — cancel to first order instead of being guessed at.
 */
function proceeds(m: SimMark, scale: number, banked: number): number {
  return m.valueSol * scale + claimedBy(m) + banked;
}

export function replay(trace: Trace, cfg: Config): Replay {
  const p = paramsFor(cfg, trace.sleeve);
  const marks = trace.marks;
  // Profit-lock withdrawals shrink the position: model as a scale factor on
  // subsequent value plus SOL moved to `banked`. An approximation — the real
  // withdraw rebalances bins — so treat profit-lock sweeps as directional.
  let scale = 1, banked = 0, lockFires = 0;
  let stopStreak = 0;
  let aboveSince: number | null = null;
  let belowSince: number | null = null;
  let armed = false;
  const width = trace.maxBinId - trace.minBinId;
  const fire = (i: number, reason: SimReason): Replay =>
    ({ firedIdx: i, reason, proceedsSol: proceeds(marks[i]!, scale, banked), bankedSol: banked });

  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]!;
    const ageH = (m.ts - trace.entryTs) / 3600;
    // Adopted rows can reach here with no cost basis (entry_sol backfilled from
    // the first mark); fall back to the frac the manager recorded at the time.
    const valueFrac = trace.entrySol > 0 ? (m.valueSol * scale) / trace.entrySol : m.valueFrac * scale;

    // P0 (replayable subset): price crash vs entry.
    if (m.price > 0 && trace.entryPrice > 0 &&
        ((m.price - trace.entryPrice) / trace.entryPrice) * 100 <= p.priceCrashPct) {
      return fire(i, "price_crash");
    }

    // P1 stop. Below range it must sustain across consecutive polls (wick
    // tolerance); in range it fires immediately — same asymmetry as the loop.
    const feeInclFrac = trace.entrySol > 0 ? valueFrac + claimedBy(m) / trace.entrySol : valueFrac;
    const stopFrac = p.countClaimedFees ? feeInclFrac : valueFrac;
    if (stopFrac < p.stopLossFrac) {
      stopStreak++;
      const needed = m.belowRange ? p.stopSustainPolls : 1;
      if (stopStreak >= needed) return fire(i, "P1_stop");
    } else {
      stopStreak = 0;
    }

    // P2: age only. Fee/volume decay needs pool data the marks do not carry.
    if (ageH > p.maxAgeH) return fire(i, "P2_age");

    if (m.aboveRange) {
      const sustainMin = trace.everInRange ? p.aboveSustainMin : p.aboveMissedSustainMin;
      if (aboveSince == null) aboveSince = m.ts;
      else if (m.ts - aboveSince >= sustainMin * 60) return fire(i, "P3_above");
      continue;
    }
    aboveSince = null;

    if (m.belowRange) {
      if (belowSince == null) belowSince = m.ts;
      else if (m.ts - belowSince >= p.belowGraceMin * 60) return fire(i, "P5_below");
      continue;
    }
    belowSince = null;

    // Escape hatch: arm once price falls through `depth_pct` of the range,
    // fire when it recovers to the top `recovery_pct`.
    if (width > 0 && m.binId != null) {
      const frac = (trace.maxBinId - m.binId) / width;
      if (frac >= p.escapeDepthPct / 100) armed = true;
      else if (armed && frac <= p.escapeRecoveryPct / 100) return fire(i, "escape");
    }

    if (p.profitLockEnabled && lockFires < p.profitLockMaxFires && valueFrac >= p.profitLockAtFrac) {
      lockFires++;
      const take = m.valueSol * scale * p.profitLockWithdrawPct;
      banked += take;
      scale *= 1 - p.profitLockWithdrawPct;
    }
  }
  const last = marks[marks.length - 1]!;
  return { firedIdx: null, reason: "held", proceedsSol: proceeds(last, scale, banked), bankedSol: banked };
}

/** Map a real `exit_reason` onto the simulator's vocabulary, or null if unreplayable. */
export function normalizeActual(reason: string): SimReason | null {
  if (reason.startsWith("P1_stop")) return "P1_stop";
  if (reason.startsWith("P3_above")) return "P3_above";
  if (reason.startsWith("P5_below")) return "P5_below";
  if (reason.startsWith("escape")) return "escape";
  return null;
}
