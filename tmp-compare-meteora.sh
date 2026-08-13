#!/bin/bash
cd /home/gizmo/meteora-farmer
node <<'NODE'
const { createRequire } = require("module");
const { resolve } = require("path");
const req = createRequire(resolve("package.json"));
const Database = req("better-sqlite3");
const db = new Database("data/farmer.db", { readonly: true });
const WALLET = "9DTThTbggnp2P2ZGLFRfN1A3j5JUsXez1dRJak3TixB2";
const BASE = "https://dlmm.datapi.meteora.ag";

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

(async () => {
  const total = await getJson(`${BASE}/portfolio/total?user=${WALLET}`);
  const open = await getJson(`${BASE}/portfolio/open?user=${WALLET}&page_size=50`);
  const pools = [];
  for (let page = 1; page <= 5; page++) {
    const j = await getJson(`${BASE}/portfolio?user=${WALLET}&page=${page}&page_size=50&days_back=365`);
    pools.push(...(j.pools || []));
    if (!j.hasNext) break;
  }

  const REALIZED = `CASE WHEN open_cost_sol IS NOT NULL AND close_return_sol IS NOT NULL
    THEN close_return_sol+fees_measured_sol+recovered_sol-open_cost_sol
    WHEN entry_sol>0 THEN exit_sol-entry_sol+fees_claimed_sol ELSE 0 END`;

  const oursByPool = db.prepare(`
    SELECT pool,
      COUNT(*) n,
      ROUND(SUM(entry_sol),6) entry,
      ROUND(SUM(open_cost_sol),6) oc,
      ROUND(SUM(close_return_sol),6) cr,
      ROUND(SUM(fees_measured_sol),6) fm,
      ROUND(SUM(recovered_sol),6) rec,
      ROUND(SUM(${REALIZED}),6) pnl,
      GROUP_CONCAT(symbol || '#' || id, ',') ids
    FROM positions
    WHERE mode='live' AND exit_ts IS NOT NULL
    GROUP BY pool
  `).all();
  const byPool = Object.fromEntries(oursByPool.map(r => [r.pool, r]));

  const rows = [];
  let metSum = 0, ourSum = 0, metDep = 0, ourOc = 0;
  for (const p of pools) {
    const o = byPool[p.poolAddress];
    const mPnl = Number(p.pnlSol);
    const oPnl = o?.pnl ?? null;
    metSum += mPnl;
    metDep += Number(p.totalDepositSol);
    if (oPnl != null) ourSum += oPnl;
    if (o?.oc != null) ourOc += o.oc;
    rows.push({
      symbol: p.tokenX,
      pool: p.poolAddress.slice(0, 8),
      met_n: null,
      met_dep: +Number(p.totalDepositSol).toFixed(4),
      met_wd: +Number(p.totalWithdrawalSol).toFixed(4),
      met_fee: +Number(p.totalFeeSol).toFixed(4),
      met_pnl: +mPnl.toFixed(4),
      our_n: o?.n ?? 0,
      our_oc: o?.oc ?? null,
      our_out: o ? +(o.cr + o.fm + o.rec).toFixed(4) : null,
      our_pnl: oPnl != null ? +oPnl.toFixed(4) : null,
      gap: oPnl != null ? +(oPnl - mPnl).toFixed(4) : null,
      ids: o?.ids ?? "",
    });
  }

  // Ours with no meteora pool match
  const metPools = new Set(pools.map(p => p.poolAddress));
  const orphans = oursByPool.filter(o => !metPools.has(o.pool));

  console.log(JSON.stringify({
    meteora_total: { pnlSol: Number(total.totalPnlSol), n: total.totalClosedPositions, pct: Number(total.totalPnlSolPctChange) },
    open: {
      met_bal: Number(open.total?.balancesSol),
      met_pnl: Number(open.total?.pnlSol),
      met_positions: open.totalPositions,
    },
    our_book: db.prepare(`SELECT COUNT(*) n, ROUND(SUM(${REALIZED}),6) pnl FROM positions WHERE mode='live' AND exit_ts IS NOT NULL`).get(),
    sum_closed_pools_met: +metSum.toFixed(6),
    sum_closed_pools_our_matched: +ourSum.toFixed(6),
    gap_our_minus_met: +(ourSum - metSum).toFixed(6),
    rows: rows.sort((a,b) => Math.abs(b.gap||0) - Math.abs(a.gap||0)),
    orphans,
  }, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
NODE
