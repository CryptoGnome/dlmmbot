import { config, SOL_MINT } from "../config.js";
import { recordDecision } from "../db/db.js";
import type { PoolInfo } from "../types.js";
import { fetchPool, sweepMajorsPools, type RawPoolExtras } from "./meteora.js";
import { majorsDiscoveryEligible, majorsPoolGates, majorsScore, majorsSymbol } from "./majorsGates.js";

export interface MajorsCandidate {
  pool: PoolInfo & { extras: RawPoolExtras };
  tokenMint: string;
  symbol: string;
  score: number;
  source: "discovery" | "whitelist";
}

function toCandidate(
  raw: PoolInfo & { extras: RawPoolExtras },
  source: MajorsCandidate["source"],
): MajorsCandidate {
  return {
    pool: raw,
    tokenMint: raw.mintX,
    symbol: majorsSymbol(raw),
    score: majorsScore(raw),
    source,
  };
}

/** Pick the highest-scoring pool per symbol (e.g. best PUMP-SOL among several). */
export function pickBestMajorsPerSymbol(cands: MajorsCandidate[]): MajorsCandidate[] {
  const best = new Map<string, MajorsCandidate>();
  for (const c of cands) {
    const cur = best.get(c.symbol);
    if (!cur || c.score > cur.score) best.set(c.symbol, c);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

async function loadWhitelist(): Promise<MajorsCandidate[]> {
  const out: MajorsCandidate[] = [];
  for (const entry of config().majors.pools) {
    const raw = await fetchPool(entry.pool);
    if (!raw) {
      recordDecision(entry.pool, entry.pool, "skipped", "majors_pool_missing", null, { sleeve: "majors", pool: entry.pool });
      continue;
    }
    const fails = majorsPoolGates(raw);
    if (fails.length > 0) {
      recordDecision(raw.mintX, raw.address, "skipped", fails[0]!.gate, null, { sleeve: "majors", pool: raw, gateFailures: fails, source: "whitelist" });
      continue;
    }
    out.push({ ...toCandidate(raw, "whitelist"), symbol: entry.symbol ?? majorsSymbol(raw) });
  }
  return out;
}

async function discoverMajors(): Promise<MajorsCandidate[]> {
  const pools = await sweepMajorsPools();
  const passing: MajorsCandidate[] = [];
  for (const p of pools) {
    if (p.mintY !== SOL_MINT || p.mintX === SOL_MINT) continue;
    if (!majorsDiscoveryEligible(p)) continue;
    const fails = majorsPoolGates(p);
    if (fails.length > 0) continue;
    passing.push(toCandidate(p, "discovery"));
  }
  return pickBestMajorsPerSymbol(passing);
}

/**
 * Majors candidates: discovery sweep (best pool per symbol by live fee/TVL)
 * merged with optional whitelist seeds. Discovery runs every tick when enabled.
 */
export async function scanMajors(): Promise<MajorsCandidate[]> {
  const mj = config().majors;
  if (!mj.enabled) return [];
  if (!mj.discovery && mj.pools.length === 0) return [];

  const byAddr = new Map<string, MajorsCandidate>();
  if (mj.discovery) {
    for (const c of await discoverMajors()) byAddr.set(c.pool.address, c);
  }
  for (const c of await loadWhitelist()) byAddr.set(c.pool.address, c); // whitelist overrides same address

  return [...byAddr.values()].sort((a, b) => b.score - a.score);
}
