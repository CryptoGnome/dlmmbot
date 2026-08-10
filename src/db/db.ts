import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Schema per STRATEGY.md §7. On-chain state is the source of truth for live
// positions; this DB is the ledger, decision log, and tuning dataset.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  creator TEXT,
  launchpad TEXT,
  first_seen INTEGER NOT NULL,
  last_vet_json TEXT
);

CREATE TABLE IF NOT EXISTS creators (
  address TEXT PRIMARY KEY,
  tokens_launched INTEGER NOT NULL DEFAULT 0,
  rug_count INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pools (
  address TEXT PRIMARY KEY,
  token_mint TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  bin_step INTEGER,
  base_fee_pct REAL,
  first_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pool_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool TEXT NOT NULL,
  ts INTEGER NOT NULL,
  tvl_usd REAL, price REAL,
  vol_30m REAL, vol_1h REAL, vol_24h REAL,
  fee_tvl_30m REAL, fee_tvl_24h REAL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_pool_ts ON pool_snapshots(pool, ts);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,               -- paper | live
  pool TEXT NOT NULL,
  token_mint TEXT NOT NULL,
  symbol TEXT,
  tranche_of INTEGER,
  entry_ts INTEGER NOT NULL,
  entry_price REAL NOT NULL,
  entry_sol REAL NOT NULL,
  min_bin_id INTEGER NOT NULL,
  max_bin_id INTEGER NOT NULL,
  state TEXT NOT NULL,
  fees_claimed_sol REAL NOT NULL DEFAULT 0,
  rent_paid_sol REAL NOT NULL DEFAULT 0,
  profit_lock_fires INTEGER NOT NULL DEFAULT 0,
  exit_ts INTEGER,
  exit_sol REAL,
  exit_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_positions_state ON positions(state);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  tx_sig TEXT,
  sol_delta REAL,                   -- SOL value moved (+in wallet / -deployed)
  token_amount REAL,
  tx_cost_sol REAL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_position ON events(position_id, ts);

-- The tuning dataset: every enter/skip/exit with full feature vector.
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  mint TEXT NOT NULL,
  pool TEXT,
  action TEXT NOT NULL,             -- entered | skipped | exited
  failed_gate TEXT,                 -- which gate rejected it (skips)
  score REAL,
  features_json TEXT NOT NULL,
  outcome_backfill_json TEXT        -- filled later: what the token did after
);
CREATE INDEX IF NOT EXISTS idx_decisions_mint ON decisions(mint, ts);

CREATE TABLE IF NOT EXISTS pnl_daily (
  day TEXT PRIMARY KEY,             -- YYYY-MM-DD (UTC)
  mode TEXT NOT NULL,
  realized_sol REAL NOT NULL DEFAULT 0,
  unrealized_sol REAL NOT NULL DEFAULT 0,
  fees_sol REAL NOT NULL DEFAULT 0,
  costs_sol REAL NOT NULL DEFAULT 0,  -- rent + gas
  sol_usd REAL
);

CREATE TABLE IF NOT EXISTS blacklist (
  key TEXT PRIMARY KEY,             -- mint or creator address
  kind TEXT NOT NULL,               -- token | creator
  reason TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  expires_ts INTEGER                -- NULL = permanent
);

-- On-chain position accounts backing a live position (1..N per position row).
CREATE TABLE IF NOT EXISTS position_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL,
  pubkey TEXT NOT NULL,
  min_bin_id INTEGER,
  max_bin_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_position_accounts ON position_accounts(position_id);

CREATE TABLE IF NOT EXISTS ledger (                -- banked balance (§5)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,               -- bank | release
  sol REAL NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS config_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  toml TEXT NOT NULL
);
`;

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dir = resolve(process.cwd(), "data");
    mkdirSync(dir, { recursive: true });
    db = new Database(resolve(dir, "farmer.db"));
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    // Idempotent migrations for columns added after the initial schema.
    try {
      db.exec("ALTER TABLE positions ADD COLUMN ever_in_range INTEGER NOT NULL DEFAULT 0");
    } catch { /* column already exists */ }
    try {
      db.exec("ALTER TABLE positions ADD COLUMN open_cost_sol REAL");   // actual wallet debit at open (size + rent + tx)
    } catch { /* column already exists */ }
    try {
      db.exec("ALTER TABLE positions ADD COLUMN close_return_sol REAL"); // actual wallet credit at close (exit + rent refund - tx)
    } catch { /* column already exists */ }
    try {
      db.exec("ALTER TABLE positions ADD COLUMN fell_deep INTEGER NOT NULL DEFAULT 0"); // escape hatch armed (survives restarts)
    } catch { /* column already exists */ }
    // fees_claimed_sol is a pool-mid MARK and stays that way — the Kelly
    // estimator reads it and changing it silently would move position sizing.
    // These two carry the measured truth alongside it: what the claim txs
    // actually credited, and what the residual sweep later recovered for a
    // claim/close swap that failed (real income that used to land only in
    // `ledger`, attributed to no position at all).
    try {
      db.exec("ALTER TABLE positions ADD COLUMN fees_measured_sol REAL NOT NULL DEFAULT 0");
    } catch { /* column already exists */ }
    try {
      db.exec("ALTER TABLE positions ADD COLUMN recovered_sol REAL NOT NULL DEFAULT 0");
    } catch { /* column already exists */ }
    // Every close runs shouldClaimAndClose, so it collects whatever fees had
    // accrued since the last claim — but nothing recorded them, and 17 of the
    // first 20 positions therefore read fees_claimed_sol = 0 despite earning.
    // Kept separate from fees_claimed_sol on purpose: close_return_sol already
    // contains this SOL, so adding it there would double-count it against
    // exit_sol and move Kelly. This column is for attribution, not for PnL.
    try {
      db.exec("ALTER TABLE positions ADD COLUMN fees_at_close_sol REAL NOT NULL DEFAULT 0");
    } catch { /* column already exists */ }
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

    // Those ALTERs are wrapped in `catch {}` to be idempotent, which also
    // swallows a genuine failure (SQLITE_BUSY, disk full). The bot would then
    // boot, trade normally, and throw `no such column` at the first close —
    // after the on-chain removal, leaving a zombie row holding a slot with no
    // alert. Assert instead, so a bad migration is a boot failure pm2 surfaces.
    const cols = new Set(
      (db.prepare("PRAGMA table_info(positions)").all() as Array<{ name: string }>).map((c) => c.name)
    );
    const required = [
      "ever_in_range", "open_cost_sol", "close_return_sol", "fell_deep",
      "fees_measured_sol", "recovered_sol", "fees_at_close_sol",
    ];
    const missing = required.filter((c) => !cols.has(c));
    if (missing.length)
      throw new Error(`positions table is missing migrated column(s): ${missing.join(", ")} — migration failed, refusing to start`);
  }
  return db;
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Per-row realized PnL, as a SQL fragment. ONE definition, because there used to
 * be three: `npm run status`, the daily rollup and the circuit breaker each
 * carried their own SUM and returned 0.1323 / 0.2303 / 0.2303 for the same book.
 *
 *   1. measured wallet delta where we have it — the truth,
 *   2. the old notional mark for rows closed before those columns existed,
 *   3. zero for adopted rows (entry_sol = 0, no cost basis), which would
 *      otherwise report exit_sol as pure profit and mask a real loss.
 *
 * Lives in db.ts so every consumer can import it without an import cycle.
 */
export const REALIZED_PNL_SQL = `
  CASE WHEN open_cost_sol IS NOT NULL AND close_return_sol IS NOT NULL
       THEN close_return_sol + fees_measured_sol + recovered_sol - open_cost_sol
       WHEN entry_sol > 0
       THEN exit_sol - entry_sol + fees_claimed_sol
       ELSE 0 END`;

// ---- blacklist helpers (STRATEGY.md §6) ----

export function isBlacklisted(key: string): string | null {
  const row = getDb()
    .prepare("SELECT reason, expires_ts FROM blacklist WHERE key = ?")
    .get(key) as { reason: string; expires_ts: number | null } | undefined;
  if (!row) return null;
  if (row.expires_ts !== null && row.expires_ts < now()) {
    getDb().prepare("DELETE FROM blacklist WHERE key = ?").run(key);
    return null;
  }
  return row.reason;
}

export function blacklist(key: string, kind: "token" | "creator", reason: string, ttlHours?: number): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO blacklist (key, kind, reason, created_ts, expires_ts) VALUES (?, ?, ?, ?, ?)"
    )
    .run(key, kind, reason, now(), ttlHours ? now() + ttlHours * 3600 : null);
}

export function recordDecision(
  mint: string,
  pool: string | null,
  action: "entered" | "skipped" | "exited",
  failedGate: string | null,
  score: number | null,
  features: unknown
): void {
  getDb()
    .prepare(
      "INSERT INTO decisions (ts, mint, pool, action, failed_gate, score, features_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(now(), mint, pool, action, failedGate, score, JSON.stringify(features));
}
