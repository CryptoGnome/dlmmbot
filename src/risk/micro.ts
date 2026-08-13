import { config } from "../config.js";
import { openSleeveExposure } from "./sleeve.js";

export function isMicroMcap(mcapUsd: number | null | undefined): boolean {
  const g = config().gates;
  return mcapUsd != null && mcapUsd >= g.mcap_min_usd && mcapUsd < g.mcap_micro_max_usd;
}

/** Open micro-sleeve positions (100–200k band at entry). */
export function microSleeveExposure(): { slots: number; deployedSol: number } {
  return openSleeveExposure("micro");
}

/** Half-Kelly size for micro band + hard SOL cap. */
export function applyMicroSize(size: number): number {
  const g = config().gates;
  return Math.min(size * g.micro_size_mult, g.micro_max_position_sol);
}

export function microPoolSharePct(): number {
  return config().gates.micro_max_pool_share_pct;
}
