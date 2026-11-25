/**
 * E2E: insider-cluster score — `npm run e2e:clusters -- [mint ...] [--n 3] [--out <dir>] [--keep]`
 *
 * Runs the REAL vet (RPC + RugCheck + Jupiter) on live tokens into a throwaway
 * DB, then re-derives the cluster score from the raw sources and checks the
 * two agree. With no mints given it takes the --n busiest SOL pools from a
 * live Meteora sweep. Needs RPC_URL in the environment. Paper mode, GMGN off:
 * it spends no money. It makes one RugCheck call per token on the free quota
 * the live bot shares from the same IP, so keep --n small.
 * Writes <out>/report.json and exits non-zero if any check fails.
 *
 * Failure modes, written before the implementation. Each is a check below:
 *  F1 the gate value is not what RugCheck's networks hold NOW (it is the
 *     amount they once received, or outside 0–100)
 *  F2 the largest network or the old gross figure is missing from the facts,
 *     or the largest network exceeds the total
 *  F3 the facts do not say which source produced the score
 *  F4 the RPC scan scores a lone holder as a cluster
 *  F5 the RPC scan reports a clean 0 when most holders were out of reach, is
 *     blind when they were not, or runs past its 10s budget
 *  F6 a version-1 transaction drops the wallet it belongs to
 *  F7 the new facts are not persisted with the vet
 *  F8 Jupiter reports a bundler share and the vet drops it
 */
import Database from "better-sqlite3";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SOL = "So11111111111111111111111111111111111111112";
const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv.splice(i, 2)[1]; };
const out = resolve(opt("--out") ?? join(tmpdir(), "dlmmbot-e2e-clusters"));
const n = Number(opt("--n") ?? 3);
const keep = argv.includes("--keep") && argv.splice(argv.indexOf("--keep"), 1).length > 0;
if (!process.env.RPC_URL) throw new Error("RPC_URL must be set");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// Isolate before any module that reads the environment is imported.
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
process.env.FARMER_DB_PATH = join(out, "farmer.db");
process.env.FARMER_CONFIG_PATH = join(out, "config.toml");
process.env.FARMER_ENV_PATH = join(out, ".env");
process.env.FARMER_MODE = "paper";
writeFileSync(
  process.env.FARMER_CONFIG_PATH,
  readFileSync("config.toml", "utf8")
    .replace(/^(\[gmgn\][^\n]*\n)enabled = true/m, "$1enabled = false")
    .replace(/^mode = "live"/m, 'mode = "paper"'),
);
writeFileSync(process.env.FARMER_ENV_PATH, "FARMER_MODE=paper\n");

const { PublicKey } = await import("@solana/web3.js");
const { config } = await import("../config.js");
const { vetToken } = await import("../vetting/vet.js");
const { fetchReport } = await import("../vetting/rugcheck.js");
const { fetchTokenFacts, connection } = await import("../vetting/onchain.js");
const { holdersExcludingAmms } = await import("../vetting/holders.js");
const { detectInsiderClusterPct, funderFromParsedTxs, parsedTxs } = await import("../vetting/clusters.js");

type Check = { id: string; mint: string; name: string; pass: boolean; detail: unknown };
const checks: Check[] = [];
const check = (id: string, mint: string, name: string, pass: boolean, detail: unknown = null) => {
  checks.push({ id, mint, name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id.padEnd(3)} ${mint.slice(0, 6)}  ${name}${pass ? "" : `  ${JSON.stringify(detail)}`}`);
};
const near = (a: number, b: number) => Math.abs(a - b) <= 0.01 + Math.abs(b) * 0.001;

let mints = argv;
if (!mints.length) {
  const { sweepPools } = await import("../scanner/meteora.js");
  const pools = (await sweepPools()).filter((p) => p.mintY === SOL).sort((a, b) => b.vol24hUsd - a.vol24hUsd);
  mints = [...new Set(pools.map((p) => p.mintX))].slice(0, n);
}

const c = connection();
const tokens: unknown[] = [];
let v1Seen = 0;

for (const mint of mints) {
  const vet = await vetToken(mint, null);
  const f = vet.facts;
  const report = await fetchReport(mint); // cached: the body the vet just read
  const oc = await fetchTokenFacts(mint);
  const nets = report?.insiderNetworks ?? [];

  if (nets.length) {
    const held = (nets.reduce((s, x) => s + (x.currentHolding ?? x.tokenAmount), 0) / oc.supplyRaw) * 100;
    const gross = (nets.reduce((s, x) => s + x.tokenAmount, 0) / oc.supplyRaw) * 100;
    check("F1", mint, "gate value = supply % the networks hold now",
      f.insiderSource === "rugcheck" && f.insiderClusterPct !== null && near(f.insiderClusterPct, held) && held >= 0 && held <= 100,
      { fact: f.insiderClusterPct, heldNow: held, onceReceived: gross });
    check("F2", mint, "largest network and gross figure recorded, largest <= total",
      f.insiderNetworks === nets.length && f.insiderGrossPct !== undefined && near(f.insiderGrossPct, gross)
        && f.insiderLargestPct !== undefined && f.insiderLargestPct <= (f.insiderClusterPct ?? 0) + 1e-9,
      { largest: f.insiderLargestPct, gross: f.insiderGrossPct, networks: f.insiderNetworks });
  }
  check("F3", mint, "a score always names its source", f.insiderClusterPct === null || f.insiderSource !== undefined,
    { pct: f.insiderClusterPct, source: f.insiderSource });

  // The RPC scan only decides the gate when RugCheck reports no networks, so run it directly on every token.
  const shares = (await holdersExcludingAmms(oc.largestAccounts)).slice(0, 12);
  const t0 = Date.now();
  const rpcPct = await detectInsiderClusterPct(shares);
  const ms = Date.now() - t0;
  // A holder is in reach when one page of signatures gets back to its first transactions.
  let inReach = 0, firstTxsRead = 0;
  for (const h of shares) {
    const sigs = await c.getSignaturesForAddress(new PublicKey(h.owner), { limit: 1000 });
    if (!sigs.length || sigs.length >= 1000) continue;
    inReach++;
    const first = await parsedTxs(c, sigs.slice(-3).map((s) => s.signature));
    if (first.every((t) => t !== null)) firstTxsRead++;
  }
  const smallestTwo = shares.map((s) => s.pct).sort((a, b) => a - b).slice(0, 2).reduce((s, x) => s + x, 0);
  check("F4", mint, "RPC scan: a cluster is two or more holders",
    rpcPct === null || rpcPct === 0 || (shares.length >= 2 && rpcPct >= smallestTwo - 1e-9 && !shares.some((s) => Math.abs(s.pct - rpcPct) < 1e-9)),
    { rpcPct, holders: shares.map((s) => +s.pct.toFixed(3)) });
  check("F5", mint, "RPC scan: unknown exactly when most holders are out of reach, inside 10s",
    ms <= 10_500 && firstTxsRead === inReach && (rpcPct === null) === (inReach * 2 < shares.length),
    { ms, rpcPct, holders: shares.length, inReach, firstTxsRead });

  // F6: find a real version-1 transaction among the holders' recent ones.
  let v1: { wallet: string; signature: string; oldCallRejects: boolean; read: boolean } | null = null;
  for (const h of shares.slice(0, 6)) {
    const sigs = (await c.getSignaturesForAddress(new PublicKey(h.owner), { limit: 12 })).map((s) => s.signature);
    const txs = await parsedTxs(c, sigs);
    const i = txs.findIndex((t) => (t as { version?: unknown } | null)?.version === 1);
    if (i < 0) continue;
    const oldCallRejects = await c.getParsedTransaction(sigs[i]!, { maxSupportedTransactionVersion: 0 }).then(() => false, () => true);
    let read = (txs[i]?.transaction.message.accountKeys.length ?? 0) > 0;
    try { funderFromParsedTxs(h.owner, [txs[i]!]); } catch { read = false; }
    v1 = { wallet: h.owner, signature: sigs[i]!, oldCallRejects, read };
    v1Seen++;
    break;
  }
  if (v1) check("F6", mint, "a version-1 transaction is read, not dropped", v1.read, v1);

  const stored = new Database(process.env.FARMER_DB_PATH!, { readonly: true });
  const row = stored.prepare("SELECT last_vet_json FROM tokens WHERE mint = ?").get(mint) as { last_vet_json: string } | undefined;
  stored.close();
  const saved = row ? JSON.parse(row.last_vet_json) as typeof f : null;
  check("F7", mint, "the facts are persisted with the vet",
    saved !== null && saved.insiderSource === f.insiderSource && saved.insiderLargestPct === f.insiderLargestPct
      && saved.insiderGrossPct === f.insiderGrossPct && saved.jupBundlerHoldingPct === f.jupBundlerHoldingPct,
    { saved: saved && { source: saved.insiderSource, largest: saved.insiderLargestPct } });

  const jupRaw = await fetch(`${config().apis.jup_datapi}/v1/assets/search?query=${mint}`, { signal: AbortSignal.timeout(8_000) })
    .then((r) => r.json() as Promise<Array<{ id?: string; audit?: { bundlerStats?: { holdingPct?: unknown } } }>>)
    .catch(() => null);
  const rawBundler = jupRaw?.find((a) => a.id === mint)?.audit?.bundlerStats?.holdingPct;
  if (typeof rawBundler === "number" && f.jupOrganicScore != null)
    check("F8", mint, "Jupiter's bundler share is kept", typeof f.jupBundlerHoldingPct === "number", { raw: rawBundler, fact: f.jupBundlerHoldingPct });

  tokens.push({
    mint, verdict: vet.verdict, hardFailures: vet.hardFailures,
    insider: {
      gatePct: f.insiderClusterPct, source: f.insiderSource ?? null, grossPct: f.insiderGrossPct ?? null,
      largestPct: f.insiderLargestPct ?? null, networks: f.insiderNetworks ?? null,
    },
    rpcScan: { pct: rpcPct, ms, holders: shares.length },
    jupBundler: { holdingPct: f.jupBundlerHoldingPct ?? null, holdingPctAth: f.jupBundlerHoldingPctAth ?? null },
    singleHolderPct: f.singleHolderPct, top10Pct: f.top10Pct, tokenAgeMinutes: f.tokenAgeMinutes,
  });
}

const failed = checks.filter((x) => !x.pass);
writeFileSync(join(out, "report.json"), JSON.stringify({
  ranAt: new Date().toISOString(), mints, passed: checks.length - failed.length, failed: failed.length,
  v1TransactionsExercised: v1Seen, tokens, checks,
}, null, 2));
if (!keep) for (const f of ["farmer.db", "farmer.db-wal", "farmer.db-shm"]) rmSync(join(out, f), { force: true });
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed — ${join(out, "report.json")}`);
process.exit(failed.length ? 1 : 0);
