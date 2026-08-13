#!/bin/bash
cd /home/gizmo/meteora-farmer
node <<'NODE'
const { createRequire } = require("module");
const { resolve } = require("path");
const req = createRequire(resolve("package.json"));
req("dotenv").config({ path: ".env" });
const { Connection, PublicKey } = req("@solana/web3.js");
const Database = req("better-sqlite3");
const dlmmMod = req("@meteora-ag/dlmm");
const DLMM = dlmmMod.default ?? dlmmMod;

const wallet = new PublicKey("9DTThTbggnp2P2ZGLFRfN1A3j5JUsXez1dRJak3TixB2");
const c = new Connection(process.env.RPC_URL || process.env.HELIUS_RPC || process.env.SOLANA_RPC, "confirmed");
const db = new Database("data/farmer.db", { readonly: true });

(async () => {
  const chainMap = await DLMM.getAllLbPairPositionsByUser(c, wallet);
  const chain = [];
  for (const [lbPair, info] of chainMap) {
    const positions = info.lbPairPositionsData ?? [];
    for (const p of positions) {
      const x = Number(p.positionData.totalXAmount);
      const y = Number(p.positionData.totalYAmount);
      const feeX = Number(p.positionData.feeX?.toString?.() ?? p.positionData.feeX);
      const feeY = Number(p.positionData.feeY?.toString?.() ?? p.positionData.feeY);
      chain.push({
        pool: lbPair.toString(),
        pos: p.publicKey.toBase58(),
        lower: p.positionData.lowerBinId,
        upper: p.positionData.upperBinId,
        x, y, feeX, feeY,
        empty: x === 0 && y === 0 && feeX === 0 && feeY === 0,
        mintX: info.tokenX?.publicKey?.toString?.() ?? null,
      });
    }
  }
  console.log("CHAIN_POSITIONS", chain.length);
  console.log(JSON.stringify(chain, null, 2));

  const dbOpen = db.prepare(`SELECT id,symbol,state,pool,entry_sol,open_cost_sol FROM positions WHERE mode='live' AND state='open'`).all();
  const dbClosed = db.prepare(`SELECT id,symbol,state,exit_reason,pool,
    round(entry_sol,4) entry, round(exit_sol,4) exit,
    round(open_cost_sol,4) oc, round(close_return_sol,4) cr,
    round(fees_measured_sol,4) fm, round(recovered_sol,4) rec,
    round(CASE WHEN open_cost_sol IS NOT NULL AND close_return_sol IS NOT NULL
      THEN close_return_sol+fees_measured_sol+recovered_sol-open_cost_sol
      WHEN entry_sol>0 THEN exit_sol-entry_sol+fees_claimed_sol ELSE 0 END,4) pnl
    FROM positions WHERE mode='live' AND exit_ts IS NOT NULL ORDER BY exit_ts DESC LIMIT 20`).all();
  const accts = db.prepare(`SELECT pa.position_id, pa.pubkey, p.symbol, p.state FROM position_accounts pa JOIN positions p ON p.id=pa.position_id`).all();

  console.log("\nDB_OPEN", JSON.stringify(dbOpen, null, 2));
  console.log("\nDB_ACCOUNTS", JSON.stringify(accts, null, 2));
  console.log("\nDB_RECENT_CLOSED", JSON.stringify(dbClosed, null, 2));

  // Match chain pubkeys to DB
  const byPk = new Map(accts.map(a => [a.pubkey, a]));
  for (const ch of chain) {
    const hit = byPk.get(ch.pos);
    console.log("MATCH", ch.pos.slice(0,8), hit ? `#${hit.position_id} ${hit.symbol} ${hit.state}` : "UNTRACKED", ch.empty ? "EMPTY" : `y=${ch.y/1e9}`);
  }

  // Wallet SOL + notable token balances
  const bal = await c.getBalance(wallet);
  console.log("\nWALLET_SOL", bal/1e9);
  const baseline = db.prepare("SELECT value FROM meta WHERE key='baseline_sol_live'").get();
  console.log("BASELINE", baseline?.value);

  // Sum measured book
  const book = db.prepare(`SELECT COUNT(*) n,
    ROUND(SUM(CASE WHEN open_cost_sol IS NOT NULL AND close_return_sol IS NOT NULL
      THEN close_return_sol+fees_measured_sol+recovered_sol-open_cost_sol
      WHEN entry_sol>0 THEN exit_sol-entry_sol+fees_claimed_sol ELSE 0 END),6) pnl,
    ROUND(SUM(open_cost_sol),6) oc, ROUND(SUM(close_return_sol),6) cr,
    ROUND(SUM(fees_measured_sol),6) fm, ROUND(SUM(recovered_sol),6) rec
    FROM positions WHERE mode='live' AND exit_ts IS NOT NULL`).get();
  console.log("BOOK", book);
})().catch(e => { console.error(e); process.exit(1); });
NODE
