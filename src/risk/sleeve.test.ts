import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { majorsSlotBudget, openSleeveExposure, sleeveAtEntry } from "./sleeve.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb } from "../test/db.js";
import { getDb, now, recordDecision } from "../db/db.js";

describe("sleeveAtEntry", () => {
  beforeEach(() => {
    useMemoryDb();
    installConfig();
  });
  afterEach(() => { resetTestDb(); restoreConfig(); });

  it("reads sleeve tag from entry decision", () => {
    const ts = now();
    getDb().prepare(
      `INSERT INTO positions (mode, pool, token_mint, symbol, entry_ts, entry_price, entry_sol,
        min_bin_id, max_bin_id, state, fees_claimed_sol, rent_paid_sol)
       VALUES ('live', 'poolM', 'mintM', 'M', ?, 1, 0.8, 1, 10, 'open', 0, 0)`
    ).run(ts);
    recordDecision("mintM", "poolM", "entered", null, 50, { sleeve: "majors" });
    expect(sleeveAtEntry({ tokenMint: "mintM", poolAddress: "poolM", entryTs: ts })).toBe("majors");
  });

  it("maps legacy core tag to meme", () => {
    const ts = now();
    getDb().prepare(
      `INSERT INTO positions (mode, pool, token_mint, symbol, entry_ts, entry_price, entry_sol,
        min_bin_id, max_bin_id, state, fees_claimed_sol, rent_paid_sol)
       VALUES ('live', 'poolX', 'mintX', 'X', ?, 1, 0.5, 1, 10, 'open', 0, 0)`
    ).run(ts);
    recordDecision("mintX", "poolX", "entered", null, 70, { sleeve: "core" });
    expect(sleeveAtEntry({ tokenMint: "mintX", poolAddress: "poolX", entryTs: ts })).toBe("meme");
  });
});

describe("majorsSlotBudget", () => {
  beforeEach(() => installConfig((c) => {
    c.majors.enabled = true;
    c.majors.max_slots = 1;
    c.majors.meme_reserve_slots = 2;
    c.sizing.max_positions = 3;
  }));
  afterEach(() => restoreConfig());

  it("allows majors only when enough meme headroom", () => {
    expect(majorsSlotBudget(0)).toBe(1);
    expect(majorsSlotBudget(1)).toBe(1);
    expect(majorsSlotBudget(2)).toBe(0);
  });
});

describe("openSleeveExposure", () => {
  beforeEach(() => {
    useMemoryDb();
    installConfig();
  });
  afterEach(() => { resetTestDb(); restoreConfig(); });

  it("counts by sleeve tag", () => {
    const ts = now();
    for (const [mint, pool, sol, sleeve] of [
      ["m1", "p1", 0.4, "micro"],
      ["m2", "p2", 0.75, "majors"],
      ["m3", "p3", 0.5, "meme"],
    ] as const) {
      getDb().prepare(
        `INSERT INTO positions (mode, pool, token_mint, symbol, entry_ts, entry_price, entry_sol,
          min_bin_id, max_bin_id, state, fees_claimed_sol, rent_paid_sol)
         VALUES ('live', ?, ?, 'T', ?, 1, ?, 1, 10, 'open', 0, 0)`
      ).run(pool, mint, ts, sol);
      recordDecision(mint, pool, "entered", null, 80, { sleeve });
    }
    expect(openSleeveExposure("majors")).toEqual({ slots: 1, deployedSol: 0.75 });
    expect(openSleeveExposure("meme")).toEqual({ slots: 1, deployedSol: 0.5 });
  });
});
