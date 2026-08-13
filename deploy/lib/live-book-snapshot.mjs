/**
 * Shared live-book snapshot — used by watch-live-book.mjs and dashboard-server.
 * Read-only against farmer.db.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

export const REALIZED_PNL = `
  CASE WHEN open_cost_sol IS NOT NULL AND close_return_sol IS NOT NULL
       THEN close_return_sol + fees_measured_sol + recovered_sol - open_cost_sol
       WHEN entry_sol > 0
       THEN exit_sol - entry_sol + fees_claimed_sol
       ELSE 0 END`;

function git(root, cmd) {
  try {
    return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function tomlNum(toml, key) {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*([0-9.]+)`, "m").exec(toml);
  return m ? Number(m[1]) : null;
}

function tomlBool(toml, key) {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*(true|false)`, "m").exec(toml);
  return m ? m[1] === "true" : null;
}

function openDb(root) {
  const require = createRequire(resolve(root, "package.json"));
  const Database = require("better-sqlite3");
  return new Database(resolve(root, "data/farmer.db"), { readonly: true, fileMustExist: true });
}

/**
 * @param {string} root farmer repo root
 * @returns {object} live watch JSON
 */
export function buildLiveBookSnapshot(root) {
  const db = openDb(root);
  try {
    const now = Math.floor(Date.now() / 1000);
    const dayAgo = now - 86_400;
    const weekAgo = now - 7 * 86_400;

    const fixSha = git(root, "git rev-parse --verify 1b1514b") ? "1b1514b" : null;
    const fixTs = fixSha
      ? Number(git(root, `git show -s --format=%ct ${fixSha}`)) || (now - 86_400)
      : now - 86_400;

    const toml = readFileSync(resolve(root, "config.toml"), "utf8");
    const head = git(root, "git rev-parse --short HEAD");
    const headMsg = git(root, "git log -1 --pretty=%s");

    const heartbeat = db.prepare("SELECT value FROM meta WHERE key='heartbeat'").get()?.value;
    let hb = null;
    try { hb = heartbeat ? JSON.parse(heartbeat) : null; } catch { /* */ }

    const open = db.prepare(
      `SELECT id, symbol, mode, state, round(entry_sol,4) entry_sol,
              datetime(entry_ts,'unixepoch') opened
       FROM positions WHERE state IN ('open','pending','closing') ORDER BY id`
    ).all();

    const closesSince = (since) => db.prepare(
      `SELECT exit_reason,
              COUNT(*) n,
              ROUND(SUM(${REALIZED_PNL}), 6) pnl,
              ROUND(AVG(${REALIZED_PNL}), 6) avg_pnl
       FROM positions
       WHERE mode='live' AND exit_ts IS NOT NULL AND exit_ts > ?
       GROUP BY exit_reason ORDER BY n DESC`
    ).all(since);

    const allLive = db.prepare(
      `SELECT COUNT(*) n, ROUND(SUM(${REALIZED_PNL}), 6) pnl
       FROM positions WHERE mode='live' AND exit_ts IS NOT NULL`
    ).get();

    const kellyRows = db.prepare(
      `SELECT (${REALIZED_PNL}) / entry_sol AS ret
       FROM positions
       WHERE exit_ts IS NOT NULL AND entry_sol > 0 AND follow_chain_id IS NULL
       ORDER BY exit_ts DESC LIMIT 50`
    ).all();

    function kellyFrom(rows) {
      const n = rows.length;
      const minSamples = tomlNum(toml, "kelly_min_samples") ?? 50;
      const frac = tomlNum(toml, "kelly_fraction") ?? 0.5;
      const cold = tomlNum(toml, "kelly_cold_start_frac") ?? 0.02;
      const maxF = tomlNum(toml, "kelly_max_position_frac") ?? 0.05;
      if (n < minSamples) {
        return { samples: n, regime: "cold_start", appliedFraction: cold, fullKelly: null, winRate: null };
      }
      const wins = rows.filter((r) => r.ret > 0).map((r) => r.ret);
      const losses = rows.filter((r) => r.ret <= 0).map((r) => -r.ret);
      const p = wins.length / n;
      const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
      const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
      if (avgLoss === 0) {
        return { samples: n, regime: "kelly", appliedFraction: maxF, fullKelly: null, winRate: p };
      }
      if (avgWin === 0) {
        return { samples: n, regime: "negative_edge", appliedFraction: 0, fullKelly: 0, winRate: p };
      }
      const fullKelly = p - (1 - p) / (avgWin / avgLoss);
      const applied = Math.min(Math.max(fullKelly * frac, 0), maxF);
      return {
        samples: n,
        regime: fullKelly <= 0 ? "negative_edge" : "kelly",
        appliedFraction: applied,
        fullKelly,
        winRate: p,
      };
    }

    const clusterExits = tomlNum(toml, "cluster_brake_exits") ?? 2;
    const clusterWindowH = tomlNum(toml, "cluster_brake_window_h") ?? 6;
    const clusterPauseH = tomlNum(toml, "cluster_brake_pause_h") ?? 6;
    const hard = db.prepare(
      `SELECT exit_ts, exit_reason, symbol
       FROM positions
       WHERE exit_reason IN ('P0_safety','P1_stop') AND exit_ts IS NOT NULL
         AND exit_ts > ?
       ORDER BY exit_ts DESC`
    ).all(now - clusterWindowH * 3600);

    let cluster = { tripped: false, count: hard.length, remainingMin: 0, recent: hard.slice(0, 5) };
    if (hard.length >= clusterExits) {
      const tripTs = hard[clusterExits - 1].exit_ts;
      const elapsed = now - tripTs;
      const pauseS = clusterPauseH * 3600;
      if (elapsed < pauseS) {
        cluster = {
          tripped: true,
          count: hard.length,
          remainingMin: Math.ceil((pauseS - elapsed) / 60),
          recent: hard.slice(0, 5),
        };
      }
    }

    const openFailed = db.prepare(
      `SELECT datetime(ts,'unixepoch') at, mint, substr(features_json,1,400) feat
       FROM decisions
       WHERE failed_gate='open_failed' AND ts > ?
       ORDER BY ts DESC LIMIT 20`
    ).all(fixTs);

    function parseOpenFail(feat) {
      try {
        const j = JSON.parse(feat);
        return { code: j.code ?? null, error: (j.error ?? "").slice(0, 120) };
      } catch {
        return { code: null, error: feat.slice(0, 80) };
      }
    }

    const openFailCodes = {};
    for (const r of openFailed) {
      const p = parseOpenFail(r.feat);
      const k = p.code ?? "null";
      openFailCodes[k] = (openFailCodes[k] ?? 0) + 1;
    }

    const markGaps = db.prepare(
      `WITH gaps AS (
         SELECT position_id,
                ts - LAG(ts) OVER (PARTITION BY position_id ORDER BY ts) AS gap
         FROM position_marks
         WHERE ts > ?
       )
       SELECT position_id,
              COUNT(*) n,
              ROUND(AVG(gap),1) mean_gap,
              MAX(gap) max_gap
       FROM gaps WHERE gap IS NOT NULL
       GROUP BY position_id
       HAVING COUNT(*) >= 5
       ORDER BY max_gap DESC
       LIMIT 15`
    ).all(weekAgo);

    const gapFails = markGaps.filter((g) => g.mean_gap < 14 || g.mean_gap > 20 || g.max_gap >= 60);

    const binCoverage = db.prepare(
      `SELECT COUNT(*) closes,
              COALESCE(SUM(CASE WHEN detail_json LIKE '%"bins"%' THEN 1 ELSE 0 END), 0) with_bins
       FROM events
       WHERE type IN ('withdraw','safety_exit') AND ts > ?`
    ).get(fixTs);

    const follow = db.prepare(
      `SELECT state, COUNT(*) n, ROUND(SUM(chain_pnl_sol),4) pnl
       FROM follow_chains WHERE started_ts > ? GROUP BY state`
    ).all(fixTs);

    const p3Missed = db.prepare(
      `SELECT id, symbol, datetime(exit_ts,'unixepoch') at,
              ROUND((${REALIZED_PNL}),4) pnl,
              ROUND((exit_ts - entry_ts)/60.0,1) hold_min
       FROM positions
       WHERE mode='live' AND exit_reason='P3_above' AND state='closed_missed' AND exit_ts > ?
       ORDER BY exit_ts DESC LIMIT 10`
    ).all(fixTs);

    const BIN_RENT_SCORE_MIN = 70;
    const BIN_RENT_GATES = ["bin_rent", "majors_bin_rent"];

    function parseBinRentNearMiss(feat) {
      try {
        const j = JSON.parse(feat);
        const range = j.range ?? {};
        const pool = j.pool ?? j.cand?.pool ?? {};
        return {
          symbol: pool.symbol ?? pool.name?.split("-")[0] ?? null,
          pool: pool.address ?? j.poolAddress ?? null,
          estRentSol: range.estBinRentSol ?? null,
          binCount: range.binCount ?? null,
          bottomPct: range.bottomPricePct ?? null,
          rentBudget: j.rentBudget ?? null,
          sleeve: j.sleeve ?? null,
        };
      } catch {
        return {};
      }
    }

    function binRentNearMiss(since) {
      const gates = BIN_RENT_GATES.map(() => "?").join(",");
      const byGate = db.prepare(
        `SELECT failed_gate g, COUNT(*) n
         FROM decisions
         WHERE action='skipped' AND failed_gate IN (${gates}) AND score >= ? AND ts > ?
         GROUP BY failed_gate ORDER BY n DESC`
      ).all(...BIN_RENT_GATES, BIN_RENT_SCORE_MIN, since);
      const n = byGate.reduce((s, r) => s + r.n, 0);
      const recent = db.prepare(
        `SELECT datetime(ts,'unixepoch') at, mint, pool, failed_gate g, ROUND(score,1) score,
                substr(features_json,1,500) feat
         FROM decisions
         WHERE action='skipped' AND failed_gate IN (${gates}) AND score >= ? AND ts > ?
         ORDER BY ts DESC LIMIT 8`
      ).all(...BIN_RENT_GATES, BIN_RENT_SCORE_MIN, since);
      const best = db.prepare(
        `SELECT datetime(ts,'unixepoch') at, mint, pool, failed_gate g, ROUND(score,1) score,
                substr(features_json,1,500) feat
         FROM decisions
         WHERE action='skipped' AND failed_gate IN (${gates}) AND score >= ? AND ts > ?
         ORDER BY score DESC LIMIT 1`
      ).get(...BIN_RENT_GATES, BIN_RENT_SCORE_MIN, since);
      const mapRow = (r) => r ? {
        at: r.at,
        mint: r.mint?.slice(0, 8),
        pool: r.pool?.slice(0, 8),
        gate: r.g,
        score: r.score,
        ...parseBinRentNearMiss(r.feat),
      } : null;
      return { n, score_min: BIN_RENT_SCORE_MIN, by_gate: byGate, best: mapRow(best),
        recent: recent.map(mapRow) };
    }

    const sinceFix = closesSince(fixTs);
    const last24 = closesSince(dayAgo);

    return {
      ts: now,
      at: new Date(now * 1000).toISOString(),
      host: git(root, "hostname") ?? "local",
      build: { head, message: headMsg, fix_sha: fixSha, fix_ts: fixTs, fix_at: new Date(fixTs * 1000).toISOString() },
      config: {
        liquidity_slippage_pct: tomlNum(toml, "liquidity_slippage_pct"),
        above_range_sustain_min: tomlNum(toml, "above_range_sustain_min"),
        above_range_missed_sustain_min: tomlNum(toml, "above_range_missed_sustain_min"),
        cluster_brake_exits: clusterExits,
        cluster_brake_window_h: clusterWindowH,
        cluster_brake_pause_h: clusterPauseH,
        open_fail_cooldown_s: tomlNum(toml, "open_fail_cooldown_s"),
        kelly_enabled: tomlBool(toml, "kelly_enabled"),
        kelly_min_samples: tomlNum(toml, "kelly_min_samples"),
        max_positions: tomlNum(toml, "max_positions"),
        stop_loss_frac: tomlNum(toml, "stop_loss_frac"),
      },
      heartbeat: hb,
      heartbeat_age_s: hb?.ts ? now - hb.ts : null,
      open,
      book: {
        all_time_live: allLive,
        since_fix: {
          by_reason: sinceFix,
          n: sinceFix.reduce((s, r) => s + r.n, 0),
          pnl: sinceFix.reduce((s, r) => s + (r.pnl ?? 0), 0),
        },
        last_24h: {
          by_reason: last24,
          n: last24.reduce((s, r) => s + r.n, 0),
          pnl: last24.reduce((s, r) => s + (r.pnl ?? 0), 0),
        },
      },
      kelly: kellyFrom(kellyRows),
      cluster,
      open_failed_since_fix: {
        n: openFailed.length,
        by_code: openFailCodes,
        recent: openFailed.slice(0, 5).map((r) => ({
          at: r.at, mint: r.mint.slice(0, 8), ...parseOpenFail(r.feat),
        })),
      },
      integrity: {
        mark_gaps: {
          positions_checked: markGaps.length,
          fail_count: gapFails.length,
          pass: gapFails.length === 0 && markGaps.length > 0,
          worst: markGaps.slice(0, 5),
          fails: gapFails.slice(0, 5),
        },
        per_bin_closes: binCoverage,
      },
      follow_since_fix: follow,
      p3_missed_since_fix: p3Missed,
      bin_rent_near_miss: {
        since_fix: binRentNearMiss(fixTs),
        last_24h: binRentNearMiss(dayAgo),
      },
    };
  } finally {
    db.close();
  }
}
