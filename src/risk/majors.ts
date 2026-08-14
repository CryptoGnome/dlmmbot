import { config } from "../config.js";
import { fixedSleeveSize, kellySleeveBase, kellyStats, sizingMode } from "./limits.js";
import { openSleeveExposure } from "./sleeve.js";

export function majorsSleeveExposure() {
  return openSleeveExposure("majors");
}

function kellyMajorsBase(deployableSol: number, walletSol: number): number {
  const s = config().sizing;
  const k = kellyStats();
  if (k.regime === "negative_edge" && s.kelly_block_negative) return 0;
  const kellyBase = Math.max(walletSol * k.appliedFraction, s.min_position_sol);
  return kellySleeveBase("majors", deployableSol, kellyBase);
}

/** Majors size: Kelly per-sleeve settings or fixed sleeve when mode=fixed. */
export function majorsPositionSize(deployableSol: number, walletSol: number): number {
  const mj = config().majors;
  if (sizingMode() === "fixed") {
    const size = fixedSleeveSize("majors", deployableSol, walletSol);
    if (size <= 0) return 0;
    return Math.min(size, mj.max_position_sol);
  }
  const base = kellyMajorsBase(deployableSol, walletSol);
  if (base <= 0) return 0;
  return Math.min(base, mj.max_position_sol, deployableSol);
}

export function majorsPoolSharePct(): number {
  return config().majors.max_pool_share_pct;
}
