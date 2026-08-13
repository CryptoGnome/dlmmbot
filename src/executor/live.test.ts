import { describe, it, expect } from "vitest";
import {
  txErrorDetail,
  rangeGapTooLarge,
  trackedButMissingOnChain,
  shouldRebuildOpenOnSlippage,
  OPEN_SLIPPAGE_REBUILDS,
} from "./live.js";

describe("txErrorDetail", () => {
  it("extracts ExceededBinSlippageTolerance from 0x1774", () => {
    const d = txErrorDetail({
      message: "Simulation failed.\nCustom program error: 0x1774",
      logs: ["Program log: AnchorError caused by account: bin_array. Error Code: ExceededBinSlippageTolerance. Error Number: 6004."],
    });
    expect(d.code).toBe("ExceededBinSlippageTolerance");
    expect(d.summary).toContain("ExceededBinSlippageTolerance");
    expect(d.summary).not.toMatch(/^ExceededBinSlippageTolerance — Simulation failed\.?$/);
  });

  it("does not let truncated Simulation failed. win as the tip alone without code", () => {
    const d = txErrorDetail({
      message: "Simulation failed.\nCustom program error: 0x1774",
      logs: [],
    });
    expect(d.code).toBe("ExceededBinSlippageTolerance");
    expect(d.summary.toLowerCase()).not.toBe("simulation failed.");
  });

  it("reads named Error Code from logs", () => {
    const d = txErrorDetail({
      message: "Transaction failed",
      logs: ["Error Code: InsufficientFunds"],
    });
    expect(d.code).toBe("InsufficientFunds");
  });
});

describe("live open/mark guards", () => {
  it("refuses range gap > 150 bins", () => {
    expect(rangeGapTooLarge(1000, 1200)).toBe(true);
    expect(rangeGapTooLarge(1000, 1100)).toBe(false);
  });

  it("throws path for tracked-but-empty chain (never fabricate −open_cost)", () => {
    expect(trackedButMissingOnChain(2, 0)).toBe(true);
    expect(trackedButMissingOnChain(2, 1)).toBe(false);
    expect(trackedButMissingOnChain(0, 0)).toBe(false);
  });

  it("rebuilds on slippage for early attempts only", () => {
    expect(shouldRebuildOpenOnSlippage("ExceededBinSlippageTolerance", 0)).toBe(true);
    expect(shouldRebuildOpenOnSlippage("ExceededBinSlippageTolerance", OPEN_SLIPPAGE_REBUILDS)).toBe(false);
    expect(shouldRebuildOpenOnSlippage("InsufficientFunds", 0)).toBe(false);
  });
});
