/**
 * E2E: entry protection — `npm run e2e:protection -- [--out <dir>] [--vets 6] [--ticks 1] [--loose] [--keep]`
 *
 * Exercises the 2026-09-27 entry-risk changes against the real world:
 *   1. REGULARS replay — the holder book and ages the bot faced at pos#605
 *      (14:31 UTC, 2026-09-27), rebuilt from on-chain transactions, pushed
 *      through the real GMGN parser and the real verdict.
 *   2. Live reads — a real scanner sweep, real vetting (RugCheck, Jupiter),
 *      and real GMGN holder reads for the top candidates. GMGN discovery and
 *      the GMGN security call are switched off so the only GMGN spend is the
 *      holder reads this change adds (the live bot shares the key's budget).
 *   3. Wiring — the real paper entry pipeline (enterNewPositions) into a
 *      throwaway DB, then every entered decision and position is audited.
 * Writes <out>/report.json and exits non-zero if any check fails. Paper mode:
 * it spends no SOL. Without GMGN_API_KEY in the environment, the live GMGN
 * checks are reported as not exercised rather than passed. `--loose` relaxes
 * the scanner's fee/volume gates in the throwaway config so a quiet market
 * still produces paper entries for the wiring checks (P8-P10); it changes
 * nothing about the risk rules under test.
 *
 * Failure modes, written before the implementation. Each is a check below:
 *  P1  the REGULARS entry is not classified young
 *  P2  the REGULARS whale book does not produce a SKIP
 *  P3  a pool / AMM row in the holders payload is counted as a whale
 *  P4  a SKIP is issued when only our own pool's TVL is known (side pool
 *      understates what a whale can sell into — must downgrade to CUT)
 *  P5  GMGN field names are wrong: every live wallet reads $0 value or no
 *      start time, so the check can never fire
 *  P6  Jupiter's token-wide liquidity is never parsed (always pool fallback)
 *  P7  the whale check throws or blocks when its data is unavailable
 *  P8  an entered decision is missing the risk record
 *  P9  a risk-cut entry exceeds young_max_position_sol or gets a tranche
 *  P10 a tranche opens at or above its primary's bottom bin
 *  P11 (report only) the thresholds fire on most live tokens — miscalibrated
 *  P13 a migrated token's fresh DLMM pool is read as its mint age (WORLD was
 *      vetted as 51 min old, bukangi as 119 min; both were days old)
 *  P12 an established token whose long-term holders sit on large paper gains
 *      is flagged (all-holder profit exceeded 30% of liquidity on 11/16 live
 *      tokens when measured — only FRESH wallets may count)
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface Args { out: string; vets: number; ticks: number; loose: boolean; keep: boolean }
function parseArgs(argv: string[]): Args {
  const a: Args = { out: join(tmpdir(), "dlmmbot-e2e-protection"), vets: 6, ticks: 1, loose: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i] ?? "";
    switch (argv[i]) {
      case "--out": a.out = next(); break;
      case "--vets": a.vets = Number(next()); break;
      case "--ticks": a.ticks = Number(next()); break;
      case "--loose": a.loose = true; break;
      case "--keep": a.keep = true; break;
      default: throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  a.out = resolve(a.out);
  return a;
}

const args = parseArgs(process.argv.slice(2));
rmSync(args.out, { recursive: true, force: true });
mkdirSync(args.out, { recursive: true });

// Isolate before any module that reads the environment is imported.
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
process.env.FARMER_DB_PATH = join(args.out, "farmer.db");
process.env.FARMER_CONFIG_PATH = join(args.out, "config.toml");
process.env.FARMER_ENV_PATH = join(args.out, ".env");
process.env.FARMER_MODE = "paper";
writeFileSync(
  process.env.FARMER_CONFIG_PATH,
  readFileSync("config.toml", "utf8")
    .replace(/^(\[gmgn\][^\n]*\n)enabled = true/m, "$1enabled = false")
    .replace(/^gmgn_security_enabled = true/m, "gmgn_security_enabled = false")
    .replace(/^mode = "live"/m, 'mode = "paper"')
    .replace(/^fee_tvl_24h_min_pct = .*$/m, args.loose ? "fee_tvl_24h_min_pct = 1" : "$&")
    .replace(/^fee_tvl_30m_daily_min_pct = .*$/m, args.loose ? "fee_tvl_30m_daily_min_pct = 1" : "$&")
    .replace(/^vol_30m_min_usd = .*$/m, args.loose ? "vol_30m_min_usd = 2000" : "$&")
    .replace(/^vol_trend_min = .*$/m, args.loose ? "vol_trend_min = 0" : "$&"),
);
// The key (if any) stays in this process's environment only — never on disk.
writeFileSync(process.env.FARMER_ENV_PATH, "FARMER_MODE=paper\n");

type Check = { id: string; name: string; pass: boolean | null; detail: unknown };
const checks: Check[] = [];
const check = (id: string, name: string, pass: boolean | null, detail: unknown = null) => {
  checks.push({ id, name, pass, detail });
  const tag = pass === null ? "SKIP" : pass ? "PASS" : "FAIL";
  console.log(`${tag}  ${id.padEnd(4)} ${name}${pass === false ? `  ${JSON.stringify(detail)}` : ""}`);
};

const { config, env } = await import("../config.js");
const risk = await import("../risk/entryRisk.js");
const { scan } = await import("../scanner/scan.js");
const { vetToken } = await import("../vetting/vet.js");
const db = await import("../db/db.js");
const { PaperExecutor } = await import("../executor/paper.js");
const { enterNewPositions, resetManagerStateForTests } = await import("../manager/loop.js");

// ------------------------------------------------------------- 1. REGULARS
// pos#605 entered 2026-09-27 14:31:42 UTC. Token price then ~$4.2e-4
// (PumpSwap/Meteora 1m closes), supply 959,276,204. Wallet books from
// getTransaction pre/post balances; cost from each buy's candle price.
{
  const t605 = Math.floor(Date.parse("2026-09-27T14:31:42Z") / 1000);
  const px = 4.2e-4;
  const supply = 959_276_204;
  const pay = (tokens: number, costUsd: number, startIso: string, address: string) => ({
    address, addr_type: 0, exchange: "",
    amount_percentage: tokens / supply,
    usd_value: tokens * px,
    unrealized_profit: tokens * px - costUsd,
    start_holding_at: Math.floor(Date.parse(startIso) / 1000),
  });
  // CE3e4…: 16.1M @1.2e-4 (13:01), 15.8M @1.9e-4 (13:31), 1.1M @2.0e-4 (13:36), 6.0M @4.5e-4 (13:57)
  const ce = pay(39_001_399, 16.1e6 * 1.2e-4 + 15.8e6 * 1.9e-4 + 1.1e6 * 2.0e-4 + 6.0e6 * 4.5e-4,
    "2026-09-27T13:01:55Z", "CE3e4vsESj3V7cneupLLcP1HhNjtAvzJaGr9m5xXkjAE");
  // 3SqHK8…: 27,996,600 @1.2e-4 (13:03)
  const sq = pay(27_996_600, 27_996_600 * 1.2e-4, "2026-09-27T13:03:07Z", "3SqHK8GdsJ8RQvU8hbj8ejJNa8sH4ekkTcUNEWiM1mHG");
  // PumpSwap pool vault: the largest holder, sitting on "profit" — must be dropped.
  const vault = { address: "6UNreUfUuNwX9EorTRcLgmJ29nH6gCVuQsJogsq569eN", addr_type: 2, exchange: "pump_amm",
    amount_percentage: 0.0786, usd_value: 0.0786 * supply * px, unrealized_profit: 25_000, start_holding_at: t605 - 5000 };
  const payload = JSON.stringify({ data: { list: [vault, ce, sq] } });
  const rows = risk.parseHolderRows(payload, "3ktbi7CghEsnKrwpfgnDqYxbsscV1Nodpr3dSBoBbMfX");

  const young = risk.classifyYoung(148, Date.parse("2026-09-27T14:02:23Z"), "rugcheck", t605 * 1000);
  check("P1", "REGULARS (token 148 min old) is classified young", young.young && young.source === "mint", young);

  // Token-wide liquidity at entry: our pool $12.1k + PumpSwap ~$46k.
  const liq = 58_000;
  const read = risk.assessWhales(rows, liq, "token", t605);
  check("P2", "REGULARS whale book at entry → SKIP", read.verdict === "skip", {
    verdict: read.verdict, reason: read.reason, freshWhales: read.freshWhales, overhangFrac: read.overhangFrac,
  });
  check("P3", "the PumpSwap vault row is not treated as a wallet",
    rows.length === 2 && !rows.some((r) => r.address === vault.address), rows.map((r) => r.address));
  const poolOnly = risk.assessWhales(rows, 12_088, "pool", t605);
  check("P4", "with only our pool's TVL known the SKIP downgrades to CUT", poolOnly.verdict === "cut",
    { verdict: poolOnly.verdict, reason: poolOnly.reason });
  // P12: an established token — big holders bought days ago at a fraction of
  // today's price. Paper gains far above liquidity, none of them fresh.
  const old = JSON.stringify({ data: { list: [
    { address: "OLD1111111111111111111111111111111111111111", addr_type: 0, exchange: "", amount_percentage: 0.06,
      usd_value: 90_000, unrealized_profit: 80_000, start_holding_at: t605 - 4 * 86_400 },
    { address: "OLD2222222222222222222222222222222222222222", addr_type: 0, exchange: "", amount_percentage: 0.04,
      usd_value: 60_000, unrealized_profit: 50_000, start_holding_at: t605 - 9 * 86_400 },
  ] } });
  const est = risk.assessWhales(risk.parseHolderRows(old, null), liq, "token", t605);
  check("P12", "long-term holders' paper gains (2.2x liquidity) do not trigger the check", est.verdict === "clear",
    { verdict: est.verdict, reason: est.reason, overhangFrac: est.overhangFrac });
  const nothing = risk.assessWhales([], liq, "token", t605);
  const noLiq = risk.assessWhales(rows, null, null, t605);
  check("P7", "no holders / no liquidity → unavailable, never a block",
    nothing.verdict === "unavailable" && noLiq.verdict === "unavailable", { nothing: nothing.reason, noLiq: noLiq.reason });
}

// ------------------------------------------------------------- 1b. mint age
// Real vetting of two migrated tokens, handed a pool created minutes ago —
// the shape that made the pool-age fallback misread them.
{
  const fresh = Date.now() - 30 * 60_000;
  const ages: Array<Record<string, unknown>> = [];
  for (const [sym, mint, minMin] of [
    ["WORLD", "CC5D6puFmcsnGaJh7kNXeAcRpL2SZzQfoQezvx45uKjt", 1_300],
    ["bukangi", "3iUTyNYW6xKv5kZUjtbrEDTsuJTrSVwvB3bQtxkLpump", 9_000],
  ] as const) {
    try {
      const v = await vetToken(mint, fresh);
      ages.push({ sym, ageMin: v.facts.tokenAgeMinutes, source: v.facts.tokenAgeSource, ok:
        (v.facts.tokenAgeMinutes ?? 0) >= minMin && v.facts.tokenAgeSource !== "pool" });
    } catch (e) {
      ages.push({ sym, error: (e as Error).message, ok: false });
    }
  }
  check("P13", "migrated tokens vet with their mint age, not their fresh pool's", ages.every((a) => a.ok), ages);
}

// ------------------------------------------------------------- 2. live reads
const gmgnKey = !!env().gmgnApiKey;
const live: Array<Record<string, unknown>> = [];
let scanOk = false;
let scanInfo: unknown = null;
try {
  const { candidates, rejected } = await scan();
  scanOk = true;
  // Candidates first; when the market gives none, the highest-scored rejects
  // (by TVL) still exercise vetting and the GMGN parse, which do not depend
  // on a pool passing the scanner gates.
  const seen = new Set<string>();
  const byTvl = [...rejected].filter((c) => c.pool.tvlUsd >= 10_000).sort((a, b) => b.score - a.score);
  const picks = [...candidates, ...byTvl]
    .filter((c) => !seen.has(c.tokenMint) && (seen.add(c.tokenMint), true)).slice(0, args.vets);
  scanInfo = { candidates: candidates.length, rejected: rejected.length, picked: picks.map((c) => c.symbol) };
  for (const cand of picks) {
    const poolCreatedAtMs = cand.pool.createdAt ? Date.parse(cand.pool.createdAt) : null;
    let vet;
    try {
      vet = await vetToken(cand.tokenMint, poolCreatedAtMs);
    } catch (e) {
      live.push({ symbol: cand.symbol, vetError: (e as Error).message });
      continue;
    }
    const young = risk.classifyYoung(vet.facts.tokenAgeMinutes, poolCreatedAtMs, vet.facts.tokenAgeSource);
    const rows = gmgnKey ? await risk.holderRowsFor(cand.tokenMint, cand.pool.address) : null;
    let whale;
    try {
      whale = await risk.whaleCheck(cand.tokenMint, cand.pool.address, vet.facts.jupLiquidityUsd, cand.pool.tvlUsd, gmgnKey);
    } catch (e) {
      whale = { threw: (e as Error).message };
    }
    live.push({
      symbol: cand.symbol, mint: cand.tokenMint, verdictVet: vet.verdict,
      tokenAgeMin: vet.facts.tokenAgeMinutes, young: young.young,
      mcapUsd: cand.pool.marketCapUsd, poolTvlUsd: cand.pool.tvlUsd, jupLiquidityUsd: vet.facts.jupLiquidityUsd ?? null,
      holderRows: rows?.length ?? null,
      rowsWithValue: rows?.filter((r) => r.usdValue > 0).length ?? null,
      rowsWithStart: rows?.filter((r) => r.startHoldingAt != null).length ?? null,
      whale,
    });
  }
} catch (e) {
  live.push({ scanError: (e as Error).message });
}
const vetted = live.filter((l) => "verdictVet" in l);
check("P6", "Jupiter token-wide liquidity parsed for at least one live token",
  vetted.length ? vetted.some((l) => typeof l.jupLiquidityUsd === "number" && (l.jupLiquidityUsd as number) > 0) : null,
  vetted.map((l) => ({ symbol: l.symbol, jup: l.jupLiquidityUsd, pool: l.poolTvlUsd })));
check("P7b", "live whale check never throws",
  vetted.length ? vetted.every((l) => !(l.whale as { threw?: string }).threw) : null,
  vetted.map((l) => l.whale));
const read = vetted.filter((l) => (l.holderRows as number | null) != null && (l.holderRows as number) > 0);
check("P5", "GMGN holder fields parse: wallets carry a USD value and a start time",
  !gmgnKey || !vetted.length ? null : read.length ? read.every((l) => (l.rowsWithValue as number) > 0 && (l.rowsWithStart as number) > 0) : false,
  gmgnKey ? vetted.map((l) => ({ symbol: l.symbol, rows: l.holderRows, withValue: l.rowsWithValue, withStart: l.rowsWithStart }))
    : "GMGN_API_KEY not set — not exercised");
const verdicts = vetted.map((l) => (l.whale as { verdict?: string }).verdict ?? "error");
const fired = verdicts.filter((v) => v === "skip" || v === "cut").length;
const assessed = verdicts.filter((v) => v !== "unavailable" && v !== "error").length;
check("P11", `whale check fired on ${fired}/${assessed} assessed live tokens (report only)`, null,
  { verdicts, young: vetted.filter((l) => l.young).length, of: vetted.length });

// ------------------------------------------------------------- 3. wiring
resetManagerStateForTests();
const exec = new PaperExecutor();
for (let t = 0; t < args.ticks; t++) {
  try {
    await enterNewPositions(exec);
  } catch (e) {
    check("P8x", "enterNewPositions threw", false, (e as Error).message);
  }
}
const conn = db.getDb();
const entered = conn.prepare(
  "SELECT d.features_json f, p.id pid, p.entry_sol, p.min_bin_id, p.max_bin_id FROM decisions d " +
  "JOIN positions p ON p.token_mint = d.mint AND p.tranche_of IS NULL AND abs(p.entry_ts - d.ts) <= 10 " +
  "WHERE d.action = 'entered' AND d.features_json NOT LIKE '%\"tranche\":true%'"
).all() as Array<{ f: string; pid: number; entry_sol: number; min_bin_id: number; max_bin_id: number }>;
const tranches = conn.prepare(
  "SELECT t.id, t.tranche_of, t.min_bin_id tmin, t.max_bin_id tmax, p.min_bin_id pmin FROM positions t " +
  "JOIN positions p ON p.id = t.tranche_of"
).all() as Array<{ id: number; tranche_of: number; tmin: number; tmax: number; pmin: number }>;
const skipsWhale = conn.prepare("SELECT COUNT(*) n FROM decisions WHERE failed_gate = 'whale_overhang'").get() as { n: number };
const feats = entered.map((e) => ({ ...e, f: JSON.parse(e.f) as { risk?: { riskCut: boolean; young: { young: boolean }; whale: { verdict: string } } } }));
const cap = config().gates.young_max_position_sol ?? risk.YOUNG_DEFAULTS.maxPositionSol;
check("P8", "every entered decision carries the risk record",
  feats.length ? feats.every((e) => e.f.risk && typeof e.f.risk.riskCut === "boolean" && e.f.risk.whale?.verdict) : null,
  feats.length ? feats.map((e) => ({ pid: e.pid, risk: e.f.risk ?? null })) : "no entries this run");
const cut = feats.filter((e) => e.f.risk?.riskCut);
check("P9", `risk-cut entries stay under ${cap} SOL and get no tranche`,
  cut.length ? cut.every((e) => e.entry_sol <= cap + 1e-9 && !tranches.some((t) => t.tranche_of === e.pid)) : null,
  cut.length ? cut.map((e) => ({ pid: e.pid, size: e.entry_sol, tranche: tranches.some((t) => t.tranche_of === e.pid) }))
    : "no risk-cut entries this run");
check("P10", "tranches sit strictly below their primary",
  tranches.length ? tranches.every((t) => t.tmax < t.pmin) : null,
  tranches.length ? tranches : "no tranches this run");

// ------------------------------------------------------------- report
const failed = checks.filter((c) => c.pass === false);
const report = {
  ok: failed.length === 0,
  generatedAt: new Date().toISOString(),
  gmgnKeyPresent: gmgnKey, scanOk, scanInfo,
  thresholds: {
    young_max_age_min: config().gates.young_max_age_min, young_size_mult: config().gates.young_size_mult,
    young_max_position_sol: cap, whale_skip_liquidity_frac: config().gates.whale_skip_liquidity_frac,
    whale_cut_fresh_overhang_frac: config().gates.whale_cut_fresh_overhang_frac,
    whale_fresh_min_profit_mult: config().gates.whale_fresh_min_profit_mult,
  },
  live, entries: feats.map((e) => ({ pid: e.pid, size: e.entry_sol, bins: [e.min_bin_id, e.max_bin_id], risk: e.f.risk })),
  tranches, whaleSkips: skipsWhale.n, checks,
};
writeFileSync(join(args.out, "report.json"), JSON.stringify(report, null, 2));
if (!args.keep) {
  for (const f of ["farmer.db", "farmer.db-wal", "farmer.db-shm", "config.toml", ".env", "gmgn-pace.json"])
    rmSync(join(args.out, f), { force: true });
}
const exercised = checks.filter((c) => c.pass !== null);
console.log(`\n${failed.length ? "FAILURES" : "ALL PASS"} — ${exercised.filter((c) => c.pass).length}/${exercised.length} exercised checks ` +
  `(${checks.length - exercised.length} not exercised). Report: ${join(args.out, "report.json")}`);
process.exit(failed.length ? 1 : 0);
