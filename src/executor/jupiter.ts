import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { config, env, SOL_MINT } from "../config.js";

// Jupiter swap client (REST v1): quote -> swap tx -> sign -> send. Used to
// bank token-side fees and zap exits back to SOL. UNTESTED IN LIVE until the
// first funded run — start with dust-sized swaps.

interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  [k: string]: unknown;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const key = env().jupiterApiKey;
  if (key) h["x-api-key"] = key;
  return h;
}

/** Swap `amountRaw` of `inputMint` to SOL. Returns lamports received (per quote) and signature. */
export async function swapToSol(
  connection: Connection,
  wallet: Keypair,
  inputMint: string,
  amountRaw: bigint,
  slippageBps: number
): Promise<{ outLamports: number; signature: string } | null> {
  if (amountRaw <= 0n || inputMint === SOL_MINT) return null;
  const base = config().apis.jupiter_quote;

  const quoteRes = await fetch(
    `${base}/quote?inputMint=${inputMint}&outputMint=${SOL_MINT}&amount=${amountRaw}&slippageBps=${slippageBps}`,
    { headers: headers(), signal: AbortSignal.timeout(15_000) }
  );
  if (!quoteRes.ok) throw new Error(`jupiter quote HTTP ${quoteRes.status}`);
  const quote = (await quoteRes.json()) as QuoteResponse;

  const swapRes = await fetch(`${base}/swap`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!swapRes.ok) throw new Error(`jupiter swap HTTP ${swapRes.status}`);
  const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([wallet]);
  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await connection.confirmTransaction(signature, "confirmed");
  return { outLamports: Number(quote.outAmount), signature };
}
