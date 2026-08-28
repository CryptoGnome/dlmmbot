import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, pruneHistory } from "../db/db.js";
import { resetTestDb, useMemoryDb } from "../test/db.js";
import {
  backfillSkip, EPISODE_BUCKET_S, pendingSkips, storeOutcome, summarize,
  type SkipCandidate,
} from "./skipOutcome.js";

/**
 * The point of this data is to judge a GATE, so the two failure modes that
 * matter are (a) fetching once per sweep instead of once per rejection, and
 * (b) the result being evicted before anyone reads it. Both are asserted here.
 */

const T0 = 1_787_000_000;
/** Bucket-aligned, so a run inside one bucket is not split by the boundary. */
const TB = T0 - (T0 % EPISODE_BUCKET_S);

function fakeFetch(bars: number[][], status = 200) {
  return vi.fn(async () => ({
    ok: status === 200,
    status,
    json: async () => ({ data: { attributes: { ohlcv_list: bars } } }),
  })) as unknown as typeof fetch;
}

function addSkip(opts: {
  mint: string; pool: string; gate: string; ts: number; score?: number;
}): void {
  getDb().prepare(
    `INSERT INTO decisions (ts, mint, pool, action, failed_gate, score, features_json)
     VALUES (?, ?, ?, 'skipped', ?, ?, '{}')`
  ).run(opts.ts, opts.mint, opts.pool, opts.gate, opts.score ?? null);
}

const cand = (over: Partial<SkipCandidate> = {}): SkipCandidate => ({
  id: 1, mint: "MINT", pool: "POOL", failedGate: "bin_step_new",
  ts: T0, sweeps: 1, bestScore: 80, ...over,
});

describe("pendingSkips", () => {
  beforeEach(useMemoryDb);
  afterEach(resetTestDb);

  it("collapses a run of sweeps into ONE episode anchored on the first", () => {
    // 300 sweeps of the same rejection is the real shape on the live book:
    // `bin_step_new` logged 330 rows for one token. One fetch, not 330.
    for (let i = 0; i < 300; i++) addSkip({ mint: "M", pool: "P", gate: "bin_step_new", ts: TB + i * 60, score: 82 });
    const todo = pendingSkips(getDb(), 90, false, 100, TB + 400 * 60);
    expect(todo).toHaveLength(1);
    expect(todo[0]!.ts).toBe(TB);       // anchored on the FIRST sweep
    expect(todo[0]!.sweeps).toBe(300);  // but the count survives
    expect(todo[0]!.bestScore).toBe(82);
  });

  it("splits a blockade that outlives one bucket, sampling it more than once", () => {
    // Deliberate: Pistacio was blocked for 21 hours. One anchor at hour 0 would
    // describe none of hours 6-21, and an unbounded episode would let a single
    // fetch stand in for a whole day of price action.
    for (let i = 0; i < 3; i++)
      addSkip({ mint: "M", pool: "P", gate: "bin_step_new", ts: TB + i * EPISODE_BUCKET_S });
    expect(pendingSkips(getDb(), 90, false, 100, TB + EPISODE_BUCKET_S * 4)).toHaveLength(3);
  });

  it("splits the same rejection into a new episode after the bucket elapses", () => {
    addSkip({ mint: "M", pool: "P", gate: "bin_step_new", ts: T0 });
    addSkip({ mint: "M", pool: "P", gate: "bin_step_new", ts: T0 + EPISODE_BUCKET_S * 2 });
    const todo = pendingSkips(getDb(), 90, false, 100, T0 + EPISODE_BUCKET_S * 4);
    expect(todo).toHaveLength(2);
  });

  it("separates episodes by gate and by mint", () => {
    addSkip({ mint: "M", pool: "P", gate: "bin_step_new", ts: T0 });
    addSkip({ mint: "M", pool: "P", gate: "vol_30m", ts: T0 + 60 });
    addSkip({ mint: "OTHER", pool: "P2", gate: "bin_step_new", ts: T0 + 60 });
    expect(pendingSkips(getDb(), 90, false, 100, T0 + 10_000)).toHaveLength(3);
  });

  it("holds back episodes whose window has not elapsed", () => {
    addSkip({ mint: "M", pool: "P", gate: "g", ts: T0 });
    expect(pendingSkips(getDb(), 90, false, 100, T0 + 60)).toHaveLength(0);
    expect(pendingSkips(getDb(), 90, false, 100, T0 + 90 * 60)).toHaveLength(1);
  });

  it("is resumable: an episode with a result is not offered again unless refetched", () => {
    addSkip({ mint: "M", pool: "P", gate: "g", ts: T0 });
    const [c] = pendingSkips(getDb(), 90, false, 100, T0 + 10_000);
    storeOutcome(getDb(), c!.id, summarize(cand(), [], 90, T0));
    expect(pendingSkips(getDb(), 90, false, 100, T0 + 10_000)).toHaveLength(0);
    expect(pendingSkips(getDb(), 90, true, 100, T0 + 10_000)).toHaveLength(1);
  });

  it("ignores entered/exited rows — the audit trail is not a rejection", () => {
    getDb().prepare(
      `INSERT INTO decisions (ts, mint, pool, action, failed_gate, score, features_json)
       VALUES (?, 'M', 'P', 'entered', NULL, 80, '{}')`
    ).run(T0);
    expect(pendingSkips(getDb(), 90, false, 100, T0 + 10_000)).toHaveLength(0);
  });
});

describe("summarize", () => {
  const bars = (rows: Array<[number, number, number, number, number]>) =>
    rows.map(([ts, open, high, low, close]) => ({ ts, open, high, low, close }));

  it("anchors on the first forward bar's open and reports the path around it", () => {
    const o = summarize(cand({ ts: T0 }), bars([
      [T0, 100, 110, 95, 105],
      [T0 + 60, 105, 125, 90, 92],
      [T0 + 120, 92, 95, 60, 70],
    ]), 90, T0);
    expect(o.status).toBe("ok");
    expect(o.skipPrice).toBe(100);
    expect(o.peakPct).toBeCloseTo(25, 6);     // high 125
    expect(o.troughPct).toBeCloseTo(-40, 6);  // low 60
    expect(o.closePct).toBeCloseTo(-30, 6);   // close 70
    expect(o.bars).toBe(3);
    expect(o.barsBelowSkip).toBe(3);
  });

  it("drops bars before the skip so the anchor is the price we rejected", () => {
    const o = summarize(cand({ ts: T0 }), bars([
      [T0 - 120, 999, 999, 999, 999],
      [T0, 100, 100, 100, 100],
    ]), 90, T0);
    expect(o.skipPrice).toBe(100);
    expect(o.bars).toBe(1);
  });

  it("refuses an anchor from a bar that is too far after the skip", () => {
    const o = summarize(cand({ ts: T0 }), bars([[T0 + 3600, 100, 100, 100, 100]]), 90, T0);
    expect(o.status).toBe("no_anchor");
    expect(o.anchorLagS).toBe(3600);
    expect(o.skipPrice).toBeNull();
  });

  it("reports no_bars rather than a zeroed path when the pool never traded", () => {
    const o = summarize(cand({ ts: T0 }), [], 90, T0);
    expect(o.status).toBe("no_bars");
    expect(o.troughPct).toBeNull();
  });

  it("carries the episode's sweep count and best score into the stored result", () => {
    const o = summarize(cand({ sweeps: 330, bestScore: 82 }), [], 90, T0);
    expect(o.sweeps).toBe(330);
    expect(o.bestScore).toBe(82);
  });
});

describe("backfillSkip", () => {
  beforeEach(useMemoryDb);
  afterEach(resetTestDb);

  it("stores the measured path on the anchor row", async () => {
    addSkip({ mint: "M", pool: "P", gate: "bin_step_new", ts: T0 });
    const f = fakeFetch([[T0, 100, 120, 80, 90]]);
    const o = await backfillSkip(getDb(), cand({ id: 1 }), 90, T0 + 10_000, f);
    expect(o.status).toBe("ok");
    const row = getDb().prepare("SELECT outcome_backfill_json j FROM decisions WHERE id = 1").get() as { j: string };
    expect(JSON.parse(row.j).peakPct).toBeCloseTo(20, 6);
  });

  it("records too_recent without spending a fetch", async () => {
    addSkip({ mint: "M", pool: "P", gate: "g", ts: T0 });
    const f = fakeFetch([]);
    const o = await backfillSkip(getDb(), cand({ id: 1 }), 90, T0 + 60, f);
    expect(o.status).toBe("too_recent");
    expect(f).not.toHaveBeenCalled();
  });

  it("records an error status instead of losing the episode when the API fails", async () => {
    addSkip({ mint: "M", pool: "P", gate: "g", ts: T0 });
    const o = await backfillSkip(getDb(), cand({ id: 1 }), 90, T0 + 10_000, fakeFetch([], 500));
    expect(o.status).toBe("error");
    const row = getDb().prepare("SELECT outcome_backfill_json j FROM decisions WHERE id = 1").get() as { j: string };
    expect(JSON.parse(row.j).status).toBe("error");
  });
});

describe("pruneHistory spares backfilled skips", () => {
  beforeEach(useMemoryDb);
  afterEach(resetTestDb);

  it("keeps a measured row and still evicts its unmeasured siblings by age", () => {
    const old = Math.floor(Date.now() / 1000) - 40 * 86_400;
    addSkip({ mint: "M", pool: "P", gate: "bin_step_new", ts: old });
    addSkip({ mint: "M", pool: "P", gate: "bin_step_new", ts: old + 60 });
    storeOutcome(getDb(), 1, summarize(cand(), [], 90, old));

    pruneHistory({ skippedDays: 30, snapshotDays: 3 });

    const left = getDb().prepare("SELECT id FROM decisions ORDER BY id").all() as Array<{ id: number }>;
    expect(left.map((r) => r.id)).toEqual([1]);
  });

  it("keeps a measured row when the SIZE ceiling is trimming, not just the age window", () => {
    const base = Math.floor(Date.now() / 1000) - 3600;
    addSkip({ mint: "M", pool: "P", gate: "bin_step_new", ts: base });
    for (let i = 1; i < 200; i++) addSkip({ mint: `M${i}`, pool: "P", gate: "fee_tvl_24h", ts: base + i });
    storeOutcome(getDb(), 1, summarize(cand(), [], 90, base));

    // maxBytes 1 forces the size loop to trim everything it is allowed to.
    pruneHistory({ skippedDays: 30, snapshotDays: 3, maxBytes: 1 });

    const kept = getDb().prepare(
      "SELECT COUNT(*) n FROM decisions WHERE outcome_backfill_json IS NOT NULL"
    ).get() as { n: number };
    expect(kept.n).toBe(1);
  });
});

describe("gate filter", () => {
  beforeEach(useMemoryDb);
  afterEach(resetTestDb);

  it("filters in SQL so a rare gate is not crowded out by the limit", () => {
    // fee_tvl_24h is 93% of the live table; a post-LIMIT filter would return
    // nothing for the gate actually being investigated.
    for (let i = 0; i < 50; i++)
      addSkip({ mint: `BULK${i}`, pool: "P", gate: "fee_tvl_24h", ts: TB + 3600 + i });
    addSkip({ mint: "RARE", pool: "P", gate: "bin_step_new", ts: TB });

    const todo = pendingSkips(getDb(), 90, false, 10, TB + EPISODE_BUCKET_S, "bin_step_new");
    expect(todo).toHaveLength(1);
    expect(todo[0]!.mint).toBe("RARE");
  });

  it("returns every gate when no filter is given", () => {
    addSkip({ mint: "A", pool: "P", gate: "fee_tvl_24h", ts: TB });
    addSkip({ mint: "B", pool: "P", gate: "bin_step_new", ts: TB });
    expect(pendingSkips(getDb(), 90, false, 10, TB + EPISODE_BUCKET_S)).toHaveLength(2);
  });
});
