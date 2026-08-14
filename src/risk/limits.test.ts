import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  regimeFactor, clusterBrakeTripped, circuitBreakerTripped, kellyStats, positionSize, computeBankroll,
} from "./limits.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb, insertClosedPosition } from "../test/db.js";
import { getDb, now } from "../db/db.js";

describe("regimeFactor", () => {
  beforeEach(() => installConfig((c) => {
    c.sizing.regime_filter = true;
    c.sizing.regime_sol_24h_halve_pct = -5;
    c.sizing.regime_sol_24h_pause_pct = -10;
  }));
  afterEach(() => restoreConfig());

  it("pauses / halves / full by SOL 24h move", () => {
    expect(regimeFactor(-12)).toBe(0);
    expect(regimeFactor(-7)).toBe(0.5);
    expect(regimeFactor(-1)).toBe(1);
  });
});

describe("clusterBrakeTripped", () => {
  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.sizing.cluster_brake_exits = 2;
      c.sizing.cluster_brake_window_h = 6;
      c.sizing.cluster_brake_pause_h = 6;
      c.sizing.cluster_brake_loss_pct = 10;
    });
  });
  afterEach(() => {
    resetTestDb();
    restoreConfig();
  });

  it("fires on 2× lossy P0/P1 inside the window", () => {
    const t = now();
    insertClosedPosition({
      entrySol: 0.3, exitSol: 0.2, openCostSol: 0.3, closeReturnSol: 0.2,
      exitReason: "P1_stop", exitTs: t - 100,
    });
    insertClosedPosition({
      entrySol: 0.3, exitSol: 0.15, openCostSol: 0.3, closeReturnSol: 0.15,
      exitReason: "P0_safety", exitTs: t - 50,
    });
    const hit = clusterBrakeTripped();
    expect(hit).not.toBeNull();
    expect(hit!.count).toBeGreaterThanOrEqual(2);
    expect(hit!.remainingMin).toBeGreaterThan(0);
  });

  it("ignores near-flat / recovered hard exits", () => {
    const t = now();
    // −5% — under the −10% loss floor
    insertClosedPosition({
      entrySol: 0.3, exitSol: 0.285, openCostSol: 0.3, closeReturnSol: 0.285,
      exitReason: "P0_safety", exitTs: t - 100,
    });
    insertClosedPosition({
      entrySol: 0.3, exitSol: 0.29, openCostSol: 0.3, closeReturnSol: 0.29,
      exitReason: "P0_safety", exitTs: t - 50,
    });
    expect(clusterBrakeTripped()).toBeNull();
  });

  it("does not fire on a single hard exit", () => {
    insertClosedPosition({
      entrySol: 0.3, exitSol: 0.2, openCostSol: 0.3, closeReturnSol: 0.2,
      exitReason: "P1_stop", exitTs: now() - 100,
    });
    expect(clusterBrakeTripped()).toBeNull();
  });

  it("fires on a cluster spread wider than pause_h (regression: oldest-exit anchor)", () => {
    // Live config runs pause_h < window_h. The old code anchored the pause on
    // the OLDEST exit of the cluster, so 4 exits spread over 3h with a 2h
    // pause never paused at all. Anchor must be the newest exit.
    installConfig((c) => {
      c.sizing.cluster_brake_exits = 4;
      c.sizing.cluster_brake_window_h = 6;
      c.sizing.cluster_brake_pause_h = 2;
      c.sizing.cluster_brake_loss_pct = 10;
    });
    const t = now();
    for (const agoS of [3 * 3600, 2 * 3600, 30 * 60, 60]) {
      insertClosedPosition({
        entrySol: 0.3, exitSol: 0.2, openCostSol: 0.3, closeReturnSol: 0.2,
        exitReason: "P1_stop", exitTs: t - agoS,
      });
    }
    const hit = clusterBrakeTripped();
    expect(hit).not.toBeNull();
    expect(hit!.count).toBe(4);
    // Pause runs from the newest exit (60s ago), so ~119 minutes remain.
    expect(hit!.remainingMin).toBeGreaterThan(100);
  });

  it("respects cluster_brake_cleared_at operator clear", () => {
    const t = now();
    insertClosedPosition({
      entrySol: 0.3, exitSol: 0.2, openCostSol: 0.3, closeReturnSol: 0.2,
      exitReason: "P1_stop", exitTs: t - 100,
    });
    insertClosedPosition({
      entrySol: 0.3, exitSol: 0.15, openCostSol: 0.3, closeReturnSol: 0.15,
      exitReason: "P0_safety", exitTs: t - 50,
    });
    expect(clusterBrakeTripped()).not.toBeNull();
    getDb().prepare(
      "INSERT INTO meta (key, value) VALUES ('cluster_brake_cleared_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(String(t));
    expect(clusterBrakeTripped()).toBeNull();
  });
});

describe("circuitBreakerTripped", () => {
  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.sizing.circuit_daily_loss_pct = 5;
    });
  });
  afterEach(() => {
    resetTestDb();
    restoreConfig();
  });

  it("trips when measured daily loss exceeds wallet %", () => {
    insertClosedPosition({
      entrySol: 1,
      exitSol: 0,
      openCostSol: 1,
      closeReturnSol: 0,
      feesMeasuredSol: 0,
      exitTs: now() - 60,
    });
    expect(circuitBreakerTripped(10)).toBe(true); // -1 > 5% of 10
    expect(circuitBreakerTripped(30)).toBe(false);
  });

  it("ignores losses from the other mode (shared promotion-flow DB)", () => {
    // Test process runs paper; a live loss must not trip the paper breaker.
    insertClosedPosition({
      entrySol: 1,
      exitSol: 0,
      openCostSol: 1,
      closeReturnSol: 0,
      exitTs: now() - 60,
      mode: "live",
    });
    expect(circuitBreakerTripped(10)).toBe(false);
  });

  it("ignores unknown-outcome rows (NULL realized PnL)", () => {
    // Force-close / reconcile-orphan rows: exit values unknown, not a loss.
    insertClosedPosition({
      entrySol: 1,
      exitSol: null,
      exitReason: "manual",
      openCostSol: null,
      closeReturnSol: null,
      exitTs: now() - 60,
    });
    expect(circuitBreakerTripped(10)).toBe(false);
  });
});

describe("kellyStats + positionSize", () => {
  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.sizing.kelly_enabled = true;
      c.sizing.kelly_min_samples = 5;
      c.sizing.kelly_lookback = 50;
      c.sizing.kelly_fraction = 0.5;
      c.sizing.kelly_cold_start_frac = 0.02;
      c.sizing.kelly_max_position_frac = 0.05;
      c.sizing.kelly_block_negative = true;
      c.sizing.min_position_sol = 0.15;
      c.sizing.max_positions = 3;
      c.sizing.score_mult_low = 0.7;
      c.sizing.score_mult_mid = 1;
      c.sizing.score_mult_high = 1.2;
    });
  });
  afterEach(() => {
    resetTestDb();
    restoreConfig();
  });

  it("cold-starts below min samples", () => {
    for (let i = 0; i < 3; i++)
      insertClosedPosition({ entrySol: 0.3, exitSol: 0.35, openCostSol: 0.3, closeReturnSol: 0.35 });
    const k = kellyStats();
    expect(k.regime).toBe("cold_start");
    expect(k.appliedFraction).toBe(0.02);
  });

  it("blocks on negative edge when armed", () => {
    for (let i = 0; i < 6; i++)
      insertClosedPosition({
        entrySol: 0.3,
        exitSol: 0.2,
        openCostSol: 0.3,
        closeReturnSol: 0.2,
        exitTs: now() - i,
      });
    const k = kellyStats();
    expect(k.regime).toBe("negative_edge");
    const br = computeBankroll(20);
    expect(positionSize(br, 80)).toBe(0);
  });

  it("applies score multipliers once Kelly is warm", () => {
    // Mix of wins so fullKelly > 0
    for (let i = 0; i < 8; i++) {
      const win = i % 3 !== 0;
      insertClosedPosition({
        entrySol: 0.3,
        exitSol: win ? 0.4 : 0.25,
        openCostSol: 0.3,
        closeReturnSol: win ? 0.4 : 0.25,
        exitTs: now() - i,
      });
    }
    expect(kellyStats().regime).toBe("kelly");
    const br = computeBankroll(20);
    expect(positionSize(br, 50)).toBe(0); // below score floor
    expect(positionSize(br, 75)).toBeGreaterThan(0);
  });
});
