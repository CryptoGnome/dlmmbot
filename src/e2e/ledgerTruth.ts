/**
 * E2E: ledger truth — `npm run e2e:ledger -- --db <farmer.db> [--wallet <pubkey>] [--out <dir>] [--wallet-pnl <sol>] [--keep]`
 *
 * Runs the real migration, the real restatement and the real dashboard
 * builders against a COPY of a real ledger and checks that every reported
 * total is the same number. The source file is only ever read. Offline: no
 * RPC, no wallet, no SOL.
 *
 * Background (2026-11-21 audit): the wallet's on-chain history said the live
 * book was +0.403 SOL; SUM(REALIZED_PNL_SQL) said -0.357, pnl_daily said
 * -0.467, and the dashboard computed its own third formula.
 *
 * Failure modes, written before the implementation. Each is a check below:
 *  L1  the migration moves the book by something other than
 *      (rent reclaims credited − profit burn debited)
 *  L2  a position's PnL changes by anything other than its own two new columns
 *  L3  a second start (restart, redeploy) moves the book again — double count
 *  L4  a material share of the rent or burn history cannot be attributed
 *      (needs --wallet: events older than the per-token detail name only the
 *      accounts they closed, and an account maps to a mint through its owner)
 *  L5  pnl_daily still disagrees with positions after the restatement
 *  L6  a follow chain's stored PnL still disagrees with its legs
 *  L7  the dashboard's all-time figure is not the bot's figure
 *  L8  the dashboard's history view throws, or counts different closes
 *  L9  profit-burn ledger rows still move the banked balance
 *  L10 (with --wallet-pnl) the restated book is no closer to the wallet's
 *      on-chain result than the old one was
 * Writes <out>/report.json and exits non-zero if any check fails.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

interface Args { db: string; out: string; wallet: string | null; walletPnl: number | null; keep: boolean }
function parseArgs(argv: string[]): Args {
  // On disk, not the OS temp dir: this holds a full copy of the ledger (hundreds
  // of MB) and /tmp is RAM-backed on some hosts.
  const a: Args = { db: "", out: join(homedir(), ".cache", "dlmmbot-e2e-ledger"), wallet: null, walletPnl: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i] ?? "";
    switch (argv[i]) {
      case "--db": a.db = next(); break;
      case "--out": a.out = next(); break;
      case "--wallet": a.wallet = next(); break;
      case "--wallet-pnl": a.walletPnl = Number(next()); break;
      case "--keep": a.keep = true; break;
      default: throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  if (!a.db) throw new Error("--db <path to a copy of farmer.db> is required");
  a.db = resolve(a.db);
  a.out = resolve(a.out);
  return a;
}

// The formula as it stood before this change — the "before" side of every check.
const OLD_PNL_SQL = `
  CASE WHEN close_return_sol IS NOT NULL AND (open_cost_sol IS NOT NULL OR entry_sol > 0)
       THEN close_return_sol + COALESCE(fees_measured_sol, 0) + COALESCE(withdrawn_sol, 0) + COALESCE(recovered_sol, 0)
            + CASE WHEN COALESCE(stranded_sol, 0) > 0 AND COALESCE(stranded_at, 0) > CAST(strftime('%s','now') AS INTEGER) - 1800 THEN stranded_sol ELSE 0 END
            - COALESCE(open_cost_sol, entry_sol + COALESCE(rent_paid_sol, 0))
       WHEN entry_sol > 0 AND exit_sol IS NOT NULL
       THEN exit_sol - entry_sol
            + CASE WHEN COALESCE(fees_measured_sol, 0) > 0 THEN fees_measured_sol ELSE COALESCE(fees_claimed_sol, 0) END
            + COALESCE(withdrawn_sol, 0) + COALESCE(recovered_sol, 0)
            + CASE WHEN COALESCE(stranded_sol, 0) > 0 AND COALESCE(stranded_at, 0) > CAST(strftime('%s','now') AS INTEGER) - 1800 THEN stranded_sol ELSE 0 END
       ELSE NULL END`;

interface Check { id: string; name: string; pass: boolean; detail: string }

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  rmSync(args.out, { recursive: true, force: true });
  mkdirSync(args.out, { recursive: true });
  const work = join(args.out, "farmer.db");
  // A consistent copy even if the source is a live WAL database.
  const src = new Database(args.db, { readonly: true, fileMustExist: true });
  await src.backup(work);
  src.close();

  // ---- before: raw read, no migration ----
  const raw = new Database(work);
  const hadColumns = (raw.prepare("SELECT COUNT(*) c FROM pragma_table_info('positions') WHERE name IN ('rent_reclaimed_sol','profit_burn_sol')").get() as { c: number }).c === 2;
  const before = new Map((raw.prepare(
    `SELECT id, (${OLD_PNL_SQL}) AS pnl FROM positions WHERE mode = 'live' AND exit_ts IS NOT NULL`
  ).all() as Array<{ id: number; pnl: number | null }>).map((r) => [r.id, r.pnl]));
  const beforeTotal = [...before.values()].reduce((s: number, v) => s + (v ?? 0), 0);
  const rentEvents = raw.prepare("SELECT COUNT(*) n, COALESCE(SUM(sol_delta), 0) s FROM events WHERE type = 'rent_reclaim' AND sol_delta > 0").get() as { n: number; s: number };
  const burnAccruals = raw.prepare("SELECT COUNT(*) n, COALESCE(SUM(sol), 0) s FROM ledger WHERE kind = 'profit_burn_accrue' AND sol > 0").get() as { n: number; s: number };
  const dailyBefore = (raw.prepare("SELECT COALESCE(SUM(realized_sol), 0) s FROM pnl_daily WHERE mode = 'live'").get() as { s: number }).s;
  raw.close();

  // ---- the real code paths, pointed at the copy ----
  writeFileSync(join(args.out, ".env"), "FARMER_MODE=live\n");
  writeFileSync(join(args.out, "config.toml"),
    readFileSync(resolve("config.toml"), "utf8").replace(/^mode\s*=\s*"paper"/m, 'mode = "live"'));
  process.env.FARMER_DB_PATH = work;
  process.env.FARMER_ENV_PATH = join(args.out, ".env");
  process.env.FARMER_CONFIG_PATH = join(args.out, "config.toml");
  process.env.FARMER_MODE = "live";
  const { getDb, REALIZED_PNL_SQL, _resetDbForTests } = await import("../db/db.js");
  const { restateDerivedPnl } = await import("../pnl/rollup.js");
  const { computeBankroll } = await import("../risk/limits.js");

  const db = getDb(); // migrate + backfill
  // What LiveExecutor does once it has the wallet: attribute the events that
  // name only accounts. Public key only — nothing here can sign.
  let legacyNote = "no --wallet given: legacy events left unattributed";
  if (args.wallet) {
    const { PublicKey } = await import("@solana/web3.js");
    const { ataMintIndex } = await import("../executor/live.js");
    const { attributeLegacyRentReclaims } = await import("../db/db.js");
    const mints = (db.prepare("SELECT DISTINCT token_mint FROM positions WHERE mode = 'live'").all() as Array<{ token_mint: string }>).map((r) => r.token_mint);
    const index = ataMintIndex(new PublicKey(args.wallet), mints);
    const r = attributeLegacyRentReclaims((account) => index.get(account) ?? null);
    legacyNote = `legacy events attributed: ${r.events}, +${r.creditedSol.toFixed(6)} SOL`;
  }
  const bookTotal = () => (db.prepare(
    `SELECT COALESCE(SUM(${REALIZED_PNL_SQL}), 0) s FROM positions WHERE mode = 'live' AND exit_ts IS NOT NULL`
  ).get() as { s: number }).s;
  const flows = db.prepare(
    "SELECT COALESCE(SUM(rent_reclaimed_sol), 0) rent, COALESCE(SUM(profit_burn_sol), 0) burn FROM positions WHERE mode = 'live' AND exit_ts IS NOT NULL"
  ).get() as { rent: number; burn: number };
  const afterRows = db.prepare(
    `SELECT id, (${REALIZED_PNL_SQL}) AS pnl, rent_reclaimed_sol rent, profit_burn_sol burn FROM positions WHERE mode = 'live' AND exit_ts IS NOT NULL`
  ).all() as Array<{ id: number; pnl: number | null; rent: number; burn: number }>;
  const afterTotal = bookTotal();
  const meta = (k: string) => Number((db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? 0);
  const rentUnattributed = meta("rent_reclaim_unattributed_sol");
  const burnUnattributed = meta("profit_burn_unattributed_sol");

  const checks: Check[] = [];
  const add = (id: string, name: string, pass: boolean, detail: string) => checks.push({ id, name, pass, detail });
  const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

  add("L1", "book moved by exactly rent credited − burn debited",
    near(afterTotal - beforeTotal, flows.rent - flows.burn),
    `before ${beforeTotal.toFixed(6)} → after ${afterTotal.toFixed(6)} (Δ ${(afterTotal - beforeTotal).toFixed(6)}); rent +${flows.rent.toFixed(6)}, burn -${flows.burn.toFixed(6)}`);

  const wrongRows = afterRows.filter((r) => {
    const old = before.get(r.id) ?? null;
    if (old === null || r.pnl === null) return old !== r.pnl;
    return !near(r.pnl - old, r.rent - r.burn, 1e-9);
  });
  add("L2", "each position changed only by its own rent and burn",
    wrongRows.length === 0,
    wrongRows.length ? `positions off: ${wrongRows.slice(0, 8).map((r) => `#${r.id}`).join(", ")}` : `${afterRows.length} closed live positions checked`);

  // L3: restart. Close, reopen (runs migrate again), compare.
  _resetDbForTests();
  const db2 = getDb();
  const again = (db2.prepare(
    `SELECT COALESCE(SUM(${REALIZED_PNL_SQL}), 0) s FROM positions WHERE mode = 'live' AND exit_ts IS NOT NULL`
  ).get() as { s: number }).s;
  add("L3", "a second start changes nothing", near(again, afterTotal, 1e-12),
    `after first start ${afterTotal.toFixed(9)}, after second ${again.toFixed(9)}`);

  const rentShare = rentEvents.s > 0 ? rentUnattributed / rentEvents.s : 0;
  const burnShare = burnAccruals.s > 0 ? burnUnattributed / burnAccruals.s : 0;
  add("L4", "rent and burn history is attributed (< 2% left over)",
    rentShare < 0.02 && burnShare < 0.02 && near(flows.rent + rentUnattributed, rentEvents.s, 1e-6) && near(flows.burn + burnUnattributed, burnAccruals.s, 1e-6),
    `rent: ${rentEvents.n} events ${rentEvents.s.toFixed(6)} SOL, credited ${flows.rent.toFixed(6)}, unattributed ${rentUnattributed.toFixed(6)}; ` +
    `burn: ${burnAccruals.n} accruals ${burnAccruals.s.toFixed(6)} SOL, debited ${flows.burn.toFixed(6)}, unattributed ${burnUnattributed.toFixed(6)}; ${legacyNote}`);

  const restated = restateDerivedPnl("live");
  const dailyAfter = (db2.prepare("SELECT COALESCE(SUM(realized_sol), 0) s FROM pnl_daily WHERE mode = 'live'").get() as { s: number }).s;
  const trackedDays = (db2.prepare(
    `SELECT COALESCE(SUM(${REALIZED_PNL_SQL}), 0) s FROM positions
      WHERE mode = 'live' AND exit_ts IS NOT NULL
        AND date(exit_ts, 'unixepoch') IN (SELECT day FROM pnl_daily WHERE mode = 'live')`
  ).get() as { s: number }).s;
  add("L5", "pnl_daily equals positions on every tracked day",
    near(dailyAfter, trackedDays, 1e-6) && restateDerivedPnl("live").days === 0,
    `pnl_daily total ${dailyBefore.toFixed(6)} → ${dailyAfter.toFixed(6)}; positions on tracked days ${trackedDays.toFixed(6)}; ${restated.days} day row(s) rewritten`);

  const chainsOff = db2.prepare(
    `SELECT COUNT(*) c FROM follow_chains f WHERE mode = 'live' AND ABS(chain_pnl_sol - COALESCE((
        SELECT SUM(${REALIZED_PNL_SQL}) FROM positions WHERE follow_chain_id = f.id AND exit_ts IS NOT NULL), 0)) > 1e-9`
  ).get() as { c: number };
  add("L6", "every follow chain's stored PnL equals its legs",
    chainsOff.c === 0, `${restated.chains} chain(s) rewritten, ${chainsOff.c} still off`);

  // Dashboard builders: plain-node modules, same DB file, read-only.
  const lib = (f: string) => pathToFileURL(resolve("deploy", "lib", f)).href;
  let dashAll: { n: number; pnl: number; pct: number | null; pct_basis?: string } | null = null;
  let dashErr = "";
  try {
    const { buildLiveBookSnapshot } = await import(lib("live-book-snapshot.mjs")) as { buildLiveBookSnapshot: (root: string) => { book: { all_time_live: typeof dashAll } } };
    dashAll = buildLiveBookSnapshot(resolve(".")).book.all_time_live;
  } catch (e) { dashErr = (e as Error).message.split("\n")[0] ?? "error"; }
  add("L7", "dashboard all-time PnL is the bot's figure",
    dashAll !== null && near(dashAll.pnl, again, 2e-6) && dashAll.n === afterRows.length,
    dashAll ? `dashboard ${dashAll.pnl} over ${dashAll.n} closes (${dashAll.pct_basis}: ${dashAll.pct}); bot ${again.toFixed(6)} over ${afterRows.length}` : `threw: ${dashErr}`);

  let histDetail = "", histOk = false;
  try {
    const { buildHistorySnapshot } = await import(lib("history-snapshot.mjs")) as { buildHistorySnapshot: (root: string, range: string) => Record<string, unknown> };
    const h = buildHistorySnapshot(resolve("."), "all");
    const days = (h.exits ?? []) as Array<{ pnl: number; n: number }>;
    const sum = days.reduce((s, d) => s + d.pnl, 0);
    const n = days.reduce((s, d) => s + d.n, 0);
    histOk = n === afterRows.length && near(sum, again, days.length * 1e-6 + 1e-6);
    histDetail = `history(all): ${n} closes over ${days.length} days, Σ ${sum.toFixed(6)}; keys: ${Object.keys(h).slice(0, 12).join(",")}`;
  } catch (e) { histDetail = `threw: ${(e as Error).message.split("\n")[0]}`; }
  add("L8", "dashboard history view runs and counts the same closes", histOk, histDetail);

  const ledger = db2.prepare(
    "SELECT COALESCE(SUM(CASE kind WHEN 'bank' THEN sol WHEN 'release' THEN -sol ELSE 0 END), 0) b, COALESCE(SUM(CASE WHEN kind LIKE 'profit_burn%' THEN sol ELSE 0 END), 0) burn FROM ledger"
  ).get() as { b: number; burn: number };
  const br = computeBankroll(20);
  add("L9", "banked balance ignores profit-burn rows", near(br.bankedSol, ledger.b, 1e-9),
    `computeBankroll banked ${br.bankedSol.toFixed(6)}; bank−release ${ledger.b.toFixed(6)}; burn rows in ledger ${ledger.burn.toFixed(6)} SOL`);

  if (args.walletPnl !== null && Number.isFinite(args.walletPnl)) {
    add("L10", "restated book is closer to the wallet's on-chain result",
      Math.abs(again - args.walletPnl) < Math.abs(beforeTotal - args.walletPnl),
      `wallet ${args.walletPnl.toFixed(4)}; book was off by ${(beforeTotal - args.walletPnl).toFixed(4)}, now off by ${(again - args.walletPnl).toFixed(4)}`);
  }

  const wins = afterRows.filter((r) => (r.pnl ?? 0) > 0).length;
  const winsBefore = [...before.values()].filter((v) => (v ?? 0) > 0).length;
  const report = {
    generatedAt: new Date().toISOString(),
    source: args.db,
    sourceAlreadyMigrated: hadColumns,
    closedLivePositions: afterRows.length,
    bookPnlSol: { before: beforeTotal, after: again },
    winRatePct: { before: (100 * winsBefore) / Math.max(1, before.size), after: (100 * wins) / Math.max(1, afterRows.length) },
    rentReclaimedSol: flows.rent,
    profitBurnSol: flows.burn,
    pnlDailySol: { before: dailyBefore, after: dailyAfter },
    passed: checks.every((c) => c.pass),
    checks,
  };
  _resetDbForTests();
  writeFileSync(join(args.out, "report.json"), JSON.stringify(report, null, 2));
  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.id} ${c.name}\n       ${c.detail}`);
  console.log(`\nbook ${beforeTotal.toFixed(4)} → ${again.toFixed(4)} SOL; win rate ${report.winRatePct.before.toFixed(1)}% → ${report.winRatePct.after.toFixed(1)}%`);
  console.log(`report: ${join(args.out, "report.json")}`);
  if (!args.keep) for (const f of ["farmer.db", "farmer.db-wal", "farmer.db-shm"]) rmSync(join(args.out, f), { force: true });
  if (!report.passed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
