import { config } from "../config.js";
import { blacklist, getDb, isBlacklisted, now } from "../db/db.js";
import type { GateFailure, VetResult } from "../types.js";
import { fetchTokenFacts, type OnchainTokenFacts } from "./onchain.js";
import { creatorRugCount, fetchReport, insiderNetworkPct } from "./rugcheck.js";
import { jupAsset } from "./jupdata.js";
import { tokenSecurity, tokenTraderTags } from "../scanner/gmgn.js";
import { concentrationFromShares, holdersExcludingAmms } from "./holders.js";
import { detectInsiderClusterPct } from "./clusters.js";
import type { HolderShare } from "./knownAccounts.js";

// STRATEGY.md §2.2 — token hard gates. Fresh RPC facts are authoritative;
// RugCheck is a veto layer (cached, but sees insider networks & creator
// history we can't always compute cheaply).

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function localCreatorRugCount(creator: string): number {
  const row = getDb()
    .prepare("SELECT rug_count FROM creators WHERE address = ?")
    .get(creator) as { rug_count: number } | undefined;
  return row?.rug_count ?? 0;
}

function applyHolderGates(
  shares: { single: number; top10: number },
  facts: VetResult["facts"],
  fail: (gate: string, value: unknown, limit: unknown) => void,
  v: ReturnType<typeof config>["vetting"],
): void {
  facts.singleHolderPct = shares.single;
  facts.top10Pct = shares.top10;
  if (v.holder_gate_enabled === false) return;
  if (shares.single > v.single_holder_max_pct)
    fail("single_holder", shares.single.toFixed(1), v.single_holder_max_pct);
  if (shares.top10 > v.top10_max_pct)
    fail("top10_holders", shares.top10.toFixed(1), v.top10_max_pct);
}

/** Mint age source: RugCheck first (true token age), else DLMM pool createdAt. */
export function resolveTokenCreatedAtMs(
  rugDetectedAt: string | null | undefined,
  poolCreatedAtMs: number | null,
): number | null {
  const rug = rugDetectedAt ? Date.parse(rugDetectedAt) : NaN;
  if (Number.isFinite(rug) && rug > 0) return rug;
  if (poolCreatedAtMs != null && Number.isFinite(poolCreatedAtMs) && poolCreatedAtMs > 0) {
    return poolCreatedAtMs;
  }
  return null;
}

export async function vetToken(mint: string, poolCreatedAtMs: number | null): Promise<VetResult> {
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

  let oc: OnchainTokenFacts | null = null;
  try {
    oc = await fetchTokenFacts(mint);
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

  // AMM-stripped holders (shared by concentration fallback + cluster detection).
  let rpcShares: HolderShare[] = [];
  if (oc.largestAccounts.length) {
    rpcShares = await holdersExcludingAmms(oc.largestAccounts);
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
    if (v.rugcheck_veto_enabled !== false && report.score_normalised >= v.rugcheck_veto_normalised)
      fail("rugcheck_veto", report.score_normalised, `< ${v.rugcheck_veto_normalised}`);

    const rugs = creatorRugCount(report);
    facts.creatorRugCount = rugs;
    if (v.creator_rug_enabled !== false && rugs > 0) {
      fail("creator_rug_history", rugs, "0");
      if (report.creator) blacklist(report.creator, "creator", `rug history x${rugs}`);
    }

    // RugCheck topHolders already excludes labeled AMMs.
    const holders = report.topHolders ?? [];
    if (holders.length) {
      const single = Math.max(...holders.map((h) => h.pct));
      const top10 = holders.slice(0, 10).reduce((s, h) => s + h.pct, 0);
      applyHolderGates({ single, top10 }, facts, fail, v);
    } else {
      const conc = concentrationFromShares(rpcShares);
      if (conc) applyHolderGates(conc, facts, fail, v);
    }

    // Only trust RugCheck insider % when networks were actually reported;
    // empty/zero with no networks falls through to our RPC cluster scan.
    if ((report.insiderNetworks?.length ?? 0) > 0) {
      const insiderPct = insiderNetworkPct(report, oc.supplyRaw);
      if (insiderPct !== null) {
        facts.insiderClusterPct = insiderPct;
        if (v.insider_gate_enabled !== false && insiderPct > v.insider_cluster_max_pct)
          fail("insider_clusters", insiderPct.toFixed(1), v.insider_cluster_max_pct);
      }
    }
  } else {
    // RugCheck down: RPC concentration + local creator history + cluster scan.
    const conc = concentrationFromShares(rpcShares);
    if (conc) applyHolderGates(conc, facts, fail, v);

    const knownCreator = (getDb()
      .prepare("SELECT creator FROM tokens WHERE mint = ?")
      .get(mint) as { creator: string | null } | undefined)?.creator;
    if (knownCreator) {
      facts.creatorAddress = knownCreator;
      const rugs = localCreatorRugCount(knownCreator);
      facts.creatorRugCount = rugs;
      if (rugs > 0) {
        if (v.creator_rug_enabled !== false) {
          fail("creator_rug_history", rugs, "0");
          blacklist(knownCreator, "creator", `local rug history x${rugs}`);
        }
      }
    }
  }

  // Funding-cluster / sniper fallback when RugCheck didn't give a usable insider %.
  if (facts.insiderClusterPct === null && rpcShares.length) {
    const clusterPct = await detectInsiderClusterPct(rpcShares);
      if (clusterPct !== null) {
        facts.insiderClusterPct = clusterPct;
        if (v.insider_gate_enabled !== false && clusterPct > v.insider_cluster_max_pct)
          fail("insider_clusters", clusterPct.toFixed(1), v.insider_cluster_max_pct);
      }
  }

  // --- GMGN cross-check layer (degrades silently on API failure) ---
  const [gmgnSec, traderTags, jup] = await Promise.all([
    tokenSecurity(mint), tokenTraderTags(mint), jupAsset(mint),
  ]);
  if (gmgnSec) {
    facts.gmgnHoneypot = gmgnSec.honeypot;
    facts.gmgnSellTaxPct = gmgnSec.sellTaxPct;
    if (v.gmgn_security_enabled !== false) {
      if (gmgnSec.honeypot) fail("gmgn_honeypot", "true", "false");
      if (gmgnSec.sellTaxPct > 0) fail("gmgn_sell_tax", `${gmgnSec.sellTaxPct}%`, "0%");
    }
  }
  if (traderTags) {
    facts.traderRiskShare = traderTags.riskShare;
    facts.traderSmartCount = traderTags.smartCount;
  }

  facts.jupOrganicScore = jup ? jup.organicScore : null;
  facts.jupBotHoldersPct = jup?.botHoldersPct ?? null;
  facts.jupDevMints = jup?.devMints ?? null;
  facts.jupTopHoldersPct = jup?.topHoldersPct ?? null;
  facts.jupOrganicVolShare24h = null;
  if (jup) {
    const totalVol = (jup.buyVol24h ?? 0) + (jup.sellVol24h ?? 0);
    const organicVol = (jup.organicBuyVol24h ?? 0) + (jup.organicSellVol24h ?? 0);
    if (totalVol > 0) facts.jupOrganicVolShare24h = organicVol / totalVol;
    if (facts.holderCount === null) facts.holderCount = jup.holderCount;
  }

  // Token mint age — not Meteora pool age. Migrated pump tokens often have a
  // brand-new DLMM pool while the mint is hours/days old; pool.createdAt caused
  // false age_min skips (and would under-count age_max the other way).
  const tokenCreatedAtMs = resolveTokenCreatedAtMs(report?.detectedAt, poolCreatedAtMs);
  if (tokenCreatedAtMs != null) {
    const ageMin = (Date.now() - tokenCreatedAtMs) / 60_000;
    facts.tokenAgeMinutes = Math.round(ageMin);
    if (v.age_min_enabled !== false && ageMin < v.age_min_minutes)
      fail("age_min", `${ageMin.toFixed(0)}m`, `${v.age_min_minutes}m`);
    if (v.age_max_enabled !== false && ageMin > v.age_max_days * 1440)
      fail("age_max", `${(ageMin / 1440).toFixed(1)}d`, `${v.age_max_days}d`);
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
  } else if (facts.singleHolderPct !== null || facts.top10Pct !== null) {
    // RugCheck blind but RPC concentration available (AMM-stripped).
    soft = 80;
    if (facts.top10Pct !== null) soft -= clamp01(facts.top10Pct / v.top10_max_pct) * 30;
    if (facts.singleHolderPct !== null) soft -= clamp01(facts.singleHolderPct / v.single_holder_max_pct) * 30;
    if ((facts.holderCount ?? 0) > 1000) soft += 5;
    soft = Math.max(0, Math.min(100, soft));
  } else if (jup) {
    soft = 75;
    if (jup.topHoldersPct !== null) soft -= clamp01(jup.topHoldersPct / v.top10_max_pct) * 30;
    if ((jup.holderCount ?? 0) > 1000) soft += 5;
    soft = Math.max(0, Math.min(100, soft));
  }
  if (traderTags && traderTags.sampled >= 10) {
    soft -= clamp01(traderTags.riskShare / 0.5) * 20;
    soft += Math.min(traderTags.smartCount, 5) * 2;
    soft = Math.max(0, Math.min(100, soft));
  }
  if (jup) {
    soft -= clamp01((50 - jup.organicScore) / 50) * 15;
    if (jup.organicScoreLabel === "high") soft += 5;
    if (jup.botHoldersPct !== null) soft -= clamp01(jup.botHoldersPct / 50) * 10;
    if (jup.devMints !== null) soft -= clamp01(jup.devMints / 500) * 10;
    soft = Math.max(0, Math.min(100, soft));
  }

  const db = getDb();
  db.prepare(
    `INSERT INTO tokens (mint, symbol, creator, launchpad, first_seen, last_vet_json)
     VALUES (?, NULL, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET creator=excluded.creator, launchpad=excluded.launchpad, last_vet_json=excluded.last_vet_json`
  ).run(mint, facts.creatorAddress, facts.launchpad, now(), JSON.stringify(facts));

  const verdict = hard.length === 0 ? "pass" : "fail";
  if (verdict === "fail" && hard.some((h) => h.gate !== "age_min")) {
    blacklist(mint, "token", hard.map((h) => h.gate).join(","), 24);
  }
  return { mint, verdict, hardFailures: hard, softScore: soft, facts };
}
