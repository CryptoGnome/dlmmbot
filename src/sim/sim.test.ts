import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../config.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { applyOverlay, exitKeysOnly, parseValue } from "./overlay.js";
import { compare, fidelity, monotonicity, score } from "./report.js";
import { replay } from "./ladder.js";
import type { SimMark, Trace } from "./types.js";

/**
 * The simulator's job is to be believed, so these tests are mostly about the
 * ways a backtest lies: a rule carried by one row, a sweep that fits noise, a
 * typo'd key that "changes nothing", and a model that cannot re-derive history.
 */

function mark(over: Partial<SimMark> & { ts: number }): SimMark {
  return {
    binId: 150, price: 1, valueSol: 1, valueFrac: 1, cumFeesSol: 0,
    inRange: true, belowRange: false, aboveRange: false, depthFrac: 0.5, unclaimedSol: 0,
    tvlUsd: null, vol30mUsd: null, feeTvl30mPct: null, poolAgeS: null, claimedCumSol: null, ...over,
  };
}

function trace(over: Partial<Trace> = {}): Trace {
  const marks = over.marks ?? [mark({ ts: 1000 }), mark({ ts: 1015 })];
  return {
    id: 1, book: "test", symbol: "TST", mint: "m", pool: "p", sleeve: "meme",
    entryTs: 1000, exitTs: marks[marks.length - 1]!.ts, entryPrice: 1, entrySol: 1,
    minBinId: 100, maxBinId: 200, everInRange: true, actualPnl: 0,
    actualReason: "P1_stop", ageMin: 30, marks, flags: [], ...over,
  };
}

describe("sim", () => {
  beforeEach(() => {
    installConfig((c) => {
      c.manage.stop_loss_frac = 0.75;
      c.manage.stop_loss_sustain_polls = 4;
      c.manage.below_range_grace_min = 15;
      c.manage.above_range_sustain_min = 10;
      c.manage.above_range_missed_sustain_min = 45;
      c.manage.escape_hatch_depth_pct = 60;
      c.manage.escape_hatch_recovery_pct = 25;
      c.manage.safety_price_crash_pct = -60;
      c.manage.profit_lock_enabled = false;
      c.manage.max_age_h = 24;
    });
    return () => restoreConfig();
  });

  describe("ladder replay", () => {
    it("fires P1 immediately in range, but sustains below range", async () => {
      const inRange = trace({
        marks: [mark({ ts: 1000 }), mark({ ts: 1015, valueSol: 0.7, valueFrac: 0.7 })],
      });
      expect(replay(inRange, config()).reason).toBe("P1_stop");

      const below = (n: number) => trace({
        marks: [
          mark({ ts: 1000 }),
          ...Array.from({ length: n }, (_, i) => mark({
            ts: 1015 + i * 15, binId: 90, valueSol: 0.7, valueFrac: 0.7,
            inRange: false, belowRange: true, depthFrac: -0.1,
          })),
        ],
      });
      // 4 consecutive polls needed: 3 is not enough, and P5 grace (15m) is far off.
      expect(replay(below(3), config()).reason).toBe("held");
      expect(replay(below(4), config()).reason).toBe("P1_stop");
    });

    it("escape hatch must arm on the way down before it can fire", async () => {
      const deep = mark({ ts: 1015, binId: 120, depthFrac: 0.2 });    // 80% down the range
      const top = mark({ ts: 1030, binId: 190, depthFrac: 0.9 });     // back in the top 10%
      expect(replay(trace({ marks: [mark({ ts: 1000 }), deep, top] }), config()).reason).toBe("escape");
      // Same recovery mark without the fall first: nothing armed, so nothing fires.
      expect(replay(trace({ marks: [mark({ ts: 1000 }), top] }), config()).reason).toBe("held");
    });

    it("P5 cuts only after the full below-range grace", async () => {
      const belowFor = (min: number) => trace({
        marks: [
          mark({ ts: 1000, binId: 90, inRange: false, belowRange: true }),
          mark({ ts: 1000 + min * 60, binId: 90, inRange: false, belowRange: true }),
        ],
      });
      expect(replay(belowFor(10), config()).reason).toBe("held");
      expect(replay(belowFor(20), config()).reason).toBe("P5_below");
    });

    /**
     * `value_sol` is mark-to-market and already contains unclaimed fees, so
     * proceeds must add only what has been CLAIMED. Adding the running fee
     * total instead inflates every exit point that happens to sit on
     * uncollected fees — the bug the 2026-08-20 ad-hoc scripts shipped with.
     */
    it("counts claimed fees once, never the unclaimed ones sitting inside valueSol", () => {
      const earned = mark({ ts: 1015, valueSol: 1, cumFeesSol: 0.10, unclaimedSol: 0.04 });
      const t = trace({ marks: [mark({ ts: 1000 }), earned] });
      // 1.0 marked value + 0.06 claimed (0.10 earned − 0.04 still in the position).
      expect(replay(t, config()).proceedsSol).toBeCloseTo(1.06, 6);
    });

    it("the fee-inclusive stop counts claimed fees only", () => {
      // MTM 0.70 is under the 0.75 stop; 0.10 earned but only 0.02 claimed,
      // so fee-inclusive is 0.72 — still under. Claim the rest and it clears.
      const under = mark({ ts: 1015, valueSol: 0.70, cumFeesSol: 0.10, unclaimedSol: 0.08 });
      const claimed = mark({ ts: 1015, valueSol: 0.70, cumFeesSol: 0.10, unclaimedSol: 0 });
      const cfg = { ...config(), manage: { ...config().manage, stop_loss_count_claimed_fees: true } };
      expect(replay(trace({ marks: [mark({ ts: 1000 }), under] }), cfg).reason).toBe("P1_stop");
      expect(replay(trace({ marks: [mark({ ts: 1000 }), claimed] }), cfg).reason).toBe("held");
    });

    it("majors use their own sleeve params, not the meme ones", async () => {
      installConfig((c) => {
        c.manage.stop_loss_frac = 0.75;
        c.majors.stop_loss_frac = 0.5;
      });
      const marks = [mark({ ts: 1000 }), mark({ ts: 1015, valueSol: 0.6, valueFrac: 0.6 })];
      expect(replay(trace({ marks }), config()).reason).toBe("P1_stop");
      expect(replay(trace({ marks, sleeve: "majors" }), config()).reason).toBe("held");
    });
  });

  describe("scoring guards", () => {
    const outcomesFrom = (deltas: number[], book = "a") =>
      deltas.map((d, i) => ({
        trace: trace({ id: i, book }), base: { firedIdx: null, reason: "held" as const, proceedsSol: 0, bankedSol: 0 },
        variant: { firedIdx: 0, reason: "P1_stop" as const, proceedsSol: d, bankedSol: 0 },
        delta: d, simPnl: d,
      }));

    it("calls a rule carried by its best row NOISE, however big the total", () => {
      // The Niles #63 shape: +0.81 from one position, small negatives elsewhere.
      const v = score(outcomesFrom([0.81, -0.02, -0.03, -0.01, -0.02, -0.01, -0.02, -0.03]));
      expect(v.delta).toBeGreaterThan(0.6);
      expect(v.call).toBe("noise");
      expect(v.why.join(" ")).toContain("sign flips");
      expect(v.concentration).toBeGreaterThan(0.8);
    });

    it("calls a broad, book-agnostic improvement an improvement", () => {
      const v = score([...outcomesFrom([0.05, 0.04, 0.06, 0.05, 0.03], "a"),
                       ...outcomesFrom([0.04, 0.05, 0.03, 0.06], "b")]);
      expect(v.call).toBe("improves");
      expect(v.perBook).toHaveLength(2);
    });

    it("refuses to call a rule that only fires a handful of times", () => {
      expect(score(outcomesFrom([0.05, 0.04, 0.06])).call).toBe("noise");
    });

    it("flags a rule whose books disagree", () => {
      const v = score([...outcomesFrom([0.09, 0.08, 0.07, 0.06, 0.05], "a"),
                       ...outcomesFrom([-0.04, -0.05, -0.03, -0.04], "b")]);
      expect(v.call).toBe("noise");
      expect(v.why.join(" ")).toContain("books disagree");
    });

    it("reports a rule that never fires as a no-op, not a win", () => {
      expect(score(outcomesFrom([])).call).toBe("no-op");
    });
  });

  it("monotonicity flags a sweep whose sign keeps flipping", () => {
    expect(monotonicity([0.1, 0.2, 0.3]).noisy).toBe(false);
    expect(monotonicity([0.02, -0.33, 0.94, -0.11]).noisy).toBe(true);
  });

  describe("config overlays", () => {
    it("throws on a key that does not exist instead of silently doing nothing", () => {
      expect(() => applyOverlay(config(), { "manage.stop_loss_frak": 0.6 })).toThrow(/does not exist/);
      expect(() => applyOverlay(config(), { "nope.key": 1 })).toThrow(/no config section/);
    });

    it("applies a real key without mutating the base config", () => {
      const base = config();
      const next = applyOverlay(base, { "manage.stop_loss_frac": 0.65 });
      expect(next.manage.stop_loss_frac).toBe(0.65);
      expect(base.manage.stop_loss_frac).toBe(0.75);
    });

    it("keeps only exit keys from a profile, and says what it dropped", () => {
      const { kept, ignored } = exitKeysOnly({
        "manage.stop_loss_frac": 0.65, "majors.max_age_h": 100,
        "sizing.max_positions": 7, "gates.tvl_min_usd": 5000,
      });
      expect(Object.keys(kept)).toEqual(["manage.stop_loss_frac", "majors.max_age_h"]);
      expect(ignored).toEqual(["sizing.max_positions", "gates.tvl_min_usd"]);
    });

    it("parses values by type", () => {
      expect(parseValue("0.65")).toBe(0.65);
      expect(parseValue("true")).toBe(true);
      expect(parseValue("bank")).toBe("bank");
    });
  });

  it("compare measures both replays on the same basis, so a no-change overlay is zero", () => {
    const t = trace({
      marks: [mark({ ts: 1000 }), mark({ ts: 1015, valueSol: 0.7, valueFrac: 0.7, cumFeesSol: 0.05 })],
    });
    const same = compare([t], config(), applyOverlay(config(), { "manage.claim_min_sol": 0.02 }));
    expect(same[0]!.delta).toBe(0);
    const looser = compare([t], config(), applyOverlay(config(), { "manage.stop_loss_frac": 0.5 }));
    expect(looser[0]!.base.reason).toBe("P1_stop");
    expect(looser[0]!.variant.reason).toBe("held");
  });

  it("fidelity scores only exits the ladder can reproduce", () => {
    const stopped = trace({
      actualReason: "P1_stop",
      marks: [mark({ ts: 1000 }), mark({ ts: 1015, valueSol: 0.7, valueFrac: 0.7 })],
    });
    const drained = trace({ id: 2, actualReason: "P0_safety" });
    const f = fidelity([stopped, drained], config());
    expect(f.scored).toBe(1);
    expect(f.agreed).toBe(1);
    expect(f.excluded).toBe(1);
  });
});
