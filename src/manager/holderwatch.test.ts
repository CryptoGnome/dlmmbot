import { describe, it, expect } from "vitest";
import {
  confirmHolderTrigger, findTrigger, HOLDER_CHECK_BUDGET_MS, isNonWalletHolder, parseHolderPct,
} from "./holderwatch.js";

const m = (entries: Array<[string, number]>) => new Map(entries);

/**
 * The pool we are IN is the largest holder of a fresh meme token, and its
 * balance FALLS when price runs up (buyers take inventory out). Read as a
 * wallet, that is a "wallet_dump" — a permanent token+creator ban — on a
 * pool being traded through. Same shape as the tvl_drain false positive.
 * GMGN does tag exchanges, but the tag is best-effort on someone else's
 * server; our own pool address and the AMM programs vetting already knows
 * must be excluded regardless.
 */
describe("non-wallet holder exclusion", () => {
  const POOL = "Bc9bn56bRPSnByz418rgpXHXDphCCUiUyXLA6FwWQjDi";
  const gmgn = (rows: Array<Record<string, unknown>>) => JSON.stringify({ data: { list: rows } });

  it("excludes our own pool even when GMGN does not tag it", () => {
    const raw = gmgn([
      { address: POOL, amount_percentage: 0.42 },              // untagged pool
      { address: "Wallet1", amount_percentage: 0.05 },
    ]);
    const pct = parseHolderPct(raw, POOL)!;
    expect(pct.has(POOL)).toBe(false);
    expect(pct.get("Wallet1")).toBeCloseTo(5);
  });

  it("excludes known AMM programs and burn sinks by address", () => {
    expect(isNonWalletHolder("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", null)).toBe(true); // DLMM
    expect(isNonWalletHolder("1nc1nerator11111111111111111111111111111111", null)).toBe(true);
    expect(isNonWalletHolder("Wallet1", null)).toBe(false);
  });

  it("still honours GMGN's own exchange tags", () => {
    const raw = gmgn([
      { address: "CexHot1", amount_percentage: 0.30, addr_type: 2 },
      { address: "CexHot2", amount_percentage: 0.30, exchange: "binance" },
      { address: "Wallet1", amount_percentage: 0.05 },
    ]);
    const pct = parseHolderPct(raw, null)!;
    expect([...pct.keys()]).toEqual(["Wallet1"]);
  });

  it("the GUNICORN shape: pool inventory bought out is not a wallet_dump", () => {
    // Baseline: pool holds 42%, a wallet holds 5%. Price runs up, buyers take
    // 10% of supply out of the pool. Nothing a wallet did.
    const before = parseHolderPct(gmgn([
      { address: POOL, amount_percentage: 0.42 }, { address: "Wallet1", amount_percentage: 0.05 },
    ]), POOL)!;
    const after = parseHolderPct(gmgn([
      { address: POOL, amount_percentage: 0.32 }, { address: "Wallet1", amount_percentage: 0.05 },
    ]), POOL)!;
    expect(findTrigger(before, after, 3, 10)).toBeNull();
    // And WITHOUT the exclusion it would have fired — the bug being pinned.
    const naive = (rows: Array<[string, number]>) => new Map(rows);
    expect(findTrigger(naive([[POOL, 42], ["Wallet1", 5]]), naive([[POOL, 32], ["Wallet1", 5]]), 3, 10))
      .toEqual({ kind: "wallet_dump", detail: expect.stringContaining("42.0%→32.0%") });
  });
});

describe("findTrigger", () => {
  it("fires wallet_dump at threshold", () => {
    const base = m([["Wallet1", 15]]);
    const cur = m([["Wallet1", 11]]);
    const t = findTrigger(base, cur, 3, 10);
    expect(t?.kind).toBe("wallet_dump");
    expect(t?.detail).toContain("15.0%→11.0%");
  });

  it("ignores dump below threshold", () => {
    expect(findTrigger(m([["A", 10]]), m([["A", 8]]), 3, 10)).toBeNull();
  });

  it("fires new_whale for unseen address at threshold", () => {
    const t = findTrigger(m([["A", 5]]), m([["A", 5], ["Whale", 12]]), 3, 10);
    expect(t?.kind).toBe("new_whale");
    expect(t?.detail).toContain("12.0%");
  });

  it("ignores new address below whale threshold", () => {
    expect(findTrigger(m([["A", 5]]), m([["A", 5], ["Small", 9]]), 3, 10)).toBeNull();
  });

  it("ignores existing holder growing (not new_whale)", () => {
    expect(findTrigger(m([["A", 5]]), m([["A", 15]]), 3, 10)).toBeNull();
  });

  it("returns null on empty maps", () => {
    expect(findTrigger(new Map(), new Map(), 3, 10)).toBeNull();
  });
});

describe("confirmHolderTrigger", () => {
  it("confirms matching kind on second read", () => {
    const base = m([["A", 15]]);
    const cur = m([["A", 11]]);
    const confirm = m([["A", 10]]);
    expect(confirmHolderTrigger(base, cur, confirm, 3, 10)?.kind).toBe("wallet_dump");
  });

  it("rejects when confirm read no longer triggers", () => {
    const base = m([["A", 15]]);
    const cur = m([["A", 11]]);
    const confirm = m([["A", 14]]);
    expect(confirmHolderTrigger(base, cur, confirm, 3, 10)).toBeNull();
  });

  it("rejects kind mismatch (dump candidate, whale on confirm)", () => {
    const base = m([["A", 15]]);
    const cur = m([["A", 11], ["Whale", 12]]);
    const confirm = m([["A", 14], ["Whale", 12]]);
    expect(confirmHolderTrigger(base, cur, confirm, 3, 10)).toBeNull();
  });
});

describe("HOLDER_CHECK_BUDGET_MS", () => {
  it("is a short wall-clock cap", () => {
    expect(HOLDER_CHECK_BUDGET_MS).toBeGreaterThanOrEqual(4000);
    expect(HOLDER_CHECK_BUDGET_MS).toBeLessThanOrEqual(6000);
  });
});
