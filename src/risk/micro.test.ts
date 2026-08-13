import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyMicroSize, isMicroMcap, microPoolSharePct, microSleeveExposure } from "./micro.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb } from "../test/db.js";
import { getDb, now, recordDecision } from "../db/db.js";

describe("isMicroMcap", () => {
  beforeEach(() => installConfig((c) => {
    c.gates.mcap_min_usd = 100_000;
    c.gates.mcap_micro_max_usd = 200_000;
  }));
  afterEach(() => restoreConfig());

  it("true only inside 100–200k band", () => {
    expect(isMicroMcap(99_999)).toBe(false);
    expect(isMicroMcap(100_000)).toBe(true);
    expect(isMicroMcap(150_000)).toBe(true);
    expect(isMicroMcap(199_999)).toBe(true);
    expect(isMicroMcap(200_000)).toBe(false);
    expect(isMicroMcap(null)).toBe(false);
  });
});

describe("applyMicroSize", () => {
  beforeEach(() => installConfig((c) => {
    c.gates.micro_size_mult = 0.5;
    c.gates.micro_max_position_sol = 0.45;
  }));
  afterEach(() => restoreConfig());

  it("halves size and caps at micro_max_position_sol", () => {
    expect(applyMicroSize(0.8)).toBe(0.4);
    expect(applyMicroSize(1.2)).toBe(0.45);
  });
});

describe("microSleeveExposure", () => {
  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.gates.mcap_micro_max_usd = 200_000;
    });
  });
  afterEach(() => {
    resetTestDb();
    restoreConfig();
  });

  it("counts only open positions whose entry mcap was below micro max", () => {
    const ts = now();
    getDb().prepare(
      `INSERT INTO positions (mode, pool, token_mint, symbol, entry_ts, entry_price, entry_sol,
        min_bin_id, max_bin_id, state, fees_claimed_sol, rent_paid_sol)
       VALUES ('live', 'poolA', 'mintA', 'A', ?, 1, 0.35, 1, 10, 'open', 0, 0)`
    ).run(ts);
    getDb().prepare(
      `INSERT INTO positions (mode, pool, token_mint, symbol, entry_ts, entry_price, entry_sol,
        min_bin_id, max_bin_id, state, fees_claimed_sol, rent_paid_sol)
       VALUES ('live', 'poolB', 'mintB', 'B', ?, 1, 0.55, 1, 10, 'open', 0, 0)`
    ).run(ts);
    recordDecision("mintA", "poolA", "entered", null, 80, { pool: { marketCapUsd: 150_000 }, sleeve: "micro" });
    recordDecision("mintB", "poolB", "entered", null, 85, { pool: { marketCapUsd: 350_000 }, sleeve: "meme" });

    const exp = microSleeveExposure();
    expect(exp.slots).toBe(1);
    expect(exp.deployedSol).toBeCloseTo(0.35);
  });
});

describe("microPoolSharePct", () => {
  beforeEach(() => installConfig((c) => { c.gates.micro_max_pool_share_pct = 10; }));
  afterEach(() => restoreConfig());

  it("reads micro pool share from config", () => {
    expect(microPoolSharePct()).toBe(10);
  });
});
