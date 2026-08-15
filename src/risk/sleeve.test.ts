import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { majorsSlotBudget, openSleeveExposure, sleeveAtEntry } from "./sleeve.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb } from "../test/db.js";
import { getDb, now, recordDecision } from "../db/db.js";
import { currentMode } from "../config.js";

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

  const insertOpen = (mode: string, mint: string, pool: string, sol: number, sleeve: string) => {
    getDb().prepare(
      `INSERT INTO positions (mode, pool, token_mint, symbol, entry_ts, entry_price, entry_sol,
        min_bin_id, max_bin_id, state, fees_claimed_sol, rent_paid_sol)
       VALUES (?, ?, ?, 'T', ?, 1, ?, 1, 10, 'open', 0, 0)`
    ).run(mode, pool, mint, now(), sol);
    recordDecision(mint, pool, "entered", null, 80, { sleeve });
  };

  it("counts by sleeve tag", () => {
    const mode = currentMode();
    insertOpen(mode, "m1", "p1", 0.4, "micro");
    insertOpen(mode, "m2", "p2", 0.75, "majors");
    insertOpen(mode, "m3", "p3", 0.5, "meme");
    expect(openSleeveExposure("majors")).toEqual({ slots: 1, deployedSol: 0.75 });
    expect(openSleeveExposure("meme")).toEqual({ slots: 1, deployedSol: 0.5 });
  });

  /**
   * The Railway bot: a paper-mode majors row left `open` from before the flip
   * to live sat in the volume DB and counted as the majors sleeve's single
   * allowed slot — "[majors] already parked (1/1 slots, 0.75 SOL)" on a book
   * every live counter reported as empty. Majors never entered anything.
   * This was the one open-position reader without a mode filter.
   */
  it("ignores open rows from the other mode", () => {
    const mine = currentMode();
    const other = mine === "live" ? "paper" : "live";
    insertOpen(other, "m2", "p2", 0.75, "majors"); // the phantom
    expect(openSleeveExposure("majors")).toEqual({ slots: 0, deployedSol: 0 });
    expect(majorsSlotBudget(0)).toBeGreaterThan(0); // and majors may still enter
    insertOpen(mine, "m9", "p9", 0.75, "majors");
    expect(openSleeveExposure("majors")).toEqual({ slots: 1, deployedSol: 0.75 });
  });
});
