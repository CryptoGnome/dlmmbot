import { describe, it, expect } from "vitest";
import { escapeRebalanceDeltas, liquiditySlippageBps, runEscapeRebalance } from "./rebalance.js";
import { installConfig, restoreConfig } from "../test/config.js";

describe("escapeRebalanceDeltas", () => {
  it("preserves width and anchors top at active bin", () => {
    const d = escapeRebalanceDeltas(100, 200, 500);
    expect(d.minDeltaId).toBe(-100);
    expect(d.maxDeltaId).toBe(0);
    expect(d.newMinBinId).toBe(400);
    expect(d.newMaxBinId).toBe(500);
  });
});

describe("liquiditySlippageBps", () => {
  it("maps config pct to bps", () => {
    installConfig();
    expect(liquiditySlippageBps()).toBe(500);
    restoreConfig();
  });
});

describe("runEscapeRebalance", () => {
  it("returns ok:false when use_zap is disabled", async () => {
    installConfig((c) => { c.exec.use_zap = false; });
    const res = await runEscapeRebalance({
      connection: {} as never,
      wallet: {} as never,
      poolAddress: "pool",
      minBinId: 100,
      maxBinId: 200,
      activeBinId: 180,
      lbPositions: [],
      swapSlippageBps: 50,
      send: async () => "sig",
    });
    expect(res.ok).toBe(false);
    expect(res.sigs).toEqual([]);
    restoreConfig();
  });
});
