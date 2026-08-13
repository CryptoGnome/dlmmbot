import { config } from "../config.js";
import { openSleeveExposure } from "./sleeve.js";

export function majorsSleeveExposure() {
  return openSleeveExposure("majors");
}

/** Fixed majors size for v0 monitoring (no meme Kelly). */
export function majorsPositionSize(deployableSol: number): number {
  const mj = config().majors;
  return Math.min(mj.size_sol, mj.max_position_sol, deployableSol);
}

export function majorsPoolSharePct(): number {
  return config().majors.max_pool_share_pct;
}
