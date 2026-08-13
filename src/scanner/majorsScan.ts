import { config } from "../config.js";
import { recordDecision } from "../db/db.js";
import type { PoolInfo } from "../types.js";
import { fetchPool } from "./meteora.js";
import { majorsPoolGates } from "./majorsGates.js";

export interface MajorsCandidate {
  pool: PoolInfo & { extras: import("./meteora.js").RawPoolExtras };
  tokenMint: string;
  symbol: string;
  score: number;
}

/** Whitelist majors — highest fee/TVL first. */
export async function scanMajors(): Promise<MajorsCandidate[]> {
  const mj = config().majors;
  if (!mj.enabled || mj.pools.length === 0) return [];

  const out: MajorsCandidate[] = [];
  for (const entry of mj.pools) {
    const raw = await fetchPool(entry.pool);
    if (!raw) {
      recordDecision(entry.pool, entry.pool, "skipped", "majors_pool_missing", null, { sleeve: "majors", pool: entry.pool });
      continue;
    }
    const fails = majorsPoolGates(raw);
    const symbol = entry.symbol ?? raw.name.split("-")[0] ?? raw.name;
    if (fails.length > 0) {
      recordDecision(raw.mintX, raw.address, "skipped", fails[0]!.gate, null, { sleeve: "majors", pool: raw, gateFailures: fails });
      continue;
    }
    out.push({
      pool: raw,
      tokenMint: raw.mintX,
      symbol,
      score: raw.feeTvl24hPct * 10 + raw.feeTvl30mPct,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}
