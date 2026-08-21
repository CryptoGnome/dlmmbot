import { Connection, PublicKey } from "@solana/web3.js";
import { makeConnection } from "../rpc.js";

// Fresh on-chain token checks — never cached, run at entry time.
//
// Not cached on purpose, and it is worth writing down why, because the
// tempting optimisation does not work: mintAuthority / freezeAuthority are
// monotonic (Solana lets them be revoked, never restored) so a PASS could in
// principle be remembered forever — but they arrive on the same
// getParsedAccountInfo response as `supply`, and supply falls whenever anyone
// burns. Since supply is the denominator of both the holder-concentration and
// the insider-cluster gates, a remembered supply reads every holder as a
// smaller share of the token than they really own. Caching here would either
// save nothing (fetch supply separately anyway) or quietly loosen two safety
// gates. The win available in this file was the serial pair below, not a cache.
// Uses jsonParsed RPC so we don't hand-roll SPL layouts.
// Holder concentration (AMM-stripped) lives in holders.ts; funding clusters in clusters.ts.

export interface OnchainTokenFacts {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  tokenProgram: string;          // "spl-token" | "spl-token-2022"
  token2022Extensions: string[];
  supplyRaw: number;
  decimals: number;
  /** Top raw token accounts (largest 20) — includes pool vaults; strip via holders.ts. */
  largestAccounts: Array<{ address: string; amountRaw: number; pctOfSupply: number }>;
}

let conn: Connection | null = null;
export function connection(): Connection {
  if (!conn) conn = makeConnection({ commitment: "confirmed" });
  return conn;
}

export async function fetchTokenFacts(mint: string): Promise<OnchainTokenFacts> {
  const c = connection();
  const mintPk = new PublicKey(mint);

  // Two independent reads that used to be summed: the mint account and its
  // largest holders. Both need only the mint pubkey, and this sits on the
  // entry critical path, where latency now has a price — the pre-open
  // re-quote skips a candidate whose pool moved while we were deciding.
  const [info, largest] = await Promise.all([
    c.getParsedAccountInfo(mintPk),
    // Best-effort: heavy call. Empty → holders.ts / RugCheck degrade.
    c.getTokenLargestAccounts(mintPk).catch(() => ({ value: [] as never[] })),
  ]);
  const value = info.value;
  if (!value || !("parsed" in (value.data as object))) throw new Error(`mint account not found: ${mint}`);
  const data = value.data as { program: string; parsed: { info: Record<string, unknown>; type: string } };
  const parsed = data.parsed.info as {
    mintAuthority?: string | null;
    freezeAuthority?: string | null;
    supply: string;
    decimals: number;
    extensions?: Array<{ extension: string }>;
  };

  const supplyRaw = Number(parsed.supply);

  return {
    mintAuthority: parsed.mintAuthority ?? null,
    freezeAuthority: parsed.freezeAuthority ?? null,
    tokenProgram: data.program,
    token2022Extensions: (parsed.extensions ?? []).map((e) => e.extension),
    supplyRaw,
    decimals: parsed.decimals,
    largestAccounts: largest.value.map((a) => ({
      address: a.address.toBase58(),
      amountRaw: Number(a.amount),
      pctOfSupply: supplyRaw > 0 ? (Number(a.amount) / supplyRaw) * 100 : 0,
    })),
  };
}
