import { config } from "../config.js";
import { getDb } from "../db/db.js";

export function isMicroMcap(mcapUsd: number | null | undefined): boolean {
  const g = config().gates;
  return mcapUsd != null && mcapUsd >= g.mcap_min_usd && mcapUsd < g.mcap_micro_max_usd;
}

/** Open micro-sleeve positions (100–200k band at entry). */
export function microSleeveExposure(): { slots: number; deployedSol: number } {
  const max = config().gates.mcap_micro_max_usd;
  const open = getDb().prepare(`
    SELECT token_mint, pool, entry_ts, entry_sol AS sol
    FROM positions WHERE state IN ('pending','open','closing')
  `).all() as Array<{ token_mint: string; pool: string; entry_ts: number; sol: number }>;
  const mcapAtEntry = getDb().prepare(`
    SELECT json_extract(features_json, '$.pool.marketCapUsd') AS mcap
    FROM decisions
    WHERE mint = ? AND pool = ? AND action = 'entered'
      AND ts BETWEEN ? AND ?
    ORDER BY ABS(ts - ?) LIMIT 1
  `);
  let slots = 0, deployedSol = 0;
  for (const p of open) {
    const row = mcapAtEntry.get(p.token_mint, p.pool, p.entry_ts - 300, p.entry_ts + 300, p.entry_ts) as { mcap: number | null } | undefined;
    if (row?.mcap != null && row.mcap < max) { slots++; deployedSol += p.sol; }
  }
  return { slots, deployedSol };
}

/** Half-Kelly size for micro band + hard SOL cap. */
export function applyMicroSize(size: number): number {
  const g = config().gates;
  return Math.min(size * g.micro_size_mult, g.micro_max_position_sol);
}

export function microPoolSharePct(): number {
  return config().gates.micro_max_pool_share_pct;
}
