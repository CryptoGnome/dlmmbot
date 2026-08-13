#!/usr/bin/env npx tsx
/**
 * Repair K #60:
 * 1) fees_measured was inflated by ~0.605 SOL (Niles wSOL unwrap during claim)
 * 2) reclaim empty position rent into close_return_sol
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

const POS_ID = 60;
const POS_PK = "FtWaXaGnZPAr4LZpRUv4TvnU5rE2PQsmotcqdMJ5pWpi";
const CLAIM_EVENT_ID = 150;
const FIXED_FM = 0.054384362;
const WAS_FM = 0.659326128;

const rpc = process.env.RPC_URL || process.env.HELIUS_RPC || process.env.SOLANA_RPC!;
const connection = new Connection(rpc, "confirmed");
const wallet = loadKeypair(env().walletPrivateKey, env().walletKeypairPath);
const db = new Database("data/farmer.db");

type Done = { feesFixed?: boolean; rentSol?: number; rentSig?: string };
function readDone(): Done {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get("repair_k_60") as { value: string } | undefined;
  return row ? JSON.parse(row.value) as Done : {};
}
function writeDone(d: Done) {
  db.prepare("INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run("repair_k_60", JSON.stringify(d));
}

async function wealthOfSig(sig: string): Promise<number> {
  let tx = null;
  for (let i = 0; i < 10 && !tx?.meta; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000));
    tx = await connection.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  }
  if (!tx?.meta) throw new Error(`tx ${sig} missing`);
  const d = wealthDeltaLamports(tx.meta, tx.transaction.message.accountKeys, wallet.publicKey);
  if (d == null) throw new Error("wallet absent");
  return d / 1e9;
}

async function main() {
  const done = readDone();
  const poolAddr = (db.prepare("SELECT pool FROM positions WHERE id=?").get(POS_ID) as { pool: string }).pool;

  if (!done.feesFixed) {
    db.prepare("UPDATE positions SET fees_measured_sol = ? WHERE id = ?").run(FIXED_FM, POS_ID);
    db.prepare(
      `UPDATE events SET detail_json = json_set(COALESCE(detail_json,'{}'), '$.measuredSol', ?, '$.measuredSol_repaired', 1, '$.measuredSol_was', ?)
       WHERE id = ?`,
    ).run(FIXED_FM, WAS_FM, CLAIM_EVENT_ID);
    done.feesFixed = true;
    writeDone(done);
    console.log(`fees_measured ${WAS_FM} → ${FIXED_FM}`);
  }

  if (done.rentSol == null) {
    const ai = await connection.getAccountInfo(new PublicKey(POS_PK));
    if (ai) {
      console.log(`closing empty K shell (${ai.lamports / 1e9} SOL)...`);
      const pool = await DLMM.create(connection, new PublicKey(poolAddr));
      await pool.refetchStates();
      const { userPositions } = await pool.getPositionsByUserAndLbPair(wallet.publicKey);
      const lb = userPositions.find((p: { publicKey: PublicKey }) => p.publicKey.toBase58() === POS_PK);
      if (!lb) throw new Error("SDK missing position");
      const tx = await pool.closePositionIfEmpty({ owner: wallet.publicKey, position: lb });
      const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: "confirmed" });
      done.rentSig = sig;
      done.rentSol = await wealthOfSig(sig);
      console.log(`rent reclaim ${sig} → ${done.rentSol}`);
    } else {
      done.rentSol = 0;
      console.log("K position account already gone");
    }
    writeDone(done);
  }

  db.prepare("UPDATE positions SET close_return_sol = ? WHERE id = ?").run(done.rentSol ?? 0, POS_ID);
  db.prepare("DELETE FROM position_accounts WHERE position_id = ? AND pubkey = ?").run(POS_ID, POS_PK);

  const out = db.prepare(`
    SELECT id, symbol, state,
      round(open_cost_sol,4) oc, round(close_return_sol,4) cr,
      round(fees_measured_sol,4) fm, round(recovered_sol,4) rec,
      round(close_return_sol+fees_measured_sol+recovered_sol-open_cost_sol,4) realized,
      round(exit_sol-entry_sol+fees_claimed_sol,4) marked
    FROM positions WHERE id=?`).get(POS_ID);
  console.log("REPAIRED", out);

  const book = db.prepare(`
    SELECT COUNT(*) n,
      ROUND(SUM(CASE WHEN open_cost_sol IS NOT NULL AND close_return_sol IS NOT NULL
        THEN close_return_sol+fees_measured_sol+recovered_sol-open_cost_sol
        WHEN entry_sol>0 THEN exit_sol-entry_sol+fees_claimed_sol ELSE 0 END),6) measured
    FROM positions WHERE mode='live' AND exit_ts IS NOT NULL`).get();
  console.log("BOOK", book);
}

main().catch((e) => { console.error(e); process.exit(1); });
