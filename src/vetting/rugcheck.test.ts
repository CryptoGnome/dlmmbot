import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  _resetRugcheckStateForTests, creatorRugCount, fetchReport, insiderNetworkPct, insiderNetworkStats, walletHolders,
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

  // Failure modes of the holder gates, written before the fix. In live reports
  // on 2026-11-25 all 8 tokens checked had a pool or locker as the largest
  // "holder" (DCTY: 31.7% was the Pump AMM pool; its largest wallet held 2.5%).
  //  H1 a labeled AMM pool is read as the largest holder
  //  H2 a labeled locker is read as a holder
  //  H3 a label keyed by the token account, not its owner, is missed
  //  H4 a wallet with no label, or a label that is not a pool or locker (the
  //     creator), is dropped — that would hide a whale
  //  H5 a report without knownAccounts throws
  //  H6 a real whale passes because a pool was stripped (vet.gates.test.ts)
  //  H7 a wrong or spoofed pool label on an ordinary keypair wallet hides a
  //     whale. All 16 labeled pools/lockers in those reports were program
  //     addresses (off the ed25519 curve), which no one holds a key to.
  it("walletHolders drops labeled pools and lockers, by owner or token account, and nothing else", () => {
    const h = (address: string, owner: string, pct: number) => ({ address, owner, pct, insider: false });
    const pda = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], SystemProgram.programId)[0].toBase58();
    const pool = pda("pool"), lockOwner = pda("lock"), mislabeled = Keypair.generate().publicKey.toBase58();
    const r = report({
      topHolders: [
        h("ta1", pool, 60), h("LockTa", lockOwner, 7), h("ta3", "Dev", 5), h("ta4", "Whale", 4), h("ta5", mislabeled, 3),
      ],
      knownAccounts: {
        [pool]: { name: "Pump Fun AMM", type: "AMM" },
        LockTa: { name: "Streamflow Vault", type: "LOCKER" },
        Dev: { name: "Creator", type: "CREATOR" },
        [mislabeled]: { name: "Pump Fun AMM", type: "AMM" },
      },
    });
    expect(walletHolders(r).map((x) => x.owner)).toEqual(["Dev", "Whale", mislabeled]);
    expect(walletHolders(report({ topHolders: [h("ta", "W", 9)] })).map((x) => x.owner)).toEqual(["W"]);
    expect(walletHolders(report({}))).toEqual([]);
  });

  // Failure modes, written before the fix (live reports, 2026-11-25):
  //  R1 a network that already sold still counts at the amount it once received
  //  R2 a report without currentHolding reads as 0% held instead of falling back
  //  R3 the largest single network is lost inside the sum of unrelated ones
  it("insiderNetworkStats: held now, not once received; largest network kept apart", () => {
    const r = report({
      insiderNetworks: [
        { id: "sold", type: "transfer", size: 4, tokenAmount: 100, currentHolding: 20 },
        { id: "old-shape", type: "transfer", size: 9, tokenAmount: 50 },
      ],
    });
    const s = insiderNetworkStats(r, 1000)!;
    expect(s.heldPct).toBeCloseTo(7, 5);
    expect(s.grossPct).toBeCloseTo(15, 5);
    expect(s.largestPct).toBeCloseTo(5, 5);
    expect(s.networks).toBe(2);
    expect(insiderNetworkPct(r, 1000)).toBeCloseTo(7, 5);
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
