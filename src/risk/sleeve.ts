import { config } from "../config.js";
import { getDb } from "../db/db.js";
import { isMicroMcap } from "./micro.js";

export type Sleeve = "micro" | "meme" | "majors";

type OpenRow = { token_mint: string; pool: string; entry_ts: number; entry_sol: number };

function entryFeatures(pos: OpenRow): { sleeve: string | null; mcap: number | null } | undefined {
  return getDb().prepare(`
    SELECT json_extract(features_json, '$.sleeve') AS sleeve,
           json_extract(features_json, '$.pool.marketCapUsd') AS mcap
    FROM decisions
    WHERE mint = ? AND pool = ? AND action = 'entered'
      AND ts BETWEEN ? AND ?
    ORDER BY ABS(ts - ?) LIMIT 1
  `).get(pos.token_mint, pos.pool, pos.entry_ts - 300, pos.entry_ts + 300, pos.entry_ts) as
    { sleeve: string | null; mcap: number | null } | undefined;
}

export function sleeveAtEntry(pos: { tokenMint: string; poolAddress: string; entryTs: number }): Sleeve {
  const row = entryFeatures({ token_mint: pos.tokenMint, pool: pos.poolAddress, entry_ts: pos.entryTs, entry_sol: 0 });
  if (row?.sleeve === "micro" || row?.sleeve === "majors" || row?.sleeve === "meme") return row.sleeve;
  if (row?.sleeve === "core") return "meme"; // legacy tag
  if (row?.mcap != null && isMicroMcap(row.mcap)) return "micro";
  return "meme";
}

export function openSleeveExposure(sleeve: Sleeve): { slots: number; deployedSol: number } {
  const open = getDb().prepare(`
    SELECT token_mint, pool, entry_ts, entry_sol FROM positions
    WHERE state IN ('pending','open','closing')
  `).all() as OpenRow[];
  let slots = 0, deployedSol = 0;
  for (const p of open) {
    if (sleeveAtEntry({ tokenMint: p.token_mint, poolAddress: p.pool, entryTs: p.entry_ts }) !== sleeve) continue;
    slots++;
    deployedSol += p.entry_sol;
  }
  return { slots, deployedSol };
}

/** Meme slots that must stay free before majors may deploy (STRATEGY §10 headroom). */
export function majorsSlotBudget(opened: number): number {
  const mj = config().majors;
  if (!mj.enabled) return 0;
  const headroom = Math.min(mj.meme_reserve_slots, config().sizing.max_positions);
  if (opened > config().sizing.max_positions - headroom) return 0;
  return Math.min(mj.max_slots, config().sizing.max_positions - opened);
}
