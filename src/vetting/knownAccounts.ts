// Known program IDs / burn sinks used to strip pool vaults from holder
// concentration. Token-account "owner" wallets that are PDAs of these programs
// are liquidity vaults, not whales (STRATEGY.md §2.2).

export const BURN_ADDRESSES = new Set([
  "1nc1nerator11111111111111111111111111111111",
]);

/** DEX / launchpad programs whose PDAs hold pool vaults. */
export const AMM_PROGRAM_IDS = new Set([
  // Meteora
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // DLMM
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", // DAMM v2
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", // Dynamic AMM
  // Raydium
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // AMM v4
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // CLMM
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // CPMM
  "5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Xwnvn", // stable
  // Orca
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",
  // Pump
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  // Phoenix / OpenBook
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",
  "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbykgJzKZ",
]);

export type OwnerKind = "wallet" | "amm" | "burn";

/** Classify a token-account owner wallet given the program that owns that account. */
export function classifyOwner(ownerWallet: string, ownerAccountProgram: string | null): OwnerKind {
  if (BURN_ADDRESSES.has(ownerWallet)) return "burn";
  if (ownerAccountProgram && AMM_PROGRAM_IDS.has(ownerAccountProgram)) return "amm";
  if (AMM_PROGRAM_IDS.has(ownerWallet)) return "amm";
  return "wallet";
}

export interface HolderShare {
  owner: string;
  pct: number;
}

/** Aggregate raw token-account rows by owner; drop amm/burn. */
export function aggregateHolderShares(
  rows: Array<{ owner: string; pctOfSupply: number; kind: OwnerKind }>,
): HolderShare[] {
  const byOwner = new Map<string, number>();
  for (const r of rows) {
    if (r.kind !== "wallet") continue;
    byOwner.set(r.owner, (byOwner.get(r.owner) ?? 0) + r.pctOfSupply);
  }
  return [...byOwner.entries()]
    .map(([owner, pct]) => ({ owner, pct }))
    .sort((a, b) => b.pct - a.pct);
}

export function concentration(shares: HolderShare[]): { single: number; top10: number } | null {
  if (!shares.length) return null;
  return {
    single: shares[0]!.pct,
    top10: shares.slice(0, 10).reduce((s, h) => s + h.pct, 0),
  };
}
