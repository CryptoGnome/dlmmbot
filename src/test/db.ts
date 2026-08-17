import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTests, now } from "../db/db.js";

/** Open an isolated :memory: DB via getDb() (FARMER_DB_PATH). */
export function useMemoryDb(): void {
  _resetDbForTests();
  process.env.FARMER_DB_PATH = ":memory:";
  getDb();
}

/** Temp-file DB when WAL / multi-connection behavior matters. */
export function useTempDb(): string {
  _resetDbForTests();
  const dir = mkdtempSync(join(tmpdir(), "farmer-test-"));
  const path = join(dir, "t.db");
  process.env.FARMER_DB_PATH = path;
  getDb();
  return path;
}

export function resetTestDb(): void {
  _resetDbForTests();
  delete process.env.FARMER_DB_PATH;
}

export function insertClosedPosition(opts: {
  entrySol: number;
  exitSol: number | null;
  exitReason?: string;
  exitTs?: number;
  feesClaimedSol?: number;
  openCostSol?: number | null;
  closeReturnSol?: number | null;
  feesMeasuredSol?: number;
  recoveredSol?: number;
  withdrawnSol?: number;
  followChainId?: number | null;
  mode?: string;
  strandedSol?: number;
  /** Seconds ago the strand was recorded; drives the STRANDED_GRACE_S expiry. */
  strandedAgeS?: number;
}): number {
  const ts = opts.exitTs ?? now();
  const res = getDb().prepare(
    `INSERT INTO positions (
       mode, pool, token_mint, symbol, entry_ts, entry_price, entry_sol,
       min_bin_id, max_bin_id, state, fees_claimed_sol, rent_paid_sol,
       exit_ts, exit_sol, exit_reason, open_cost_sol, close_return_sol,
       fees_measured_sol, recovered_sol, withdrawn_sol, follow_chain_id,
       stranded_sol, stranded_at
     ) VALUES (?, 'pool', 'mint', 'TST', ?, 1, ?, 1, 10, 'closed_win', ?, 0,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    // Default "paper", matching the mode the test process runs in — the risk
    // queries filter on currentMode() and would silently skip "live" rows.
    opts.mode ?? "paper",
    ts - 3600,
    opts.entrySol,
    opts.feesClaimedSol ?? 0,
    ts,
    opts.exitSol,
    opts.exitReason ?? "P3_above",
    opts.openCostSol === undefined ? null : opts.openCostSol,
    opts.closeReturnSol === undefined ? null : opts.closeReturnSol,
    opts.feesMeasuredSol ?? 0,
    opts.recoveredSol ?? 0,
    opts.withdrawnSol ?? 0,
    opts.followChainId === undefined ? null : opts.followChainId,
    opts.strandedSol ?? 0,
    opts.strandedSol ? now() - (opts.strandedAgeS ?? 0) : null,
  );
  return Number(res.lastInsertRowid);
}

export function insertOpenPosition(opts?: {
  entrySol?: number;
  entryPrice?: number;
  minBinId?: number;
  maxBinId?: number;
  entryTs?: number;
  symbol?: string;
  mode?: string;
  everInRange?: number;
  fellDeep?: number;
  followChainId?: number | null;
}): number {
  const res = getDb().prepare(
    `INSERT INTO positions (
       mode, pool, token_mint, symbol, entry_ts, entry_price, entry_sol,
       min_bin_id, max_bin_id, state, fees_claimed_sol, rent_paid_sol,
       ever_in_range, fell_deep, follow_chain_id, open_cost_sol
     ) VALUES (?, 'pool1', 'mint1', ?, ?, ?, ?, ?, ?, 'open', 0, 0, ?, ?, ?, ?)`
  ).run(
    opts?.mode ?? "paper",
    opts?.symbol ?? "TST",
    opts?.entryTs ?? now() - 600,
    opts?.entryPrice ?? 1,
    opts?.entrySol ?? 0.3,
    opts?.minBinId ?? 100,
    opts?.maxBinId ?? 200,
    opts?.everInRange ?? 0,
    opts?.fellDeep ?? 0,
    opts?.followChainId ?? null,
    (opts?.entrySol ?? 0.3) + 0.01,
  );
  return Number(res.lastInsertRowid);
}
