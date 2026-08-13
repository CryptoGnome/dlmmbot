import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { connection } from "./onchain.js";
import type { HolderShare } from "./knownAccounts.js";

const TOTAL_TIMEOUT_MS = 10_000;
const MAX_HOLDERS = 12;
const MAX_SIGS_PER_WALLET = 12;
const LAUNCH_WINDOW_SLOTS = 5;

/** Group holdings by shared funder; return largest cluster as % of supply. */
export function maxFundingClusterPct(
  holdings: Array<{ wallet: string; pct: number }>,
  funderOf: ReadonlyMap<string, string>,
): number {
  const byFunder = new Map<string, number>();
  for (const h of holdings) {
    const funder = funderOf.get(h.wallet);
    if (!funder || funder === h.wallet) continue;
    byFunder.set(funder, (byFunder.get(funder) ?? 0) + h.pct);
  }
  let max = 0;
  for (const pct of byFunder.values()) if (pct > max) max = pct;
  return max;
}

/** Supply % held by wallets that bought within `windowSlots` of launch. */
export function launchSniperPct(
  buys: Array<{ wallet: string; pct: number; slot: number }>,
  launchSlot: number,
  windowSlots = LAUNCH_WINDOW_SLOTS,
): number {
  const snipers = new Set(
    buys.filter((b) => b.slot >= launchSlot && b.slot <= launchSlot + windowSlots).map((b) => b.wallet),
  );
  if (!snipers.size) return 0;
  const byWallet = new Map<string, number>();
  for (const b of buys) {
    if (!snipers.has(b.wallet)) continue;
    byWallet.set(b.wallet, Math.max(byWallet.get(b.wallet) ?? 0, b.pct));
  }
  let sum = 0;
  for (const pct of byWallet.values()) sum += pct;
  return sum;
}

export function insiderClusterPct(
  fundingPct: number,
  sniperPct: number,
): number {
  return Math.max(fundingPct, sniperPct);
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** First inbound SOL transfer funder for a wallet, or null. */
export function funderFromParsedTxs(
  wallet: string,
  txs: Array<ParsedTransactionWithMeta | null>,
): string | null {
  for (const tx of txs) {
    if (!tx?.transaction?.message?.accountKeys) continue;
    const keys = tx.transaction.message.accountKeys.map((k) =>
      typeof k === "string" ? k : k.pubkey.toBase58(),
    );
    const instructions = tx.transaction.message.instructions;
    for (const ix of instructions) {
      if (!("parsed" in ix) || !ix.parsed) continue;
      const p = ix.parsed as { type?: string; info?: { source?: string; destination?: string } };
      if (p.type !== "transfer" || !p.info) continue;
      if (p.info.destination === wallet && p.info.source && p.info.source !== wallet) {
        return p.info.source;
      }
    }
    // Fallback: first pre→post lamport increase with a matching decrease elsewhere.
    const meta = tx.meta;
    if (!meta?.preBalances || !meta.postBalances) continue;
    const idx = keys.indexOf(wallet);
    if (idx < 0) continue;
    const delta = (meta.postBalances[idx] ?? 0) - (meta.preBalances[idx] ?? 0);
    if (delta <= 0) continue;
    for (let i = 0; i < keys.length; i++) {
      if (i === idx) continue;
      const d = (meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0);
      if (d < 0 && Math.abs(d) >= delta * 0.9) return keys[i]!;
    }
  }
  return null;
}

/**
 * Best-effort insider/funding cluster %. Null = degrade (timeout / thin data).
 * Budget-capped: top holders only, short sig windows, overall timeout.
 */
export async function detectInsiderClusterPct(
  holdings: HolderShare[],
): Promise<number | null> {
  if (!holdings.length) return null;
  const c = connection();
  const top = holdings.slice(0, MAX_HOLDERS);

  const work = (async () => {
    const funderOf = new Map<string, string>();
    // Resolve funders sequentially in small batches to stay under RPC limits.
    for (let i = 0; i < top.length; i += 4) {
      const batch = top.slice(i, i + 4);
      await Promise.all(batch.map(async (h) => {
        try {
          const sigs = await c.getSignaturesForAddress(
            new PublicKey(h.owner),
            { limit: MAX_SIGS_PER_WALLET },
          );
          if (!sigs.length) return;
          // Oldest-first among the recent window — funding usually precedes buys.
          const ordered = [...sigs].reverse();
          const txs = await c.getParsedTransactions(
            ordered.map((s) => s.signature),
            { maxSupportedTransactionVersion: 0 },
          );
          const funder = funderFromParsedTxs(h.owner, txs);
          if (funder) funderOf.set(h.owner, funder);
        } catch { /* degrade per-wallet */ }
      }));
    }

    const fundingPct = maxFundingClusterPct(
      top.map((h) => ({ wallet: h.owner, pct: h.pct })),
      funderOf,
    );
    // Sniper detection without full mint history: if ≥2 top holders share a
    // funder we already captured the risk via fundingPct. Launch-slot scan is
    // skipped here to keep RPC budget; pure helper remains for tests/future.
    return insiderClusterPct(fundingPct, 0);
  })();

  const result = await raceTimeout(work, TOTAL_TIMEOUT_MS);
  if (result === null) return null;
  // No signal ≠ clean: only gate when we found a non-zero cluster.
  return result;
}
