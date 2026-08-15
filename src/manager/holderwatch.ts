import { config, env } from "../config.js";
import { gmgnCli, gmgnIsBanned, gmgnTokenBudgetOk } from "../scanner/gmgn.js";
import { AMM_PROGRAM_IDS, BURN_ADDRESSES } from "../vetting/knownAccounts.js";

// P0 wallet-dump / new-whale triggers (STRATEGY.md §4) via GMGN holder polling.
// Top holders snapshotted every holder_poll_s; confirm-then-fire against the
// SAME baseline before P0 (TVL-glitch lesson: one bad read must never exit).

/**
 * Addresses that must never count as a "wallet" for dump/whale detection.
 *
 * The DLMM pool we are IN is the single largest holder of a fresh meme token,
 * and its balance falls every time price runs up — buyers are taking inventory
 * out of it. That is the pool being traded through, not a whale dumping. The
 * GMGN feed does tag exchanges, but a tag is a best-effort label on someone
 * else's server; excluding our own pool address, and anything the vetting side
 * already knows to be an AMM or burn sink, cannot depend on it. Same failure
 * shape as the tvl_drain false positive (pos#5 GUNICORN): a pool being consumed
 * looks like a rug to a rule that only reads one number.
 */
export function isNonWalletHolder(addr: string, poolAddress: string | null | undefined): boolean {
  if (poolAddress && addr === poolAddress) return true;
  if (AMM_PROGRAM_IDS.has(addr)) return true;
  if (BURN_ADDRESSES.has(addr)) return true;
  return false;
}

export interface HolderTrigger {
  kind: "wallet_dump" | "new_whale";
  detail: string;
}

interface Snapshot {
  at: number;
  pct: Map<string, number>;
  nextPollAt: number;
}

const snapshots = new Map<number, Snapshot>();
/** Wall-clock cap so slow GMGN cannot stretch the manage tick decision pass. */
export const HOLDER_CHECK_BUDGET_MS = 5_000;

export function clearHolderWatch(posId: number): void {
  snapshots.delete(posId);
}

/** Parse a GMGN holders payload into wallet → % of supply, dropping non-wallets. */
export function parseHolderPct(
  raw: string,
  poolAddress: string | null | undefined,
): Map<string, number> | null {
  const j = JSON.parse(raw) as Record<string, unknown>;
  const data = j.data as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  const list = (Array.isArray(j) ? j : (j.list ?? (Array.isArray(data) ? data : data?.list) ?? [])) as Array<Record<string, unknown>>;
  if (!list.length) return null;
  const pct = new Map<string, number>();
  for (const h of list) {
    const addr = String(h.address);
    // GMGN's own tags first, then our independent knowledge — never rely on the
    // tag alone (see isNonWalletHolder).
    if (Number(h.addr_type ?? 0) === 2 || String(h.exchange ?? "")) continue;
    if (isNonWalletHolder(addr, poolAddress)) continue;
    pct.set(addr, Number(h.amount_percentage ?? 0) * 100);
  }
  return pct;
}

async function fetchHolderPct(mint: string, poolAddress: string | null | undefined): Promise<Map<string, number> | null> {
  if (gmgnIsBanned() || !gmgnTokenBudgetOk(5)) return null;
  try {
    const raw = await gmgnCli(["token", "holders", "--chain", "sol", "--address", mint, "--limit", "20", "--raw"]);
    return parseHolderPct(raw, poolAddress);
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

async function holderCheckInner(posId: number, mint: string, poolAddress: string | null | undefined): Promise<HolderTrigger | null> {
  if (!env().gmgnApiKey) return null;
  const m = config().manage;
  const prev = snapshots.get(posId);
  const pollMs = m.holder_poll_s * 1000;

  if (!prev) {
    // Stagger first poll across positions so N open slots don't stampede one tick.
    const phase = (posId % 6) * Math.floor(pollMs / 6);
    snapshots.set(posId, { at: 0, pct: new Map(), nextPollAt: Date.now() + phase });
    return null;
  }
  if (Date.now() < prev.nextPollAt) return null;

  const cur = await fetchHolderPct(mint, poolAddress);
  if (!cur) return null;
  if (prev.at === 0 || prev.pct.size === 0) {
    snapshots.set(posId, { at: Date.now(), pct: cur, nextPollAt: Date.now() + pollMs });
    return null;
  }

  const cand = findTrigger(prev.pct, cur, m.safety_wallet_dump_pct, m.safety_new_whale_pct);
  if (!cand) {
    snapshots.set(posId, { at: Date.now(), pct: cur, nextPollAt: Date.now() + pollMs });
    return null;
  }

  const confirm = gmgnTokenBudgetOk(5) ? await fetchHolderPct(mint, poolAddress) : null;
  snapshots.set(posId, { at: Date.now(), pct: confirm ?? cur, nextPollAt: Date.now() + pollMs });
  if (!confirm) return null;
  return confirmHolderTrigger(
    prev.pct, cur, confirm, m.safety_wallet_dump_pct, m.safety_new_whale_pct,
  );
}

/**
 * Poll-if-due and evaluate. Returns a confirmed trigger or null. Never throws;
 * all failures (API down, budget exceeded) degrade to "no signal this cycle".
 */
export async function holderCheck(
  posId: number,
  mint: string,
  poolAddress?: string | null,
): Promise<HolderTrigger | null> {
  return raceBudget(holderCheckInner(posId, mint, poolAddress), HOLDER_CHECK_BUDGET_MS);
}

/** Test hook — reset in-memory snapshots. */
export function _resetHolderWatchForTests(): void {
  snapshots.clear();
}
