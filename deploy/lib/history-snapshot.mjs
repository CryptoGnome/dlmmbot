/**
 * Historical series for the LAN dashboard — equity, exits, skips, activity.
 * Read-only against farmer.db.
 */
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { REALIZED_PNL } from "./live-book-snapshot.mjs";

function openDb(root) {
  const require = createRequire(resolve(root, "package.json"));
  const Database = require("better-sqlite3");
  return new Database(resolve(root, "data/farmer.db"), { readonly: true, fileMustExist: true });
}

function rangeStart(range, now) {
  if (range === "7d") return now - 7 * 86_400;
  if (range === "30d") return now - 30 * 86_400;
  return 0; // all
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
      `SELECT day, realized_sol, unrealized_sol, fees_sol, costs_sol
       FROM pnl_daily
       WHERE mode='live' AND day >= ?
       ORDER BY day ASC`
    ).all(dayCutoff);

    let cumRealized = 0;
    let cumFees = 0;
    const equity = daily.map((r) => {
      cumRealized += r.realized_sol ?? 0;
      cumFees += r.fees_sol ?? 0;
      return {
        day: r.day,
        realized: Math.round((r.realized_sol ?? 0) * 1e6) / 1e6,
        unrealized: Math.round((r.unrealized_sol ?? 0) * 1e6) / 1e6,
        fees: Math.round((r.fees_sol ?? 0) * 1e6) / 1e6,
        costs: Math.round((r.costs_sol ?? 0) * 1e6) / 1e6,
        cum_realized: Math.round(cumRealized * 1e6) / 1e6,
        cum_fees: Math.round(cumFees * 1e6) / 1e6,
      };
    });

    const exitRows = db.prepare(
      `SELECT date(exit_ts,'unixepoch') AS day, exit_reason,
              COUNT(*) AS n,
              ROUND(SUM(${REALIZED_PNL}), 6) AS pnl
       FROM positions
       WHERE mode='live' AND exit_ts IS NOT NULL AND exit_ts >= ?
       GROUP BY day, exit_reason
       ORDER BY day ASC`
    ).all(since);

    const exitDays = {};
    const reasons = new Set();
    for (const r of exitRows) {
      reasons.add(r.exit_reason ?? "unknown");
      if (!exitDays[r.day]) exitDays[r.day] = { day: r.day };
      exitDays[r.day][r.exit_reason ?? "unknown"] = r.pnl ?? 0;
      exitDays[r.day][`${r.exit_reason ?? "unknown"}_n`] = r.n;
    }
    const exits = Object.values(exitDays).sort((a, b) => a.day.localeCompare(b.day));

    const ladder = db.prepare(
      `SELECT id, symbol, exit_reason,
              datetime(exit_ts,'unixepoch') AS at,
              exit_ts,
              ROUND((${REALIZED_PNL}), 6) AS pnl,
              ROUND(entry_sol, 4) AS entry_sol
       FROM positions
       WHERE mode='live' AND exit_ts IS NOT NULL AND exit_ts >= ?
       ORDER BY exit_ts DESC
       LIMIT 40`
    ).all(since);

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
      exits,
      exit_reasons: [...reasons],
      ladder,
      skip_top: skipTop,
      skip_series: skipSeries,
      activity,
    };
  } finally {
    db.close();
  }
}
