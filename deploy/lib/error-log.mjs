/**
 * Shared error_log helpers for the dashboard (mjs) — mirrors src/db/db.ts logError.
 * Farmer writes via TypeScript; dash can append its own rows with insertError.
 */
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { runtimePaths } from "./runtime-paths.mjs";

const SCHEMA = `
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
`;

let cachedBuild;
function buildLabel(root) {
  if (cachedBuild !== undefined) return cachedBuild;
  try {
    cachedBuild = execSync("git describe --always --dirty", { cwd: root, encoding: "utf8" }).trim() || null;
  } catch {
    cachedBuild = null;
  }
  return cachedBuild;
}

function openWritable(root) {
  const require = createRequire(resolve(root, "package.json"));
  const Database = require("better-sqlite3");
  const db = new Database(runtimePaths(root).dbPath);
  db.exec(SCHEMA);
  return db;
}

/** @param {import("better-sqlite3").Database} db */
export function ensureErrorLog(db) {
  try { db.exec(SCHEMA); } catch { /* readonly or missing */ }
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {number} [limit]
 */
export function listRecentErrors(db, limit = 100) {
  try {
    ensureErrorLog(db);
    const rows = db.prepare(
      `SELECT id, ts, level, source, code, message, stack, detail_json,
              position_id, symbol, mint, pool, build, host, pid
       FROM error_log ORDER BY id DESC LIMIT ?`,
    ).all(limit);
    return rows.map((r) => {
      let detail = null;
      if (r.detail_json) {
        try { detail = JSON.parse(r.detail_json); } catch { detail = r.detail_json; }
      }
      return {
        id: r.id,
        ts: r.ts,
        at: new Date(r.ts * 1000).toISOString(),
        level: r.level,
        source: r.source,
        code: r.code,
        message: r.message,
        stack: r.stack,
        detail,
        position_id: r.position_id,
        symbol: r.symbol,
        mint: r.mint,
        pool: r.pool,
        build: r.build,
        host: r.host,
        pid: r.pid,
      };
    });
  } catch {
    return [];
  }
}

export function errorStats(db, nowTs = Math.floor(Date.now() / 1000)) {
  try {
    ensureErrorLog(db);
    const hour = db.prepare(
      `SELECT COUNT(*) AS n FROM error_log WHERE ts >= ? AND level != 'warn'`,
    ).get(nowTs - 3600);
    const day = db.prepare(
      `SELECT COUNT(*) AS n FROM error_log WHERE ts >= ? AND level != 'warn'`,
    ).get(nowTs - 86_400);
    const last = db.prepare(`SELECT id, ts FROM error_log ORDER BY id DESC LIMIT 1`).get();
    return {
      count_1h: Number(hour?.n) || 0,
      count_24h: Number(day?.n) || 0,
      last_id: last?.id ?? null,
      last_ts: last?.ts ?? null,
    };
  } catch {
    return { count_1h: 0, count_24h: 0, last_id: null, last_ts: null };
  }
}

export function insertError(root, input) {
  const level = input.level ?? "error";
  const message = String(input.message || "unknown").slice(0, 800);
  const code = input.code ?? null;
  const dedupeSec = input.dedupeSec ?? 60;
  const db = openWritable(root);
  try {
    if (dedupeSec > 0) {
      const now = Math.floor(Date.now() / 1000);
      const recent = db.prepare(
        `SELECT id FROM error_log
         WHERE source = ? AND IFNULL(code,'') = IFNULL(?, '') AND message = ? AND ts >= ?
         LIMIT 1`,
      ).get(input.source, code, message, now - dedupeSec);
      if (recent) return 0;
    }
    const info = db.prepare(
      `INSERT INTO error_log
        (ts, level, source, code, message, stack, detail_json, position_id, symbol, mint, pool, build, host, pid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Math.floor(Date.now() / 1000),
      level,
      input.source || "dash",
      code,
      message,
      input.stack ?? null,
      input.detail != null ? JSON.stringify(input.detail) : null,
      input.positionId ?? null,
      input.symbol ?? null,
      input.mint ?? null,
      input.pool ?? null,
      buildLabel(root),
      hostname(),
      process.pid,
    );
    return Number(info.lastInsertRowid) || 0;
  } finally {
    db.close();
  }
}
