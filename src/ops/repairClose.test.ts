import { describe, it, expect } from "vitest";
import { isUnbookedExitLeg, walletDeltas } from "./repairClose.js";
import { SOL_MINT } from "../config.js";

const WALLET = "A5qoBWtNp5z2zTZLTRmALpjCkAT3KPLP28hxmaLzHZ6q";
const OTHER = "9DTThTbggnp2P2ZGLFRfN1A3j5JUsXez1dRJak3TixB2";
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";

describe("isUnbookedExitLeg", () => {
  it("counts a sale of the position's token for SOL", () => {
    expect(isUnbookedExitLeg(-14114.896, 0.695132)).toBe(true);
  });

  // Both directions are required, or the repair starts inventing recoveries out
  // of transactions that were already accounted for somewhere else.
  it("rejects a SOL-only credit (rent reclaim, fee claim)", () => {
    expect(isUnbookedExitLeg(0, 0.002104)).toBe(false);
  });

  it("rejects a token-only move (transfer, not a sale)", () => {
    expect(isUnbookedExitLeg(-500, 0)).toBe(false);
  });

  it("rejects a BUY of the token — that is an entry, not an exit leg", () => {
    expect(isUnbookedExitLeg(+14114.896, -0.7)).toBe(false);
  });
});

describe("walletDeltas", () => {
  const meta = (over: Record<string, unknown> = {}) => ({
    preBalances: [1_000_000_000, 0],
    postBalances: [1_695_132_000, 0],
    preTokenBalances: [{ owner: WALLET, mint: PUMP, uiTokenAmount: { uiAmount: 14114.896 } }],
    postTokenBalances: [],
    ...over,
  });

  it("reads the native SOL credit and the token debit of the real pos#104 swap", () => {
    const d = walletDeltas(meta(), [WALLET, OTHER], WALLET, PUMP);
    expect(d.solDelta).toBeCloseTo(0.695132, 6);
    expect(d.tokenDelta).toBeCloseTo(-14114.896, 3);
    expect(isUnbookedExitLeg(d.tokenDelta, d.solDelta)).toBe(true);
  });

  // Jupiter often settles into wSOL. Counting only native would read a real
  // recovery as zero — the same class of miss this whole repair exists for.
  it("counts wSOL as SOL", () => {
    const d = walletDeltas(
      meta({
        postBalances: [1_000_000_000, 0],
        postTokenBalances: [{ owner: WALLET, mint: SOL_MINT, uiTokenAmount: { uiAmount: 0.695132 } }],
      }),
      [WALLET, OTHER], WALLET, PUMP,
    );
    expect(d.solDelta).toBeCloseTo(0.695132, 6);
  });

  it("ignores balances belonging to another owner", () => {
    const d = walletDeltas(
      meta({ preTokenBalances: [{ owner: OTHER, mint: PUMP, uiTokenAmount: { uiAmount: 999 } }] }),
      [WALLET, OTHER], WALLET, PUMP,
    );
    expect(d.tokenDelta).toBe(0);
  });

  it("ignores a different mint", () => {
    const d = walletDeltas(meta(), [WALLET, OTHER], WALLET, "SomeOtherMint111111111111111111111111111111");
    expect(d.tokenDelta).toBe(0);
  });
});
