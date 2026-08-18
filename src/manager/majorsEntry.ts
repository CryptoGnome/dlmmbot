import { config } from "../config.js";
import { isBlacklisted, isExitCooldown, recordDecision, logError } from "../db/db.js";
import type { Executor } from "../executor/executor.js";
import { alert } from "../alerts.js";
import { solUsdPrice } from "../market.js";
import { majorsEntryTiming, majorsRangeForPool } from "../ranges/majorsPlanner.js";
import { applyBinRentGate } from "../ranges/binRent.js";
import { majorsPositionSize, majorsPoolSharePct, majorsSleeveExposure } from "../risk/majors.js";
import { type Bankroll, minPositionSol, openPositionCount, tokenExposureSol } from "../risk/limits.js";
import { majorsSlotBudget } from "../risk/sleeve.js";
import { scanMajors } from "../scanner/majorsScan.js";
import { fetchCandlesDeep } from "../scanner/candles.js";

/**
 * The pass-summary line is rate-limited: the majors entry runs every scan
 * tick, and "3 candidates, entered none" printed 60× an hour is the log spam
 * the silent-by-design loop exists to avoid. Once per interval, and only when
 * the outcome changed, is enough to answer "why are we not in any majors?".
 */
let lastMajorsSummary = "";
let lastMajorsSummaryAt = 0;
const MAJORS_SUMMARY_MIN_MS = 10 * 60 * 1000;

/** Majors parking: spot shape, TA entry timing, week-scale manage rules. */
export async function enterMajorsPositions(exec: Executor, bankroll: Bankroll): Promise<void> {
  const mj = config().majors;
  if (!mj.enabled) return;

  // One line per pass, so the Railway log can answer "why are we not in any
  // majors?" without the decisions table. Before this, "found nothing" and
  // "found ANSEM and skipped it" were both silence.
  const outcomes: string[] = [];
  const skip = (sym: string, why: string) => outcomes.push(`${sym}:${why}`);

  const opened = openPositionCount();
  const parked = majorsSleeveExposure();
  // Every early exit says why, at scan cadence, so silence in the log means
  // "not called" and nothing else. An earlier draft left the already-parked
  // return silent and it took an hour to tell "parked" from "never ran".
  const bail = (why: string) => {
    if (Date.now() - lastMajorsSummaryAt > MAJORS_SUMMARY_MIN_MS || lastMajorsSummary !== why) {
      console.log(`[majors] ${why}`);
      lastMajorsSummary = why;
      lastMajorsSummaryAt = Date.now();
    }
  };
  if (majorsSlotBudget(opened) <= 0) { bail(`no slot budget (${opened} open, meme reserve ${mj.meme_reserve_slots})`); return; }
  if (parked.slots >= mj.max_slots) { bail(`already parked (${parked.slots}/${mj.max_slots} slots, ${parked.deployedSol.toFixed(2)} SOL)`); return; }

  const capSol = bankroll.walletSol * (mj.deploy_cap_pct / 100);
  if (parked.deployedSol >= capSol) { bail(`deploy cap reached (${parked.deployedSol.toFixed(2)}/${capSol.toFixed(2)} SOL)`); return; }

  const cands = await scanMajors();
  let entered: string | null = null;
  for (const cand of cands) {
    if (majorsSleeveExposure().slots >= mj.max_slots) break;
    if (openPositionCount() >= config().sizing.max_positions) break;
    if (majorsSlotBudget(openPositionCount()) <= 0) break;

    if (tokenExposureSol(cand.tokenMint) > 0) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "majors_token_open", cand.score, { sleeve: "majors", symbol: cand.symbol });
      skip(cand.symbol, "token_open");
      continue;
    }

    // Re-entry cooldown (STRATEGY.md §4 P5, `loss_reentry_cooldown_h`). Every
    // other entry route reads the blacklist; this one did not, so a P5 cut
    // wrote a 24h cooldown and the next scan tick walked straight back in —
    // live on 2026-08-18, ANSEM re-entered 6s after being cut for -0.0786.
    // Vetting bans are deliberately NOT enforced here: see isExitCooldown.
    const bl = isBlacklisted(cand.tokenMint);
    if (bl !== null && isExitCooldown(bl)) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "majors_exit_cooldown", cand.score, { sleeve: "majors", symbol: cand.symbol, reason: bl });
      skip(cand.symbol, `cooldown(${bl})`);
      continue;
    }

    const candles = await fetchCandlesDeep(cand.pool.address, "5m").catch(() => []);
    const timing = majorsEntryTiming(candles, cand.pool.price);
    if (!timing.ok) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", timing.reason!, cand.score, { sleeve: "majors", timing });
      skip(cand.symbol, `${timing.reason!.replace("majors_", "")}(rsi ${timing.rsi?.toFixed(0) ?? "?"},swing ${((timing.swingPos ?? 0) * 100).toFixed(0)}%)`);
      continue;
    }

    // Size first: the bin-rent gate caps non-refundable rent as a share of the
    // position, so it needs to know how big the position will be.
    const floor = minPositionSol(bankroll.walletSol);
    let size = majorsPositionSize(bankroll.deployableSol, bankroll.walletSol);
    const exp = majorsSleeveExposure();
    if (exp.deployedSol + size > capSol) {
      size = Math.max(0, capSol - exp.deployedSol);
      if (size < floor) {
        recordDecision(cand.tokenMint, cand.pool.address, "skipped", "majors_deploy_cap", cand.score, { sleeve: "majors", exp, capSol });
        skip(cand.symbol, "deploy_cap");
        continue;
      }
    }
    if (size < floor) {
      // Used to `continue` silently — no decision, no log. Exactly the kind of
      // hole that turned pos#5 into a 20-minute reconstruction.
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "majors_size_below_floor", cand.score, { sleeve: "majors", size, floor });
      skip(cand.symbol, `size ${size.toFixed(3)}<floor ${floor.toFixed(3)}`);
      continue;
    }

    const solUsd = await solUsdPrice();
    if (solUsd !== null && solUsd > 0) {
      const shareCapSol = (cand.pool.tvlUsd * (majorsPoolSharePct() / 100)) / solUsd;
      if (size > shareCapSol) {
        if (shareCapSol < floor) {
          recordDecision(cand.tokenMint, cand.pool.address, "skipped", "majors_pool_share", cand.score, { shareCapSol, sleeve: "majors" });
          skip(cand.symbol, "pool_share");
          continue;
        }
        size = shareCapSol;
      }
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
      sizeSol: size,
    });
    if (!rent.ok) {
      recordDecision(cand.tokenMint, cand.pool.address, "skipped", "majors_bin_rent", cand.score, {
        sleeve: "majors", range: rent.range, rent: rent.meta,
      });
      skip(cand.symbol, `bin_rent(${rent.meta.actual ?? rent.meta.est}>${rent.meta.budget.toFixed(3)})`);
      continue;
    }
    const range = rent.range;

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
      skip(cand.symbol, "open_failed");
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
    entered = cand.symbol;
    break;
  }
  if (!entered) {
    const line =
      `[majors] ${cands.length} candidate(s) passed pool gates` +
      (cands.length ? ` [${cands.map((c) => c.symbol).join(", ")}]` : "") +
      ` — entered none` + (outcomes.length ? `; skipped ${outcomes.join(", ")}` : "");
    const changed = line !== lastMajorsSummary;
    if (changed || Date.now() - lastMajorsSummaryAt > MAJORS_SUMMARY_MIN_MS) {
      console.log(line);
      lastMajorsSummary = line;
      lastMajorsSummaryAt = Date.now();
    }
  }
}
