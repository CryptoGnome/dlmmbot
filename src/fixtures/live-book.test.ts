import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { managePositions, resetManagerStateForTests } from "../manager/loop.js";
import { txErrorDetail } from "../executor/live.js";
import { FakeExecutor } from "../test/fakeExecutor.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb, insertOpenPosition } from "../test/db.js";
import { getDb } from "../db/db.js";

const fixtures = JSON.parse(
  readFileSync(resolve(process.cwd(), "fixtures/live-book-golden.json"), "utf8")
) as {
  cases: Array<{
    id: string;
    entry?: {
      entry_sol: number; entry_price: number; min_bin_id: number; max_bin_id: number;
      ever_in_range: number; fell_deep: number;
    };
    marks?: Array<{
      value_sol: number; price: number; active_bin_id: number;
      in_range: boolean; above_range: boolean; below_range: boolean;
      tvl_usd: number; fee_tvl_30m_pct: number; vol_30m_usd: number;
    }>;
    open_failed?: { message: string; logs: string[] };
    expect: Record<string, unknown>;
  }>;
};

describe("live-book golden fixtures", () => {
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
      c.follow.enabled = false;
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  for (const c of fixtures.cases) {
    it(c.id, async () => {
      if (c.open_failed) {
        const d = txErrorDetail(c.open_failed);
        expect(d.code).toBe(c.expect.code);
        return;
      }
      if (!c.entry || !c.marks) throw new Error(`fixture ${c.id} missing entry/marks`);
      const exec = new FakeExecutor("paper");
      const id = insertOpenPosition({
        entrySol: c.entry.entry_sol,
        entryPrice: c.entry.entry_price,
        minBinId: c.entry.min_bin_id,
        maxBinId: c.entry.max_bin_id,
        everInRange: c.entry.ever_in_range,
        fellDeep: c.entry.fell_deep,
      });
      const m = c.marks[0]!;
      exec.setMark(id, {
        valueSol: m.value_sol,
        price: m.price,
        activeBinId: m.active_bin_id,
        inRange: m.in_range,
        aboveRange: m.above_range,
        belowRange: m.below_range,
        tvlUsd: m.tvl_usd,
        feeTvl30mPct: m.fee_tvl_30m_pct,
        vol30mUsd: m.vol_30m_usd,
      });

      if (c.id === "p3_missed_10m_churn") {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-13T12:00:00Z"));
        await managePositions(exec);
        expect(exec.closed).toHaveLength(0);
        vi.setSystemTime(new Date("2026-08-13T12:50:00Z"));
        await managePositions(exec);
      } else {
        // `repeat_polls`: hold the same mark across N ticks. Rules that must
        // SUSTAIN before firing (P1 below range, since 2026-08-16) need it.
        const polls = Math.max(1, (c as { repeat_polls?: number }).repeat_polls ?? 1);
        for (let i = 0; i < polls; i++) await managePositions(exec);
      }

      if (c.expect.exit_reason) {
        expect(exec.closed[0]?.reason).toBe(c.expect.exit_reason);
      }
      if (c.expect.escape_rebalance) {
        expect(exec.escapeRebalanced).toEqual([id]);
        expect(exec.closed).toEqual([]);
      }
      if (c.expect.fell_deep !== undefined) {
        const row = getDb().prepare("SELECT fell_deep FROM positions WHERE id = ?").get(id) as { fell_deep: number };
        expect(row.fell_deep).toBe(c.expect.fell_deep);
      }
      if (c.expect.state) {
        const row = getDb().prepare("SELECT state FROM positions WHERE id = ?").get(id) as { state: string };
        expect(row.state).toBe(c.expect.state);
      }
    });
  }
});
