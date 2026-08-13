import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../scanner/meteora.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scanner/meteora.js")>();
  return { ...actual, fetchPool: vi.fn() };
});
vi.mock("../vetting/vet.js", () => ({
  vetToken: vi.fn(async () => ({
    mint: "mint",
    verdict: "pass",
    hardFailures: [],
    softScore: 80,
    facts: {},
  })),
}));
vi.mock("../market.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../market.js")>();
  return { ...actual, sol24hChangePct: vi.fn(async () => 0) };
});

import { fetchPool } from "../scanner/meteora.js";
import { armFollowChain, tickFollowChains, onFollowLegClosed, hasActiveFollowChain } from "./follow.js";
import { FakeExecutor } from "../test/fakeExecutor.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb, insertOpenPosition } from "../test/db.js";
import { getDb, now } from "../db/db.js";
import { makePool } from "../test/pool.js";
import type { Position } from "../types.js";

function loadChain() {
  return getDb().prepare("SELECT * FROM follow_chains ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;
}

describe("follow state machine", () => {
  let exec: FakeExecutor;

  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.follow.enabled = true;
      c.follow.min_vol_30m_usd = 100_000;
      c.follow.retrace_arm_pct = 10;
      c.follow.range_depth_pct = 30;
      c.follow.leg_size_sol = 0.2;
      c.follow.max_legs = 3;
      c.follow.chain_loss_budget_sol = 0.15;
      c.follow.cold_polls_end = 3;
      c.follow.open_fail_cooldown_s = 300;
      c.gates.vol_30m_min_usd = 25_000;
      c.gates.fee_tvl_24h_min_pct = 20;
      c.sizing.min_reentry_sol = 0.1;
      c.sizing.kelly_enabled = false;
    });
    exec = new FakeExecutor("paper");
    vi.mocked(fetchPool).mockReset();
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
  });

  it("arms awaiting_dip after P3 and opens only after retrace", async () => {
    const id = insertOpenPosition({ entrySol: 0.3, entryPrice: 1 });
    const pos = {
      id, mode: "paper" as const, poolAddress: "pool1", tokenMint: "mint1",
      symbol: "TST", trancheOf: null, entryTs: now(), entryPrice: 1, entrySol: 0.3,
      minBinId: 1, maxBinId: 10, state: "open" as const, feesClaimedSol: 0, rentPaidSol: 0,
      profitLockFires: 0, exitTs: null, exitSol: null, exitReason: null,
    };
    armFollowChain(pos, 1.0);
    expect(hasActiveFollowChain("mint1", "paper")).toBe(true);
    expect(loadChain().state).toBe("awaiting_dip");

    // Still at peak — no open
    vi.mocked(fetchPool).mockResolvedValue(makePool({
      address: "pool1", price: 1.0, vol30mUsd: 200_000,
      feeTvl30mPct: 1, feeTvl1hPct: 1, binStep: 100, decimalsX: 6,
    }));
    await tickFollowChains(exec);
    expect(exec.opens).toHaveLength(0);

    // 10% dip + heat → open
    vi.mocked(fetchPool).mockResolvedValue(makePool({
      address: "pool1", price: 0.89, vol30mUsd: 200_000,
      feeTvl30mPct: 1, feeTvl1hPct: 1, binStep: 100, decimalsX: 6,
    }));
    await tickFollowChains(exec);
    expect(exec.opens).toHaveLength(1);
    expect(loadChain().state).toBe("leg_open");
  });

  it("ends on volume_died after cold streak", async () => {
    const id = insertOpenPosition({ entrySol: 0.3, entryPrice: 1 });
    armFollowChain({
      id, mode: "paper", poolAddress: "pool1", tokenMint: "mint1", symbol: "TST",
      trancheOf: null, entryTs: now(), entryPrice: 1, entrySol: 0.3, minBinId: 1, maxBinId: 10,
      state: "open", feesClaimedSol: 0, rentPaidSol: 0, profitLockFires: 0,
      exitTs: null, exitSol: null, exitReason: null,
    }, 1);
    vi.mocked(fetchPool).mockResolvedValue(makePool({
      address: "pool1", price: 1, vol30mUsd: 1000, // below gates.vol_30m_min
    }));
    await tickFollowChains(exec);
    await tickFollowChains(exec);
    await tickFollowChains(exec);
    const chain = loadChain();
    expect(chain.state).toBe("done");
    expect(chain.end_reason).toBe("volume_died");
  });

  it("open-fail sets cooldown and does not spam opens", async () => {
    const id = insertOpenPosition({ entrySol: 0.3, entryPrice: 1 });
    armFollowChain({
      id, mode: "paper", poolAddress: "pool1", tokenMint: "mint1", symbol: "TST",
      trancheOf: null, entryTs: now(), entryPrice: 1, entrySol: 0.3, minBinId: 1, maxBinId: 10,
      state: "open", feesClaimedSol: 0, rentPaidSol: 0, profitLockFires: 0,
      exitTs: null, exitSol: null, exitReason: null,
    }, 1);
    exec.openError = Object.assign(new Error("ExceededBinSlippageTolerance — sim"), {
      code: "ExceededBinSlippageTolerance",
    });
    vi.mocked(fetchPool).mockResolvedValue(makePool({
      address: "pool1", price: 0.85, vol30mUsd: 200_000,
      feeTvl30mPct: 1, feeTvl1hPct: 1, binStep: 100, decimalsX: 6,
    }));
    await tickFollowChains(exec);
    await tickFollowChains(exec);
    expect(exec.opens).toHaveLength(1); // only one attempt before cooldown
  });

  it("non-P3 leg close ends the chain", () => {
    const id = insertOpenPosition({ entrySol: 0.3, entryPrice: 1 });
    armFollowChain({
      id, mode: "paper", poolAddress: "pool1", tokenMint: "mint1", symbol: "TST",
      trancheOf: null, entryTs: now(), entryPrice: 1, entrySol: 0.3, minBinId: 1, maxBinId: 10,
      state: "open", feesClaimedSol: 0, rentPaidSol: 0, profitLockFires: 0,
      exitTs: null, exitSol: null, exitReason: null,
    }, 1);
    const chainId = loadChain().id as number;
    getDb().prepare("UPDATE follow_chains SET state='leg_open', legs=1 WHERE id=?").run(chainId);
    const leg: Position = {
      id, mode: "paper", poolAddress: "pool1", tokenMint: "mint1", symbol: "TST",
      trancheOf: null, entryTs: now(), entryPrice: 1, entrySol: 0.3, minBinId: 1, maxBinId: 10,
      state: "open", feesClaimedSol: 0, rentPaidSol: 0, profitLockFires: 0,
      exitTs: null, exitSol: null, exitReason: null, followChainId: chainId,
    };
    onFollowLegClosed(leg, "P1_stop", -0.05);
    expect(loadChain().state).toBe("done");
    expect(loadChain().end_reason).toBe("leg_P1_stop");
  });
});
