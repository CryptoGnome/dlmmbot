import BN from "bn.js";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { buildJupiterSwapTransaction, DEFAULT_JUPITER_API_URL } from "@meteora-ag/zap-sdk";
import { env, SOL_MINT } from "../config.js";

const MAX_JUPITER_ACCOUNTS = 40;

function zapConfig() {
  return {
    jupiterApiUrl: DEFAULT_JUPITER_API_URL,
    jupiterApiKey: env().jupiterApiKey ?? "",
  };
}

/** Slippage tiers shared with manual Jupiter path. */
export function zapSlippageTiers(baseSlippageBps: number): number[] {
  return [...new Set([baseSlippageBps, Math.min(Math.max(baseSlippageBps * 3, 300), 1500), 1500])]
    .sort((a, b) => a - b);
}

/** Token → SOL via Meteora Zap SDK (Jupiter V6 swap-instruction API). */
export async function zapToSol(
  wallet: Keypair,
  inputMint: string,
  amountRaw: bigint,
  slippageBps: number,
  sendTx: (tx: Transaction) => Promise<string>,
): Promise<{ outLamports: number; signature: string } | null> {
  if (amountRaw <= 0n || inputMint === SOL_MINT) return null;
  const { transaction, quoteResponse } = await buildJupiterSwapTransaction(
    wallet.publicKey,
    new PublicKey(inputMint),
    new PublicKey(SOL_MINT),
    new BN(amountRaw.toString()),
    MAX_JUPITER_ACCOUNTS,
    slippageBps,
    undefined,
    zapConfig(),
  );
  const signature = await sendTx(transaction);
  return { outLamports: Number(quoteResponse.outAmount), signature };
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
