import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config, env } from "../config.js";

const execFileP = promisify(execFile);

// GMGN discovery client — wraps the official `gmgn-cli` (query tier: API key
// only; we deliberately do NOT configure the trading tier / private key).
// The CLI reads GMGN_API_KEY from ~/.config/gmgn/.env or the process env.
// Degrades gracefully: no key or CLI failure -> empty results, scanner
// continues on Meteora-only discovery.

export interface GmgnTrendingToken {
  address: string;
  symbol: string;
  priceChangePct1h: number;
  volumeUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  holderCount: number;
  top10HolderRate: number;   // 0-1
  renouncedMint: boolean;
  renouncedFreeze: boolean;
  launchpad: string;
  creator: string;
  openTimestamp: number;
}

export interface GmgnPresence {
  token: GmgnTrendingToken;
  intervals: Set<string>;   // which trending windows the mint appears in
}

let cache: { at: number; byMint: Map<string, GmgnPresence> } | null = null;
const CACHE_MS = 55_000; // one scan cycle

async function cli(args: string[]): Promise<string> {
  // npx resolves the cached gmgn-cli; shell needed for the .cmd shim on Windows.
  const { stdout } = await execFileP("npx", ["-y", "gmgn-cli", ...args], {
    shell: true,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env },
  });
  return stdout;
}

async function fetchInterval(interval: string, minLiquidity: number): Promise<GmgnTrendingToken[]> {
  const raw = await cli([
    "market", "trending",
    "--chain", "sol",
    "--interval", interval,
    "--limit", "100",
    "--order-by", "volume",
    "--direction", "desc",
    "--min-liquidity", String(minLiquidity),
    "--raw",
  ]);
  const parsed = JSON.parse(raw) as { code: number; data?: { rank?: Array<Record<string, unknown>> } };
  const out: GmgnTrendingToken[] = [];
  for (const r of parsed.data?.rank ?? []) {
    const t: GmgnTrendingToken = {
      address: String(r.address ?? ""),
      symbol: String(r.symbol ?? ""),
      priceChangePct1h: Number(r.price_change_percent1h ?? 0),
      volumeUsd: Number(r.volume ?? 0),
      liquidityUsd: Number(r.liquidity ?? 0),
      marketCapUsd: Number(r.market_cap ?? 0),
      holderCount: Number(r.holder_count ?? 0),
      top10HolderRate: Number(r.top_10_holder_rate ?? 0),
      renouncedMint: r.renounced_mint === 1,
      renouncedFreeze: r.renounced_freeze_account === 1,
      launchpad: String(r.launchpad_platform ?? r.launchpad ?? ""),
      creator: String(r.creator ?? ""),
      openTimestamp: Number(r.open_timestamp ?? 0),
    };
    if (t.address) out.push(t);
  }
  return out;
}

/**
 * Trending SOL tokens across all configured windows, keyed by mint, with the
 * set of windows each mint appears in. Cached per scan cycle. Windows are
 * fetched in parallel; a failed window degrades to absent rather than failing
 * the scan.
 */
export async function trendingByMint(): Promise<Map<string, GmgnPresence>> {
  const g = config().gmgn;
  if (!g.enabled || !env().gmgnApiKey) return new Map();
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.byMint;

  const results = await Promise.all(
    g.intervals.map(async (iv) => {
      try {
        return { iv, tokens: await fetchInterval(iv, g.min_liquidity_usd) };
      } catch (e) {
        console.error(`[gmgn] trending ${iv} fetch failed (continuing without):`, (e as Error).message);
        return { iv, tokens: [] as GmgnTrendingToken[] };
      }
    })
  );

  const byMint = new Map<string, GmgnPresence>();
  for (const { iv, tokens } of results) {
    for (const t of tokens) {
      const cur = byMint.get(t.address);
      if (cur) cur.intervals.add(iv);
      else byMint.set(t.address, { token: t, intervals: new Set([iv]) });
    }
  }
  cache = { at: Date.now(), byMint };
  return byMint;
}
