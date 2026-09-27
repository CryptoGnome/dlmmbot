import { describe, it, expect } from "vitest";
import { resolveTokenCreatedAt } from "./vet.js";
import { classifyYoung } from "../risk/entryRisk.js";

/**
 * Mint-age resolution (2026-09-27). Failure modes written before the change:
 *  A1 RugCheck missing, Jupiter has createdAt -> pool age used anyway (WORLD:
 *     minted 09-26 18:57, vetted as 51 min off a pool created 09-27 15:58)
 *  A2 RugCheck present -> no longer wins
 *  A3 both missing -> no pool fallback, or the fallback is not labelled "pool"
 *  A4 nothing usable -> anything but null
 *  A5 a malformed date at any level is used instead of skipped
 *  A6 the young check labels a pool-derived age "mint"
 */
describe("resolveTokenCreatedAt", () => {
  const worldMint = "2026-09-26T18:57:42Z";
  const worldPoolMs = Date.parse("2026-09-27T15:58:34Z");

  it("A1: RugCheck missing -> Jupiter createdAt, not the fresh DLMM pool", () => {
    expect(resolveTokenCreatedAt(null, worldMint, worldPoolMs))
      .toEqual({ ms: Date.parse(worldMint), source: "jupiter" });
  });

  it("A2: RugCheck detectedAt still wins", () => {
    const rug = "2026-09-26T18:57:43.456Z";
    expect(resolveTokenCreatedAt(rug, "2026-01-01T00:00:00Z", worldPoolMs))
      .toEqual({ ms: Date.parse(rug), source: "rugcheck" });
  });

  it("A3: both missing -> pool age, labelled pool", () => {
    expect(resolveTokenCreatedAt(undefined, null, worldPoolMs)).toEqual({ ms: worldPoolMs, source: "pool" });
    expect(resolveTokenCreatedAt("", "", worldPoolMs)).toEqual({ ms: worldPoolMs, source: "pool" });
  });

  it("A4: nothing usable -> null", () => {
    expect(resolveTokenCreatedAt(null, null, null)).toBeNull();
    expect(resolveTokenCreatedAt(null, null, Number.NaN)).toBeNull();
    expect(resolveTokenCreatedAt(null, null, 0)).toBeNull();
  });

  it("A5: malformed dates are skipped at every level", () => {
    expect(resolveTokenCreatedAt("not-a-date", "also-not", worldPoolMs)?.source).toBe("pool");
    expect(resolveTokenCreatedAt("not-a-date", worldMint, worldPoolMs)?.source).toBe("jupiter");
  });
});

describe("classifyYoung source label", () => {
  it("A6: an age vet took from the pool is labelled pool, a real mint age mint", () => {
    expect(classifyYoung(51, null, "pool").source).toBe("pool");
    expect(classifyYoung(1361, null, "jupiter").source).toBe("mint");
    expect(classifyYoung(1361, null, "rugcheck")).toMatchObject({ young: false, source: "mint" });
  });
});
