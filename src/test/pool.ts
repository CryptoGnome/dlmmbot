import type { PoolInfo } from "../types.js";
import type { RawPoolExtras } from "../scanner/meteora.js";
import { SOL_MINT } from "../config.js";

export function makePool(overrides: Partial<PoolInfo & { extras: RawPoolExtras }> = {}): PoolInfo & { extras: RawPoolExtras } {
  const extras = overrides.extras ?? {
    holders: 1000,
    marketCapUsd: 250_000,
    freezeAuthorityDisabled: true,
    launchpad: "pump",
    collectFeeMode: 1,
  };
  return {
    address: "Pool1111111111111111111111111111111111111",
    name: "TST-SOL",
    mintX: "Tok1111111111111111111111111111111111111",
    mintY: SOL_MINT,
    binStep: 100,
    baseFeePct: 1,
    dynamicFeePct: 0.1,
    tvlUsd: 50_000,
    price: 0.001,
    decimalsX: 6,
    marketCapUsd: 250_000,
    vol30mUsd: 80_000,
    vol1hUsd: 150_000,
    vol24hUsd: 2_000_000,
    feeTvl30mPct: 1.0,
    feeTvl1hPct: 1.0,
    feeTvl4hPct: 1.0,
    feeTvl24hPct: 40,
    feesBothTokens: false,
    createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    ...overrides,
    extras: { ...extras, ...(overrides.extras ?? {}) },
  };
}
