import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SOL_MINT } from "../config.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { _resetPriceGateForTests, divergencePct, jupPriceInSol, priceDivergenceGate } from "./priceGate.js";

const MINT = "Tok1111111111111111111111111111111111111";

describe("priceDivergenceGate", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    installConfig((c) => { c.gates.price_divergence_max_pct = 2.0; });
    _resetPriceGateForTests();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreConfig();
  });

  const priceResponse = (tokenUsd: number | null, solUsd = 200) => ({
    ok: true,
    status: 200,
    json: async () => ({
      ...(tokenUsd !== null ? { [MINT]: { usdPrice: tokenUsd } } : {}),
      [SOL_MINT]: { usdPrice: solUsd },
    }),
  });

  it("divergencePct is relative to the Jupiter quote", () => {
    expect(divergencePct(1.02, 1.0)).toBeCloseTo(2, 8);
    expect(divergencePct(0.7, 1.0)).toBeCloseTo(30, 8);
  });

  it("passes when pool price tracks the Jupiter quote", async () => {
    // token $0.20, SOL $200 -> 0.001 SOL; pool at 0.001005 = 0.5% off
    fetchMock.mockResolvedValue(priceResponse(0.2));
    expect(await priceDivergenceGate(MINT, 0.001005)).toBeNull();
  });

  it("hard-fails a pool 30% off the Jupiter quote", async () => {
    fetchMock.mockResolvedValue(priceResponse(0.2));
    const gate = await priceDivergenceGate(MINT, 0.0013);
    expect(gate?.gate).toBe("price_divergence");
  });

  it("fails CLOSED with a distinct gate when the quote is unavailable", async () => {
    fetchMock.mockResolvedValue(priceResponse(null)); // token not indexed by Jupiter
    const gate = await priceDivergenceGate(MINT, 0.001);
    expect(gate?.gate).toBe("price_divergence_unavailable");
  });

  it("fails CLOSED on fetch errors too", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const gate = await priceDivergenceGate(MINT, 0.001);
    expect(gate?.gate).toBe("price_divergence_unavailable");
  });

  it("parks all lookups during the 429 cooldown", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    expect(await jupPriceInSol(MINT)).toBeNull();
    expect(await jupPriceInSol("OtherMint111111111111111111111111111111")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches a quote within the TTL", async () => {
    fetchMock.mockResolvedValue(priceResponse(0.2));
    expect(await jupPriceInSol(MINT)).toBeCloseTo(0.001, 12);
    expect(await jupPriceInSol(MINT)).toBeCloseTo(0.001, 12);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
