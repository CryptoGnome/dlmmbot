import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { majorsDiscoveryEligible, majorsPoolGates, majorsScore } from "../scanner/majorsGates.js";
import { pickBestMajorsPerSymbol, type MajorsCandidate } from "../scanner/majorsScan.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { SOL_MINT } from "../config.js";
import type { PoolInfo } from "../types.js";
import type { RawPoolExtras } from "../scanner/meteora.js";

function pool(over: Partial<PoolInfo & { extras: RawPoolExtras }>): PoolInfo & { extras: RawPoolExtras } {
  return {
    address: "p", name: "TST-SOL", mintX: "mint", mintY: SOL_MINT,
    binStep: 100, baseFeePct: 1, dynamicFeePct: 1, tvlUsd: 500_000, price: 1,
    decimalsX: 6, marketCapUsd: 1_000_000, vol30mUsd: 10_000, vol1hUsd: 20_000, vol24hUsd: 100_000,
    feeTvl30mPct: 0.01, feeTvl1hPct: 0.01, feeTvl4hPct: 0.01, feeTvl24hPct: 0.15,
    feesBothTokens: false, createdAt: new Date(Date.now() - 30 * 86400000).toISOString(),
    extras: { holders: 1000, marketCapUsd: 1_000_000, freezeAuthorityDisabled: true, launchpad: "", collectFeeMode: 1 },
    ...over,
  };
}

function cand(over: { symbol?: string; source?: MajorsCandidate["source"]; pool?: Partial<PoolInfo & { extras: RawPoolExtras }> }): MajorsCandidate {
  const p = pool(over.pool ?? {});
  return {
    pool: p,
    tokenMint: p.mintX,
    symbol: over.symbol ?? "TST",
    score: majorsScore(p),
    source: over.source ?? "discovery",
  };
}

describe("majorsPoolGates", () => {
  beforeEach(() => installConfig((c) => {
    c.majors.fee_tvl_24h_min_pct = 0.08;
    c.majors.fee_tvl_30m_daily_min_pct = 0.05;
    c.majors.tvl_min_usd = 100_000;
    c.majors.vol_30m_min_usd = 5000;
  }));
  afterEach(() => restoreConfig());

  it("passes a typical SOL-quoted major pool", () => {
    expect(majorsPoolGates(pool({}))).toEqual([]);
  });

  it("fails sub-threshold fee/TVL", () => {
    const fails = majorsPoolGates(pool({ feeTvl24hPct: 0.01, feeTvl30mPct: 0.001 }));
    expect(fails.some((f) => f.gate === "majors_fee_tvl_24h")).toBe(true);
  });

  it("rejects non-SOL quote", () => {
    const fails = majorsPoolGates(pool({ mintY: "USDCmint" }));
    expect(fails.some((f) => f.gate === "majors_quote")).toBe(true);
  });
});

describe("majorsDiscoveryEligible", () => {
  beforeEach(() => installConfig((c) => {
    c.majors.symbol_allowlist = ["PUMP", "ANSEM"];
    c.majors.mcap_min_usd = 0;
    c.majors.age_min_days = 7;
  }));
  afterEach(() => restoreConfig());

  it("admits allowlisted symbols with enough age", () => {
    expect(majorsDiscoveryEligible(pool({ name: "PUMP-SOL" }))).toBe(true);
  });

  it("rejects unknown symbols when mcap gate is off", () => {
    expect(majorsDiscoveryEligible(pool({ name: "RANDOM-SOL" }))).toBe(false);
  });

  it("admits by mcap when configured", () => {
    installConfig((c) => { c.majors.mcap_min_usd = 50_000_000; c.majors.symbol_allowlist = []; });
    expect(majorsDiscoveryEligible(pool({ name: "RANDOM-SOL", marketCapUsd: 60_000_000 }))).toBe(true);
  });
});

describe("pickBestMajorsPerSymbol", () => {
  it("keeps highest-scoring pool per symbol", () => {
    const out = pickBestMajorsPerSymbol([
      cand({ symbol: "PUMP", pool: { address: "a", feeTvl24hPct: 0.1, feeTvl30mPct: 0.01 } }),
      cand({ symbol: "PUMP", pool: { address: "b", feeTvl24hPct: 0.2, feeTvl30mPct: 0.02 } }),
      cand({ symbol: "ANSEM", pool: { address: "c", feeTvl24hPct: 0.15, feeTvl30mPct: 0.01 } }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((x) => x.symbol === "PUMP")!.pool.address).toBe("b");
  });
});

describe("majorsScore", () => {
  it("stays on the shared 0–100 scale", () => {
    const cold = majorsScore(pool({ feeTvl24hPct: 0.08, feeTvl30mPct: 0.05 / 48 }));
    const hot = majorsScore(pool({ feeTvl24hPct: 0.456, feeTvl30mPct: 0.003214 }));
    const maxed = majorsScore(pool({ feeTvl24hPct: 2, feeTvl30mPct: 0.1 }));
    expect(cold).toBeGreaterThanOrEqual(0);
    expect(cold).toBeLessThan(40);
    expect(hot).toBeGreaterThan(50);
    expect(hot).toBeLessThan(100);
    expect(maxed).toBe(100);
    // Ranking preserved vs the old raw fee blend
    expect(hot).toBeGreaterThan(cold);
  });
});