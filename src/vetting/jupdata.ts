import { config } from "../config.js";

// Jupiter datapi enrichment client (datapi.jup.ag — the API behind jup.ag's
// own token UI; undocumented and unauthenticated, verified live 2026-08-07).
// SOFT-SIGNAL SOURCE ONLY: vet.ts may adjust softScore from these fields but
// must never hard-gate on them — an undocumented API can drift or vanish, so
// every failure path here degrades to null and the vet result must be
// identical to today's when that happens. Responses are schema-checked:
// missing/renamed fields read as "no data", never NaN.

export interface JupAssetSnapshot {
  organicScore: number | null;   // 0-100; null if Jupiter omitted it
  organicScoreLabel: string;     // "low" | "medium" | "high"
  holderCount: number | null;
  topHoldersPct: number | null;  // top holders' supply share (may include pool accounts)
  botHoldersPct: number | null;
  devMints: number | null;       // tokens this deployer has minted (serial-launcher signal)
  devMigrations: number | null;
  buyVol24h: number | null;
  sellVol24h: number | null;
  organicBuyVol24h: number | null;
  organicSellVol24h: number | null;
  /** Display fields from the same search payload (for dashboard icons). */
  symbol: string | null;
  name: string | null;
  icon: string | null;
}

const CACHE_MS = 55_000;       // one scan cycle — never re-hit a mint within a sweep
const CALL_GAP_MS = 600;       // pacing between requests
const COOLDOWN_MS = 120_000;   // park entirely after a 429 or repeated failures
const MAX_CONSECUTIVE_FAILURES = 3;

const cache = new Map<string, { at: number; snap: JupAssetSnapshot | null }>();
let nextCallAt = 0;
let coolingUntil = 0;
let consecutiveFailures = 0;

const num = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) ? x : null;

/** Paced, cached, 429-aware asset lookup. Null = unavailable (degrade, don't gate). */
export async function jupAsset(mint: string): Promise<JupAssetSnapshot | null> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.snap;
  const snap = await fetchAsset(mint);
  cache.set(mint, { at: Date.now(), snap });
  if (cache.size > 500) {
    for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_MS) cache.delete(k);
  }
  return snap;
}

async function fetchAsset(mint: string): Promise<JupAssetSnapshot | null> {
  if (Date.now() < coolingUntil) return null;
  const wait = Math.max(0, nextCallAt - Date.now());
  nextCallAt = Math.max(Date.now(), nextCallAt) + CALL_GAP_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  try {
    const res = await fetch(
      `${config().apis.jup_datapi}/v1/assets/search?query=${mint}`,
      { signal: AbortSignal.timeout(8_000) }
    );
    if (res.status === 429) {
      coolingUntil = Date.now() + COOLDOWN_MS;
      console.warn("[jupdata] 429 — cooling down");
      return null;
    }
    if (!res.ok) return bumpFailure();
    const body = (await res.json()) as unknown;
    consecutiveFailures = 0;
    if (!Array.isArray(body)) return null;
    const a = body.find(
      (x): x is Record<string, unknown> =>
        typeof x === "object" && x !== null && (x as Record<string, unknown>).id === mint
    );
    if (!a) return null; // token not indexed (yet) — normal for very fresh mints

    const organicScore = num(a.organicScore);
    const symbol = typeof a.symbol === "string" ? a.symbol : null;
    const name = typeof a.name === "string" ? a.name : null;
    const icon = typeof a.icon === "string" ? a.icon : null;
    // Display-only hit is still useful even when organicScore is missing.
    if (organicScore === null && !symbol && !name && !icon) return null;
    const audit = (typeof a.audit === "object" && a.audit !== null ? a.audit : {}) as Record<string, unknown>;
    const s24 = (typeof a.stats24h === "object" && a.stats24h !== null ? a.stats24h : {}) as Record<string, unknown>;

    return {
      organicScore,
      organicScoreLabel: typeof a.organicScoreLabel === "string" ? a.organicScoreLabel : "unknown",
      holderCount: num(a.holderCount),
      topHoldersPct: num(audit.topHoldersPercentage),
      botHoldersPct: num(audit.botHoldersPercentage),
      devMints: num(audit.devMints),
      devMigrations: num(audit.devMigrations),
      buyVol24h: num(s24.buyVolume),
      sellVol24h: num(s24.sellVolume),
      organicBuyVol24h: num(s24.buyOrganicVolume),
      organicSellVol24h: num(s24.sellOrganicVolume),
      symbol,
      name,
      icon,
    };
  } catch {
    return bumpFailure();
  }
}

function bumpFailure(): null {
  if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    coolingUntil = Date.now() + COOLDOWN_MS;
    consecutiveFailures = 0;
    console.warn("[jupdata] repeated failures — cooling down");
  }
  return null;
}
