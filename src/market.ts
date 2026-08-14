// Market-context feeds shared by risk modules. Fail-open with logging: if the
// feed is down we return neutral values rather than blocking the pipeline.

let cached: { at: number; changePct: number | null; usd: number | null } = { at: 0, changePct: null, usd: null };
let lastAttempt = 0;

// Stale-vs-null policy: a last-known-good price beats a wiped cache — the
// pool-share caps and regime filter fail open on null, and CoinGecko free-tier
// 429s cluster in exactly the high-activity windows where those caps matter.
// But a price that survived hours of feed death is a lie too, so values harder
// than STALE_MAX_MS report as down.
const FRESH_MS = 300_000;      // normal cache TTL
const RETRY_BACKOFF_MS = 60_000; // don't hammer the API while it's failing
const STALE_MAX_MS = 3_600_000;  // beyond this, stale = down

async function refresh(): Promise<void> {
  if (Date.now() - cached.at < FRESH_MS) return;
  if (Date.now() - lastAttempt < RETRY_BACKOFF_MS) return;
  lastAttempt = Date.now();
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true",
      { signal: AbortSignal.timeout(8_000) }
    );
    // A 429/5xx body parses as JSON without `solana` — without these guards it
    // overwrote the cache with nulls and a fresh timestamp, wiping
    // last-known-good for the full TTL.
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { solana?: { usd?: number; usd_24h_change?: number } };
    if (typeof j.solana?.usd !== "number") throw new Error("malformed body");
    cached = { at: Date.now(), changePct: j.solana.usd_24h_change ?? null, usd: j.solana.usd };
  } catch {
    // keep last-known-good; `at` untouched so recovery refreshes immediately
  }
}

function value<K extends "changePct" | "usd">(key: K): (typeof cached)[K] {
  if (Date.now() - cached.at > STALE_MAX_MS) return null;
  return cached[key];
}

/** SOL/USD 24h change in percent (CoinGecko free API, cached 5 min). */
export async function sol24hChangePct(): Promise<number | null> {
  await refresh();
  return value("changePct");
}

/** SOL/USD spot price (same feed/cache). null = feed down — callers fail open. */
export async function solUsdPrice(): Promise<number | null> {
  await refresh();
  return value("usd");
}
