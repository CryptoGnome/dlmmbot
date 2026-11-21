import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  getDb, now, REALIZED_PNL_SQL, creditRentReclaim, backfillRentReclaims, backfillProfitBurns, attributeLegacyRentReclaims,
} from "./db.js";
import { useMemoryDb, resetTestDb, insertClosedPosition } from "../test/db.js";

// Ledger truth (2026-11-21 audit). The wallet's on-chain history said +0.403
// SOL while SUM(REALIZED_PNL_SQL) said -0.357. Ways the ledger can disagree
// with the wallet, each pinned below BEFORE the fix was written:
//   A1  token-account rent comes back at the sweep and no position is credited
//   A2  the credit lands on a re-entry instead of the entry that paid the rent
//   A3  one reclaim tx closes several accounts and the credit is lost or doubled
//   A4  the 1% profit burn leaves the wallet and no position is debited
//   A5  a backfill run twice counts history twice
//   A6  the dashboard's copy of the formula drifts from this one
//   A7  an event that cannot be attributed is silently dropped rather than counted
// Found by `npm run e2e:ledger` on the real book (0.0727 of 0.6447 SOL left over):
//   A8  the account was re-created with no new entry (dust sent to the wallet), so
//       the "entry that paid" search is empty and a real wallet gain is dropped
//   A9  events older than the token list name only account addresses
//   A10 history replayed out of order credits the wrong side of an earlier reclaim

function pnlFor(id: number): number | null {
  return (getDb().prepare(
    `SELECT (${REALIZED_PNL_SQL}) AS pnl FROM positions WHERE id = ?`
  ).get(id) as { pnl: number | null }).pnl;
}
function bookPnl(): number {
  return (getDb().prepare(
    `SELECT COALESCE(SUM(${REALIZED_PNL_SQL}), 0) AS s FROM positions`
  ).get() as { s: number }).s;
}
function livePos(mint: string, entryTs: number, o: { open: number; close: number }): number {
  const id = insertClosedPosition({
    entrySol: o.open, exitSol: o.close, openCostSol: o.open, closeReturnSol: o.close, mode: "live", exitTs: entryTs + 600,
  });
  getDb().prepare("UPDATE positions SET token_mint = ?, entry_ts = ? WHERE id = ?").run(mint, entryTs, id);
  return id;
}
function reclaimEvent(ts: number, solDelta: number | null, mints: string[], positionId: number | null = null): void {
  getDb().prepare(
    "INSERT INTO events (position_id, ts, type, tx_sig, sol_delta, detail_json) VALUES (?, ?, 'rent_reclaim', 'sig', ?, ?)"
  ).run(positionId, ts, solDelta, JSON.stringify({ tokens: mints.map((mint) => ({ mint, symbol: "T", account: "a" })) }));
}

describe("REALIZED_PNL_SQL carries rent reclaims and the profit burn", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());

  it("A1: a flat round trip that paid 0.00204 token-account rent is flat once the rent returns", () => {
    const id = insertClosedPosition({ entrySol: 0.5, exitSol: 0.5, openCostSol: 0.50204, closeReturnSol: 0.5 });
    expect(pnlFor(id)).toBeCloseTo(-0.00204, 8);
    getDb().prepare("UPDATE positions SET rent_reclaimed_sol = 0.00204 WHERE id = ?").run(id);
    expect(pnlFor(id)).toBeCloseTo(0, 8);
  });

  it("A1: the legacy notional branch is credited too", () => {
    const id = insertClosedPosition({ entrySol: 0.3, exitSol: 0.3, openCostSol: null, closeReturnSol: null });
    getDb().prepare("UPDATE positions SET rent_reclaimed_sol = 0.002 WHERE id = ?").run(id);
    expect(pnlFor(id)).toBeCloseTo(0.002, 8);
  });

  it("A4: the profit burn is a cost of the close that earned it", () => {
    const id = insertClosedPosition({ entrySol: 1, exitSol: 1.1, openCostSol: 1, closeReturnSol: 1.1 });
    getDb().prepare("UPDATE positions SET profit_burn_sol = 0.001 WHERE id = ?").run(id);
    expect(pnlFor(id)).toBeCloseTo(0.099, 8);
  });
});

describe("creditRentReclaim", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());

  it("A2: credits the entry that created the account, not the newest re-entry", () => {
    const t = now() - 10_000;
    const first = livePos("mintA", t, { open: 0.50204, close: 0.5 });
    const reentry = livePos("mintA", t + 1000, { open: 0.5, close: 0.5 });
    expect(creditRentReclaim("mintA", 0.00204, t + 5000)).toBe(first);
    expect(pnlFor(first)).toBeCloseTo(0, 8);
    expect(pnlFor(reentry)).toBeCloseTo(0, 8);
  });

  it("A2: after a reclaim, the next account is paid for by the next entry", () => {
    const t = now() - 20_000;
    const first = livePos("mintA", t, { open: 0.50204, close: 0.5 });
    creditRentReclaim("mintA", 0.00204, t + 5000);
    reclaimEvent(t + 5000, 0.00204, ["mintA"]); // the reclaim is what ends that account's life
    const second = livePos("mintA", t + 8000, { open: 0.50204, close: 0.5 });
    expect(creditRentReclaim("mintA", 0.00204, t + 12_000)).toBe(second);
    expect(pnlFor(first)).toBeCloseTo(0, 8);
    expect(pnlFor(second)).toBeCloseTo(0, 8);
  });

  it("never credits a position opened after the reclaim, or another mode's row", () => {
    const t = now() - 20_000;
    const paper = insertClosedPosition({ entrySol: 0.5, exitSol: 0.5, mode: "paper" });
    getDb().prepare("UPDATE positions SET token_mint = 'mintA', entry_ts = ? WHERE id = ?").run(t, paper);
    const later = livePos("mintA", t + 9000, { open: 0.5, close: 0.5 });
    expect(creditRentReclaim("mintA", 0.002, t + 5000)).toBeNull();
    expect(pnlFor(paper)).toBeCloseTo(0, 8);
    expect(pnlFor(later)).toBeCloseTo(0, 8);
  });

  it("A7: returns null for an unknown mint instead of crediting a stranger", () => {
    livePos("mintA", now() - 5000, { open: 0.5, close: 0.5 });
    expect(creditRentReclaim("mintZ", 0.002, now())).toBeNull();
    expect(bookPnl()).toBeCloseTo(0, 8);
  });

  it("ignores a non-positive or non-finite amount", () => {
    const id = livePos("mintA", now() - 5000, { open: 0.5, close: 0.5 });
    expect(creditRentReclaim("mintA", 0, now())).toBeNull();
    expect(creditRentReclaim("mintA", Number.NaN, now())).toBeNull();
    expect(pnlFor(id)).toBeCloseTo(0, 8);
  });
});

describe("creditRentReclaim — cases the real ledger turned up", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());

  it("A8: with no unpaid entry left, the newest earlier position in the mint takes it", () => {
    const t = now() - 30_000;
    const only = livePos("mintA", t, { open: 0.502, close: 0.5 });
    expect(creditRentReclaim("mintA", 0.002, t + 3000)).toBe(only);
    reclaimEvent(t + 3000, 0.002, ["mintA"]);
    // dust re-created the account; the sweep reclaimed it again with no new entry
    expect(creditRentReclaim("mintA", 0.002, t + 6000)).toBe(only);
    expect(bookPnl()).toBeCloseTo(-0.002 + 0.004, 8);
  });

  it("A10: an older reclaim replayed after a newer one still finds its own payer", () => {
    const t = now() - 90_000;
    const first = livePos("mintA", t, { open: 0.502, close: 0.5 });
    const second = livePos("mintA", t + 6000, { open: 0.502, close: 0.5 });
    expect(creditRentReclaim("mintA", 0.002, t + 9000)).toBe(first); // newer event first: earliest unpaid entry
    // ...then the older event, dated before `second` existed: nothing earlier is unpaid, so `first` again
    expect(creditRentReclaim("mintA", 0.002, t + 3000)).toBe(first);
    expect(pnlFor(second)).toBeCloseTo(-0.002, 8);
  });
});

describe("creditRentReclaim — found in review", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());

  // A11: A and B share one account life (B re-entered before the sweep ran), the
  // reclaim goes to A. C then re-creates the account. "First position after the
  // newest credited row" picked B for the second reclaim — B never paid rent.
  it("A11: an account life is bounded by reclaims, not by which rows already hold a credit", () => {
    const t = now() - 90_000;
    const a = livePos("mintA", t, { open: 0.502, close: 0.5 });
    const b = livePos("mintA", t + 100, { open: 0.5, close: 0.5 });
    reclaimEvent(t + 3000, 0.002, ["mintA"]);
    const c = livePos("mintA", t + 6000, { open: 0.502, close: 0.5 });
    reclaimEvent(t + 9000, 0.002, ["mintA"]);
    backfillRentReclaims();
    expect(pnlFor(a)).toBeCloseTo(0, 8);
    expect(pnlFor(b)).toBeCloseTo(0, 8);
    expect(pnlFor(c)).toBeCloseTo(0, 8);
  });
});

describe("attributeLegacyRentReclaims", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());
  const legacy = (ts: number, sol: number, accounts: string[]) => getDb().prepare(
    "INSERT INTO events (position_id, ts, type, tx_sig, sol_delta, detail_json) VALUES (NULL, ?, 'rent_reclaim', 's', ?, ?)"
  ).run(ts, sol, JSON.stringify({ accounts }));
  const unattributed = () => Number((getDb().prepare("SELECT value FROM meta WHERE key = 'rent_reclaim_unattributed_sol'").get() as { value: string } | undefined)?.value ?? 0);

  it("A9: maps each closed account back to its mint, credits it, and takes it off the unattributed total — once", () => {
    const t = now() - 50_000;
    const a = livePos("mintA", t, { open: 0.502, close: 0.5 });
    const b = livePos("mintB", t + 10, { open: 0.502, close: 0.5 });
    legacy(t + 3000, 0.004, ["ataA", "ataB"]);
    expect(backfillRentReclaims().unattributedSol).toBeCloseTo(0.004, 9);
    const index = new Map([["ataA", "mintA"], ["ataB", "mintB"]]);
    const r = attributeLegacyRentReclaims((acct) => index.get(acct) ?? null);
    expect(r.creditedSol).toBeCloseTo(0.004, 9);
    expect(unattributed()).toBeCloseTo(0, 9);
    expect(pnlFor(a)).toBeCloseTo(0, 8);
    expect(pnlFor(b)).toBeCloseTo(0, 8);
    expect(attributeLegacyRentReclaims((acct) => index.get(acct) ?? null).creditedSol).toBe(0);
    expect(backfillRentReclaims().creditedSol).toBe(0); // a restart does not replay the rewritten event
    expect(bookPnl()).toBeCloseTo(0, 8);
  });

  it("leaves an event alone unless every one of its accounts can be mapped", () => {
    const t = now() - 50_000;
    const a = livePos("mintA", t, { open: 0.502, close: 0.5 });
    legacy(t + 3000, 0.004, ["ataA", "ataUnknown"]);
    backfillRentReclaims();
    const r = attributeLegacyRentReclaims((acct) => (acct === "ataA" ? "mintA" : null));
    expect(r.creditedSol).toBe(0);
    expect(unattributed()).toBeCloseTo(0.004, 9);
    expect(pnlFor(a)).toBeCloseTo(-0.002, 8);
  });
});

describe("backfillRentReclaims", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());

  it("A3: a batch reclaim is split across its accounts and the book gains exactly the tx delta", () => {
    const t = now() - 50_000;
    const a = livePos("mintA", t, { open: 0.502, close: 0.5 });
    const b = livePos("mintB", t + 10, { open: 0.502, close: 0.5 });
    reclaimEvent(t + 3000, 0.00399, ["mintA", "mintB"]);
    const before = bookPnl();
    const r = backfillRentReclaims();
    expect(r.creditedSol).toBeCloseTo(0.00399, 8);
    expect(r.unattributedSol).toBeCloseTo(0, 8);
    expect(bookPnl() - before).toBeCloseTo(0.00399, 8);
    expect(pnlFor(a)).toBeCloseTo(-0.002 + 0.001995, 8);
    expect(pnlFor(b)).toBeCloseTo(-0.002 + 0.001995, 8);
  });

  it("A5: running it twice changes nothing the second time", () => {
    const t = now() - 50_000;
    livePos("mintA", t, { open: 0.502, close: 0.5 });
    reclaimEvent(t + 3000, 0.002, ["mintA"]);
    backfillRentReclaims();
    const once = bookPnl();
    const again = backfillRentReclaims();
    expect(again.creditedSol).toBe(0);
    expect(bookPnl()).toBeCloseTo(once, 10);
  });

  it("A7: an event with no token list falls back to its position, and an unattributable one is counted", () => {
    const t = now() - 50_000;
    const a = livePos("mintA", t, { open: 0.502, close: 0.5 });
    getDb().prepare(
      "INSERT INTO events (position_id, ts, type, tx_sig, sol_delta, detail_json) VALUES (?, ?, 'rent_reclaim', 's1', 0.002, ?)"
    ).run(a, t + 3000, JSON.stringify({ accounts: ["x"] }));
    getDb().prepare(
      "INSERT INTO events (position_id, ts, type, tx_sig, sol_delta, detail_json) VALUES (NULL, ?, 'rent_reclaim', 's2', 0.0015, ?)"
    ).run(t + 4000, JSON.stringify({ accounts: ["y"] }));
    reclaimEvent(t + 5000, null, ["mintA"]); // tx never became fetchable: unknown, not zero
    const r = backfillRentReclaims();
    expect(r.creditedSol).toBeCloseTo(0.002, 8);
    expect(r.unattributedSol).toBeCloseTo(0.0015, 8);
    expect(pnlFor(a)).toBeCloseTo(0, 8);
  });

  it("replays history in order, so each reclaim finds the entry that paid for that account", () => {
    const t = now() - 90_000;
    const first = livePos("mintA", t, { open: 0.502, close: 0.5 });
    reclaimEvent(t + 3000, 0.002, ["mintA"]);
    const second = livePos("mintA", t + 6000, { open: 0.502, close: 0.5 });
    const third = livePos("mintA", t + 7000, { open: 0.5, close: 0.5 });
    reclaimEvent(t + 9000, 0.002, ["mintA"]);
    backfillRentReclaims();
    expect(pnlFor(first)).toBeCloseTo(0, 8);
    expect(pnlFor(second)).toBeCloseTo(0, 8);
    expect(pnlFor(third)).toBeCloseTo(0, 8);
  });
});

describe("backfillProfitBurns", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());

  it("A4: debits each accrual to the position named in its note, once", () => {
    const id = insertClosedPosition({ entrySol: 1, exitSol: 1.1, openCostSol: 1, closeReturnSol: 1.1, mode: "live" });
    const other = insertClosedPosition({ entrySol: 1, exitSol: 1.2, openCostSol: 1, closeReturnSol: 1.2, mode: "live" });
    const ins = getDb().prepare("INSERT INTO ledger (ts, kind, sol, note) VALUES (?, ?, ?, ?)");
    ins.run(now(), "profit_burn_accrue", 0.001, `pos#${id} TST pnl=+0.100000 share=0.001000`);
    ins.run(now(), "profit_burn_accrue", 0.002, `pos#${other} TST pnl=+0.200000 share=0.002000`);
    ins.run(now(), "profit_burn", 0.003, `pos#${other} TST pnl=+0.2 burned≥1 of mint sig=abc`); // the spend, not a second fee
    ins.run(now(), "profit_burn_accrue", 0.0005, "pos#99999 GONE pnl=+0.05 share=0.0005");
    const r = backfillProfitBurns();
    expect(r.debitedSol).toBeCloseTo(0.003, 8);
    expect(r.unattributedSol).toBeCloseTo(0.0005, 8);
    expect(pnlFor(id)).toBeCloseTo(0.099, 8);
    expect(pnlFor(other)).toBeCloseTo(0.198, 8);
    expect(backfillProfitBurns().debitedSol).toBe(0); // A5
    expect(pnlFor(id)).toBeCloseTo(0.099, 8);
  });
});

describe("backfillProfitBurns — paper never spends", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());

  // A12 (review): the ledger has no mode column, so a paper accrual debited the
  // paper position — shrinking the paper wallet and restating paper days the
  // promotion streak is counted on, for a fee paper mode never pays.
  it("A12: a paper position's accrual is neither debited nor reported as unattributed", () => {
    const paper = insertClosedPosition({ entrySol: 1, exitSol: 1.1, openCostSol: 1, closeReturnSol: 1.1, mode: "paper" });
    getDb().prepare("INSERT INTO ledger (ts, kind, sol, note) VALUES (?, 'profit_burn_accrue', 0.001, ?)")
      .run(now(), `pos#${paper} TST pnl=+0.100000 share=0.001000`);
    const r = backfillProfitBurns();
    expect(r).toEqual({ debitedSol: 0, unattributedSol: 0 });
    expect(pnlFor(paper)).toBeCloseTo(0.1, 9);
  });
});

describe("the dashboard formula", () => {
  // A6: deploy/lib runs under plain node and cannot import this module, so the
  // two definitions are compared as text. Every term must match.
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  it("is the same expression as REALIZED_PNL_SQL", () => {
    const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
    const src = readFileSync(join(root, "deploy", "lib", "live-book-snapshot.mjs"), "utf8");
    const strand = /const STRANDED_CREDIT = `([\s\S]*?)`;/.exec(src)?.[1];
    const pnl = /export const REALIZED_PNL = `([\s\S]*?)`;/.exec(src)?.[1];
    expect(strand, "STRANDED_CREDIT not found").toBeTruthy();
    expect(pnl, "REALIZED_PNL not found").toBeTruthy();
    const dash = norm(pnl!.replaceAll("${STRANDED_CREDIT}", strand!));
    expect(dash).toBe(norm(REALIZED_PNL_SQL));
  });
});
