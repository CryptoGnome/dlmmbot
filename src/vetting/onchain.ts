import { Connection, PublicKey } from "@solana/web3.js";
import { makeConnection } from "../rpc.js";

// Fresh on-chain token checks — never cached, run at entry time.
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

  const info = await c.getParsedAccountInfo(mintPk);
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

  // Best-effort: heavy call. Empty → holders.ts / RugCheck degrade.
  const largest = await c.getTokenLargestAccounts(mintPk).catch(() => ({ value: [] as never[] }));
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
