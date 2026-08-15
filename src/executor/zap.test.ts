import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { zapSlippageTiers } from "./zap.js";
import { assembleSwapIxs, type SwapInstructionsBody } from "./jupiter.js";

describe("zapSlippageTiers", () => {
  it("escalates from base through 1500 bps", () => {
    expect(zapSlippageTiers(50)).toEqual([50, 300, 1500]);
    expect(zapSlippageTiers(500)).toEqual([500, 1500]);
    expect(zapSlippageTiers(1500)).toEqual([1500]);
  });
});

/**
 * The live failure this pins: @meteora-ag/zap-sdk's buildJupiterSwapTransaction
 * keeps ONLY swapInstruction and drops the rest, so the swap program receives an
 * uninitialised wSOL account and rejects with 6025 InvalidTokenAccount. Confirmed
 * by simulating both shapes against mainnet — swap-only errors 6025, setup+swap
 * succeeds. Every close failed all three slippage tiers on it before falling back.
 */
describe("assembleSwapIxs", () => {
  const ix = (tag: number) => ({
    programId: Keypair.generate().publicKey.toBase58(),
    accounts: [{ pubkey: Keypair.generate().publicKey.toBase58(), isSigner: false, isWritable: true }],
    data: Buffer.from([tag]).toString("base64"),
  });
  const tagOf = (i: { data: Buffer }) => i.data[0];

  const body: SwapInstructionsBody = {
    computeBudgetInstructions: [ix(1), ix(2)],
    setupInstructions: [ix(3)],
    swapInstruction: ix(4),
    cleanupInstruction: ix(5),
  };

  it("keeps setup, swap and cleanup in execution order", () => {
    // Order is load-bearing: setup must create the account before the swap
    // writes to it, cleanup must unwrap after the swap has produced wSOL.
    expect(assembleSwapIxs(body).map(tagOf)).toEqual([1, 2, 3, 4, 5]);
  });

  it("includes setupInstructions — dropping them is the 6025 bug", () => {
    const ixs = assembleSwapIxs(body);
    const setupIdx = ixs.findIndex((i) => tagOf(i) === 3);
    const swapIdx = ixs.findIndex((i) => tagOf(i) === 4);
    expect(setupIdx).toBeGreaterThanOrEqual(0);
    expect(setupIdx).toBeLessThan(swapIdx);
  });

  it("includes cleanupInstruction — dropping it stranded proceeds as wSOL", () => {
    const ixs = assembleSwapIxs(body);
    expect(ixs.map(tagOf)).toContain(5);
    expect(tagOf(ixs[ixs.length - 1]!)).toBe(5);
  });

  it("tolerates a null cleanup and absent optional groups", () => {
    expect(assembleSwapIxs({ swapInstruction: ix(4), cleanupInstruction: null }).map(tagOf)).toEqual([4]);
  });

  it("throws rather than sending a transaction with no swap in it", () => {
    expect(() => assembleSwapIxs({ setupInstructions: [ix(3)] })).toThrow(/missing swapInstruction/);
    expect(() => assembleSwapIxs({ error: "no route found" })).toThrow(/no route found/);
  });
});
