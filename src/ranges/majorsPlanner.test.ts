import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { majorsEntryTiming, planMajorsSpotRange, rsi, swingPosition } from "./majorsPlanner.js";
import { installConfig, restoreConfig } from "../test/config.js";
import type { Candle } from "../scanner/meteora.js";

function candles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({ timestamp: i, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1 }));
}

describe("planMajorsSpotRange", () => {
  beforeEach(() => installConfig((c) => {
    c.majors.range_below_pct = 12;
    c.majors.range_above_pct = 6;
  }));
  afterEach(() => restoreConfig());

  it("builds spot plan centered on price", () => {
    const plan = planMajorsSpotRange(1, 100, 6);
    expect(plan.shape).toBe("spot");
    expect(plan.binCount).toBeGreaterThan(5);
    expect(plan.topPricePct).toBeGreaterThan(0);
    expect(plan.bottomPricePct).toBeLessThan(0);
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
