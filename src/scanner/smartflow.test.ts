import { describe, expect, it } from "vitest";
import { aggregateSmartflow, type FlowTrade } from "./smartflow.js";

describe("aggregateSmartflow", () => {
  const base = 1_700_000_000;
  const trades: FlowTrade[] = [
    { hash: "a", token: "MINT1", maker: "w1", side: "buy", usd: 100, ts: base, kol: null, feed: "smartmoney" },
    { hash: "b", token: "MINT1", maker: "w2", side: "buy", usd: 50, ts: base + 10, kol: null, feed: "smartmoney" },
    { hash: "c", token: "MINT1", maker: "w1", side: "sell", usd: 20, ts: base + 20, kol: null, feed: "smartmoney" },
    { hash: "d", token: "MINT2", maker: "w3", side: "buy", usd: 200, ts: base + 5, kol: "alpha", feed: "kol" },
  ];

  it("ranks tokens and builds recent tape", () => {
    const snap = aggregateSmartflow(trades, {
      nowMs: (base + 60) * 1000,
      lastPollOk: (base + 60) * 1000,
      running: true,
      windowMin: 30,
    });
    expect(snap.trade_count).toBe(4);
    expect(snap.tokens[0]?.mint).toBe("MINT1");
    expect(snap.tokens[0]?.smart_wallets).toBe(2);
    expect(snap.tokens[0]?.net_usd).toBe(130);
    expect(snap.tokens.find((t) => t.mint === "MINT2")?.kol_names).toContain("alpha");
    expect(snap.recent[0]?.hash).toBe("c");
    expect(snap.stale).toBe(false);
  });
});
