import { config } from "../config.js";
import { recordDecision, logError } from "../db/db.js";
import type { Executor } from "../executor/executor.js";
import { alert } from "../alerts.js";
import { solUsdPrice } from "../market.js";
import { majorsEntryTiming, majorsRangeForPool } from "../ranges/majorsPlanner.js";
import { applyBinRentGate } from "../ranges/binRent.js";
import { majorsPositionSize, majorsPoolSharePct, majorsSleeveExposure } from "../risk/majors.js";
import { type Bankroll, openPositionCount, tokenExposureSol } from "../risk/limits.js";
import { majorsSlotBudget } from "../risk/sleeve.js";
import { scanMajors } from "../scanner/majorsScan.js";
import { fetchCandles } from "../scanner/meteora.js";

/** Majors parking: spot shape, TA entry timing, week-scale manage rules. */
export async function enterMajorsPositions(exec: Executor, bankroll: Bankroll): Promise<void> {
  const mj = config().majors;
  if (!mj.enabled) return;

  const opened = openPositionCount();
  if (majorsSlotBudget(opened) <= 0) return;
  if (majorsSleeveExposure().slots >= mj.max_slots) return;

  const capSol = bankroll.walletSol * (mj.deploy_cap_pct / 100);
  if (majorsSleeveExposure().deployedSol >= capSol) return;

  for (const cand of await scanMajors()) {
    if (majorsSleeveExposure().slots >= mj.max_slots) break;
    if (openPositionCount() >= config().sizing.max_positions) break;
    if (majorsSlotBudget(openPositionCount()) <= 0) break;

    if (tokenExposureSol(cand.tokenMint) > 0) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "majors_token_open", cand.score, { sleeve: "majors", symbol: cand.symbol });
      continue;
    }

    const candles = await fetchCandles(cand.pool.address, "5m").catch(() => []);
    const timing = majorsEntryTiming(candles, cand.pool.price);
    if (!timing.ok) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", timing.reason!, cand.score, { sleeve: "majors", timing });
      continue;
    }

    const planned = majorsRangeForPool(cand.pool.price, cand.pool.binStep, cand.pool.decimalsX);
    const rent = await applyBinRentGate({
      range: planned,
      score: cand.score,
      poolAddress: cand.pool.address,
      price: cand.pool.price,
      binStep: cand.pool.binStep,
      decimalsX: cand.pool.decimalsX,
      minDownPct: mj.range_below_pct,
    });
    if (!rent.ok) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "majors_bin_rent", cand.score, {
        sleeve: "majors", range: rent.range, rent: rent.meta,
      });
      continue;
    }
    const range = rent.range;

    let size = majorsPositionSize(bankroll.deployableSol, bankroll.walletSol);
    const exp = majorsSleeveExposure();
    if (exp.deployedSol + size > capSol) {
      size = Math.max(0, capSol - exp.deployedSol);
      if (size < config().sizing.min_position_sol) {
        recordDecision(cand.tokenMint, cand.pool.address, "skipped", "majors_deploy_cap", cand.score, { sleeve: "majors", exp, capSol });
        continue;
      }
    }
    if (size < config().sizing.min_position_sol) continue;

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
      logError({
        source: "majors",
        code: "open_failed",
        message: `${cand.symbol} majors open failed: ${msg}`,
        err: e,
        detail: { size, range, sleeve: "majors", score: cand.score },
        symbol: cand.symbol,
        mint: cand.tokenMint,
        pool: cand.pool.address,
        dedupeSec: 15,
      });
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "majors_open_failed", cand.score, { size, range, error: msg, sleeve: "majors" });
      continue;
    }

    recordDecision(cand.tokenMint, cand.pool.address, "entered", null, cand.score, {
      size, range, pool: cand.pool, sleeve: "majors", timing,
      experiment: { path: "majors", source: cand.source, shape: range.shape, feeTvl24h: cand.pool.feeTvl24hPct },
    });
    await alert("entry",
      `${cand.symbol} pos#${pos.id}: MAJORS ${size.toFixed(2)} SOL SPOT @ ${cand.pool.price.toPrecision(4)} ` +
      `(${cand.source}, RSI ${timing.rsi?.toFixed(0) ?? "?"}, swing ${((timing.swingPos ?? 0) * 100).toFixed(0)}%)\n` +
      `chart: https://gmgn.ai/sol/token/${cand.tokenMint}`);
    console.log(
      `[majors] ${cand.symbol} SPOT ${size.toFixed(2)} SOL rsi=${timing.rsi?.toFixed(0)} ` +
      `swing=${((timing.swingPos ?? 0) * 100).toFixed(0)}% pool=${cand.pool.address.slice(0, 8)}… pos#${pos.id}`
    );
    break;
  }
}
