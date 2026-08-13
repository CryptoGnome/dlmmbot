/**
 * Token display metadata (symbol / name / icon) cached in SQLite `tokens`.
 * Filled by the farmer on vet; dashboard backfills missing icons from Jupiter datapi.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runtimePaths } from "./runtime-paths.mjs";

const META_TTL_S = 7 * 24 * 3600;
const BACKFILL_GAP_MS = 400;
const BACKFILL_MAX = 6;

let backfillBusy = false;
let nextBackfillAt = 0;

function requireDb(root) {
  const require = createRequire(resolve(root, "package.json"));
  return require("better-sqlite3");
}

export function ensureTokenMetaSchema(db) {
  try { db.exec("ALTER TABLE tokens ADD COLUMN name TEXT"); } catch { /* */ }
  try { db.exec("ALTER TABLE tokens ADD COLUMN icon_url TEXT"); } catch { /* */ }
  try { db.exec("ALTER TABLE tokens ADD COLUMN meta_updated_ts INTEGER"); } catch { /* */ }
}

/** @returns {Record<string, { mint: string, symbol: string|null, name: string|null, icon_url: string|null }>} */
export function loadTokenMetaMap(db, mints) {
  ensureTokenMetaSchema(db);
  const uniq = [...new Set((mints || []).filter(Boolean))];
  const out = {};
  if (!uniq.length) return out;
  const stmt = db.prepare(
    `SELECT mint, symbol, name, icon_url FROM tokens WHERE mint = ?`,
  );
  for (const mint of uniq) {
    const row = stmt.get(mint);
    if (row) {
      out[mint] = {
        mint: row.mint,
        symbol: row.symbol || null,
        name: row.name || null,
        icon_url: row.icon_url || null,
      };
    }
  }
  return out;
}

export function upsertTokenMetaRow(db, mint, meta) {
  if (!mint) return;
  const symbol = meta.symbol?.trim?.() || meta.symbol || null;
  const name = meta.name?.trim?.() || meta.name || null;
  const icon = meta.icon_url?.trim?.() || meta.icon_url || meta.icon || null;
  if (!symbol && !name && !icon) return;
  const ts = Math.floor(Date.now() / 1000);
  ensureTokenMetaSchema(db);
  db.prepare(
    `INSERT INTO tokens (mint, symbol, name, icon_url, meta_updated_ts, first_seen)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET
       symbol = COALESCE(excluded.symbol, tokens.symbol),
       name = COALESCE(excluded.name, tokens.name),
       icon_url = COALESCE(excluded.icon_url, tokens.icon_url),
       meta_updated_ts = excluded.meta_updated_ts`,
  ).run(mint, symbol, name, icon, ts, ts);
}

function needsRefresh(row, nowTs) {
  if (!row) return true;
  if (!row.icon_url) return true;
  if (!row.meta_updated_ts) return true;
  return nowTs - Number(row.meta_updated_ts) > META_TTL_S;
}

async function fetchJupMeta(mint) {
  const res = await fetch(
    `https://datapi.jup.ag/v1/assets/search?query=${encodeURIComponent(mint)}`,
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!res.ok) return null;
  const body = await res.json();
  if (!Array.isArray(body)) return null;
  const a = body.find((x) => x && x.id === mint);
  if (!a) return null;
  return {
    symbol: typeof a.symbol === "string" ? a.symbol : null,
    name: typeof a.name === "string" ? a.name : null,
    icon_url: typeof a.icon === "string" ? a.icon : null,
  };
}

/**
 * Non-blocking: refresh a few missing/stale icons so the next watch tick is richer.
 * @param {string} root
 * @param {string[]} mints
 */
export function scheduleTokenMetaBackfill(root, mints) {
  if (backfillBusy || Date.now() < nextBackfillAt) return;
  const uniq = [...new Set((mints || []).filter(Boolean))];
  if (!uniq.length) return;

  backfillBusy = true;
  nextBackfillAt = Date.now() + 8_000;

  void (async () => {
    const Database = requireDb(root);
    const db = new Database(runtimePaths(root).dbPath);
    try {
      ensureTokenMetaSchema(db);
      const nowTs = Math.floor(Date.now() / 1000);
      const stmt = db.prepare(
        `SELECT mint, icon_url, meta_updated_ts FROM tokens WHERE mint = ?`,
      );
      const todo = [];
      for (const mint of uniq) {
        if (todo.length >= BACKFILL_MAX) break;
        if (needsRefresh(stmt.get(mint), nowTs)) todo.push(mint);
      }
      for (const mint of todo) {
        try {
          const meta = await fetchJupMeta(mint);
          if (meta) upsertTokenMetaRow(db, mint, meta);
        } catch { /* soft */ }
        await new Promise((r) => setTimeout(r, BACKFILL_GAP_MS));
      }
    } finally {
      try { db.close(); } catch { /* */ }
      backfillBusy = false;
    }
  })();
}

/** Attach icon_url / name onto objects that already have mint. */
export function decorateWithMeta(rows, metaMap) {
  if (!rows?.length) return rows;
  for (const r of rows) {
    const m = r?.mint ? metaMap[r.mint] : null;
    if (!m) continue;
    if (m.icon_url) r.icon_url = m.icon_url;
    if (m.name) r.name = m.name;
    if (m.symbol && (!r.symbol || r.symbol === "?")) r.symbol = m.symbol;
  }
  return rows;
}
