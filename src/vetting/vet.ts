import { config } from "../config.js";
import { blacklist, getDb, isBlacklisted, now } from "../db/db.js";
import type { GateFailure, VetResult } from "../types.js";
import { fetchTokenFacts } from "./onchain.js";
import { creatorRugCount, fetchReport, insiderNetworkPct } from "./rugcheck.js";

// STRATEGY.md §2.2 — token hard gates. Fresh RPC facts are authoritative;
// RugCheck is a veto layer (cached, but sees insider networks & creator
// history we can't compute cheaply yet).

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export async function vetToken(mint: string, tokenCreatedAtMs: number | null): Promise<VetResult> {
  const v = config().vetting;
  const hard: GateFailure[] = [];
  const fail = (gate: string, value: unknown, limit: unknown) =>
    hard.push({ gate, value: String(value), limit: String(limit) });

  const facts: VetResult["facts"] = {
    mintAuthority: null, freezeAuthority: null, tokenProgram: "unknown",
    token2022Extensions: [], singleHolderPct: null, top10Pct: null,
    holderCount: null, insiderClusterPct: null, creatorAddress: null,
    creatorRugCount: null, rugcheckScoreNormalised: null, rugcheckRisks: [],
    launchpad: null, tokenAgeMinutes: null,
  };

  const blReason = isBlacklisted(mint);
  if (blReason) {
    fail("blacklist", blReason, "not blacklisted");
    return { mint, verdict: "fail", hardFailures: hard, softScore: 0, facts };
  }

  // --- fresh on-chain layer ---
  try {
    const oc = await fetchTokenFacts(mint);
    facts.mintAuthority = oc.mintAuthority;
    facts.freezeAuthority = oc.freezeAuthority;
    facts.tokenProgram = oc.tokenProgram;
    facts.token2022Extensions = oc.token2022Extensions;

    if (oc.mintAuthority) fail("mint_authority", oc.mintAuthority, "revoked");
    if (oc.freezeAuthority) fail("freeze_authority", oc.freezeAuthority, "revoked");
    const badExt = oc.token2022Extensions.filter(
      (e) => !v.allow_token2022_extensions.some((ok) => e.toLowerCase().includes(ok))
    );
    if (badExt.length) fail("token2022_extensions", badExt.join(","), v.allow_token2022_extensions.join(","));
  } catch (e) {
    fail("onchain_error", (e as Error).message, "reachable RPC");
    return { mint, verdict: "error", hardFailures: hard, softScore: 0, facts };
  }

  // --- RugCheck veto layer (graceful when rate-limited: null = skip, don't fail) ---
  const report = await fetchReport(mint);
  if (report) {
    facts.rugcheckScoreNormalised = report.score_normalised;
    facts.rugcheckRisks = report.risks.map((r) => ({ name: r.name, score: r.score, level: r.level }));
    facts.creatorAddress = report.creator ?? null;
    facts.launchpad = report.launchpad?.platform ?? null;
    facts.holderCount = report.totalHolders;

    if (report.rugged) fail("rugged_flag", "true", "false");
    if (report.score_normalised >= v.rugcheck_veto_normalised)
      fail("rugcheck_veto", report.score_normalised, `< ${v.rugcheck_veto_normalised}`);

    const rugs = creatorRugCount(report);
    facts.creatorRugCount = rugs;
    if (rugs > 0) {
      fail("creator_rug_history", rugs, "0");
      if (report.creator) blacklist(report.creator, "creator", `rug history x${rugs}`);
    }

    // Holder concentration from RugCheck topHolders (already excludes labeled AMMs).
    const holders = report.topHolders ?? [];
    if (holders.length) {
      const single = Math.max(...holders.map((h) => h.pct));
      const top10 = holders.slice(0, 10).reduce((s, h) => s + h.pct, 0);
      facts.singleHolderPct = single;
      facts.top10Pct = top10;
      if (single > v.single_holder_max_pct) fail("single_holder", single.toFixed(1), v.single_holder_max_pct);
      if (top10 > v.top10_max_pct) fail("top10_holders", top10.toFixed(1), v.top10_max_pct);
    }

    const insiderPct = insiderNetworkPct(report, null);
    if (insiderPct !== null) {
      facts.insiderClusterPct = insiderPct;
      if (insiderPct > v.insider_cluster_max_pct)
        fail("insider_clusters", insiderPct.toFixed(1), v.insider_cluster_max_pct);
    }
  }
  // TODO(phase 2): when RugCheck is unavailable, compute holder concentration
  // from onchain.largestAccounts minus our own knownAccounts registry, and
  // creator history from our creators table. Until then a missing report means
  // weaker vetting — reflected in softScore below.

  // --- age gates ---
  if (tokenCreatedAtMs) {
    const ageMin = (Date.now() - tokenCreatedAtMs) / 60_000;
    facts.tokenAgeMinutes = Math.round(ageMin);
    if (ageMin < v.age_min_minutes) fail("age_min", `${ageMin.toFixed(0)}m`, `${v.age_min_minutes}m`);
    if (ageMin > v.age_max_days * 1440) fail("age_max", `${(ageMin / 1440).toFixed(1)}d`, `${v.age_max_days}d`);
  }

  // --- soft score (0-100): holder quality when we have data, penalty when blind ---
  let soft = 50;
  if (report) {
    soft = 100;
    if (facts.top10Pct !== null) soft -= clamp01(facts.top10Pct / v.top10_max_pct) * 30;
    if (facts.singleHolderPct !== null) soft -= clamp01(facts.singleHolderPct / v.single_holder_max_pct) * 30;
    soft -= clamp01(report.score_normalised / v.rugcheck_veto_normalised) * 25;
    if ((facts.holderCount ?? 0) > 1000) soft += 5;
    soft = Math.max(0, Math.min(100, soft));
  }

  // Persist token + vet snapshot.
  const db = getDb();
  db.prepare(
    `INSERT INTO tokens (mint, symbol, creator, launchpad, first_seen, last_vet_json)
     VALUES (?, NULL, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET creator=excluded.creator, launchpad=excluded.launchpad, last_vet_json=excluded.last_vet_json`
  ).run(mint, facts.creatorAddress, facts.launchpad, now(), JSON.stringify(facts));

  const verdict = hard.length === 0 ? "pass" : "fail";
  if (verdict === "fail" && hard.some((h) => h.gate !== "age_min")) {
    // age_min failures are retryable; everything else parks the token for 24h
    blacklist(mint, "token", hard.map((h) => h.gate).join(","), 24);
  }
  return { mint, verdict, hardFailures: hard, softScore: soft, facts };
}
