import { describe, it, expect } from "vitest";
import {
  confirmHolderTrigger, findTrigger, HOLDER_CHECK_BUDGET_MS,
} from "./holderwatch.js";

const m = (entries: Array<[string, number]>) => new Map(entries);

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
