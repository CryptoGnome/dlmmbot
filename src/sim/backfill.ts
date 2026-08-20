import { openDb } from "../db/db.js";
import { backfillOne, pending, type BackfillStatus } from "./postExit.js";

/**
 * `npm run sim:backfill` — fetch the price path after each closed position from
 * GeckoTerminal so the backtester can judge holding LONGER, not only cutting
 * earlier. Keyless, rate-limited, resumable: every position attempted is
 * recorded, so a re-run picks up where the last one stopped and positions whose
 * window has not elapsed yet are retried later instead of being written off.
 */

const USAGE = `
npm run sim:backfill -- [options]

  --db <path>          farmer.db to fill (default: FARMER_DB_PATH or data/farmer.db)
  --window <min>       minutes of price after each exit to fetch (default 80, max 80)
  --limit <n>          stop after n positions this run (default 200)
  --pace <ms>          delay between API calls (default 2500 — the free tier is strict)
  --refetch            re-fetch positions already done
`.trim();

interface Args { db: string; window: number; limit: number; pace: number; refetch: boolean }

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    db: process.env.FARMER_DB_PATH || "data/farmer.db",
    window: 80, limit: 200, pace: 2500, refetch: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i] ?? "";
    switch (argv[i]) {
      case "--db": a.db = next(); break;
      case "--window": a.window = Number(next()); break;
      case "--limit": a.limit = Number(next()); break;
      case "--pace": a.pace = Number(next()); break;
      case "--refetch": a.refetch = true; break;
      case "--help": case "-h": break;
      default: throw new Error(`unknown argument: ${argv[i]} (--help for usage)`);
    }
  }
  // One call returns at most 100 minute bars and 20 of them are the pre-exit
  // overlap used for calibration, so a longer window would silently truncate.
  if (a.window > 80) throw new Error("--window cannot exceed 80 (one API call is 100 minute bars, 20 reserved for calibration)");
  return a;
}

export async function run(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return; }
  const args = parseArgs(argv);
  const db = openDb(args.db);
  try {
    const todo = pending(db, args.window, args.refetch, args.limit);
    console.log(`Backfilling ${todo.length} position(s) from ${args.db}, ${args.window}m window, ${args.pace}ms pacing`);
    if (!todo.length) {
      console.log("Nothing pending — every closed position already has a result for this window.");
      return;
    }
    const counts = new Map<BackfillStatus, number>();
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < todo.length; i++) {
      const c = todo[i]!;
      let line: string;
      try {
        const r = await backfillOne(db, c, args.window, now);
        counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
        line = `#${c.id} ${r.status}` +
          (r.bars ? ` ${r.bars} bars` : "") +
          (r.calibRatio != null ? ` calib ×${r.calibRatio.toFixed(3)} (n=${r.calibN})` : "");
      } catch (e) {
        counts.set("error", (counts.get("error") ?? 0) + 1);
        line = `#${c.id} error ${(e as Error).message.slice(0, 80)}`;
      }
      console.log(`  [${i + 1}/${todo.length}] ${line}`);
      // Nothing is fetched for a position whose window has not elapsed, so do
      // not pay the rate-limit delay for it.
      if (i < todo.length - 1 && counts.get("too_recent") !== i + 1) {
        await new Promise((r) => setTimeout(r, args.pace));
      }
    }
    const summary = [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`\nDone: ${summary}`);
    const ok = counts.get("ok") ?? 0;
    if (ok) console.log(`Run \`npm run sim -- --post-exit\` to see what happened after those ${ok} exits.`);
    if (counts.get("miscalibrated")) {
      console.log(`Miscalibrated rows are stored but never used: their bars did not track our own recorded marks.`);
    }
  } finally {
    db.close();
  }
}

run(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
