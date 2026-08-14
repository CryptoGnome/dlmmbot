import { config, SOL_MINT } from "../config.js";
import type { GateFailure } from "../types.js";

// STRATEGY.md §2.1 — pool price vs Jupiter quote divergence gate (the video's
// oracle-glitch / empty-pool trap): a near-empty or desynced DLMM pool can show
// a hot fee ratio from arb flow while its internal price is far off market.
// FAIL CLOSED: no usable Jupiter quote -> distinct gate failure, never a pass.
//
// Uses the documented Jupiter Price API (apis.jupiter_price, lite-api /price/v3)
// with jupdata.ts-style pacing/caching/429-cooldown. Only runs for pool-gate
// passers, so it's a handful of calls per sweep.

const CACHE_MS = 55_000;       // one scan cycle
const CALL_GAP_MS = 600;       // pacing between requests
const COOLDOWN_MS = 120_000;   // park entirely after a 429 or repeated failures
const MAX_CONSECUTIVE_FAILURES = 3;

const cache = new Map<string, { at: number; priceInSol: number | null }>();
let nextCallAt = 0;
let coolingUntil = 0;
let consecutiveFailures = 0;

/** Tests only — clear pacing/cache state between cases. */
export function _resetPriceGateForTests(): void {
  cache.clear();
  nextCallAt = 0;
  coolingUntil = 0;
  consecutiveFailures = 0;
}

/** |pool - jup| relative to the Jupiter quote, in percent. */
export function divergencePct(poolPrice: number, jupPriceInSol: number): number {
  return (Math.abs(poolPrice - jupPriceInSol) / jupPriceInSol) * 100;
}

/** Paced, cached, 429-aware token price in SOL from Jupiter. null = unavailable. */
export async function jupPriceInSol(mint: string): Promise<number | null> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.priceInSol;
  const price = await fetchPriceInSol(mint);
  if (price !== null) cache.set(mint, { at: Date.now(), priceInSol: price });
  if (cache.size > 500) {
    for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_MS) cache.delete(k);
  }
  return price;
}

async function fetchPriceInSol(mint: string): Promise<number | null> {
  if (Date.now() < coolingUntil) return null;
  const wait = Math.max(0, nextCallAt - Date.now());
  nextCallAt = Math.max(Date.now(), nextCallAt) + CALL_GAP_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  try {
    const res = await fetch(
      `${config().apis.jupiter_price}?ids=${mint},${SOL_MINT}`,
      { signal: AbortSignal.timeout(8_000) }
    );
    if (res.status === 429) {
      coolingUntil = Date.now() + COOLDOWN_MS;
      console.warn("[priceGate] 429 — cooling down");
      return null;
    }
    if (!res.ok) return bumpFailure();
    const j = (await res.json()) as Record<string, { usdPrice?: number; price?: number }>;
    consecutiveFailures = 0;
    const tokenUsd = j[mint]?.usdPrice ?? j[mint]?.price;
    const solUsd = j[SOL_MINT]?.usdPrice ?? j[SOL_MINT]?.price;
    if (typeof tokenUsd !== "number" || typeof solUsd !== "number") return null;
    if (!Number.isFinite(tokenUsd) || !Number.isFinite(solUsd) || tokenUsd <= 0 || solUsd <= 0) return null;
    return tokenUsd / solUsd;
  } catch {
    return bumpFailure();
  }
}

function bumpFailure(): null {
  if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    coolingUntil = Date.now() + COOLDOWN_MS;
    consecutiveFailures = 0;
    console.warn("[priceGate] repeated failures — cooling down");
  }
  return null;
}

/**
 * Hard gate: pool datapi price vs Jupiter quote (both in SOL per token).
 * Returns null when the pool passes; a GateFailure otherwise. Two distinct
 * gate names so operators can tell "diverged" from "quote unavailable".
 */
export async function priceDivergenceGate(
  mint: string,
  poolPriceInSol: number,
): Promise<GateFailure | null> {
  const maxPct = config().gates.price_divergence_max_pct;
  const jup = await jupPriceInSol(mint);
  if (jup === null) {
    return {
      gate: "price_divergence_unavailable",
      value: "no Jupiter quote",
      limit: `divergence <= ${maxPct}% (fail closed)`,
    };
  }
  const div = divergencePct(poolPriceInSol, jup);
  return div > maxPct
    ? { gate: "price_divergence", value: `${div.toFixed(2)}%`, limit: `${maxPct}%` }
    : null;
}
