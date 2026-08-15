import { describe, it, expect, beforeEach } from "vitest";
import { parseGeckoTerminal, _resetCandleCacheForTests } from "./candles.js";

/**
 * The datapi caps ohlcv at 10 bars on every timeframe (verified 2026-08-15),
 * which starved RSI(14), the meme "last hour" windows and the planner's "24h
 * swing" without ever erroring. GeckoTerminal is the deep source; these pin
 * the two things that would corrupt every indicator if wrong: column order
 * and sort order.
 */
describe("parseGeckoTerminal", () => {
  beforeEach(() => _resetCandleCacheForTests());

  const body = (rows: number[][]) => ({ data: { attributes: { ohlcv_list: rows } } });

  it("maps [ts, open, high, low, close, volume] — standard OHLCV, not o,h,c,l", () => {
    // A live ANSEM bar. high (col 2) >= open/close, low (col 3) <= open/close.
    const [c] = parseGeckoTerminal(body([[1786834800, 0.25872, 0.25916, 0.25357, 0.25375, 26839]]));
    expect(c).toEqual({ timestamp: 1786834800, open: 0.25872, high: 0.25916, low: 0.25357, close: 0.25375, volume: 26839 });
    expect(c!.high).toBeGreaterThanOrEqual(Math.max(c!.open, c!.close));
    expect(c!.low).toBeLessThanOrEqual(Math.min(c!.open, c!.close));
  });

  it("returns oldest → newest so slice(-N) means 'most recent N'", () => {
    // GeckoTerminal ships newest-first; every consumer assumes the opposite.
    const out = parseGeckoTerminal(body([
      [300, 1, 1, 1, 1, 0], [200, 1, 1, 1, 1, 0], [100, 1, 1, 1, 1, 0],
    ]));
    expect(out.map((c) => c.timestamp)).toEqual([100, 200, 300]);
  });

  it("drops malformed bars instead of feeding an indicator an impossible one", () => {
    const out = parseGeckoTerminal(body([
      [100, 1.0, 0.9, 1.1, 1.0, 5],   // high < open, low > open — impossible
      [200, 1.0, 1.2, 0.8, 1.1, 5],   // valid
      [300, "x", 1, 1, 1, 5] as unknown as number[], // non-numeric
      [400, 1, 1, 1] as number[],     // short row
    ]));
    expect(out.map((c) => c.timestamp)).toEqual([200]);
  });

  it("returns [] on any unexpected shape", () => {
    expect(parseGeckoTerminal(null)).toEqual([]);
    expect(parseGeckoTerminal({})).toEqual([]);
    expect(parseGeckoTerminal({ data: { attributes: {} } })).toEqual([]);
  });
});
