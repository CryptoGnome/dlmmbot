import { describe, expect, it } from "vitest";
import { profitBurnSpendSol } from "../executor/profitBurn.js";

describe("profitBurnSpendSol", () => {
  it("takes 1% of measured net profit", () => {
    expect(profitBurnSpendSol(1.0, 0.01)).toBeCloseTo(0.01, 8);
  });
  it("skips losses and zero", () => {
    expect(profitBurnSpendSol(-0.5, 0.01)).toBeNull();
    expect(profitBurnSpendSol(0, 0.01)).toBeNull();
  });
  it("returns dust shares (accrual decides when to burn)", () => {
    expect(profitBurnSpendSol(0.027415, 0.01)).toBeCloseTo(0.00027415, 8);
  });
});
