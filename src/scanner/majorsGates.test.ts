import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { majorsPoolGates } from "../scanner/majorsGates.js";
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
    feesBothTokens: false, createdAt: null,
    extras: { holders: 1000, marketCapUsd: 1_000_000, freezeAuthorityDisabled: true, launchpad: "", collectFeeMode: 1 },
    ...over,
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
