import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  _resetRugcheckStateForTests, creatorRugCount, fetchReport, insiderNetworkPct,
  type RugcheckReport,
} from "./rugcheck.js";

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

  it("creatorRugCount survives a report with risks missing entirely", () => {
    const r = report({});
    delete (r as Partial<RugcheckReport>).risks; // partial 200 shape drift
    expect(creatorRugCount(r)).toBe(0);
  });

  it("insiderNetworkPct sums network token amounts", () => {
    const r = report({
      insiderNetworks: [
        { id: "a", type: "transfer", size: 2, tokenAmount: 100 },
        { id: "b", type: "trade", size: 3, tokenAmount: 50 },
      ],
    });
    expect(insiderNetworkPct(r, 1000)).toBeCloseTo(15, 5);
  });

  it("insiderNetworkPct is null (not 0) when supply is unknown — fallback must run", () => {
    const r = report({
      insiderNetworks: [{ id: "a", type: "transfer", size: 2, tokenAmount: 100 }],
    });
    expect(insiderNetworkPct(r, null)).toBeNull();
    expect(insiderNetworkPct(r, 0)).toBeNull();
  });

  it("insiderNetworkPct: empty networks = affirmative 0; missing networks = null", () => {
    expect(insiderNetworkPct(report({ insiderNetworks: [] }), 1000)).toBe(0);
    expect(insiderNetworkPct(report({ insiderNetworks: null }), 1000)).toBeNull();
  });
});

describe("rugcheck fetch pacing", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    _resetRugcheckStateForTests();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  it("caches a successful report within the TTL", async () => {
    fetchMock.mockResolvedValue(ok(report({})));
    const a = await fetchReport("MintA");
    const b = await fetchReport("MintA");
    expect(a?.creator).toBe("Cr111");
    expect(b?.creator).toBe("Cr111");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parks all calls during the 429 cooldown", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    expect(await fetchReport("MintA")).toBeNull();
    expect(await fetchReport("MintB")).toBeNull(); // cooldown: no second request
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache non-OK responses (retries after the pacing gap)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    expect(await fetchReport("MintA")).toBeNull();
    fetchMock.mockResolvedValueOnce(ok(report({})));
    expect((await fetchReport("MintA"))?.creator).toBe("Cr111"); // real 1.5s pacing wait
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
