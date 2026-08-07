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

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${config().apis.rugcheck}${path}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null; // rate-limited or unknown token — degrade gracefully
    return (await res.json()) as T;
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
  const risk = report.risks.find((r) => r.name === "Creator history of rugged tokens");
  if (!risk) return 0;
  // Observed scores: 7200 / 19200 / 120000 — scales with rug count; treat any as >=1.
  return Math.max(1, Math.round(risk.score / 7200));
}

/** Supply share held by detected insider networks, in percent. */
export function insiderNetworkPct(report: RugcheckReport, totalSupplyRaw: number | null): number | null {
  if (!report.insiderNetworks?.length || !totalSupplyRaw) return report.insiderNetworks ? 0 : null;
  const insiderRaw = report.insiderNetworks.reduce((s, n) => s + (n.tokenAmount ?? 0), 0);
  return (insiderRaw / totalSupplyRaw) * 100;
}
