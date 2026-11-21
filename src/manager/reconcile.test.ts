import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { attachAccountToPosition } from "./reconcile.js";
import { getDb } from "../db/db.js";
import { useMemoryDb, resetTestDb, insertOpenPosition } from "../test/db.js";

// Written before the fix (review of the partial-open change). A later position
// account whose tx fate was unknown can land after open() recorded the position
// without it. Boot reconcile skipped any pool that already had an open row, so
// that account stayed unmanaged until the row closed AND the bot restarted again.
// Ways attaching it to the open row can go wrong:
//   T1  the account is tracked but the row's bin range / size / basis are not widened,
//       so exposure and the stop are measured against the smaller position
//   T2  a row with an unknown basis gets a partial one (unknown + x is unknown)
//   T3  a second boot attaches the same account again
describe("attachAccountToPosition", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());
  const row = (id: number) => getDb().prepare(
    "SELECT entry_sol, open_cost_sol, min_bin_id, max_bin_id FROM positions WHERE id = ?"
  ).get(id) as { entry_sol: number; open_cost_sol: number | null; min_bin_id: number; max_bin_id: number };
  const accounts = (id: number) => (getDb().prepare("SELECT COUNT(*) c FROM position_accounts WHERE position_id = ?").get(id) as { c: number }).c;

  it("T1: widens the range and adds the deposit and its measured cost", () => {
    const id = insertOpenPosition({ entrySol: 0.3, minBinId: -350, maxBinId: -300, mode: "live" });
    getDb().prepare("UPDATE positions SET open_cost_sol = 0.36 WHERE id = ?").run(id);
    expect(attachAccountToPosition(id, { pubkey: "stray", minBin: -400, maxBin: -351 }, 0.5, 0.56)).toBe(true);
    expect(row(id)).toEqual({ entry_sol: 0.8, open_cost_sol: 0.92, min_bin_id: -400, max_bin_id: -300 });
    expect(accounts(id)).toBe(1);
    const ev = getDb().prepare("SELECT type, detail_json FROM events WHERE position_id = ?").get(id) as { type: string; detail_json: string };
    expect(ev.type).toBe("open");
    expect(JSON.parse(ev.detail_json)).toMatchObject({ reconcile: "attached_stray_account", account: "stray", costSol: 0.56 });
  });

  it("T2: an unknown basis stays unknown", () => {
    const id = insertOpenPosition({ entrySol: 0.3, minBinId: -350, maxBinId: -300, mode: "live" });
    getDb().prepare("UPDATE positions SET open_cost_sol = NULL WHERE id = ?").run(id);
    attachAccountToPosition(id, { pubkey: "stray", minBin: -400, maxBin: -351 }, 0.5, 0.56);
    expect(row(id).open_cost_sol).toBeNull();
    expect(row(id).entry_sol).toBeCloseTo(0.8, 9);
  });

  it("T3: attaching the same account twice is a no-op", () => {
    const id = insertOpenPosition({ entrySol: 0.3, minBinId: -350, maxBinId: -300, mode: "live" });
    attachAccountToPosition(id, { pubkey: "stray", minBin: -400, maxBin: -351 }, 0.5, 0.56);
    expect(attachAccountToPosition(id, { pubkey: "stray", minBin: -400, maxBin: -351 }, 0.5, 0.56)).toBe(false);
    expect(row(id).entry_sol).toBeCloseTo(0.8, 9);
    expect(accounts(id)).toBe(1);
  });
});
