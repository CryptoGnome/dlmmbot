import { config } from "../config.js";
import { fixedSleeveSize, sizingMode } from "./limits.js";
import { openSleeveExposure } from "./sleeve.js";

export function majorsSleeveExposure() {
  return openSleeveExposure("majors");
}

/** Majors size: fixed sleeve when sizing.mode=fixed, else majors.size_sol. */
export function majorsPositionSize(deployableSol: number, walletSol: number): number {
  const mj = config().majors;
  if (sizingMode() === "fixed") {
    const size = fixedSleeveSize("majors", deployableSol, walletSol);
    if (size <= 0) return 0;
    return Math.min(size, mj.max_position_sol);
  }
  return Math.min(mj.size_sol, mj.max_position_sol, deployableSol);
}

export function majorsPoolSharePct(): number {
  return config().majors.max_pool_share_pct;
}
