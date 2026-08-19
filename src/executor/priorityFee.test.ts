import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { installConfig, restoreConfig } from "../test/config.js";
import {
  clampFee, computeUnitLimitFor, computeUnitPriceIxIndex, escalate, hasComputeUnitLimit,
  MAX_COMPUTE_UNITS, pickFeeMicroLamports, priorityFeeSettings, recentFeeMicroLamports,
  setComputeUnitPrice, writableAccountsOf, type PriorityFeeSettings,
} from "./priorityFee.js";

const BLOCKHASH = "11111111111111111111111111111111";

function settings(over: Partial<PriorityFeeSettings> = {}): PriorityFeeSettings {
  return {
    percentile: 75,
    floorMicroLamports: 10_000,
    capMicroLamports: 1_000_000,
    retryMult: 1.5,
    cuMarginPct: 20,
    cuFallback: 600_000,
    ...over,
  };
}

/** A tx with `n` distinct writable accounts and no compute-budget instructions. */
function plainTx(n = 2): Transaction {
  const tx = new Transaction();
  tx.recentBlockhash = BLOCKHASH;
  tx.feePayer = Keypair.generate().publicKey;
  tx.add(new TransactionInstruction({
    programId: Keypair.generate().publicKey,
    keys: Array.from({ length: n }, () => ({
      pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true,
    })),
    data: Buffer.from([1]),
  }));
  return tx;
}

describe("priority fee selection", () => {
  it("takes the percentile of NONZERO samples", () => {
    // The zero-fee majority is what unprioritised traffic pays; including it
    // would report "0" as the going rate on a pool that is actually contested.
    const samples = [0, 0, 0, 0, 100, 200, 300, 400];
    expect(pickFeeMicroLamports(samples, settings({ floorMicroLamports: 1, percentile: 75 }))).toBe(400);
    expect(pickFeeMicroLamports(samples, settings({ floorMicroLamports: 1, percentile: 50 }))).toBe(300);
    expect(pickFeeMicroLamports(samples, settings({ floorMicroLamports: 1, percentile: 0 }))).toBe(100);
  });

  it("clamps to floor and cap", () => {
    expect(pickFeeMicroLamports([5], settings())).toBe(10_000);
    expect(pickFeeMicroLamports([9_000_000], settings())).toBe(1_000_000);
  });

  it("falls back to the floor when every sample is zero or absent", () => {
    expect(pickFeeMicroLamports([], settings())).toBe(10_000);
    expect(pickFeeMicroLamports([0, 0], settings())).toBe(10_000);
  });

  it("ignores non-finite samples rather than producing NaN", () => {
    expect(pickFeeMicroLamports([NaN, Infinity, 50_000], settings())).toBe(50_000);
  });

  it("survives a cap set below the floor", () => {
    const s = settings({ floorMicroLamports: 20_000, capMicroLamports: 5_000 });
    expect(clampFee(1, s)).toBe(20_000);
  });
});

describe("retry escalation", () => {
  it("raises the price per attempt and never past the cap", () => {
    const s = settings();
    expect(escalate(20_000, 0, s)).toBe(20_000);
    expect(escalate(20_000, 1, s)).toBe(30_000);
    expect(escalate(20_000, 2, s)).toBe(45_000);
    expect(escalate(900_000, 3, s)).toBe(1_000_000); // capped
  });

  it("a multiplier at or below 1 is inert rather than shrinking the fee", () => {
    expect(escalate(20_000, 3, settings({ retryMult: 0.5 }))).toBe(20_000);
  });
});

describe("transaction inspection", () => {
  it("collects writable accounts, deduped", () => {
    const dup = Keypair.generate().publicKey;
    const tx = new Transaction().add(new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [
        { pubkey: dup, isSigner: false, isWritable: true },
        { pubkey: dup, isSigner: false, isWritable: true },
        { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false },
      ],
      data: Buffer.alloc(0),
    }));
    expect(writableAccountsOf(tx)).toHaveLength(1);
  });

  // Adding a second compute-budget instruction of the same kind fails the
  // transaction, and the DLMM SDK already prepends its own simulated limit.
  it("detects an existing compute unit limit", () => {
    expect(hasComputeUnitLimit(plainTx())).toBe(false);
    const withLimit = plainTx();
    withLimit.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
    expect(hasComputeUnitLimit(withLimit)).toBe(true);
  });

  it("does not mistake a price instruction for a limit instruction", () => {
    const tx = plainTx();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 }));
    expect(hasComputeUnitLimit(tx)).toBe(false);
    expect(computeUnitPriceIxIndex(tx)).toBe(1);
  });

  it("reports -1 when there is no price instruction to replace", () => {
    expect(computeUnitPriceIxIndex(plainTx())).toBe(-1);
  });

  // The retry path calls this repeatedly on ONE transaction; appending each
  // time would build a tx with several price instructions, which fails.
  it("replaces the price instruction instead of stacking duplicates", () => {
    const tx = plainTx();
    setComputeUnitPrice(tx, 10_000);
    setComputeUnitPrice(tx, 20_000);
    setComputeUnitPrice(tx, 30_000);
    const prices = tx.instructions.filter((_, i) => i === computeUnitPriceIxIndex(tx));
    expect(prices).toHaveLength(1);
    expect(tx.instructions.filter((ix) =>
      ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3)).toHaveLength(1);
    expect(tx.instructions[computeUnitPriceIxIndex(tx)]!.data.readBigUInt64LE(1)).toBe(30_000n);
  });

  it("leaves a compute unit limit alone when setting the price", () => {
    const tx = plainTx();
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }));
    setComputeUnitPrice(tx, 10_000);
    setComputeUnitPrice(tx, 40_000);
    expect(hasComputeUnitLimit(tx)).toBe(true);
    expect(tx.instructions[0]!.data.readUInt32LE(1)).toBe(250_000);
  });
});

describe("account-scoped fee sampling", () => {
  it("asks for the accounts the tx writes", async () => {
    const tx = plainTx(3);
    const getRecentPrioritizationFees = vi.fn().mockResolvedValue([{ prioritizationFee: 50_000 }]);
    const fee = await recentFeeMicroLamports({ getRecentPrioritizationFees }, writableAccountsOf(tx), settings());
    expect(fee).toBe(50_000);
    const arg = getRecentPrioritizationFees.mock.calls[0]![0] as { lockedWritableAccounts: PublicKey[] };
    expect(arg.lockedWritableAccounts).toHaveLength(3);
  });

  // A cold account and an RPC that ignores the filter both return []; the
  // network-wide sample beats dropping straight to the floor either way.
  it("falls back to the network-wide sample when the scoped query is empty", async () => {
    const getRecentPrioritizationFees = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ prioritizationFee: 77_000 }]);
    const fee = await recentFeeMicroLamports(
      { getRecentPrioritizationFees }, [Keypair.generate().publicKey], settings(),
    );
    expect(fee).toBe(77_000);
    expect(getRecentPrioritizationFees).toHaveBeenCalledTimes(2);
    expect(getRecentPrioritizationFees.mock.calls[1]![0]).toBeUndefined();
  });

  it("returns the floor when the RPC throws on both attempts", async () => {
    const getRecentPrioritizationFees = vi.fn().mockRejectedValue(new Error("rpc down"));
    const fee = await recentFeeMicroLamports(
      { getRecentPrioritizationFees }, [Keypair.generate().publicKey], settings(),
    );
    expect(fee).toBe(10_000);
  });

  it("skips the scoped query when the tx locks nothing writable", async () => {
    const getRecentPrioritizationFees = vi.fn().mockResolvedValue([{ prioritizationFee: 30_000 }]);
    await recentFeeMicroLamports({ getRecentPrioritizationFees }, [], settings());
    expect(getRecentPrioritizationFees).toHaveBeenCalledTimes(1);
    expect(getRecentPrioritizationFees.mock.calls[0]![0]).toBeUndefined();
  });
});

describe("compute unit limit", () => {
  it("returns null when the tx already carries a limit", async () => {
    const tx = plainTx();
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
    const simulateTransaction = vi.fn();
    expect(await computeUnitLimitFor({ simulateTransaction }, tx, settings())).toBeNull();
    expect(simulateTransaction).not.toHaveBeenCalled();
  });

  it("sizes from simulated consumption plus margin", async () => {
    const simulateTransaction = vi.fn().mockResolvedValue({ value: { unitsConsumed: 200_000, err: null } });
    expect(await computeUnitLimitFor({ simulateTransaction }, plainTx(), settings())).toBe(240_000);
  });

  // Without an explicit limit the runtime applies 200k × ix count, so the
  // routes that need the most CU are exactly the ones whose simulation gets
  // truncated. Probing at the max is what makes the estimate usable.
  it("probes at the maximum limit without touching the caller's tx", async () => {
    const simulateTransaction = vi.fn().mockResolvedValue({ value: { unitsConsumed: 900_000, err: null } });
    const tx = plainTx();
    const before = tx.instructions.length;
    await computeUnitLimitFor({ simulateTransaction }, tx, settings());
    expect(tx.instructions).toHaveLength(before);
    const probe = simulateTransaction.mock.calls[0]![0] as Transaction;
    expect(hasComputeUnitLimit(probe)).toBe(true);
    expect(probe.instructions[0]!.data.readUInt32LE(1)).toBe(MAX_COMPUTE_UNITS);
  });

  // 2026-08-19: a 2-account rent-reclaim batch simulated at 390 CU → limit
  // 468; the priority-price ix appended AFTER sizing costs 150 more, so the
  // real tx needed 540 and every attempt died with "Program ComputeBudget
  // failed: Computational budget exceeded". The probe must carry the price ix
  // the caller will add, so tiny txs are sized for what actually runs.
  it("probe includes a compute-unit-price ix so the sized limit covers it", async () => {
    const simulateTransaction = vi.fn().mockResolvedValue({ value: { unitsConsumed: 540, err: null } });
    const tx = plainTx();
    await computeUnitLimitFor({ simulateTransaction }, tx, settings());
    const probe = simulateTransaction.mock.calls[0]![0] as Transaction;
    expect(computeUnitPriceIxIndex(probe)).toBeGreaterThanOrEqual(0);
    expect(tx.instructions.length).toBe(plainTx().instructions.length);
  });

  it("probe does not duplicate a price ix the tx already carries", async () => {
    const simulateTransaction = vi.fn().mockResolvedValue({ value: { unitsConsumed: 540, err: null } });
    const tx = plainTx();
    setComputeUnitPrice(tx, 1000);
    await computeUnitLimitFor({ simulateTransaction }, tx, settings());
    const probe = simulateTransaction.mock.calls[0]![0] as Transaction;
    expect(probe.instructions.filter((ix) => computeUnitPriceIxIndex(new Transaction().add(ix)) >= 0)).toHaveLength(1);
  });

  it("never requests more than the runtime ceiling", async () => {
    const simulateTransaction = vi.fn().mockResolvedValue({ value: { unitsConsumed: 1_390_000, err: null } });
    expect(await computeUnitLimitFor({ simulateTransaction }, plainTx(), settings())).toBe(MAX_COMPUTE_UNITS);
  });

  it("falls back when simulation errors, throws, or reports nothing", async () => {
    const s = settings();
    const tx = plainTx();
    const failed = vi.fn().mockResolvedValue({ value: { unitsConsumed: 0, err: "InstructionError" } });
    expect(await computeUnitLimitFor({ simulateTransaction: failed }, tx, s)).toBe(600_000);
    const threw = vi.fn().mockRejectedValue(new Error("rpc down"));
    expect(await computeUnitLimitFor({ simulateTransaction: threw }, tx, s)).toBe(600_000);
    const silent = vi.fn().mockResolvedValue({ value: { unitsConsumed: null, err: null } });
    expect(await computeUnitLimitFor({ simulateTransaction: silent }, tx, s)).toBe(600_000);
  });
});

describe("settings from config", () => {
  beforeEach(() => useDefaultConfig());
  afterEach(() => restoreConfig());

  function useDefaultConfig() {
    installConfig(() => { /* shipped config.toml as-is */ });
  }

  it("reads the shipped values", () => {
    expect(priorityFeeSettings()).toEqual({
      percentile: 75,
      floorMicroLamports: 10_000,
      capMicroLamports: 1_000_000,
      retryMult: 1.5,
      cuMarginPct: 20,
      cuFallback: 600_000,
    });
  });

  // data/config.toml is seeded once and never re-seeded, so every install that
  // predates these keys runs on the code fallbacks — the same path the v0.4.0
  // sizing floors depend on.
  it("falls back in code for a config that predates the keys", () => {
    installConfig((c) => {
      delete c.exec.priority_fee_percentile;
      delete c.exec.priority_fee_floor_microlamports;
      delete c.exec.priority_fee_cap_microlamports;
      delete c.exec.priority_fee_retry_mult;
      delete c.exec.compute_unit_margin_pct;
      delete c.exec.compute_unit_fallback;
    });
    expect(priorityFeeSettings()).toEqual({
      percentile: 75,
      floorMicroLamports: 10_000,
      capMicroLamports: 1_000_000,
      retryMult: 1.5,
      cuMarginPct: 20,
      cuFallback: 600_000,
    });
  });
});
