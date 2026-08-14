import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config, env } from "../config.js";
import { logError } from "../db/db.js";

const execFileP = promisify(execFile);

// GMGN discovery client — wraps the official `gmgn-cli` (query tier: API key
// only; we deliberately do NOT configure the trading tier / private key).
// Degrades gracefully: no key or CLI failure -> empty results, scanner
// continues on Meteora-only discovery.
//
// Rate limits (gmgn-skills / OpenAPI, 2026): leaky bucket rate=20 capacity=20
// **per module** (market, token, track) — not one global pool. Overlapping
// CLI processes or two bots on one API key still double load. All calls share
// one in-process serial queue; each module bucket is paced separately; park on
// 429 until reset_at (never spam — each retry can extend the ban).

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
const CACHE_MS = 600_000; // 10m — trending is enrichment, not tick-critical

/** Documented bucket (gmgn-skills, 2026): rate=20 capacity=20 per module. */
export const GMGN_BUCKET_RATE = 20;
export const GMGN_BUCKET_CAP = 20;
/** Floor gap after a finished call — RPS ≈ 20/W; stay well under on weight-1. */
const MIN_GAP_MS = 1_250;
/** Extra spacing after token holders/traders (weight 5) — burst cap floor(20/5). */
const TOKEN_HEAVY_GAP_MS = 2_000;
/** GMGN bans are typically 5m when reset_at is missing from the CLI payload. */
const DEFAULT_BAN_MS = 300_000;
/** Rolling cap — optional/heavy routes shed first (two bots on one key need headroom). */
const SPEND_WINDOW_MS = 60_000;
const SPEND_WINDOW_MAX = 36;
/** Start below full bucket so a cold boot cannot burst 20 weight-1 calls. */
const BUCKET_START_TOKENS = 8;

let banLoggedUntil = 0;
let spendWindowStart = 0;
let spendWindowWeight = 0;

type Job = {
  args: string[];
  resolve: (s: string) => void;
  reject: (e: unknown) => void;
};

let queue: Job[] = [];
let pumping = false;
let bannedUntil = 0;

export type GmgnBucketId = "market" | "token" | "track";

type BucketState = { tokens: number; lastRefillAt: number; nextSlotAt: number };

const buckets = new Map<GmgnBucketId, BucketState>();

/** GMGN limits market / token / track routes on separate leaky buckets. */
export function gmgnBucketId(args: string[]): GmgnBucketId {
  const a = args[0] ?? "";
  if (a === "market") return "market";
  if (a === "token") return "token";
  return "track";
}

function getBucket(id: GmgnBucketId): BucketState {
  let b = buckets.get(id);
  if (!b) {
    b = { tokens: BUCKET_START_TOKENS, lastRefillAt: Date.now(), nextSlotAt: 0 };
    buckets.set(id, b);
  }
  return b;
}

function resetSpendWindow(now = Date.now()): void {
  spendWindowStart = now;
  spendWindowWeight = 0;
}

function spendWindowOk(weight: number, now = Date.now()): boolean {
  if (now - spendWindowStart > SPEND_WINDOW_MS) resetSpendWindow(now);
  return spendWindowWeight + weight <= SPEND_WINDOW_MAX;
}

function recordSpend(weight: number, now = Date.now()): void {
  if (now - spendWindowStart > SPEND_WINDOW_MS) resetSpendWindow(now);
  spendWindowWeight += weight;
}

const BAN_ERR = "gmgn cooling down after 429";

function rejectQueued(reason = BAN_ERR): void {
  while (queue.length) queue.shift()!.reject(new Error(reason));
}

function enterBan(untilMs: number): void {
  bannedUntil = Math.max(bannedUntil, untilMs);
  rejectQueued();
  logBanOnce();
}

function refillBucket(id: GmgnBucketId, now = Date.now()): void {
  const b = getBucket(id);
  const elapsed = Math.max(0, (now - b.lastRefillAt) / 1000);
  b.tokens = Math.min(GMGN_BUCKET_CAP, b.tokens + elapsed * GMGN_BUCKET_RATE);
  b.lastRefillAt = now;
}

/** Shed load: skip optional weight-5 token calls when the token bucket is busy. */
export function gmgnTokenBudgetOk(minWeight = 5): boolean {
  return gmgnSpendOk(minWeight, "token", { optional: true });
}

/** Pre-flight for optional routes — skip before enqueue when tight. */
export function gmgnSpendOk(
  weight: number,
  bucketId: GmgnBucketId,
  opts: { optional?: boolean } = {},
): boolean {
  if (gmgnIsBanned()) return false;
  if (!spendWindowOk(weight)) return !opts.optional;
  refillBucket(bucketId);
  const pending = queue.filter((j) => gmgnBucketId(j.args) === bucketId);
  const pendingWeight = pending.reduce((n, j) => n + gmgnRouteWeight(j.args), 0);
  if (opts.optional) {
    if (pending.length >= 1 || pendingWeight + weight > GMGN_BUCKET_CAP) return false;
    if (bucketId === "token" && pending.length >= 2) return false;
  }
  return getBucket(bucketId).tokens >= weight;
}

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
  try {
    const j = JSON.parse(text) as { reset_at?: number | string };
    if (j.reset_at != null) {
      const parsed = parseResetEpoch(j.reset_at, now);
      if (parsed) return parsed;
    }
  } catch { /* not JSON — fall through to regex */ }
  const m =
    /(?:reset_at|X-RateLimit-Reset|RateLimit-Reset)["'\s:=]+(\d{10,13})/i.exec(text)
    ?? /reset(?:s)?\s+(?:at|in)\s+(\d{10,13})/i.exec(text);
  if (!m?.[1]) return null;
  return parseResetEpoch(m[1], now);
}

function parseResetEpoch(raw: number | string, now: number): number | null {
  let n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1e12) n *= 1000;
  if (n < now) return null;
  if (n > now + 30 * 60_000) return null;
  return n;
}

function logBanOnce(): void {
  if (bannedUntil <= banLoggedUntil) return;
  banLoggedUntil = bannedUntil;
  const sec = Math.ceil((bannedUntil - Date.now()) / 1000);
  const msg = "GMGN rate limited — trending/vetting paused until reset";
  logError({
    source: "gmgn",
    code: "rate_limit",
    level: "warn",
    message: msg,
    dedupeSec: Math.min(Math.max(sec, 60), 600),
    detail: { pause_sec: sec },
  });
}

export function gmgnIsBanned(): boolean {
  return Date.now() < bannedUntil;
}

function isRateLimitText(text: string): boolean {
  return /RATE_LIMIT|HTTP\s*429|\b429\b/.test(text);
}

async function waitForBucketTokens(id: GmgnBucketId, weight: number): Promise<void> {
  for (;;) {
    refillBucket(id);
    const b = getBucket(id);
    if (b.tokens >= weight) {
      b.tokens -= weight;
      return;
    }
    const need = weight - b.tokens;
    await sleep(Math.max(50, Math.ceil((need / GMGN_BUCKET_RATE) * 1000)));
  }
}

async function runOne(args: string[]): Promise<string> {
  const bucketId = gmgnBucketId(args);
  const weight = gmgnRouteWeight(args);
  if (gmgnIsBanned()) throw new Error(BAN_ERR);

  while (!spendWindowOk(weight)) {
    const wait = spendWindowStart + SPEND_WINDOW_MS - Date.now() + 50;
    if (wait > 8_000) throw new Error("gmgn budget exhausted");
    await sleep(Math.max(50, wait));
  }

  const b = getBucket(bucketId);
  const gap = Math.max(0, b.nextSlotAt - Date.now());
  if (gap > 0) await sleep(gap);
  await waitForBucketTokens(bucketId, weight);

  try {
    // Own the cooldown — any CLI call during a ban extends RATE_LIMIT_BANNED (+5s each).
    const { stdout, stderr } = await execFileP("npx", ["-y", "gmgn-cli", ...args], {
      shell: true,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        GMGN_API_KEY: env().gmgnApiKey ?? process.env.GMGN_API_KEY,
        GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS: "0",
        GMGN_RATE_LIMIT_AUTO_RETRY: "0",
      },
    });
    const combined = `${stdout}\n${stderr ?? ""}`;
    if (isRateLimitText(combined)) {
      enterBan(parseGmgnResetMs(combined) ?? Date.now() + DEFAULT_BAN_MS);
      throw new Error("gmgn 429");
    }
    recordSpend(weight);
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const text = `${err.message ?? ""}\n${err.stdout ?? ""}\n${err.stderr ?? ""}${String(e)}`;
    if (isRateLimitText(text)) {
      enterBan(parseGmgnResetMs(text) ?? Date.now() + DEFAULT_BAN_MS);
      throw new Error(BAN_ERR);
    }
    throw e;
  } finally {
    const weightGap = Math.ceil((weight / GMGN_BUCKET_RATE) * 1000);
    const minGap = weight >= 5 && bucketId === "token"
      ? Math.max(TOKEN_HEAVY_GAP_MS, weightGap)
      : Math.max(MIN_GAP_MS, weightGap);
    b.nextSlotAt = Date.now() + minGap;
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
  if (gmgnIsBanned()) return Promise.reject(new Error(BAN_ERR));
  return new Promise((resolve, reject) => {
    queue.push({ args, resolve, reject });
    void pump();
  });
}

/** Test hook — set module bucket tokens without waiting. */
export function _setGmgnBucketForTests(id: GmgnBucketId, tokens: number): void {
  const b = getBucket(id);
  b.tokens = tokens;
  b.lastRefillAt = Date.now();
}

/** Test hook — clear queue / ban / buckets. */
export function _resetGmgnPaceForTests(): void {
  queue = [];
  pumping = false;
  bannedUntil = 0;
  banLoggedUntil = 0;
  spendWindowStart = 0;
  spendWindowWeight = 0;
  buckets.clear();
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
  if (gmgnIsBanned()) return cache?.byMint ?? new Map();

  const byMint = new Map<string, GmgnPresence>();
  // Sequential — never stampede; stop all windows on first 429/cooldown.
  for (const iv of g.intervals) {
    try {
      const tokens = await fetchInterval(iv, g.min_liquidity_usd);
      for (const t of tokens) {
        const cur = byMint.get(t.address);
        if (cur) cur.intervals.add(iv);
        else byMint.set(t.address, { token: t, intervals: new Set([iv]) });
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (!/429|cooling down|RATE_LIMIT/i.test(msg)) {
        logError({
          source: "gmgn",
          code: "trending_fetch",
          level: "warn",
          message: `trending ${iv}: ${msg}`.slice(0, 800),
          dedupeSec: 300,
          detail: { interval: iv },
        });
      }
      if (/429|cooling down|RATE_LIMIT/i.test(msg)) break;
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
  if (!env().gmgnApiKey || !gmgnSpendOk(1, "token")) return null;
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
  if (!env().gmgnApiKey || gmgnIsBanned() || !gmgnTokenBudgetOk(5)) return null;
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
