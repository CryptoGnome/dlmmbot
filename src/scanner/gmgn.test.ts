import { describe, it, expect, beforeEach } from "vitest";
import {
  parseTokenSecurity,
  parseGmgnResetMs,
  gmgnRouteWeight,
  gmgnBucketId,
  gmgnTokenBudgetOk,
  gmgnSpendOk,
  _setGmgnBucketForTests,
  _resetGmgnPaceForTests,
} from "./gmgn.js";

// tokenSecurity is the pipeline's ONLY honeypot/sell-tax check (vet.ts).
// The parser must fail closed (null) on shape drift, never read a payload it
// doesn't understand as "honeypot=false".

describe("parseTokenSecurity", () => {
  it("unwraps the --raw { code, data } envelope like every other endpoint", () => {
    const raw = JSON.stringify({ code: 0, data: { honeypot: 1, sell_tax: 0.05, buy_tax: 0.01 } });
    expect(parseTokenSecurity(raw)).toEqual({ honeypot: true, sellTaxPct: 5, buyTaxPct: 1 });
  });

  it("handles nested data envelopes", () => {
    const raw = JSON.stringify({ code: 0, data: { data: { honeypot: 0, can_not_sell: 1, sell_tax: 0 } } });
    expect(parseTokenSecurity(raw)?.honeypot).toBe(true);
  });

  it("still reads top-level fields when there is no envelope", () => {
    const raw = JSON.stringify({ honeypot: 0, sell_tax: 0, buy_tax: 0 });
    expect(parseTokenSecurity(raw)).toEqual({ honeypot: false, sellTaxPct: 0, buyTaxPct: 0 });
  });

  it("returns null (not honeypot=false) when no security field is recognizable", () => {
    expect(parseTokenSecurity(JSON.stringify({ code: 0, data: { msg: "ok" } }))).toBeNull();
    expect(parseTokenSecurity(JSON.stringify({ code: 0, data: {} }))).toBeNull();
  });
});

describe("gmgn rate-limit helpers", () => {
  beforeEach(() => _resetGmgnPaceForTests());

  it("weights holders/traders heavier than trending/security", () => {
    expect(gmgnRouteWeight(["market", "trending"])).toBe(1);
    expect(gmgnRouteWeight(["token", "security"])).toBe(1);
    expect(gmgnRouteWeight(["token", "holders"])).toBe(5);
    expect(gmgnRouteWeight(["token", "traders"])).toBe(5);
  });

  it("parses reset_at and X-RateLimit-Reset", () => {
    const now = 1_700_000_000_000;
    expect(parseGmgnResetMs('{"error":"RATE_LIMIT_BANNED","reset_at":1700000060}', now))
      .toBe(1_700_000_060_000);
    expect(parseGmgnResetMs('{"code":429,"error":"RATE_LIMIT_BANNED","reset_at":1700000060}', now))
      .toBe(1_700_000_060_000);
    expect(parseGmgnResetMs("X-RateLimit-Reset: 1700000099", now)).toBe(1_700_000_099_000);
    expect(parseGmgnResetMs("nope", now)).toBeNull();
  });

  it("maps CLI args to per-module buckets", () => {
    expect(gmgnBucketId(["market", "trending"])).toBe("market");
    expect(gmgnBucketId(["token", "holders"])).toBe("token");
    expect(gmgnBucketId(["track", "smartmoney"])).toBe("track");
  });

  it("sheds optional trader-tag calls when token bucket is depleted", () => {
    _resetGmgnPaceForTests();
    _setGmgnBucketForTests("token", 5);
    expect(gmgnTokenBudgetOk(5)).toBe(true);
    _setGmgnBucketForTests("token", 4);
    expect(gmgnTokenBudgetOk(5)).toBe(false);
  });

  it("allows required security preflight when optional paths would shed", () => {
    _resetGmgnPaceForTests();
    _setGmgnBucketForTests("token", 1);
    expect(gmgnSpendOk(1, "token")).toBe(true);
    expect(gmgnSpendOk(5, "token", { optional: true })).toBe(false);
  });
});
