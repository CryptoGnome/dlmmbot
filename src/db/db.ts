import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { resolveBuildLabel } from "../buildLabel.js";
import { currentMode } from "../config.js";
import { presentError } from "../errors/present.js";

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
  day TEXT NOT NULL,                -- YYYY-MM-DD (UTC)
  mode TEXT NOT NULL,
  realized_sol REAL NOT NULL DEFAULT 0,
  unrealized_sol REAL NOT NULL DEFAULT 0,
  fees_sol REAL NOT NULL DEFAULT 0,
  costs_sol REAL NOT NULL DEFAULT 0,  -- rent + gas
  sol_usd REAL,
  PRIMARY KEY (day, mode)           -- day-only key let a mid-day mode flip clobber the paper promotion row
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
  in_range INTEGER NOT NULL DEFAULT 0,
  -- Pool health the executor already fetches for P0/P2 on every mark. Recorded
  -- since v0.19.1 so the backtester can replay tvl_drain and rotation decay,
  -- which were 39% of closed positions and unsimulatable without them.
  tvl_usd REAL,
  vol_30m_usd REAL,
  fee_tvl_30m_pct REAL,
  pool_age_s REAL,
  -- Fees banked by this mark. Without it, claims can only be inferred from
  -- unclaimed dropping, and value_sol already contains the unclaimed part --
  -- the ambiguity that produced a double-count in the first sim scripts.
  fees_claimed_cum_sol REAL
);
CREATE INDEX IF NOT EXISTS idx_position_marks ON position_marks(position_id, ts);

-- Price after a position closed, backfilled from GeckoTerminal by
-- npm run sim:backfill. A position's own marks stop at its exit, so without
-- this the backtester can only judge exiting EARLIER; these bars are what make
-- "did we cut a recovery?" answerable. Minute bars, one row per bar.
CREATE TABLE IF NOT EXISTS post_exit_prices (
  position_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,               -- bar open, unix seconds
  open REAL, high REAL, low REAL, close REAL,
  PRIMARY KEY (position_id, ts)
);

-- One row per position attempted, so a backfill is resumable and its failures
-- are visible rather than looking like "no recovery happened".
CREATE TABLE IF NOT EXISTS post_exit_backfill (
  position_id INTEGER PRIMARY KEY,
  fetched_ts INTEGER NOT NULL,
  window_min INTEGER NOT NULL,
  bars INTEGER NOT NULL DEFAULT 0,
  -- median(our recorded mark price / the bar close at the same minute) over the
  -- overlap before the exit. An external series is never trusted until it lines
  -- up with what we measured ourselves; ~1 means the same convention.
  calib_ratio REAL,
  calib_n INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL               -- ok | too_recent | no_bars | no_overlap | miscalibrated | error
);

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

/**
 * Bytes the WAL is truncated back to after a checkpoint.
 *
 * Without this, `journal_size_limit` defaults to -1: SQLite rewinds and REUSES
 * the WAL rather than shrinking it, so the file is a permanent high-water mark
 * of the largest burst it ever absorbed. Measured on the server 2026-08-26 —
 * `farmer.db` 199 MB, `farmer.db-wal` **2263 MB**, stable (0 KB growth over
 * 45s), one process attached, no unfinalized iterators. Not a leak: a burst
 * (a 5000-row-at-a-time prune loop, or a marks batch) grew it once and nothing
 * ever gave the space back.
 *
 * 2.3 GB against the server's 60 GB free is untidy. Against Railway's **0.5 GB
 * volume** — the volume that has already hit ENOSPC once, which is why
 * `db_max_mb` defaults to 200 — the same burst would be fatal, and nothing in
 * the ceiling logic would see it coming: `dbFileBytes()` reads `page_count`,
 * which counts the main database only and is blind to the WAL entirely.
 *
 * 64 MB leaves room for the largest transaction here (the prune loop's 5000-row
 * DELETE batches) while capping the idle footprint. The limit applies only when
 * a checkpoint completes — it does not force one — so `wal_autocheckpoint`
 * (1000 pages / 4 MB) remains what drives the checkpointing.
 */
export const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

function migrate(database: Database.Database): void {
  database.pragma("journal_mode = WAL");
  database.pragma(`journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
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
  try {
    database.exec("ALTER TABLE positions ADD COLUMN withdrawn_sol REAL NOT NULL DEFAULT 0");
  } catch { /* column already exists */ }
  try {
    database.exec("ALTER TABLE positions ADD COLUMN stranded_sol REAL NOT NULL DEFAULT 0");
  } catch { /* column already exists */ }
  // Give-back telemetry: the running peak of fee-inclusive PnL, and whether the
  // counterfactual has already been logged for this position. Persisted for the
  // same reason the timers are — a restart that forgot the peak would silently
  // re-arm the experiment and log a second, wrong row.
  for (const col of ["peak_pnl_sol REAL", "give_back_logged INTEGER NOT NULL DEFAULT 0"]) {
    try {
      database.exec(`ALTER TABLE positions ADD COLUMN ${col}`);
    } catch { /* column already exists */ }
  }
  // Exit timers. They used to live only in the manager's memory, so a restart
  // granted a fresh grace window to a position already most of the way through
  // one and reset a part-served stop streak. See hydrateTimers() in
  // manager/loop.ts. The P0 drain window is NOT here — it is rebuilt from
  // position_marks, which already records tvl_usd per mark.
  for (const col of [
    "above_range_since INTEGER", "below_range_since INTEGER",
    "stop_streak INTEGER NOT NULL DEFAULT 0", "decay_streak INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      database.exec(`ALTER TABLE positions ADD COLUMN ${col}`);
    } catch { /* column already exists */ }
  }
  for (const col of [
    "tvl_usd REAL", "vol_30m_usd REAL", "fee_tvl_30m_pct REAL",
    "pool_age_s REAL", "fees_claimed_cum_sol REAL",
  ]) {
    try {
      database.exec(`ALTER TABLE position_marks ADD COLUMN ${col}`);
    } catch { /* column already exists */ }
  }
  // Operator "close this one now" request from the dashboard. The dashboard
  // cannot close a position itself — only the loop holds the executor and the
  // wallet — so it sets this and the next manage tick performs the close.
  try {
    database.exec("ALTER TABLE positions ADD COLUMN close_requested_at INTEGER");
  } catch { /* column already exists */ }
  // When the chain last entered awaiting_dip — the reference for the dip
  // timeout. Measured from here rather than started_ts so a chain that just
  // closed a winning leg (awaiting_high first) is not charged for that wait.
  try {
    database.exec("ALTER TABLE follow_chains ADD COLUMN dip_since_ts INTEGER");
  } catch { /* column already exists */ }
  try {
    database.exec("ALTER TABLE positions ADD COLUMN stranded_at INTEGER");
  } catch { /* column already exists */ }
  // pnl_daily: day-only PK → (day, mode). A paper→live flip mid-day used to
  // overwrite the day's paper row, deleting it from the promotion scoreboard.
  {
    const pk = (database.prepare(
      "SELECT name FROM pragma_table_info('pnl_daily') WHERE pk > 0 ORDER BY pk"
    ).all() as Array<{ name: string }>).map((r) => r.name);
    if (pk.length === 1 && pk[0] === "day") {
      database.exec(`
        CREATE TABLE pnl_daily_migrated (
          day TEXT NOT NULL, mode TEXT NOT NULL,
          realized_sol REAL NOT NULL DEFAULT 0, unrealized_sol REAL NOT NULL DEFAULT 0,
          fees_sol REAL NOT NULL DEFAULT 0, costs_sol REAL NOT NULL DEFAULT 0, sol_usd REAL,
          PRIMARY KEY (day, mode)
        );
        INSERT INTO pnl_daily_migrated SELECT day, mode, realized_sol, unrealized_sol, fees_sol, costs_sol, sol_usd FROM pnl_daily;
        DROP TABLE pnl_daily;
        ALTER TABLE pnl_daily_migrated RENAME TO pnl_daily;
      `);
    }
  }
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
    "withdrawn_sol", "stranded_sol", "stranded_at", "close_requested_at",
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
 *   1. measured wallet delta where we have it — the truth. Requires a cost
 *      basis: adopted rows (entry_sol = 0, open_cost_sol NULL) fall through,
 *      otherwise close proceeds would read as pure profit and mask real losses.
 *   2. the old notional mark for rows closed before those columns existed.
 *      Requires exit_sol: force-closed / reconcile-orphaned rows have no exit
 *      value at all, and treating them as exit 0 fabricated a −entry_sol loss
 *      (a crash mid-close could trip the circuit breaker on a position that
 *      lost nothing).
 *   3. NULL — "unknown", skipped by SUM — for rows with no usable exit or
 *      basis. Consumers dividing by entry_sol must also filter the NULLs.
 *
 * withdrawn_sol: profit-lock withdrawals land in the wallet mid-position and
 * are part of realized PnL; without the term a locked winner closing at 70% of
 * basis read as a loss. Safe to add because open_cost_sol is written at open
 * by BOTH executors and never shrunk (entry_sol is, so it must not be the
 * basis for measured rows).
 *
 * stranded_sol: an under-filled close leaves the token side in the wallet. Those
 * tokens are an ASSET we still hold, not a loss — but close_return_sol only sees
 * the SOL that actually landed, and recovered_sol stays 0 until the residual
 * sweep sells them, up to ten minutes later. In that gap the row reads as a
 * near-total loss. ANSEM pos#8 (2026-08-17) booked -0.5422 SOL at 08:09:53 on a
 * 75%-under-filled close; the sweep sold the residue 112s later for 0.5323 and
 * the true figure was -0.0100. The phantom loss tripped the daily circuit
 * breaker 52 seconds after the close — a wrong number is not cosmetic, it steers
 * the book. So the quoted value of the leftovers (a real Jupiter quote taken at
 * close time) stands in until the sweep replaces it with a measured number.
 *
 * The credit EXPIRES after STRANDED_GRACE_S. That bound is the whole safety
 * argument: if the sweep cannot sell the residue — no route, honeypot, worthless
 * — this is no longer settlement lag but a bag we are actually holding, and the
 * loss must show. A credit that never expired would turn this fix into a way to
 * under-report real losses, which is strictly worse than the bug it fixes.
 * Only the sweep and the close write these columns, and the sweep zeroes
 * stranded_sol as it credits recovered_sol, so the two can never double-count.
 *
 * Lives in db.ts so every consumer can import it without an import cycle.
 */
/** How long a close-time strand estimate may stand in for a measured recovery. */
export const STRANDED_GRACE_S = 30 * 60; // 3 sweep attempts at the 10-min interval

// Unsettled, still-fresh strand value. `strftime` (not a bound parameter)
// because REALIZED_PNL_SQL is interpolated into ~10 call sites whose parameter
// ordering would all have to change.
const STRANDED_CREDIT_SQL = `
  CASE WHEN COALESCE(stranded_sol, 0) > 0
        AND COALESCE(stranded_at, 0) > CAST(strftime('%s', 'now') AS INTEGER) - ${STRANDED_GRACE_S}
       THEN stranded_sol ELSE 0 END`;

export const REALIZED_PNL_SQL = `
  CASE WHEN close_return_sol IS NOT NULL
        AND (open_cost_sol IS NOT NULL OR entry_sol > 0)
       THEN close_return_sol
            + COALESCE(fees_measured_sol, 0)
            + COALESCE(withdrawn_sol, 0)
            + COALESCE(recovered_sol, 0)
            + ${STRANDED_CREDIT_SQL}
            - COALESCE(open_cost_sol, entry_sol + COALESCE(rent_paid_sol, 0))
       WHEN entry_sol > 0 AND exit_sol IS NOT NULL
       THEN exit_sol - entry_sol
            + CASE WHEN COALESCE(fees_measured_sol, 0) > 0
                   THEN fees_measured_sol
                   ELSE COALESCE(fees_claimed_sol, 0) END
            + COALESCE(withdrawn_sol, 0)
            + COALESCE(recovered_sol, 0)
            + ${STRANDED_CREDIT_SQL}
       ELSE NULL END`;

// ---- blacklist helpers (STRATEGY.md §6) ----

/**
 * Reason prefixes written by the bot's OWN exit on a token (P0 safety, P1
 * stop, P5 below-range), as opposed to the meme-vetting gates in vet.ts
 * (holder concentration, insider clusters, rugcheck).
 *
 * The distinction exists for the majors sleeve. Majors is an allowlist of
 * established tokens, so importing meme heuristics there would park the sleeve
 * indefinitely on a false positive — but "we just cut this position for a
 * loss" is sleeve-independent and must block re-entry everywhere.
 */
const EXIT_COOLDOWN_PREFIXES = ["P0 safety exit", "stop loss cooldown", "below range cut", "escape cooldown"];

/** True when a blacklist reason came from an exit rather than from vetting. */
export function isExitCooldown(reason: string): boolean {
  return EXIT_COOLDOWN_PREFIXES.some((p) => reason.startsWith(p));
}

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
  // Never shorten an existing entry: a P0 rug flag is permanent, and the same
  // token's still-open tranche exiting P1/P5 later used to INSERT OR REPLACE
  // it down to a 24h cooldown — making a rugged token re-enterable next day.
  const existing = getDb().prepare("SELECT expires_ts FROM blacklist WHERE key = ?").get(key) as
    | { expires_ts: number | null }
    | undefined;
  const newExpiry = ttlHours ? now() + ttlHours * 3600 : null;
  if (existing) {
    if (existing.expires_ts === null) return; // already permanent
    if (newExpiry !== null && newExpiry <= existing.expires_ts) return; // no downgrade
  }
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO blacklist (key, kind, reason, created_ts, expires_ts) VALUES (?, ?, ?, ?, ?)"
    )
    .run(key, kind, reason, now(), newExpiry);
}

/**
 * One strike (STRATEGY.md §2.2 / §4 P0): increment the creator's rug_count and
 * permanently blacklist the creator key. Called by the manager on P0/rug
 * classification and by anything else that proves a rug. Idempotent-ish: each
 * call is one more strike; the blacklist entry is permanent either way.
 */
export function recordCreatorRug(creator: string, reason = "rugged token (P0)"): void {
  if (!creator) return;
  getDb()
    .prepare(
      `INSERT INTO creators (address, tokens_launched, rug_count, first_seen)
       VALUES (?, 0, 1, ?)
       ON CONFLICT(address) DO UPDATE SET rug_count = rug_count + 1`
    )
    .run(creator, now());
  blacklist(creator, "creator", reason); // no TTL = permanent
}

/**
 * Bound the two append-only tables that grow every sweep.
 *
 * Nothing pruned them before: the Railway volume was 83% full inside a day and
 * a 200-hour local run had 27 MB of `decisions` — ~100 gate-rejection rows an
 * hour, each carrying a full serialised pool object (fixed at the write site
 * too). Retention is what the readers actually need:
 *  - `entered` / `exited` rows are the audit trail and are rare: kept forever.
 *  - `skipped` rows feed the dashboard funnel, whose longest range is 30 days.
 *  - `pool_snapshots` is read `ORDER BY ts DESC LIMIT 1` per pool; the rest is
 *    an offline replay dataset that no one has replayed. Kept a few days.
 * Returns the row counts removed so the caller can log a non-zero sweep.
 */
/** Bytes the SQLite file currently occupies on disk (pages × page size). */
export function dbFileBytes(): number {
  const db = getDb();
  const pageCount = (db.pragma("page_count", { simple: true }) as number) ?? 0;
  const pageSize = (db.pragma("page_size", { simple: true }) as number) ?? 4096;
  return pageCount * pageSize;
}

export interface PruneResult {
  decisions: number;
  snapshots: number;
  vacuumed: boolean;
  /** Which rule fired: the age windows, or the size ceiling. */
  mode: "age" | "size" | "none";
  bytesBefore: number;
  bytesAfter: number;
}

/**
 * Counterfactual telemetry: one row per POSITION recording what a rule that is
 * not switched on would have done. They are written as `skipped` decisions
 * because that is the only action a non-event has — which put them in the same
 * bucket as scanner rejections and got them deleted.
 *
 * Measured 2026-08-21 on the server: 986 of the 1068 surviving `skipped` rows
 * were `fee_tvl_24h` pool rejections, and the retained window was **8 minutes**
 * — the size ceiling is hit continuously, so the oldest-first trim below runs
 * every pass. Every experiment row ever written had already been deleted:
 * P1_fee_offset_deferred 0, young_exit_candidate 0, top_blast_candidate 0,
 * give_back_candidate 0. Four experiments collecting nothing.
 *
 * These are rare — at most one per position, against ~900 rejection rows an
 * hour — so exempting them costs almost nothing and is the difference between
 * a decision made on data and one made on log scraping.
 */
export const TELEMETRY_GATES = [
  "P1_fee_offset_deferred",
  "young_exit_candidate",
  "top_blast_candidate",
  "give_back_candidate",
  "reentry_ladder_deferred",
  // 2026-08-26: both of these shipped as instrumented-off experiments WITHOUT
  // being added here, and the omission is silent — the experiment looks healthy,
  // the rows just stop existing. Measured on the server that day: the file sat
  // at 198.7/200 MB, so the size trim was running constantly and the oldest
  // surviving skipped row was 4.6 days old against `retain_skipped_days = 30`.
  // `sizing_flat_deferred` wrote 6 rows and had 0 left within the hour.
  // ANY new *_deferred / *_candidate gate MUST be added here in the same commit
  // that starts writing it.
  "escape_absolute_deferred",
  "sizing_flat_deferred",
] as const;

/** SQL fragment: true for a row that is NOT counterfactual telemetry. */
const NOT_TELEMETRY_SQL = `COALESCE(failed_gate, '') NOT IN (${TELEMETRY_GATES.map((g) => `'${g}'`).join(", ")})`;

/**
 * SQL fragment: true for a row that does NOT carry a backfilled outcome.
 *
 * `npm run sim:skips` writes one measured price path per skip EPISODE, not per
 * sweep, so the set this spares grows with distinct rejections rather than with
 * tick rate. Without it the size ceiling deletes the measurement: on the live
 * book it had ground the skip window down to ~30 hours against a 30-day age
 * setting, so a result would be evicted the day after it was fetched — which is
 * exactly why `bin_step_new` could only be shown to have blocked two mints.
 */
const BACKFILLED_SQL = "outcome_backfill_json IS NULL";

export function pruneHistory(opts: {
  skippedDays: number;
  snapshotDays: number;
  /** Hard ceiling on the DB file. Above it, `skipped` rows and snapshots are trimmed oldest-first regardless of age. */
  maxBytes?: number;
}): PruneResult {
  const db = getDb();
  const t = now();
  const bytesBefore = dbFileBytes();

  // Age windows first — the normal steady state on a mature install.
  let decisions = db.prepare(
    `DELETE FROM decisions WHERE action = 'skipped' AND ${NOT_TELEMETRY_SQL} AND ${BACKFILLED_SQL} AND ts < ?`
  ).run(t - opts.skippedDays * 86_400).changes;
  let snapshots = db.prepare(
    "DELETE FROM pool_snapshots WHERE ts < ?"
  ).run(t - opts.snapshotDays * 86_400).changes;
  let mode: PruneResult["mode"] = decisions + snapshots > 0 ? "age" : "none";

  // Size ceiling second. The age windows are calibrated to what the dashboard
  // READS (30 days of funnel), not to what the volume can HOLD — and on a
  // one-day-old install nothing is older than 30 days, so the age rule pruned
  // zero rows, printed nothing, and the Railway volume filled to ENOSPC
  // overnight at ~890 rejection rows/hour. Below the ceiling this is a no-op;
  // above it, trim the two append-only tables oldest-first in chunks until the
  // file is under the ceiling. entered/exited rows are never touched here
  // either — they are the audit trail and are rare.
  //
  // Note the file does not shrink on DELETE; VACUUM below gives the space back.
  // We measure "used pages" rather than file size for the loop so freed pages
  // count immediately.
  const ceiling = opts.maxBytes ?? 0;
  if (ceiling > 0) {
    const usedBytes = () => {
      const pc = db.pragma("page_count", { simple: true }) as number;
      const fl = db.pragma("freelist_count", { simple: true }) as number;
      const ps = db.pragma("page_size", { simple: true }) as number;
      return (pc - fl) * ps;
    };
    let guard = 0;
    while (usedBytes() > ceiling && guard++ < 200) {
      const s = db.prepare(
        "DELETE FROM pool_snapshots WHERE rowid IN (SELECT rowid FROM pool_snapshots ORDER BY ts ASC LIMIT 5000)"
      ).run().changes;
      const d = db.prepare(
        `DELETE FROM decisions WHERE rowid IN (SELECT rowid FROM decisions WHERE action = 'skipped' AND ${NOT_TELEMETRY_SQL} AND ${BACKFILLED_SQL} ORDER BY ts ASC LIMIT 5000)`
      ).run().changes;
      snapshots += s;
      decisions += d;
      if (s + d === 0) break; // nothing prunable left — never touch entered/exited or telemetry
      mode = "size";
    }
  }

  // DELETE frees pages inside the file; the file itself does not shrink until
  // VACUUM rewrites it. VACUUM needs scratch space roughly equal to the live
  // data, so on a FULL disk it can fail — hence the try, and hence the size
  // loop above deleting first so there is something to reclaim.
  let vacuumed = false;
  if (decisions + snapshots >= 10_000 || mode === "size") {
    try { db.exec("VACUUM"); vacuumed = true; } catch { /* no scratch space or busy — next pass */ }
  }
  return { decisions, snapshots, vacuumed, mode, bytesBefore, bytesAfter: dbFileBytes() };
}

/**
 * Snapshot config.toml into `config_history` whenever it differs from the last
 * row. The table shipped empty and unwritten; it is worth filling because the
 * backtester replays TODAY's exit ladder over positions closed under whatever
 * rules were live at the time — the below-range stop sustain (2026-08-16) alone
 * moves replay fidelity on the server book from 76% to 91%. With a dated trail
 * of the settings, a replay can be told which rules a position actually ran
 * under instead of guessing from the calendar.
 *
 * One row per edit, not per tick: config changes are rare and the whole file is
 * a few KB.
 */
export function recordConfigSnapshot(toml: string): boolean {
  const db = getDb();
  const last = db.prepare("SELECT toml FROM config_history ORDER BY id DESC LIMIT 1").get() as
    { toml: string } | undefined;
  if (last?.toml === toml) return false;
  db.prepare("INSERT INTO config_history (ts, toml) VALUES (?, ?)").run(now(), toml);
  return true;
}

export function recordDecision(
  mint: string,
  pool: string | null,
  action: "entered" | "skipped" | "exited",
  failedGate: string | null,
  score: number | null,
  features: unknown
): void {
  const mode = currentMode();
  let payload: Record<string, unknown>;
  if (features && typeof features === "object" && !Array.isArray(features)) {
    const f = features as Record<string, unknown>;
    const cand = f.cand && typeof f.cand === "object" ? f.cand as Record<string, unknown> : null;
    const poolObj = f.pool && typeof f.pool === "object" ? f.pool as Record<string, unknown> : null;
    const symbol =
      (typeof f.symbol === "string" && f.symbol) ||
      (typeof cand?.symbol === "string" && cand.symbol) ||
      (typeof poolObj?.symbol === "string" && poolObj.symbol) ||
      null;
    payload = {
      ...f,
      ...(symbol && f.symbol !== symbol ? { symbol } : {}),
      mode: typeof f.mode === "string" ? f.mode : mode,
    };
  } else {
    payload = { mode, value: features };
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
  const label = resolveBuildLabel();
  cachedBuild = label === "unknown" ? null : label;
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

/**
 * Flatten an Error and its `cause` chain into one line.
 *
 * undici throws a bare `TypeError: fetch failed` for every connect-level
 * failure — DNS, refused TCP, dead TLS — and puts the only diagnosable part
 * (`ENOTFOUND`, `ECONNREFUSED`, `CERT_HAS_EXPIRED`) on `err.cause`, which the
 * stack does not show either. Reading just `.message` made every RPC outage in
 * the Errors tab look identical and told the operator nothing.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err).split("\n")[0]!;
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur instanceof Error && depth < 4; depth++) {
    const line = (cur.message || String(cur)).split("\n")[0]!;
    const code = (cur as NodeJS.ErrnoException).code;
    parts.push(code && !line.includes(code) ? `${line} (${code})` : line);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" <- ");
}

function errParts(err: unknown): { message: string; stack: string | null } {
  if (err instanceof Error) {
    return {
      message: describeError(err).slice(0, 800),
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
  const fromErr = input.err != null ? errParts(input.err) : null;
  const message = (input.message || fromErr?.message || "unknown error").slice(0, 800);
  const stack = fromErr?.stack ?? null;
  const code = input.code ?? null;
  const dedupeSec = input.dedupeSec ?? 60;
  const presentation = presentError({
    source: input.source,
    code,
    message,
    stack,
    level: input.level,
  });
  const level = input.level ?? presentation.level ?? (presentation.kind === "incident" ? "error" : "warn");

  const line = `[${input.source}${code ? `/${code}` : ""}] ${presentation.label}: ${message}`;
  if (level === "warn") console.warn(line);
  else console.error(line);
  if (stack && level !== "warn") console.error(stack.split("\n").slice(1, 8).join("\n"));

  const detailPayload: Record<string, unknown> = input.detail != null && typeof input.detail === "object" && !Array.isArray(input.detail)
    ? { ...(input.detail as Record<string, unknown>) }
    : input.detail != null
      ? { raw: input.detail }
      : {};
  detailPayload._present = {
    label: presentation.label,
    kind: presentation.kind,
    hint: presentation.hint ?? null,
  };

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
        JSON.stringify(detailPayload),
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
