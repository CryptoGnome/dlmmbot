import { openDb } from "../db/db.js";
import {
  backfillSkip, pendingSkips, MAX_WINDOW_MIN, type SkipStatus,
} from "./skipOutcome.js";

/**
 * `npm run sim:skips` — fetch the price path after each scanner REJECTION so a
 * gate can be judged on what it blocked instead of on intuition. Companion to
 * `sim:backfill`, which does the same for closed positions. Keyless,
 * rate-limited, resumable: every episode attempted is recorded, so a re-run
 * picks up where the last one stopped.
 */

const USAGE = `
npm run sim:skips -- [options]

  --db <path>          farmer.db to fill (default: FARMER_DB_PATH or data/farmer.db)
  --window <min>       minutes of price after the skip to fetch (default 90, max ${MAX_WINDOW_MIN})
  --limit <n>          stop after n episodes this run (default 200)
  --pace <ms>          delay between API calls (default 2500 — the free tier is strict)
  --gate <name>        only episodes rejected by this gate (e.g. bin_step_new)
  --refetch            re-fetch episodes already done
`.trim();

interface Args {
  db: string; window: number; limit: number; pace: number;
  gate: string | null; refetch: boolean;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    db: process.env.FARMER_DB_PATH || "data/farmer.db",
    window: 90, limit: 200, pace: 2500, gate: null, refetch: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i] ?? "";
    switch (argv[i]) {
      case "--db": a.db = next(); break;
      case "--window": a.window = Number(next()); break;
      case "--limit": a.limit = Number(next()); break;
      case "--pace": a.pace = Number(next()); break;
      case "--gate": a.gate = next(); break;
      case "--refetch": a.refetch = true; break;
      case "--help": case "-h": break;
      default: throw new Error(`unknown argument: ${argv[i]} (--help for usage)`);
    }
  }
  if (!(a.window > 0) || a.window > MAX_WINDOW_MIN)
    throw new Error(`--window must be 1..${MAX_WINDOW_MIN} (one API call is 100 minute bars)`);
  return a;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return; }
  const args = parseArgs(argv);
  const db = openDb(args.db);
  try {
    const nowTs = Math.floor(Date.now() / 1000);
    const todo = pendingSkips(db, args.window, args.refetch, args.limit, nowTs, args.gate);
    console.log(
      `Backfilling ${todo.length} skip episode(s) from ${args.db}, ` +
      `${args.window}m window, ${args.pace}ms pacing${args.gate ? `, gate=${args.gate}` : ""}`
    );
    if (!todo.length) {
      console.log("Nothing pending — every elapsed episode already has a result.");
      return;
    }
    const counts = new Map<SkipStatus, number>();
    for (let i = 0; i < todo.length; i++) {
      const c = todo[i]!;
      const o = await backfillSkip(db, c, args.window, Math.floor(Date.now() / 1000));
      counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
      const path = o.status === "ok"
        ? `peak ${o.peakPct!.toFixed(1)}% / trough ${o.troughPct!.toFixed(1)}% / ` +
          `close ${o.closePct!.toFixed(1)}% (${o.barsBelowSkip}/${o.bars} below)`
        : o.status;
      console.log(
        `  [${i + 1}/${todo.length}] ${c.failedGate} ${c.mint.slice(0, 8)} ` +
        `x${c.sweeps} score ${c.bestScore?.toFixed(1) ?? "-"} → ${path}`
      );
      if (i < todo.length - 1) await sleep(args.pace);
    }
    console.log("\n" + [...counts].map(([k, v]) => `${k}=${v}`).join(" "));
  } finally {
    db.close();
  }
}

run(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
