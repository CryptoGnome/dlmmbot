import { Connection, PublicKey } from "@solana/web3.js";
import { createRequire } from "node:module";

// Load the SDK's CJS build via require: its ESM build does
// `import { BN } from '@coral-xyz/anchor'` which crashes under Node's ESM
// loader (anchor is CJS, no named exports). Class is default-only-exported,
// which TS interop mangles — type the static surface we use structurally.
interface ChainPositionInfo {
  tokenX: { publicKey: PublicKey };
  lbPairPositionsData?: Array<{
    publicKey: PublicKey;
    positionData: {
      lowerBinId: number;
      upperBinId: number;
      totalXAmount: { toString(): string } | number | string;
      totalYAmount: { toString(): string } | number | string;
    };
  }>;
}
interface DlmmStatic {
  getAllLbPairPositionsByUser(connection: Connection, user: PublicKey): Promise<Map<string, ChainPositionInfo>>;
}
const dlmmMod = createRequire(import.meta.url)("@meteora-ag/dlmm") as { default?: DlmmStatic } & DlmmStatic;
const DLMM: DlmmStatic = dlmmMod.default ?? dlmmMod;
import { getDb, now } from "../db/db.js";
import { alert } from "../alerts.js";
import { openCostFromTxDeltas, strayChainAccounts } from "../executor/executor.js";
import { wealthDeltaLamports } from "../executor/live.js";

/**
 * What the wallet actually paid to open an on-chain position we have no row
 * for: the wallet delta of the tx that created each position account (its
 * oldest signature). Null when any of them cannot be read with certainty — the
 * manager then falls back to the first mark, as before. The first mark is a
 * poor basis (it includes fees already earned and price drift since the open:
 * pos#309 was booked at 0.629 against 0.471 paid), so it is the fallback only.
 */
export async function adoptedOpenCostSol(connection: Connection, wallet: PublicKey, accounts: PublicKey[]): Promise<number | null> {
  const PAGE = 1000;
  const deltas: Array<number | null> = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    try {
      const sigs = await connection.getSignaturesForAddress(account, { limit: PAGE }, "confirmed");
      const oldest = sigs[sigs.length - 1];
      // A full page means older signatures may exist, so "oldest" is not provably the creation tx.
      if (!oldest || oldest.err || sigs.length >= PAGE) { deltas.push(null); continue; }
      if (seen.has(oldest.signature)) continue;
      seen.add(oldest.signature);
      const tx = await connection.getParsedTransaction(oldest.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const lamports = tx?.meta ? wealthDeltaLamports(tx.meta, tx.transaction.message.accountKeys, wallet) : null;
      deltas.push(lamports === null ? null : lamports / 1e9);
    } catch {
      deltas.push(null);
    }
  }
  return openCostFromTxDeltas(deltas);
}

/**
 * Fold an on-chain position account the DB never recorded into the open row it
 * belongs to: track it, widen the row's bin range, and add what it holds to
 * the row's size and (when both are known) its measured cost. Without the
 * size, exposure and the stop-loss would be measured against the smaller
 * position; without the account, nothing would ever mark or close it.
 * Idempotent on the account address. Returns false when it was already tracked.
 */
export function attachAccountToPosition(
  positionId: number,
  account: { pubkey: string; minBin: number; maxBin: number },
  depositedSol: number,
  costSol: number,
): boolean {
  const db = getDb();
  let attached = false;
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM position_accounts WHERE pubkey = ?").get(account.pubkey)) return;
    db.prepare("INSERT INTO position_accounts (position_id, pubkey, min_bin_id, max_bin_id) VALUES (?, ?, ?, ?)")
      .run(positionId, account.pubkey, account.minBin, account.maxBin);
    db.prepare(
      `UPDATE positions SET min_bin_id = MIN(min_bin_id, ?), max_bin_id = MAX(max_bin_id, ?),
              entry_sol = entry_sol + ?,
              open_cost_sol = CASE WHEN open_cost_sol IS NULL THEN NULL ELSE open_cost_sol + ? END
        WHERE id = ?`
    ).run(account.minBin, account.maxBin, depositedSol, costSol, positionId);
    db.prepare("INSERT INTO events (position_id, ts, type, detail_json) VALUES (?, ?, 'open', ?)")
      .run(positionId, now(), JSON.stringify({ reconcile: "attached_stray_account", account: account.pubkey, depositedSol, costSol }));
    attached = true;
  }).immediate();
  return attached;
}

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

  // An empty chain read against a non-empty book is far more likely an RPC
  // fault than a genuinely empty wallet, and the loop below would write EVERY
  // open row to closed_manual with a NULL exit value on the strength of it.
  // Bail instead: a stuck row is recoverable on the next boot, a mass write-off
  // of live positions is not.
  if (chainMap.size === 0 && dbOpen.length > 0) {
    await alert("info",
      `reconcile: chain returned zero positions but the DB has ${dbOpen.length} open ` +
      `(${dbOpen.map((r) => `${r.symbol} pos#${r.id}`).join(", ")}) — refusing to orphan them. ` +
      `Likely a lagging or rate-limited RPC. Verify on chain before acting.`);
    return report;
  }

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
    if (dbPools.has(poolAddr)) {
      // The pool has an open row — but that does not mean every account in it
      // is tracked. A later account of a two-account open can land after
      // open() gave up on it ("tx fate unknown"), and skipping the whole pool
      // here left it unmanaged until the row closed AND the bot restarted.
      try {
        const chain = info.lbPairPositionsData ?? [];
        const openRows = db.prepare(
          "SELECT id, symbol FROM positions WHERE mode='live' AND pool = ? AND state IN ('open','pending','closing') ORDER BY entry_ts DESC, id DESC"
        ).all(poolAddr) as Array<{ id: number; symbol: string }>;
        const tracked = (ids: number[] | null) => new Set((db.prepare(
          ids === null
            ? "SELECT pubkey FROM position_accounts"
            : `SELECT pubkey FROM position_accounts WHERE position_id IN (${ids.map(() => "?").join(",") || "NULL"})`
        ).all(...(ids ?? [])) as Array<{ pubkey: string }>).map((r) => r.pubkey));
        const { attach, foreign } = strayChainAccounts(
          chain.map((p) => ({
            pubkey: p.publicKey.toString(),
            hasLiquidity: Number(p.positionData.totalXAmount) > 0 || Number(p.positionData.totalYAmount) > 0,
          })),
          tracked(openRows.map((r) => r.id)), tracked(null),
        );
        const target = openRows[0];
        for (const pubkey of attach) {
          const pos = chain.find((p) => p.publicKey.toString() === pubkey)!;
          const costSol = await adoptedOpenCostSol(connection, wallet, [pos.publicKey]);
          if (!target || costSol === null) {
            await alert("watchdog",
              `reconcile: funded position account ${pubkey} in pool ${poolAddr.slice(0, 8)}… is not tracked by any position ` +
              `and its open tx could not be read — NOT attached. It is unmanaged: verify on chain and close it manually.`);
            continue;
          }
          // What it holds now in SOL (the quote side). A one-sided deposit that
          // has not traded is all SOL, which is the case this exists for.
          const depositedSol = Number(pos.positionData.totalYAmount.toString()) / 1e9;
          if (attachAccountToPosition(target.id, { pubkey, minBin: pos.positionData.lowerBinId, maxBin: pos.positionData.upperBinId }, depositedSol, costSol)) {
            report.adopted.push(`${poolAddr} (stray account → pos#${target.id})`);
            await alert("watchdog",
              `reconcile: attached untracked position account ${pubkey} to ${target.symbol} pos#${target.id} ` +
              `(+${depositedSol.toFixed(4)} SOL, cost ${costSol.toFixed(4)}) — it landed after its open gave up on it and is now managed.`);
          }
        }
        for (const pubkey of foreign)
          await alert("watchdog",
            `reconcile: position account ${pubkey} in pool ${poolAddr.slice(0, 8)}… still holds liquidity but belongs to a CLOSED position — ` +
            `its close did not complete on chain. Not touched; verify and close it manually.`);
      } catch (e) {
        console.error(`[reconcile] stray-account check failed for ${poolAddr.slice(0, 8)}…:`, (e as Error).message.split("\n")[0]);
      }
      continue;
    }
    const positions = info.lbPairPositionsData ?? [];
    if (positions.length === 0) continue;
    // Bin range across all position accounts on this pair.
    let minBin = Number.MAX_SAFE_INTEGER, maxBin = Number.MIN_SAFE_INTEGER;
    let anyLiquidity = false;
    for (const pos of positions) {
      minBin = Math.min(minBin, pos.positionData.lowerBinId);
      maxBin = Math.max(maxBin, pos.positionData.upperBinId);
      if (Number(pos.positionData.totalXAmount) > 0 || Number(pos.positionData.totalYAmount) > 0) {
        anyLiquidity = true;
      }
    }
    // Empty shells left by a failed rebalance/close — adopting them as open
    // creates a $0 "position" that P0 writes off again (Niles #63 → ADOPTED #65).
    // Leave them for the executor's empty-close / rent reclaim path.
    if (!anyLiquidity) {
      console.log(
        `[reconcile] skip adopt ${poolAddr.slice(0, 8)}… — ${positions.length} empty account(s), no liquidity`,
      );
      continue;
    }
    // entry_sol stays 0 so the first mark sets the stop-loss reference ("PnL
    // from adoption point" for the exit rules); open_cost_sol is the measured
    // wallet outflow when it can be read, so realized PnL is the true one.
    const openCostSol = await adoptedOpenCostSol(connection, wallet, positions.map((p) => p.publicKey));
    const res = db.prepare(
      `INSERT INTO positions (mode, pool, token_mint, symbol, entry_ts, entry_price, entry_sol,
        min_bin_id, max_bin_id, state, open_cost_sol)
       VALUES ('live', ?, ?, ?, ?, 0, 0, ?, ?, 'open', ?)`
    ).run(poolAddr, info.tokenX.publicKey.toString(), "ADOPTED", now(), minBin, maxBin, openCostSol);
    const adoptedId = Number(res.lastInsertRowid);
    // Without these the adoption is worse than useless. accountKeys() reads
    // position_accounts, ourLbPositions() filters the wallet's on-chain
    // positions down to that set, and valueOf([]) is 0 — so an adopted position
    // marks as worthless, P0 closes it as pool_dead, and a live 0.3-0.6 SOL
    // position is written off without a single instruction being sent.
    for (const pos of positions)
      db.prepare(
        "INSERT INTO position_accounts (position_id, pubkey, min_bin_id, max_bin_id) VALUES (?, ?, ?, ?)"
      ).run(adoptedId, pos.publicKey.toString(), pos.positionData.lowerBinId, pos.positionData.upperBinId);
    db.prepare(
      "INSERT INTO events (position_id, ts, type, detail_json) VALUES (?, ?, 'open', ?)"
    ).run(adoptedId, now(), JSON.stringify({
      reconcile: openCostSol === null
        ? "adopted_from_chain — entry price/size unknown, PnL from adoption point"
        : "adopted_from_chain — cost basis measured from the open tx(s); stop-loss reference from the first mark",
      openCostSol,
      accounts: positions.map((p) => p.publicKey.toString()),
    }));
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
