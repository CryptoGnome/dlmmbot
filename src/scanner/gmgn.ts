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

// GMGN documents 1 request/second (docs.gmgn.ai), enforced by IP blocks that
// extend on repeated violations. All calls pace through a min-gap (1s + jitter
// margin), and any 429 parks GMGN entirely for a cooldown — every consumer
// already degrades gracefully to Meteora-only data.
const CALL_GAP_MS = 1_100;
const BAN_COOLDOWN_MS = 120_000;
let nextCallAt = 0;
let bannedUntil = 0;

/** Paced, 429-aware GMGN CLI call — the only path any module may use. */
export async function gmgnCli(args: string[]): Promise<string> {
  return cli(args);
}

async function cli(args: string[]): Promise<string> {
  if (Date.now() < bannedUntil) throw new Error("gmgn cooling down after 429");
  const wait = Math.max(0, nextCallAt - Date.now());
  nextCallAt = Math.max(Date.now(), nextCallAt) + CALL_GAP_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  try {
    // npx resolves the cached gmgn-cli; shell needed for the .cmd shim on Windows.
    const { stdout } = await execFileP("npx", ["-y", "gmgn-cli", ...args], {
      shell: true,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env },
    });
    if (stdout.includes("RATE_LIMIT") || stdout.includes("HTTP 429")) {
      bannedUntil = Date.now() + BAN_COOLDOWN_MS;
      throw new Error("gmgn 429");
    }
    return stdout;
  } catch (e) {
    if (String(e).includes("429") || String(e).includes("RATE_LIMIT")) bannedUntil = Date.now() + BAN_COOLDOWN_MS;
    throw e;
  }
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

// --- Vetting enrichment (phase 1 of GMGN adoption, 2026-08-07) ---

export interface GmgnSecurity {
  honeypot: boolean;
  sellTaxPct: number;
  buyTaxPct: number;
}

const SECURITY_FIELDS = ["honeypot", "is_honeypot", "can_not_sell", "sell_tax", "buy_tax"];

/** Exported for tests: parse a raw `token security` payload. null = unrecognizable. */
export function parseTokenSecurity(raw: string): GmgnSecurity | null {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  // Like every other endpoint, --raw wraps the payload in { code, data }.
  // Unwrap up to two levels (some endpoints nest data.security-style objects).
  let d = parsed;
  for (let i = 0; i < 2 && typeof d.data === "object" && d.data !== null; i++) {
    d = d.data as Record<string, unknown>;
  }
  // Fail closed on shape drift: no recognizable security field means we know
  // NOTHING — never synthesize honeypot=false from a payload we can't read.
  if (!SECURITY_FIELDS.some((k) => k in d)) return null;
  return {
    honeypot: Number(d.honeypot ?? d.is_honeypot ?? 0) === 1 || Number(d.can_not_sell ?? 0) === 1,
    sellTaxPct: Number(d.sell_tax ?? 0) * 100,
    buyTaxPct: Number(d.buy_tax ?? 0) * 100,
  };
}

/** Token security cross-check. null = unavailable (no key / API failure / unrecognizable payload) — vet.ts records the blind spot. */
export async function tokenSecurity(mint: string): Promise<GmgnSecurity | null> {
  if (!env().gmgnApiKey) return null;
  try {
    const raw = await cli(["token", "security", "--chain", "sol", "--address", mint, "--raw"]);
    const sec = parseTokenSecurity(raw);
    if (!sec) console.warn(`[gmgn] token security payload unrecognizable for ${mint} — honeypot gate skipped`);
    return sec;
  } catch {
    return null;
  }
}

const RISK_TAGS = ["bundler", "rat_trader", "sniper", "dev_team"];

export interface TraderTagStats {
  sampled: number;
  riskShare: number;   // 0-1: fraction of sampled top traders with any risk tag
  smartCount: number;  // smart_degen-tagged wallets in the sample
}

/** Behavioral tags on a token's top traders. null = unavailable — degrades silently. */
export async function tokenTraderTags(mint: string): Promise<TraderTagStats | null> {
  if (!env().gmgnApiKey) return null;
  try {
    const raw = await cli(["token", "traders", "--chain", "sol", "--address", mint, "--limit", "20", "--raw"]);
    const j = JSON.parse(raw) as Record<string, unknown>;
    const list = (Array.isArray(j) ? j : (j.list ?? (j.data as Record<string, unknown> | undefined)?.list ?? [])) as Array<Record<string, unknown>>;
    if (!list.length) return null;
    let risk = 0, smart = 0;
    for (const t of list) {
      const tags = [...(t.tags as string[] ?? []), ...(t.maker_token_tags as string[] ?? [])];
      if (tags.some((x) => RISK_TAGS.includes(x))) risk++;
      if (tags.includes("smart_degen")) smart++;
    }
    return { sampled: list.length, riskShare: risk / list.length, smartCount: smart };
  } catch {
    return null;
  }
}
