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
  }
  return db;
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

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
