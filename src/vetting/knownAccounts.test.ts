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

  // Failure modes of the RPC funding scan, written before the fix. A live
  // probe on 2026-11-25 scored BASKET 6.89% when no two holders shared a
  // funder: 6.89% was simply its largest holder.
  //  C1 one funded wallet is reported as a "cluster"
  //  C2 a funder that is itself a top holder is left out of its own cluster
  //  C3 a funding chain between holders (A funds B funds C) splits in two
  //  C4 two unrelated clusters are added together
  //  C5 a pool vault that paid a seller is read as that wallet's funder
  //  C6 raw-RPC transactions (pubkey as a string) throw and drop the wallet
  it("C1: a single funded wallet is not a cluster", () => {
    expect(maxFundingClusterPct([{ wallet: "w1", pct: 9 }], new Map([["w1", "F"]]))).toBe(0);
  });

  it("C2: a funder that is also a holder counts in its own cluster", () => {
    expect(maxFundingClusterPct([
      { wallet: "F", pct: 4 }, { wallet: "w1", pct: 3 }, { wallet: "w2", pct: 2 },
    ], new Map([["w1", "F"], ["w2", "F"]]))).toBe(9);
  });

  it("C3: a funding chain between holders is one cluster", () => {
    expect(maxFundingClusterPct([
      { wallet: "A", pct: 5 }, { wallet: "B", pct: 3 }, { wallet: "C", pct: 2 },
    ], new Map([["B", "A"], ["C", "B"]]))).toBe(10);
  });

  it("C4: unrelated clusters are not added together", () => {
    expect(maxFundingClusterPct([
      { wallet: "w1", pct: 3 }, { wallet: "w2", pct: 2 }, { wallet: "w3", pct: 4 }, { wallet: "w4", pct: 4 },
    ], new Map([["w1", "F"], ["w2", "F"], ["w3", "G"], ["w4", "G"]]))).toBe(8);
  });

  const diffTx = (keys: unknown[], tokenAccountIndexes: number[]) => ({
    transaction: { message: { accountKeys: keys, instructions: [] } },
    meta: {
      preBalances: [5e9, 1e9], postBalances: [4e9, 2e9],
      preTokenBalances: tokenAccountIndexes.map((accountIndex) => ({ accountIndex })),
      postTokenBalances: [],
    },
  }) as unknown as ParsedTransactionWithMeta;

  it("C5: a token account that paid the wallet (a pool vault on a sell) is not a funder", () => {
    expect(funderFromParsedTxs("Wallet", [diffTx(["Vault", "Wallet"], [0])])).toBeNull();
    expect(funderFromParsedTxs("Wallet", [diffTx(["Payer", "Wallet"], [])])).toBe("Payer");
  });

  it("C6: raw-RPC account keys (pubkey as a string) are read, not thrown on", () => {
    expect(funderFromParsedTxs("Wallet", [diffTx([{ pubkey: "Payer" }, { pubkey: "Wallet" }], [])])).toBe("Payer");
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
