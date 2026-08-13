import { describe, it, expect } from "vitest";
import { resolveTokenCreatedAtMs } from "./vet.js";

describe("resolveTokenCreatedAtMs", () => {
  const poolMs = Date.parse("2026-08-13T22:00:00.000Z");
  const mintIso = "2026-08-12T01:06:13.518Z";
  const mintMs = Date.parse(mintIso);

  it("prefers RugCheck detectedAt over pool createdAt", () => {
    expect(resolveTokenCreatedAtMs(mintIso, poolMs)).toBe(mintMs);
  });

  it("falls back to pool createdAt when RugCheck has no detectedAt", () => {
    expect(resolveTokenCreatedAtMs(null, poolMs)).toBe(poolMs);
    expect(resolveTokenCreatedAtMs(undefined, poolMs)).toBe(poolMs);
    expect(resolveTokenCreatedAtMs("", poolMs)).toBe(poolMs);
  });

  it("returns null when neither source is usable", () => {
    expect(resolveTokenCreatedAtMs(null, null)).toBeNull();
    expect(resolveTokenCreatedAtMs("not-a-date", 0)).toBeNull();
    expect(resolveTokenCreatedAtMs(null, Number.NaN)).toBeNull();
  });
});
