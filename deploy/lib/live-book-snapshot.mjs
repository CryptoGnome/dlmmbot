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

/** Meteora DLMM portfolio totals — same source as app.meteora.ag/portfolio. */
function fetchMeteoraPortfolio(wallet) {
  if (!wallet) return null;
  try {
    const total = JSON.parse(execSync(
      `curl -sS --max-time 4 "https://dlmm.datapi.meteora.ag/portfolio/total?user=${wallet}"`,
      { encoding: "utf8" },
    ));
    const open = JSON.parse(execSync(
      `curl -sS --max-time 4 "https://dlmm.datapi.meteora.ag/portfolio/open?user=${wallet}&page_size=20"`,
      { encoding: "utf8" },
    ));
    return {
      closed_n: total.totalClosedPositions ?? null,
      closed_pnl_sol: total.totalPnlSol != null ? Math.round(Number(total.totalPnlSol) * 1e6) / 1e6 : null,
      closed_pct: total.totalPnlSolPctChange != null ? Math.round(Number(total.totalPnlSolPctChange) * 1e4) / 1e4 : null,
      open_n: open.totalPositions ?? open.total?.totalPositions ?? null,
      open_bal_sol: open.total?.balancesSol != null ? Math.round(Number(open.total.balancesSol) * 1e6) / 1e6 : null,
      open_pnl_sol: open.total?.pnlSol != null ? Math.round(Number(open.total.pnlSol) * 1e6) / 1e6 : null,
      source: "dlmm.datapi.meteora.ag",
    };
  } catch {
    return null;
  }
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

    const featStmt = db.prepare(
      `SELECT features_json FROM decisions
       WHERE action='entered' AND mint = ? ORDER BY ts DESC LIMIT 1`
    );

    function priceAtBin(refPrice, refBin, targetBin, binStep) {
      if (!(refPrice > 0) || refBin == null || targetBin == null || !(binStep > 0)) return null;
      return refPrice * Math.pow(1 + binStep / 10_000, targetBin - refBin);
    }

    const open = db.prepare(
      `SELECT p.id, p.symbol, p.token_mint AS mint, p.mode, p.state, p.pool,
              round(p.entry_sol,4) entry_sol, round(p.entry_price,12) entry_price,
              round(p.open_cost_sol,6) open_cost_sol,
              p.min_bin_id, p.max_bin_id,
              round(p.fees_claimed_sol,6) fees_claimed_sol,
              datetime(p.entry_ts,'unixepoch') opened,
              m.value_sol, m.value_frac, m.unclaimed_fees_sol, m.in_range,
              m.active_bin_id, m.price AS mark_price, m.ts AS mark_ts,
              datetime(m.ts,'unixepoch') marked
       FROM positions p
       LEFT JOIN position_marks m ON m.id = (
         SELECT id FROM position_marks WHERE position_id = p.id ORDER BY ts DESC LIMIT 1
       )
       WHERE p.state IN ('open','pending','closing')
       ORDER BY p.id`
    ).all().map((r) => {
      let value = r.value_sol != null ? Number(r.value_sol) : null;
      const entry = Number(r.entry_sol) || 0;
      let unclaimed = r.unclaimed_fees_sol != null ? Number(r.unclaimed_fees_sol) : null;
      const claimed = Number(r.fees_claimed_sol) || 0;
      let markUnreliable = false;
      // value_sol=0 with a live price is almost always a failed rebalance / empty
      // SDK read — not a real −100% wipe. Prefer last healthy mark for display.
      if (value === 0 && entry > 0 && r.mark_price != null && Number(r.mark_price) > 0) {
        const prev = db.prepare(
          `SELECT value_sol, value_frac, unclaimed_fees_sol, ts
           FROM position_marks
           WHERE position_id = ? AND value_sol > 0
           ORDER BY ts DESC LIMIT 1`
        ).get(r.id);
        if (prev && Number(prev.value_sol) > 0) {
          value = Number(prev.value_sol);
          unclaimed = prev.unclaimed_fees_sol != null ? Number(prev.unclaimed_fees_sol) : unclaimed;
          markUnreliable = true;
        } else {
          value = null;
          markUnreliable = true;
        }
      }
      const pnl = value != null ? value - entry : null;
      const pct = value != null && entry > 0 ? (value / entry) - 1 : null;
      const liq = value != null
        ? Math.round((value - (unclaimed ?? 0)) * 1e6) / 1e6
        : null;
      const invPnl = liq != null ? Math.round((liq - entry) * 1e6) / 1e6 : null;
      const totalPnl = value != null
        ? Math.round((value - entry + claimed) * 1e6) / 1e6
        : null;
      const minBin = r.min_bin_id;
      const maxBin = r.max_bin_id;
      const activeBin = r.active_bin_id;
      let status = "unknown";
      if (activeBin != null && minBin != null && maxBin != null) {
        if (activeBin > maxBin) status = "above";
        else if (activeBin < minBin) status = "below";
        else status = "in";
      } else if (r.in_range != null) {
        status = r.in_range ? "in" : "out";
      }

      let binStep = 100;
      try {
        const feat = featStmt.get(r.mint);
        const j = feat?.features_json ? JSON.parse(feat.features_json) : {};
        if (j.pool?.binStep) binStep = j.pool.binStep;
      } catch { /* */ }

      const markPrice = r.mark_price != null ? Number(r.mark_price) : null;
      const lowPx = priceAtBin(markPrice, activeBin, minBin, binStep);
      const highPx = priceAtBin(markPrice, activeBin, maxBin, binStep);

      return {
        id: r.id,
        symbol: r.symbol,
        mint: r.mint,
        mode: r.mode,
        state: r.state,
        entry_sol: entry,
        entry_price: r.entry_price,
        open_cost_sol: r.open_cost_sol != null ? Number(r.open_cost_sol) : null,
        opened: r.opened,
        fees_claimed_sol: claimed,
        min_bin_id: minBin,
        max_bin_id: maxBin,
        range_status: status,
        range: {
          min_bin: minBin,
          max_bin: maxBin,
          active_bin: activeBin,
          min_price: lowPx,
          max_price: highPx,
          price: markPrice,
          status,
        },
        mark: value != null || markUnreliable ? {
          value_sol: value != null ? Math.round(value * 1e6) / 1e6 : null,
          liq_sol: liq,
          pnl_sol: pnl != null ? Math.round(pnl * 1e6) / 1e6 : null,
          inv_pnl_sol: invPnl,
          total_pnl_sol: totalPnl,
          pct: pct != null ? Math.round(pct * 1e6) / 1e6 : null,
          unclaimed_fees_sol: unclaimed != null ? Math.round(unclaimed * 1e6) / 1e6 : null,
          fees_claimed_sol: claimed,
          in_range: status === "in",
          status,
          unreliable: markUnreliable,
          active_bin_id: activeBin,
          price: markPrice,
          age_s: r.mark_ts != null ? now - Number(r.mark_ts) : null,
          at: r.marked,
        } : null,
      };
    });

    const closesSince = (since) => {
      const byReason = db.prepare(
        `SELECT exit_reason,
                COUNT(*) n,
                ROUND(SUM(${REALIZED_PNL}), 6) pnl,
                ROUND(AVG(${REALIZED_PNL}), 6) avg_pnl,
                ROUND(SUM(entry_sol), 6) entry_sol
         FROM positions
         WHERE mode='live' AND exit_ts IS NOT NULL AND exit_ts > ?
         GROUP BY exit_reason ORDER BY n DESC`
      ).all(since);
      return byReason.map((r) => ({
        ...r,
        pct: r.entry_sol > 0 ? Math.round((r.pnl / r.entry_sol) * 1e6) / 1e6 : null,
      }));
    };

    const allLiveRow = db.prepare(
      `SELECT COUNT(*) n, ROUND(SUM(${REALIZED_PNL}), 6) pnl, ROUND(SUM(entry_sol), 6) entry_sol
       FROM positions WHERE mode='live' AND exit_ts IS NOT NULL`
    ).get();
    const allLive = {
      ...allLiveRow,
      pct: allLiveRow.entry_sol > 0
        ? Math.round((allLiveRow.pnl / allLiveRow.entry_sol) * 1e6) / 1e6
        : null,
    };

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
    const clearedRaw = db.prepare(
      "SELECT value FROM meta WHERE key='cluster_brake_cleared_at'"
    ).get()?.value;
    const clearedAt = clearedRaw != null ? Number(clearedRaw) : 0;
    const clusterSince = Math.max(
      now - clusterWindowH * 3600,
      Number.isFinite(clearedAt) ? clearedAt : 0,
    );
    const hard = db.prepare(
      `SELECT exit_ts, exit_reason, symbol
       FROM positions
       WHERE exit_reason IN ('P0_safety','P1_stop') AND exit_ts IS NOT NULL
         AND exit_ts > ?
       ORDER BY exit_ts DESC`
    ).all(clusterSince);

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
      `SELECT id, symbol, token_mint AS mint, datetime(exit_ts,'unixepoch') at,
              ROUND((${REALIZED_PNL}),4) pnl,
              ROUND(entry_sol, 4) entry_sol,
              ROUND((exit_ts - entry_ts)/60.0,1) hold_min
       FROM positions
       WHERE mode='live' AND exit_reason='P3_above' AND state='closed_missed' AND exit_ts > ?
       ORDER BY exit_ts DESC LIMIT 10`
    ).all(fixTs).map((r) => ({
      ...r,
      pct: r.entry_sol > 0 ? Math.round((r.pnl / r.entry_sol) * 1e6) / 1e6 : null,
    }));

    const BIN_RENT_SCORE_MIN = 70;
    const BIN_RENT_GATES = ["bin_rent", "majors_bin_rent"];

    function parseEntryFeat(feat) {
      try {
        const j = JSON.parse(feat);
        const pool = j.pool ?? {};
        const name = pool.name ?? pool.symbol ?? null;
        return {
          size: typeof j.size === "number" ? Math.round(j.size * 1e4) / 1e4 : null,
          sleeve: j.sleeve ?? (j.follow ? "follow" : null),
          isAlpha: !!j.isAlpha,
          symbol: name ? String(name).split("-")[0] : null,
          baseScore: typeof j.experiment?.baseScore === "number"
            ? Math.round(j.experiment.baseScore * 10) / 10
            : null,
        };
      } catch {
        return {};
      }
    }

    const recentPasses = db.prepare(
      `SELECT datetime(d.ts,'unixepoch') at, d.mint, d.pool, ROUND(d.score,1) score,
              COALESCE(NULLIF(t.symbol,''), NULLIF(
                (SELECT p.symbol FROM positions p WHERE p.token_mint = d.mint ORDER BY p.id DESC LIMIT 1),
                ''), '?') AS symbol,
              json_extract(d.features_json, '$.size') AS size,
              json_extract(d.features_json, '$.sleeve') AS sleeve,
              json_extract(d.features_json, '$.isAlpha') AS is_alpha,
              json_extract(d.features_json, '$.experiment.baseScore') AS base_score,
              json_extract(d.features_json, '$.pool.name') AS pool_name,
              json_extract(d.features_json, '$.follow') AS follow
       FROM decisions d
       LEFT JOIN tokens t ON t.mint = d.mint
       WHERE d.action='entered' AND d.ts > ?
       ORDER BY d.ts DESC
       LIMIT 12`
    ).all(weekAgo).map((r) => {
      const name = r.pool_name ? String(r.pool_name).split("-")[0] : null;
      const size = typeof r.size === "number" ? Math.round(r.size * 1e4) / 1e4 : null;
      const baseScore = typeof r.base_score === "number" ? Math.round(r.base_score * 10) / 10 : null;
      return {
        at: r.at,
        mint: r.mint || null,
        pool: r.pool || null,
        score: r.score,
        size,
        sleeve: r.sleeve || (r.follow ? "follow" : null),
        isAlpha: !!r.is_alpha,
        baseScore,
        symbol: r.symbol && r.symbol !== "?" ? r.symbol : (name || "?"),
      };
    });

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
        `SELECT datetime(d.ts,'unixepoch') at, d.mint, d.pool, d.failed_gate g, ROUND(d.score,1) score,
                COALESCE(NULLIF(t.symbol,''), NULLIF(
                  (SELECT p.symbol FROM positions p WHERE p.token_mint = d.mint ORDER BY p.id DESC LIMIT 1),
                  ''), '?') AS symbol,
                substr(d.features_json,1,500) feat
         FROM decisions d
         LEFT JOIN tokens t ON t.mint = d.mint
         WHERE d.action='skipped' AND d.failed_gate IN (${gates}) AND d.score >= ? AND d.ts > ?
         ORDER BY d.ts DESC LIMIT 8`
      ).all(...BIN_RENT_GATES, BIN_RENT_SCORE_MIN, since);
      const best = db.prepare(
        `SELECT datetime(d.ts,'unixepoch') at, d.mint, d.pool, d.failed_gate g, ROUND(d.score,1) score,
                COALESCE(NULLIF(t.symbol,''), NULLIF(
                  (SELECT p.symbol FROM positions p WHERE p.token_mint = d.mint ORDER BY p.id DESC LIMIT 1),
                  ''), '?') AS symbol,
                substr(d.features_json,1,500) feat
         FROM decisions d
         LEFT JOIN tokens t ON t.mint = d.mint
         WHERE d.action='skipped' AND d.failed_gate IN (${gates}) AND d.score >= ? AND d.ts > ?
         ORDER BY d.score DESC LIMIT 1`
      ).get(...BIN_RENT_GATES, BIN_RENT_SCORE_MIN, since);
      const mapRow = (r) => {
        if (!r) return null;
        const feat = parseBinRentNearMiss(r.feat);
        return {
          at: r.at,
          mint: r.mint || null,
          pool: r.pool || feat.pool || null,
          gate: r.g,
          score: r.score,
          ...feat,
          symbol: r.symbol || feat.symbol || "?",
        };
      };
      return { n, score_min: BIN_RENT_SCORE_MIN, by_gate: byGate, best: mapRow(best),
        recent: recent.map(mapRow) };
    }

    const sinceFix = closesSince(fixTs);
    const last24 = closesSince(dayAgo);
    const bookAgg = (rows) => {
      const n = rows.reduce((s, r) => s + r.n, 0);
      const pnl = rows.reduce((s, r) => s + (r.pnl ?? 0), 0);
      const entry_sol = rows.reduce((s, r) => s + (r.entry_sol ?? 0), 0);
      return {
        by_reason: rows,
        n,
        pnl,
        entry_sol,
        pct: entry_sol > 0 ? Math.round((pnl / entry_sol) * 1e6) / 1e6 : null,
      };
    };

    const deployedSol = open.reduce((s, p) => {
      const mark = p.mark?.value_sol;
      return s + (typeof mark === "number" && Number.isFinite(mark) ? mark : (p.entry_sol ?? 0));
    }, 0);
    const walletSol = typeof hb?.walletSol === "number" ? hb.walletSol : null;
    const solUsdRow = db.prepare(
      `SELECT sol_usd FROM pnl_daily WHERE mode='live' AND sol_usd > 0 ORDER BY day DESC LIMIT 1`
    ).get();
    const solUsd = solUsdRow?.sol_usd ?? null;
    const totalSol = walletSol != null ? walletSol + deployedSol : null;
    const balance = {
      wallet_sol: walletSol != null ? Math.round(walletSol * 1e6) / 1e6 : null,
      deployed_sol: Math.round(deployedSol * 1e6) / 1e6,
      total_sol: totalSol != null ? Math.round(totalSol * 1e6) / 1e6 : null,
      sol_usd: solUsd,
      total_usd: totalSol != null && solUsd
        ? Math.round(totalSol * solUsd * 100) / 100
        : null,
      wallet_usd: walletSol != null && solUsd
        ? Math.round(walletSol * solUsd * 100) / 100
        : null,
    };

    // Meteora Data API — LP deposit/withdraw/fee PnL (what app.meteora.ag/portfolio shows).
    // Distinct from our wallet-measured book (includes rent + post-exit swap slippage).
    const meteora = fetchMeteoraPortfolio(process.env.WALLET_PUBKEY
      ?? process.env.PUBLIC_WALLET
      ?? "9DTThTbggnp2P2ZGLFRfN1A3j5JUsXez1dRJak3TixB2");

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
      balance,
      meteora,
      open,
      book: {
        all_time_live: allLive,
        since_fix: bookAgg(sinceFix),
        last_24h: bookAgg(last24),
      },
      kelly: kellyFrom(kellyRows),
      cluster,
      open_failed_since_fix: {
        n: openFailed.length,
        by_code: openFailCodes,
        recent: openFailed.slice(0, 5).map((r) => ({
          at: r.at, mint: r.mint, ...parseOpenFail(r.feat),
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
      recent_passes: recentPasses,
    };
  } finally {
    db.close();
  }
}
