import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { vetToken } from "./vet.js";
import { fetchReport, type RugcheckReport } from "./rugcheck.js";
import { fetchTokenFacts } from "./onchain.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb } from "../test/db.js";
import { getDb, isBlacklisted, now, recordCreatorRug } from "../db/db.js";

// Fail-closed vetting behavior (audit #8/#9): the engine must hard-fail when it
// is blind, and the creator one-strike system must actually block re-offenders.

vi.mock("./onchain.js", () => ({ fetchTokenFacts: vi.fn() }));
vi.mock("./rugcheck.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rugcheck.js")>()),
  fetchReport: vi.fn(),
}));
vi.mock("./jupdata.js", () => ({ jupAsset: vi.fn(async () => null) }));
vi.mock("../scanner/gmgn.js", () => ({
  tokenSecurity: vi.fn(async () => null),
  tokenTraderTags: vi.fn(async () => null),
}));

const MINT = "Tok1111111111111111111111111111111111111";
const CREATOR = "Cr1111111111111111111111111111111111111";
const THREE_H_AGO = Date.now() - 3 * 3600_000;

const factsMock = vi.mocked(fetchTokenFacts);
const reportMock = vi.mocked(fetchReport);

function onchainFacts() {
  return {
    mintAuthority: null,
    freezeAuthority: null,
    tokenProgram: "spl-token",
    token2022Extensions: [],
    supplyRaw: 1_000_000_000,
    decimals: 6,
    largestAccounts: [],
  };
}

function rugReport(partial: Partial<RugcheckReport> = {}): RugcheckReport {
  return {
    score: 0,
    score_normalised: 10,
    risks: [],
    creator: CREATOR,
    creatorTokens: null,
    rugged: false,
    graphInsidersDetected: 0,
    insiderNetworks: null,
    totalHolders: 500,
    totalLPProviders: 10,
    totalMarketLiquidity: 1e6,
    launchpad: null,
    topHolders: [
      { address: "H1", owner: "H1", pct: 5, insider: false },
      { address: "H2", owner: "H2", pct: 4, insider: false },
    ],
    markets: null,
    detectedAt: new Date(THREE_H_AGO).toISOString(),
    ...partial,
  };
}

function gatesOf(r: Awaited<ReturnType<typeof vetToken>>): string[] {
  return r.hardFailures.map((f) => f.gate);
}

describe("vetToken fail-closed gates", () => {
  beforeEach(() => {
    useMemoryDb();
    installConfig();
    factsMock.mockReset().mockResolvedValue(onchainFacts());
    reportMock.mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    restoreConfig();
    resetTestDb();
  });

  it("hard-fails holder_data_unavailable when RugCheck AND RPC holder data are blind", async () => {
    const r = await vetToken(MINT, THREE_H_AGO);
    expect(r.verdict).toBe("fail");
    expect(gatesOf(r)).toContain("holder_data_unavailable");
    // Transient blindness must not burn the token's 24h blacklist slot.
    expect(isBlacklisted(MINT)).toBeNull();
  });

  it("does not fire holder_data_unavailable when RugCheck holders exist", async () => {
    reportMock.mockResolvedValue(rugReport());
    const r = await vetToken(MINT, THREE_H_AGO);
    expect(gatesOf(r)).not.toContain("holder_data_unavailable");
    expect(r.verdict).toBe("pass");
  });

  it("respects the holder_gate_enabled master switch", async () => {
    installConfig((c) => { c.vetting.holder_gate_enabled = false; });
    const r = await vetToken(MINT, THREE_H_AGO);
    expect(gatesOf(r)).not.toContain("holder_data_unavailable");
  });

  it("hard-fails age_unknown when both age sources are missing", async () => {
    reportMock.mockResolvedValue(rugReport({ detectedAt: null }));
    const r = await vetToken(MINT, null);
    expect(gatesOf(r)).toContain("age_unknown");
  });

  // A revived old meme is a valid pool: the pool gates already proved it has
  // live fee flow and volume, and mint age carries no score/sizing weight.
  it("admits a mature mint by default — no upper age ceiling", async () => {
    const NINETY_DAYS_AGO = Date.now() - 90 * 24 * 3600 * 1000;
    reportMock.mockResolvedValue(rugReport({ detectedAt: new Date(NINETY_DAYS_AGO).toISOString() }));
    const r = await vetToken(MINT, null);
    expect(gatesOf(r)).not.toContain("age_max");
    expect(r.verdict).toBe("pass");
    // The age is still measured and recorded — we dropped the gate, not the fact.
    expect(r.facts.tokenAgeMinutes).toBeGreaterThan(89 * 1440);
  });

  it("still caps mint age when the operator re-enables age_max", async () => {
    const NINETY_DAYS_AGO = Date.now() - 90 * 24 * 3600 * 1000;
    reportMock.mockResolvedValue(rugReport({ detectedAt: new Date(NINETY_DAYS_AGO).toISOString() }));
    installConfig((c) => { c.vetting.age_max_enabled = true; c.vetting.age_max_days = 14; });
    const r = await vetToken(MINT, null);
    expect(gatesOf(r)).toContain("age_max");
    expect(r.verdict).toBe("fail");
  });

  // age_min is the SAFETY gate — dropping the ceiling must not touch the floor.
  it("still rejects a mint inside the instant-rug window", async () => {
    reportMock.mockResolvedValue(rugReport({ detectedAt: new Date(Date.now() - 5 * 60_000).toISOString() }));
    const r = await vetToken(MINT, null);
    expect(gatesOf(r)).toContain("age_min");
    expect(r.verdict).toBe("fail");
  });

  it("skips age_unknown only when BOTH age gates are disabled", async () => {
    reportMock.mockResolvedValue(rugReport({ detectedAt: null }));
    // Sets BOTH preconditions explicitly: age_max ships disabled, so relying on
    // the default here would assert nothing once age_min is switched off.
    installConfig((c) => {
      c.vetting.age_min_enabled = false;
      c.vetting.age_max_enabled = true;
    });
    expect(gatesOf(await vetToken(MINT, null))).toContain("age_unknown");
    installConfig((c) => {
      c.vetting.age_min_enabled = false;
      c.vetting.age_max_enabled = false;
    });
    expect(gatesOf(await vetToken(MINT, null))).not.toContain("age_unknown");
  });

  it("one strike: recordCreatorRug blocks the creator's next mint", async () => {
    recordCreatorRug(CREATOR); // what loop.ts calls on P0
    reportMock.mockResolvedValue(rugReport()); // fresh token, same creator
    const r = await vetToken(MINT, THREE_H_AGO);
    expect(r.verdict).toBe("fail");
    expect(gatesOf(r)).toContain("creator_blacklist");
    expect(gatesOf(r)).toContain("creator_rug_history");
    expect(r.facts.creatorRugCount).toBe(1);
  });

  it("creator strikes apply from the local DB even when RugCheck is down", async () => {
    getDb().prepare(
      "INSERT INTO tokens (mint, creator, first_seen) VALUES (?, ?, ?)"
    ).run(MINT, CREATOR, now());
    recordCreatorRug(CREATOR);
    const r = await vetToken(MINT, THREE_H_AGO); // report = null
    expect(gatesOf(r)).toContain("creator_blacklist");
    expect(gatesOf(r)).toContain("creator_rug_history");
  });

  it("records security_data_unavailable when the honeypot source is blind", async () => {
    reportMock.mockResolvedValue(rugReport());
    const r = await vetToken(MINT, THREE_H_AGO);
    expect(r.facts.securityDataUnavailable).toBe(true);
    // Soft note only — must not hard-fail an otherwise clean token.
    expect(r.verdict).toBe("pass");
  });
});
