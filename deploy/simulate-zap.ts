#!/usr/bin/env tsx
/**
 * Dry-run Zap SDK path: Jupiter V6 quote → build tx → RPC simulate.
 * No funds move. Requires JUPITER_API_KEY and RPC_URL in .env.
 *
 *   npx tsx deploy/simulate-zap.ts
 *   npx tsx deploy/simulate-zap.ts --mint <token_mint> --amount-raw 1000000
 */
import BN from "bn.js";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  buildJupiterSwapTransaction,
  DEFAULT_JUPITER_API_URL,
  getJupiterQuote,
} from "@meteora-ag/zap-sdk";
import { env, SOL_MINT } from "../src/config.js";
import { fetchPool } from "../src/scanner/meteora.js";
import { loadKeypair } from "../src/executor/wallet.js";
import { zapSlippageTiers, zapToSol } from "../src/executor/zap.js";

const DEFAULT_POOL = "HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh"; // PUMP-SOL whitelist seed
const RPC_TIMEOUT_MS = 20_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function zapConfig() {
  return {
    jupiterApiUrl: DEFAULT_JUPITER_API_URL,
    jupiterApiKey: env().jupiterApiKey ?? "",
  };
}

async function main() {
  const key = env().jupiterApiKey;
  if (!key) {
    console.error("FAIL: JUPITER_API_KEY missing — set it in .env");
    process.exit(1);
  }
  console.log(`Jupiter API: ${DEFAULT_JUPITER_API_URL} (key present, ${key.length} chars)`);

  let mint = arg("--mint");
  if (!mint) {
    const pool = await fetchPool(DEFAULT_POOL);
    if (!pool) {
      console.error(`FAIL: could not fetch pool ${DEFAULT_POOL}`);
      process.exit(1);
    }
    mint = pool.mintX;
    console.log(`Pool: ${pool.name} (${DEFAULT_POOL})`);
  }

  const amountRaw = BigInt(arg("--amount-raw") ?? "1000000"); // ~1M base units — quote/sim only
  const slippageBps = Number(arg("--slippage-bps") ?? "300");
  console.log(`Mint: ${mint}`);
  console.log(`Amount raw: ${amountRaw}  slippage: ${slippageBps} bps`);

  const cfg = zapConfig();
  const inputMint = new PublicKey(mint);
  const outputMint = new PublicKey(SOL_MINT);

  // 1) Quote
  const quote = await getJupiterQuote(
    inputMint, outputMint, new BN(amountRaw.toString()),
    40, slippageBps, false, true, true, false, cfg,
  );
  if (!quote) {
    console.error("FAIL: getJupiterQuote returned null");
    process.exit(1);
  }
  const outSol = Number(quote.outAmount) / 1e9;
  console.log(`\n[1] Quote OK — out ~${outSol.toFixed(6)} SOL (route ${quote.routePlan?.length ?? "?"} hops)`);

  // 2) Build tx — use live wallet if configured, else ephemeral pubkey (sim only)
  let wallet: import("@solana/web3.js").Keypair;
  let walletNote: string;
  try {
    wallet = loadKeypair(env().walletPrivateKey, env().walletKeypairPath);
    walletNote = wallet.publicKey.toBase58();
  } catch {
    wallet = Keypair.generate();
    walletNote = `${wallet.publicKey.toBase58()} (ephemeral — sim only)`;
  }
  console.log(`Wallet: ${walletNote}`);

  const { transaction, quoteResponse } = await buildJupiterSwapTransaction(
    wallet.publicKey, inputMint, outputMint,
    new BN(amountRaw.toString()), 40, slippageBps, quote, cfg,
  );
  console.log(`[2] Build OK — ${transaction.instructions.length} ix, quoted out ${Number(quoteResponse.outAmount) / 1e9} SOL`);

  // 3) RPC simulate (unsigned ok with sigVerify: false)
  const connection = new Connection(env().rpcUrl, {
    commitment: "confirmed",
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }),
  });
  transaction.feePayer = wallet.publicKey;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash;

  const sim = await connection.simulateTransaction(transaction, undefined, false);
  const err = sim.value.err;
  const logs = sim.value.logs ?? [];
  const interesting = logs.filter((l) => /error|insufficient|failed|success|swap/i.test(l)).slice(-8);

  if (err === null) {
    console.log(`[3] Simulate OK — units ${sim.value.unitsConsumed ?? "?"}`);
    if (interesting.length) console.log("    logs:", interesting.join("\n         "));
  } else {
    const errStr = JSON.stringify(err);
    // No token balance in wallet is fine — proves route + ix layout are valid
    const acceptable = /InsufficientFunds|insufficient|AccountNotFound|0x1/i.test(errStr + logs.join(" "));
    console.log(`[3] Simulate err: ${errStr}`);
    if (interesting.length) console.log("    logs:", interesting.join("\n         "));
    if (!acceptable) {
      console.error("FAIL: unexpected simulation error");
      process.exit(1);
    }
    console.log("    (acceptable — wallet likely has no input token; quote+build path is valid)");
  }

  // 4) Exercise zap.ts wrapper with simulate-only send
  let simSig = 0;
  const simSend = async (tx: Transaction) => {
    tx.feePayer = wallet.publicKey;
    const { blockhash: bh } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = bh;
    const r = await connection.simulateTransaction(tx, undefined, false);
    if (r.value.err && !/InsufficientFunds|insufficient|AccountNotFound|0x1/i.test(JSON.stringify(r.value.err) + (r.value.logs ?? []).join(" "))) {
      throw new Error(`zap wrapper sim failed: ${JSON.stringify(r.value.err)}`);
    }
    return `simulated-${++simSig}`;
  };

  const zapRes = await zapToSol(wallet, mint, amountRaw, slippageBps, simSend);
  if (!zapRes) {
    console.error("FAIL: zapToSol returned null");
    process.exit(1);
  }
  console.log(`\n[4] zap.ts wrapper OK — tiers ${zapSlippageTiers(slippageBps).join(", ")} bps`);
  console.log("\nPASS: Zap SDK simulation complete (no tx sent)");
}

main().catch((e) => {
  console.error("FAIL:", (e as Error).message);
  process.exit(1);
});
