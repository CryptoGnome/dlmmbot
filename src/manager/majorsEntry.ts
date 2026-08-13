import { config } from "../config.js";
import { recordDecision } from "../db/db.js";
import type { Executor } from "../executor/executor.js";
import { alert } from "../alerts.js";
import { solUsdPrice } from "../market.js";
import { planFollowRange, fitPlanToRentBudget } from "../ranges/planner.js";
import { majorsPositionSize, majorsPoolSharePct, majorsSleeveExposure } from "../risk/majors.js";
import { type Bankroll, openPositionCount, tokenExposureSol } from "../risk/limits.js";
import { majorsSlotBudget } from "../risk/sleeve.js";
import { scanMajors } from "../scanner/majorsScan.js";

/** Park idle capital in whitelist majors after the meme pipeline (STRATEGY §10 v0). */
export async function enterMajorsPositions(exec: Executor, bankroll: Bankroll): Promise<void> {
  const mj = config().majors;
  if (!mj.enabled) return;

  const opened = openPositionCount();
  const budget = majorsSlotBudget(opened);
  if (budget <= 0) return;

  const majorsExp = majorsSleeveExposure();
  if (majorsExp.slots >= mj.max_slots) return;

  const capSol = bankroll.walletSol * (mj.deploy_cap_pct / 100);
  if (majorsExp.deployedSol >= capSol) return;

  for (const cand of await scanMajors()) {
    if (majorsSleeveExposure().slots >= mj.max_slots) break;
    if (openPositionCount() >= config().sizing.max_positions) break;
    if (majorsSlotBudget(openPositionCount()) <= 0) break;

    if (tokenExposureSol(cand.tokenMint) > 0) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "majors_token_open", cand.score, { sleeve: "majors" });
      continue;
    }

    let size = majorsPositionSize(bankroll.deployableSol);
    const exp = majorsSleeveExposure();
    if (exp.deployedSol + size > capSol) {
      size = Math.max(0, capSol - exp.deployedSol);
      if (size < config().sizing.min_position_sol) {
        recordDecision(cand.tokenMint, cand.pool.address, "skipped", "majors_deploy_cap", cand.score, { sleeve: "majors", exp, capSol });
        continue;
      }
    }
    if (size < config().sizing.min_position_sol) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "majors_size_min", cand.score, { size, sleeve: "majors" });
      continue;
    }

    const solUsd = await solUsdPrice();
    if (solUsd !== null && solUsd > 0) {
      const shareCapSol = (cand.pool.tvlUsd * (majorsPoolSharePct() / 100)) / solUsd;
      if (size > shareCapSol) {
        if (shareCapSol < config().sizing.min_position_sol) {
          recordDecision(cand.tokenMint, cand.pool.address, "skipped", "majors_pool_share", cand.score, { shareCapSol, sleeve: "majors" });
          continue;
        }
        size = shareCapSol;
      }
    }

    let range = planFollowRange(cand.pool.price, cand.pool.binStep, mj.range_depth_pct, cand.pool.decimalsX);
    const rentBudget = config().entry.bin_rent_budget_sol;
    if (range.estBinRentSol > rentBudget) {
      const fitted = fitPlanToRentBudget(range, rentBudget, cand.pool.price, cand.pool.binStep, cand.pool.decimalsX, mj.range_depth_pct);
      if (!fitted) {
        recordDecision(cand.tokenMint, cand.pool.address, "skipped", "majors_bin_rent", cand.score, { range, sleeve: "majors" });
        continue;
      }
      range = fitted;
    }

    let pos;
    try {
      pos = await exec.open({
        poolAddress: cand.pool.address,
        tokenMint: cand.tokenMint,
        symbol: cand.symbol,
        sizeSol: size,
        range,
        entryPrice: cand.pool.price,
      });
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0]!.slice(0, 400);
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "majors_open_failed", cand.score, { size, range, error: msg, sleeve: "majors" });
      continue;
    }

    recordDecision(cand.tokenMint, cand.pool.address, "entered", null, cand.score, {
      size, range, pool: cand.pool, sleeve: "majors",
      experiment: { path: "majors", source: cand.source, feeTvl24h: cand.pool.feeTvl24hPct },
    });
    await alert("entry",
      `${cand.symbol} pos#${pos.id}: MAJORS ${size.toFixed(2)} SOL @ ${cand.pool.price.toPrecision(4)} ` +
      `(${cand.source}, fee/TVL ${cand.pool.feeTvl24hPct.toFixed(2)}%/d, depth ${range.bottomPricePct.toFixed(0)}%)\n` +
      `chart: https://gmgn.ai/sol/token/${cand.tokenMint}`);
    console.log(`[majors] ${cand.symbol} size=${size.toFixed(2)} SOL source=${cand.source} fee24h=${cand.pool.feeTvl24hPct.toFixed(2)}% pool=${cand.pool.address.slice(0, 8)}… pos#${pos.id}`);
    break; // one majors entry per tick
  }
}
