import { describe, it, expect } from "vitest";
import { pickCopycatWinner } from "./scan.js";

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
