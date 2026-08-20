import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import { applyCohort, cohortSummary, loadTraces, poolMetricCoverage } from "./load.js";
import { applyOverlay, exitKeysOnly, loadProfile, parseValue } from "./overlay.js";
import {
  compare, fidelity, formatFidelity, formatOutcomes, formatVerdict, monotonicity, score,
} from "./report.js";
import type { CohortFilter, ConfigOverlay, Trace } from "./types.js";

/**
 * `npm run sim` — replay recorded positions against alternative exit settings.
 *
 * Answers one question: "given the positions we actually took, would a
 * different EXIT setting have produced more SOL?" It cannot answer entry, gate
 * or sizing questions — there is no data for trades the bot never took.
 * See ladder.ts for the exact replayable/unreplayable split.
 */

interface Args {
  dbs: Array<{ path: string; label: string }>;
  profiles: string[];
  sets: string[];
  sweep: { key: string; values: string[] } | null;
  cohort: CohortFilter;
  top: number;
  json: string | null;
  list: boolean;
}

const USAGE = `
npm run sim -- [options]

  Replays recorded positions (position_marks) against alternative EXIT settings.

  Books
    --db [label=]path        farmer.db to load; repeat for cross-validation
                             (default: FARMER_DB_PATH or data/farmer.db)
  Scenarios
    --profile <id|path>      profiles/official/<id>.json, or a path to one
    --set key=value          override one config key (repeatable)
    --sweep key=a,b,c        run one scenario per value and check monotonicity
  Cohort
    --sleeve meme,micro      default: every sleeve
    --age-max <min>          token age at entry below N minutes (young launches)
    --age-min <min>          ...at or above N minutes
    --book a,b               restrict to one book
    --since YYYY-MM-DD       exits on or after this date
    --min-marks <n>          minimum polls recorded (default 8)
    --include-flagged        keep traces the loader flagged as untrustworthy
  Output
    --top <n>                per-position rows to print (default 10)
    --json <path>            write the full result set
    --list                   list the cohort and exit

  Examples
    npm run sim -- --sleeve meme --age-max 120 --set manage.stop_loss_frac=0.65
    npm run sim -- --sweep manage.below_range_grace_min=5,10,15,20,30
    npm run sim -- --profile aggressive --db server=srv.db --db railway=rw.db
`.trim();

export function parseArgs(argv: string[]): Args {
  const a: Args = { dbs: [], profiles: [], sets: [], sweep: null, cohort: {}, top: 10, json: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i] ?? "";
    switch (arg) {
      case "--db": {
        const raw = next();
        const m = /^([A-Za-z0-9_-]+)=(.+)$/.exec(raw);
        if (m) a.dbs.push({ label: m[1]!, path: m[2]! });
        else a.dbs.push({ path: raw, label: resolve(raw).split(/[\\/]/).slice(-2)[0] ?? "book" });
        break;
      }
      case "--profile": a.profiles.push(next()); break;
      case "--set": a.sets.push(next()); break;
      case "--sweep": {
        const raw = next();
        const eq = raw.indexOf("=");
        if (eq < 0) throw new Error(`--sweep expects key=a,b,c — got "${raw}"`);
        a.sweep = { key: raw.slice(0, eq), values: raw.slice(eq + 1).split(",") };
        break;
      }
      case "--sleeve": a.cohort.sleeve = next().split(",") as Trace["sleeve"][]; break;
      case "--age-max": a.cohort.ageMaxMin = Number(next()); break;
      case "--age-min": a.cohort.ageMinMin = Number(next()); break;
      case "--book": a.cohort.book = next().split(","); break;
      case "--min-marks": a.cohort.minMarks = Number(next()); break;
      case "--since": a.cohort.sinceTs = Math.floor(Date.parse(next()) / 1000); break;
      case "--include-flagged": a.cohort.includeFlagged = true; break;
      case "--top": a.top = Number(next()); break;
      case "--json": a.json = next(); break;
      case "--list": a.list = true; break;
      case "--help": case "-h": console.log(USAGE); return a;
      default: throw new Error(`unknown argument: ${arg} (--help for usage)`);
    }
  }
  return a;
}

function scenariosFrom(args: Args): Array<{ label: string; overlay: ConfigOverlay }> {
  const out: Array<{ label: string; overlay: ConfigOverlay }> = [];
  for (const p of args.profiles) {
    const { label, overlay } = loadProfile(p);
    const { kept, ignored } = exitKeysOnly(overlay);
    if (ignored.length) {
      console.log(`  note: ${label} also changes ${ignored.length} entry/sizing keys ` +
        `(${ignored.slice(0, 4).join(", ")}${ignored.length > 4 ? ", …" : ""}) — ` +
        `not simulated, this compares exit behaviour only`);
    }
    out.push({ label, overlay: kept });
  }
  if (args.sets.length) {
    const overlay: ConfigOverlay = {};
    for (const s of args.sets) {
      const eq = s.indexOf("=");
      if (eq < 0) throw new Error(`--set expects key=value, got "${s}"`);
      overlay[s.slice(0, eq)] = parseValue(s.slice(eq + 1));
    }
    out.push({ label: args.sets.join(" "), overlay });
  }
  if (args.sweep) {
    for (const v of args.sweep.values) {
      out.push({ label: `${args.sweep.key}=${v}`, overlay: { [args.sweep.key]: parseValue(v) } });
    }
  }
  return out;
}

export function run(argv: string[]): void {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return; }
  const args = parseArgs(argv);
  if (!args.dbs.length) {
    args.dbs.push({ path: process.env.FARMER_DB_PATH || "data/farmer.db", label: "local" });
  }

  const all: Trace[] = args.dbs.flatMap((d) => loadTraces(d.path, d.label));
  const traces = applyCohort(all, args.cohort);
  console.log(`Books: ${args.dbs.map((d) => `${d.label} (${d.path})`).join(", ")}`);
  console.log(`Cohort: ${cohortSummary(all, traces, args.cohort)}`);
  if (!traces.length) {
    console.log("\nNothing to simulate. Loosen the cohort filters, or check the DB path.");
    return;
  }
  if (args.list) {
    for (const t of traces) {
      console.log(`  #${t.id} ${t.symbol.padEnd(12)} ${t.book.padEnd(8)} ${t.sleeve.padEnd(6)} ` +
        `age=${t.ageMin == null ? "?" : t.ageMin.toFixed(0) + "m"} marks=${String(t.marks.length).padStart(4)} ` +
        `${t.actualReason.padEnd(12)} pnl=${t.actualPnl.toFixed(4)}`);
    }
    return;
  }

  const base = config();
  const actual = traces.reduce((a, t) => a + t.actualPnl, 0);
  console.log(`Actual realized PnL over the cohort: ${actual >= 0 ? "+" : ""}${actual.toFixed(3)} SOL\n`);
  console.log(formatFidelity(fidelity(traces, base)));
  const cov = poolMetricCoverage(traces);
  if (cov.withMetrics < cov.total) {
    console.log(`  Pool health (TVL/volume) recorded on ${cov.withMetrics}/${cov.total} traces — ` +
      `P0 tvl_drain and P2 decay stay out of the replay until the rest of the book carries it.`);
  }

  const scenarios = scenariosFrom(args);
  if (!scenarios.length) {
    console.log("\nNo scenario given — pass --set, --profile or --sweep. (--help for examples)");
    return;
  }

  const results = scenarios.map((s) => {
    const outcomes = compare(traces, base, applyOverlay(base, s.overlay));
    return { ...s, outcomes, verdict: score(outcomes) };
  });

  for (const r of results) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(formatVerdict(r.label, r.verdict));
    if (r.verdict.fired > 0) console.log(formatOutcomes(r.outcomes, args.top));
  }

  if (args.sweep) {
    console.log(`\n${"─".repeat(70)}\nSweep ${args.sweep.key}`);
    for (const r of results) {
      const d = (r.verdict.delta >= 0 ? "+" : "") + r.verdict.delta.toFixed(3);
      console.log(`  ${r.label.padEnd(42)} ${d.padStart(7)} (${r.verdict.fired} fired) ${r.verdict.call}`);
    }
    const mono = monotonicity(results.map((r) => r.verdict.delta));
    console.log(mono.noisy
      ? `  NOISE: the delta changes sign ${mono.flips}× across the sweep. That is a fitted parameter,\n` +
        `  not a threshold — do not pick the best cell.`
      : `  Sign is stable across the sweep (${mono.flips} flip${mono.flips === 1 ? "" : "s"}).`);
  }

  if (args.json) {
    writeFileSync(args.json, JSON.stringify(results.map((r) => ({
      label: r.label, overlay: r.overlay, verdict: r.verdict,
      positions: r.outcomes.filter((o) => o.delta !== 0).map((o) => ({
        id: o.trace.id, book: o.trace.book, symbol: o.trace.symbol, delta: o.delta,
        actualPnl: o.trace.actualPnl, simPnl: o.simPnl,
        baseReason: o.base.reason, variantReason: o.variant.reason,
      })),
    })), null, 2));
    console.log(`\nWrote ${args.json}`);
  }
}

run(process.argv.slice(2));
