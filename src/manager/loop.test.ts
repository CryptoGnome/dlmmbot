import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CLAIM_EST_TX_COST_SOL, managePositions, pollSleepMs, resetManagerStateForTests, shouldClaimFees } from "./loop.js";
import { FakeExecutor } from "../test/fakeExecutor.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb, insertOpenPosition } from "../test/db.js";
import { getDb } from "../db/db.js";
import type { ExitReason, Position } from "../types.js";

describe("pollSleepMs", () => {
  it("keeps cadence on short ticks and never stacks after long ones", () => {
    expect(pollSleepMs(2_000, 15_000)).toBe(13_000);
    expect(pollSleepMs(15_000, 15_000)).toBe(0);
    expect(pollSleepMs(50_000, 15_000)).toBe(0);
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
      c.manage.house_money_rule = false;
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
      installConfig((c) => { c.manage.stop_loss_sustain_polls = 3; c.manage.escape_hatch_depth_pct = 99; c.manage.escape_hatch_recovery_pct = 0; });
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
