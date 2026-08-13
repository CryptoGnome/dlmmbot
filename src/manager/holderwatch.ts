import { config, env } from "../config.js";
import { gmgnCli } from "../scanner/gmgn.js";

// P0 wallet-dump / new-whale triggers (STRATEGY.md §4) via GMGN holder polling.
// Top holders snapshotted every holder_poll_s; confirm-then-fire against the
// SAME baseline before P0 (TVL-glitch lesson: one bad read must never exit).

export interface HolderTrigger {
  kind: "wallet_dump" | "new_whale";
  detail: string;
}

interface Snapshot {
  at: number;
  pct: Map<string, number>; // holder address -> % of supply (pools/AMMs excluded)
}

const snapshots = new Map<number, Snapshot>();
/** Wall-clock cap so slow GMGN cannot stretch the manage tick decision pass. */
export const HOLDER_CHECK_BUDGET_MS = 5_000;

export function clearHolderWatch(posId: number): void {
  snapshots.delete(posId);
}

async function fetchHolderPct(mint: string): Promise<Map<string, number> | null> {
  try {
    const raw = await gmgnCli(["token", "holders", "--chain", "sol", "--address", mint, "--limit", "20", "--raw"]);
    const j = JSON.parse(raw) as Record<string, unknown>;
    const data = j.data as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
    const list = (Array.isArray(j) ? j : (j.list ?? (Array.isArray(data) ? data : data?.list) ?? [])) as Array<Record<string, unknown>>;
    if (!list.length) return null;
    const pct = new Map<string, number>();
    for (const h of list) {
      if (Number(h.addr_type ?? 0) === 2 || String(h.exchange ?? "")) continue;
      pct.set(String(h.address), Number(h.amount_percentage ?? 0) * 100);
    }
    return pct;
  } catch {
    return null;
  }
}

export function findTrigger(
  baseline: Map<string, number>,
  cur: Map<string, number>,
  dumpPct: number,
  whalePct: number,
): HolderTrigger | null {
  for (const [addr, prev] of baseline) {
    const now = cur.get(addr) ?? 0;
    if (prev - now >= dumpPct) {
      return { kind: "wallet_dump", detail: `${addr.slice(0, 6)}… ${prev.toFixed(1)}%→${now.toFixed(1)}% of supply` };
    }
  }
  for (const [addr, now] of cur) {
    if (!baseline.has(addr) && now >= whalePct) {
      return { kind: "new_whale", detail: `${addr.slice(0, 6)}… entered with ${now.toFixed(1)}% of supply` };
    }
  }
  return null;
}

/** Confirm candidate trigger against a fresh read vs the same baseline. */
export function confirmHolderTrigger(
  baseline: Map<string, number>,
  cur: Map<string, number>,
  confirm: Map<string, number>,
  dumpPct: number,
  whalePct: number,
): HolderTrigger | null {
  const cand = findTrigger(baseline, cur, dumpPct, whalePct);
  if (!cand) return null;
  const confirmed = findTrigger(baseline, confirm, dumpPct, whalePct);
  return confirmed && confirmed.kind === cand.kind ? confirmed : null;
}

function raceBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

async function holderCheckInner(posId: number, mint: string): Promise<HolderTrigger | null> {
  if (!env().gmgnApiKey) return null;
  const m = config().manage;
  const prev = snapshots.get(posId);
  if (prev && Date.now() - prev.at < m.holder_poll_s * 1000) return null;

  const cur = await fetchHolderPct(mint);
  if (!cur) return null;
  if (!prev) {
    snapshots.set(posId, { at: Date.now(), pct: cur });
    return null;
  }

  const cand = findTrigger(prev.pct, cur, m.safety_wallet_dump_pct, m.safety_new_whale_pct);
  if (!cand) {
    snapshots.set(posId, { at: Date.now(), pct: cur });
    return null;
  }

  const confirm = await fetchHolderPct(mint);
  snapshots.set(posId, { at: Date.now(), pct: confirm ?? cur });
  if (!confirm) return null;
  return confirmHolderTrigger(
    prev.pct, cur, confirm, m.safety_wallet_dump_pct, m.safety_new_whale_pct,
  );
}

/**
 * Poll-if-due and evaluate. Returns a confirmed trigger or null. Never throws;
 * all failures (API down, budget exceeded) degrade to "no signal this cycle".
 */
export async function holderCheck(posId: number, mint: string): Promise<HolderTrigger | null> {
  return raceBudget(holderCheckInner(posId, mint), HOLDER_CHECK_BUDGET_MS);
}

/** Test hook — reset in-memory snapshots. */
export function _resetHolderWatchForTests(): void {
  snapshots.clear();
}
