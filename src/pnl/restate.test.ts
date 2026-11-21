import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { restateDerivedPnl } from "./rollup.js";
import { getDb, now, recordExternalFlow } from "../db/db.js";
import { useMemoryDb, resetTestDb, insertClosedPosition } from "../test/db.js";

// Written before the fix (2026-11-21 audit). Stored totals that are DERIVED from
// positions go stale whenever a position's PnL changes after the fact (a sweep,
// a rent reclaim, an expired strand credit, a formula fix). Ways they were wrong:
//   D1  pnl_daily rows for 08-07/08-08 kept an old formula's numbers forever, so
//       the all-time equity chart ended at -0.467 against a book of -0.357
//   D2  restating invents rows for days the bot never tracked (breaks the paper streak)
//   D3  follow_chains.chain_pnl_sol was accumulated at leg close and never revisited
//       (chain #6 stored 0.0336 against legs worth 0.0580)
//   D4  a leg that closed after its chain ended was never counted
//   E1  an external deposit reads as profit: baseline never moved
//   E2  a deposit before any baseline exists creates a wrong one

const DAY = "2026-08-08";
const DAY_TS = Math.floor(Date.parse(`${DAY}T12:00:00Z`) / 1000);

function closedOn(ts: number, pnl: number, mode = "paper"): number {
  return insertClosedPosition({ entrySol: 1, exitSol: 1 + pnl, openCostSol: 1, closeReturnSol: 1 + pnl, exitTs: ts, mode });
}
function dailyRow(day: string, mode = "paper") {
  return getDb().prepare("SELECT realized_sol r, fees_sol f, unrealized_sol u FROM pnl_daily WHERE day = ? AND mode = ?").get(day, mode) as
    { r: number; f: number; u: number } | undefined;
}

describe("restateDerivedPnl — pnl_daily", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());

  it("D1: a past day's stale realized_sol is rewritten from positions; other columns are kept", () => {
    const id = closedOn(DAY_TS, 0.1);
    getDb().prepare("INSERT INTO pnl_daily (day, mode, realized_sol, unrealized_sol, fees_sol, costs_sol) VALUES (?, 'paper', -0.5, 0.07, 0, 0.01)").run(DAY);
    getDb().prepare("UPDATE positions SET recovered_sol = 0.02, fees_measured_sol = 0.03 WHERE id = ?").run(id); // credited later
    expect(restateDerivedPnl("paper").days).toBe(1);
    const row = dailyRow(DAY)!;
    expect(row.r).toBeCloseTo(0.1 + 0.02 + 0.03, 9);
    expect(row.f).toBeCloseTo(0.03, 9);
    expect(row.u).toBeCloseTo(0.07, 9);
    expect(restateDerivedPnl("paper").days).toBe(0); // nothing left to change
  });

  it("D2: never creates a row for an untracked day, and never touches another mode's rows", () => {
    closedOn(DAY_TS, 0.1);
    getDb().prepare("INSERT INTO pnl_daily (day, mode, realized_sol, unrealized_sol, fees_sol, costs_sol) VALUES (?, 'live', 9, 0, 0, 0)").run(DAY);
    restateDerivedPnl("paper");
    expect(dailyRow(DAY, "paper")).toBeUndefined();
    expect(dailyRow(DAY, "live")!.r).toBe(9);
  });

  it("a tracked day whose closes all vanished from the window reads zero, not its old number", () => {
    getDb().prepare("INSERT INTO pnl_daily (day, mode, realized_sol, unrealized_sol, fees_sol, costs_sol) VALUES (?, 'paper', 0.4, 0, 0.1, 0)").run(DAY);
    restateDerivedPnl("paper");
    expect(dailyRow(DAY)!.r).toBe(0);
  });
});

describe("restateDerivedPnl — follow chains", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());

  function chain(state: string, stored: number): number {
    return Number(getDb().prepare(
      `INSERT INTO follow_chains (mode, pool, token_mint, symbol, origin_position_id, started_ts, state, legs, chain_pnl_sol, chain_high, high_mark, updated_ts)
       VALUES ('paper', 'pool', 'mint', 'TST', 1, ?, ?, 2, ?, 1, 1, ?)`
    ).run(now(), state, stored, now()).lastInsertRowid);
  }
  const stored = (id: number) => (getDb().prepare("SELECT chain_pnl_sol p FROM follow_chains WHERE id = ?").get(id) as { p: number }).p;

  it("D3/D4: a chain's PnL is the sum of its legs, including one that closed after it ended", () => {
    const c = chain("done", 0.0336);
    const leg1 = closedOn(now() - 500, 0.0336);
    const leg2 = closedOn(now() - 100, 0.0244); // closed after the chain was already done
    getDb().prepare("UPDATE positions SET follow_chain_id = ? WHERE id IN (?, ?)").run(c, leg1, leg2);
    expect(restateDerivedPnl("paper").chains).toBe(1);
    expect(stored(c)).toBeCloseTo(0.058, 9);
  });

  it("an open leg contributes nothing, and a chain with no legs reads zero", () => {
    const c = chain("leg_open", 0.5);
    const open = closedOn(now(), 0.3);
    getDb().prepare("UPDATE positions SET follow_chain_id = ?, exit_ts = NULL, state = 'open' WHERE id = ?").run(c, open);
    restateDerivedPnl("paper");
    expect(stored(c)).toBe(0);
  });
});

describe("recordExternalFlow — deposits and withdrawals are not PnL", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());
  const baseline = () => (getDb().prepare("SELECT value FROM meta WHERE key = 'baseline_sol_live'").get() as { value: string } | undefined)?.value;

  it("E1: a deposit raises the baseline by exactly the deposit and is written to the ledger", () => {
    getDb().prepare("INSERT INTO meta (key, value) VALUES ('baseline_sol_live', '24.406410236')").run();
    expect(recordExternalFlow("live", 10.310559894, "sweep from the retired wallet")).toBeCloseTo(34.71697013, 9);
    expect(Number(baseline())).toBeCloseTo(34.71697013, 9);
    const row = getDb().prepare("SELECT kind, sol, note FROM ledger").get() as { kind: string; sol: number; note: string };
    expect(row).toEqual({ kind: "deposit", sol: 10.310559894, note: "sweep from the retired wallet" });
  });

  it("a withdrawal lowers it and is its own ledger kind", () => {
    getDb().prepare("INSERT INTO meta (key, value) VALUES ('baseline_sol_live', '10')").run();
    expect(recordExternalFlow("live", -2.5, "to cold storage")).toBeCloseTo(7.5, 9);
    expect((getDb().prepare("SELECT kind, sol FROM ledger").get() as { kind: string; sol: number })).toEqual({ kind: "withdrawal", sol: 2.5 });
  });

  it("E2: with no baseline yet there is nothing to adjust — the first close will capture the funded wallet", () => {
    expect(recordExternalFlow("live", 5, "early top-up")).toBeNull();
    expect(baseline()).toBeUndefined();
    expect(getDb().prepare("SELECT COUNT(*) c FROM ledger").get()).toEqual({ c: 1 }); // still on record
  });

  it("rejects zero, NaN, and a withdrawal larger than the baseline", () => {
    getDb().prepare("INSERT INTO meta (key, value) VALUES ('baseline_sol_live', '10')").run();
    expect(() => recordExternalFlow("live", 0, "x")).toThrow();
    expect(() => recordExternalFlow("live", Number.NaN, "x")).toThrow();
    expect(() => recordExternalFlow("live", -11, "x")).toThrow();
    expect(Number(baseline())).toBe(10);
  });
});
