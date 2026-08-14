/**
 * Meteora DLMM lookup for Settings majors allowlist picker.
 * Mirrors bot discovery symbol extraction + gate hints (read-only).
 */
import { parseConfig } from "./config-edit.mjs";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const DAY_MS = 86_400_000;
const DATAPI = "https://dlmm.datapi.meteora.ag";
const CACHE_TTL_MS = 60_000;

/** @type {{ at: number; pools: Array<ReturnType<typeof normalizePool>>; pending: Promise<void> | null }} */
let sweepCache = { at: 0, pools: [], pending: null };

async function getJson(path) {
  const res = await fetch(`${DATAPI}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`meteora datapi HTTP ${res.status}`);
  return res.json();
}

function normalizePool(p) {
  const ageMs = p.created_at ? Date.now() - p.created_at : null;
  const feeTvl24h =
    ageMs !== null && ageMs < DAY_MS && ageMs > 0
      ? (p.fee_tvl_ratio?.["24h"] ?? 0) * (DAY_MS / ageMs)
      : (p.fee_tvl_ratio?.["24h"] ?? 0);
  return {
    address: p.address,
    name: p.name,
    symbol: (p.name.split("-")[0] ?? p.name).toUpperCase(),
    tokenSymbol: (p.token_x?.symbol ?? "").toUpperCase(),
    mintX: p.token_x?.address ?? "",
    mintY: p.token_y?.address ?? "",
    quote: p.token_y?.symbol ?? "?",
    tvlUsd: p.tvl ?? 0,
    marketCapUsd: p.token_x?.market_cap ?? 0,
    vol30mUsd: p.volume?.["30m"] ?? 0,
    feeTvl24hPct: feeTvl24h,
    feeTvl30mPct: p.fee_tvl_ratio?.["30m"] ?? 0,
    baseFeePct: p.pool_config?.base_fee_pct ?? 0,
    createdAt: p.created_at ?? null,
    ageDays: ageMs != null ? Math.floor(ageMs / DAY_MS) : null,
  };
}

async function sweepPools(root) {
  const mj = parseConfig(root).majors ?? {};
  const pages = Math.max(1, Math.min(20, Number(mj.discovery_pages) || 8));
  const tvlMin = Number(mj.tvl_min_usd) || 100_000;
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const filter = encodeURIComponent(`is_blacklisted=false&&tvl>${tvlMin}`);
    const body = await getJson(`/pools?page=${page}&page_size=100&sort_by=tvl:desc&filter_by=${filter}`);
    out.push(...(body.data ?? []).map(normalizePool));
    if (page >= (body.pages ?? page)) break;
  }
  return out;
}

async function cachedSweep(root) {
  const now = Date.now();
  if (sweepCache.pools.length && now - sweepCache.at < CACHE_TTL_MS) return sweepCache.pools;
  if (!sweepCache.pending) {
    sweepCache.pending = sweepPools(root).then((pools) => {
      sweepCache = { at: Date.now(), pools, pending: null };
    }).catch((e) => {
      sweepCache.pending = null;
      throw e;
    });
  }
  await sweepCache.pending;
  return sweepCache.pools;
}

function majorsSymbol(p) {
  return p.symbol;
}

function gateFails(p, mj, gates) {
  const fails = [];
  if (p.mintY !== SOL_MINT) fails.push("not SOL quote");
  if (p.tvlUsd < (mj.tvl_min_usd ?? 100_000)) fails.push("TVL low");
  if (p.tvlUsd > (mj.tvl_max_usd ?? 10_000_000)) fails.push("TVL high");
  const feeTvl30mDaily = p.feeTvl30mPct * 48;
  if (p.feeTvl24hPct < (mj.fee_tvl_24h_min_pct ?? 0.08)) fails.push("fee/TVL 24h low");
  if (feeTvl30mDaily < (mj.fee_tvl_30m_daily_min_pct ?? 0.05)) fails.push("fee/TVL 30m low");
  if (p.vol30mUsd < (mj.vol_30m_min_usd ?? 5000)) fails.push("30m volume low");
  if (p.baseFeePct > (gates?.base_fee_max_pct ?? 10)) fails.push("base fee high");
  return fails;
}

function poolReady(p, mj, fails) {
  if (fails.length) return { ready: false, tone: "warn", text: fails.slice(0, 2).join(" · ") };
  const minDays = mj.age_min_days ?? 7;
  if (minDays > 0 && (p.ageDays == null || p.ageDays < minDays)) {
    return { ready: false, tone: "dim", text: p.ageDays != null ? `Pool ${p.ageDays}d old (need ${minDays}d)` : "Pool age unknown" };
  }
  return { ready: true, tone: "ok", text: "SOL pool passes majors gates" };
}

function matchRank(p, q) {
  const sym = p.symbol;
  const tok = p.tokenSymbol;
  if (sym === q || tok === q) return 0;
  if (sym.startsWith(q) || tok.startsWith(q)) return 1;
  if (sym.includes(q) || tok.includes(q) || p.name.toUpperCase().includes(q)) return 2;
  return 9;
}

function matchesQuery(p, q) {
  return matchRank(p, q) < 9;
}

/**
 * @param {string} root repo root (for config thresholds)
 * @param {string} query user ticker search
 * @param {number} limit max symbol groups
 */
export async function searchMajorsSymbols(root, query, limit = 12) {
  const q = String(query ?? "").trim().toUpperCase();
  if (q.length < 1) return { query: q, hits: [], cachedAt: sweepCache.at || null };

  const cfg = parseConfig(root);
  const mj = cfg.majors ?? {};
  const gates = cfg.gates ?? {};
  const pools = await cachedSweep(root);

  const solPools = pools.filter((p) => p.mintY === SOL_MINT && p.mintX !== SOL_MINT);
  const matched = solPools.filter((p) => matchesQuery(p, q));

  /** @type {Map<string, typeof matched>} */
  const bySym = new Map();
  for (const p of matched) {
    const sym = majorsSymbol(p);
    const list = bySym.get(sym) ?? [];
    list.push(p);
    bySym.set(sym, list);
  }

  const hits = [...bySym.entries()]
    .map(([symbol, list]) => {
      const sorted = [...list].sort((a, b) => b.tvlUsd - a.tvlUsd);
      const best = sorted[0];
      const fails = gateFails(best, mj, gates);
      const status = poolReady(best, mj, fails);
      const onAllowlist = (mj.symbol_allowlist ?? []).map((s) => String(s).toUpperCase()).includes(symbol);
      const rank = Math.min(...sorted.map((p) => matchRank(p, q)));
      return {
        symbol,
        poolCount: sorted.length,
        onAllowlist,
        rank,
        best: {
          address: best.address,
          name: best.name,
          quote: best.quote,
          tvlUsd: Math.round(best.tvlUsd),
          feeTvl24hPct: Math.round(best.feeTvl24hPct * 1000) / 1000,
          vol30mUsd: Math.round(best.vol30mUsd),
          ageDays: best.ageDays,
          gateFails: fails,
          statusTone: status.tone,
          statusText: status.text,
          ready: status.ready,
        },
      };
    })
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.best.ready !== b.best.ready) return a.best.ready ? -1 : 1;
      return b.best.tvlUsd - a.best.tvlUsd;
    })
    .slice(0, limit)
    .map(({ rank: _rank, ...hit }) => hit);

  return { query: q, hits, cachedAt: sweepCache.at || Date.now() };
}
