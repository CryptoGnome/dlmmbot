import { describe, expect, it } from "vitest";
import { profitBurnSpendSol } from "../executor/profitBurn.js";

describe("profitBurnSpendSol", () => {
  it("takes 1% of measured net profit", () => {
    expect(profitBurnSpendSol(1.0, 0.01, 0.0001)).toBeCloseTo(0.01, 8);
  });
  it("skips losses and zero", () => {
    expect(profitBurnSpendSol(-0.5, 0.01, 0.0001)).toBeNull();
    expect(profitBurnSpendSol(0, 0.01, 0.0001)).toBeNull();
  });
  it("skips dust under min_sol", () => {
    expect(profitBurnSpendSol(0.05, 0.01, 0.001)).toBeNull(); // 0.0005 < 0.001
    expect(profitBurnSpendSol(0.12, 0.01, 0.001)).toBeCloseTo(0.0012, 8);
  });
});
