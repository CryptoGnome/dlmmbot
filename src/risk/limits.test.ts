import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  regimeFactor, clusterBrakeTripped, circuitBreakerTripped, kellyStats, positionSize, computeBankroll,
  fixedSleeveSize, kellySleeveBase, sizingMode, minPositionSol, minReentrySol, reserveSol,
  flatCounterfactualSol,
} from "./limits.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb, insertClosedPosition } from "../test/db.js";
import { getDb, now, STRANDED_GRACE_S } from "../db/db.js";
import { config } from "../config.js";
import { majorsPositionSize } from "./majors.js";

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

  it("does not trip on an under-filled close whose tokens are still in the wallet", () => {
    // The 2026-08-17 incident, exactly: ANSEM pos#8 closed with 75% of the
    // position left unsold in the wallet, booked −0.5422, and paused all new
    // entries 52 seconds later. The sweep sold the residue for 0.5323 and the
    // real number was −0.0100 — the breaker had steered on a loss that never
    // happened. Sweep interval is 10 min, so the exposure window is that wide.
    insertClosedPosition({
      entrySol: 0.75,
      exitSol: 0.7144,
      openCostSol: 0.8669,
      closeReturnSol: 0.2955,
      feesMeasuredSol: 0.0292,
      strandedSol: 0.5327,
      exitTs: now() - 60,
    });
    expect(circuitBreakerTripped(9.9)).toBe(false); // −0.0095, not −0.5422
  });

  it("still trips once a strand outlives the grace window", () => {
    // Residue the sweep never sold: a real bag, a real loss, and the breaker
    // must see it. Without the expiry this fix would silently mute the breaker.
    insertClosedPosition({
      entrySol: 0.75,
      exitSol: 0.7144,
      openCostSol: 0.8669,
      closeReturnSol: 0.2955,
      feesMeasuredSol: 0.0292,
      strandedSol: 0.5327,
      strandedAgeS: STRANDED_GRACE_S + 60,
      exitTs: now() - 60,
    });
    expect(circuitBreakerTripped(9.9)).toBe(true); // −0.5422 vs 5% of 9.9
  });
});

describe("kellyStats + positionSize", () => {
  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.sizing.mode = "kelly";
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

describe("kelly per-sleeve sizing", () => {
  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.sizing.mode = "kelly";
      c.sizing.kelly_enabled = true;
      c.sizing.kelly_min_samples = 5;
      c.sizing.kelly_cold_start_frac = 0.05;
      c.sizing.kelly_max_position_frac = 0.5;
      c.sizing.kelly_block_negative = false;
      c.sizing.min_position_sol = 0.15;
      c.sizing.max_positions = 5;
      c.sizing.score_mult_mid = 1;
      c.sizing.reserve_sol = 0;
      c.sizing.reserve_pct = 0;
      c.sizing.kelly_core_unit = "kelly";
      c.sizing.kelly_core_mult = 1;
      c.sizing.kelly_majors_unit = "sol";
      c.sizing.kelly_majors_sol = 1;
      c.majors.max_position_sol = 3;
    });
  });
  afterEach(() => {
    resetTestDb();
    restoreConfig();
  });

  it("scales adaptive core by kelly_core_mult", () => {
    const br = computeBankroll(20);
    const base = kellySleeveBase("core", br.deployableSol, 1);
    expect(base).toBeCloseTo(1);
    installConfig((c) => { c.sizing.kelly_core_mult = 2; });
    expect(kellySleeveBase("core", br.deployableSol, 1)).toBeCloseTo(2);
    expect(positionSize(br, 75)).toBeCloseTo(2);
  });

  it("uses explicit SOL when kelly_core_unit=sol", () => {
    installConfig((c) => {
      c.sizing.kelly_core_unit = "sol";
      c.sizing.kelly_core_sol = 0.8;
    });
    const br = computeBankroll(20);
    expect(positionSize(br, 75)).toBeCloseTo(0.8);
  });

  it("majors uses kelly_majors_sol in kelly mode", () => {
    const br = computeBankroll(20);
    expect(majorsPositionSize(br.deployableSol, br.walletSol)).toBeCloseTo(1);
  });
});

// A flat 0.3 SOL floor meant "the bot silently does nothing" for small
// operators: reserve ate the whole bankroll, effectiveSlots went to 0, and the
// low score tier was unreachable below 20 SOL. These lock in that every
// bankroll gets a working, proportional configuration — and that books at or
// above 30 SOL keep exactly the sizing they had.
describe("bankroll-scaled floors", () => {
  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.sizing.mode = "kelly";
      c.sizing.kelly_enabled = true;
      c.sizing.kelly_min_samples = 50;
      c.sizing.kelly_cold_start_frac = 0.03;
      c.sizing.kelly_max_position_frac = 0.10;
      c.sizing.kelly_block_negative = false;
      c.sizing.kelly_core_unit = "kelly";
      c.sizing.kelly_core_mult = 1;
      c.sizing.min_position_sol = 0.3;
      c.sizing.min_position_pct = 1.0;
      c.sizing.min_position_floor_sol = 0.05;
      c.sizing.min_reentry_sol = 0.2;
      c.sizing.max_positions = 5;
      c.sizing.reserve_sol = 1.0;
      c.sizing.reserve_max_pct = 25;
      c.sizing.reserve_pct = 10;
      c.sizing.score_mult_low = 0.5;
      c.sizing.score_mult_mid = 1.0;
      c.sizing.score_mult_high = 1.5;
    });
  });
  afterEach(() => {
    resetTestDb();
    restoreConfig();
  });

  it("scales the floor with equity and never below the hard floor", () => {
    expect(minPositionSol(1)).toBeCloseTo(0.05);   // hard floor, not 1% = 0.01
    expect(minPositionSol(10)).toBeCloseTo(0.10);
    expect(minPositionSol(20)).toBeCloseTo(0.20);
    expect(minPositionSol(30)).toBeCloseTo(0.30);  // target binds
    expect(minPositionSol(100)).toBeCloseTo(0.30); // and never exceeds it
  });

  it("keeps the floor at the operator's target when they set one below the hard floor", () => {
    installConfig((c) => { c.sizing.min_position_sol = 0.02; });
    expect(minPositionSol(100)).toBeCloseTo(0.02);
  });

  it("min_position_pct = 0 restores the flat floor", () => {
    installConfig((c) => { c.sizing.min_position_pct = 0; });
    expect(minPositionSol(1)).toBeCloseTo(0.3);
    expect(minPositionSol(50)).toBeCloseTo(0.3);
  });

  it("re-entry floor tracks the entry floor and never exceeds it", () => {
    expect(minReentrySol(30)).toBeCloseTo(0.2);  // min_reentry_sol binds
    expect(minReentrySol(2)).toBeCloseTo(0.05);  // scaled floor binds
  });

  it("caps the flat reserve so a small wallet still has a bankroll", () => {
    expect(reserveSol(1)).toBeCloseTo(0.35);   // 0.25 capped flat + 0.10 pct
    expect(reserveSol(10)).toBeCloseTo(2.0);   // unchanged: 1.0 + 1.0
    expect(reserveSol(30)).toBeCloseTo(4.0);   // unchanged: 1.0 + 3.0
  });

  it("a 1 SOL wallet gets deployable capital and real slots", () => {
    const br = computeBankroll(1);
    expect(br.deployableSol).toBeCloseTo(0.65);
    expect(br.effectiveSlots).toBe(5);
    expect(positionSize(br, 75)).toBeGreaterThan(0);
  });

  it("sizes a small wallet proportionally instead of blowing past the wallet cap", () => {
    const br = computeBankroll(2);
    const size = positionSize(br, 75);
    // Old behaviour floored the Kelly base at 0.3 and raised the cap to match:
    // 15% of a 2 SOL wallet. The 10% cap must actually bind now.
    expect(size).toBeLessThanOrEqual(2 * 0.10 + 1e-9);
    expect(size).toBeGreaterThan(0);
  });

  it("makes the 60-70 score tier reachable below 20 SOL", () => {
    // Half of a base pinned to a flat floor is always under that floor — the
    // low tier was dead at every bankroll under 20 SOL.
    expect(positionSize(computeBankroll(10), 65)).toBeCloseTo(0.15);
    expect(positionSize(computeBankroll(5), 65)).toBeCloseTo(0.075);
  });

  it("leaves a 30 SOL book on exactly its previous sizing", () => {
    const br = computeBankroll(30);
    expect(br.deployableSol).toBeCloseTo(26);        // 30 - (1.0 + 3.0)
    expect(positionSize(br, 75)).toBeCloseTo(0.9);   // 3% cold-start
    expect(positionSize(br, 90)).toBeCloseTo(1.35);
    expect(positionSize(br, 65)).toBeCloseTo(0.45);
  });

  // The live Railway/PM2 installs copied config.toml once, before these keys
  // existed — data/config.toml is never re-seeded. That volume config is the
  // configuration the fix has to work under, so it gets its own test rather
  // than trusting that `?? DEFAULT` reads right.
  it("scales for an install whose config predates the new keys", () => {
    installConfig((c) => {
      delete c.sizing.min_position_pct;
      delete c.sizing.min_position_floor_sol;
      delete c.sizing.reserve_max_pct;
    });
    // Guard the guard: the numbers below match the shipped config.toml, so
    // without this the test would still pass if the delete silently no-op'd
    // and we were reading the keys rather than the code fallbacks.
    expect(config().sizing.min_position_pct).toBeUndefined();
    expect(config().sizing.min_position_floor_sol).toBeUndefined();
    expect(config().sizing.reserve_max_pct).toBeUndefined();
    expect(minPositionSol(1)).toBeCloseTo(0.05);
    expect(minPositionSol(10)).toBeCloseTo(0.10);
    expect(minPositionSol(30)).toBeCloseTo(0.30);
    expect(reserveSol(1)).toBeCloseTo(0.35);
    expect(reserveSol(10)).toBeCloseTo(2.0);
    const br = computeBankroll(10);
    expect(br.effectiveSlots).toBe(5);
    expect(positionSize(br, 65)).toBeCloseTo(0.15);
    expect(positionSize(br, 75)).toBeCloseTo(0.30);
  });

  it("still refuses a position under the hard economic floor", () => {
    installConfig((c) => { c.sizing.kelly_cold_start_frac = 0.001; });
    expect(positionSize(computeBankroll(1), 65)).toBe(0);
  });
});

describe("fixed sizing mode", () => {
  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.sizing.mode = "fixed";
      c.sizing.kelly_enabled = false;
      c.sizing.min_position_sol = 0.3;
      c.sizing.max_positions = 5;
      c.sizing.kelly_max_position_frac = 0.5;
      c.sizing.reserve_sol = 0;
      c.sizing.reserve_pct = 0;
      c.sizing.fixed_core_unit = "sol";
      c.sizing.fixed_core_sol = 0.5;
      c.sizing.fixed_core_pct = 10;
      c.sizing.fixed_micro_unit = "pct";
      c.sizing.fixed_micro_sol = 0.3;
      c.sizing.fixed_micro_pct = 5;
      c.sizing.fixed_majors_unit = "sol";
      c.sizing.fixed_majors_sol = 2;
      c.sizing.fixed_majors_pct = 10;
      c.sizing.score_mult_low = 0.5;
      c.sizing.score_mult_mid = 1;
      c.sizing.score_mult_high = 1.5;
      c.majors.size_sol = 0.75;
      c.majors.max_position_sol = 3;
    });
  });
  afterEach(() => {
    resetTestDb();
    restoreConfig();
  });

  it("reports fixed mode", () => {
    expect(sizingMode()).toBe("fixed");
  });

  it("uses exact SOL for core without score tilt", () => {
    const br = computeBankroll(20);
    expect(positionSize(br, 50)).toBe(0);
    expect(positionSize(br, 75)).toBeCloseTo(0.5);
    expect(positionSize(br, 90)).toBeCloseTo(0.5);
  });

  it("uses % of deployable for micro sleeve", () => {
    const br = computeBankroll(20);
    // deployable ≈ 20 with reserve 0
    expect(fixedSleeveSize("micro", br.deployableSol, br.walletSol)).toBeCloseTo(1);
    expect(positionSize(br, 80, "micro")).toBeCloseTo(1);
  });

  it("skips when fixed SOL is below min_position_sol", () => {
    installConfig((c) => {
      c.sizing.mode = "fixed";
      c.sizing.min_position_sol = 0.3;
      c.sizing.fixed_core_unit = "sol";
      c.sizing.fixed_core_sol = 0.1;
      c.sizing.kelly_max_position_frac = 0.5;
      c.sizing.reserve_sol = 0;
      c.sizing.reserve_pct = 0;
    });
    const br = computeBankroll(20);
    expect(positionSize(br, 80)).toBe(0);
  });

  it("majors uses fixed sleeve size over majors.size_sol", () => {
    const br = computeBankroll(20);
    expect(majorsPositionSize(br.deployableSol, br.walletSol)).toBeCloseTo(2);
  });
});

// SIZING-MODE-DECISION.md Gate 3. `flatCounterfactualSol` duplicates
// `positionSize`'s clamp on purpose — sizing is too risk-critical to refactor
// for a telemetry function — so these tests exist to catch the drift that
// duplication invites.
describe("flatCounterfactualSol — Gate 3 telemetry", () => {
  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.sizing.mode = "kelly";
      c.sizing.kelly_enabled = true;
      c.sizing.kelly_min_samples = 5;
      c.sizing.kelly_cold_start_frac = 0.05;
      c.sizing.kelly_max_position_frac = 0.5;
      c.sizing.kelly_block_negative = false;
      c.sizing.min_position_sol = 0.15;
      c.sizing.min_position_pct = 0;
      c.sizing.max_positions = 5;
      c.sizing.score_mult_low = 0.5;
      c.sizing.score_mult_mid = 1;
      c.sizing.score_mult_high = 1.5;
      c.sizing.reserve_sol = 0;
      c.sizing.reserve_pct = 0;
      c.sizing.kelly_core_unit = "kelly";
      c.sizing.kelly_core_mult = 1;
    });
  });
  afterEach(() => {
    resetTestDb();
    restoreConfig();
  });

  // The pin the duplication comment promises: give the pct rule a base equal to
  // the Kelly base, and the two must agree to the lamport. If someone edits one
  // clamp and not the other, this is what fails.
  it("matches positionSize exactly when the two bases are equal", () => {
    const b = computeBankroll(10);
    installConfig((c) => {
      c.sizing.kelly_cold_start_frac = 0.05;          // kelly base = 10 * 0.05 = 0.5
      c.sizing.kelly_core_pct = (0.5 / b.deployableSol) * 100; // pct base = 0.5 too
    });
    for (const score of [65, 75, 90]) {
      expect(flatCounterfactualSol(b, score)).toBeCloseTo(positionSize(b, score), 9);
    }
  });

  it("is a pct of DEPLOYABLE, and so cannot exceed it — the property Kelly lacks", () => {
    const b = computeBankroll(10);
    installConfig((c) => { c.sizing.kelly_core_pct = 100; c.sizing.kelly_max_position_frac = 1; });
    // base = 100% of deployable, then the 1.5x score tilt on top: still clamped.
    expect(flatCounterfactualSol(b, 90)).toBeLessThanOrEqual(b.deployableSol);
  });

  it("does not move with the Kelly estimate — the whole point of the arm", () => {
    const b = computeBankroll(10);
    installConfig((c) => { c.sizing.kelly_core_pct = 5; });
    const before = flatCounterfactualSol(b, 75);
    // Bury the book in losses so f* collapses; the flat arm must not notice.
    for (let i = 0; i < 20; i++) insertClosedPosition({ entrySol: 1, exitSol: 0.5 });
    expect(kellyStats().appliedFraction).toBeLessThan(0.05);
    expect(flatCounterfactualSol(b, 75)).toBeCloseTo(before, 12);
  });

  it("returns 0 below the floor rather than silently bumping to it", () => {
    const b = computeBankroll(10);
    installConfig((c) => { c.sizing.kelly_core_pct = 0.01; }); // ~0.001 SOL, under the 0.15 floor
    expect(flatCounterfactualSol(b, 75)).toBe(0);
  });

  it("returns 0 for a sub-60 score, matching positionSize's admission gate", () => {
    const b = computeBankroll(10);
    installConfig((c) => { c.sizing.kelly_core_pct = 5; });
    expect(flatCounterfactualSol(b, 59)).toBe(0);
    expect(positionSize(b, 59)).toBe(0);
  });
});
