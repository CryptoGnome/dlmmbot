import { config, env } from "../config.js";
import { gmgnCli } from "./gmgn.js";

// Smart-money / KOL flow collector (practitioner research adoption, phase 2).
// GMGN's track feeds are GLOBAL recent-trade streams (~100 trades / 2 min), so
// two calls per minute maintain a rolling window covering every token at once;
// scoring a candidate is a free in-memory lookup — no per-token API calls.

interface FlowTrade {
  hash: string;
  token: string;
  maker: string;
  side: "buy" | "sell";
  usd: number;
  ts: number;
  kol: string | null; // twitter handle when the trade came from the KOL feed
}

let trades: FlowTrade[] = [];
let seenTx = new Set<string>();
let timer: NodeJS.Timeout | null = null;
let lastPollOk = 0;

function parseList(raw: string): Array<Record<string, unknown>> {
  const j = JSON.parse(raw) as Record<string, unknown>;
  if (Array.isArray(j)) return j as Array<Record<string, unknown>>;
  const data = j.data as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  return (j.list ?? (Array.isArray(data) ? data : data?.list) ?? []) as Array<Record<string, unknown>>;
}

async function pollOnce(): Promise<void> {
  for (const feed of ["smartmoney", "kol"] as const) {
    try {
      const raw = await gmgnCli(["track", feed, "--chain", "sol", "--limit", "200", "--raw"]);
      for (const t of parseList(raw)) {
        const hash = String(t.transaction_hash ?? "");
        if (!hash || seenTx.has(hash)) continue;
        seenTx.add(hash);
        const info = (t.maker_info ?? {}) as Record<string, unknown>;
        trades.push({
          hash,
          token: String(t.base_address ?? ""),
          maker: String(t.maker ?? ""),
          side: t.side === "sell" ? "sell" : "buy",
          usd: Number(t.amount_usd ?? 0),
          ts: Number(t.timestamp ?? 0),
          kol: feed === "kol" ? String((info.twitter_username as string) || (info.name as string) || "kol") : null,
        });
      }
      lastPollOk = Date.now();
    } catch {
      /* rate-limited or API down — the window just gets sparser; scoring degrades to no bonus */
    }
  }
  const cutoff = Math.floor(Date.now() / 1000) - config().smartflow.window_min * 60;
  trades = trades.filter((t) => t.ts >= cutoff);
  seenTx = new Set(trades.map((t) => t.hash));
}

/** Start the background collector (no-op without an API key, or if running). */
export function startSmartFlow(): void {
  if (!env().gmgnApiKey || timer) return;
  void pollOnce();
  timer = setInterval(() => void pollOnce(), 60_000);
  console.log("[smartflow] smart-money/KOL collector started (2 calls/min, 30m window)");
}

export interface FlowSummary {
  smartWallets: number;  // distinct smart-money wallets buying in the window
  newJoiners: number;    // wallets whose FIRST buy is in the newest third of the window
  netUsd: number;        // buys - sells across both feeds
  kolNames: string[];    // distinct KOL identities buying
  stale: boolean;        // no successful poll in >3 min — treat as no-signal
}

/** Zero-API-cost lookup into the rolling window. null = collector not running. */
export function flowFor(mint: string): FlowSummary | null {
  if (!timer) return null;
  const stale = Date.now() - lastPollOk > 180_000;
  const nowS = Math.floor(Date.now() / 1000);
  const recentCutoff = nowS - Math.floor((config().smartflow.window_min * 60) / 3);
  const firstBuy = new Map<string, number>();
  const kols = new Set<string>();
  let netUsd = 0;
  for (const t of trades) {
    if (t.token !== mint) continue;
    if (t.side === "buy") {
      netUsd += t.usd;
      const prev = firstBuy.get(t.maker);
      if (prev === undefined || t.ts < prev) firstBuy.set(t.maker, t.ts);
      if (t.kol) kols.add(t.kol);
    } else {
      netUsd -= t.usd;
    }
  }
  const newJoiners = [...firstBuy.values()].filter((ts) => ts >= recentCutoff).length;
  return { smartWallets: firstBuy.size, newJoiners, netUsd, kolNames: [...kols], stale };
}
