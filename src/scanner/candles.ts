import { config } from "../config.js";
import { fetchCandles as fetchDatapiCandles, type Candle } from "./meteora.js";

/**
 * Candle history for a pool, deep enough for the indicators that read it.
 *
 * The Meteora datapi caps `/ohlcv` at 10 bars on every timeframe — verified
 * 2026-08-15 across 5m/30m/1h/4h with every paging parameter it might accept.
 * That silently starved every consumer:
 *   - majors RSI(14): never computable → `rsi ?` on every log line, and the
 *     timing gate has been swing-only since it was written;
 *   - meme timingPart: "last hour" = slice(-12) got 10, its trailing-hour
 *     volume average got 9;
 *   - planner.swing(): "24h lookback of 5m candles" (288 bars) got 10, so
 *     "swing high/low" and the ATH-proximity check were the last 50 minutes.
 * None of it errored — each degrades gracefully — which is why it lasted.
 *
 * GeckoTerminal serves 100 bars per call, free and keyless, keyed by the same
 * pool address, and covers pools minutes old. Its public limit is 30 req/min,
 * so this module rate-limits and caches: three call sites (scan, meme entry,
 * majors entry) at up to a few pools each per 60s tick fit comfortably, and a
 * 60s cache means one fetch serves the whole tick. On any failure or when the
 * source is disabled, the datapi's 10 bars come back — never fewer than before.
 */

const GT_ACCEPT = "application/json;version=20230302";
const CACHE_TTL_MS = 60_000;
const DEFAULT_LIMIT = 100;
/** Public GeckoTerminal limit; stay under it with headroom for bursts. */
const DEFAULT_MAX_PER_MIN = 25;

const cache = new Map<string, { at: number; candles: Candle[] }>();
const recentCalls: number[] = [];

function underRateLimit(maxPerMin: number): boolean {
  const cutoff = Date.now() - 60_000;
  while (recentCalls.length && recentCalls[0]! < cutoff) recentCalls.shift();
  return recentCalls.length < maxPerMin;
}

/**
 * GeckoTerminal ohlcv_list rows are [ts, open, high, low, close, volume],
 * newest-first. Verified against live data (2026-08-15): column 2 is always
 * ≥ its neighbours and column 3 always ≤, i.e. standard OHLCV order — an
 * earlier draft assumed o,h,c,l and would have swapped low and close into
 * every indicator.
 */
export function parseGeckoTerminal(body: unknown): Candle[] {
  const list = (body as { data?: { attributes?: { ohlcv_list?: unknown[] } } })?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const out: Candle[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [ts, o, h, l, c, v] = row as number[];
    if (![ts, o, h, l, c, v].every((x) => typeof x === "number" && Number.isFinite(x))) continue;
    // Reject a malformed bar rather than feed an indicator an impossible one.
    if (h! < Math.max(o!, c!) || l! > Math.min(o!, c!)) continue;
    out.push({ timestamp: ts!, open: o!, high: h!, low: l!, close: c!, volume: v! });
  }
  // Consumers expect oldest → newest (slice(-N) = "most recent N").
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchGeckoTerminal(poolAddress: string, timeframe: "5m" | "1h", limit: number): Promise<Candle[]> {
  const base = config().apis.geckoterminal ?? "https://api.geckoterminal.com/api/v2";
  // `currency=token` — bars in the QUOTE token (SOL for every pool we trade),
  // not USD. Every consumer compares candle prices to `pool.price`, which is
  // SOL-denominated; the default USD bars would put swingPosition and the
  // meme freefall/ATH checks a factor of ~75 off. Verified against the datapi:
  // GeckoTerminal SOL close 0.003336 vs datapi 0.00335 for the same bar.
  const path = timeframe === "1h"
    ? `/networks/solana/pools/${poolAddress}/ohlcv/hour?aggregate=1&limit=${limit}&currency=token`
    : `/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=5&limit=${limit}&currency=token`;
  const res = await fetch(`${base}${path}`, {
    headers: { Accept: GT_ACCEPT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`geckoterminal ${res.status}`);
  return parseGeckoTerminal(await res.json());
}

/**
 * Deep candles for a pool: GeckoTerminal (100 bars) with the datapi (10 bars)
 * as fallback. Never throws for the deep source — a GeckoTerminal outage or a
 * pool it does not index falls back to exactly what the bot had before.
 */
export async function fetchCandlesDeep(
  poolAddress: string,
  timeframe: "5m" | "1h" = "5m",
): Promise<Candle[]> {
  const c = config().candles;
  const enabled = c?.deep_source_enabled ?? true;
  const key = `${poolAddress}:${timeframe}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.candles;

  if (enabled && underRateLimit(c?.max_per_min ?? DEFAULT_MAX_PER_MIN)) {
    recentCalls.push(Date.now());
    try {
      const deep = await fetchGeckoTerminal(poolAddress, timeframe, c?.limit ?? DEFAULT_LIMIT);
      // A pool GeckoTerminal has not indexed yet returns [] — the datapi may
      // still know it, so only cache and return the deep answer when it has
      // more to say than the fallback would.
      if (deep.length > 10) {
        cache.set(key, { at: Date.now(), candles: deep });
        return deep;
      }
    } catch { /* fall through to datapi */ }
  }
  const shallow = await fetchDatapiCandles(poolAddress, timeframe);
  cache.set(key, { at: Date.now(), candles: shallow });
  return shallow;
}

/** Test hook. */
export function _resetCandleCacheForTests(): void {
  cache.clear();
  recentCalls.length = 0;
}
