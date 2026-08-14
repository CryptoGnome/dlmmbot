import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { config, env, SOL_MINT } from "../config.js";

// Jupiter swap client (REST v1): quote -> swap tx -> sign -> send. Used to
// bank token-side fees and zap exits back to SOL. UNTESTED IN LIVE until the
// first funded run — start with dust-sized swaps.

interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  [k: string]: unknown;
}

type IxPayload = {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
};

function deserializeIx(ix: IxPayload): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}

async function lookupTables(
  connection: Connection,
  keys: string[],
): Promise<AddressLookupTableAccount[]> {
  if (!keys.length) return [];
  const infos = await connection.getMultipleAccountsInfo(keys.map((k) => new PublicKey(k)));
  const out: AddressLookupTableAccount[] = [];
  for (let i = 0; i < keys.length; i++) {
    const info = infos[i];
    const key = keys[i];
    if (!info || !key) continue;
    out.push(
      new AddressLookupTableAccount({
        key: new PublicKey(key),
        state: AddressLookupTableAccount.deserialize(info.data),
      }),
    );
  }
  return out;
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

/** Swap `lamports` of SOL to `outputMint`. Returns raw token out (from quote) + signature. */
export async function swapFromSol(
  connection: Connection,
  wallet: Keypair,
  outputMint: string,
  lamports: bigint,
  slippageBps: number,
): Promise<{ outAmountRaw: bigint; signature: string } | null> {
  if (lamports <= 0n || outputMint === SOL_MINT) return null;
  const built = await buildSwapFromSolTx(connection, wallet, outputMint, lamports, slippageBps);
  if (!built) return null;
  const signature = await connection.sendRawTransaction(built.tx.serialize(), { maxRetries: 3 });
  await connection.confirmTransaction(signature, "confirmed");
  return { outAmountRaw: built.minOutRaw, signature };
}

/**
 * Quote + `/swap-instructions`, then append `extraIxs(minOutRaw)` (e.g. burn) in the same v0 tx.
 * `minOutRaw` is Jupiter's otherAmountThreshold (safe to burn after the swap ix).
 */
export async function buildSwapFromSolTx(
  connection: Connection,
  wallet: Keypair,
  outputMint: string,
  lamports: bigint,
  slippageBps: number,
  extraIxs: (minOutRaw: bigint) => TransactionInstruction[] = () => [],
): Promise<{ tx: VersionedTransaction; minOutRaw: bigint; outAmountRaw: bigint } | null> {
  if (lamports <= 0n || outputMint === SOL_MINT) return null;
  const base = config().apis.jupiter_quote;

  // Leave room for burn (+ optional pre-burn) accounts in the v0 message.
  const quoteRes = await fetch(
    `${base}/quote?inputMint=${SOL_MINT}&outputMint=${outputMint}&amount=${lamports}&slippageBps=${slippageBps}&maxAccounts=54`,
    { headers: headers(), signal: AbortSignal.timeout(15_000) },
  );
  if (!quoteRes.ok) throw new Error(`jupiter quote HTTP ${quoteRes.status}`);
  const quote = (await quoteRes.json()) as QuoteResponse;
  const minOutRaw = BigInt(quote.otherAmountThreshold ?? quote.outAmount);
  if (minOutRaw <= 0n) return null;

  const swapRes = await fetch(`${base}/swap-instructions`, {
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
  if (!swapRes.ok) throw new Error(`jupiter swap-instructions HTTP ${swapRes.status}`);
  const body = (await swapRes.json()) as {
    error?: string;
    computeBudgetInstructions?: IxPayload[];
    setupInstructions?: IxPayload[];
    swapInstruction?: IxPayload;
    cleanupInstruction?: IxPayload | null;
    addressLookupTableAddresses?: string[];
  };
  if (body.error || !body.swapInstruction) {
    throw new Error(`jupiter swap-instructions: ${body.error ?? "missing swapInstruction"}`);
  }

  const ixs: TransactionInstruction[] = [
    ...(body.computeBudgetInstructions ?? []).map(deserializeIx),
    ...(body.setupInstructions ?? []).map(deserializeIx),
    deserializeIx(body.swapInstruction),
    ...(body.cleanupInstruction ? [deserializeIx(body.cleanupInstruction)] : []),
    ...extraIxs(minOutRaw),
  ];
  const alts = await lookupTables(connection, body.addressLookupTableAddresses ?? []);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);
  return { tx, minOutRaw, outAmountRaw: BigInt(quote.outAmount) };
}

/** Quote-only: lamports of SOL `amountRaw` of `inputMint` would fetch, or null if unquotable. */
export async function quoteToSolLamports(inputMint: string, amountRaw: bigint): Promise<number | null> {
  if (amountRaw <= 0n || inputMint === SOL_MINT) return null;
  const base = config().apis.jupiter_quote;
  try {
    const res = await fetch(
      `${base}/quote?inputMint=${inputMint}&outputMint=${SOL_MINT}&amount=${amountRaw}&slippageBps=300`,
      { headers: headers(), signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) return null;
    const quote = (await res.json()) as QuoteResponse;
    return Number(quote.outAmount);
  } catch {
    return null;
  }
}

/**
 * swapToSol with escalating slippage. Exit quotes race a moving price — a
 * tight-slippage failure (0x1771) at close time strands the token side in the
 * wallet, so retry looser before giving up (claudius pos#9, 2026-08-08).
 */
export async function swapToSolEscalating(
  connection: Connection,
  wallet: Keypair,
  inputMint: string,
  amountRaw: bigint,
  baseSlippageBps: number
): Promise<{ outLamports: number; signature: string } | null> {
  if (amountRaw <= 0n || inputMint === SOL_MINT) return null;
  const tiers = [...new Set([baseSlippageBps, Math.min(Math.max(baseSlippageBps * 3, 300), 1500), 1500])]
    .sort((a, b) => a - b);
  let lastErr: unknown;
  for (const bps of tiers) {
    try {
      return await swapToSol(connection, wallet, inputMint, amountRaw, bps);
    } catch (e) {
      lastErr = e;
      console.error(`[live] swap @${bps}bps failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  throw lastErr;
}
