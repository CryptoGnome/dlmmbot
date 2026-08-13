import { PublicKey } from "@solana/web3.js";
import { connection, type OnchainTokenFacts } from "./onchain.js";
import {
  aggregateHolderShares, classifyOwner, concentration, type HolderShare,
} from "./knownAccounts.js";

const RESOLVE_TIMEOUT_MS = 8_000;

/**
 * Resolve largest token accounts → wallet owners, drop AMM vault PDAs / burns,
 * aggregate multi-ATA owners. Empty on RPC failure (caller degrades).
 */
export async function holdersExcludingAmms(
  largest: OnchainTokenFacts["largestAccounts"],
): Promise<HolderShare[]> {
  if (!largest.length) return [];
  const c = connection();
  const tokenPks = largest.map((a) => new PublicKey(a.address));

  const parsed = await Promise.race([
    Promise.all(tokenPks.map((pk) => c.getParsedAccountInfo(pk).catch(() => null))),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), RESOLVE_TIMEOUT_MS)),
  ]);
  if (!parsed) return [];

  const ownerWallets: Array<{ owner: string; pctOfSupply: number }> = [];
  for (let i = 0; i < largest.length; i++) {
    const info = parsed[i]?.value;
    if (!info || typeof info.data !== "object" || !("parsed" in info.data)) continue;
    const owner = (info.data as { parsed: { info: { owner?: string } } }).parsed.info.owner;
    if (!owner) continue;
    ownerWallets.push({ owner, pctOfSupply: largest[i]!.pctOfSupply });
  }
  if (!ownerWallets.length) return [];

  const uniqueOwners = [...new Set(ownerWallets.map((o) => o.owner))];
  const ownerInfos = await Promise.race([
    c.getMultipleAccountsInfo(uniqueOwners.map((o) => new PublicKey(o))),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), RESOLVE_TIMEOUT_MS)),
  ]);
  if (!ownerInfos) return [];

  const programByOwner = new Map<string, string | null>();
  for (let i = 0; i < uniqueOwners.length; i++) {
    const info = ownerInfos[i];
    programByOwner.set(uniqueOwners[i]!, info ? info.owner.toBase58() : null);
  }

  return aggregateHolderShares(ownerWallets.map((w) => ({
    owner: w.owner,
    pctOfSupply: w.pctOfSupply,
    kind: classifyOwner(w.owner, programByOwner.get(w.owner) ?? null),
  })));
}

export function concentrationFromShares(shares: HolderShare[]) {
  return concentration(shares);
}
