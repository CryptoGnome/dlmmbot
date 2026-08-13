import { config } from "../config.js";
import type { PoolInfo } from "../types.js";

// Client for the Meteora DLMM data API (verified live 2026-08-07):
//   GET /pools?page=1&page_size=100&sort_by=fee_tvl_ratio_30m:desc&filter_by=tvl>5000
//   GET /pools/{address}/ohlcv?timeframe=5m
// Notes: pagination is 1-based; volume/fees/fee_tvl_ratio are objects keyed
// "30m"|"1h"|"2h"|"4h"|"12h"|"24h"; fee_tvl_ratio values are already percent.

interface RawPool {
  address: string;
  name: string;
  token_x: { address: string; symbol: string; decimals: number; holders: number; freeze_authority_disabled: boolean; price: number; market_cap: number };
  token_y: { address: string; symbol: string };
  created_at: number | null; // ms epoch
  pool_config: { bin_step: number; base_fee_pct: number; collect_fee_mode: number };
  dynamic_fee_pct: number;
  tvl: number;
  current_price: number;
  volume: Record<string, number>;
  fees: Record<string, number>;
  fee_tvl_ratio: Record<string, number>;
  is_blacklisted: boolean;
  launchpad: string;
}

export interface RawPoolExtras {
  holders: number;
  marketCapUsd: number;
  freezeAuthorityDisabled: boolean;
  launchpad: string;
  collectFeeMode: number;
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${config().apis.meteora_datapi}${path}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`datapi ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

function normalize(p: RawPool): PoolInfo & { extras: RawPoolExtras } {
  return {
    address: p.address,
    name: p.name,
    mintX: p.token_x.address,
    mintY: p.token_y.address,
    binStep: p.pool_config.bin_step,
    baseFeePct: p.pool_config.base_fee_pct,
    dynamicFeePct: p.dynamic_fee_pct ?? null,
    tvlUsd: p.tvl,
    price: p.current_price,
    decimalsX: p.token_x.decimals,
    marketCapUsd: p.token_x.market_cap ?? 0,
    vol30mUsd: p.volume?.["30m"] ?? 0,
    vol1hUsd: p.volume?.["1h"] ?? 0,
    vol24hUsd: p.volume?.["24h"] ?? 0,
    feeTvl30mPct: p.fee_tvl_ratio?.["30m"] ?? 0,
    feeTvl1hPct: p.fee_tvl_ratio?.["1h"] ?? 0,
    feeTvl4hPct: p.fee_tvl_ratio?.["4h"] ?? 0,
    feeTvl24hPct: p.fee_tvl_ratio?.["24h"] ?? 0,
    // collect_fee_mode: 0 = both tokens, 1 = quote only (verified on-chain 2026-08-07).
    feesBothTokens: p.pool_config.collect_fee_mode === 0,
    createdAt: p.created_at ? new Date(p.created_at).toISOString() : null,
    extras: {
      holders: p.token_x.holders,
      marketCapUsd: p.token_x.market_cap,
      freezeAuthorityDisabled: p.token_x.freeze_authority_disabled,
      launchpad: p.launchpad,
      collectFeeMode: p.pool_config.collect_fee_mode,
    },
  };
}

/** Sweep high-TVL pools for majors discovery (sorted by TVL, not meme fee/TVL). */
export async function sweepMajorsPools(): Promise<Array<PoolInfo & { extras: RawPoolExtras }>> {
  const mj = config().majors;
  const out: Array<PoolInfo & { extras: RawPoolExtras }> = [];
  for (let page = 1; page <= mj.discovery_pages; page++) {
    const filter = encodeURIComponent(`is_blacklisted=false&&tvl>${mj.tvl_min_usd}`);
    const body = await getJson<{ data: RawPool[]; pages: number }>(
      `/pools?page=${page}&page_size=100&sort_by=tvl:desc&filter_by=${filter}`
    );
    out.push(...body.data.map(normalize));
    if (page >= body.pages) break;
  }
  return out;
}

/** Sweep the top pools by 30m fee/TVL, pre-filtered by TVL floor server-side. */
export async function sweepPools(): Promise<Array<PoolInfo & { extras: RawPoolExtras }>> {
  const c = config();
  const out: Array<PoolInfo & { extras: RawPoolExtras }> = [];
  for (let page = 1; page <= c.scanner.pages; page++) {
    const filter = encodeURIComponent(`is_blacklisted=false&&tvl>${c.gates.tvl_min_usd}`);
    const body = await getJson<{ data: RawPool[]; pages: number }>(
      `/pools?page=${page}&page_size=100&sort_by=fee_tvl_ratio_30m:desc&filter_by=${filter}`
    );
    out.push(...body.data.map(normalize));
    if (page >= body.pages) break;
  }
  return out;
}

/** Direct single-pool fetch — used by position marking; never rank-dependent. */
export async function fetchPool(address: string): Promise<(PoolInfo & { extras: RawPoolExtras }) | null> {
  try {
    const raw = await getJson<RawPool>(`/pools/${address}`);
    return normalize(raw);
  } catch (e) {
    if ((e as Error).message.includes("HTTP 404")) return null; // pool truly gone
    throw e; // transient failure — caller must NOT treat as pool death
  }
}

export async function fetchCandles(
  poolAddress: string,
  timeframe: "1m" | "5m" | "15m" | "1h" = "5m"
): Promise<Candle[]> {
  const body = await getJson<{ data: Candle[] }>(
    `/pools/${poolAddress}/ohlcv?timeframe=${timeframe}`
  );
  return body.data ?? [];
}
