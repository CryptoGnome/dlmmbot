import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { priceToBinId, binIdToPrice, planRange, planFollowRange } from "./planner.js";
import { installConfig, restoreConfig } from "../test/config.js";

describe("planner bin math", () => {
  beforeEach(() => installConfig());
  afterEach(() => restoreConfig());

  it("round-trips UI price ↔ bin for 6-decimal token (HTZ class)", () => {
    const binStep = 100;
    const decimalsX = 6;
    const ui = 1.2345e-4;
    const bin = priceToBinId(ui, binStep, decimalsX);
    const back = binIdToPrice(bin, binStep, decimalsX);
    // Floor on encode means back ≤ ui; next bin is above.
    expect(back).toBeLessThanOrEqual(ui * 1.0001);
    expect(binIdToPrice(bin + 1, binStep, decimalsX)).toBeGreaterThan(ui * 0.999);
  });

  it("round-trips for 9-decimal token", () => {
    const binStep = 80;
    const decimalsX = 9;
    const ui = 0.05;
    const bin = priceToBinId(ui, binStep, decimalsX);
    expect(Math.abs(binIdToPrice(bin, binStep, decimalsX) / ui - 1)).toBeLessThan(0.01);
  });

  it("does not place 6-decimal bins ~1000x below market (HTZ incident)", () => {
    const price = 2.5e-5;
    const binStep = 100;
    // Wrong (UI as raw) vs correct (6-decimal).
    const wrong = Math.floor(Math.log(price) / Math.log(1 + binStep / 10_000));
    const right = priceToBinId(price, binStep, 6);
    expect(Math.abs(right - wrong)).toBeGreaterThan(500);
  });

  it("planRange floors depth at min_down_pct and caps vs P0 crash margin", () => {
    installConfig((c) => {
      c.entry.min_down_pct = 40;
      c.entry.max_down_pct = 50;
      c.manage.safety_price_crash_pct = -60; // safetyCap = 50
    });
    // Flat candles → no fib shallower path; depth = maxDown capped by safety.
    const candles = Array.from({ length: 10 }, (_, i) => ({
      timestamp: i, open: 1, high: 1.01, low: 0.99, close: 1, volume: 1,
    }));
    const plan = planRange(1, 100, candles, 6);
    expect(plan.bottomPricePct).toBeLessThanOrEqual(-39);
    expect(plan.bottomPricePct).toBeGreaterThanOrEqual(-55);
    expect(plan.binCount).toBeGreaterThan(10);
  });

  it("planFollowRange respects depth and account split", () => {
    installConfig((c) => {
      c.entry.max_position_accounts = 2;
      c.follow.range_depth_pct = 30;
    });
    const plan = planFollowRange(1, 100, 30, 6);
    expect(plan.fibAnchor).toBeNull();
    expect(plan.bottomPricePct).toBeLessThan(-20);
    expect(plan.positionAccounts).toBeGreaterThanOrEqual(1);
  });
});
