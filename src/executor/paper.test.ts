import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PaperExecutor } from "./paper.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb, insertOpenPosition } from "../test/db.js";
import { SOL_MINT } from "../config.js";
import { now } from "../db/db.js";

function fixturePoolJson(overrides: Record<string, unknown> = {}) {
  return {
    address: "pool1",
    name: "TST-SOL",
    token_x: {
      address: "mint1", symbol: "TST", decimals: 6, holders: 500,
      freeze_authority_disabled: true, price: 0.001, market_cap: 200_000,
    },
    token_y: { address: SOL_MINT, symbol: "SOL" },
    created_at: Date.now() - 86_400_000,
    pool_config: { bin_step: 100, base_fee_pct: 1, collect_fee_mode: 1 },
    dynamic_fee_pct: 0.1,
    tvl: 50_000,
    current_price: 0.001,
    volume: { "30m": 80_000, "1h": 150_000, "24h": 1_000_000 },
    fees: {},
    fee_tvl_ratio: { "30m": 0.5, "1h": 0.5, "4h": 0.5, "24h": 30 },
    is_blacklisted: false,
    launchpad: "pump",
    ...overrides,
  };
}

describe("PaperExecutor.mark (HTTP fixture)", () => {
  beforeEach(() => {
    useMemoryDb();
    installConfig();
  });
  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.unstubAllGlobals();
  });

  it("marks in-range from datapi fixture without live network", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => fixturePoolJson({ current_price: 0.001 }),
    })));
    const exec = new PaperExecutor();
    // Bins around price 0.001 at step 100 / 6 decimals
    const { priceToBinId } = await import("../ranges/planner.js");
    const top = priceToBinId(0.001, 100, 6);
    const id = insertOpenPosition({
      entrySol: 0.3, entryPrice: 0.001, minBinId: top - 40, maxBinId: top, entryTs: now() - 120,
    });
    const mark = await exec.mark({
      id, mode: "paper", poolAddress: "pool1", tokenMint: "mint1", symbol: "TST",
      trancheOf: null, entryTs: now() - 120, entryPrice: 0.001, entrySol: 0.3,
      minBinId: top - 40, maxBinId: top, state: "open", feesClaimedSol: 0, rentPaidSol: 0,
      profitLockFires: 0, exitTs: null, exitSol: null, exitReason: null,
    });
    expect(mark.tvlUsd).toBe(50_000);
    expect(mark.inRange || mark.aboveRange || mark.belowRange).toBe(true);
    expect(mark.valueSol).toBeGreaterThan(0);
  });

  it("returns dead mark when pool TVL is below threshold", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => fixturePoolJson({ tvl: 50 }),
    })));
    const exec = new PaperExecutor();
    const id = insertOpenPosition();
    const mark = await exec.mark({
      id, mode: "paper", poolAddress: "pool1", tokenMint: "mint1", symbol: "TST",
      trancheOf: null, entryTs: now(), entryPrice: 1, entrySol: 0.3,
      minBinId: 1, maxBinId: 10, state: "open", feesClaimedSol: 0, rentPaidSol: 0,
      profitLockFires: 0, exitTs: null, exitSol: null, exitReason: null,
    });
    expect(mark.valueSol).toBe(0);
    expect(mark.tvlUsd).toBe(0);
  });
});

describe("sweepPools / fetchPool fixtures", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("normalize path via fetchPool", async () => {
    installConfig();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => fixturePoolJson({ address: "abc", current_price: 0.002 }),
    })));
    const { fetchPool } = await import("../scanner/meteora.js");
    const p = await fetchPool("abc");
    expect(p?.price).toBe(0.002);
    expect(p?.extras.freezeAuthorityDisabled).toBe(true);
    restoreConfig();
  });
});
