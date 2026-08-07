import { config, SOL_MINT } from "../config.js";
import { getDb, isBlacklisted, now, recordDecision } from "../db/db.js";
import type { Candidate } from "../types.js";
import { poolGates } from "./gates.js";
import { trendingByMint } from "./gmgn.js";
import { fetchCandles, sweepPools } from "./meteora.js";
import { feeMomentumPart, opportunityScore, structurePart, timingPart, turnoverPart } from "./score.js";

// STRATEGY.md §1 — sweep → dedupe copycats → best pool per token → gates → score.

export interface ScanResult {
  candidates: Candidate[];   // passed all pool gates, sorted by score desc
  rejected: Candidate[];     // failed gates (kept for the decisions log)
  sweptPools: number;
}

export async function scan(opts: { withTiming?: boolean } = {}): Promise<ScanResult> {
  const [pools, gmgnTrending] = await Promise.all([sweepPools(), trendingByMint()]);
  const db = getDb();

  // Snapshot every swept pool (offline replay/tuning dataset, §7).
  const snap = db.prepare(
    `INSERT INTO pool_snapshots (pool, ts, tvl_usd, price, vol_30m, vol_1h, vol_24h, fee_tvl_30m, fee_tvl_24h)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const ts = now();
  const insertMany = db.transaction(() => {
    for (const p of pools)
      snap.run(p.address, ts, p.tvlUsd, p.price, p.vol30mUsd, p.vol1hUsd, p.vol24hUsd, p.feeTvl30mPct, p.feeTvl24hPct);
  });
  insertMany();

  // Consider only SOL-quoted, non-SOL-base pools; skip blacklisted tokens.
  const memePools = pools.filter((p) => p.mintY === SOL_MINT && p.mintX !== SOL_MINT);

  // Copycat dedupe (§1.2): same symbol -> keep highest 24h volume.
  const bySymbol = new Map<string, typeof memePools>();
  for (const p of memePools) {
    const sym = (p.name.split("-")[0] ?? p.name).toUpperCase();
    const list = bySymbol.get(sym) ?? [];
    list.push(p);
    bySymbol.set(sym, list);
  }
  const canonical = new Set<string>();
  for (const list of bySymbol.values()) {
    const byMint = new Map<string, number>();
    for (const p of list) byMint.set(p.mintX, (byMint.get(p.mintX) ?? 0) + p.vol24hUsd);
    const winner = [...byMint.entries()].sort((a, b) => b[1] - a[1])[0];
    if (winner) canonical.add(winner[0]);
  }

  // Best pool per canonical token = highest 24h fee/TVL.
  const bestPool = new Map<string, (typeof memePools)[number]>();
  for (const p of memePools) {
    if (!canonical.has(p.mintX)) continue;
    if (isBlacklisted(p.mintX)) continue;
    const cur = bestPool.get(p.mintX);
    if (!cur || p.feeTvl24hPct > cur.feeTvl24hPct) bestPool.set(p.mintX, p);
  }

  const candidates: Candidate[] = [];
  const rejected: Candidate[] = [];

  for (const p of bestPool.values()) {
    const gateFailures = poolGates(p);
    const symbol = p.name.split("-")[0] ?? p.name;

    // Timing needs a candles fetch per pool — only for gate-passers (cheap sweep).
    let timing = 0.5;
    if (gateFailures.length === 0 && opts.withTiming !== false) {
      try {
        timing = timingPart(await fetchCandles(p.address, "5m"), p.price);
      } catch {
        timing = 0.5;
      }
    }

    const parts = {
      feeMomentum: feeMomentumPart(p),
      turnover: turnoverPart(p),
      vettingSoft: 0.5, // replaced by the vetting engine downstream
      timing,
      structure: structurePart(p),
    };
    let { score, weighted } = opportunityScore(parts);

    // GMGN enrichment (§1): tiered trending bonus + cheap pre-vet from trending metadata.
    const g = config().gmgn;
    const gm = gmgnTrending.get(p.mintX);
    if (gm) {
      const t = gm.token;
      if (g.require_renounced && (!t.renouncedMint || !t.renouncedFreeze)) {
        gateFailures.push({ gate: "gmgn_renounced", value: `mint=${t.renouncedMint} freeze=${t.renouncedFreeze}`, limit: "both renounced" });
      } else {
        const in5m = gm.intervals.has("5m");
        const in1h = gm.intervals.has("1h");
        const bonus = in5m && in1h ? g.bonus_sustained : in5m ? g.bonus_emerging : in1h ? g.bonus_fading : 0;
        if (bonus > 0) {
          score = Math.min(100, score + bonus);
          weighted = { ...weighted, gmgn_trending: bonus };
        }
      }
    }

    const cand: Candidate = { pool: p, tokenMint: p.mintX, symbol, score, scoreParts: weighted, gateFailures };
    if (gateFailures.length === 0) candidates.push(cand);
    else {
      rejected.push(cand);
      recordDecision(p.mintX, p.address, "skipped", gateFailures[0]?.gate ?? null, score, {
        pool: p, gateFailures, scoreParts: weighted,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return { candidates, rejected, sweptPools: pools.length };
}
