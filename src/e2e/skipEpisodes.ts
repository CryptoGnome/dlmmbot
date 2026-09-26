/**
 * E2E: skip episodes — `npm run e2e:skips -- [--out <dir>] [--sweeps 4] [--gap 15] [--keep]`
 *
 * Drives the REAL scanner against the live Meteora datapi into a throwaway DB
 * that starts in the pre-episode schema, then reads the result back through
 * every consumer of skip rows: the sim:skips episode query, the dashboard
 * history snapshot (funnel, skip share, daily activity), the live-book snapshot
 * (bin-rent near misses) and retention. Writes <out>/report.json and exits
 * non-zero if any check fails. Paper mode, GMGN off — it spends no money and
 * none of the API budget the live bot shares.
 *
 * Failure modes, written before the implementation. Each is a check below:
 *  F1  rows for different mints / pools / gates merge
 *  F2  an episode spans a 6h bucket boundary
 *  F3  a paper rejection merges into a live row (or the reverse)
 *  F4  rejections are lost: SUM(sweeps) != rejections observed
 *  F5  a dashboard reader still counts rows, so the funnel collapses ~100x
 *  F6  sim:skips gets the wrong sweep count or best score
 *  F7  pre-deploy per-sweep rows and new episode rows double-count or split
 *  F8  the migration fails on a populated pre-episode DB
 *  F9  event rows (open_failed, telemetry) get merged
 *  F10 the anchor (first sweep's score / features) is overwritten
 *  F11 a NULL score breaks score_max
 *  F12 retention breaks on episode rows
 *  F13 the dedupe lookup does not use an index
 *  F14 the table does not actually shrink
 *  F15 the size ceiling deletes rejection history while snapshots it could
 *      delete instead still exist (3 days of snapshots is ~245 MB on the live
 *      book: they alone hold the file over a 250 MB ceiling)
 *  F16 when snapshots alone cannot get under the ceiling, the trim stalls
 *      instead of falling back to skip rows, and the volume fills (see F12)
 */
import Database from "better-sqlite3";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const B = 6 * 3600; // must equal EPISODE_BUCKET_S; asserted once the module loads

interface Args { out: string; sweeps: number; gap: number; keep: boolean }
function parseArgs(argv: string[]): Args {
  const a: Args = { out: join(tmpdir(), "dlmmbot-e2e-skips"), sweeps: 4, gap: 15, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i] ?? "";
    switch (argv[i]) {
      case "--out": a.out = next(); break;
      case "--sweeps": a.sweeps = Number(next()); break;
      case "--gap": a.gap = Number(next()); break;
      case "--keep": a.keep = true; break;
      default: throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  if (!(a.sweeps >= 2)) throw new Error("--sweeps must be >= 2 (dedupe needs a repeat)");
  a.out = resolve(a.out);
  return a;
}

const args = parseArgs(process.argv.slice(2));
rmSync(args.out, { recursive: true, force: true });
mkdirSync(args.out, { recursive: true });
const dbPath = join(args.out, "farmer.db");
const twinPath = join(args.out, "legacy-twin.db");

// Isolate before any module that reads the environment is imported.
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
process.env.FARMER_DB_PATH = dbPath;
process.env.FARMER_CONFIG_PATH = join(args.out, "config.toml");
process.env.FARMER_ENV_PATH = join(args.out, ".env");
process.env.FARMER_MODE = "paper";
writeFileSync(
  process.env.FARMER_CONFIG_PATH,
  readFileSync("config.toml", "utf8")
    .replace(/^(\[gmgn\][^\n]*\n)enabled = true/m, "$1enabled = false")
    .replace(/^mode = "live"/m, 'mode = "paper"'),
);
writeFileSync(process.env.FARMER_ENV_PATH, "FARMER_MODE=paper\n");

// Wall clock we can move: the bucket rollover is 6h away in real time.
const realNow = Date.now.bind(Date);
let offsetS = 0;
Date.now = () => realNow() + offsetS * 1000;
const nowS = () => Math.floor(Date.now() / 1000);
const bucketOf = (ts: number) => Math.floor(ts / B);

// Keep every pre-rollover sweep inside one bucket, with room before it for the
// seeded pre-deploy rows.
{
  const need = args.sweeps * (args.gap + 30) + 300;
  const t = nowS();
  const start = t - (t % B);
  if (t - start < 300 || start + B - t < need) offsetS = start + B + 300 - t;
}

// ---------------------------------------------------------------- F8 setup
// A populated DB in the schema that shipped before episodes existed.
const T = nowS();
const B0 = T - (T % B);
{
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, mint TEXT NOT NULL, pool TEXT,
      action TEXT NOT NULL, failed_gate TEXT, score REAL, features_json TEXT NOT NULL,
      outcome_backfill_json TEXT
    );
    CREATE INDEX idx_decisions_mint ON decisions(mint, ts);
  `);
  const ins = legacy.prepare(
    "INSERT INTO decisions (ts, mint, pool, action, failed_gate, score, features_json) VALUES (?, ?, ?, 'skipped', ?, ?, ?)"
  );
  // A: 40 per-sweep rows written before the deploy, in the CURRENT bucket (F7).
  for (let i = 0; i < 40; i++)
    ins.run(B0 + 10 + i, "LEGACY_A", "POOL_A", "fee_tvl_24h", 50 + i, JSON.stringify({ mode: "paper", symbol: "LEGA" }));
  // B: the same key, but written while the book was LIVE (F3).
  ins.run(B0 + 10, "LEGACY_B", "POOL_B", "fee_tvl_24h", 70, JSON.stringify({ mode: "live", symbol: "LEGB" }));
  // C: the same key in the PREVIOUS bucket (F2).
  ins.run(B0 - 100, "LEGACY_C", "POOL_C", "mcap_min", 40, JSON.stringify({ mode: "paper", symbol: "LEGC" }));
  legacy.close();
}

type Check = { id: string; name: string; pass: boolean; detail: unknown };
const checks: Check[] = [];
const check = (id: string, name: string, pass: boolean, detail: unknown = null) => {
  checks.push({ id, name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${name}${pass ? "" : `  ${JSON.stringify(detail)}`}`);
};

const db = await import("../db/db.js");
const { pendingSkips, EPISODE_BUCKET_S } = await import("../sim/skipOutcome.js");
const { scan } = await import("../scanner/scan.js");
if (EPISODE_BUCKET_S !== B) throw new Error(`harness bucket ${B} != EPISODE_BUCKET_S ${EPISODE_BUCKET_S}`);

const conn = db.getDb();

// ---------------------------------------------------------------- F8
{
  const cols = new Set((conn.prepare("PRAGMA table_info(decisions)").all() as Array<{ name: string }>).map((c) => c.name));
  const legacyRows = conn.prepare("SELECT COUNT(*) n, SUM(sweeps) s, COUNT(last_ts) lt FROM decisions").get() as
    { n: number; s: number; lt: number };
  check("F8", "migration adds sweeps/last_ts/score_max to a populated pre-episode DB and keeps its rows",
    cols.has("sweeps") && cols.has("last_ts") && cols.has("score_max") &&
      legacyRows.n === 42 && legacyRows.s === 42 && legacyRows.lt === 0,
    { cols: [...cols], legacyRows });
}

// Expected tallies, keyed exactly as an episode is: mint|pool|gate|mode|bucket.
interface Tally { mint: string; pool: string | null; gate: string; mode: string; bucket: number;
  n: number; rows: number; maxScore: number | null; firstScore: number | null; first: unknown }
const tallies = new Map<string, Tally>();
const keyOf = (mint: string, pool: string | null, gate: string, mode: string, bucket: number) =>
  `${mint}|${pool}|${gate}|${mode}|${bucket}`;
function observe(mint: string, pool: string | null, gate: string, mode: string, ts: number,
  score: number | null, first: unknown, opts: { newRow?: boolean } = {}) {
  const k = keyOf(mint, pool, gate, mode, bucketOf(ts));
  const t = tallies.get(k);
  if (!t) {
    tallies.set(k, { mint, pool, gate, mode, bucket: bucketOf(ts), n: 1, rows: 1, maxScore: score, firstScore: score, first });
    return;
  }
  t.n++;
  if (opts.newRow) t.rows++;
  if (score !== null && (t.maxScore === null || score > t.maxScore)) t.maxScore = score;
}
// The seeded rows are part of the expectation: they are rows, one sweep each.
for (let i = 0; i < 40; i++) observe("LEGACY_A", "POOL_A", "fee_tvl_24h", "paper", B0 + 10 + i, 50 + i, null, { newRow: true });
observe("LEGACY_B", "POOL_B", "fee_tvl_24h", "live", B0 + 10, 70, null);
observe("LEGACY_C", "POOL_C", "mcap_min", "paper", B0 - 100, 40, null);

// ---------------------------------------------------------------- real sweeps
// The legacy twin records every observation the way the old code did — one
// INSERT per rejection per sweep — so F14 compares like with like.
const twin = db.openDb(twinPath);
const twinIns = twin.prepare(
  "INSERT INTO decisions (ts, mint, pool, action, failed_gate, score, features_json) VALUES (?, ?, ?, 'skipped', ?, ?, ?)"
);
const realKeys = new Set<string>();
const sweepLog: Array<{ i: number; ts: number; swept: number; rejected: number; candidates: number }> = [];
let observations = 0;
async function sweep(i: number): Promise<void> {
  const ts = nowS();
  const res = await scan({ withTiming: false });
  for (const c of res.rejected) {
    const gate = c.gateFailures[0]?.gate;
    if (!gate) continue;
    const p = c.pool;
    const features = {
      symbol: c.symbol, gateFailures: c.gateFailures,
      tvlUsd: Math.round(p.tvlUsd), vol30mUsd: Math.round(p.vol30mUsd),
      feeTvl24hPct: +p.feeTvl24hPct.toFixed(2), feeTvl30mPct: +p.feeTvl30mPct.toFixed(2),
      binStep: p.binStep, mcapUsd: Math.round(p.marketCapUsd ?? 0), mode: "paper",
    };
    observe(c.tokenMint, p.address, gate, "paper", ts, c.score, features);
    realKeys.add(keyOf(c.tokenMint, p.address, gate, "paper", bucketOf(ts)));
    twinIns.run(ts, c.tokenMint, p.address, gate, c.score, JSON.stringify(features));
    observations++;
  }
  sweepLog.push({ i, ts, swept: res.sweptPools, rejected: res.rejected.length, candidates: res.candidates.length });
  console.log(`sweep ${i}: ${res.sweptPools} pools, ${res.rejected.length} rejected, ${res.candidates.length} candidates`);
}
for (let i = 1; i <= args.sweeps; i++) {
  await sweep(i);
  if (i < args.sweeps) await new Promise((r) => setTimeout(r, args.gap * 1000));
}

// ---------------------------------------------------------------- synthetic keys
const t1 = nowS();
// F7: three post-deploy rejections of A fold into the FIRST pre-deploy row.
for (const s of [70, 95, 60]) { db.recordSkip("LEGACY_A", "POOL_A", "fee_tvl_24h", s, { symbol: "LEGA" }); observe("LEGACY_A", "POOL_A", "fee_tvl_24h", "paper", t1, s, null); }
// F3: paper rejections of B must not join the live row.
for (let i = 0; i < 2; i++) { db.recordSkip("LEGACY_B", "POOL_B", "fee_tvl_24h", 71, { symbol: "LEGB" }); observe("LEGACY_B", "POOL_B", "fee_tvl_24h", "paper", t1, 71, null); }
// F2: C's previous-bucket row must not absorb this one.
db.recordSkip("LEGACY_C", "POOL_C", "mcap_min", 41, { symbol: "LEGC" }); observe("LEGACY_C", "POOL_C", "mcap_min", "paper", t1, 41, null);
// A NULL pool is still one key (the loop's gates always have a pool; majors errors may not).
for (let i = 0; i < 3; i++) { db.recordSkip("NULLPOOL_D", null, "majors_pool_missing", null, {}); observe("NULLPOOL_D", null, "majors_pool_missing", "paper", t1, null, null); }
// F10/F11: first observation kept, NULL-safe running max.
const seqScores = [null, 60, 75, null, 65];
seqScores.forEach((s, seq) => { db.recordSkip("SEQ_E", "POOL_E", "score_min", s, { seq }); observe("SEQ_E", "POOL_E", "score_min", "paper", t1, s, { seq }); });
// F9: events stay one row each, including telemetry sent through recordSkip by mistake.
for (let i = 0; i < 2; i++) { db.recordDecision("EVENT_F", "POOL_F", "skipped", "open_failed", 80, { code: "c", error: `e${i}` }); observe("EVENT_F", "POOL_F", "open_failed", "paper", t1, 80, null, { newRow: true }); }
for (let i = 0; i < 2; i++) { db.recordSkip("EVENT_G", "POOL_G", "give_back_candidate", null, { i }); observe("EVENT_G", "POOL_G", "give_back_candidate", "paper", t1, null, null, { newRow: true }); }
// F5 (live-book): four bin-rent near misses are four, not one.
for (let i = 0; i < 4; i++) { db.recordSkip("RENT_H", "POOL_H", "bin_rent", 90, { symbol: "RENT", rentBudget: 0.05 }); observe("RENT_H", "POOL_H", "bin_rent", "paper", t1, 90, null); }

// ---------------------------------------------------------------- F2 rollover
offsetS += B;
await sweep(args.sweeps + 1);
const t2 = nowS();
db.recordSkip("LEGACY_A", "POOL_A", "fee_tvl_24h", 99, { symbol: "LEGA" }); observe("LEGACY_A", "POOL_A", "fee_tvl_24h", "paper", t2, 99, null);

// ---------------------------------------------------------------- read back
type Row = { id: number; ts: number; mint: string; pool: string | null; failed_gate: string; score: number | null;
  score_max: number | null; sweeps: number; last_ts: number | null; mode: string; features_json: string };
const rows = conn.prepare(
  `SELECT id, ts, mint, pool, failed_gate, score, score_max, sweeps, last_ts, features_json,
          COALESCE(json_extract(features_json, '$.mode'), 'paper') AS mode
     FROM decisions WHERE action = 'skipped' ORDER BY id`
).all() as Row[];
const byKey = new Map<string, Row[]>();
for (const r of rows) {
  const k = keyOf(r.mint, r.pool, r.failed_gate, r.mode, bucketOf(r.ts));
  byKey.set(k, [...(byKey.get(k) ?? []), r]);
}

// F1 + F7: one row per episode key, except keys that carried pre-deploy or event rows.
{
  const bad: unknown[] = [];
  for (const [k, t] of tallies) {
    const got = byKey.get(k)?.length ?? 0;
    if (got !== t.rows) bad.push({ k, expectedRows: t.rows, got });
  }
  for (const k of byKey.keys()) if (!tallies.has(k)) bad.push({ k, unexpected: true });
  check("F1", "exactly one row per (mint, pool, gate, mode, 6h bucket); pre-deploy and event rows kept as-is",
    bad.length === 0, bad.slice(0, 10));
}
// F4: nothing lost, per key and in total.
{
  const bad: unknown[] = [];
  let expectedTotal = 0, gotTotal = 0;
  for (const [k, t] of tallies) {
    const s = (byKey.get(k) ?? []).reduce((a, r) => a + r.sweeps, 0);
    expectedTotal += t.n; gotTotal += s;
    if (s !== t.n) bad.push({ k, expected: t.n, got: s });
  }
  check("F4", "SUM(sweeps) equals every rejection observed, per episode and in total",
    bad.length === 0 && expectedTotal === gotTotal, { expectedTotal, gotTotal, bad: bad.slice(0, 10) });
}
// F7 detail: the post-deploy rejections of A landed on its FIRST pre-deploy row.
{
  const a = byKey.get(keyOf("LEGACY_A", "POOL_A", "fee_tvl_24h", "paper", bucketOf(t1))) ?? [];
  const first = a[0];
  check("F7", "rejections after the deploy fold into the first pre-deploy row of the same episode",
    a.length === 40 && first?.sweeps === 4 && a.slice(1).every((r) => r.sweeps === 1) && first?.score_max === 95,
    { rows: a.length, first: first && { sweeps: first.sweeps, score_max: first.score_max } });
}
// F2: no row outlives its bucket; the previous bucket's row is untouched; the rollover opened new rows.
{
  const straddle = rows.filter((r) => r.last_ts !== null && bucketOf(r.last_ts) !== bucketOf(r.ts));
  const prevC = byKey.get(keyOf("LEGACY_C", "POOL_C", "mcap_min", "paper", bucketOf(B0 - 100)))?.[0];
  const rolled = [...realKeys].filter((k) => k.endsWith(`|${bucketOf(t2)}`)).length;
  check("F2", "episodes never cross a 6h bucket; a new bucket opens new rows",
    straddle.length === 0 && prevC?.sweeps === 1 && rolled > 0 &&
      (byKey.get(keyOf("LEGACY_A", "POOL_A", "fee_tvl_24h", "paper", bucketOf(t2)))?.length ?? 0) === 1,
    { straddle: straddle.slice(0, 5).map((r) => r.id), prevCSweeps: prevC?.sweeps, rolledKeys: rolled });
}
// F3: live and paper stay apart.
{
  const live = byKey.get(keyOf("LEGACY_B", "POOL_B", "fee_tvl_24h", "live", bucketOf(B0 + 10))) ?? [];
  const paper = byKey.get(keyOf("LEGACY_B", "POOL_B", "fee_tvl_24h", "paper", bucketOf(t1))) ?? [];
  check("F3", "a paper rejection never merges into a live row",
    live.length === 1 && live[0]!.sweeps === 1 && paper.length === 1 && paper[0]!.sweeps === 2,
    { live: live.map((r) => r.sweeps), paper: paper.map((r) => r.sweeps) });
}
// F9: events.
{
  const ev = byKey.get(keyOf("EVENT_F", "POOL_F", "open_failed", "paper", bucketOf(t1))) ?? [];
  const tel = byKey.get(keyOf("EVENT_G", "POOL_G", "give_back_candidate", "paper", bucketOf(t1))) ?? [];
  check("F9", "open_failed and telemetry rows are never merged, even through recordSkip",
    ev.length === 2 && tel.length === 2 && [...ev, ...tel].every((r) => r.sweeps === 1),
    { open_failed: ev.length, telemetry: tel.length });
}
// F10 + F11: anchor preserved, NULL-safe max.
{
  const e = byKey.get(keyOf("SEQ_E", "POOL_E", "score_min", "paper", bucketOf(t1)))?.[0];
  const seq = e ? JSON.parse(e.features_json).seq : undefined;
  check("F10", "the row keeps its FIRST observation's score and features",
    e?.score === null && seq === 0 && e?.sweeps === 5, { score: e?.score, seq, sweeps: e?.sweeps });
  check("F11", "score_max is the max of the non-NULL scores, whatever order the NULLs arrive in",
    e?.score_max === 75, { score_max: e?.score_max });
  const realFirstOk = [...realKeys].every((k) => {
    const t = tallies.get(k)!; const r = byKey.get(k)?.[0];
    return !!r && r.score === t.firstScore && JSON.parse(r.features_json).tvlUsd === (t.first as { tvlUsd: number }).tvlUsd;
  });
  check("F10b", "real scanner episodes keep the first sweep's score and pool numbers", realFirstOk);
}
// F6: sim:skips sees the same episodes, sweep counts and best scores.
{
  const far = t2 + 10 * B;
  const got = pendingSkips(conn, 90, false, 1_000_000, far);
  // sim:skips does not split by mode: fold the expectation the same way.
  const want = new Map<string, { n: number; best: number | null }>();
  for (const t of tallies.values()) {
    if (t.pool === null) continue; // pendingSkips requires a pool
    const k = `${t.mint}|${t.pool}|${t.gate}|${t.bucket}`;
    const w = want.get(k) ?? { n: 0, best: null };
    w.n += t.n;
    if (t.maxScore !== null && (w.best === null || t.maxScore > w.best)) w.best = t.maxScore;
    want.set(k, w);
  }
  const bad: unknown[] = [];
  for (const c of got) {
    const k = `${c.mint}|${c.pool}|${c.failedGate}|${bucketOf(c.ts)}`;
    const w = want.get(k);
    if (!w || w.n !== c.sweeps || w.best !== c.bestScore) bad.push({ k, want: w, got: { sweeps: c.sweeps, best: c.bestScore } });
  }
  check("F6", "sim:skips returns one episode per key with the full sweep count and best score",
    bad.length === 0 && got.length === want.size, { episodes: got.length, expected: want.size, bad: bad.slice(0, 10) });
}
// F5: the dashboard reads rejections, not rows.
{
  const { buildHistorySnapshot } = await import("../../deploy/lib/history-snapshot.mjs" as string);
  const { buildLiveBookSnapshot } = await import("../../deploy/lib/live-book-snapshot.mjs" as string);
  const hist = buildHistorySnapshot(process.cwd(), "30d");
  const byGate = new Map<string, number>();
  let skipped = 0;
  for (const t of tallies.values()) {
    if (t.mode !== "paper" || t.gate.includes("open_failed")) continue;
    skipped += t.n;
    byGate.set(t.gate, (byGate.get(t.gate) ?? 0) + t.n);
  }
  const shareBad = (hist.stats.funnel.skip_share as Array<{ g: string; n: number }>)
    .filter((s) => byGate.get(s.g) !== s.n);
  const activitySkipped = (hist.activity as Array<{ skipped: number }>).reduce((a, d) => a + d.skipped, 0);
  const openFailed = (hist.activity as Array<{ open_failed: number }>).reduce((a, d) => a + d.open_failed, 0);
  check("F5", "history funnel, skip share and daily activity count rejections, not rows",
    hist.stats.funnel.skipped === skipped && shareBad.length === 0 && activitySkipped === skipped && openFailed === 2,
    { funnel: hist.stats.funnel.skipped, expected: skipped, activitySkipped, openFailed, shareBad });
  const live = buildLiveBookSnapshot(process.cwd());
  const nm = live.bin_rent_near_miss?.last_24h;
  check("F5b", "live-book bin-rent near misses count rejections; the recent list shows the episode once",
    nm?.n === 4 && nm?.recent?.length === 1, { n: nm?.n, recent: nm?.recent?.length });
}
// F13: the lookup that runs on every rejection is an index seek.
{
  const plan = (conn.prepare(`EXPLAIN QUERY PLAN ${db.SKIP_EPISODE_LOOKUP_SQL}`).all(
    { mint: "x", pool: "y", gate: "z", mode: "paper", from: 0, to: 1 }) as Array<{ detail: string }>)
    .map((r) => r.detail);
  check("F13", "the per-rejection lookup seeks idx_decisions_mint",
    plan.some((d) => /USING INDEX idx_decisions_mint/.test(d)), plan);
}
// F14: the table shrinks. Measured on the real sweeps only, against the twin.
const size = (() => {
  const realRows = [...realKeys].reduce((a, k) => a + (byKey.get(k)?.length ?? 0), 0);
  const realBytes = [...realKeys].reduce((a, k) => a + (byKey.get(k) ?? []).reduce((b, r) => b + r.features_json.length, 0), 0);
  const tw = twin.prepare("SELECT COUNT(*) n, SUM(LENGTH(features_json)) b FROM decisions").get() as { n: number; b: number };
  const sweepsInFirstBucket = args.sweeps;
  return {
    observations, twinRows: tw.n, episodeRows: realRows, rowRatio: +(tw.n / Math.max(1, realRows)).toFixed(2),
    twinFeatureBytes: tw.b, episodeFeatureBytes: realBytes,
    byteRatio: +(tw.b / Math.max(1, realBytes)).toFixed(2), sweepsInFirstBucket,
  };
})();
check("F14", "episode rows == distinct episodes, and fewer than one-row-per-rejection",
  size.episodeRows === realKeys.size && size.twinRows === observations && size.episodeRows < size.twinRows, size);
// F15: a ceiling that deleting snapshots can satisfy leaves every skip row alone.
{
  const count = () => conn.prepare(
    `SELECT (SELECT COUNT(*) FROM pool_snapshots) snaps,
            (SELECT COUNT(*) FROM decisions WHERE action = 'skipped') skips`
  ).get() as { snaps: number; skips: number };
  const used = () => {
    const pc = conn.pragma("page_count", { simple: true }) as number;
    const fl = conn.pragma("freelist_count", { simple: true }) as number;
    return (pc - fl) * (conn.pragma("page_size", { simple: true }) as number);
  };
  const before = count();
  const ceiling = used() - 50 * 1024; // well inside what ~1,500 snapshot rows occupy
  const pr = db.pruneHistory({ skippedDays: 30, snapshotDays: 3, maxBytes: ceiling });
  const after = count();
  check("F15", "the size ceiling takes snapshots first and leaves rejection history alone while it can",
    pr.mode === "size" && after.snaps < before.snaps && after.skips === before.skips && used() <= ceiling,
    { before, after, mode: pr.mode, ceiling, used: used() });
}
// F12 + F16: a ceiling snapshots cannot satisfy falls through to episode rows
// (oldest-first) and still spares telemetry. Last: it deletes.
{
  const telBefore = (conn.prepare("SELECT COUNT(*) n FROM decisions WHERE failed_gate = 'give_back_candidate'").get() as { n: number }).n;
  const pr = db.pruneHistory({ skippedDays: 30, snapshotDays: 3, maxBytes: 1 });
  const left = conn.prepare(
    `SELECT failed_gate g, COUNT(*) n FROM decisions WHERE action = 'skipped' GROUP BY failed_gate`
  ).all() as Array<{ g: string; n: number }>;
  const nonTel = left.filter((r) => !(db.TELEMETRY_GATES as readonly string[]).includes(r.g));
  check("F12", "past the snapshots, size-mode retention trims episode rows too and spares telemetry",
    pr.mode === "size" && nonTel.length === 0 && left.find((r) => r.g === "give_back_candidate")?.n === telBefore,
    { prune: { mode: pr.mode, decisions: pr.decisions, vacuumed: pr.vacuumed }, left });
}

twin.close();
const ok = checks.every((c) => c.pass);
const report = {
  ok, generatedAt: new Date(realNow()).toISOString(), clockOffsetS: offsetS,
  args: { sweeps: args.sweeps, gap: args.gap }, sweeps: sweepLog, size, checks,
};
writeFileSync(join(args.out, "report.json"), JSON.stringify(report, null, 2));
if (!args.keep) {
  for (const f of ["farmer.db", "farmer.db-wal", "farmer.db-shm", "legacy-twin.db", "legacy-twin.db-wal",
    "legacy-twin.db-shm", "config.toml", ".env", "gmgn-pace.json"])
    rmSync(join(args.out, f), { force: true });
}
console.log(`\n${ok ? "ALL PASS" : "FAILURES"} — ${checks.filter((c) => c.pass).length}/${checks.length} checks. ` +
  `${size.observations} rejections → ${size.episodeRows} rows (${size.rowRatio}x fewer). Report: ${join(args.out, "report.json")}`);
process.exit(ok ? 0 : 1);
