import { PublicKey, type Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { connection } from "./onchain.js";
import type { HolderShare } from "./knownAccounts.js";

const TOTAL_TIMEOUT_MS = 10_000;
const MAX_HOLDERS = 12;
// A wallet's funder is whoever paid for its first transactions. One page of
// signatures reaches the start of any wallet young enough to be a side wallet;
// a longer history has no findable first funder, so that wallet joins no
// cluster. Until 2026-11-25 this read the 12 most RECENT transactions, a window
// of minutes on an active wallet, and named whoever last sent it SOL.
const HISTORY_PAGE = 1000;
const FIRST_TXS = 3;
const LAUNCH_WINDOW_SLOTS = 5;

/**
 * Largest group of two or more holders linked by funding, as % of supply.
 * Each link joins a wallet to its funder, so co-funded wallets, a funder that
 * also holds, and a funding chain between holders all land in one group. One
 * funded wallet is not a cluster (single_holder gates a lone whale): counting
 * it made this score equal the largest holder's share on most tokens.
 */
export function maxFundingClusterPct(
  holdings: Array<{ wallet: string; pct: number }>,
  funderOf: ReadonlyMap<string, string>,
): number {
  const parent = new Map<string, string>();
  const root = (x: string): string => {
    while (parent.has(x)) x = parent.get(x)!;
    return x;
  };
  for (const [wallet, funder] of funderOf) {
    const a = root(wallet), b = root(funder);
    if (a !== b) parent.set(a, b);
  }
  const groups = new Map<string, { pct: number; wallets: number }>();
  for (const h of holdings) {
    const g = groups.get(root(h.wallet)) ?? { pct: 0, wallets: 0 };
    g.pct += h.pct;
    g.wallets++;
    groups.set(root(h.wallet), g);
  }
  let max = 0;
  for (const g of groups.values()) if (g.wallets >= 2 && g.pct > max) max = g.pct;
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
    // String(): pubkey is a PublicKey from web3.js and a plain string from raw RPC.
    const keys = tx.transaction.message.accountKeys.map((k) =>
      typeof k === "string" ? k : String(k.pubkey),
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
    // A token account that lost lamports is a pool's wSOL vault paying a seller, not a funder.
    const tokenAccounts = new Set(
      [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])].map((b) => b.accountIndex),
    );
    for (let i = 0; i < keys.length; i++) {
      if (i === idx || tokenAccounts.has(i)) continue;
      const d = (meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0);
      if (d < 0 && Math.abs(d) >= delta * 0.9) return keys[i]!;
    }
  }
  return null;
}

/**
 * Raw getTransaction batch. web3.js 1.x rejects version-1 transactions in its
 * response schema, and one of them fails a whole getParsedTransactions batch:
 * on 2026-11-25 that silently dropped 16 of 24 probed holders. jsonParsed has
 * the same message/meta shape in every version.
 */
export async function parsedTxs(c: Connection, signatures: string[]): Promise<Array<ParsedTransactionWithMeta | null>> {
  const batch = (c as unknown as {
    _rpcBatchRequest(reqs: Array<{ methodName: string; args: unknown[] }>): Promise<Array<{ result?: ParsedTransactionWithMeta | null }>>;
  })._rpcBatchRequest(signatures.map((s) => ({
    methodName: "getTransaction",
    args: [s, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }],
  })));
  return (await batch).map((r) => r.result ?? null);
}

/**
 * Best-effort funding-cluster %. Null = unknown: a timeout, or most holders
 * out of reach (lookup failed, or a history longer than one page, which is
 * every top holder on a token held by trading bots) — never a clean 0 from a
 * blind scan.
 * Budget-capped: top holders only, first transactions only, overall timeout.
 */
export async function detectInsiderClusterPct(
  holdings: HolderShare[],
): Promise<number | null> {
  if (!holdings.length) return null;
  const c = connection();
  const top = holdings.slice(0, MAX_HOLDERS);

  const work = (async () => {
    const funderOf = new Map<string, string>();
    let read = 0;
    // Resolve funders sequentially in small batches to stay under RPC limits.
    for (let i = 0; i < top.length; i += 4) {
      const batch = top.slice(i, i + 4);
      await Promise.all(batch.map(async (h) => {
        try {
          const sigs = await c.getSignaturesForAddress(
            new PublicKey(h.owner),
            { limit: HISTORY_PAGE },
          );
          if (sigs.length > 0 && sigs.length < HISTORY_PAGE) {
            // Newest-first page that reached the wallet's start: its tail is the first transactions.
            const first = sigs.slice(-FIRST_TXS).reverse().map((s) => s.signature);
            const funder = funderFromParsedTxs(h.owner, await parsedTxs(c, first));
            if (funder) funderOf.set(h.owner, funder);
            read++;
          }
        } catch { /* degrade per-wallet */ }
      }));
    }
    if (read * 2 < top.length) return null;

    const fundingPct = maxFundingClusterPct(
      top.map((h) => ({ wallet: h.owner, pct: h.pct })),
      funderOf,
    );
    // Sniper detection without full mint history: if ≥2 top holders share a
    // funder we already captured the risk via fundingPct. Launch-slot scan is
    // skipped here to keep RPC budget; pure helper remains for tests/future.
    return insiderClusterPct(fundingPct, 0);
  })();

  return raceTimeout(work, TOTAL_TIMEOUT_MS);
}
