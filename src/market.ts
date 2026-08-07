// Market-context feeds shared by risk modules. Fail-open with logging: if the
// feed is down we return neutral values rather than blocking the pipeline.

let cached: { at: number; changePct: number | null } = { at: 0, changePct: null };

/** SOL/USD 24h change in percent (CoinGecko free API, cached 5 min). */
export async function sol24hChangePct(): Promise<number | null> {
  if (Date.now() - cached.at < 300_000) return cached.changePct;
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true",
      { signal: AbortSignal.timeout(8_000) }
    );
    const j = (await res.json()) as { solana?: { usd_24h_change?: number } };
    cached = { at: Date.now(), changePct: j.solana?.usd_24h_change ?? null };
  } catch {
    cached = { at: Date.now(), changePct: cached.changePct };
  }
  return cached.changePct;
}
