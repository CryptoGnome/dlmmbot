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

-- Instrumentation for the range-shape decision (RANGE-SHAPE-DECISION.md).
-- One row per 15s manager poll per open position. pool_snapshots is the only
-- price history we have and it samples at p50 65s, which has hidden
-- single-interval jumps of up to 91 bins — too coarse to measure how deep a
-- position actually traversed. Read-only side effect of a mark() we already do
-- and already throw away. ~240 rows per hour-long position.
CREATE TABLE IF NOT EXISTS position_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  active_bin_id INTEGER,
  price REAL,
  value_sol REAL,
  value_frac REAL,               -- value_sol / entry_sol, the P1 stop's input
  unclaimed_fees_sol REAL,
  in_range INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_position_marks ON position_marks(position_id, ts);

CREATE TABLE IF NOT EXISTS config_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  toml TEXT NOT NULL
);

-- Follow mode (up-only re-entry after a P3 up-and-out close). One row per
-- chain; legs are ordinary positions rows carrying follow_chain_id. The state
-- machine lives in manager/follow.ts; everything it needs to survive a restart
-- (peaks, streaks, budget) is persisted here every tick.
CREATE TABLE IF NOT EXISTS follow_chains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,               -- paper | live
  pool TEXT NOT NULL,
  token_mint TEXT NOT NULL,
  symbol TEXT,
  origin_position_id INTEGER NOT NULL,
  started_ts INTEGER NOT NULL,
  state TEXT NOT NULL,              -- awaiting_high | awaiting_dip | leg_open | done
  end_reason TEXT,                  -- set when state = done
  legs INTEGER NOT NULL DEFAULT 0,
  chain_pnl_sol REAL NOT NULL DEFAULT 0,
  chain_high REAL NOT NULL,         -- highest price seen since the chain started
  high_mark REAL NOT NULL,          -- chain_high at last leg close; must be exceeded to re-arm
  arm_peak REAL,                    -- running max since awaiting_dip began (dip reference)
  cold_streak INTEGER NOT NULL DEFAULT 0,
  last_leg_position_id INTEGER,
  updated_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_follow_chains_state ON follow_chains(state, mode);
`;

let db: Database.Database | null = null;

function migrate(database: Database.Database): void {
  database.pragma("journal_mode = WAL");
  database.exec(SCHEMA);
  // Idempotent migrations for columns added after the initial schema.
  try {
    database.exec("ALTER TABLE positions ADD COLUMN ever_in_range INTEGER NOT NULL DEFAULT 0");
  } catch { /* column already exists */ }
  try {
    database.exec("ALTER TABLE positions ADD COLUMN open_cost_sol REAL");
  } catch { /* column already exists */ }
  try {
    database.exec("ALTER TABLE positions ADD COLUMN close_return_sol REAL");
  } catch { /* column already exists */ }
  try {
    database.exec("ALTER TABLE positions ADD COLUMN fell_deep INTEGER NOT NULL DEFAULT 0");
  } catch { /* column already exists */ }
  try {
    database.exec("ALTER TABLE positions ADD COLUMN fees_measured_sol REAL NOT NULL DEFAULT 0");
  } catch { /* column already exists */ }
  try {
    database.exec("ALTER TABLE positions ADD COLUMN recovered_sol REAL NOT NULL DEFAULT 0");
  } catch { /* column already exists */ }
  try {
    database.exec("ALTER TABLE positions ADD COLUMN fees_at_close_sol REAL NOT NULL DEFAULT 0");
  } catch { /* column already exists */ }
  try {
    database.exec("ALTER TABLE positions ADD COLUMN follow_chain_id INTEGER");
  } catch { /* column already exists */ }
  database.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

  const cols = new Set(
    (database.prepare("PRAGMA table_info(positions)").all() as Array<{ name: string }>).map((c) => c.name)
  );
  const required = [
    "ever_in_range", "open_cost_sol", "close_return_sol", "fell_deep",
    "fees_measured_sol", "recovered_sol", "fees_at_close_sol", "follow_chain_id",
  ];
  const missing = required.filter((c) => !cols.has(c));
  if (missing.length)
    throw new Error(`positions table is missing migrated column(s): ${missing.join(", ")} — migration failed, refusing to start`);
}

/** Open and migrate a DB at an arbitrary path (tests use :memory: or a temp file). */
export function openDb(path: string): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(resolve(path, ".."), { recursive: true });
  }
  const database = new Database(path);
  migrate(database);
  return database;
}

export function getDb(): Database.Database {
  if (!db) {
    const path = process.env.FARMER_DB_PATH ?? resolve(process.cwd(), "data", "farmer.db");
    if (path !== ":memory:") mkdirSync(resolve(path, ".."), { recursive: true });
    db = openDb(path);
  }
  return db;
}

/** Close the singleton so the next getDb() opens FARMER_DB_PATH fresh (tests only). */
export function _resetDbForTests(): void {
  if (db) {
    try { db.close(); } catch { /* already closed */ }
    db = null;
  }
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
  let payload: unknown = features;
  if (features && typeof features === "object" && !Array.isArray(features)) {
    const f = features as Record<string, unknown>;
    const cand = f.cand && typeof f.cand === "object" ? f.cand as Record<string, unknown> : null;
    const poolObj = f.pool && typeof f.pool === "object" ? f.pool as Record<string, unknown> : null;
    const symbol =
      (typeof f.symbol === "string" && f.symbol) ||
      (typeof cand?.symbol === "string" && cand.symbol) ||
      (typeof poolObj?.symbol === "string" && poolObj.symbol) ||
      null;
    payload = symbol && f.symbol !== symbol ? { ...f, symbol } : f;
  }
  getDb()
    .prepare(
      "INSERT INTO decisions (ts, mint, pool, action, failed_gate, score, features_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(now(), mint, pool, action, failedGate, score, JSON.stringify(payload));
}
