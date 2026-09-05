import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CLAIM_EST_TX_COST_SOL, giveBackPeakFloor, managePositions, pollSleepMs, resetManagerStateForTests, scanDue, shouldClaimFees } from "./loop.js";
import { FakeExecutor } from "../test/fakeExecutor.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb, insertOpenPosition } from "../test/db.js";
import { getDb, now } from "../db/db.js";
import { config, ESCAPE_ARM_DRAWDOWN_PCT, ESCAPE_RECOVER_DRAWDOWN_PCT } from "../config.js";
import type { ExitReason, Position } from "../types.js";

describe("pollSleepMs", () => {
  it("keeps cadence on short ticks and never stacks after long ones", () => {
    expect(pollSleepMs(2_000, 15_000)).toBe(13_000);
    expect(pollSleepMs(15_000, 15_000)).toBe(0);
    expect(pollSleepMs(50_000, 15_000)).toBe(0);
  });
});

describe("scanDue", () => {
  const INTERVAL = 60_000, POLL = 15_000;

  it("fires on the 4th tick instead of coin-flipping to the 5th", () => {
    // The old test was `elapsed > 60000`, sitting exactly on the boundary:
    // 288 of 637 measured scans passed it and 348 missed and waited 15s more.
    expect(scanDue(60_000, INTERVAL, POLL)).toBe(true);  // dead on
    expect(scanDue(59_998, INTERVAL, POLL)).toBe(true);  // the losing side
    expect(scanDue(60_002, INTERVAL, POLL)).toBe(true);  // the winning side
  });

  it("never fires a tick early", () => {
    expect(scanDue(45_000, INTERVAL, POLL)).toBe(false); // tick 3
    expect(scanDue(30_000, INTERVAL, POLL)).toBe(false);
    expect(scanDue(0, INTERVAL, POLL)).toBe(false);
  });

  it("puts the line at half a poll before the target", () => {
    expect(scanDue(52_501, INTERVAL, POLL)).toBe(true);
    expect(scanDue(52_500, INTERVAL, POLL)).toBe(false);
  });

  it("still behaves when the poll does not divide the interval", () => {
    expect(scanDue(56_501, INTERVAL, 7_000)).toBe(true);
    expect(scanDue(56_499, INTERVAL, 7_000)).toBe(false);
  });
});

describe("shouldClaimFees (P4)", () => {
  const m = { claim_min_sol: 0.05, claim_min_txcost_mult: 20, claim_interval_h: 4 };

  it("claims immediately above the headline floor", () => {
    expect(shouldClaimFees(0.05, 0, m)).toBe(true);
    expect(shouldClaimFees(0.2, 60, m)).toBe(true);
  });

  it("claims sub-floor fees once the interval elapses and the trip pays", () => {
    const fees = 20 * CLAIM_EST_TX_COST_SOL; // exactly the cost floor
    expect(shouldClaimFees(fees, 4 * 3600, m)).toBe(true);
    expect(shouldClaimFees(fees, 4 * 3600 - 1, m)).toBe(false); // too soon
  });

  it("never claims dust that would not pay claim_min_txcost_mult× tx cost", () => {
    expect(shouldClaimFees(20 * CLAIM_EST_TX_COST_SOL - 1e-9, 24 * 3600, m)).toBe(false);
    expect(shouldClaimFees(0, 24 * 3600, m)).toBe(false);
  });
});

describe("managePositions contracts", () => {
  let exec: FakeExecutor;

  beforeEach(() => {
    useMemoryDb();
    resetManagerStateForTests();
    installConfig((c) => {
      c.manage.stop_loss_frac = 0.75;
      c.manage.above_range_sustain_min = 10;
      c.manage.above_range_missed_sustain_min = 45;
      c.manage.escape_hatch_depth_pct = 60;
      c.manage.escape_hatch_recovery_pct = 25;
      c.manage.escape_hatch_drawdown_pct = 26.4;
      c.manage.escape_hatch_recovery_drawdown_pct = 12;
      c.manage.house_money_rule = false;
      c.manage.give_back_enabled = false; // rule under test separately below
      c.follow.enabled = false;
    });
    exec = new FakeExecutor("paper");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })));
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("marks all positions before closing any (sibling close must not delay peer marks)", async () => {
    const order: string[] = [];
    const a = insertOpenPosition({ entrySol: 0.4, symbol: "A" });
    const b = insertOpenPosition({ entrySol: 0.4, symbol: "B" });
    exec.setMark(a, { valueSol: 0.28, price: 0.8, activeBinId: 150, inRange: true });
    exec.setMark(b, { valueSol: 0.4, price: 1, activeBinId: 150, inRange: true });

    const mark = exec.mark.bind(exec);
    const close = exec.close.bind(exec);
    exec.mark = async (pos: Position) => {
      order.push(`mark:${pos.id}`);
      return mark(pos);
    };
    exec.close = async (pos: Position, reason: ExitReason, slip: number) => {
      order.push(`close:${pos.id}`);
      return close(pos, reason, slip);
    };

    await managePositions(exec);
    expect(order.indexOf(`mark:${a}`)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(`mark:${b}`)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(`close:${a}`)).toBeGreaterThanOrEqual(0);
    expect(Math.max(order.indexOf(`mark:${a}`), order.indexOf(`mark:${b}`)))
      .toBeLessThan(order.indexOf(`close:${a}`));
  });

  /**
   * Marking used to be strictly serial, so a tick cost the SUM of every
   * position's RPC latency — the reason mean mark gaps measured 16-19s against
   * poll_s = 15, with no sleep left to give back. These four cases pin the
   * contract the parallel version has to keep: overlap across pools, never
   * within one, and a ledger that still reads in book order.
   */
  function instrumentMarks() {
    const mark = exec.mark.bind(exec);
    const state = { inFlight: 0, max: 0, done: [] as number[] };
    exec.mark = async (pos: Position) => {
      state.inFlight++;
      state.max = Math.max(state.max, state.inFlight);
      // A real macrotask, so serial code cannot look concurrent by accident.
      await new Promise((r) => setTimeout(r, 5));
      state.inFlight--;
      state.done.push(pos.id);
      return mark(pos);
    };
    return state;
  }

  /** A mark that holds a position flat — nothing for the exit ladder to fire on. */
  function setFlatMark(id: number) {
    exec.setMark(id, { valueSol: 0.4, price: 1, activeBinId: 150, inRange: true });
  }

  it("marks different pools concurrently", async () => {
    const ids = ["poolA", "poolB", "poolC"].map((pool) =>
      insertOpenPosition({ entrySol: 0.4, pool }));
    ids.forEach(setFlatMark);
    config().manage.mark_concurrency = 4;
    const state = instrumentMarks();

    await managePositions(exec);
    expect(state.max).toBe(3);
    expect(state.done.sort()).toEqual(ids.sort());
  });

  /**
   * The live executor caches one pool object per address and refetchStates()
   * mutates it in place, so a tranche pair or a re-entry must never mark at the
   * same time as its sibling.
   */
  it("never marks two positions in the same pool at once", async () => {
    const ids = [0, 1, 2].map(() => insertOpenPosition({ entrySol: 0.4, pool: "poolA" }));
    ids.forEach(setFlatMark);
    config().manage.mark_concurrency = 4;
    const state = instrumentMarks();

    await managePositions(exec);
    expect(state.max).toBe(1);
    expect(state.done).toEqual(ids);
  });

  it("mark_concurrency = 1 restores strictly serial marking", async () => {
    const ids = ["poolA", "poolB", "poolC"].map((pool) =>
      insertOpenPosition({ entrySol: 0.4, pool }));
    ids.forEach(setFlatMark);
    config().manage.mark_concurrency = 1;
    const state = instrumentMarks();

    await managePositions(exec);
    expect(state.max).toBe(1);
    expect(state.done).toEqual(ids);
  });

  it("keeps a failed mark from costing its peers their tick", async () => {
    const bad = insertOpenPosition({ entrySol: 0.4, symbol: "BAD", pool: "poolA" });
    const good = insertOpenPosition({ entrySol: 0.4, symbol: "GOOD", pool: "poolB" });
    // No setMark for `bad`: FakeExecutor throws, the shape of an RPC failure.
    exec.setMark(good, { valueSol: 0.28, price: 0.8, activeBinId: 150, inRange: true });
    config().manage.mark_concurrency = 4;

    await managePositions(exec);
    expect(exec.closed).toEqual([{ id: good, reason: "P1_stop" }]);
    const rows = getDb().prepare("SELECT position_id FROM position_marks").all() as Array<{ position_id: number }>;
    expect(rows.map((r) => r.position_id)).toEqual([good]);
    const state = getDb().prepare("SELECT state FROM positions WHERE id = ?").get(bad) as { state: string };
    expect(state.state).toBe("open");
  });

  it("writes marks in book order even when a later pool answers first", async () => {
    const slow = insertOpenPosition({ entrySol: 0.4, symbol: "SLOW", pool: "poolA" });
    const fast = insertOpenPosition({ entrySol: 0.4, symbol: "FAST", pool: "poolB" });
    [slow, fast].forEach(setFlatMark);
    config().manage.mark_concurrency = 4;
    const mark = exec.mark.bind(exec);
    exec.mark = async (pos: Position) => {
      await new Promise((r) => setTimeout(r, pos.id === slow ? 30 : 1));
      return mark(pos);
    };

    await managePositions(exec);
    const rows = getDb().prepare("SELECT position_id FROM position_marks ORDER BY rowid").all() as Array<{ position_id: number }>;
    expect(rows.map((r) => r.position_id)).toEqual([slow, fast]);
  });

  it("P1 stop when valueFrac < stop_loss_frac", async () => {
    const id = insertOpenPosition({ entrySol: 0.4 });
    exec.setMark(id, {
      valueSol: 0.28,
      price: 0.8,
      activeBinId: 150,
      inRange: true,
    });
    await managePositions(exec);
    expect(exec.closed).toEqual([{ id, reason: "P1_stop" }]);
    const row = getDb().prepare("SELECT exit_reason FROM positions WHERE id = ?").get(id) as { exit_reason: string };
    expect(row.exit_reason).toBe("P1_stop");
  });

  /**
   * The executor fetches pool health for P0/P2 on every mark; before v0.19.1 the
   * insert dropped it, which left tvl_drain and rotation decay — 39% of closed
   * positions — impossible to replay in the backtester.
   */
  it("records pool health and banked fees on every mark", async () => {
    const id = insertOpenPosition({ entrySol: 0.4 });
    getDb().prepare("UPDATE positions SET fees_claimed_sol = 0.03 WHERE id = ?").run(id);
    exec.setMark(id, { valueSol: 0.4, price: 1, activeBinId: 150, inRange: true });
    await managePositions(exec);
    const row = getDb().prepare(
      `SELECT tvl_usd, vol_30m_usd, fee_tvl_30m_pct, fees_claimed_cum_sol
         FROM position_marks WHERE position_id = ?`
    ).get(id) as Record<string, number | null>;
    expect(row.tvl_usd).toBe(50_000);
    expect(row.vol_30m_usd).toBe(80_000);
    expect(row.fee_tvl_30m_pct).toBe(1);
    expect(row.fees_claimed_cum_sol).toBe(0.03);
  });

  /**
   * TELEMETRY ONLY. Fee-inclusive peak, then the give-back. Nothing closes —
   * the whole point is to collect the counterfactual before deciding.
   */
  describe("give-back telemetry", () => {
    const candidates = () =>
      (getDb().prepare("SELECT features_json FROM decisions WHERE failed_gate = 'give_back_candidate'").all() as
        Array<{ features_json: string }>);

    // entry 0.4: value 0.45 => peak +0.05; value 0.43 => +0.03, which is under
    // 75% of that peak (0.0375).
    const mark = (id: number, valueSol: number) =>
      exec.setMark(id, { valueSol, price: 1, activeBinId: 150, inRange: true });

    it("logs once when a qualifying peak is handed back, and closes nothing", async () => {
      const id = insertOpenPosition({ entrySol: 0.4, minBinId: 100, maxBinId: 200 });
      mark(id, 0.45);
      await managePositions(exec);
      expect(candidates()).toHaveLength(0); // still at the peak

      mark(id, 0.43);
      await managePositions(exec);
      const rows = candidates();
      expect(rows).toHaveLength(1);
      const f = JSON.parse(rows[0]!.features_json);
      expect(f.peakPnlSol).toBeCloseTo(0.05, 5);
      expect(f.pnlNowSol).toBeCloseTo(0.03, 5);
      expect(exec.closed).toHaveLength(0); // telemetry only

      mark(id, 0.41);
      await managePositions(exec);
      expect(candidates()).toHaveLength(1); // once per position
    });

    it("stays quiet when the peak never cleared the floor", async () => {
      const id = insertOpenPosition({ entrySol: 0.4, minBinId: 100, maxBinId: 200 });
      mark(id, 0.41); // +0.01 peak, under GIVE_BACK_MIN_PEAK_SOL
      await managePositions(exec);
      mark(id, 0.40);
      await managePositions(exec);
      expect(candidates()).toHaveLength(0);
    });

    /**
     * 0.02 SOL is 5% of the 0.4 above but 13% of a 0.15 SOL Railway meme entry —
     * a flat floor is blind to exactly the positions this is meant to watch.
     */
    it("scales the floor down for a small position", async () => {
      const id = insertOpenPosition({ entrySol: 0.15, minBinId: 100, maxBinId: 200 });
      expect(giveBackPeakFloor(0.15)).toBeCloseTo(0.0075, 6); // 5% of entry, not 0.02
      mark(id, 0.16);   // +0.010 peak — under the flat 0.02, over the scaled floor
      await managePositions(exec);
      mark(id, 0.1565); // +0.0065, i.e. 65% of the peak
      await managePositions(exec);
      expect(candidates()).toHaveLength(1);
      expect(exec.closed).toHaveLength(0);
    });

    it("caps the floor at the flat 0.02 for a large position", async () => {
      expect(giveBackPeakFloor(0.75)).toBe(0.02);
      expect(giveBackPeakFloor(5)).toBe(0.02);
    });

    it("remembers the peak across a restart", async () => {
      const id = insertOpenPosition({ entrySol: 0.4, minBinId: 100, maxBinId: 200 });
      mark(id, 0.45);
      await managePositions(exec);

      resetManagerStateForTests(); // the restart

      mark(id, 0.43);
      await managePositions(exec);
      // Without a persisted peak, 0.43 would BE the peak and nothing would fire.
      expect(candidates()).toHaveLength(1);
      expect(JSON.parse(candidates()[0]!.features_json).peakPnlSol).toBeCloseTo(0.05, 5);
    });

    it("does not log twice when a restart follows the first log", async () => {
      const id = insertOpenPosition({ entrySol: 0.4, minBinId: 100, maxBinId: 200 });
      mark(id, 0.45);
      await managePositions(exec);
      mark(id, 0.43);
      await managePositions(exec);
      expect(candidates()).toHaveLength(1);

      resetManagerStateForTests();

      mark(id, 0.42);
      await managePositions(exec);
      expect(candidates()).toHaveLength(1);
    });
  });

  /**
   * The same trigger with give_back_enabled: a REAL exit (promoted 2026-08-28
   * after replay and live telemetry agreed). Meme sleeves only.
   */
  describe("give-back stop (enabled)", () => {
    const mark = (id: number, valueSol: number) =>
      exec.setMark(id, { valueSol, price: 1, activeBinId: 150, inRange: true });
    const enable = () => installConfig((c) => {
      c.manage.give_back_enabled = true;
      c.manage.house_money_rule = false;
      c.follow.enabled = false;
    });

    it("closes with reason give_back and benches the token", async () => {
      enable();
      const id = insertOpenPosition({ entrySol: 0.4, minBinId: 100, maxBinId: 200 });
      mark(id, 0.45);
      await managePositions(exec);
      expect(exec.closed).toHaveLength(0); // at the peak — nothing to do

      mark(id, 0.43); // +0.03 = 60% of the +0.05 peak, under keep_frac 0.75
      await managePositions(exec);
      expect(exec.closed).toEqual([{ id, reason: "give_back" }]);
      const row = getDb().prepare("SELECT state, exit_reason FROM positions WHERE id = ?").get(id) as
        { state: string; exit_reason: string };
      expect(row.state).toBe("closed_giveback");
      expect(row.exit_reason).toBe("give_back");
      // Benched like an escape: re-buying on the next sweep is not "leaving".
      const bl = getDb().prepare("SELECT reason FROM blacklist WHERE key = 'mint1'").get() as
        { reason: string } | undefined;
      expect(bl?.reason).toContain("give-back");
      const exited = getDb().prepare(
        "SELECT features_json FROM decisions WHERE action = 'exited' AND failed_gate = 'give_back'"
      ).all();
      expect(exited).toHaveLength(1);
    });

    it("fires even when the candidate was already logged under the telemetry-only build", async () => {
      // Telemetry era logs the counterfactual and sets give_back_logged=1; a
      // deploy that enables the rule must still act on the NEXT trigger tick,
      // or every open gave-back position sails through untouched.
      const id = insertOpenPosition({ entrySol: 0.4, minBinId: 100, maxBinId: 200 });
      mark(id, 0.45);
      await managePositions(exec);
      mark(id, 0.43);
      await managePositions(exec); // telemetry-only: logs, closes nothing
      expect(exec.closed).toHaveLength(0);

      enable();
      mark(id, 0.42);
      await managePositions(exec);
      expect(exec.closed).toEqual([{ id, reason: "give_back" }]);
    });

    it("never fires on a majors position — the evidence base is meme-book only", async () => {
      enable();
      const id = insertOpenPosition({ entrySol: 0.4, minBinId: 100, maxBinId: 200 });
      getDb().prepare(
        `INSERT INTO decisions (ts, mint, pool, action, failed_gate, score, features_json)
         VALUES (?, 'mint1', 'pool1', 'entered', NULL, 80, '{"sleeve":"majors"}')`
      ).run(now() - 600);
      mark(id, 0.45);
      await managePositions(exec);
      mark(id, 0.43);
      await managePositions(exec);
      expect(exec.closed).toHaveLength(0); // telemetry may log; the exit must not fire
    });

    it("leaves a position alone while it holds above keep_frac of peak", async () => {
      enable();
      const id = insertOpenPosition({ entrySol: 0.4, minBinId: 100, maxBinId: 200 });
      mark(id, 0.45);
      await managePositions(exec);
      mark(id, 0.44); // +0.04 = 80% of peak, above keep 0.75
      await managePositions(exec);
      expect(exec.closed).toHaveLength(0);
    });
  });

  /**
   * resetManagerStateForTests() IS a restart in miniature: it drops every
   * in-memory map while the DB survives, exactly as a redeploy does. Before
   * these timers were persisted, a restart handed a position 14 minutes into
   * its 15-minute grace a fresh 15 and sent a 3-of-4 stop streak back to 0.
   */
  describe("exit timers survive a restart", () => {
    it("does not hand a below-range position a fresh grace window", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
      const id = insertOpenPosition({ entrySol: 0.3, minBinId: 100, maxBinId: 200 });
      exec.setMark(id, { valueSol: 0.29, price: 0.9, activeBinId: 90, inRange: false, belowRange: true });
      await managePositions(exec);
      expect(exec.closed).toHaveLength(0); // grace starts at 12:00

      resetManagerStateForTests(); // the restart

      vi.setSystemTime(new Date("2026-08-21T12:14:00Z"));
      await managePositions(exec);
      expect(exec.closed).toHaveLength(0); // 14m served, grace is 15m

      vi.setSystemTime(new Date("2026-08-21T12:16:00Z"));
      await managePositions(exec);
      expect(exec.closed).toEqual([{ id, reason: "P5_below" }]);
    });

    it("does not reset a part-served P1 stop streak", async () => {
      const id = insertOpenPosition({ entrySol: 0.4 });
      exec.setMark(id, { valueSol: 0.2, price: 0.5, activeBinId: 90, inRange: false, belowRange: true });
      for (let i = 0; i < 3; i++) await managePositions(exec);
      expect(exec.closed).toHaveLength(0); // 3 of the 4 sustain polls

      resetManagerStateForTests();

      await managePositions(exec); // the 4th, not a new first
      expect(exec.closed).toEqual([{ id, reason: "P1_stop" }]);
    });

    it("clears the persisted timers when the position closes", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
      const id = insertOpenPosition({ entrySol: 0.3, minBinId: 100, maxBinId: 200 });
      exec.setMark(id, { valueSol: 0.29, price: 0.9, activeBinId: 90, inRange: false, belowRange: true });
      await managePositions(exec);
      const running = getDb().prepare("SELECT below_range_since AS b FROM positions WHERE id = ?").get(id) as { b: number | null };
      expect(running.b).toBe(Math.floor(new Date("2026-08-21T12:00:00Z").getTime() / 1000));

      vi.setSystemTime(new Date("2026-08-21T12:16:00Z"));
      await managePositions(exec);
      const closed = getDb().prepare(
        "SELECT below_range_since AS b, stop_streak AS s FROM positions WHERE id = ?"
      ).get(id) as { b: number | null; s: number };
      expect(closed.b).toBeNull(); // a stale timer must not outlive the position
      expect(closed.s).toBe(0);
    });

    /**
     * P0 keeps no column of its own — its 10-minute window is rebuilt from the
     * marks already on disk. Without that, a restart blinds the drain check
     * until four fresh polls have accumulated, which is the window a rug fits in.
     */
    it("rebuilds the P0 drain window from marks it could not remember", async () => {
      vi.useFakeTimers();
      const id = insertOpenPosition({ entrySol: 0.3, minBinId: 100, maxBinId: 200 });
      const healthy = { valueSol: 0.29, price: 1, activeBinId: 150, inRange: true, tvlUsd: 50_000 };
      for (const t of ["12:00:00", "12:00:30", "12:01:00", "12:01:30"]) {
        vi.setSystemTime(new Date(`2026-08-21T${t}Z`));
        exec.setMark(id, healthy);
        await managePositions(exec);
      }
      expect(exec.closed).toHaveLength(0);

      resetManagerStateForTests();

      // TVL halves: -50% against a $50k median, past safety_tvl_drop_pct = 40.
      for (const t of ["12:02:00", "12:02:30"]) {
        vi.setSystemTime(new Date(`2026-08-21T${t}Z`));
        exec.setMark(id, { ...healthy, tvlUsd: 25_000 });
        await managePositions(exec);
      }
      expect(exec.closed).toEqual([{ id, reason: "P0_safety" }]);
    });
  });

  /**
   * 2026-08-20 young-launch research: every simulated quicker-exit rule tested
   * flat to negative on the ledger, so nothing acts — but the closest-to-even
   * trigger (2 min sustained below band midpoint) is logged once per position
   * as `young_exit_candidate` to be judged on forward data.
   */
  describe("young-exit candidate telemetry", () => {
    const candidateRows = () =>
      (getDb().prepare("SELECT features_json FROM decisions WHERE failed_gate = 'young_exit_candidate'").all() as Array<{ features_json: string }>);

    it("logs once after 2 min sustained below band midpoint, without closing", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));
      const id = insertOpenPosition({ entrySol: 0.3, minBinId: 100, maxBinId: 200 });
      exec.setMark(id, { valueSol: 0.29, price: 0.95, activeBinId: 130, inRange: true });

      await managePositions(exec);
      expect(candidateRows()).toHaveLength(0); // streak just started

      vi.setSystemTime(new Date("2026-08-20T12:03:00Z"));
      await managePositions(exec);
      const rows = candidateRows();
      expect(rows).toHaveLength(1);
      const f = JSON.parse(rows[0]!.features_json);
      expect(f.posId).toBe(id);
      expect(f.depthFrac).toBeCloseTo(0.3);
      expect(exec.closed).toHaveLength(0); // telemetry only — nothing closes

      vi.setSystemTime(new Date("2026-08-20T12:06:00Z"));
      await managePositions(exec);
      expect(candidateRows()).toHaveLength(1); // once per position
    });

    it("recovery above the midpoint resets the sustain streak", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));
      const id = insertOpenPosition({ entrySol: 0.3, minBinId: 100, maxBinId: 200 });
      exec.setMark(id, { valueSol: 0.29, price: 0.95, activeBinId: 130, inRange: true });
      await managePositions(exec);

      vi.setSystemTime(new Date("2026-08-20T12:03:00Z"));
      exec.setMark(id, { valueSol: 0.3, price: 1.05, activeBinId: 160, inRange: true });
      await managePositions(exec); // back above midpoint — streak cleared

      vi.setSystemTime(new Date("2026-08-20T12:04:00Z"));
      exec.setMark(id, { valueSol: 0.29, price: 0.95, activeBinId: 130, inRange: true });
      await managePositions(exec);

      vi.setSystemTime(new Date("2026-08-20T12:05:00Z"));
      await managePositions(exec); // only 60s into the new dip
      expect(candidateRows()).toHaveLength(0);
    });
  });

  /**
   * 4680 pos#11 (2026-08-16): a -54% wick lasting under two minutes. P5 armed
   * its 15m grace to ride out exactly that; P1 read one 15s mark at -25% and
   * cut the position 80s later. Token was +58% within the hour — the biggest
   * loss on the book, on a 5m candle that CLOSED at -20%. Below range, the stop
   * must sustain across polls. In range it is still immediate.
   */
  /**
   * 2026-08-18: `valueFrac` is MTM only and never saw fees already CLAIMED
   * (realized SOL in the wallet). Six of seven audited P1 stops fired with
   * fee-inclusive value 0.84–0.97; the seventh (4680) at 0.25 was a real
   * crash. `stop_loss_count_claimed_fees` switches what P1 measures; the
   * other answer is logged as `P1_fee_offset_deferred` so the knob can be
   * judged from the ledger before it is turned on.
   */
  describe("P1 fee offset (stop_loss_count_claimed_fees)", () => {
    // entry 0.4, MTM 0.28 -> valueFrac 0.70 (under 0.75). Claimed 0.06 -> fee-inclusive 0.85.
    const feeRich = () => {
      const id = insertOpenPosition({ entrySol: 0.4 });
      getDb().prepare("UPDATE positions SET fees_claimed_sol = 0.06 WHERE id = ?").run(id);
      exec.setMark(id, { valueSol: 0.28, price: 0.8, activeBinId: 150, inRange: true });
      return id;
    };
    const deferredRows = () =>
      (getDb().prepare("SELECT features_json FROM decisions WHERE failed_gate = 'P1_fee_offset_deferred'").all() as Array<{ features_json: string }>);

    it("OFF (default): fires on MTM exactly as before, and logs that fees would have held it", async () => {
      const id = feeRich();
      await managePositions(exec);
      expect(exec.closed).toEqual([{ id, reason: "P1_stop" }]);
      const rows = deferredRows();
      expect(rows).toHaveLength(1);
      const f = JSON.parse(rows[0]!.features_json);
      expect(f.valueFrac).toBeCloseTo(0.70, 2);
      expect(f.feeInclFrac).toBeCloseTo(0.85, 2);
    });

    it("OFF: does not log when fees would NOT have held it (a real crash)", async () => {
      // entry 0.4, MTM 0.088 -> 0.22; claimed 0.012 -> 0.25. The 4680 shape.
      const id = insertOpenPosition({ entrySol: 0.4 });
      getDb().prepare("UPDATE positions SET fees_claimed_sol = 0.012 WHERE id = ?").run(id);
      exec.setMark(id, { valueSol: 0.088, price: 0.8, activeBinId: 150, inRange: true });
      await managePositions(exec);
      expect(exec.closed).toEqual([{ id, reason: "P1_stop" }]);
      expect(deferredRows()).toHaveLength(0);
    });

    it("ON: a fee-rich position under MTM stop is held", async () => {
      installConfig((c) => { c.manage.stop_loss_frac = 0.75; c.manage.stop_loss_count_claimed_fees = true; c.manage.escape_hatch_depth_pct = 99; });
      feeRich();
      await managePositions(exec);
      expect(exec.closed).toHaveLength(0);
      expect(deferredRows()).toHaveLength(0); // no counterfactual when the knob is live
    });

    it("ON: a real crash still fires — fees cannot rescue 4680", async () => {
      installConfig((c) => { c.manage.stop_loss_frac = 0.75; c.manage.stop_loss_count_claimed_fees = true; });
      const id = insertOpenPosition({ entrySol: 0.4 });
      getDb().prepare("UPDATE positions SET fees_claimed_sol = 0.012 WHERE id = ?").run(id);
      exec.setMark(id, { valueSol: 0.088, price: 0.8, activeBinId: 150, inRange: true });
      await managePositions(exec);
      expect(exec.closed).toEqual([{ id, reason: "P1_stop" }]);
    });

    it("ON: fires once fees are exhausted by further drawdown", async () => {
      installConfig((c) => { c.manage.stop_loss_frac = 0.75; c.manage.stop_loss_count_claimed_fees = true; c.manage.escape_hatch_depth_pct = 99; });
      const id = feeRich();                     // 0.70 + 0.15 = 0.85, held
      await managePositions(exec);
      expect(exec.closed).toHaveLength(0);
      exec.setMark(id, { valueSol: 0.20, price: 0.8, activeBinId: 150, inRange: true }); // 0.50 + 0.15 = 0.65
      await managePositions(exec);
      expect(exec.closed).toEqual([{ id, reason: "P1_stop" }]);
    });
  });

  describe("P1 stop vs P5 wick tolerance", () => {
    const belowRangeUnderStop = (id: number) => exec.setMark(id, {
      valueSol: 0.28, price: 0.5, activeBinId: 50, inRange: false, belowRange: true, aboveRange: false,
    });

    it("does not fire on a single below-range mark — the wick case", async () => {
      installConfig((c) => { c.manage.stop_loss_sustain_polls = 4; });
      const id = insertOpenPosition({ entrySol: 0.4, minBinId: 100, maxBinId: 200 });
      belowRangeUnderStop(id);
      await managePositions(exec);
      expect(exec.closed).toHaveLength(0);
      // Two more polls, still under: streak 3 of 4 — still no cut.
      belowRangeUnderStop(id); await managePositions(exec);
      belowRangeUnderStop(id); await managePositions(exec);
      expect(exec.closed).toHaveLength(0);
    });

    it("a recovery between polls resets the streak", async () => {
      // Escape hatch off: bin 50 → bin 150 would otherwise read as deep-dip-recovered.
      installConfig((c) => { c.manage.stop_loss_sustain_polls = 3; c.manage.escape_hatch_drawdown_pct = 99; c.manage.escape_hatch_recovery_drawdown_pct = 0; });
      const id = insertOpenPosition({ entrySol: 0.4, minBinId: 100, maxBinId: 200 });
      belowRangeUnderStop(id); await managePositions(exec);
      belowRangeUnderStop(id); await managePositions(exec); // streak 2
      // Back in range and above the stop: streak must reset to 0.
      exec.setMark(id, { valueSol: 0.42, price: 1.1, activeBinId: 150, inRange: true, belowRange: false, aboveRange: false });
      await managePositions(exec);
      expect(exec.closed).toHaveLength(0);
      belowRangeUnderStop(id); await managePositions(exec); // streak 1, not 3
      expect(exec.closed).toHaveLength(0);
    });

    it("fires once the stop has sustained across the configured polls", async () => {
      installConfig((c) => { c.manage.stop_loss_sustain_polls = 3; });
      const id = insertOpenPosition({ entrySol: 0.4, minBinId: 100, maxBinId: 200 });
      for (let i = 0; i < 2; i++) { belowRangeUnderStop(id); await managePositions(exec); }
      expect(exec.closed).toHaveLength(0);
      belowRangeUnderStop(id); await managePositions(exec);
      expect(exec.closed).toEqual([{ id, reason: "P1_stop" }]);
    });

    it("still fires immediately when the drawdown happens IN range", async () => {
      // Value down 30% while price is still inside our bins is a real loss, not a wick.
      installConfig((c) => { c.manage.stop_loss_sustain_polls = 4; });
      const id = insertOpenPosition({ entrySol: 0.4, minBinId: 100, maxBinId: 200 });
      exec.setMark(id, { valueSol: 0.28, price: 0.8, activeBinId: 150, inRange: true });
      await managePositions(exec);
      expect(exec.closed).toEqual([{ id, reason: "P1_stop" }]);
    });
  });

  it("escape hatch closes after deep dip recovers to top", async () => {
    const id = insertOpenPosition({ entrySol: 0.4, minBinId: 100, maxBinId: 200, fellDeep: 1 });
    exec.setMark(id, {
      valueSol: 0.42,
      price: 1.05,
      activeBinId: 180,
      inRange: true,
    });
    await managePositions(exec);
    expect(exec.escapeRebalanced).toEqual([id]);
    expect(exec.closed).toEqual([{ id, reason: "escape" }]);
    // "Close and reset" must not re-buy on the next tick: the token is benched.
    const bl = getDb().prepare("SELECT reason, expires_ts FROM blacklist WHERE key = ?").get("mint1") as { reason: string; expires_ts: number } | undefined;
    expect(bl?.reason).toBe("escape cooldown");
    expect(bl!.expires_ts - Math.floor(Date.now() / 1000)).toBeGreaterThan(12 * 60);
    expect(bl!.expires_ts - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(15 * 60);
  });

  it("escape cooldown of 0 leaves the token re-enterable", async () => {
    installConfig((c) => { c.manage.escape_reentry_cooldown_min = 0; });
    const id = insertOpenPosition({ entrySol: 0.4, minBinId: 100, maxBinId: 200, fellDeep: 1 });
    exec.setMark(id, { valueSol: 0.42, price: 1.05, activeBinId: 180, inRange: true });
    await managePositions(exec);
    expect(exec.closed).toEqual([{ id, reason: "escape" }]);
    expect(getDb().prepare("SELECT 1 FROM blacklist WHERE key = ?").get("mint1")).toBeUndefined();
  });

  // v0.24.0 moved the hatch from a fraction of RANGE DEPTH to an absolute
  // drawdown from entry price. These two tests are the reason that was safe.
  describe("escape hatch arming is priced, not shaped", () => {
    it("defaults reproduce the old fraction-of-range rule at min_down_pct = 40", () => {
      // Old rule armed once price had fallen through 60% of the range's BINS.
      // Bins are geometric, so on a range whose bottom sits at 0.60x entry that
      // is exactly price = 0.60 ** 0.60. If either default drifts from this,
      // shipping the rework silently retunes a live exit — so pin it.
      const bottomRatio = 1 - 40 / 100;
      expect(ESCAPE_ARM_DRAWDOWN_PCT).toBeCloseTo((1 - bottomRatio ** 0.60) * 100, 1);
      expect(ESCAPE_RECOVER_DRAWDOWN_PCT).toBeCloseTo((1 - bottomRatio ** 0.25) * 100, 1);
    });

    it("with the switch off, the narrow range still arms on a shallow dip", async () => {
      // With the switch off the depth rule is live, so a -20% dip arms the
      // 25-bin range (63% of its depth) and leaves the 100-bin one alone — the
      // coupling the absolute form removes, and the reason it is not a no-op on
      // the real book. The template default flipped to ON on 2026-09-05; this
      // pins the legacy behaviour behind the switch, not the default.
      installConfig((c) => { c.manage.escape_hatch_absolute = false; });
      const wide = insertOpenPosition({ entrySol: 0.4, minBinId: 100, maxBinId: 200 });
      const narrow = insertOpenPosition({ entrySol: 0.4, minBinId: 175, maxBinId: 200, pool: "pool2" });
      const armed = (id: number) =>
        (getDb().prepare("SELECT fell_deep AS f FROM positions WHERE id = ?").get(id) as { f: number }).f;
      exec.setMark(wide, { valueSol: 0.40, price: 0.80, activeBinId: 156, inRange: true });
      exec.setMark(narrow, { valueSol: 0.40, price: 0.80, activeBinId: 184, inRange: true });
      await managePositions(exec);
      expect([armed(wide), armed(narrow)]).toEqual([0, 1]);
      // …and the disagreement is on the record, which is what decides this.
      const d = getDb().prepare(
        "SELECT COUNT(*) AS n FROM decisions WHERE failed_gate = 'escape_absolute_deferred'"
      ).get() as { n: number };
      expect(d.n).toBeGreaterThan(0);
    });

    it("the same dip arms a wide and a narrow range identically", async () => {
      // The defect: one config, two arming prices. A -20% dip used to arm a
      // 30%-deep range (60% of its depth) while leaving a 40%-deep one alone,
      // so width silently retuned the exit. Now neither arms until -26.4%.
      installConfig((c) => { c.manage.escape_hatch_absolute = true; });
      const wide = insertOpenPosition({ entrySol: 0.4, minBinId: 100, maxBinId: 200 });
      const narrow = insertOpenPosition({ entrySol: 0.4, minBinId: 175, maxBinId: 200, pool: "pool2" });
      const armed = (id: number) =>
        (getDb().prepare("SELECT fell_deep AS f FROM positions WHERE id = ?").get(id) as { f: number }).f;

      // Bins are set to where -20% / -30% actually falls in each range, so the
      // narrow position really is past 60% of its own depth at -20% — the case
      // the old rule armed on. activeBinId no longer feeds the hatch at all.
      exec.setMark(wide, { valueSol: 0.40, price: 0.80, activeBinId: 156, inRange: true });   // 44% of depth
      exec.setMark(narrow, { valueSol: 0.40, price: 0.80, activeBinId: 184, inRange: true }); // 63% of depth
      await managePositions(exec);
      expect([armed(wide), armed(narrow)]).toEqual([0, 0]);   // -20%: neither arms

      exec.setMark(wide, { valueSol: 0.40, price: 0.70, activeBinId: 130, inRange: true });
      exec.setMark(narrow, { valueSol: 0.40, price: 0.70, activeBinId: 176, inRange: true });
      await managePositions(exec);
      expect([armed(wide), armed(narrow)]).toEqual([1, 1]);   // -30%: both arm
    });
  });

  it("profit lock withdraws at configured threshold", async () => {
    installConfig((c) => {
      c.manage.profit_lock_enabled = true;
      c.manage.profit_lock_at_frac = 1.30;
      c.manage.profit_lock_withdraw_pct = 30;
      c.manage.profit_lock_max_fires = 1;
    });
    const id = insertOpenPosition({ entrySol: 0.4, minBinId: 100, maxBinId: 200 });
    exec.setMark(id, {
      valueSol: 0.52,
      price: 1.3,
      activeBinId: 150,
      inRange: true,
    });
    await managePositions(exec);
    expect(exec.withdrawn).toEqual([{ id, bps: 3000 }]);
    expect(exec.closed).toEqual([]);
    const row = getDb().prepare("SELECT profit_lock_fires FROM positions WHERE id = ?").get(id) as { profit_lock_fires: number };
    expect(row.profit_lock_fires).toBe(1);
  });

  it("P3 missed waits longer sustain than wins", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T12:00:00Z"));
    const id = insertOpenPosition({ entrySol: 0.3, everInRange: 0, minBinId: 100, maxBinId: 200 });
    exec.setMark(id, {
      valueSol: 0.3,
      price: 1.2,
      activeBinId: 220,
      aboveRange: true,
      inRange: false,
      belowRange: false,
    });
    await managePositions(exec);
    expect(exec.closed).toHaveLength(0);

    vi.setSystemTime(new Date("2026-08-13T12:12:00Z"));
    await managePositions(exec);
    expect(exec.closed).toHaveLength(0);

    vi.setSystemTime(new Date("2026-08-13T12:50:00Z"));
    await managePositions(exec);
    expect(exec.closed).toEqual([{ id, reason: "P3_above" }]);
    const row = getDb().prepare("SELECT state FROM positions WHERE id = ?").get(id) as { state: string };
    expect(row.state).toBe("closed_missed");
  });

  it("P0 pool_dead on valueSol === 0", async () => {
    const id = insertOpenPosition({ entrySol: 0.3 });
    exec.setMark(id, {
      valueSol: 0,
      price: 0,
      activeBinId: 0,
      tvlUsd: 0,
      belowRange: true,
      inRange: false,
    });
    await managePositions(exec);
    expect(exec.closed).toEqual([{ id, reason: "P0_safety" }]);
  });

  /**
   * A tvl_drain exit is cheap insurance and stays. What it must NOT do is what
   * it did to pos#5 GUNICORN (2026-08-15): one 40%-in-10-min reading on a
   * 9-minute-old pool permanently banned the token AND its creator, after which
   * the token round-tripped +260% and its pool stayed the best fee/TVL on the
   * board. TVL draining is a liquidity condition — a thin pool being traded
   * through looks identical to a rug — so it earns a cooldown, not a life
   * sentence. Triggers that actually evidence a rug keep the permanent ban.
   */
  describe("P0 blacklist severity", () => {
    const MINT = "mint1"; // insertOpenPosition hardcodes this
    const CREATOR = "Creator11111111111111111111111111111111111";

    function seedToken(mint: string) {
      getDb()
        .prepare("INSERT OR REPLACE INTO tokens (mint, creator, first_seen) VALUES (?, ?, 0)")
        .run(mint, CREATOR);
    }
    const bl = (key: string) =>
      getDb().prepare("SELECT reason, expires_ts FROM blacklist WHERE key = ?").get(key) as
        | { reason: string; expires_ts: number | null } | undefined;

    async function driveTvlDrain(id: number, tvls: number[], prices?: number[], poolAgeS?: number | null) {
      for (let i = 0; i < tvls.length; i++) {
        exec.setMark(id, {
          valueSol: 0.3, price: prices?.[i] ?? 1, activeBinId: 150, tvlUsd: tvls[i]!, inRange: true,
          ...(poolAgeS !== undefined ? { poolAgeS } : {}),
        });
        await managePositions(exec);
      }
    }

    /**
     * Below either floor the 10-min median is noise, measured with no rug in
     * progress: a thin pool's TVL is a handful of LPs (same token, same 4 min:
     * $8k pool swung 51%, $67k pool 9%); a newborn's baseline is its own birth.
     */
    it("skips tvl_drain on a thin pool where the median is noise", async () => {
      installConfig((c) => { c.manage.tvl_drain_min_tvl_usd = 20_000; c.manage.tvl_drain_min_pool_age_min = 20; });
      seedToken(MINT);
      const id = insertOpenPosition({ entrySol: 0.3, minBinId: 100, maxBinId: 200 });
      // Median $8k — the GUNICORN pool's depth. A -60% read here is not a rug read.
      await driveTvlDrain(id, [8_000, 8_000, 8_000, 8_000, 3_000, 3_000]);
      expect(exec.closed).toHaveLength(0);
    });

    it("skips tvl_drain on a pool younger than the measurement window", async () => {
      installConfig((c) => { c.manage.tvl_drain_min_tvl_usd = 20_000; c.manage.tvl_drain_min_pool_age_min = 20; });
      seedToken(MINT);
      const id = insertOpenPosition({ entrySol: 0.3, minBinId: 100, maxBinId: 200 });
      // Deep enough, but 9 minutes old — the pos#5 GUNICORN age at entry.
      await driveTvlDrain(id, [50_000, 50_000, 50_000, 50_000, 20_000, 20_000], undefined, 9 * 60);
      expect(exec.closed).toHaveLength(0);
    });

    it("fires normally on a deep, mature pool", async () => {
      installConfig((c) => { c.manage.tvl_drain_min_tvl_usd = 20_000; c.manage.tvl_drain_min_pool_age_min = 20; });
      seedToken(MINT);
      const id = insertOpenPosition({ entrySol: 0.3, minBinId: 100, maxBinId: 200 });
      await driveTvlDrain(id, [50_000, 50_000, 50_000, 50_000, 20_000, 20_000], undefined, 3 * 3600);
      expect(exec.closed).toEqual([{ id, reason: "P0_safety" }]);
    });

    it("unknown pool age does not suppress the trigger", async () => {
      // A missing created_at must not turn the safety off — null age = no age gate.
      installConfig((c) => { c.manage.tvl_drain_min_tvl_usd = 20_000; c.manage.tvl_drain_min_pool_age_min = 20; });
      seedToken(MINT);
      const id = insertOpenPosition({ entrySol: 0.3, minBinId: 100, maxBinId: 200 });
      await driveTvlDrain(id, [50_000, 50_000, 50_000, 50_000, 20_000, 20_000], undefined, null);
      expect(exec.closed).toEqual([{ id, reason: "P0_safety" }]);
    });

    it("tvl_drain cools the token off and spares the creator", async () => {
      installConfig((c) => { c.manage.tvl_drain_cooldown_h = 6; });
      seedToken(MINT);
      const id = insertOpenPosition({ entrySol: 0.3, minBinId: 100, maxBinId: 200 });
      // Four healthy samples set the median, then two consecutive -60% readings.
      await driveTvlDrain(id, [50_000, 50_000, 50_000, 50_000, 20_000, 20_000]);

      expect(exec.closed).toEqual([{ id, reason: "P0_safety" }]);
      const token = bl(MINT);
      expect(token?.reason).toMatch(/tvl_drain/);
      expect(token?.expires_ts).not.toBeNull(); // cooldown, not permanent
      expect(bl(CREATOR)).toBeUndefined();      // creator untouched
      const rug = getDb().prepare("SELECT rug_count FROM creators WHERE address = ?").get(CREATOR) as
        | { rug_count: number } | undefined;
      expect(rug?.rug_count ?? 0).toBe(0);
    });

    /**
     * The pos#5 GUNICORN shape: TVL -40%+ while price runs +261%. The pool was
     * being traded through — its ask-side inventory bought out — not drained.
     * Volume cannot separate the two (a rug is a stampede and prints volume
     * too); price direction can.
     */
    it("does not fire when TVL falls but price is running up", async () => {
      installConfig((c) => { c.manage.tvl_drain_price_rise_veto_pct = 25; });
      seedToken(MINT);
      const id = insertOpenPosition({ entrySol: 0.3, minBinId: 100, maxBinId: 200 });
      await driveTvlDrain(
        id,
        [50_000, 50_000, 50_000, 50_000, 20_000, 20_000],
        [1, 1, 1, 1, 2.6, 3.6], // +260% over the window
      );
      expect(exec.closed).toHaveLength(0);
      expect(bl(MINT)).toBeUndefined();
    });

    it("still fires when TVL falls and price is flat or falling", async () => {
      installConfig((c) => { c.manage.tvl_drain_price_rise_veto_pct = 25; });
      seedToken(MINT);
      const id = insertOpenPosition({ entrySol: 0.3, minBinId: 100, maxBinId: 200 });
      // A real rug drains TVL with price going the other way — veto must not save it.
      await driveTvlDrain(
        id,
        [50_000, 50_000, 50_000, 50_000, 20_000, 20_000],
        [1, 1, 1, 1, 0.8, 0.7],
      );
      expect(exec.closed).toEqual([{ id, reason: "P0_safety" }]);
    });

    it("a price rise under the veto threshold does not save it", async () => {
      installConfig((c) => { c.manage.tvl_drain_price_rise_veto_pct = 25; });
      seedToken(MINT);
      const id = insertOpenPosition({ entrySol: 0.3, minBinId: 100, maxBinId: 200 });
      await driveTvlDrain(
        id,
        [50_000, 50_000, 50_000, 50_000, 20_000, 20_000],
        [1, 1, 1, 1, 1.1, 1.1], // +10%, below the 25% bar
      );
      expect(exec.closed).toEqual([{ id, reason: "P0_safety" }]);
    });

    it("records the drain window on the decision row so it can be audited", async () => {
      seedToken(MINT);
      const id = insertOpenPosition({ entrySol: 0.3, minBinId: 100, maxBinId: 200 });
      await driveTvlDrain(id, [50_000, 50_000, 50_000, 50_000, 20_000, 20_000]);
      const row = getDb().prepare(
        "SELECT features_json f FROM decisions WHERE failed_gate = 'P0_safety_tvl_drain' ORDER BY id DESC LIMIT 1"
      ).get() as { f: string } | undefined;
      expect(row).toBeDefined();
      const drain = JSON.parse(row!.f).drain;
      // The window is in-memory and dies with the process — without this row a
      // tvl_drain exit leaves nothing to diagnose afterwards.
      expect(drain.medianTvl).toBe(50_000);
      expect(drain.tvlNow).toBe(20_000);
      expect(drain.tvlDropPct).toBeCloseTo(60);
      expect(drain.vetoedByPriceRise).toBe(false);
    });

    it("pool_dead still bans the token and the creator permanently", async () => {
      const mint = MINT;
      seedToken(mint);
      const id = insertOpenPosition({ entrySol: 0.3 });
      exec.setMark(id, { valueSol: 0, price: 0, activeBinId: 0, tvlUsd: 0, belowRange: true, inRange: false });
      await managePositions(exec);

      expect(bl(mint)?.expires_ts).toBeNull();    // permanent
      expect(bl(CREATOR)?.expires_ts).toBeNull(); // one strike on the creator
      const rug = getDb().prepare("SELECT rug_count FROM creators WHERE address = ?").get(CREATOR) as
        { rug_count: number };
      expect(rug.rug_count).toBe(1);
    });
  });
});

describe("operator close (dashboard button)", () => {
  let exec: FakeExecutor;

  beforeEach(() => {
    useMemoryDb();
    resetManagerStateForTests();
    installConfig((c) => {
      c.manage.stop_loss_frac = 0.75;
      c.follow.enabled = false;
    });
    exec = new FakeExecutor("paper");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
  });
  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.unstubAllGlobals();
  });

  const requestClose = (id: number) =>
    getDb().prepare("UPDATE positions SET close_requested_at = ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000), id);

  it("closes a requested position as `manual`", async () => {
    const id = insertOpenPosition({ entrySol: 0.4 });
    exec.setMark(id, { valueSol: 0.4, price: 1, activeBinId: 150, inRange: true });
    requestClose(id);

    await managePositions(exec);

    expect(exec.closed).toEqual([{ id, reason: "manual" }]);
    const row = getDb().prepare("SELECT exit_reason, exit_ts FROM positions WHERE id = ?")
      .get(id) as { exit_reason: string; exit_ts: number | null };
    expect(row.exit_reason).toBe("manual");
    expect(row.exit_ts).not.toBeNull();
  });

  // The operator looked at the position and decided. A rule firing on the same
  // tick must not get to relabel that exit — P1 would also blacklist the token
  // and feed the cluster brake, on a close the operator asked for.
  it("takes precedence over a rule that would fire on the same tick", async () => {
    const id = insertOpenPosition({ entrySol: 0.4 });
    exec.setMark(id, { valueSol: 0.28, price: 0.8, activeBinId: 150, inRange: true }); // would be P1_stop
    requestClose(id);

    await managePositions(exec);

    expect(exec.closed).toEqual([{ id, reason: "manual" }]);
    const row = getDb().prepare("SELECT exit_reason FROM positions WHERE id = ?")
      .get(id) as { exit_reason: string };
    expect(row.exit_reason).toBe("manual");
  });

  it("leaves positions without a request alone", async () => {
    const id = insertOpenPosition({ entrySol: 0.4 });
    exec.setMark(id, { valueSol: 0.4, price: 1, activeBinId: 150, inRange: true });

    await managePositions(exec);

    expect(exec.closed).toEqual([]);
  });

  it("closes only the requested position, not its siblings", async () => {
    const a = insertOpenPosition({ entrySol: 0.4, symbol: "A" });
    const b = insertOpenPosition({ entrySol: 0.4, symbol: "B" });
    exec.setMark(a, { valueSol: 0.4, price: 1, activeBinId: 150, inRange: true });
    exec.setMark(b, { valueSol: 0.4, price: 1, activeBinId: 150, inRange: true });
    requestClose(b);

    await managePositions(exec);

    expect(exec.closed).toEqual([{ id: b, reason: "manual" }]);
  });
});
