import { describe, it, expect } from "vitest";
import { zapSlippageTiers } from "./zap.js";

describe("zapSlippageTiers", () => {
  it("escalates from base through 1500 bps", () => {
    expect(zapSlippageTiers(50)).toEqual([50, 300, 1500]);
    expect(zapSlippageTiers(500)).toEqual([500, 1500]);
    expect(zapSlippageTiers(1500)).toEqual([1500]);
  });
});
