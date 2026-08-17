import { describe, it, expect } from "vitest";
import {
  txErrorDetail,
  rangeGapTooLarge,
  trackedButMissingOnChain,
  shouldRebuildOpenOnSlippage,
  wealthDeltaLamports,
  OPEN_SLIPPAGE_REBUILDS,
} from "./live.js";
import { classifyLeftover, RESIDUAL_SWEEP_MIN_SOL } from "./executor.js";
import { PublicKey } from "@solana/web3.js";
import { SOL_MINT } from "../config.js";

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

describe("wealthDeltaLamports", () => {
  const wallet = new PublicKey("9DTThTbggnp2P2ZGLFRfN1A3j5JUsXez1dRJak3TixB2");
  const other = new PublicKey("11111111111111111111111111111111");

  it("counts native + wSOL as one wealth figure", () => {
    const keys = [{ pubkey: other }, { pubkey: wallet }];
    const meta = {
      preBalances: [0, 1_000_000_000],
      postBalances: [0, 999_992_970], // -0.00000703 native
      preTokenBalances: [
        { accountIndex: 2, mint: SOL_MINT, owner: wallet.toBase58(), uiTokenAmount: { amount: "0", decimals: 9, uiAmount: 0 } },
      ],
      postTokenBalances: [
        { accountIndex: 2, mint: SOL_MINT, owner: wallet.toBase58(), uiTokenAmount: { amount: "603934037", decimals: 9, uiAmount: 0.603934037 } },
      ],
    };
    const d = wealthDeltaLamports(meta as never, keys, wallet);
    expect(d).toBe(603934037 - 7030);
  });

  it("nets unwrap (native up, wSOL down) to ~0", () => {
    const keys = [{ pubkey: wallet }];
    const meta = {
      preBalances: [1_000_000_000],
      postBalances: [1_600_000_000],
      preTokenBalances: [
        { accountIndex: 1, mint: SOL_MINT, owner: wallet.toBase58(), uiTokenAmount: { amount: "600000000", decimals: 9, uiAmount: 0.6 } },
      ],
      postTokenBalances: [],
    };
    const d = wealthDeltaLamports(meta as never, keys, wallet);
    expect(d).toBe(0);
  });
});

describe("classifyLeftover — what a close left in the wallet", () => {
  const MARK = 0.22;

  it("reports nothing when the close swept the token side clean", () => {
    expect(classifyLeftover(null, MARK, false)).toEqual({ kind: "none", share: null, creditSol: 0 });
  });

  // pos#15 BUTTHOLE, 2026-08-17: a WINNING close (+0.0002 SOL) that filed an
  // error over 0.00045 SOL of dust and claimed "residual sweep will sell it" —
  // for an amount sweepResiduals is guaranteed to skip.
  it("treats a leftover under the sweep floor as dust, not an incident", () => {
    const r = classifyLeftover(0.00045059, MARK, true);
    expect(r.kind).toBe("dust");
    expect(r.creditSol).toBe(0); // nothing will convert it — book the loss now
  });

  it("treats a leftover at or above the sweep floor as a recoverable strand", () => {
    const r = classifyLeftover(RESIDUAL_SWEEP_MIN_SOL, MARK, true);
    expect(r.kind).toBe("strand");
    expect(r.creditSol).toBe(RESIDUAL_SWEEP_MIN_SOL);
  });

  // ANSEM pos#8: 0.5327 SOL, 75% of mark — the case the detector exists for.
  it("flags a large under-fill and carries its full value as credit", () => {
    const r = classifyLeftover(0.532672767, 0.7144471699792198, true);
    expect(r.kind).toBe("strand");
    expect(r.creditSol).toBeCloseTo(0.532672767, 9);
    expect(r.share!).toBeGreaterThan(0.25); // clears the alert bar
  });

  it("flags an unquotable leftover rather than assuming it is dust", () => {
    // Being unable to price it is exactly when we must not write it off.
    const r = classifyLeftover(null, MARK, true);
    expect(r.kind).toBe("strand");
    expect(r.share).toBeNull();
    expect(r.creditSol).toBe(0); // but PnL may only count what we can value
  });

  it("returns no share when the mark is zero (empty close)", () => {
    expect(classifyLeftover(0.05, 0, true).share).toBeNull();
  });
});
