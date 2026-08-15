import { describe, it, expect } from "vitest";
import { pickBestPool, pickCopycatWinner } from "./scan.js";

describe("pickCopycatWinner (copycat cooldown, §1.2)", () => {
  const NOW = 1_000_000;
  const IGNORE_S = 24 * 3600;

  it("picks the highest-volume mint and cools down the losers", () => {
    const ignored = new Map<string, number>();
    const vols = new Map([["mintA", 50_000], ["mintB", 200_000], ["mintC", 10_000]]);
    expect(pickCopycatWinner(vols, ignored, NOW, IGNORE_S)).toBe("mintB");
    expect(ignored.get("mintA")).toBe(NOW + IGNORE_S);
    expect(ignored.get("mintC")).toBe(NOW + IGNORE_S);
    expect(ignored.has("mintB")).toBe(false);
  });

  it("keeps the previous winner even when a cooled loser flips ahead on volume", () => {
    const ignored = new Map<string, number>();
    pickCopycatWinner(new Map([["mintA", 50_000], ["mintB", 200_000]]), ignored, NOW, IGNORE_S);
    // Next sweep: mintA's volume spiked past mintB — but it lost within the
    // last 24h, so it stays ignored and mintB stays canonical.
    const later = NOW + 3600;
    expect(pickCopycatWinner(new Map([["mintA", 500_000], ["mintB", 200_000]]), ignored, later, IGNORE_S)).toBe("mintB");
    // After the cooldown expires it may compete (and win) again.
    const expired = NOW + IGNORE_S + 1;
    expect(pickCopycatWinner(new Map([["mintA", 500_000], ["mintB", 200_000]]), ignored, expired, IGNORE_S)).toBe("mintA");
  });

  it("returns null when every contender is cooling down", () => {
    const ignored = new Map([["mintA", NOW + 999], ["mintB", NOW + 999]]);
    expect(pickCopycatWinner(new Map([["mintA", 1], ["mintB", 2]]), ignored, NOW, IGNORE_S)).toBeNull();
  });

  it("never cools down a sole contender", () => {
    const ignored = new Map<string, number>();
    expect(pickCopycatWinner(new Map([["mintA", 1]]), ignored, NOW, IGNORE_S)).toBe("mintA");
    expect(ignored.size).toBe(0);
  });
});

/**
 * Which of a token's pools to trade. "Highest fee/TVL" is inversely
 * proportional to TVL and so structurally picks the THINNEST sibling — thin
 * pools earn less and their TVL jitters 40-50% on ordinary LP moves, which
 * P0 tvl_drain reads as a rug (2026-08-15, pos#5 GUNICORN).
 */
describe("pickBestPool (deepest gate-passing sibling)", () => {
  const pool = (tvlUsd: number, feeTvl24hPct: number, binStep = 100, ok = true) =>
    ({ tvlUsd, feeTvl24hPct, binStep, ok });
  const passes = (p: { ok: boolean }) => p.ok;

  it("takes the deepest same-bin-step sibling, not the highest fee/TVL", () => {
    // The GUNICORN shape: $8k pool at 64% fee/TVL vs $67k pool at 34%.
    const thin = pool(8_000, 64), deep = pool(67_000, 34);
    expect(pickBestPool([thin, deep], passes, 25)).toBe(deep);
  });

  it("the gates are the family boundary — a bin-20 pool loses because bin_step_new fails it", () => {
    // Deep bin-20 pool exists but the strategy needs wide bins. It is not an
    // alternative because the GATES reject it, so it is simply not eligible.
    const wideThin = pool(8_000, 64, 100), narrowDeep = pool(400_000, 5, 20, false);
    expect(pickBestPool([wideThin, narrowDeep], passes, 25)).toBe(wideThin);
  });

  it("does not split hairs between two bin steps the gates both accept", () => {
    // Real board 2026-08-15: a $6k bin-80 pool and a $60k bin-100 pool, both
    // passing (bin_step_min_new = 80). An earlier draft that demanded identical
    // bin steps picked the $6k one. Depth wins across accepted shapes.
    const bin80thin = pool(6_163, 91, 80), bin100deep = pool(59_724, 87, 100);
    expect(pickBestPool([bin80thin, bin100deep], passes, 25)).toBe(bin100deep);
  });

  it("ignores a high-fee pool that fails the gates when choosing", () => {
    const failing = pool(5_000, 99, 20, false);
    const a = pool(30_000, 20, 100), b = pool(90_000, 12, 100);
    expect(pickBestPool([failing, a, b], passes, 25)).toBe(b);
  });

  it("lets fee/TVL break a near-tie in depth", () => {
    // Within 25% of the deepest, the fee edge is real — take it.
    const deep = pool(100_000, 10), nearHot = pool(80_000, 30);
    expect(pickBestPool([deep, nearHot], passes, 25)).toBe(nearHot);
    // Just outside the band the depth rule reasserts.
    const farHot = pool(70_000, 30);
    expect(pickBestPool([deep, farHot], passes, 25)).toBe(deep);
  });

  it("a gate-failing pool never wins on depth", () => {
    const deepBad = pool(500_000, 40, 100, false), thinOk = pool(9_000, 30, 100, true);
    expect(pickBestPool([deepBad, thinOk], passes, 25)).toBe(thinOk);
  });

  it("returns the best-by-fee pool when nothing passes, so the rejection is logged", () => {
    const a = pool(20_000, 5, 100, false), b = pool(10_000, 50, 100, false);
    expect(pickBestPool([a, b], passes, 25)).toBe(b);
    expect(pickBestPool([], passes, 25)).toBeNull();
  });
});
