import { describe, it, expect } from "vitest";
import { creatorRugCount, insiderNetworkPct, type RugcheckReport } from "./rugcheck.js";

function report(partial: Partial<RugcheckReport>): RugcheckReport {
  return {
    score: 0,
    score_normalised: 10,
    risks: [],
    creator: "Cr111",
    creatorTokens: null,
    rugged: false,
    graphInsidersDetected: 0,
    insiderNetworks: null,
    totalHolders: 100,
    totalLPProviders: 10,
    totalMarketLiquidity: 1e6,
    launchpad: null,
    topHolders: null,
    markets: null,
    detectedAt: null,
    ...partial,
  };
}

describe("rugcheck parsers", () => {
  it("creatorRugCount scales from risk score", () => {
    expect(creatorRugCount(report({ risks: [] }))).toBe(0);
    expect(creatorRugCount(report({
      risks: [{ name: "Creator history of rugged tokens", value: "2", description: "", score: 14400, level: "danger" }],
    }))).toBe(2);
  });

  it("insiderNetworkPct sums network token amounts", () => {
    const r = report({
      insiderNetworks: [
        { id: "a", type: "transfer", size: 2, tokenAmount: 100 },
        { id: "b", type: "trade", size: 3, tokenAmount: 50 },
      ],
    });
    expect(insiderNetworkPct(r, 1000)).toBeCloseTo(15, 5);
    expect(insiderNetworkPct(r, null)).toBe(0);
    expect(insiderNetworkPct(report({ insiderNetworks: null }), 1000)).toBeNull();
  });
});
