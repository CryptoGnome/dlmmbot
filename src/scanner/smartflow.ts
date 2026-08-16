import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config, env } from "../config.js";
import { gmgnCli, gmgnIsBanned } from "./gmgn.js";

// Smart-money / KOL flow collector (practitioner research adoption, phase 2).
// GMGN's track feeds are GLOBAL recent-trade streams (~100 trades / 2 min).
// Alternate smartmoney/kol — one track call per poll keeps load low.
// Snapshot → data/smartflow.json for the ops dashboard Smart flow tab.

export interface FlowTrade {
  hash: string;
  token: string;
  maker: string;
  side: "buy" | "sell";
  usd: number;
  ts: number;
  kol: string | null;
  feed: "smartmoney" | "kol";
}

export interface FlowSummary {
  smartWallets: number;
  newJoiners: number;
  netUsd: number;
  kolNames: string[];
  stale: boolean;
}

export interface SmartflowTokenRow {
  mint: string;
  smart_wallets: number;
  new_joiners: number;
  net_usd: number;
  buy_usd: number;
  sell_usd: number;
  kol_names: string[];
  trade_count: number;
}

export interface SmartflowSnapshot {
  at: string;
  ts: number;
  last_poll_at: string | null;
  last_poll_ms: number;
  stale: boolean;
  running: boolean;
  enabled: boolean;
  window_min: number;
  next_feed: "smartmoney" | "kol";
  trade_count: number;
  tokens: SmartflowTokenRow[];
  recent: Array<{
    hash: string;
    mint: string;
    maker: string;
    side: "buy" | "sell";
    usd: number;
    ts: number;
    at: string;
    kol: string | null;
    feed: "smartmoney" | "kol";
  }>;
}

let trades: FlowTrade[] = [];
let seenTx = new Set<string>();
let timer: NodeJS.Timeout | null = null;
let lastPollOk = 0;
let feedTurn = 0;

function parseList(raw: string): Array<Record<string, unknown>> {
  const j = JSON.parse(raw) as Record<string, unknown>;
  if (Array.isArray(j)) return j as Array<Record<string, unknown>>;
  const data = j.data as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  return (j.list ?? (Array.isArray(data) ? data : data?.list) ?? []) as Array<Record<string, unknown>>;
}

function smartflowPath(): string {
  if (process.env.FARMER_DB_PATH) {
    return join(dirname(process.env.FARMER_DB_PATH), "smartflow.json");
  }
  return join(process.cwd(), "data", "smartflow.json");
}

/** Aggregate in-memory trades into a dashboard snapshot (pure — for tests). */
export function aggregateSmartflow(
  list: FlowTrade[],
  opts: {
    nowMs?: number;
    lastPollOk?: number;
    running?: boolean;
    enabled?: boolean;
    windowMin?: number;
    nextFeed?: "smartmoney" | "kol";
    tokenLimit?: number;
    recentLimit?: number;
  } = {},
): SmartflowSnapshot {
  const nowMs = opts.nowMs ?? Date.now();
  const nowS = Math.floor(nowMs / 1000);
  const windowMin = opts.windowMin ?? 30;
  const lastOk = opts.lastPollOk ?? 0;
  const recentCutoff = nowS - Math.floor((windowMin * 60) / 3);
  const byMint = new Map<string, {
    wallets: Map<string, number>;
    kols: Set<string>;
    buy: number;
    sell: number;
    n: number;
  }>();

  for (const t of list) {
    let row = byMint.get(t.token);
    if (!row) {
      row = { wallets: new Map(), kols: new Set(), buy: 0, sell: 0, n: 0 };
      byMint.set(t.token, row);
    }
    row.n += 1;
    if (t.side === "buy") {
      row.buy += t.usd;
      const prev = row.wallets.get(t.maker);
      if (prev === undefined || t.ts < prev) row.wallets.set(t.maker, t.ts);
      if (t.kol) row.kols.add(t.kol);
    } else {
      row.sell += t.usd;
    }
  }

  const tokens: SmartflowTokenRow[] = [...byMint.entries()]
    .map(([mint, r]) => {
      const joiners = [...r.wallets.values()].filter((ts) => ts >= recentCutoff).length;
      return {
        mint,
        smart_wallets: r.wallets.size,
        new_joiners: joiners,
        net_usd: r.buy - r.sell,
        buy_usd: r.buy,
        sell_usd: r.sell,
        kol_names: [...r.kols].slice(0, 12),
        trade_count: r.n,
      };
    })
    .sort((a, b) =>
      b.smart_wallets - a.smart_wallets
      || b.net_usd - a.net_usd
      || b.trade_count - a.trade_count)
    .slice(0, opts.tokenLimit ?? 40);

  const recentLimit = opts.recentLimit ?? 50;
  const recent = [...list]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, recentLimit)
    .map((t) => ({
      hash: t.hash,
      mint: t.token,
      maker: t.maker,
      side: t.side,
      usd: t.usd,
      ts: t.ts,
      at: new Date(t.ts * 1000).toISOString(),
      kol: t.kol,
      feed: t.feed,
    }));

  return {
    at: new Date(nowMs).toISOString(),
    ts: nowS,
    last_poll_at: lastOk ? new Date(lastOk).toISOString() : null,
    last_poll_ms: lastOk,
    stale: !lastOk || nowMs - lastOk > 180_000,
    running: !!opts.running,
    enabled: opts.enabled !== false,
    window_min: windowMin,
    next_feed: opts.nextFeed ?? "smartmoney",
    trade_count: list.length,
    tokens,
    recent,
  };
}

export function buildSmartflowSnapshot(): SmartflowSnapshot {
  const sf = config().smartflow;
  return aggregateSmartflow(trades, {
    lastPollOk,
    running: !!timer,
    enabled: !!env().gmgnApiKey,
    windowMin: sf.window_min,
    nextFeed: feedTurn % 2 === 0 ? "smartmoney" : "kol",
  });
}

export function writeSmartflowSnapshot(): void {
  const snap = buildSmartflowSnapshot();
  const path = smartflowPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snap));
  renameSync(tmp, path);
}

async function pollOnce(): Promise<void> {
  if (gmgnIsBanned()) {
    writeSmartflowSnapshot();
    return;
  }
  const feeds = ["smartmoney", "kol"] as const;
  const feed = feeds[feedTurn % feeds.length]!;
  feedTurn += 1;
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
        kol: feed === "kol"
          ? String((info.twitter_username as string) || (info.name as string) || "kol")
          : null,
        feed,
      });
    }
    lastPollOk = Date.now();
  } catch {
    /* rate-limited or API down — the window just gets sparser; scoring degrades to no bonus */
  }
  const cutoff = Math.floor(Date.now() / 1000) - config().smartflow.window_min * 60;
  trades = trades.filter((t) => t.ts >= cutoff);
  seenTx = new Set(trades.map((t) => t.hash));
  // The snapshot is a dashboard nicety. On a full disk (ENOSPC, 2026-08-16)
  // this write threw out of the timer as an unhandledRejection and took the
  // whole farmer down — with a live position open. Never let a cosmetic write
  // be fatal.
  try {
    writeSmartflowSnapshot();
  } catch (e) {
    console.error("[smartflow] snapshot write failed (non-fatal):", (e as Error).message);
  }
}

/** Start the background collector (no-op without an API key, or if running). */
export function startSmartFlow(): void {
  if (!env().gmgnApiKey || timer) return;
  void pollOnce();
  timer = setInterval(() => void pollOnce(), 120_000);
  writeSmartflowSnapshot();
  console.log("[smartflow] smart-money/KOL collector started (1 track call/120s, snapshot → data/smartflow.json)");
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

/** Test hook — reset in-memory collector state. */
export function _resetSmartflowForTests(): void {
  trades = [];
  seenTx = new Set();
  if (timer) clearInterval(timer);
  timer = null;
  lastPollOk = 0;
  feedTurn = 0;
}
