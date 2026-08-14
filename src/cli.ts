import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { isLive, startConfigWatcher } from "./config.js";
import { getDb, REALIZED_PNL_SQL } from "./db/db.js";
import { runLoop } from "./manager/loop.js";
import { scan } from "./scanner/scan.js";
import { vetToken } from "./vetting/vet.js";

const cmd = process.argv[2];

async function main(): Promise<void> {
  switch (cmd) {
    case "scan": {
      console.log("scanning Meteora DLMM pools...");
      const res = await scan();
      console.log(`\nswept ${res.sweptPools} pools -> ${res.candidates.length} candidates, ${res.rejected.length} rejected\n`);
      for (const c of res.candidates.slice(0, 15)) {
        const p = c.pool;
        console.log(
          `  ${c.symbol.padEnd(12)} score=${String(c.score).padStart(5)} ` +
          `feeTVL24h=${p.feeTvl24hPct.toFixed(1)}%/d tvl=$${(p.tvlUsd / 1000).toFixed(0)}k ` +
          `vol30m=$${(p.vol30mUsd / 1000).toFixed(0)}k binStep=${p.binStep} fee=${p.baseFeePct}% ${p.address}`
        );
      }
      if (res.candidates.length === 0) {
        console.log("  (no pools passed all gates this sweep — normal in quiet markets)");
        const topRejects = res.rejected.sort((a, b) => b.score - a.score).slice(0, 5);
        console.log("\n  closest rejects:");
        for (const c of topRejects)
          console.log(`  ${c.symbol.padEnd(12)} failed: ${c.gateFailures.map((f) => `${f.gate}(${f.value} vs ${f.limit})`).join(", ")}`);
      }
      break;
    }
    case "vet": {
      const mint = process.argv[3];
      if (!mint) { console.error("usage: npm run vet -- <mint>"); process.exit(1); }
      const res = await vetToken(mint, null);
      console.log(`verdict: ${res.verdict}  softScore: ${res.softScore.toFixed(0)}/100`);
      if (res.hardFailures.length) {
        console.log("hard failures:");
        for (const f of res.hardFailures) console.log(`  - ${f.gate}: ${f.value} (limit ${f.limit})`);
      }
      console.log("facts:", JSON.stringify(res.facts, null, 2));
      break;
    }
    case "run": {
      startConfigWatcher();
      await runLoop();
      break;
    }
    case "status": {
      const db = getDb();
      const open = db.prepare(
        "SELECT id, symbol, entry_sol, entry_price, state, fees_claimed_sol, datetime(entry_ts,'unixepoch') AS opened FROM positions WHERE state IN ('open','pending')"
      ).all();
      const closed = db.prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(${REALIZED_PNL_SQL}), 0) AS pnl,
                COALESCE(SUM(fees_measured_sol + fees_at_close_sol), 0) AS fees
         FROM positions WHERE exit_ts IS NOT NULL`
      ).get() as { n: number; pnl: number; fees: number };
      console.log(`open positions: ${open.length}`);
      console.table(open);
      console.log(`closed: ${closed.n}  realized PnL (measured): ${closed.pnl.toFixed(4)} SOL`);
      // Disclosure only — this is already inside realized above, via
      // fees_measured_sol on claims and close_return_sol on close-time fees.
      console.log(`  of which fee income: ${closed.fees.toFixed(4)} SOL`);

      const { promotionStatus } = await import("./pnl/rollup.js");
      const promo = promotionStatus();
      console.log(
        `\npaper->live promotion: ${promo.consecutiveProfitable}/${promo.requiredDays} consecutive profitable days` +
        (promo.eligible ? "  ✅ ELIGIBLE" : "") + ` (${promo.trackedDays} days tracked)`
      );
      for (const d of promo.days)
        console.log(`  ${d.day}  realized ${d.realized >= 0 ? "+" : ""}${d.realized.toFixed(4)}  Δunrealized ${d.unrealizedDelta >= 0 ? "+" : ""}${d.unrealizedDelta.toFixed(4)}  ${d.profitable ? "✅" : "❌"}`);
      break;
    }
    case "force-close": {
      // Recovery for a row stuck open with nothing behind it on chain. That
      // state became unrecoverable-by-itself on 2026-08-10: ourLbPositions now
      // throws when we track accounts the chain does not return (rather than
      // marking the position worthless), and reconcile refuses to orphan a
      // lone open row on an empty chain read. Both are the right call, and
      // together they leave exactly this gap. This is the sanctioned exit —
      // not a hand-written UPDATE, for the same reason `release` exists.
      //   npm run force-close -- <id> "<reason>"
      const db = getDb();
      const id = Number(process.argv[3]);
      const reason = process.argv[4];
      if (!Number.isInteger(id) || !reason) {
        console.error('usage: npm run force-close -- <position id> "<reason>"');
        process.exit(1);
      }
      const pos = db.prepare("SELECT * FROM positions WHERE id = ?").get(id) as
        | { id: number; symbol: string; pool: string; state: string; exit_ts: number | null; entry_sol: number }
        | undefined;
      if (!pos) { console.error(`no position ${id}`); process.exit(1); }
      if (pos.exit_ts !== null) { console.error(`pos#${id} ${pos.symbol} is already closed (${pos.state})`); process.exit(1); }

      // Never let an operator write off a position that still holds liquidity.
      if (isLive()) {
        const { LiveExecutor } = await import("./executor/live.js");
        const live = new LiveExecutor();
        const { tracked, found } = await live.chainPresence({ id: pos.id, poolAddress: pos.pool });
        console.log(`chain check: ${found} of ${tracked} tracked account(s) still on chain`);
        if (found > 0) {
          console.error(
            `REFUSING: pos#${id} ${pos.symbol} still has ${found} live position account(s).\n` +
            `force-close only writes off rows with nothing behind them. To exit a real position,\n` +
            `let the manager close it, or use \`npm run halt\` to close everything and stop.`
          );
          process.exit(1);
        }
      } else {
        console.log("paper mode — skipping the chain check");
      }

      // exit_sol / close_return_sol stay NULL on purpose. We do not know what
      // came back, and REALIZED_PNL_SQL yields NULL for such a row, which SUM
      // skips — so it contributes nothing rather than a fabricated number.
      // The SOL itself is still reflected in the wallet-level account figure.
      db.prepare(
        "UPDATE positions SET state = 'closed_manual', exit_ts = ?, exit_reason = 'manual' WHERE id = ?"
      ).run(Math.floor(Date.now() / 1000), id);
      db.prepare(
        "INSERT INTO events (position_id, ts, type, detail_json) VALUES (?, ?, 'force_close', ?)"
      ).run(id, Math.floor(Date.now() / 1000), JSON.stringify({ reason, by: "cli", chainChecked: isLive() }));
      console.log(
        `pos#${id} ${pos.symbol} marked closed_manual — "${reason}"\n` +
        `exit_sol and close_return_sol left NULL: outcome unknown, so it contributes 0 to realized PnL.\n` +
        `undo: UPDATE positions SET state='open', exit_ts=NULL, exit_reason=NULL WHERE id=${id};`
      );
      break;
    }
    case "release": {
      // House-money banking has no inverse in the manager: bankProfit only ever
      // inserts 'bank', and computeBankroll subtracts the net from deployable —
      // so banked SOL was a one-way door. `release` is that inverse, and it goes
      // through the CLI rather than a hand-written UPDATE so the reversal is in
      // the ledger with a note instead of being an unattributable DB poke.
      //   npm run release            -> release everything currently banked
      //   npm run release -- 0.05    -> release that much
      const db = getDb();
      const banked = (db.prepare(
        "SELECT COALESCE(SUM(CASE kind WHEN 'bank' THEN sol ELSE -sol END), 0) AS b FROM ledger"
      ).get() as { b: number }).b;
      if (banked <= 0) { console.log(`nothing banked (net ${banked.toFixed(6)} SOL) — nothing to release`); break; }

      // "all" rather than typing the number: the banked total is a float sum,
      // so a hand-copied 6dp value overshoots it by an epsilon and trips the
      // guard below. It also lets a full release still carry a custom note.
      const arg = process.argv[3];
      const amount = arg === undefined || arg === "all" ? banked : Number(arg);
      if (!Number.isFinite(amount) || amount <= 0) { console.error(`bad amount: ${arg}`); process.exit(1); }
      if (amount > banked) { console.error(`cannot release ${amount} SOL — only ${banked.toFixed(6)} is banked`); process.exit(1); }

      const note = process.argv[4] ?? "manual release to deployable";
      const ts = Math.floor(Date.now() / 1000);
      const res = db.prepare("INSERT INTO ledger (ts, kind, sol, note) VALUES (?, 'release', ?, ?)")
        .run(ts, amount, note);
      const after = (db.prepare(
        "SELECT COALESCE(SUM(CASE kind WHEN 'bank' THEN sol ELSE -sol END), 0) AS b FROM ledger"
      ).get() as { b: number }).b;
      console.log(
        `released ${amount.toFixed(6)} SOL (ledger row ${res.lastInsertRowid}, "${note}")\n` +
        `banked ${banked.toFixed(6)} -> ${after.toFixed(6)} SOL; that much returns to deployable on the next tick.\n` +
        `undo: DELETE FROM ledger WHERE id = ${res.lastInsertRowid};`
      );
      break;
    }
    case "halt": {
      const haltPath = resolve(process.cwd(), "HALT");
      if (existsSync(haltPath)) {
        unlinkSync(haltPath);
        console.log("HALT cleared — farmer resumes on the next tick (or restart if it already exited)");
      } else {
        writeFileSync(haltPath, new Date().toISOString());
        console.log("HALT requested — running farmer will close all positions and idle until cleared");
      }
      break;
    }
    default:
      console.log("usage: npm run <scan|vet -- <mint>|run|status|halt|release [-- <sol> [note]]>");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
