import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { managePositions, pollSleepMs } from "./loop.js";
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

describe("managePositions contracts", () => {
  let exec: FakeExecutor;

  beforeEach(() => {
    useMemoryDb();
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

  it("escape hatch after deep dip recovers to top", async () => {
    const id = insertOpenPosition({ entrySol: 0.4, minBinId: 100, maxBinId: 200, fellDeep: 1 });
    exec.setMark(id, {
      valueSol: 0.42,
      price: 1.05,
      activeBinId: 180,
      inRange: true,
    });
    await managePositions(exec);
    expect(exec.closed).toEqual([{ id, reason: "escape" }]);
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
});
