import { Keypair, Transaction } from "@solana/web3.js";
import { buildSwapToSolIxs } from "./jupiter.js";
import { SOL_MINT } from "../config.js";

/**
 * Legacy transactions carry no address lookup tables, so the whole route has to
 * fit in the raw account list. 30 leaves headroom for the compute-budget
 * instructions `send()` adds on top.
 */
const MAX_JUPITER_ACCOUNTS = 30;

/** Slippage tiers shared with manual Jupiter path. */
export function zapSlippageTiers(baseSlippageBps: number): number[] {
  return [...new Set([baseSlippageBps, Math.min(Math.max(baseSlippageBps * 3, 300), 1500), 1500])]
    .sort((a, b) => a - b);
}

/**
 * Token → SOL, assembled from Jupiter's `/swap-instructions`.
 *
 * This used to go through @meteora-ag/zap-sdk's `buildJupiterSwapTransaction`,
 * which keeps ONLY the swap instruction and discards setup, cleanup, compute
 * budget and lookup tables. Dropping setup means the swap is handed an
 * uninitialised wSOL account and fails with 6025 `InvalidTokenAccount` — and
 * because `unwrapWsol()` closes that account after every exit, it was absent by
 * construction on the next close. Verified by simulating both shapes: swap-only
 * errors 6025, setup+swap succeeds.
 */
export async function zapToSol(
  wallet: Keypair,
  inputMint: string,
  amountRaw: bigint,
  slippageBps: number,
  sendTx: (tx: Transaction) => Promise<string>,
): Promise<{ outLamports: number; signature: string } | null> {
  if (amountRaw <= 0n || inputMint === SOL_MINT) return null;
  const built = await buildSwapToSolIxs(
    wallet.publicKey, inputMint, amountRaw, slippageBps, MAX_JUPITER_ACCOUNTS,
  );
  if (!built) return null;
  const tx = new Transaction();
  tx.feePayer = wallet.publicKey;
  for (const ix of built.ixs) tx.add(ix);
  const signature = await sendTx(tx);
  return { outLamports: Number(built.outAmountRaw), signature };
}

export async function zapToSolEscalating(
  wallet: Keypair,
  inputMint: string,
  amountRaw: bigint,
  baseSlippageBps: number,
  sendTx: (tx: Transaction) => Promise<string>,
): Promise<{ outLamports: number; signature: string } | null> {
  if (amountRaw <= 0n || inputMint === SOL_MINT) return null;
  let lastErr: unknown;
  for (const bps of zapSlippageTiers(baseSlippageBps)) {
    try {
      return await zapToSol(wallet, inputMint, amountRaw, bps, sendTx);
    } catch (e) {
      lastErr = e;
      console.error(`[live] zap swap @${bps}bps failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  throw lastErr;
}
