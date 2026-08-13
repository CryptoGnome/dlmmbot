/**
 * Historical series for the LAN dashboard — equity, exits, skips, activity.
 * Read-only against farmer.db.
 */
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { REALIZED_PNL } from "./live-book-snapshot.mjs";
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

    const daily = db.prepare(
      `SELECT day, realized_sol, unrealized_sol, fees_sol, costs_sol, sol_usd
       FROM pnl_daily
       WHERE mode='live' AND day >= ?
       ORDER BY day ASC`
    ).all(dayCutoff);

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
       WHERE mode='live' AND exit_ts IS NOT NULL AND exit_ts >= ?
       GROUP BY day
       ORDER BY day ASC`
    ).all(since).map((r) => ({
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
       WHERE mode='live' AND exit_ts IS NOT NULL AND exit_ts >= ?
       GROUP BY exit_reason
       ORDER BY pnl ASC`
    ).all(since).map((r) => ({
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
              ROUND(open_cost_sol, 6) AS open_cost_sol,
              ROUND(close_return_sol, 6) AS close_return_sol,
              ROUND(COALESCE(fees_measured_sol, fees_claimed_sol), 6) AS fees_sol,
              ROUND(COALESCE(recovered_sol, 0), 6) AS recovered_sol,
              ROUND(COALESCE(fees_at_close_sol, 0), 6) AS fees_at_close_sol,
              ROUND(exit_sol, 6) AS exit_sol
       FROM positions
       WHERE mode='live' AND exit_ts IS NOT NULL AND exit_ts >= ?
       ORDER BY exit_ts DESC
       LIMIT 40`
    ).all(since).map((r) => {
      const openCost = r.open_cost_sol != null ? Number(r.open_cost_sol) : null;
      const closeRet = r.close_return_sol != null ? Number(r.close_return_sol) : null;
      const fees = Number(r.fees_sol) || 0;
      const recovered = Number(r.recovered_sol) || 0;
      const entry = Number(r.entry_sol) || 0;
      const exitMarked = r.exit_sol != null ? Number(r.exit_sol) : null;
      // Wallet exit move (ex fees/recovered): close_return − open_cost, else marked exit − entry.
      const exitMove = openCost != null && closeRet != null
        ? Math.round((closeRet - openCost) * 1e6) / 1e6
        : exitMarked != null && entry > 0
          ? Math.round((exitMarked - entry) * 1e6) / 1e6
          : null;
      return {
        ...r,
        fees_sol: Math.round(fees * 1e6) / 1e6,
        recovered_sol: Math.round(recovered * 1e6) / 1e6,
        exit_move_sol: exitMove,
        pct: entry > 0 ? Math.round((r.pnl / entry) * 1e6) / 1e6 : null,
      };
    });

    const skipTop = db.prepare(
      `SELECT failed_gate AS g, COUNT(*) AS n
       FROM decisions
       WHERE action='skipped' AND ts >= ? AND failed_gate IS NOT NULL
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
              SUM(CASE WHEN action='skipped' THEN 1 ELSE 0 END) AS skipped
       FROM decisions
       WHERE ts >= ?
       GROUP BY day
       ORDER BY day ASC`
    ).all(since);

    return {
      range,
      since,
      at: new Date(now * 1000).toISOString(),
      equity,
      exits: exitDaily,
      exit_by_reason: exitByReason,
      exit_reasons: exitByReason.map((r) => r.reason),
      ladder,
      skip_top: skipTop,
      skip_series: skipSeries,
      activity,
    };
  } finally {
    db.close();
  }
}
