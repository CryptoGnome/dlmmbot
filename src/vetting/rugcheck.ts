import { config } from "../config.js";

// Free RugCheck API client (verified live 2026-08-07). Used as a VETO signal
// only, never as approval — free-tier reports are cached and can be stale for
// minutes-old tokens. Our own RPC checks (onchain.ts) are the fresh layer.

export interface RugcheckSummary {
  score: number;
  score_normalised: number;
  risks: Array<{ name: string; value: string; description: string; score: number; level: string }>;
  lpLockedPct?: number;
}

export interface RugcheckReport extends RugcheckSummary {
  creator: string | null;
  creatorTokens: Array<{ mint: string; createdAt?: string }> | null;
  rugged: boolean;
  graphInsidersDetected: number;
  insiderNetworks: Array<{ id: string; type: "transfer" | "trade"; size: number; tokenAmount: number }> | null;
  totalHolders: number;
  totalLPProviders: number;
  totalMarketLiquidity: number;
  launchpad: { name: string; platform: string } | null;
  topHolders: Array<{ address: string; owner: string; pct: number; insider: boolean }> | null;
  markets: Array<{ marketType: string; lp?: { lpLockedPct: number; lpLockedUSD: number } }> | null;
  detectedAt: string | null;
}

// Free tier rate-limits hard (~10 rapid calls → 429). Pace + cache + cooldown,
// mirroring jupdata.ts, so one scan sweep can't burn the whole budget and a 429
// storm doesn't blind the holder/insider gates for every candidate at once.
const CACHE_MS = 55_000;       // one scan cycle
const CALL_GAP_MS = 1_500;     // min interval between requests
const COOLDOWN_MS = 120_000;   // park entirely after a 429
const cache = new Map<string, { at: number; body: unknown | null }>();
let nextCallAt = 0;
let coolingUntil = 0;

/** Tests only — clear pacing/cache state between cases. */
export function _resetRugcheckStateForTests(): void {
  cache.clear();
  nextCallAt = 0;
  coolingUntil = 0;
}

async function get<T>(path: string): Promise<T | null> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.body as T | null;
  if (Date.now() < coolingUntil) return null; // don't cache: retry after cooldown

  const wait = Math.max(0, nextCallAt - Date.now());
  nextCallAt = Math.max(Date.now(), nextCallAt) + CALL_GAP_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  try {
    const res = await fetch(`${config().apis.rugcheck}${path}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) {
      coolingUntil = Date.now() + COOLDOWN_MS;
      console.warn("[rugcheck] 429 — cooling down");
      return null; // not cached — transient
    }
    if (!res.ok) return null; // unknown token etc. — degrade gracefully, don't cache
    const body = (await res.json()) as T;
    cache.set(path, { at: Date.now(), body });
    if (cache.size > 500) {
      for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_MS) cache.delete(k);
    }
    return body;
  } catch {
    return null;
  }
}

export function summaryUrl(mint: string): string {
  return `${config().apis.rugcheck}/v1/tokens/${mint}/report/summary`;
}

export async function fetchSummary(mint: string): Promise<RugcheckSummary | null> {
  return get<RugcheckSummary>(`/v1/tokens/${mint}/report/summary`);
}

export async function fetchReport(mint: string): Promise<RugcheckReport | null> {
  return get<RugcheckReport>(`/v1/tokens/${mint}/report`);
}

/** Count of creator's prior tokens marked rugged (best-effort from the report). */
export function creatorRugCount(report: RugcheckReport): number {
  // risks can be absent on partial 200s — treat as "none reported", don't throw.
  const risk = (report.risks ?? []).find((r) => r.name === "Creator history of rugged tokens");
  if (!risk) return 0;
  // Observed scores: 7200 / 19200 / 120000 — scales with rug count; treat any as >=1.
  return Math.max(1, Math.round(risk.score / 7200));
}

/**
 * Supply share held by detected insider networks, in percent.
 * null = unknowable (no network data, or supply unknown) — callers fall back to
 * the RPC funding-cluster scan. Returning 0 on unknown supply used to suppress
 * that fallback (audit #9).
 */
export function insiderNetworkPct(report: RugcheckReport, totalSupplyRaw: number | null): number | null {
  if (!report.insiderNetworks) return null;
  if (report.insiderNetworks.length === 0) return 0; // affirmatively reported: none
  if (!totalSupplyRaw) return null; // networks exist but supply unknown — can't compute a %
  const insiderRaw = report.insiderNetworks.reduce((s, n) => s + (n.tokenAmount ?? 0), 0);
  return (insiderRaw / totalSupplyRaw) * 100;
}
