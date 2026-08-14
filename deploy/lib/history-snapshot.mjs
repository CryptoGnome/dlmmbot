/**
 * Historical series for the LAN dashboard — equity, exits, skips, activity.
 * Read-only against farmer.db.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { REALIZED_PNL } from "./live-book-snapshot.mjs";
import { resolveBotMode } from "./bot-mode.mjs";
import { runtimePaths } from "./runtime-paths.mjs";

function openDb(root) {
  const require = createRequire(resolve(root, "package.json"));
  const Database = require("better-sqlite3");
  return new Database(runtimePaths(root).dbPath, { readonly: true, fileMustExist: true });
}

function rangeStart(range, now) {
  if (range === "7d") return now - 7 * 86_400;
  if (range === "30d") return now - 30 * 86_400;
  return 0;
}

function round6(n) {
  return Math.round((n ?? 0) * 1e6) / 1e6;
}

/**
 * @param {string} root
 * @param {"7d"|"30d"|"all"} range
 */
export function buildHistorySnapshot(root, range = "30d") {
  const db = openDb(root);
  try {
    const now = Math.floor(Date.now() / 1000);
    const since = rangeStart(range, now);
    const dayCutoff = since > 0
      ? new Date(since * 1000).toISOString().slice(0, 10)
      : "1970-01-01";
    const bookMode = resolveBotMode(root);

    const daily = db.prepare(
      `SELECT day, realized_sol, unrealized_sol, fees_sol, costs_sol, sol_usd
       FROM pnl_daily
       WHERE mode = ? AND day >= ?
       ORDER BY day ASC`
    ).all(bookMode, dayCutoff);

    // Carry last known SOL/USD price forward when a day is missing sol_usd
    let lastPx = 0;
    for (const r of daily) {
      if (r.sol_usd && r.sol_usd > 0) lastPx = r.sol_usd;
    }
    let px = 0;
    let cumSol = 0;
    let cumUsd = 0;
    const equity = daily.map((r) => {
      if (r.sol_usd && r.sol_usd > 0) px = r.sol_usd;
      else if (!px && lastPx) px = lastPx;
      const daySol = r.realized_sol ?? 0;
      cumSol += daySol;
      const dayUsd = px > 0 ? daySol * px : 0;
      cumUsd += dayUsd;
      return {
        day: r.day,
        sol: round6(daySol),
        usd: round6(dayUsd),
        cum_sol: round6(cumSol),
        cum_usd: round6(cumUsd),
        sol_usd: px || null,
      };
    });

    // One bar per day = net PnL (easy to read green/red) + return on capital
    const exitDaily = db.prepare(
      `SELECT date(exit_ts,'unixepoch') AS day,
              COUNT(*) AS n,
              ROUND(SUM(${REALIZED_PNL}), 6) AS pnl,
              ROUND(SUM(entry_sol), 6) AS entry_sol
       FROM positions
       WHERE mode = ? AND exit_ts IS NOT NULL AND exit_ts >= ?
       GROUP BY day
       ORDER BY day ASC`
    ).all(bookMode, since).map((r) => ({
      ...r,
      pct: r.entry_sol > 0 ? Math.round((r.pnl / r.entry_sol) * 1e6) / 1e6 : null,
    }));

    const exitPctByDay = Object.fromEntries(exitDaily.map((r) => [r.day, r.pct]));
    for (const row of equity) {
      row.day_pct = exitPctByDay[row.day] ?? null;
    }

    const exitByReason = db.prepare(
      `SELECT exit_reason AS reason,
              COUNT(*) AS n,
              ROUND(SUM(${REALIZED_PNL}), 6) AS pnl,
              ROUND(SUM(entry_sol), 6) AS entry_sol
       FROM positions
       WHERE mode = ? AND exit_ts IS NOT NULL AND exit_ts >= ?
       GROUP BY exit_reason
       ORDER BY pnl ASC`
    ).all(bookMode, since).map((r) => ({
      ...r,
      pct: r.entry_sol > 0 ? Math.round((r.pnl / r.entry_sol) * 1e6) / 1e6 : null,
    }));

    const ladder = db.prepare(
      `SELECT id,
              COALESCE(NULLIF(symbol,''), '?') AS symbol,
              token_mint AS mint,
              exit_reason,
              datetime(exit_ts,'unixepoch') AS at,
              exit_ts,
              ROUND((${REALIZED_PNL}), 6) AS pnl,
              ROUND(entry_sol, 4) AS entry_sol,
              ROUND(COALESCE(rent_paid_sol, 0), 6) AS rent_paid_sol,
              ROUND(open_cost_sol, 6) AS open_cost_sol,
              ROUND(close_return_sol, 6) AS close_return_sol,
              ROUND(COALESCE(fees_measured_sol, 0), 6) AS fees_measured_sol,
              ROUND(COALESCE(fees_claimed_sol, 0), 6) AS fees_claimed_sol,
              ROUND(COALESCE(recovered_sol, 0), 6) AS recovered_sol,
              ROUND(COALESCE(fees_at_close_sol, 0), 6) AS fees_at_close_sol,
              ROUND(exit_sol, 6) AS exit_sol
       FROM positions
       WHERE mode = ? AND exit_ts IS NOT NULL AND exit_ts >= ?
       ORDER BY exit_ts DESC
       LIMIT 40`
    ).all(bookMode, since).map((r) => {
      const openCost = r.open_cost_sol != null ? Number(r.open_cost_sol) : null;
      const closeRet = r.close_return_sol != null ? Number(r.close_return_sol) : null;
      const feesMeasured = Number(r.fees_measured_sol) || 0;
      const feesClaimed = Number(r.fees_claimed_sol) || 0;
      const feesAtClose = Number(r.fees_at_close_sol) || 0;
      const feesLife = feesMeasured > 0 ? feesMeasured : feesClaimed;
      const fees = Math.round((feesLife + feesAtClose) * 1e6) / 1e6;
      const recovered = Number(r.recovered_sol) || 0;
      const entry = Number(r.entry_sol) || 0;
      const rent = Number(r.rent_paid_sol) || 0;
      const pnl = Number(r.pnl) || 0;
      const costBasis = openCost ?? (entry > 0 ? entry + rent : entry);
      // Deposit move (IL + tx): total PnL minus fee income and late recoveries.
      const exitMove = Math.round((pnl - fees - recovered) * 1e6) / 1e6;
      return {
        ...r,
        fees_sol: fees,
        recovered_sol: Math.round(recovered * 1e6) / 1e6,
        exit_move_sol: exitMove,
        pct: costBasis > 0 ? Math.round((pnl / costBasis) * 1e6) / 1e6 : null,
      };
    });

    const skipTop = db.prepare(
      `SELECT failed_gate AS g, COUNT(*) AS n
       FROM decisions
       WHERE action='skipped' AND ts >= ? AND failed_gate IS NOT NULL
         AND failed_gate NOT LIKE '%open_failed%'
       GROUP BY failed_gate
       ORDER BY n DESC
       LIMIT 8`
    ).all(since);

    const topGates = skipTop.map((r) => r.g);
    let skipSeries = [];
    if (topGates.length > 0) {
      const placeholders = topGates.map(() => "?").join(",");
      const skipRows = db.prepare(
        `SELECT date(ts,'unixepoch') AS day, failed_gate AS g, COUNT(*) AS n
         FROM decisions
         WHERE action='skipped' AND ts >= ? AND failed_gate IN (${placeholders})
         GROUP BY day, failed_gate
         ORDER BY day ASC`
      ).all(since, ...topGates);

      const byDay = {};
      for (const r of skipRows) {
        if (!byDay[r.day]) {
          byDay[r.day] = { day: r.day };
          for (const g of topGates) byDay[r.day][g] = 0;
        }
        byDay[r.day][r.g] = r.n;
      }
      skipSeries = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));
    }

    const activity = db.prepare(
      `SELECT date(ts,'unixepoch') AS day,
              SUM(CASE WHEN action='entered' THEN 1 ELSE 0 END) AS entered,
              SUM(CASE WHEN action='skipped' AND IFNULL(failed_gate,'') NOT LIKE '%open_failed%' THEN 1 ELSE 0 END) AS skipped,
              SUM(CASE WHEN IFNULL(failed_gate,'') LIKE '%open_failed%' THEN 1 ELSE 0 END) AS open_failed
       FROM decisions
       WHERE ts >= ?
       GROUP BY day
       ORDER BY day ASC`
    ).all(since);

    // --- Analytics aggregates (range-scoped closes + decisions) ---
    const closeRows = db.prepare(
      `SELECT id,
              COALESCE(NULLIF(symbol,''), '?') AS symbol,
              token_mint AS mint,
              pool,
              exit_reason AS reason,
              entry_ts, exit_ts, entry_sol,
              follow_chain_id,
              ever_in_range,
              (${REALIZED_PNL}) AS pnl,
              ROUND(COALESCE(fees_measured_sol, fees_claimed_sol, 0), 6) AS fees_sol,
              open_cost_sol, close_return_sol, exit_sol
       FROM positions
       WHERE mode = ? AND exit_ts IS NOT NULL AND exit_ts >= ?`
    ).all(bookMode, since);

    const sleeveAt = db.prepare(
      `SELECT json_extract(features_json, '$.sleeve') AS sleeve,
              json_extract(features_json, '$.pool.marketCapUsd') AS mcap,
              json_extract(features_json, '$.pool.feeTvl24hPct') AS fee_tvl_24h,
              json_extract(features_json, '$.follow') AS follow
       FROM decisions
       WHERE mint = ? AND pool = ? AND action = 'entered'
         AND ts BETWEEN ? AND ?
       ORDER BY ABS(ts - ?) LIMIT 1`
    );

    const mcapMicroMax = (() => {
      try {
        const toml = readFileSync(runtimePaths(root).configPath, "utf8");
        const m = /^\s*mcap_micro_max_usd\s*=\s*([0-9_.]+)/m.exec(toml);
        const min = /^\s*mcap_min_usd\s*=\s*([0-9_.]+)/m.exec(toml);
        return {
          microMax: m ? Number(m[1].replace(/_/g, "")) : 200_000,
          mcapMin: min ? Number(min[1].replace(/_/g, "")) : 50_000,
        };
      } catch {
        return { microMax: 200_000, mcapMin: 50_000 };
      }
    })();

    function resolveSleeve(row) {
      try {
        const hit = sleeveAt.get(row.mint, row.pool, row.entry_ts - 300, row.entry_ts + 300, row.entry_ts);
        const s = hit?.sleeve;
        if (s === "micro" || s === "majors" || s === "meme") return { sleeve: s, feeTvl: hit?.fee_tvl_24h, follow: !!hit?.follow };
        if (s === "core") return { sleeve: "meme", feeTvl: hit?.fee_tvl_24h, follow: !!hit?.follow };
        if (hit?.mcap != null && Number(hit.mcap) >= mcapMicroMax.mcapMin && Number(hit.mcap) < mcapMicroMax.microMax) {
          return { sleeve: "micro", feeTvl: hit?.fee_tvl_24h, follow: !!hit?.follow };
        }
        return { sleeve: "meme", feeTvl: hit?.fee_tvl_24h, follow: !!row.follow_chain_id || !!hit?.follow };
      } catch {
        return { sleeve: "meme", feeTvl: null, follow: !!row.follow_chain_id };
      }
    }

    function inventoryMove(row) {
      const openCost = row.open_cost_sol != null ? Number(row.open_cost_sol) : null;
      const closeRet = row.close_return_sol != null ? Number(row.close_return_sol) : null;
      const entry = Number(row.entry_sol) || 0;
      const exitMarked = row.exit_sol != null ? Number(row.exit_sol) : null;
      if (openCost != null && closeRet != null) return closeRet - openCost;
      if (exitMarked != null && entry > 0) return exitMarked - entry;
      return null;
    }

    const enriched = closeRows.map((r) => {
      const meta = resolveSleeve(r);
      const holdH = r.exit_ts && r.entry_ts ? (Number(r.exit_ts) - Number(r.entry_ts)) / 3600 : null;
      const pnl = Number(r.pnl) || 0;
      const fees = Number(r.fees_sol) || 0;
      const inv = inventoryMove(r);
      return {
        ...r,
        sleeve: meta.sleeve,
        fee_tvl_24h: meta.feeTvl != null ? Number(meta.feeTvl) : null,
        follow: meta.follow || r.follow_chain_id != null,
        hold_h: holdH,
        pnl,
        fees_sol: fees,
        inventory_sol: inv,
      };
    });

    function aggBucket(rows) {
      const n = rows.length;
      if (!n) return { n: 0, pnl: 0, entry_sol: 0, pct: null, wins: 0, losses: 0, win_rate: null, avg_pnl: null, hold_median_h: null };
      let pnl = 0, entry = 0, wins = 0, losses = 0;
      const holds = [];
      for (const r of rows) {
        pnl += r.pnl;
        entry += Number(r.entry_sol) || 0;
        if (r.pnl > 0) wins += 1;
        else if (r.pnl < 0) losses += 1;
        if (r.hold_h != null) holds.push(r.hold_h);
      }
      holds.sort((a, b) => a - b);
      const mid = holds.length ? holds[Math.floor(holds.length / 2)] : null;
      return {
        n,
        pnl: round6(pnl),
        entry_sol: round6(entry),
        pct: entry > 0 ? Math.round((pnl / entry) * 1e6) / 1e6 : null,
        wins,
        losses,
        win_rate: n > 0 ? Math.round((wins / n) * 1e4) / 1e4 : null,
        avg_pnl: round6(pnl / n),
        hold_median_h: mid != null ? Math.round(mid * 100) / 100 : null,
      };
    }

    // Headline
    const wins = enriched.filter((r) => r.pnl > 0);
    const losses = enriched.filter((r) => r.pnl < 0);
    const avgWin = wins.length ? wins.reduce((s, r) => s + r.pnl, 0) / wins.length : null;
    const avgLoss = losses.length ? losses.reduce((s, r) => s + r.pnl, 0) / losses.length : null;
    const winRate = enriched.length ? wins.length / enriched.length : null;
    const expectancy = enriched.length
      ? (winRate ?? 0) * (avgWin ?? 0) + (1 - (winRate ?? 0)) * (avgLoss ?? 0)
      : null;
    let feesTotal = 0, invTotal = 0, invKnown = 0;
    for (const r of enriched) {
      feesTotal += r.fees_sol;
      if (r.inventory_sol != null) {
        invTotal += r.inventory_sol;
        invKnown += 1;
      }
    }
    const headline = {
      closes: enriched.length,
      win_rate: winRate != null ? Math.round(winRate * 1e4) / 1e4 : null,
      avg_win_sol: avgWin != null ? round6(avgWin) : null,
      avg_loss_sol: avgLoss != null ? round6(avgLoss) : null,
      expectancy_sol: expectancy != null ? round6(expectancy) : null,
      fees_sol: round6(feesTotal),
      inventory_sol: invKnown ? round6(invTotal) : null,
      pnl_sol: round6(enriched.reduce((s, r) => s + r.pnl, 0)),
    };

    // By exit reason
    const byReasonMap = new Map();
    for (const r of enriched) {
      const k = r.reason || "unknown";
      if (!byReasonMap.has(k)) byReasonMap.set(k, []);
      byReasonMap.get(k).push(r);
    }
    const by_reason = [...byReasonMap.entries()]
      .map(([reason, rows]) => ({ reason, ...aggBucket(rows) }))
      .sort((a, b) => a.pnl - b.pnl);

    // By sleeve (+ follow overlay bucket)
    const bySleeveMap = new Map();
    for (const r of enriched) {
      const k = r.follow ? "follow" : r.sleeve;
      if (!bySleeveMap.has(k)) bySleeveMap.set(k, []);
      bySleeveMap.get(k).push(r);
    }
    const by_sleeve = ["meme", "micro", "majors", "follow"]
      .filter((k) => bySleeveMap.has(k))
      .map((sleeve) => ({ sleeve, ...aggBucket(bySleeveMap.get(sleeve)) }));

    // Tokens best / worst
    const byMint = new Map();
    for (const r of enriched) {
      const k = r.mint || r.symbol;
      if (!byMint.has(k)) byMint.set(k, { mint: r.mint, symbol: r.symbol, rows: [] });
      byMint.get(k).rows.push(r);
    }
    const tokenAggs = [...byMint.values()].map((t) => ({
      symbol: t.symbol,
      mint: t.mint,
      ...aggBucket(t.rows),
    }));
    const tokens_best = [...tokenAggs].sort((a, b) => b.pnl - a.pnl).slice(0, 5);
    const tokens_worst = [...tokenAggs].sort((a, b) => a.pnl - b.pnl).slice(0, 5);

    // Follow scorecard
    const followRows = enriched.filter((r) => r.follow);
    const follow = {
      ...aggBucket(followRows),
      chains: db.prepare(
        `SELECT COUNT(DISTINCT follow_chain_id) AS n
         FROM positions
         WHERE mode = ? AND follow_chain_id IS NOT NULL AND exit_ts IS NOT NULL AND exit_ts >= ?`
      ).get(bookMode, since)?.n ?? 0,
    };

    // Funnel
    const funnelCounts = db.prepare(
      `SELECT
         SUM(CASE WHEN action='entered' THEN 1 ELSE 0 END) AS entered,
         SUM(CASE WHEN action='skipped' AND IFNULL(failed_gate,'') NOT LIKE '%open_failed%' THEN 1 ELSE 0 END) AS skipped,
         SUM(CASE WHEN IFNULL(failed_gate,'') LIKE '%open_failed%' THEN 1 ELSE 0 END) AS open_failed
       FROM decisions WHERE ts >= ?`
    ).get(since);
    const skipN = Number(funnelCounts?.skipped) || 0;
    const skip_share = skipTop
      .filter((s) => !String(s.g).includes("open_failed"))
      .map((s) => ({
        g: s.g,
        n: s.n,
        share: skipN > 0 ? Math.round((s.n / skipN) * 1e4) / 1e4 : null,
      }));
    const failRows = db.prepare(
      `SELECT features_json FROM decisions
       WHERE IFNULL(failed_gate,'') LIKE '%open_failed%' AND ts >= ?`
    ).all(since);
    const failCodes = {};
    for (const r of failRows) {
      let code = "unknown";
      try {
        const j = r.features_json ? JSON.parse(r.features_json) : {};
        code = j.code || "unknown";
        if (typeof code !== "string" || !code) code = "unknown";
      } catch { /* */ }
      failCodes[code] = (failCodes[code] || 0) + 1;
    }
    const fail_codes = Object.entries(failCodes)
      .map(([code, n]) => ({ code, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);
    const scoreRows = db.prepare(
      `SELECT score FROM decisions WHERE action='entered' AND ts >= ? AND score IS NOT NULL`
    ).all(since).map((r) => Number(r.score)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    function pctile(arr, p) {
      if (!arr.length) return null;
      const i = Math.min(arr.length - 1, Math.max(0, Math.floor((arr.length - 1) * p)));
      return Math.round(arr[i] * 100) / 100;
    }
    const entry_scores = {
      n: scoreRows.length,
      median: pctile(scoreRows, 0.5),
      p25: pctile(scoreRows, 0.25),
      p75: pctile(scoreRows, 0.75),
    };
    const enteredN = Number(funnelCounts?.entered) || 0;
    const failedN = Number(funnelCounts?.open_failed) || 0;
    const funnel = {
      entered: enteredN,
      skipped: skipN,
      open_failed: failedN,
      fail_rate: enteredN + failedN > 0
        ? Math.round((failedN / (enteredN + failedN)) * 1e4) / 1e4
        : null,
      skip_share,
      fail_codes,
      entry_scores,
    };

    // Time-in-range from marks
    let time_in_range = { avg_pct: null, n: 0, with_marks: 0 };
    if (enriched.length) {
      const ids = enriched.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      const tirRows = db.prepare(
        `SELECT position_id AS id, AVG(in_range * 1.0) AS tir, COUNT(*) AS n
         FROM position_marks WHERE position_id IN (${placeholders})
         GROUP BY position_id`
      ).all(...ids);
      const byId = Object.fromEntries(tirRows.map((r) => [r.id, r]));
      let sum = 0, known = 0;
      for (const r of enriched) {
        const t = byId[r.id];
        if (t && t.n > 0) {
          sum += Number(t.tir) || 0;
          known += 1;
        }
      }
      time_in_range = {
        avg_pct: known ? Math.round((sum / known) * 1e4) / 1e4 : null,
        n: enriched.length,
        with_marks: known,
      };
    }

    // Entry fee/TVL buckets vs outcome
    const withFee = enriched.filter((r) => r.fee_tvl_24h != null && Number.isFinite(r.fee_tvl_24h));
    withFee.sort((a, b) => a.fee_tvl_24h - b.fee_tvl_24h);
    const fee_tvl_buckets = [];
    if (withFee.length >= 3) {
      const third = Math.ceil(withFee.length / 3);
      const bands = [
        { label: "Low fee/TVL", rows: withFee.slice(0, third) },
        { label: "Mid fee/TVL", rows: withFee.slice(third, third * 2) },
        { label: "High fee/TVL", rows: withFee.slice(third * 2) },
      ];
      for (const b of bands) {
        if (!b.rows.length) continue;
        const fees = b.rows.map((r) => r.fee_tvl_24h);
        fee_tvl_buckets.push({
          label: b.label,
          fee_tvl_min: Math.round(Math.min(...fees) * 100) / 100,
          fee_tvl_max: Math.round(Math.max(...fees) * 100) / 100,
          ...aggBucket(b.rows),
        });
      }
    } else if (withFee.length) {
      fee_tvl_buckets.push({
        label: "All (few samples)",
        fee_tvl_min: Math.round(Math.min(...withFee.map((r) => r.fee_tvl_24h)) * 100) / 100,
        fee_tvl_max: Math.round(Math.max(...withFee.map((r) => r.fee_tvl_24h)) * 100) / 100,
        ...aggBucket(withFee),
      });
    }

    // Capital / open-book proxy from pnl_daily
    const capital_series = daily.map((r) => ({
      day: r.day,
      unrealized_sol: round6(r.unrealized_sol ?? 0),
      fees_sol: round6(r.fees_sol ?? 0),
      realized_sol: round6(r.realized_sol ?? 0),
    }));

    // Cluster pressure: lossy P0/P1 in range
    const hardLoss = enriched.filter((r) => {
      if (r.reason !== "P0_safety" && r.reason !== "P1_stop") return false;
      const entry = Number(r.entry_sol) || 0;
      return entry > 0 && r.pnl / entry <= -0.1;
    });
    const cluster_pressure = {
      hard_loss_exits: hardLoss.length,
      pnl: round6(hardLoss.reduce((s, r) => s + r.pnl, 0)),
      recent: hardLoss
        .slice()
        .sort((a, b) => Number(b.exit_ts) - Number(a.exit_ts))
        .slice(0, 5)
        .map((r) => ({
          id: r.id,
          symbol: r.symbol,
          mint: r.mint,
          reason: r.reason,
          pnl: round6(r.pnl),
          at: new Date(Number(r.exit_ts) * 1000).toISOString(),
        })),
    };

    return {
      range,
      since,
      at: new Date(now * 1000).toISOString(),
      book_mode: bookMode,
      equity,
      exits: exitDaily,
      exit_by_reason: exitByReason,
      exit_reasons: exitByReason.map((r) => r.reason),
      ladder,
      skip_top: skipTop,
      skip_series: skipSeries,
      activity,
      stats: {
        headline,
        by_reason,
        by_sleeve,
        fee_vs_inventory: {
          fees_sol: round6(feesTotal),
          inventory_sol: invKnown ? round6(invTotal) : null,
          n_with_inventory: invKnown,
        },
        tokens_best,
        tokens_worst,
        follow,
        funnel,
        time_in_range,
        fee_tvl_buckets,
        capital_series,
        cluster_pressure,
      },
    };
  } finally {
    db.close();
  }
}
