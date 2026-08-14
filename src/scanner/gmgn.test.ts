import { describe, it, expect } from "vitest";
import { parseTokenSecurity } from "./gmgn.js";

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
