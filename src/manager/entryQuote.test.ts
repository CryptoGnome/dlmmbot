import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The entry pipeline reaches out to five services before it plans a range.
// None of them is what these tests are about — the guard between the scan's
// quote and the open is.
vi.mock("../scanner/scan.js", () => ({ scan: vi.fn(async () => ({ candidates: [], rejected: [], sweptPools: 0 })) }));
vi.mock("../scanner/meteora.js", () => ({ fetchPool: vi.fn(async () => null) }));
vi.mock("../scanner/candles.js", () => ({ fetchCandlesDeep: vi.fn(async () => []) }));
vi.mock("../scanner/gmgn.js", () => ({ trendingByMint: vi.fn(async () => new Map()) }));
vi.mock("../market.js", () => ({
  sol24hChangePct: vi.fn(async () => 0),
  solUsdPrice: vi.fn(async () => 200),
}));
vi.mock("../vetting/vet.js", () => ({
  vetToken: vi.fn(async () => ({ verdict: "pass", softScore: 80, hardFailures: [], soft: {} })),
}));
// Bin-array rent is an on-chain read; let the planned range through untouched.
vi.mock("../ranges/binRent.js", () => ({
  applyBinRentGate: vi.fn(async (a: { range: unknown }) => ({
    ok: true,
    range: a.range,
    meta: { est: 0, actual: 0, tier: "normal", budget: 0, shrunk: false },
  })),
}));

import { scan } from "../scanner/scan.js";
import { fetchPool } from "../scanner/meteora.js";
import { enterNewPositions, DEFAULT_MAX_QUOTE_DRIFT_BINS } from "./loop.js";
import { FakeExecutor } from "../test/fakeExecutor.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb } from "../test/db.js";
import { getDb } from "../db/db.js";
import { makePool } from "../test/pool.js";
import type { Candidate } from "../types.js";

/**
 * CatGPT, 2026-08-21. One pool at 100 bps (1% per bin): the scan quoted
 * 3.6176e-6 and by the time the bot opened, the pool was at 3.7645e-6 — four
 * bins up. The range top is planted at the quote, and every upside exit is
 * measured from the range top, so those four bins put P3's sustain and the
 * escape hatch's recovery band out of reach and left only the stop.
 */
const QUOTED = 3.6176e-6;
const DRIFTED = 3.7645e-6;   // +4.0 bins
const NUDGED = 3.6538e-6;    // +1.0 bin

function candidate(price = QUOTED): Candidate {
  const pool = makePool({ address: "CatPool11111111111111111111111111111111", binStep: 100, price });
  return { pool, tokenMint: pool.mintX, symbol: "CatGPT", score: 80, scoreParts: {}, gateFailures: [] };
}

const skips = () =>
  (getDb().prepare("SELECT failed_gate, features_json FROM decisions WHERE action='skipped'").all() as
    Array<{ failed_gate: string; features_json: string }>);

describe("stale quote guard", () => {
  let exec: FakeExecutor;

  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.sizing.kelly_enabled = false;
      c.sizing.max_positions = 5;
      c.entry.tranche_enabled = false;
      c.follow.enabled = false;
      c.majors.enabled = false;
    });
    exec = new FakeExecutor("paper");
    vi.mocked(scan).mockResolvedValue({ candidates: [candidate()], rejected: [], sweptPools: 1 });
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.clearAllMocks();
  });

  it("skips rather than chasing when the pool has run since the scan", async () => {
    vi.mocked(fetchPool).mockResolvedValue({ ...candidate(DRIFTED).pool, extras: {} } as never);

    await enterNewPositions(exec);

    expect(exec.opens).toHaveLength(0);
    const stale = skips().filter((s) => s.failed_gate === "quote_stale");
    expect(stale).toHaveLength(1);
    const f = JSON.parse(stale[0]!.features_json);
    expect(f.driftBins).toBeCloseTo(4.0, 1);
    expect(f.quotedPrice).toBe(QUOTED);
    expect(f.freshPrice).toBe(DRIFTED);
  });

  it("plans off the fresh quote, not the scan's, when the drift is tolerable", async () => {
    vi.mocked(fetchPool).mockResolvedValue({ ...candidate(NUDGED).pool, extras: {} } as never);

    await enterNewPositions(exec);

    expect(skips().map((s) => s.failed_gate)).not.toContain("quote_stale");
    expect(exec.opens).toHaveLength(1);
    expect(exec.opens[0]!.entryPrice).toBe(NUDGED); // the fresh price, not QUOTED
  });

  it("falls through on the scan quote when the re-quote fails", async () => {
    // A datapi hiccup must not cost every entry — the old behaviour is the
    // fallback, not a skip.
    vi.mocked(fetchPool).mockRejectedValue(new Error("HTTP 503"));

    await enterNewPositions(exec);

    expect(skips().map((s) => s.failed_gate)).not.toContain("quote_stale");
    expect(exec.opens).toHaveLength(1);
    expect(exec.opens[0]!.entryPrice).toBe(QUOTED);
  });

  it("honours the configured tolerance, and 0 disables the guard", async () => {
    vi.mocked(fetchPool).mockResolvedValue({ ...candidate(DRIFTED).pool, extras: {} } as never);
    installConfig((c) => { c.entry.max_quote_drift_bins = 5; }); // 4 bins now inside
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(1);
    expect(exec.opens[0]!.entryPrice).toBe(DRIFTED);

    resetTestDb();
    useMemoryDb();
    exec = new FakeExecutor("paper");
    installConfig((c) => { c.entry.max_quote_drift_bins = 0; }); // guard off entirely
    await enterNewPositions(exec);
    expect(vi.mocked(fetchPool)).toHaveBeenCalledTimes(1); // not re-quoted at all
    expect(exec.opens[0]!.entryPrice).toBe(QUOTED);
  });

  it("defaults to a 3-bin tolerance when the config predates the key", () => {
    expect(DEFAULT_MAX_QUOTE_DRIFT_BINS).toBe(3);
  });
});
