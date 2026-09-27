import { config } from "../config.js";
import { gmgnCli, gmgnIsBanned, gmgnTokenBudgetOk } from "../scanner/gmgn.js";
import { isNonWalletHolder } from "../manager/holderwatch.js";

// Entry-time tail-risk controls (2026-09-27, after REGULARS pos#605/606 lost
// 0.75 SOL in one poll). Two independent reads, both of which can only SHRINK
// an entry or skip it — never enlarge one:
//
//  - young token: the only entry feature that separated big losers in BOTH
//    halves of 551 live entries (median token age 134 min vs 1,360). Young
//    tokens are where the fee income is and where the -50..-78% losses are,
//    at the same size as everything else. Cut size, drop the tranche.
//  - whale overhang: wallets that bought recently and sit on large paper
//    gains, measured against the token's TOTAL liquidity (every pool, not just
//    the thin DLMM side pool we LP in). REGULARS: two such wallets sold 7% of
//    supply in 9 seconds and PumpSwap fell 67% inside one 15s poll; arbitrage
//    carried the move through our whole ladder. Not backtestable — GMGN only
//    serves current holders — so every read is recorded on the entry.

export const YOUNG_DEFAULTS = { maxAgeMin: 180, sizeMult: 0.5, maxPositionSol: 0.45 };
export const WHALE_DEFAULTS = {
  enabled: true,
  freshHoldMin: 180,
  freshMinSupplyPct: 2,
  freshMinProfitMult: 1.5,
  skipLiquidityFrac: 0.25,
  cutFreshOverhangFrac: 0.25,
};

export interface YoungRead {
  young: boolean;
  ageMin: number | null;
  source: "mint" | "pool" | "unknown";
}

/**
 * Mint age first (vet), pool age as fallback; unknown age is treated as young.
 * `tokenAgeSource` is vet's record of where the age came from: an age vet
 * itself took from the pool is labelled "pool", not "mint". Pool age is a
 * lower bound on mint age, so the fallback can only err toward young.
 */
export function classifyYoung(
  tokenAgeMin: number | null | undefined,
  poolCreatedAtMs: number | null | undefined,
  tokenAgeSource?: "rugcheck" | "jupiter" | "pool" | null,
  nowMs = Date.now(),
): YoungRead {
  const max = config().gates.young_max_age_min ?? YOUNG_DEFAULTS.maxAgeMin;
  if (tokenAgeMin != null && Number.isFinite(tokenAgeMin)) {
    return { young: tokenAgeMin < max, ageMin: tokenAgeMin, source: tokenAgeSource === "pool" ? "pool" : "mint" };
  }
  if (poolCreatedAtMs != null && Number.isFinite(poolCreatedAtMs)) {
    const ageMin = (nowMs - poolCreatedAtMs) / 60_000;
    return { young: ageMin < max, ageMin: Math.round(ageMin), source: "pool" };
  }
  return { young: true, ageMin: null, source: "unknown" };
}

/**
 * The risk cut shared by young tokens and whale overhang. When the micro
 * sleeve already halved this entry the multiplier is not applied twice —
 * only the SOL cap binds — so two cuts never compound to a quarter size.
 */
export function applyRiskCut(size: number, alreadyCut: boolean): number {
  const g = config().gates;
  const cap = g.young_max_position_sol ?? YOUNG_DEFAULTS.maxPositionSol;
  const mult = g.young_size_mult ?? YOUNG_DEFAULTS.sizeMult;
  return Math.min(alreadyCut ? size : size * mult, cap);
}

export interface HolderRow {
  address: string;
  addrType: number;
  exchange: string;
  supplyPct: number;         // 0-100
  usdValue: number;
  unrealizedProfit: number;  // USD
  unrealizedPnl: number | null; // profit / cost of current holdings
  startHoldingAt: number | null; // unix seconds
}

export interface FreshWhale {
  address: string;
  supplyPct: number;
  usdValue: number;
  profitMult: number;
  heldMin: number;
  liquidityFrac: number;
}

export type WhaleVerdict = "skip" | "cut" | "clear" | "unavailable";

export interface WhaleRead {
  verdict: WhaleVerdict;
  reason: string;
  liquidityUsd: number | null;
  liquiditySource: "token" | "pool" | null;
  walletsRead: number;
  overhangUsd: number | null;
  overhangFrac: number | null;
  freshWhales: FreshWhale[];
  maxFreshFrac: number | null;
}

const num = (x: unknown): number => {
  const n = typeof x === "string" ? Number(x) : (x as number);
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
};

/** GMGN `token holders --raw` payload → rows, pools/AMMs/burns removed. */
export function parseHolderRows(raw: string, poolAddress: string | null | undefined): HolderRow[] {
  const j = JSON.parse(raw) as Record<string, unknown>;
  const data = j.data as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  const list = (Array.isArray(j) ? j : (j.list ?? (Array.isArray(data) ? data : data?.list) ?? [])) as Array<Record<string, unknown>>;
  const rows: HolderRow[] = [];
  for (const h of list) {
    const address = String(h.address ?? "");
    if (!address) continue;
    const addrType = num(h.addr_type);
    const exchange = String(h.exchange ?? "");
    if (addrType === 2 || exchange) continue;
    if (isNonWalletHolder(address, poolAddress)) continue;
    const pnl = h.unrealized_pnl;
    rows.push({
      address, addrType, exchange,
      supplyPct: num(h.amount_percentage) * 100,
      usdValue: num(h.usd_value),
      unrealizedProfit: num(h.unrealized_profit),
      unrealizedPnl: pnl == null || !Number.isFinite(Number(pnl)) ? null : Number(pnl),
      startHoldingAt: h.start_holding_at == null ? null : num(h.start_holding_at) || null,
    });
  }
  return rows;
}

/**
 * Pure verdict over parsed holders. `liquiditySource: "pool"` means only our
 * own pool's TVL was known — a SKIP is then downgraded to a CUT, because a
 * side pool understates what a whale can sell into.
 */
export function assessWhales(
  rows: HolderRow[],
  liquidityUsd: number | null,
  liquiditySource: "token" | "pool" | null,
  nowS = Math.floor(Date.now() / 1000),
): WhaleRead {
  const g = config().gates;
  const holdMin = g.whale_fresh_hold_min ?? WHALE_DEFAULTS.freshHoldMin;
  const minPct = g.whale_fresh_min_supply_pct ?? WHALE_DEFAULTS.freshMinSupplyPct;
  const minMult = g.whale_fresh_min_profit_mult ?? WHALE_DEFAULTS.freshMinProfitMult;
  const skipFrac = g.whale_skip_liquidity_frac ?? WHALE_DEFAULTS.skipLiquidityFrac;
  const cutFrac = g.whale_cut_fresh_overhang_frac ?? WHALE_DEFAULTS.cutFreshOverhangFrac;
  const base = { liquidityUsd, liquiditySource, walletsRead: rows.length };
  if (!liquidityUsd || liquidityUsd <= 0) {
    return { ...base, verdict: "unavailable", reason: "no liquidity figure", overhangUsd: null, overhangFrac: null, freshWhales: [], maxFreshFrac: null };
  }
  if (!rows.length) {
    return { ...base, verdict: "unavailable", reason: "no wallet holders returned", overhangUsd: null, overhangFrac: null, freshWhales: [], maxFreshFrac: null };
  }

  // Overhang counts only FRESH wallets' paper profit. Measured 2026-09-27 on
  // 16 live tokens: all-holder unrealized profit was >= 30% of liquidity on 11
  // of them (long-term holders of established tokens always sit on gains), so
  // it flagged nearly everything; fresh-wallet profit was zero on 14 and
  // non-zero only where wallets had just bought in size (REGULARS ~0.29).
  const isFresh = (r: HolderRow) => {
    if (r.startHoldingAt == null) return false;
    const m = (nowS - r.startHoldingAt) / 60;
    return m >= 0 && m <= holdMin;
  };
  const overhangUsd = rows.filter(isFresh).reduce((a, r) => a + Math.max(0, r.unrealizedProfit), 0);
  const overhangFrac = overhangUsd / liquidityUsd;
  const freshWhales: FreshWhale[] = [];
  for (const r of rows) {
    if (r.supplyPct < minPct || !isFresh(r)) continue;
    const heldMin = (nowS - r.startHoldingAt!) / 60;
    // value / cost of what is still held. unrealized_pnl is profit/cost when
    // GMGN sends it; otherwise derive it from value and profit.
    const cost = r.usdValue - r.unrealizedProfit;
    const profitMult = r.unrealizedPnl != null ? 1 + r.unrealizedPnl : cost > 0 ? r.usdValue / cost : 0;
    if (profitMult < minMult) continue;
    freshWhales.push({
      address: r.address, supplyPct: r.supplyPct, usdValue: r.usdValue,
      profitMult, heldMin: Math.round(heldMin), liquidityFrac: r.usdValue / liquidityUsd,
    });
  }
  freshWhales.sort((a, b) => b.liquidityFrac - a.liquidityFrac);
  const maxFreshFrac = freshWhales[0]?.liquidityFrac ?? 0;
  const read = { ...base, overhangUsd, overhangFrac, freshWhales, maxFreshFrac };

  if (maxFreshFrac >= skipFrac) {
    const w = freshWhales[0]!;
    const why = `fresh whale ${w.address.slice(0, 6)}… holds ${w.supplyPct.toFixed(1)}% ` +
      `($${Math.round(w.usdValue)}, ${w.profitMult.toFixed(1)}x, ${w.heldMin}m) = ` +
      `${(w.liquidityFrac * 100).toFixed(0)}% of $${Math.round(liquidityUsd)} liquidity`;
    return liquiditySource === "token"
      ? { ...read, verdict: "skip", reason: why }
      : { ...read, verdict: "cut", reason: `${why} (pool TVL only — skip downgraded)` };
  }
  if (overhangFrac >= cutFrac) {
    return {
      ...read, verdict: "cut",
      reason: `fresh wallets' unrealized profit $${Math.round(overhangUsd)} = ` +
        `${(overhangFrac * 100).toFixed(0)}% of $${Math.round(liquidityUsd)} liquidity`,
    };
  }
  return { ...read, verdict: "clear", reason: "below thresholds" };
}

// One read per mint per window: an entry that passes this check and then
// fails a later gate (bin rent, stale quote, open failure) comes back next
// sweep, and must not spend another GMGN call each time.
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; rows: HolderRow[] | null }>();

/** Cached holder read (one GMGN call per mint per 10 min); null when unavailable. */
export async function holderRowsFor(mint: string, poolAddress: string): Promise<HolderRow[] | null> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  if (gmgnIsBanned() || !gmgnTokenBudgetOk(5)) return null; // not cached: retry when budget returns
  let rows: HolderRow[] | null = null;
  try {
    const raw = await gmgnCli(["token", "holders", "--chain", "sol", "--address", mint, "--limit", "20", "--raw"]);
    rows = parseHolderRows(raw, poolAddress);
  } catch {
    rows = null;
  }
  cache.set(mint, { at: Date.now(), rows });
  return rows;
}

/**
 * Entry-time whale read. Never throws; every failure is "unavailable", which
 * the caller treats as no signal (young-token sizing still applies).
 */
export async function whaleCheck(
  mint: string,
  poolAddress: string,
  tokenLiquidityUsd: number | null | undefined,
  poolTvlUsd: number,
  gmgnKeyPresent: boolean,
): Promise<WhaleRead> {
  const liquidityUsd = tokenLiquidityUsd && tokenLiquidityUsd > 0 ? tokenLiquidityUsd : poolTvlUsd > 0 ? poolTvlUsd : null;
  const liquiditySource = tokenLiquidityUsd && tokenLiquidityUsd > 0 ? "token" : liquidityUsd ? "pool" : null;
  const empty = (reason: string): WhaleRead => ({
    verdict: "unavailable", reason, liquidityUsd, liquiditySource, walletsRead: 0,
    overhangUsd: null, overhangFrac: null, freshWhales: [], maxFreshFrac: null,
  });
  if ((config().gates.whale_check_enabled ?? WHALE_DEFAULTS.enabled) === false) return empty("disabled");
  if (!gmgnKeyPresent) return empty("no GMGN key");
  const rows = await holderRowsFor(mint, poolAddress);
  if (!rows) return empty("GMGN holders unavailable");
  return assessWhales(rows, liquidityUsd, liquiditySource);
}

/** Test hook. */
export function _resetWhaleCacheForTests(): void {
  cache.clear();
}
