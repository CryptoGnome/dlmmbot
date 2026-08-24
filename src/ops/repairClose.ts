import { Connection, PublicKey } from "@solana/web3.js";
import { SOL_MINT } from "../config.js";

/**
 * Recover close proceeds that a swap-confirm timeout hid from the ledger.
 *
 * A below-range exit's value is the Jupiter swap, not the remove-liquidity tx.
 * Until the fix in jupiter.ts, a swap whose confirm timed out was reported to
 * the close as "no swap happened" even when the ladder had already proved it
 * landed — so its SOL never entered close_return_sol and the token side booked
 * as a total loss (pos#104 PUMP, 2026-08-24: 0.695 SOL missing, -88.8% on a
 * roughly flat position, daily circuit breaker tripped one second later).
 *
 * This repairs the rows that bug already wrote. It reads the chain and never
 * trusts the ledger: a leg counts only if the wallet actually sold that
 * position's token for SOL in a transaction the close did not book.
 */
export interface UnbookedLeg {
  signature: string;
  blockTime: number;
  solDelta: number;
  tokenDelta: number;
}

/**
 * An unbooked exit leg SOLD the position's token FOR SOL. Both directions are
 * required: a tx that only credits SOL is a rent reclaim or a claim (already
 * accounted elsewhere), and one that only moves tokens is a transfer, not a
 * sale. Requiring both is what keeps this from inventing recoveries.
 */
export function isUnbookedExitLeg(tokenDelta: number, solDelta: number): boolean {
  return tokenDelta < 0 && solDelta > 0;
}

/** Wallet's native + wSOL change, and its change in `mint`, for one parsed tx. */
export function walletDeltas(
  meta: {
    preBalances: number[]; postBalances: number[];
    preTokenBalances?: Array<{ owner?: string; mint: string; uiTokenAmount: { uiAmount: number | null } }> | null;
    postTokenBalances?: Array<{ owner?: string; mint: string; uiTokenAmount: { uiAmount: number | null } }> | null;
  },
  accountKeys: string[],
  wallet: string,
  mint: string,
): { solDelta: number; tokenDelta: number } {
  const i = accountKeys.indexOf(wallet);
  let solDelta = i >= 0 ? (meta.postBalances[i]! - meta.preBalances[i]!) / 1e9 : 0;
  let tokenDelta = 0;
  const walk = (rows: typeof meta.preTokenBalances, sign: number) => {
    for (const b of rows ?? []) {
      if (b.owner !== wallet) continue;
      const amt = sign * (b.uiTokenAmount.uiAmount ?? 0);
      if (b.mint === SOL_MINT) solDelta += amt;        // wSOL is SOL
      else if (b.mint === mint) tokenDelta += amt;
    }
  };
  walk(meta.preTokenBalances, -1);
  walk(meta.postTokenBalances, +1);
  return { solDelta, tokenDelta };
}

/** Seconds either side of the recorded exit_ts to search. */
const WINDOW_S = 900;
/** Pacing between getParsedTransaction calls — this runs while the RPC is sore. */
const PACE_MS = 400;

export async function findUnbookedExitLegs(
  connection: Connection,
  wallet: PublicKey,
  mint: string,
  exitTs: number,
  knownSigs: Set<string>,
): Promise<UnbookedLeg[]> {
  const sigs = (await connection.getSignaturesForAddress(wallet, { limit: 200 }))
    .filter((s) => s.blockTime != null && Math.abs(s.blockTime - exitTs) <= WINDOW_S)
    .filter((s) => !knownSigs.has(s.signature) && !s.err);
  const legs: UnbookedLeg[] = [];
  for (const s of sigs) {
    await new Promise((r) => setTimeout(r, PACE_MS));
    const tx = await connection.getParsedTransaction(s.signature, {
      commitment: "confirmed", maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta) continue;
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
    const { solDelta, tokenDelta } = walletDeltas(tx.meta, keys, wallet.toBase58(), mint);
    if (isUnbookedExitLeg(tokenDelta, solDelta)) {
      legs.push({ signature: s.signature, blockTime: s.blockTime!, solDelta, tokenDelta });
    }
  }
  return legs;
}
