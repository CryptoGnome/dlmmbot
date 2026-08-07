import { Connection, PublicKey } from "@solana/web3.js";
import { createRequire } from "node:module";

// Load the SDK's CJS build via require: its ESM build does
// `import { BN } from '@coral-xyz/anchor'` which crashes under Node's ESM
// loader (anchor is CJS, no named exports). Class is default-only-exported,
// which TS interop mangles — type the static surface we use structurally.
interface ChainPositionInfo {
  tokenX: { publicKey: PublicKey };
  lbPairPositionsData?: Array<{ positionData: { lowerBinId: number; upperBinId: number } }>;
}
interface DlmmStatic {
  getAllLbPairPositionsByUser(connection: Connection, user: PublicKey): Promise<Map<string, ChainPositionInfo>>;
}
const dlmmMod = createRequire(import.meta.url)("@meteora-ag/dlmm") as { default?: DlmmStatic } & DlmmStatic;
const DLMM: DlmmStatic = dlmmMod.default ?? dlmmMod;
import { getDb, now } from "../db/db.js";
import { alert } from "../alerts.js";

// Startup reconciliation (§7): the CHAIN is the source of truth for live
// positions, not our DB. Run before the manager loop touches anything in live
// mode. Two failure classes:
//   1. DB says open, chain has nothing  -> crashed mid-close or external close.
//      Mark closed_manual (exit values unknown -> flagged for review).
//   2. Chain has a position we don't track -> crashed mid-open or manual UI
//      action. Adopt it as an open row so the manager takes over.
// Paper mode: nothing on chain by definition; this is a no-op.

export interface ReconcileReport {
  dbOpen: number;
  chainPositions: number;
  orphanedInDb: string[];  // marked closed_manual
  adopted: string[];       // inserted as open
}

export async function reconcileLive(connection: Connection, wallet: PublicKey): Promise<ReconcileReport> {
  const db = getDb();
  const dbOpen = db.prepare(
    "SELECT id, pool, token_mint, symbol FROM positions WHERE mode='live' AND state IN ('open','pending','closing')"
  ).all() as Array<{ id: number; pool: string; token_mint: string; symbol: string }>;

  // All DLMM positions owned by the wallet, grouped by lbPair.
  const chainMap = await DLMM.getAllLbPairPositionsByUser(connection, wallet);
  const chainPools = new Set<string>();
  for (const [lbPair] of chainMap) chainPools.add(lbPair.toString());

  const report: ReconcileReport = {
    dbOpen: dbOpen.length,
    chainPositions: chainPools.size,
    orphanedInDb: [],
    adopted: [],
  };

  // 1. DB-open rows with no on-chain backing.
  for (const row of dbOpen) {
    if (!chainPools.has(row.pool)) {
      db.prepare(
        "UPDATE positions SET state='closed_manual', exit_ts=?, exit_reason='manual' WHERE id=?"
      ).run(now(), row.id);
      db.prepare(
        "INSERT INTO events (position_id, ts, type, detail_json) VALUES (?, ?, 'withdraw', ?)"
      ).run(row.id, now(), JSON.stringify({ reconcile: "db_open_but_not_on_chain — exit values unknown, review manually" }));
      report.orphanedInDb.push(`${row.symbol} pos#${row.id}`);
    }
  }

  // 2. On-chain positions the DB doesn't know about -> adopt.
  const dbPools = new Set(dbOpen.map((r) => r.pool));
  for (const [lbPairKey, info] of chainMap) {
    const poolAddr = lbPairKey.toString();
    if (dbPools.has(poolAddr)) continue;
    const positions = info.lbPairPositionsData ?? [];
    if (positions.length === 0) continue;
    // Bin range across all position accounts on this pair.
    let minBin = Number.MAX_SAFE_INTEGER, maxBin = Number.MIN_SAFE_INTEGER;
    for (const pos of positions) {
      minBin = Math.min(minBin, pos.positionData.lowerBinId);
      maxBin = Math.max(maxBin, pos.positionData.upperBinId);
    }
    const res = db.prepare(
      `INSERT INTO positions (mode, pool, token_mint, symbol, entry_ts, entry_price, entry_sol,
        min_bin_id, max_bin_id, state)
       VALUES ('live', ?, ?, ?, ?, 0, 0, ?, ?, 'open')`
    ).run(poolAddr, info.tokenX.publicKey.toString(), "ADOPTED", now(), minBin, maxBin);
    db.prepare(
      "INSERT INTO events (position_id, ts, type, detail_json) VALUES (?, ?, 'open', ?)"
    ).run(Number(res.lastInsertRowid), now(), JSON.stringify({ reconcile: "adopted_from_chain — entry price/size unknown, PnL from adoption point" }));
    report.adopted.push(poolAddr);
  }

  if (report.orphanedInDb.length || report.adopted.length) {
    await alert(
      "info",
      `reconcile: ${report.orphanedInDb.length} DB-open orphans closed (${report.orphanedInDb.join(", ") || "-"}), ` +
      `${report.adopted.length} chain positions adopted`
    );
  }
  return report;
}
