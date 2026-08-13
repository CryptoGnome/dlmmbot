import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, REALIZED_PNL_SQL, logError } from "./db.js";
import { useMemoryDb, resetTestDb, insertClosedPosition } from "../test/db.js";

function pnlFor(id: number): number {
  return (getDb().prepare(
    `SELECT (${REALIZED_PNL_SQL}) AS pnl FROM positions WHERE id = ?`
  ).get(id) as { pnl: number }).pnl;
}

describe("REALIZED_PNL_SQL", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());

  it("prefers measured wallet delta when both cost columns exist", () => {
    const id = insertClosedPosition({
      entrySol: 0.3,
      exitSol: 0.4, // notional would say +0.1
      openCostSol: 0.31,
      closeReturnSol: 0.28,
      feesMeasuredSol: 0.02,
      recoveredSol: 0.01,
    });
    expect(pnlFor(id)).toBeCloseTo(0.28 + 0.02 + 0.01 - 0.31, 8);
  });

  it("falls back to legacy notional mark when measured columns missing", () => {
    const id = insertClosedPosition({
      entrySol: 0.3,
      exitSol: 0.35,
      feesClaimedSol: 0.02,
      openCostSol: null,
      closeReturnSol: null,
    });
    expect(pnlFor(id)).toBeCloseTo(0.35 - 0.3 + 0.02, 8);
  });

  it("returns 0 for adopted rows (entry_sol = 0)", () => {
    const id = insertClosedPosition({
      entrySol: 0,
      exitSol: 0.5,
      feesClaimedSol: 0.1,
      openCostSol: null,
      closeReturnSol: null,
    });
    expect(pnlFor(id)).toBe(0);
  });

  it("treats NULL close_return_sol as not measured (legacy path)", () => {
    const id = insertClosedPosition({
      entrySol: 0.3,
      exitSol: 0.25,
      feesClaimedSol: 0,
      openCostSol: 0.31,
      closeReturnSol: null,
    });
    expect(pnlFor(id)).toBeCloseTo(0.25 - 0.3, 8);
  });
});

describe("logError", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());

  it("writes a row and dedupes within the window", () => {
    const a = logError({ source: "test", code: "unit", message: "boom", dedupeSec: 60 });
    const b = logError({ source: "test", code: "unit", message: "boom", dedupeSec: 60 });
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(0);
    const n = (getDb().prepare("SELECT COUNT(*) AS n FROM error_log").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it("stores stack from Error objects", () => {
    const id = logError({
      source: "test",
      code: "stack",
      message: "with stack",
      err: new Error("with stack"),
      dedupeSec: 0,
    });
    const row = getDb().prepare("SELECT stack FROM error_log WHERE id = ?").get(id) as { stack: string | null };
    expect(row.stack).toBeTruthy();
    expect(row.stack!).toContain("Error: with stack");
  });
});
