import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { startConfigWatcher } from "./config.js";
import { getDb } from "./db/db.js";
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
        `SELECT COUNT(*) AS n, COALESCE(SUM(exit_sol - entry_sol + fees_claimed_sol), 0) AS pnl
         FROM positions WHERE exit_ts IS NOT NULL`
      ).get() as { n: number; pnl: number };
      console.log(`open positions: ${open.length}`);
      console.table(open);
      console.log(`closed: ${closed.n}  realized PnL (incl fees): ${closed.pnl.toFixed(4)} SOL`);

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
    case "halt": {
      const haltPath = resolve(process.cwd(), "HALT");
      if (existsSync(haltPath)) { unlinkSync(haltPath); console.log("HALT cleared — farmer may run again"); }
      else { writeFileSync(haltPath, new Date().toISOString()); console.log("HALT requested — running farmer will close all positions and stop"); }
      break;
    }
    default:
      console.log("usage: npm run <scan|vet -- <mint>|run|status|halt>");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
