import { config } from "../config.js";
import { getDb, now, REALIZED_PNL_SQL } from "../db/db.js";

// Daily PnL rollup (§7) + paper->live promotion tracking (§8).
// Called once per manager tick; upserts today's row so the day's numbers are
// always current. A day is "profitable" when its total equity delta
// (realized + fees already inside realized + unrealized change) is positive.

function utcDay(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

let cachedSolUsd: { at: number; price: number | null } = { at: 0, price: null };

async function solUsd(): Promise<number | null> {
  if (Date.now() - cachedSolUsd.at < 300_000) return cachedSolUsd.price;
  try {
    const res = await fetch(
      `${config().apis.jupiter_price}?ids=So11111111111111111111111111111111111111112`,
      { signal: AbortSignal.timeout(8_000) }
    );
    const j = (await res.json()) as Record<string, { usdPrice?: number; price?: number }>;
    const entry = j["So11111111111111111111111111111111111111112"];
    cachedSolUsd = { at: Date.now(), price: entry?.usdPrice ?? entry?.price ?? null };
  } catch {
    cachedSolUsd = { at: Date.now(), price: cachedSolUsd.price };
  }
  return cachedSolUsd.price;
}

/** Upsert today's pnl_daily row. unrealizedSol = sum of open-position marks minus entries. */
export async function rollupDaily(mode: "paper" | "live", unrealizedSol: number): Promise<void> {
  const db = getDb();
  const day = utcDay(now());
  const dayStart = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);

  // Measured wallet delta per position, falling back to the notional mark for
  // rows closed before those columns existed. realized_sol is now the same
  // quantity the wallet moves by, so the daily series stops disagreeing in sign
  // with the account (08-08 read -0.026 against a true +0.097).
  const realized = (db.prepare(
    `SELECT COALESCE(SUM(${REALIZED_PNL_SQL}), 0) AS r
     FROM positions WHERE mode = ? AND exit_ts >= ? AND exit_ts IS NOT NULL`
  ).get(mode, dayStart) as { r: number }).r;

  // Disclosure only — fees are ALREADY inside realized above (claims via
  // fees_measured_sol, close-time collection via close_return_sol). Do not add
  // this to realized_sol; it is here to show where the return came from.
  const fees = (db.prepare(
    `SELECT COALESCE(SUM(p.fees_measured_sol + p.fees_at_close_sol), 0) AS f
     FROM positions p WHERE p.mode = ? AND p.exit_ts >= ? AND p.exit_ts IS NOT NULL`
  ).get(mode, dayStart) as { f: number }).f;

  const costs = (db.prepare(
    `SELECT COALESCE(SUM(e.tx_cost_sol), 0) AS c FROM events e
     JOIN positions p ON p.id = e.position_id
     WHERE p.mode = ? AND e.ts >= ?`
  ).get(mode, dayStart) as { c: number }).c;

  const usd = await solUsd();
  db.prepare(
    `INSERT INTO pnl_daily (day, mode, realized_sol, unrealized_sol, fees_sol, costs_sol, sol_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       mode = excluded.mode, realized_sol = excluded.realized_sol,
       unrealized_sol = excluded.unrealized_sol, fees_sol = excluded.fees_sol,
       costs_sol = excluded.costs_sol, sol_usd = excluded.sol_usd`
  ).run(day, mode, realized, unrealizedSol, fees, costs, usd);
}

export interface PromotionStatus {
  requiredDays: number;
  trackedDays: number;
  consecutiveProfitable: number;
  eligible: boolean;
  days: Array<{ day: string; realized: number; unrealizedDelta: number; profitable: boolean }>;
}

/** Paper->live promotion gate (§8): N consecutive profitable paper days. */
export function promotionStatus(): PromotionStatus {
  const required = config().exec.paper_promotion_days;
  const rows = getDb().prepare(
    `SELECT day, realized_sol, unrealized_sol FROM pnl_daily WHERE mode = 'paper' ORDER BY day ASC`
  ).all() as Array<{ day: string; realized_sol: number; unrealized_sol: number }>;

  const days: PromotionStatus["days"] = [];
  let prevUnrealized = 0;
  for (const r of rows) {
    const unrealizedDelta = r.unrealized_sol - prevUnrealized;
    const profitable = r.realized_sol + unrealizedDelta > 0;
    days.push({ day: r.day, realized: r.realized_sol, unrealizedDelta, profitable });
    prevUnrealized = r.unrealized_sol;
  }
  let consecutive = 0;
  for (let i = days.length - 1; i >= 0 && days[i]!.profitable; i--) consecutive++;
  return {
    requiredDays: required,
    trackedDays: days.length,
    consecutiveProfitable: consecutive,
    eligible: consecutive >= required,
    days: days.slice(-14),
  };
}
