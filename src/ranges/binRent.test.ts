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
      c.entry.bin_rent_max_pos_pct = 25;
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

  // Rent is non-refundable, so it is capped as a share of the position too —
  // otherwise a bankroll-scaled 0.05 SOL entry could spend 0.075 SOL to open.
  it("caps rent as a share of the position when sizeSol is given", () => {
    expect(tierBinRentBudget(70, 0.3)).toEqual({ budgetSol: 0.075, tier: "soft" });   // unchanged
    expect(tierBinRentBudget(70, 0.1)).toEqual({ budgetSol: 0.025, tier: "soft" });
    expect(tierBinRentBudget(85, 0.2)).toEqual({ budgetSol: 0.05, tier: "hard" });    // below hard budget
    expect(tierBinRentBudget(70)).toEqual({ budgetSol: 0.075, tier: "soft" });        // no size = no cap
  });

  it("rejects rent a small position cannot carry, and allows it when free", async () => {
    const base = {
      range: fatRange(),
      score: 75,
      poolAddress: "Pool111111111111111111111111111111111111111",
      price: 1, binStep: 20, decimalsX: 9, minDownPct: 40,
    };
    const paid = vi.fn().mockResolvedValue({ actualSol: 0.075, arrays: 1, source: "quote" });
    expect((await applyBinRentGate({ ...base, sizeSol: 0.05, quote: paid })).ok).toBe(false);
    expect((await applyBinRentGate({ ...base, sizeSol: 0.4, quote: paid })).ok).toBe(true);
    // Initialised arrays cost nothing — small positions can still enter there.
    const free = vi.fn().mockResolvedValue({ actualSol: 0, arrays: 0, source: "quote" });
    expect((await applyBinRentGate({ ...base, sizeSol: 0.05, quote: free })).ok).toBe(true);
  });

  it("bin_rent_max_pos_pct = 0 disables the share cap", async () => {
    installConfig((c) => { c.entry.bin_rent_max_pos_pct = 0; });
    expect(tierBinRentBudget(70, 0.05)).toEqual({ budgetSol: 0.075, tier: "soft" });
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
