import { config, env } from "../config.js";
import { gmgnCli } from "../scanner/gmgn.js";

// P0 wallet-dump / new-whale triggers (STRATEGY.md §4, phase-2 spec) via GMGN
// holder polling — no tx-stream needed. Each open position's top holders are
// snapshotted every holder_poll_s; a trigger candidate is confirmed by an
// immediate re-read against the SAME baseline before firing (TVL-glitch
// lesson, 2026-08-07: one bad API reading must never cause a safety exit).

export interface HolderTrigger {
  kind: "wallet_dump" | "new_whale";
  detail: string;
}

interface Snapshot {
  at: number;
  pct: Map<string, number>; // holder address -> % of supply (pools/AMMs excluded)
}

const snapshots = new Map<number, Snapshot>();

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
      // addr_type 2 / exchange-labeled accounts are pools & AMMs — liquidity
      // moving there is trading, not a holder dumping.
      if (Number(h.addr_type ?? 0) === 2 || String(h.exchange ?? "")) continue;
      pct.set(String(h.address), Number(h.amount_percentage ?? 0) * 100);
    }
    return pct;
  } catch {
    return null; // rate-limited or API down — skip this cycle
  }
}

function findTrigger(baseline: Map<string, number>, cur: Map<string, number>, dumpPct: number, whalePct: number): HolderTrigger | null {
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

/**
 * Poll-if-due and evaluate. Returns a confirmed trigger or null. Never throws;
 * all failures degrade to "no signal this cycle".
 */
export async function holderCheck(posId: number, mint: string): Promise<HolderTrigger | null> {
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

  // Confirm against the SAME baseline with a fresh read before firing.
  const confirm = await fetchHolderPct(mint);
  snapshots.set(posId, { at: Date.now(), pct: confirm ?? cur });
  if (!confirm) return null;
  const confirmed = findTrigger(prev.pct, confirm, m.safety_wallet_dump_pct, m.safety_new_whale_pct);
  return confirmed && confirmed.kind === cand.kind ? confirmed : null;
}
