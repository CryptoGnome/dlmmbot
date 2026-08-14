import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, REALIZED_PNL_SQL, logError, upsertTokenMeta } from "./db.js";
import { useMemoryDb, resetTestDb, insertClosedPosition } from "../test/db.js";

function pnlFor(id: number): number | null {
  return (getDb().prepare(
    `SELECT (${REALIZED_PNL_SQL}) AS pnl FROM positions WHERE id = ?`
  ).get(id) as { pnl: number | null }).pnl;
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

  it("returns NULL for adopted rows with no basis (entry_sol = 0)", () => {
    const id = insertClosedPosition({
      entrySol: 0,
      exitSol: 0.5,
      feesClaimedSol: 0.1,
      openCostSol: null,
      closeReturnSol: null,
    });
    expect(pnlFor(id)).toBeNull();
  });

  it("returns NULL for a no-basis adopted row even when close_return exists", () => {
    // The old expression subtracted COALESCE(open_cost, 0+0) here — full close
    // proceeds reported as pure profit, masking real same-day losses from the
    // circuit breaker.
    const id = insertClosedPosition({
      entrySol: 0,
      exitSol: null,
      openCostSol: null,
      closeReturnSol: 0.5,
      feesMeasuredSol: 0.01,
    });
    expect(pnlFor(id)).toBeNull();
  });

  it("returns NULL for unknown-exit rows (force-close / reconcile orphan)", () => {
    // exit_sol AND close_return_sol both NULL: outcome unknown. The old
    // expression fabricated a full −entry_sol loss — a crash mid-close could
    // trip the circuit breaker on a position that lost nothing.
    const id = insertClosedPosition({
      entrySol: 0.5,
      exitSol: null,
      exitReason: "manual",
      openCostSol: null,
      closeReturnSol: null,
    });
    expect(pnlFor(id)).toBeNull();
    const sum = (getDb().prepare(
      `SELECT COALESCE(SUM(${REALIZED_PNL_SQL}), 0) AS s FROM positions`
    ).get() as { s: number }).s;
    expect(sum).toBe(0); // SUM skips the NULL
  });

  it("counts profit-lock withdrawals in the measured branch", () => {
    // 1.0 in, locked 0.4 to the wallet mid-position, closed at 0.7:
    // true PnL is +0.1, not −0.3.
    const id = insertClosedPosition({
      entrySol: 0.6, // shrunk by the lock; must NOT be the basis
      exitSol: 0.7,
      openCostSol: 1.0,
      closeReturnSol: 0.7,
      withdrawnSol: 0.4,
    });
    expect(pnlFor(id)).toBeCloseTo(0.1, 8);
  });

  it("uses close_return when open_cost is missing (partial wallet columns)", () => {
    const id = insertClosedPosition({
      entrySol: 0.75,
      exitSol: 0.76,
      openCostSol: null,
      closeReturnSol: 0.752,
      feesMeasuredSol: 0,
    });
    expect(pnlFor(id)).toBeCloseTo(0.002, 8);
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

  it("upserts display metadata without wiping existing fields", () => {
    upsertTokenMeta("mintA", { symbol: "AAA", icon_url: "https://x/a.png" });
    upsertTokenMeta("mintA", { name: "Token A" });
    const row = getDb().prepare(
      "SELECT symbol, name, icon_url FROM tokens WHERE mint = ?",
    ).get("mintA") as { symbol: string; name: string; icon_url: string };
    expect(row.symbol).toBe("AAA");
    expect(row.name).toBe("Token A");
    expect(row.icon_url).toBe("https://x/a.png");
  });
});
