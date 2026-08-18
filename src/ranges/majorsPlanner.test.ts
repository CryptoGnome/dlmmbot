import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { majorsEntryTiming, planMajorsRange, rsi, swingPosition } from "./majorsPlanner.js";
import { priceToBinId } from "./planner.js";
import { installConfig, restoreConfig } from "../test/config.js";
import type { Candle } from "../scanner/meteora.js";

function candles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({ timestamp: i, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1 }));
}

describe("planMajorsRange", () => {
  beforeEach(() => installConfig((c) => {
    c.majors.range_below_pct = 12;
    c.majors.range_above_pct = 6;
    c.majors.strategy_shape = "spot";
  }));
  afterEach(() => restoreConfig());

  it("tops out at the active bin — never plans bins above price", () => {
    // A SOL-only deposit cannot fund a bin above the active one. Every live
    // majors position inspected on 2026-08-18 had all its above-price bins
    // empty; the range must not include them.
    const plan = planMajorsRange(1, 100, 6);
    expect(plan.maxBinId).toBe(priceToBinId(1, 100, 6));
    expect(plan.topPricePct).toBe(0);
    expect(plan.bottomPricePct).toBeLessThan(0);
    expect(plan.binCount).toBeGreaterThan(5);
  });

  it("ignores range_above_pct entirely", () => {
    const a = planMajorsRange(1, 100, 6);
    installConfig((c) => { c.majors.range_below_pct = 12; c.majors.range_above_pct = 30; c.majors.strategy_shape = "spot"; });
    const b = planMajorsRange(1, 100, 6);
    expect(b.minBinId).toBe(a.minBinId);
    expect(b.maxBinId).toBe(a.maxBinId);
  });

  it("takes its shape from majors.strategy_shape", () => {
    expect(planMajorsRange(1, 100, 6).shape).toBe("spot");
    installConfig((c) => { c.majors.range_below_pct = 12; c.majors.strategy_shape = "bidask"; });
    expect(planMajorsRange(1, 100, 6).shape).toBe("bidask");
  });
});

describe("majorsEntryTiming", () => {
  beforeEach(() => installConfig((c) => {
    c.majors.entry_rsi_max = 45;
    c.majors.entry_swing_position_max = 0.4;
    c.majors.entry_swing_avoid_top = 0.75;
    c.majors.entry_rsi_period = 14;
  }));
  afterEach(() => restoreConfig());

  it("rejects price near swing top", () => {
    const cs = candles(Array.from({ length: 30 }, (_, i) => 1 + i * 0.01));
    const t = majorsEntryTiming(cs, 1.29);
    expect(t.ok).toBe(false);
    expect(t.reason).toBe("majors_swing_high");
  });

  it("allows oversold RSI", () => {
    const falling = candles(Array.from({ length: 20 }, (_, i) => 2 - i * 0.05));
    const r = rsi(falling, 14);
    expect(r).not.toBeNull();
    const t = majorsEntryTiming(falling, falling.at(-1)!.close);
    expect(t.ok).toBe(true);
  });
});

describe("rsi", () => {
  it("returns low RSI on steady decline", () => {
    const cs = candles(Array.from({ length: 20 }, (_, i) => 100 - i * 2));
    expect(rsi(cs, 14)!).toBeLessThan(30);
  });
});

describe("swingPosition", () => {
  it("returns 0 at swing low", () => {
    const cs = candles([1, 1.2, 0.8, 1.1, 0.75]);
    expect(swingPosition(0.75, cs)).toBeCloseTo(0, 1);
  });
});
