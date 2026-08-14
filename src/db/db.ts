import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

// Schema per STRATEGY.md §7. On-chain state is the source of truth for live
// positions; this DB is the ledger, decision log, and tuning dataset.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  creator TEXT,
  launchpad TEXT,
  first_seen INTEGER NOT NULL,
  last_vet_json TEXT,
  name TEXT,
  icon_url TEXT,
  meta_updated_ts INTEGER
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

-- Structured runtime errors for the dashboard Errors tab (WS via watch snapshot).
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,              -- error | warn | fatal
  source TEXT NOT NULL,             -- farmer | manager | enter | follow | watchdog | dash | …
  code TEXT,                        -- tick | open_failed | position_act | …
  message TEXT NOT NULL,
  stack TEXT,
  detail_json TEXT,
  position_id INTEGER,
  symbol TEXT,
  mint TEXT,
  pool TEXT,
  build TEXT,
  host TEXT,
  pid INTEGER
);
CREATE INDEX IF NOT EXISTS idx_error_log_ts ON error_log(ts DESC);
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
  try { database.exec("ALTER TABLE tokens ADD COLUMN name TEXT"); } catch { /* */ }
  try { database.exec("ALTER TABLE tokens ADD COLUMN icon_url TEXT"); } catch { /* */ }
  try { database.exec("ALTER TABLE tokens ADD COLUMN meta_updated_ts INTEGER"); } catch { /* */ }
  database.exec(`
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  code TEXT,
  message TEXT NOT NULL,
  stack TEXT,
  detail_json TEXT,
  position_id INTEGER,
  symbol TEXT,
  mint TEXT,
  pool TEXT,
  build TEXT,
  host TEXT,
  pid INTEGER
);
CREATE INDEX IF NOT EXISTS idx_error_log_ts ON error_log(ts DESC);
`);
  // Add dismissed AFTER create — CREATE INDEX on a new column must not run in the
  // same IF NOT EXISTS batch as the table (existing DBs skip CREATE TABLE and then
  // blow up on the index). That crash surfaced as "reconcile failed: no such column".
  try {
    database.exec("ALTER TABLE error_log ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0");
  } catch { /* column already exists */ }
  try {
    database.exec("CREATE INDEX IF NOT EXISTS idx_error_log_active ON error_log(dismissed, ts DESC)");
  } catch { /* */ }

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

export type ErrorLevel = "error" | "warn" | "fatal";

export type LogErrorInput = {
  source: string;
  level?: ErrorLevel;
  code?: string | null;
  message: string;
  err?: unknown;
  detail?: unknown;
  positionId?: number | null;
  symbol?: string | null;
  mint?: string | null;
  pool?: string | null;
  /** Skip insert if same source+code+message landed within this many seconds (default 60). */
  dedupeSec?: number;
};

let cachedBuild: string | null | undefined;
let cachedHost: string | null | undefined;

function runtimeBuild(): string | null {
  if (cachedBuild !== undefined) return cachedBuild;
  try {
    cachedBuild = execSync("git describe --always --dirty", { encoding: "utf8" }).trim() || null;
  } catch {
    cachedBuild = null;
  }
  return cachedBuild;
}

function runtimeHost(): string | null {
  if (cachedHost !== undefined) return cachedHost;
  try {
    cachedHost = hostname() || null;
  } catch {
    cachedHost = null;
  }
  return cachedHost;
}

function errParts(err: unknown): { message: string; stack: string | null } {
  if (err instanceof Error) {
    return {
      message: (err.message || String(err)).split("\n")[0]!.slice(0, 800),
      stack: err.stack ? err.stack.split("\n").slice(0, 40).join("\n") : null,
    };
  }
  return { message: String(err).split("\n")[0]!.slice(0, 800), stack: null };
}

/**
 * Persist a structured error for the dashboard Errors tab (and always mirror to stderr).
 * Returns the new row id, or 0 if deduped / write failed.
 */
export function logError(input: LogErrorInput): number {
  const level = input.level ?? "error";
  const fromErr = input.err != null ? errParts(input.err) : null;
  const message = (input.message || fromErr?.message || "unknown error").slice(0, 800);
  const stack = fromErr?.stack ?? null;
  const code = input.code ?? null;
  const dedupeSec = input.dedupeSec ?? 60;

  const line = `[${input.source}${code ? `/${code}` : ""}] ${message}`;
  if (level === "warn") console.warn(line);
  else console.error(line);
  if (stack && level !== "warn") console.error(stack.split("\n").slice(1, 8).join("\n"));

  try {
    const database = getDb();
    if (dedupeSec > 0) {
      const recent = database
        .prepare(
          `SELECT id FROM error_log
           WHERE source = ? AND IFNULL(code,'') = IFNULL(?, '') AND message = ? AND ts >= ?
           ORDER BY id DESC LIMIT 1`,
        )
        .get(input.source, code, message, now() - dedupeSec) as { id: number } | undefined;
      if (recent) return 0;
    }
    const info = database
      .prepare(
        `INSERT INTO error_log
          (ts, level, source, code, message, stack, detail_json, position_id, symbol, mint, pool, build, host, pid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now(),
        level,
        input.source,
        code,
        message,
        stack,
        input.detail != null ? JSON.stringify(input.detail) : null,
        input.positionId ?? null,
        input.symbol ?? null,
        input.mint ?? null,
        input.pool ?? null,
        runtimeBuild(),
        runtimeHost(),
        process.pid,
      );
    return Number(info.lastInsertRowid) || 0;
  } catch (e) {
    console.error("[error_log] write failed:", (e as Error).message);
    return 0;
  }
}

/** Install once — captures crash paths that never hit a local try/catch. */
export function installProcessErrorHooks(source = "farmer"): void {
  const tag = source;
  process.on("uncaughtException", (err) => {
    logError({ source: tag, level: "fatal", code: "uncaughtException", message: err.message, err, dedupeSec: 0 });
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logError({ source: tag, level: "fatal", code: "unhandledRejection", message: err.message, err, dedupeSec: 5 });
  });
}

export type TokenMeta = {
  mint: string;
  symbol: string | null;
  name: string | null;
  icon_url: string | null;
  meta_updated_ts: number | null;
};

/** Upsert display metadata (symbol/name/icon) — never clears existing non-null fields with null. */
export function upsertTokenMeta(
  mint: string,
  meta: { symbol?: string | null; name?: string | null; icon_url?: string | null },
): void {
  if (!mint) return;
  const symbol = meta.symbol?.trim() || null;
  const name = meta.name?.trim() || null;
  const icon = meta.icon_url?.trim() || null;
  if (!symbol && !name && !icon) return;
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO tokens (mint, symbol, name, icon_url, meta_updated_ts, first_seen)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(mint) DO UPDATE SET
         symbol = COALESCE(excluded.symbol, tokens.symbol),
         name = COALESCE(excluded.name, tokens.name),
         icon_url = COALESCE(excluded.icon_url, tokens.icon_url),
         meta_updated_ts = excluded.meta_updated_ts`,
    )
    .run(mint, symbol, name, icon, ts, ts);
}

export function getTokenMetaMap(mints: string[]): Record<string, TokenMeta> {
  const uniq = [...new Set(mints.filter(Boolean))];
  if (!uniq.length) return {};
  const out: Record<string, TokenMeta> = {};
  const stmt = getDb().prepare(
    `SELECT mint, symbol, name, icon_url, meta_updated_ts FROM tokens WHERE mint = ?`,
  );
  for (const mint of uniq) {
    const row = stmt.get(mint) as TokenMeta | undefined;
    if (row) out[mint] = row;
  }
  return out;
}
