import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../scanner/majorsScan.js", () => ({ scanMajors: vi.fn(async () => []) }));
vi.mock("../scanner/candles.js", () => ({ fetchCandlesDeep: vi.fn(async () => []) }));
vi.mock("../ranges/majorsPlanner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ranges/majorsPlanner.js")>();
  // TA timing is not what these tests are about; let every candidate through.
  return { ...actual, majorsEntryTiming: vi.fn(() => ({ ok: true, rsi: 40, swingPos: 0.2 })) };
});

import { scanMajors } from "../scanner/majorsScan.js";
import { enterMajorsPositions } from "./majorsEntry.js";
import { FakeExecutor } from "../test/fakeExecutor.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb } from "../test/db.js";
import { blacklist, getDb, isExitCooldown } from "../db/db.js";
import { makePool } from "../test/pool.js";

/** The real ANSEM mint the 2026-08-18 incident fired on. */
const ANSEM = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";

function candidate() {
  const pool = makePool({ address: "AnsemPool111111111111111111111111111111", mintX: ANSEM, price: 0.00362 });
  return { pool, tokenMint: ANSEM, symbol: "ANSEM", score: 70, source: "whitelist" as const };
}

const openCount = () =>
  (getDb().prepare("SELECT COUNT(*) c FROM positions WHERE exit_ts IS NULL").get() as { c: number }).c;

const skipReasons = () =>
  (getDb().prepare("SELECT failed_gate FROM decisions WHERE action='skipped'").all() as Array<{ failed_gate: string }>)
    .map((r) => r.failed_gate);

describe("majors re-entry cooldown", () => {
  let exec: FakeExecutor;
  const bankroll = { walletSol: 10, bankedSol: 0, deployedSol: 0, deployableSol: 10, effectiveSlots: 5 };

  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.majors.enabled = true;
      c.majors.max_slots = 2;
      c.sizing.max_positions = 5;
      c.sizing.kelly_enabled = false;
    });
    exec = new FakeExecutor("paper");
    vi.mocked(scanMajors).mockResolvedValue([candidate()]);
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.restoreAllMocks();
  });

  it("classifies exit cooldowns apart from vetting bans", () => {
    // Written by loop.ts on P0/P1/P5 — these must block re-entry everywhere.
    expect(isExitCooldown("below range cut")).toBe(true);
    expect(isExitCooldown("stop loss cooldown")).toBe(true);
    expect(isExitCooldown("P0 safety exit (price_crash)")).toBe(true);
    expect(isExitCooldown("escape cooldown")).toBe(true);
    // Written by vet.ts — meme heuristics, deliberately not enforced on majors.
    expect(isExitCooldown("insider_clusters,age_max")).toBe(false);
    expect(isExitCooldown("rugcheck_veto,top10_holders")).toBe(false);
  });

  it("does not re-enter a major that was just cut below range", async () => {
    // Exactly what the live bot did at 00:32:14 on 2026-08-18.
    blacklist(ANSEM, "token", "below range cut", 24);

    await enterMajorsPositions(exec, bankroll);

    expect(openCount()).toBe(0);
    expect(skipReasons()).toContain("majors_exit_cooldown");
  });

  it("does not re-enter after a stop loss or a P0 safety exit", async () => {
    blacklist(ANSEM, "token", "stop loss cooldown", 24);
    await enterMajorsPositions(exec, bankroll);
    expect(openCount()).toBe(0);

    getDb().prepare("DELETE FROM blacklist").run();
    blacklist(ANSEM, "token", "P0 safety exit (tvl_drain)", 6);
    await enterMajorsPositions(exec, bankroll);
    expect(openCount()).toBe(0);
  });

  it("still enters when the ban is a meme-vetting gate", async () => {
    // Majors is an allowlist of established tokens; a holder-concentration or
    // rugcheck veto must not park the sleeve.
    blacklist(ANSEM, "token", "insider_clusters,age_max", 24);

    await enterMajorsPositions(exec, bankroll);

    expect(openCount()).toBe(1);
  });

  it("enters once the cooldown has expired", async () => {
    blacklist(ANSEM, "token", "below range cut", 24);
    await enterMajorsPositions(exec, bankroll);
    expect(openCount()).toBe(0);

    // isBlacklisted evicts on read once expires_ts has passed.
    getDb().prepare("UPDATE blacklist SET expires_ts = ? WHERE key = ?")
      .run(Math.floor(Date.now() / 1000) - 60, ANSEM);

    await enterMajorsPositions(exec, bankroll);
    expect(openCount()).toBe(1);
  });
});
