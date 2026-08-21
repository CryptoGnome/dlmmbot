import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
vi.mock("../ranges/binRent.js", () => ({
  applyBinRentGate: vi.fn(async (a: { range: unknown }) => ({
    ok: true, range: a.range,
    meta: { est: 0, actual: 0, tier: "normal", budget: 0, shrunk: false },
  })),
}));

import { scan } from "../scanner/scan.js";
import { fetchPool } from "../scanner/meteora.js";
import { fetchCandlesDeep } from "../scanner/candles.js";
import { enterNewPositions, TOP_BLAST_TELEMETRY_FRAC } from "./loop.js";
import { FakeExecutor } from "../test/fakeExecutor.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb } from "../test/db.js";
import { getDb } from "../db/db.js";
import { makePool } from "../test/pool.js";
import type { Candidate } from "../types.js";

/**
 * Swing high 1.0, low 0.5 — so entry/swingHigh is just the pool price.
 * swing() needs at least 6 bars, so pad with ones inside that range.
 */
const candles = () => [
  { timestamp: 1, open: 0.6, high: 1.0, low: 0.5, close: 0.9, volume: 1000 },
  ...Array.from({ length: 5 }, (_, i) => ({
    timestamp: i + 2, open: 0.9, high: 0.95, low: 0.55, close: 0.8, volume: 1000,
  })),
];

function candidate(price: number): Candidate {
  const pool = makePool({ address: "TopPool1111111111111111111111111111111", binStep: 100, price });
  return { pool, tokenMint: pool.mintX, symbol: "BLAST", score: 80, scoreParts: {}, gateFailures: [] };
}

const rows = (gate: string) =>
  getDb().prepare("SELECT features_json FROM decisions WHERE failed_gate = ?").all(gate) as Array<{ features_json: string }>;

describe("top-blast telemetry", () => {
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
    vi.mocked(fetchCandlesDeep).mockResolvedValue(candles());
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.clearAllMocks();
  });

  /** No drift, so the stale-quote guard passes and the entry proceeds. */
  const enterAt = async (price: number) => {
    vi.mocked(scan).mockResolvedValue({ candidates: [candidate(price)], rejected: [], sweptPools: 1 });
    vi.mocked(fetchPool).mockResolvedValue({ ...candidate(price).pool, extras: {} } as never);
    await enterNewPositions(exec);
  };

  it("flags an entry at the swing high — and still takes it", async () => {
    await enterAt(0.98); // 98% of the 1.0 swing high

    expect(exec.opens).toHaveLength(1); // telemetry only: nothing is skipped
    const flagged = rows("top_blast_candidate");
    expect(flagged).toHaveLength(1);
    const f = JSON.parse(flagged[0]!.features_json);
    expect(f.ofSwingHigh).toBeCloseTo(0.98, 3);
    expect(f.swingHigh).toBe(1.0);
    expect(f.threshold).toBe(TOP_BLAST_TELEMETRY_FRAC);
  });

  it("stays quiet when the entry is comfortably below the high", async () => {
    await enterAt(0.8);

    expect(exec.opens).toHaveLength(1);
    expect(rows("top_blast_candidate")).toHaveLength(0);
  });

  it("records the ratio flat on every entry, flagged or not", async () => {
    await enterAt(0.8);

    const entered = getDb().prepare("SELECT features_json FROM decisions WHERE action='entered'")
      .all() as Array<{ features_json: string }>;
    expect(entered).toHaveLength(1);
    // Derivable from range.fibAnchor before, but only via nested JSON + a join.
    expect(JSON.parse(entered[0]!.features_json).entryOfSwingHigh).toBeCloseTo(0.8, 3);
  });
});
