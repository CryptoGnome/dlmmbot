import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config, env } from "../config.js";

const execFileP = promisify(execFile);

// GMGN discovery client — wraps the official `gmgn-cli` (query tier: API key
// only; we deliberately do NOT configure the trading tier / private key).
// Degrades gracefully: no key or CLI failure -> empty results, scanner
// continues on Meteora-only discovery.
//
// Rate limits (gmgn-cli / GMGN leaky bucket, 2026): rate=10 capacity=10 with
// per-route weights; OpenAPI also documents ~1 req/s. Overlapping CLI
// processes were the main 429 source — all calls share one serial queue,
// honor weight + min gap after each finished call, and park on 429 until
// X-RateLimit-Reset / reset_at (never spam the cooldown — that extends bans).

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
const CACHE_MS = 120_000;

/** Documented bucket (gmgn-skills cli-usage). */
export const GMGN_BUCKET_RATE = 10;
export const GMGN_BUCKET_CAP = 10;
/** Floor gap after a finished call — OpenAPI default ~1 req/s. */
const MIN_GAP_MS = 1_100;
const DEFAULT_BAN_MS = 120_000;
const SHORT_BAN_WAIT_MS = 5_000;

type Job = {
  args: string[];
  resolve: (s: string) => void;
  reject: (e: unknown) => void;
};

let queue: Job[] = [];
let pumping = false;
let bannedUntil = 0;
let nextSlotAt = 0;
let tokens = GMGN_BUCKET_CAP;
let lastRefillAt = Date.now();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Route weight for the leaky bucket (gmgn-skills token/market docs). */
export function gmgnRouteWeight(args: string[]): number {
  const a = args[0] ?? "";
  const b = args[1] ?? "";
  if (a === "token" && (b === "holders" || b === "traders")) return 5;
  if (a === "market" && (b === "trenches" || b === "signal" || b === "hot-searches")) return 3;
  if (a === "market" && b === "kline") return 2;
  return 1;
}

/** Parse ban end from CLI stdout/stderr / JSON body. */
export function parseGmgnResetMs(text: string, now = Date.now()): number | null {
  const m =
    /(?:reset_at|X-RateLimit-Reset|RateLimit-Reset)["'\s:=]+(\d{10,13})/i.exec(text)
    ?? /reset(?:s)?\s+(?:at|in)\s+(\d{10,13})/i.exec(text);
  if (!m) return null;
  let n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1e12) n *= 1000; // seconds → ms
  if (n < now) return null;
  if (n > now + 30 * 60_000) return null; // ignore absurd far-future
  return n;
}

function isRateLimitText(text: string): boolean {
  return /RATE_LIMIT|HTTP\s*429|\b429\b/.test(text);
}

function refillTokens(now = Date.now()): void {
  const elapsed = Math.max(0, (now - lastRefillAt) / 1000);
  tokens = Math.min(GMGN_BUCKET_CAP, tokens + elapsed * GMGN_BUCKET_RATE);
  lastRefillAt = now;
}

async function waitForTokens(weight: number): Promise<void> {
  for (;;) {
    refillTokens();
    if (tokens >= weight) {
      tokens -= weight;
      return;
    }
    const need = weight - tokens;
    await sleep(Math.max(50, Math.ceil((need / GMGN_BUCKET_RATE) * 1000)));
  }
}

async function runOne(args: string[]): Promise<string> {
  const weight = gmgnRouteWeight(args);
  const now = Date.now();
  if (now < bannedUntil) {
    const rem = bannedUntil - now;
    if (rem <= SHORT_BAN_WAIT_MS) await sleep(rem + 50);
    else throw new Error("gmgn cooling down after 429");
  }

  const gap = Math.max(0, nextSlotAt - Date.now());
  if (gap > 0) await sleep(gap);
  await waitForTokens(weight);

  try {
    // Own the cooldown — CLI auto-retry during a ban extends RATE_LIMIT_BANNED.
    const { stdout, stderr } = await execFileP("npx", ["-y", "gmgn-cli", ...args], {
      shell: true,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS: "0",
      },
    });
    const combined = `${stdout}\n${stderr ?? ""}`;
    if (isRateLimitText(combined)) {
      bannedUntil = parseGmgnResetMs(combined) ?? Date.now() + DEFAULT_BAN_MS;
      throw new Error("gmgn 429");
    }
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const text = `${err.message ?? ""}\n${err.stdout ?? ""}\n${err.stderr ?? ""}${String(e)}`;
    if (isRateLimitText(text)) {
      bannedUntil = Math.max(
        bannedUntil,
        parseGmgnResetMs(text) ?? Date.now() + DEFAULT_BAN_MS,
      );
    }
    throw e;
  } finally {
    // Space *after* the process exits so calls never overlap on the wire.
    const weightGap = Math.ceil((weight / GMGN_BUCKET_RATE) * 1000);
    nextSlotAt = Date.now() + Math.max(MIN_GAP_MS, weightGap);
  }
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      try {
        job.resolve(await runOne(job.args));
      } catch (e) {
        job.reject(e);
      }
    }
  } finally {
    pumping = false;
    if (queue.length) void pump();
  }
}

/** Paced, 429-aware GMGN CLI call — the only path any module may use. */
export async function gmgnCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    queue.push({ args, resolve, reject });
    void pump();
  });
}

/** Test hook — clear queue / ban / bucket. */
export function _resetGmgnPaceForTests(): void {
  queue = [];
  pumping = false;
  bannedUntil = 0;
  nextSlotAt = 0;
  tokens = GMGN_BUCKET_CAP;
  lastRefillAt = Date.now();
  cache = null;
  secCache.clear();
  tagCache.clear();
}

async function cli(args: string[]): Promise<string> {
  return gmgnCli(args);
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
 * fetched through the serial CLI queue; a failed window degrades to absent.
 */
export async function trendingByMint(): Promise<Map<string, GmgnPresence>> {
  const g = config().gmgn;
  if (!g.enabled || !env().gmgnApiKey) return new Map();
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.byMint;

  const byMint = new Map<string, GmgnPresence>();
  // Sequential awaits — clearer + never stampede the queue with N parallel jobs
  // that then sit banned after the first 429.
  for (const iv of g.intervals) {
    try {
      const tokens = await fetchInterval(iv, g.min_liquidity_usd);
      for (const t of tokens) {
        const cur = byMint.get(t.address);
        if (cur) cur.intervals.add(iv);
        else byMint.set(t.address, { token: t, intervals: new Set([iv]) });
      }
    } catch (e) {
      console.error(`[gmgn] trending ${iv} fetch failed (continuing without):`, (e as Error).message);
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
const ENRICH_TTL_MS = 300_000;
const secCache = new Map<string, { at: number; v: GmgnSecurity | null }>();
const tagCache = new Map<string, { at: number; v: TraderTagStats | null }>();

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
  const hit = secCache.get(mint);
  if (hit && Date.now() - hit.at < ENRICH_TTL_MS) return hit.v;
  try {
    const raw = await cli(["token", "security", "--chain", "sol", "--address", mint, "--raw"]);
    const sec = parseTokenSecurity(raw);
    if (!sec) console.warn(`[gmgn] token security payload unrecognizable for ${mint} — honeypot gate skipped`);
    secCache.set(mint, { at: Date.now(), v: sec });
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
  const hit = tagCache.get(mint);
  if (hit && Date.now() - hit.at < ENRICH_TTL_MS) return hit.v;
  try {
    const raw = await cli(["token", "traders", "--chain", "sol", "--address", mint, "--limit", "20", "--raw"]);
    const j = JSON.parse(raw) as Record<string, unknown>;
    const list = (Array.isArray(j) ? j : (j.list ?? (j.data as Record<string, unknown> | undefined)?.list ?? [])) as Array<Record<string, unknown>>;
    if (!list.length) {
      tagCache.set(mint, { at: Date.now(), v: null });
      return null;
    }
    let risk = 0, smart = 0;
    for (const t of list) {
      const tags = [...(t.tags as string[] ?? []), ...(t.maker_token_tags as string[] ?? [])];
      if (tags.some((x) => RISK_TAGS.includes(x))) risk++;
      if (tags.includes("smart_degen")) smart++;
    }
    const v = { sampled: list.length, riskShare: risk / list.length, smartCount: smart };
    tagCache.set(mint, { at: Date.now(), v });
    return v;
  } catch {
    return null;
  }
}
