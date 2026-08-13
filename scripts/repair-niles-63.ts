#!/usr/bin/env npx tsx
/**
 * One-shot repair for Niles #63 empty shell + mis-measured recovered_sol.
 * Idempotent via meta.repair_niles_63.
 */
import { Connection, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env" });

const req = createRequire(resolve("package.json"));
const Database = req("better-sqlite3");
const dlmmMod = req("@meteora-ag/dlmm");
const DLMM = dlmmMod.default ?? dlmmMod;
const { loadKeypair } = await import("../src/executor/wallet.ts");
const { wealthDeltaLamports } = await import("../src/executor/live.ts");
const { env } = await import("../src/config.ts");

const POS_ID = 63;
const POS_PK = "C5nznAu11PqVfPAG5oDD1R12X7MRn41Q2BLeYYPL29oX";
const POOL = "GgVsJADZr5e9vPgkRmTkCAUfttgTiQHvAdHrw4rtYUdp";
const NILES = "GDPtXowyiXHjsHXgkwM1erpFufPEeNvqK8iGq71Bpump";

const rpc = process.env.RPC_URL || process.env.HELIUS_RPC || process.env.SOLANA_RPC;
if (!rpc) throw new Error("RPC_URL missing");
const connection = new Connection(rpc, "confirmed");
const wallet = loadKeypair(env().walletPrivateKey, env().walletKeypairPath);
const db = new Database("data/farmer.db");

type Done = { rentSol?: number; rentSig?: string; recoveredFix?: number; sweepSig?: string };

function readDone(): Done {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("repair_niles_63") as { value: string } | undefined;
  return row ? JSON.parse(row.value) as Done : {};
}
function writeDone(d: Done) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run("repair_niles_63", JSON.stringify(d));
}

async function wealthOfSig(sig: string): Promise<number> {
  let tx = null;
  for (let i = 0; i < 8 && !tx?.meta; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1000));
    tx = await connection.getParsedTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  }
  if (!tx?.meta) throw new Error(`tx ${sig} not found`);
  const d = wealthDeltaLamports(tx.meta, tx.transaction.message.accountKeys, wallet.publicKey);
  if (d === null) throw new Error(`wallet absent from ${sig}`);
  return d / 1e9;
}

async function findSweepSig(): Promise<string> {
  const wSigs = await connection.getSignaturesForAddress(wallet.publicKey, { limit: 40 });
  for (const s of wSigs) {
    if (!s.blockTime || s.blockTime < 1786635600 || s.blockTime > 1786636200) continue;
    const tx = await connection.getTransaction(s.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    const logs = tx?.meta?.logMessages ?? [];
    if (!logs.some((l) => /Instruction: Sell/.test(l))) continue;
    const hasNiles = (tx?.meta?.preTokenBalances ?? []).some(
      (b) => b.mint === NILES && b.owner === wallet.publicKey.toBase58(),
    );
    if (hasNiles) return s.signature;
  }
  throw new Error("sweep sig not found");
}

async function main() {
  const done = readDone();

  if (done.rentSol == null) {
    const posInfo = await connection.getAccountInfo(new PublicKey(POS_PK));
    if (posInfo) {
      console.log(`closing empty position (${posInfo.lamports / 1e9} SOL rent)...`);
      const pool = await DLMM.create(connection, new PublicKey(POOL));
      await pool.refetchStates();
      const { userPositions } = await pool.getPositionsByUserAndLbPair(wallet.publicKey);
      const lb = userPositions.find((p: { publicKey: PublicKey }) => p.publicKey.toBase58() === POS_PK);
      if (!lb) throw new Error("position account exists but SDK did not return it");
      const tx = await pool.closePositionIfEmpty({ owner: wallet.publicKey, position: lb });
      const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: "confirmed" });
      done.rentSig = sig;
      done.rentSol = await wealthOfSig(sig);
      console.log(`closed: ${sig} wealthΔ ${done.rentSol}`);
    } else {
      done.rentSol = 0;
      console.log("position account already gone");
    }
    writeDone(done);
  }

  if (done.recoveredFix == null) {
    const sweepSig = await findSweepSig();
    done.sweepSig = sweepSig;
    done.recoveredFix = await wealthOfSig(sweepSig);
    console.log(`sweep ${sweepSig.slice(0, 12)}… wealth ${done.recoveredFix}`);
    writeDone(done);
  }

  db.prepare(
    `UPDATE positions SET recovered_sol = ?, close_return_sol = ? WHERE id = ?`,
  ).run(done.recoveredFix, done.rentSol ?? 0, POS_ID);
  db.prepare("DELETE FROM position_accounts WHERE position_id = ? AND pubkey = ?").run(POS_ID, POS_PK);
  db.prepare(
    `UPDATE positions SET exit_reason = 'manual', state = 'closed_manual'
     WHERE id = 65 AND symbol = 'ADOPTED' AND entry_sol = 0`,
  ).run();

  const out = db.prepare(
    `SELECT id, symbol, state,
       round(open_cost_sol,6) oc, round(close_return_sol,6) cr,
       round(fees_measured_sol,6) fm, round(recovered_sol,6) rec,
       round(close_return_sol + fees_measured_sol + recovered_sol - open_cost_sol,6) AS realized
     FROM positions WHERE id = ?`,
  ).get(POS_ID);
  console.log("REPAIRED", out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
