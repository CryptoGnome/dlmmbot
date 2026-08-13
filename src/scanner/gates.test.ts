import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { poolGates, poolShareGate } from "./gates.js";
import { feeMomentumPart, turnoverPart, structurePart, opportunityScore, timingPart } from "./score.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { makePool } from "../test/pool.js";

describe("poolGates", () => {
  beforeEach(() => installConfig());
  afterEach(() => restoreConfig());

  it("passes a healthy SOL-quoted meme pool", () => {
    expect(poolGates(makePool())).toEqual([]);
  });

  it("fails TVL / mcap / vol floors", () => {
    const fails = poolGates(makePool({ tvlUsd: 100, marketCapUsd: 1000, vol30mUsd: 100 }));
    const gates = fails.map((f) => f.gate);
    expect(gates).toContain("tvl_min");
    expect(gates).toContain("mcap_min");
    expect(gates).toContain("vol_30m");
  });

  it("poolShareGate rejects oversized positions", () => {
    const p = makePool({ tvlUsd: 10_000 });
    expect(poolShareGate(p, 3_000)?.gate).toBe("pool_share");
    expect(poolShareGate(p, 500)).toBeNull();
  });
});

describe("opportunityScore parts", () => {
  beforeEach(() => installConfig());
  afterEach(() => restoreConfig());

  it("composes a deterministic score from fixture parts", () => {
    const p = makePool();
    const { score } = opportunityScore({
      feeMomentum: feeMomentumPart(p),
      turnover: turnoverPart(p),
      vettingSoft: 0.8,
      timing: 0.9,
      structure: structurePart(p),
    });
    expect(score).toBeGreaterThan(50);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("timingPart penalizes freefall", () => {
    const candles = [
      { timestamp: 1, open: 1, high: 1, low: 0.9, close: 0.95, volume: 10 },
      { timestamp: 2, open: 0.95, high: 0.95, low: 0.8, close: 0.85, volume: 10 },
      { timestamp: 3, open: 0.85, high: 0.85, low: 0.7, close: 0.75, volume: 10 },
      { timestamp: 4, open: 0.75, high: 0.75, low: 0.6, close: 0.65, volume: 10 },
    ];
    expect(timingPart(candles, 0.65)).toBeLessThan(0.5);
  });
});
