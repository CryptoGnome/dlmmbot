import { describe, it, expect, vi } from "vitest";
import { runSlippageLadder, slippageTiers } from "./jupiter.js";
import { SOL_MINT } from "../config.js";

const MINT = "So1111111111111111111111111111111111111111x"; // any non-SOL mint

describe("slippageTiers", () => {
  it("base, ~3x clamped to 300–1500, then 1500", () => {
    expect(slippageTiers(50)).toEqual([50, 300, 1500]);
    expect(slippageTiers(500)).toEqual([500, 1500]);
    expect(slippageTiers(1500)).toEqual([1500]);
  });
});

describe("runSlippageLadder", () => {
  it("returns the first tier that succeeds and never calls a later one", async () => {
    const swap = vi.fn(async (_amt: bigint, bps: number) => ({ outLamports: 100, signature: `sig-${bps}` }));
    const r = await runSlippageLadder(MINT, 1000n, 50, swap);
    expect(r?.signature).toBe("sig-50");
    expect(swap).toHaveBeenCalledTimes(1);
  });

  it("escalates through the tiers on failure and rethrows the last error", async () => {
    const swap = vi.fn(async (_amt: bigint, bps: number) => { throw new Error(`fail@${bps}`); });
    await expect(runSlippageLadder(MINT, 1000n, 50, swap)).rejects.toThrow("fail@1500");
    expect(swap.mock.calls.map((c) => c[1])).toEqual([50, 300, 1500]);
  });

  // The hazard this guards: swapToSol has its own send+confirm. A confirm that
  // throws is NOT proof the tx did not land. Without a re-read, the next tier
  // re-quotes the ORIGINAL amount against a wallet that may already be empty
  // — or that has since been credited with tokens the position never held.
  it("stops escalating when the wallet is empty after a thrown tier — the tx landed", async () => {
    const swap = vi.fn(async (_amt: bigint, bps: number) => { throw new Error(`confirm timeout @${bps}`); });
    const reread = vi.fn(async () => 0n); // tier 1 actually sold it all
    const r = await runSlippageLadder(MINT, 1000n, 50, swap, reread);
    expect(r).toBeNull();                       // not an error: nothing left to sell
    expect(swap).toHaveBeenCalledTimes(1);      // did NOT send a second swap
    expect(reread).toHaveBeenCalledTimes(1);
  });

  // pos#104 PUMP, 2026-08-24. The ladder proved the swap landed ("wallet now
  // 0") and then returned null — the caller's "no swap happened" value — so the
  // 0.695 SOL the swap really produced never reached the close's wealth delta.
  // The ledger booked 0.070 against a 0.750 deposit, -88.8%, and the phantom
  // loss tripped the daily circuit breaker. If the tier carried a signature out
  // on its confirm error, the ladder must hand it back.
  it("returns the landed signature when the wallet proves the thrown tier sold", async () => {
    const swap = vi.fn(async (_amt: bigint, bps: number) => {
      throw Object.assign(new Error(`not confirmed in 30s @${bps}`), { signature: "LUPZhnAac9" });
    });
    const reread = vi.fn(async () => 0n);
    const r = await runSlippageLadder(MINT, 1000n, 50, swap, reread);
    expect(r?.signature).toBe("LUPZhnAac9");    // NOT null — the SOL is real
    expect(swap).toHaveBeenCalledTimes(1);      // still does not double-sell
  });

  // The between-tier re-read only runs when a tier remains. The final tier had
  // no such check, so the same loss reappeared on the last rung of the ladder.
  it("recovers the last tier's signature too, where no iteration remains", async () => {
    const swap = vi.fn(async (_amt: bigint, bps: number) => {
      throw Object.assign(new Error(`not confirmed @${bps}`), { signature: `sig-${bps}` });
    });
    let calls = 0;
    // Non-zero between tiers so the ladder runs all three, then empty at the end.
    const reread = vi.fn(async () => (++calls <= 2 ? 1000n : 0n));
    const r = await runSlippageLadder(MINT, 1000n, 50, swap, reread);
    expect(r?.signature).toBe("sig-1500");
    expect(swap).toHaveBeenCalledTimes(3);
  });

  // Never invent a signature: a tier that failed without one must still throw
  // rather than report a swap that may not exist.
  it("still throws when the last tier left no signature to recover", async () => {
    const swap = vi.fn(async (_amt: bigint, bps: number) => { throw new Error(`dead @${bps}`); });
    const reread = vi.fn(async () => 1000n);
    await expect(runSlippageLadder(MINT, 1000n, 50, swap, reread)).rejects.toThrow("dead @1500");
  });

  it("re-quotes only what the wallet still holds when a tier partially landed", async () => {
    let calls = 0;
    const swap = vi.fn(async (amt: bigint, bps: number) => {
      calls++;
      if (calls === 1) throw new Error("confirm timeout");
      return { outLamports: Number(amt), signature: `sig-${bps}-${amt}` };
    });
    const reread = vi.fn(async () => 400n); // 600 of 1000 already went out
    const r = await runSlippageLadder(MINT, 1000n, 50, swap, reread);
    expect(r?.signature).toBe("sig-300-400");
    expect(swap.mock.calls[1]![0]).toBe(400n); // second tier sold 400, not 1000
  });

  it("does not shrink the amount when the wallet holds MORE than requested", async () => {
    // Tokens credited between tiers (a claim, a reward) belong to a different
    // accounting bucket — the ladder sells only what it was asked to sell.
    let calls = 0;
    const swap = vi.fn(async (amt: bigint, bps: number) => {
      calls++;
      if (calls === 1) throw new Error("confirm timeout");
      return { outLamports: Number(amt), signature: `sig-${bps}-${amt}` };
    });
    const reread = vi.fn(async () => 5000n);
    const r = await runSlippageLadder(MINT, 1000n, 50, swap, reread);
    expect(swap.mock.calls[1]![0]).toBe(1000n);
    expect(r?.signature).toBe("sig-300-1000");
  });

  it("falls back to plain escalation when the re-read itself fails", async () => {
    let calls = 0;
    const swap = vi.fn(async (amt: bigint, bps: number) => {
      calls++;
      if (calls === 1) throw new Error("x");
      return { outLamports: 1, signature: `sig-${bps}-${amt}` };
    });
    const reread = vi.fn(async () => { throw new Error("rpc down"); });
    const r = await runSlippageLadder(MINT, 1000n, 50, swap, reread);
    expect(r?.signature).toBe("sig-300-1000"); // original amount, next tier
  });

  it("is a no-op for SOL or zero", async () => {
    const swap = vi.fn();
    expect(await runSlippageLadder(SOL_MINT, 1000n, 50, swap)).toBeNull();
    expect(await runSlippageLadder(MINT, 0n, 50, swap)).toBeNull();
    expect(swap).not.toHaveBeenCalled();
  });
});
