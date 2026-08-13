import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installConfig, restoreConfig } from "../test/config.js";
import type { RangePlan } from "../types.js";
import { applyBinRentGate, tierBinRentBudget } from "./binRent.js";
import { priceToBinId } from "./planner.js";

function fatRange(): RangePlan {
  const price = 1;
  const binStep = 20;
  const decimalsX = 9;
  const maxBinId = priceToBinId(price, binStep, decimalsX);
  const deepMin = priceToBinId(price * 0.6, binStep, decimalsX);
  return {
    minBinId: deepMin,
    maxBinId,
    binCount: maxBinId - deepMin + 1,
    positionAccounts: 10,
    bottomPricePct: -40,
    fibAnchor: null,
    estBinRentSol: 0.75,
    shape: "bidask",
  };
}

describe("bin rent tiers", () => {
  beforeEach(() => {
    installConfig((c) => {
      c.entry.bin_rent_budget_sol = 0.075;
      c.entry.bin_rent_hard_sol = 0.15;
      c.entry.bin_rent_hard_score_min = 80;
      c.entry.min_down_pct = 40;
    });
  });
  afterEach(() => restoreConfig());

  it("tierBinRentBudget uses soft under score min and hard at/above", () => {
    expect(tierBinRentBudget(79)).toEqual({ budgetSol: 0.075, tier: "soft" });
    expect(tierBinRentBudget(80)).toEqual({ budgetSol: 0.15, tier: "hard" });
  });

  it("allows when estimate already within soft budget without quoting", async () => {
    const quote = vi.fn();
    const r = await applyBinRentGate({
      range: {
        minBinId: 1, maxBinId: 50, binCount: 50, positionAccounts: 1,
        bottomPricePct: -40, shape: "bidask", fibAnchor: null, estBinRentSol: 0.075,
      },
      score: 70,
      poolAddress: "Pool111111111111111111111111111111111111111",
      price: 1, binStep: 100, decimalsX: 9, minDownPct: 40,
      quote,
    });
    expect(r.ok).toBe(true);
    expect(quote).not.toHaveBeenCalled();
  });

  it("quotes and allows when actual rent is 0 after soft shrink fails", async () => {
    const quote = vi.fn().mockResolvedValue({ actualSol: 0, arrays: 0, source: "quote" });
    const r = await applyBinRentGate({
      range: fatRange(),
      score: 75,
      poolAddress: "Pool111111111111111111111111111111111111111",
      price: 1, binStep: 20, decimalsX: 9, minDownPct: 40,
      quote,
    });
    expect(quote).toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.meta.actual).toBe(0);
  });

  it("allows 0.15 actual only on hard tier (score ≥ 80)", async () => {
    const quote = vi.fn().mockResolvedValue({ actualSol: 0.15, arrays: 2, source: "quote" });
    const base = {
      range: fatRange(),
      poolAddress: "Pool111111111111111111111111111111111111111",
      price: 1, binStep: 20, decimalsX: 9, minDownPct: 40,
      quote,
    };
    expect((await applyBinRentGate({ ...base, score: 70 })).ok).toBe(false);
    expect((await applyBinRentGate({ ...base, score: 85 })).ok).toBe(true);
  });

  it("fails closed when quote returns estimate over hard budget", async () => {
    const quote = vi.fn().mockResolvedValue({ actualSol: 0.75, arrays: 10, source: "error" });
    const r = await applyBinRentGate({
      range: fatRange(),
      score: 90,
      poolAddress: "Pool111111111111111111111111111111111111111",
      price: 1, binStep: 20, decimalsX: 9, minDownPct: 40,
      quote,
    });
    expect(r.ok).toBe(false);
    expect(r.meta.source).toBe("error");
  });
});
