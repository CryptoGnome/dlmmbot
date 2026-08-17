import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, isBlacklisted, REALIZED_PNL_SQL, STRANDED_GRACE_S, logError, now, pruneHistory, recordCreatorRug, recordDecision, upsertTokenMeta } from "./db.js";
import { useMemoryDb, resetTestDb, insertClosedPosition } from "../test/db.js";

function pnlFor(id: number): number | null {
  return (getDb().prepare(
    `SELECT (${REALIZED_PNL_SQL}) AS pnl FROM positions WHERE id = ?`
  ).get(id) as { pnl: number | null }).pnl;
}

describe("REALIZED_PNL_SQL", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());

  it("prefers measured wallet delta when both cost columns exist", () => {
    const id = insertClosedPosition({
      entrySol: 0.3,
      exitSol: 0.4, // notional would say +0.1
      openCostSol: 0.31,
      closeReturnSol: 0.28,
      feesMeasuredSol: 0.02,
      recoveredSol: 0.01,
    });
    expect(pnlFor(id)).toBeCloseTo(0.28 + 0.02 + 0.01 - 0.31, 8);
  });

  it("falls back to legacy notional mark when measured columns missing", () => {
    const id = insertClosedPosition({
      entrySol: 0.3,
      exitSol: 0.35,
      feesClaimedSol: 0.02,
      openCostSol: null,
      closeReturnSol: null,
    });
    expect(pnlFor(id)).toBeCloseTo(0.35 - 0.3 + 0.02, 8);
  });

  it("returns NULL for adopted rows with no basis (entry_sol = 0)", () => {
    const id = insertClosedPosition({
      entrySol: 0,
      exitSol: 0.5,
      feesClaimedSol: 0.1,
      openCostSol: null,
      closeReturnSol: null,
    });
    expect(pnlFor(id)).toBeNull();
  });

  it("returns NULL for a no-basis adopted row even when close_return exists", () => {
    // The old expression subtracted COALESCE(open_cost, 0+0) here — full close
    // proceeds reported as pure profit, masking real same-day losses from the
    // circuit breaker.
    const id = insertClosedPosition({
      entrySol: 0,
      exitSol: null,
      openCostSol: null,
      closeReturnSol: 0.5,
      feesMeasuredSol: 0.01,
    });
    expect(pnlFor(id)).toBeNull();
  });

  it("returns NULL for unknown-exit rows (force-close / reconcile orphan)", () => {
    // exit_sol AND close_return_sol both NULL: outcome unknown. The old
    // expression fabricated a full −entry_sol loss — a crash mid-close could
    // trip the circuit breaker on a position that lost nothing.
    const id = insertClosedPosition({
      entrySol: 0.5,
      exitSol: null,
      exitReason: "manual",
      openCostSol: null,
      closeReturnSol: null,
    });
    expect(pnlFor(id)).toBeNull();
    const sum = (getDb().prepare(
      `SELECT COALESCE(SUM(${REALIZED_PNL_SQL}), 0) AS s FROM positions`
    ).get() as { s: number }).s;
    expect(sum).toBe(0); // SUM skips the NULL
  });

  it("counts profit-lock withdrawals in the measured branch", () => {
    // 1.0 in, locked 0.4 to the wallet mid-position, closed at 0.7:
    // true PnL is +0.1, not −0.3.
    const id = insertClosedPosition({
      entrySol: 0.6, // shrunk by the lock; must NOT be the basis
      exitSol: 0.7,
      openCostSol: 1.0,
      closeReturnSol: 0.7,
      withdrawnSol: 0.4,
    });
    expect(pnlFor(id)).toBeCloseTo(0.1, 8);
  });

  // ANSEM pos#8, 2026-08-17 08:09:53 (live). The close swap under-filled and
  // left 75% of the position sitting in the wallet as tokens. Un-credited, the
  // row read −0.5422 SOL and tripped the daily circuit breaker 52s later; the
  // sweep sold the residue 112s after the close and the truth was −0.0100.
  it("credits a fresh strand so an under-filled close is not a phantom loss", () => {
    const id = insertClosedPosition({
      entrySol: 0.75,
      exitSol: 0.7144,
      openCostSol: 0.8669,
      closeReturnSol: 0.2955,
      feesMeasuredSol: 0.0292,
      strandedSol: 0.5327,
    });
    expect(pnlFor(id)).toBeCloseTo(0.2955 + 0.0292 + 0.5327 - 0.8669, 8);
    expect(pnlFor(id)!).toBeGreaterThan(-0.02); // not the −0.54 phantom
  });

  it("expires the strand credit once the grace window passes", () => {
    // A residue the sweep cannot sell is a bag we are holding, not settlement
    // lag. The credit must decay to the real loss or it hides losses forever —
    // strictly worse than the bug it fixes.
    const id = insertClosedPosition({
      entrySol: 0.75,
      exitSol: 0.7144,
      openCostSol: 0.8669,
      closeReturnSol: 0.2955,
      feesMeasuredSol: 0.0292,
      strandedSol: 0.5327,
      strandedAgeS: STRANDED_GRACE_S + 60,
    });
    expect(pnlFor(id)).toBeCloseTo(0.2955 + 0.0292 - 0.8669, 8);
  });

  it("never counts the strand estimate and the swept recovery together", () => {
    // The sweep zeroes stranded_sol as it credits recovered_sol. Belt-and-braces
    // on the invariant: a row carrying both must not double-count.
    const id = insertClosedPosition({
      entrySol: 0.75,
      exitSol: 0.7144,
      openCostSol: 0.8669,
      closeReturnSol: 0.2955,
      feesMeasuredSol: 0.0292,
      recoveredSol: 0.5323,
      strandedSol: 0, // what the sweep leaves behind
    });
    expect(pnlFor(id)).toBeCloseTo(0.2955 + 0.0292 + 0.5323 - 0.8669, 8);
  });

  it("credits a strand on the legacy notional branch too", () => {
    const id = insertClosedPosition({
      entrySol: 0.3,
      exitSol: 0.1,
      feesClaimedSol: 0.01,
      openCostSol: null,
      closeReturnSol: null,
      strandedSol: 0.18,
    });
    expect(pnlFor(id)).toBeCloseTo(0.1 - 0.3 + 0.01 + 0.18, 8);
  });

  it("uses close_return when open_cost is missing (partial wallet columns)", () => {
    const id = insertClosedPosition({
      entrySol: 0.75,
      exitSol: 0.76,
      openCostSol: null,
      closeReturnSol: 0.752,
      feesMeasuredSol: 0,
    });
    expect(pnlFor(id)).toBeCloseTo(0.002, 8);
  });

  it("treats NULL close_return_sol as not measured (legacy path)", () => {
    const id = insertClosedPosition({
      entrySol: 0.3,
      exitSol: 0.25,
      feesClaimedSol: 0,
      openCostSol: 0.31,
      closeReturnSol: null,
    });
    expect(pnlFor(id)).toBeCloseTo(0.25 - 0.3, 8);
  });
});

describe("logError", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());

  it("writes a row and dedupes within the window", () => {
    const a = logError({ source: "test", code: "unit", message: "boom", dedupeSec: 60 });
    const b = logError({ source: "test", code: "unit", message: "boom", dedupeSec: 60 });
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(0);
    const n = (getDb().prepare("SELECT COUNT(*) AS n FROM error_log").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it("recordCreatorRug increments rug_count and blacklists the creator permanently", () => {
    recordCreatorRug("CrA", "rugged token (P0)");
    recordCreatorRug("CrA");
    const row = getDb().prepare(
      "SELECT rug_count FROM creators WHERE address = ?",
    ).get("CrA") as { rug_count: number };
    expect(row.rug_count).toBe(2);
    expect(isBlacklisted("CrA")).toBeTruthy();
    const bl = getDb().prepare(
      "SELECT kind, expires_ts FROM blacklist WHERE key = ?",
    ).get("CrA") as { kind: string; expires_ts: number | null };
    expect(bl.kind).toBe("creator");
    expect(bl.expires_ts).toBeNull(); // permanent — one strike
  });

  it("upserts display metadata without wiping existing fields", () => {
    upsertTokenMeta("mintA", { symbol: "AAA", icon_url: "https://x/a.png" });
    upsertTokenMeta("mintA", { name: "Token A" });
    const row = getDb().prepare(
      "SELECT symbol, name, icon_url FROM tokens WHERE mint = ?",
    ).get("mintA") as { symbol: string; name: string; icon_url: string };
    expect(row.symbol).toBe("AAA");
    expect(row.name).toBe("Token A");
    expect(row.icon_url).toBe("https://x/a.png");
  });
});

/**
 * Nothing pruned these tables before: the Railway volume hit 83% inside a day.
 * Retention must be exactly what the readers need — and must never touch the
 * entered/exited audit trail.
 */
describe("pruneHistory", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());

  const DAY = 86_400;
  const count = (sql: string) => (getDb().prepare(sql).get() as { c: number }).c;

  it("prunes old skipped decisions and snapshots, keeps recent ones", () => {
    const db = getDb();
    const t = now();
    const ins = db.prepare("INSERT INTO decisions (ts, mint, pool, action, failed_gate, score, features_json) VALUES (?,?,?,?,?,?,?)");
    ins.run(t - 40 * DAY, "m1", "p1", "skipped", "vol_30m", 50, "{}");   // old skip → prune
    ins.run(t - 1 * DAY,  "m2", "p2", "skipped", "vol_30m", 50, "{}");   // recent skip → keep
    const snap = db.prepare("INSERT INTO pool_snapshots (pool, ts, tvl_usd, price, vol_30m, vol_1h, vol_24h, fee_tvl_30m, fee_tvl_24h) VALUES (?,?,?,?,?,?,?,?,?)");
    snap.run("p1", t - 5 * DAY, 1, 1, 1, 1, 1, 1, 1);  // old → prune
    snap.run("p1", t - 1 * DAY, 1, 1, 1, 1, 1, 1, 1);  // recent → keep

    const r = pruneHistory({ skippedDays: 30, snapshotDays: 3 });
    expect(r).toMatchObject({ decisions: 1, snapshots: 1, vacuumed: false, mode: "age" });
    expect(count("SELECT COUNT(*) c FROM decisions")).toBe(1);
    expect(count("SELECT COUNT(*) c FROM pool_snapshots")).toBe(1);
  });

  it("never prunes entered or exited rows, however old", () => {
    const db = getDb();
    const t = now();
    const ins = db.prepare("INSERT INTO decisions (ts, mint, pool, action, failed_gate, score, features_json) VALUES (?,?,?,?,?,?,?)");
    ins.run(t - 400 * DAY, "m1", "p1", "entered", null, 80, "{}");
    ins.run(t - 400 * DAY, "m1", "p1", "exited", "P3_above_win", null, "{}");
    ins.run(t - 400 * DAY, "m1", "p1", "skipped", "vol_30m", 50, "{}");
    const r = pruneHistory({ skippedDays: 30, snapshotDays: 3 });
    expect(r.decisions).toBe(1);
    expect(count("SELECT COUNT(*) c FROM decisions WHERE action IN ('entered','exited')")).toBe(2);
  });

  /**
   * The age windows are calibrated to what the dashboard reads, not what the
   * volume can hold. On a one-day-old install nothing was older than 30 days,
   * retention pruned zero rows, and the Railway volume filled to ENOSPC
   * overnight. The size ceiling is what actually bounds the file.
   */
  it("size ceiling trims oldest skipped rows and snapshots regardless of age", () => {
    const db = getDb();
    const t = now();
    const ins = db.prepare("INSERT INTO decisions (ts, mint, pool, action, failed_gate, score, features_json) VALUES (?,?,?,?,?,?,?)");
    const fat = "x".repeat(2000);
    // 3000 recent skipped rows ≈ 6 MB — all inside the 30-day window.
    const many = db.transaction(() => { for (let i = 0; i < 3000; i++) ins.run(t - i, "m", "p", "skipped", "vol_30m", 50, fat); });
    many();
    ins.run(t - 500, "m", "p", "entered", null, 80, "{}"); // must survive
    ins.run(t - 400, "m", "p", "exited", "P3_above_win", null, "{}"); // must survive
    const before = pruneHistory({ skippedDays: 30, snapshotDays: 3, maxBytes: 0 }); // no ceiling → nothing
    expect(before.mode).toBe("none");
    expect(before.decisions).toBe(0);

    const r = pruneHistory({ skippedDays: 30, snapshotDays: 3, maxBytes: 1024 * 1024 }); // 1 MB ceiling
    expect(r.mode).toBe("size");
    expect(r.decisions).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) c FROM decisions WHERE action IN ('entered','exited')")).toBe(2);
    // Oldest-first: whatever skipped rows remain are the NEWEST ones.
    const oldest = (getDb().prepare("SELECT MIN(ts) m FROM decisions WHERE action='skipped'").get() as { m: number | null }).m;
    if (oldest !== null) expect(t - oldest).toBeLessThan(3000);
    // And it never loops forever when only audit rows remain.
    const again = pruneHistory({ skippedDays: 30, snapshotDays: 3, maxBytes: 1 });
    expect(again.mode).not.toBe(undefined);
    expect(count("SELECT COUNT(*) c FROM decisions WHERE action IN ('entered','exited')")).toBe(2);
  });

  it("reports file size before and after so the log line can show it", () => {
    const r = pruneHistory({ skippedDays: 30, snapshotDays: 3 });
    expect(r.bytesBefore).toBeGreaterThan(0);
    expect(r.bytesAfter).toBeGreaterThan(0);
  });

  it("gate rejections no longer carry a serialised pool object", () => {
    // The write site used to pass `pool: p` — ~1 KB per row, ~100 rows/hour.
    recordDecision("m1", "p1", "skipped", "vol_30m", 50, {
      symbol: "X", gateFailures: [{ gate: "vol_30m", value: "100", limit: "25000" }],
      tvlUsd: 5000, vol30mUsd: 100, feeTvl24hPct: 1.2, feeTvl30mPct: 0.1, binStep: 100, mcapUsd: 200000,
    });
    const row = getDb().prepare("SELECT LENGTH(features_json) l, features_json f FROM decisions").get() as { l: number; f: string };
    expect(row.l).toBeLessThan(400);
    expect(JSON.parse(row.f).pool).toBeUndefined();
    expect(JSON.parse(row.f).gateFailures[0].gate).toBe("vol_30m"); // the reason survives
  });
});
