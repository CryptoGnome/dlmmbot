import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, now } from "../db/db.js";
import { insertClosedPosition, resetTestDb, useMemoryDb } from "../test/db.js";
import { auditExits, formatExitAudit } from "./report.js";
import {
  backfillOne, calibrate, fetchBars, loadPath, pending, recovery, type Bar,
} from "./postExit.js";

/**
 * The value of this data rests entirely on the calibration step: GeckoTerminal
 * is not our price feed, and a series that does not line up with our own marks
 * must be refused rather than quietly averaged into a conclusion.
 */

/** A fetch that returns the given bars in GeckoTerminal's [ts,o,h,l,c] shape. */
function fakeFetch(bars: number[][], status = 200) {
  return vi.fn(async () => ({
    ok: status === 200,
    status,
    json: async () => ({ data: { attributes: { ohlcv_list: bars } } }),
  })) as unknown as typeof fetch;
}

const T0 = 1_787_000_000; // fixed minute boundary

function markAt(positionId: number, ts: number, price: number): void {
  getDb().prepare(
    `INSERT INTO position_marks (position_id, ts, active_bin_id, price, value_sol, value_frac, unclaimed_fees_sol, in_range)
     VALUES (?, ?, 100, ?, 1, 1, 0, 1)`
  ).run(positionId, ts, price);
}

describe("post-exit backfill", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => { resetTestDb(); vi.restoreAllMocks(); });

  describe("fetchBars", () => {
    it("parses, sorts and drops malformed bars", async () => {
      const f = fakeFetch([[T0 + 120, 2, 3, 1, 2.5], [T0, 1, 2, 0.5, 1.5]]);
      const bars = await fetchBars("pool", T0 + 600, 100, f);
      expect(bars?.map((b) => b.ts)).toEqual([T0, T0 + 120]);
      expect(bars?.[0]).toMatchObject({ open: 1, high: 2, low: 0.5, close: 1.5 });
    });

    it("returns null on a hard error rather than pretending the pool was flat", async () => {
      expect(await fetchBars("pool", T0, 100, fakeFetch([], 404))).toBeNull();
    });
  });

  describe("calibrate", () => {
    const bars: Bar[] = [0, 1, 2, 3].map((i) => ({
      ts: T0 + i * 60, open: 1, high: 1, low: 1, close: 10,
    }));

    it("finds the ratio between their series and ours", () => {
      // Our marks read 20 where their bars close at 10 — a constant x2.
      const marks = [0, 1, 2, 3].map((i) => ({ ts: T0 + i * 60 + 5, price: 20 }));
      const c = calibrate(bars, marks);
      expect(c.ratio).toBeCloseTo(2, 6);
      expect(c.tight).toBe(true);
      expect(c.n).toBe(4);
    });

    it("refuses a series that does not track ours", () => {
      const marks = [10, 40, 12, 90].map((p, i) => ({ ts: T0 + i * 60 + 5, price: p }));
      expect(calibrate(bars, marks).tight).toBe(false);
    });

    it("reports no ratio when the windows barely overlap", () => {
      const c = calibrate(bars, [{ ts: T0 + 5, price: 10 }]);
      expect(c.ratio).toBeNull();
      expect(c.tight).toBe(false);
    });
  });

  describe("backfillOne", () => {
    const closed = (exitTs: number) => insertClosedPosition({
      entrySol: 0.4, exitSol: 0.3, exitTs, mode: "live",
    });

    it("stores bars and marks the position ok when calibration holds", async () => {
      const id = closed(T0);
      for (let i = 4; i >= 1; i--) markAt(id, T0 - i * 60 + 5, 10);
      const bars = [-4, -3, -2, -1, 0, 1, 2].map((i) => [T0 + i * 60, 10, 12, 9, 10]);
      const f = fakeFetch(bars);
      const r = await backfillOne(getDb(), { id, pool: "p", exit_ts: T0 }, 80, T0 + 99_999, f);
      expect(r.status).toBe("ok");
      expect(r.calibRatio).toBeCloseTo(1, 6);
      expect(r.bars).toBe(7);
      const stored = getDb().prepare("SELECT COUNT(*) c FROM post_exit_prices WHERE position_id = ?").get(id) as { c: number };
      expect(stored.c).toBe(7);
    });

    it("does not fetch a position whose window has not elapsed yet", async () => {
      const id = closed(T0);
      const f = fakeFetch([]);
      const r = await backfillOne(getDb(), { id, pool: "p", exit_ts: T0 }, 80, T0 + 60, f);
      expect(r.status).toBe("too_recent");
      expect(f).not.toHaveBeenCalled();
    });

    it("keeps miscalibrated bars but refuses to serve them", async () => {
      const id = closed(T0);
      [3, 40, 5, 90].forEach((p, i) => markAt(id, T0 - (4 - i) * 60 + 5, p));
      const bars = [-4, -3, -2, -1, 0, 1].map((i) => [T0 + i * 60, 10, 10, 10, 10]);
      const r = await backfillOne(getDb(), { id, pool: "p", exit_ts: T0 }, 80, T0 + 99_999, fakeFetch(bars));
      expect(r.status).toBe("miscalibrated");
      const kept = getDb().prepare("SELECT COUNT(*) c FROM post_exit_prices WHERE position_id = ?").get(id) as { c: number };
      expect(kept.c).toBe(6);                       // stored, so a re-judge is free
      expect(loadPath(getDb(), id, T0)).toBeNull(); // but never handed to the audit
    });

    it("records a failed fetch instead of leaving the position pending forever", async () => {
      const id = closed(T0);
      const r = await backfillOne(getDb(), { id, pool: "p", exit_ts: T0 }, 80, T0 + 99_999, fakeFetch([], 500));
      expect(r.status).toBe("error");
      const row = getDb().prepare("SELECT status FROM post_exit_backfill WHERE position_id = ?").get(id) as { status: string };
      expect(row.status).toBe("error");
    });
  });

  describe("pending", () => {
    it("skips finished positions but retries the ones that were too recent", async () => {
      const done = insertClosedPosition({ entrySol: 0.4, exitSol: 0.3, exitTs: now() - 99_999, mode: "live" });
      const early = insertClosedPosition({ entrySol: 0.4, exitSol: 0.3, exitTs: now() - 60, mode: "live" });
      await backfillOne(getDb(), { id: done, pool: "p", exit_ts: now() - 99_999 }, 80, now(), fakeFetch([[T0, 1, 1, 1, 1]]));
      await backfillOne(getDb(), { id: early, pool: "p", exit_ts: now() - 60 }, 80, now(), fakeFetch([]));

      const ids = pending(getDb(), 80, false, 50).map((c) => c.id);
      expect(ids).toContain(early);   // its window has since elapsed
      expect(ids).not.toContain(done);
      expect(pending(getDb(), 80, true, 50).map((c) => c.id)).toContain(done); // --refetch
    });
  });

  describe("recovery", () => {
    const path = (closes: number[]) => ({
      positionId: 1, calibRatio: 1,
      after: closes.map((c, i) => ({ ts: T0 + i * 60, open: c, high: c, low: c, close: c })),
    });

    it("measures the high, the low and when the high came", () => {
      const r = recovery(path([10, 12, 18, 11]), 10, 20, 60)!;
      expect(r.maxMult).toBeCloseTo(1.8, 6);
      expect(r.minMult).toBeCloseTo(1.0, 6);
      expect(r.endMult).toBeCloseTo(1.1, 6);
      expect(r.minutesToHigh).toBe(2);
      expect(r.regainedEntry).toBe(false); // never got back to 20
    });

    it("flags price returning to the entry, where the whole range is traversed", () => {
      expect(recovery(path([10, 25]), 10, 20, 60)!.regainedEntry).toBe(true);
    });

    it("honours the window rather than reading the whole series", () => {
      // The x5 spike sits at minute 3, outside a 2-minute window.
      expect(recovery(path([10, 11, 12, 50]), 10, 999, 2)!.maxMult).toBeCloseTo(1.2, 6);
    });
  });

  it("audits exits by reason, folding P3 win/missed into one row", () => {
    const rec = (maxMult: number, regained: boolean) => ({
      maxMult, minMult: 0.9, endMult: 1, minutesToHigh: 5, regainedEntry: regained, bars: 60,
    });
    const audits = auditExits([
      { reason: "P3_above_win", rec: rec(1.1, false), belowAtExit: false },
      { reason: "P3_above_missed", rec: rec(1.3, true), belowAtExit: false },
      { reason: "P1_stop", rec: rec(2.0, true), belowAtExit: true },
    ]);
    const p3 = audits.find((a) => a.reason === "P3_above")!;
    expect(p3.n).toBe(2);
    expect(p3.medMax).toBeCloseTo(1.2, 6);
    expect(p3.regained).toBe(1);
    const stop = audits.find((a) => a.reason === "P1_stop")!;
    expect(stop.bigRecoveries).toBe(1);
  });

  /**
   * The distinction that decides whether this report tells the truth. An exit
   * taken above range has already converted to SOL, so later upside is not
   * value we gave up — reading it as one inverts the conclusion.
   */
  it("separates recoveries that were forgone from ones that cost nothing", () => {
    const rec = (maxMult: number) => ({
      maxMult, minMult: 0.9, endMult: 1, minutesToHigh: 5, regainedEntry: false, bars: 60,
    });
    const text = formatExitAudit([
      { reason: "P1_stop", rec: rec(1.4), belowAtExit: true },
      { reason: "escape", rec: rec(1.5), belowAtExit: false },
    ], 60);
    expect(text).toContain("SOLD BELOW RANGE");
    expect(text).toContain("SOLD AT OR ABOVE RANGE");
    expect(text).toContain("NOT forgone");
    // Each exit reason appears under exactly one heading.
    const below = text.slice(text.indexOf("SOLD BELOW RANGE"), text.indexOf("SOLD AT OR ABOVE"));
    expect(below).toContain("P1_stop");
    expect(below).not.toContain("escape");
  });
});
