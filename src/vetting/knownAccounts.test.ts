import { describe, it, expect } from "vitest";
import {
  aggregateHolderShares, classifyOwner, concentration,
} from "./knownAccounts.js";
import {
  funderFromParsedTxs, insiderClusterPct, launchSniperPct, maxFundingClusterPct,
} from "./clusters.js";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";

describe("knownAccounts", () => {
  it("classifies burn and AMM program-owned accounts", () => {
    expect(classifyOwner("1nc1nerator11111111111111111111111111111111", null)).toBe("burn");
    expect(classifyOwner("VaultPda1111111111111111111111111111111",
      "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo")).toBe("amm");
    expect(classifyOwner("Wallet111111111111111111111111111111111", "11111111111111111111111111111111")).toBe("wallet");
  });

  it("aggregates multi-ATA owners and drops AMM/burn", () => {
    const shares = aggregateHolderShares([
      { owner: "A", pctOfSupply: 10, kind: "wallet" },
      { owner: "A", pctOfSupply: 5, kind: "wallet" },
      { owner: "Vault", pctOfSupply: 40, kind: "amm" },
      { owner: "1nc1nerator11111111111111111111111111111111", pctOfSupply: 20, kind: "burn" },
      { owner: "B", pctOfSupply: 8, kind: "wallet" },
    ]);
    expect(shares).toEqual([
      { owner: "A", pct: 15 },
      { owner: "B", pct: 8 },
    ]);
  });

  it("concentration single + top10", () => {
    expect(concentration([])).toBeNull();
    const conc = concentration([
      { owner: "a", pct: 12 },
      { owner: "b", pct: 8 },
      { owner: "c", pct: 5 },
    ]);
    expect(conc).toEqual({ single: 12, top10: 25 });
  });
});

describe("clusters pure math", () => {
  it("maxFundingClusterPct sums co-funded wallets", () => {
    const funderOf = new Map([
      ["w1", "F"],
      ["w2", "F"],
      ["w3", "G"],
    ]);
    expect(maxFundingClusterPct([
      { wallet: "w1", pct: 6 },
      { wallet: "w2", pct: 5 },
      { wallet: "w3", pct: 9 },
      { wallet: "w4", pct: 20 }, // no funder
    ], funderOf)).toBe(11);
  });

  it("launchSniperPct sums wallets in launch window", () => {
    expect(launchSniperPct([
      { wallet: "s1", pct: 4, slot: 100 },
      { wallet: "s2", pct: 3, slot: 103 },
      { wallet: "late", pct: 10, slot: 200 },
    ], 100, 5)).toBe(7);
  });

  it("insiderClusterPct takes the max of funding vs sniper", () => {
    expect(insiderClusterPct(8, 12)).toBe(12);
    expect(insiderClusterPct(9, 2)).toBe(9);
  });

  it("funderFromParsedTxs reads parsed SOL transfer", () => {
    const tx = {
      transaction: {
        message: {
          accountKeys: ["Funder", "Wallet"],
          instructions: [{
            program: "system",
            programId: "11111111111111111111111111111111",
            parsed: { type: "transfer", info: { source: "Funder", destination: "Wallet", lamports: 1e9 } },
          }],
        },
      },
      meta: null,
    } as unknown as ParsedTransactionWithMeta;
    expect(funderFromParsedTxs("Wallet", [tx])).toBe("Funder");
    expect(funderFromParsedTxs("Wallet", [null])).toBeNull();
  });
});
