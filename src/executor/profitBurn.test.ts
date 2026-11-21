import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { accrueProfitBurn, profitBurnSpendSol, readProfitBurnAccrued, shouldFlushProfitBurn, PROFIT_BURN } from "./profitBurn.js";
import { backfillProfitBurns, getDb, REALIZED_PNL_SQL } from "../db/db.js";
import { useMemoryDb, resetTestDb, insertClosedPosition } from "../test/db.js";

describe("profitBurnSpendSol", () => {
  it("takes 1% of measured net profit", () => {
    expect(profitBurnSpendSol(1.0, 0.01)).toBeCloseTo(0.01, 8);
  });
  it("skips losses and zero", () => {
    expect(profitBurnSpendSol(-0.5, 0.01)).toBeNull();
    expect(profitBurnSpendSol(0, 0.01)).toBeNull();
  });
  it("returns dust shares (accrued; burned once the pot reaches the flush floor)", () => {
    expect(profitBurnSpendSol(0.027415, 0.01)).toBeCloseTo(0.00027415, 8);
  });
});

// Written before the fix (2026-11-21 audit). Ways the 1% fee can be wrong:
//   B1  a dust pot is burned in a tx of its own — 177 of 484 burns were under
//       0.00005 SOL, each paying a network fee about the size of the burn
//   B2  deferring dust silently forgives the fee
//   B3  the fee leaves the wallet and no position's PnL shows it
//   B4  the debit is applied twice (once at accrual, again by the startup backfill)
const pnl = (id: number) => (getDb().prepare(
  `SELECT (${REALIZED_PNL_SQL}) AS p FROM positions WHERE id = ?`
).get(id) as { p: number }).p;

describe("profit burn accounting", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());

  it("B1: a pot under the flush floor is not worth a transaction", () => {
    expect(shouldFlushProfitBurn(0.00004)).toBe(false);
    expect(shouldFlushProfitBurn(0)).toBe(false);
    expect(shouldFlushProfitBurn(Number.NaN)).toBe(false);
  });

  it("B2: the pot keeps every deferred share and flushes once it crosses the floor", () => {
    const id = insertClosedPosition({ entrySol: 1, exitSol: 1.01, openCostSol: 1, closeReturnSol: 1.01, mode: "live" });
    const share = PROFIT_BURN.min_flush_sol * 0.4;
    accrueProfitBurn(share, `pos#${id} TST pnl=+0.04 share=x`);
    accrueProfitBurn(share, `pos#${id} TST pnl=+0.04 share=x`);
    expect(shouldFlushProfitBurn(readProfitBurnAccrued())).toBe(false);
    const pot = accrueProfitBurn(share, `pos#${id} TST pnl=+0.04 share=x`);
    expect(pot).toBeCloseTo(share * 3, 12);
    expect(shouldFlushProfitBurn(pot)).toBe(true);
  });

  it("B3/B4: an accrual is debited to its position exactly once", () => {
    const id = insertClosedPosition({ entrySol: 1, exitSol: 1.1, openCostSol: 1, closeReturnSol: 1.1, mode: "live" });
    accrueProfitBurn(0.001, `pos#${id} TST pnl=+0.100000 share=0.001000`);
    expect(pnl(id)).toBeCloseTo(0.099, 9);
    expect(backfillProfitBurns().debitedSol).toBe(0); // what the next startup would run
    expect(pnl(id)).toBeCloseTo(0.099, 9);
  });
});
