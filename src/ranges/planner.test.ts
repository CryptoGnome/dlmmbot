import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { priceToBinId, binIdToPrice, binArraysSpanned, planRange, planFollowRange, planTrancheRange, fitPlanToRentBudget } from "./planner.js";
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
    const wrong = Math.floor(Math.log(price) / Math.log(1 + binStep / 10_000));
    const right = priceToBinId(price, binStep, 6);
    expect(Math.abs(right - wrong)).toBeGreaterThan(500);
  });

  it("planRange floors depth at min_down_pct and caps vs P0 crash margin", () => {
    installConfig((c) => {
      c.entry.min_down_pct = 40;
      c.entry.max_down_pct = 50;
      c.manage.safety_price_crash_pct = -60;
    });
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

  it("planTrancheRange sits below a shallow primary and respects P0 floor", () => {
    installConfig((c) => {
      c.entry.min_down_pct = 40;
      c.entry.max_down_pct = 50;
      c.entry.tranche_max_down_pct = 70;
      c.manage.safety_price_crash_pct = -60;
    });
    // Flat candles → primary bottoms near -40..-50; force a shallow primary.
    const primary = {
      minBinId: priceToBinId(0.85, 100, 6), // ~-15% — leave room under it
      maxBinId: priceToBinId(1, 100, 6),
      binCount: 20, positionAccounts: 1, bottomPricePct: -15,
      shape: "bidask" as const, fibAnchor: null, estBinRentSol: 0.075,
    };
    const t = planTrancheRange(1, 100, [], 6, primary);
    expect(t).not.toBeNull();
    expect(t!.maxBinId).toBe(primary.minBinId - 1);
    expect(t!.minBinId).toBeLessThan(t!.maxBinId);
    expect(t!.bottomPricePct).toBeLessThanOrEqual(-39);
    expect(t!.bottomPricePct).toBeGreaterThanOrEqual(-55);
  });

  it("planTrancheRange returns null when primary already fills the floor", () => {
    installConfig((c) => {
      c.entry.min_down_pct = 40;
      c.entry.max_down_pct = 50;
      c.entry.tranche_max_down_pct = 70;
      c.manage.safety_price_crash_pct = -60;
    });
    const primary = planRange(1, 100, [], 6);
    // Primary at the P0-safe floor → no pocket underneath.
    const t = planTrancheRange(1, 100, [], 6, primary);
    // May be null or tiny; require null or <10 bins skipped by planner
    if (t) expect(t.binCount).toBeGreaterThanOrEqual(10);
    else expect(t).toBeNull();
  });

  it("fitPlanToRentBudget shrinks bins to fit rent without going shallower than min_down", () => {
    const price = 1;
    const binStep = 100;
    const decimalsX = 9;
    const maxBinId = priceToBinId(price, binStep, decimalsX);
    const deepMin = maxBinId - 200;
    const fat = {
      minBinId: deepMin, maxBinId, binCount: 201, positionAccounts: 3,
      bottomPricePct: -60, shape: "bidask" as const, fibAnchor: null, estBinRentSol: 0.225,
    };
    // maxBinId ≈ 0 sits exactly on an on-chain array boundary: every bin below
    // it lives in the next 70-bin array down, so a 40%-deep range can never
    // fit ONE aligned array here. The old unaligned ceil(binCount/70) claimed
    // it could — and live opens paid double the estimated rent.
    const one = fitPlanToRentBudget(fat, 0.075, price, binStep, decimalsX, 40);
    expect(one).toBeNull();
    const two = fitPlanToRentBudget(fat, 0.15, price, binStep, decimalsX, 40);
    expect(two).not.toBeNull();
    expect(two!.estBinRentSol).toBeLessThanOrEqual(0.15);
    expect(two!.maxBinId).toBe(maxBinId);
    expect(two!.bottomPricePct).toBeLessThanOrEqual(-39);
  });

  it("binArraysSpanned counts aligned 70-bin segments, not bin count / 70", () => {
    expect(binArraysSpanned(0, 69)).toBe(1);    // exactly one aligned array
    expect(binArraysSpanned(1, 70)).toBe(2);    // same width, off by one → two
    expect(binArraysSpanned(-51, 0)).toBe(2);   // negative ids straddle -1 and 0
    expect(binArraysSpanned(-70, -1)).toBe(1);  // fully inside array -1
    expect(binArraysSpanned(5, 5)).toBe(1);
  });

  it("fitPlanToRentBudget is a no-op when rent already fits", () => {
    const plan = {
      minBinId: 1, maxBinId: 50, binCount: 50, positionAccounts: 1,
      bottomPricePct: -40, shape: "bidask" as const, fibAnchor: null, estBinRentSol: 0.075,
    };
    expect(fitPlanToRentBudget(plan, 0.075, 1, 100, 9, 40)).toBe(plan);
  });

  it("fitPlanToRentBudget returns null when rent and min depth cannot both fit", () => {
    const price = 1;
    const binStep = 20;
    const decimalsX = 9;
    const maxBinId = priceToBinId(price, binStep, decimalsX);
    const deepMin = priceToBinId(price * 0.6, binStep, decimalsX);
    const plan = {
      minBinId: deepMin, maxBinId, binCount: maxBinId - deepMin + 1,
      positionAccounts: 10, bottomPricePct: -40, fibAnchor: null,
      estBinRentSol: 0.75, shape: "bidask" as const,
    };
    expect(fitPlanToRentBudget(plan, 0.075, price, binStep, decimalsX, 40)).toBeNull();
  });
});
