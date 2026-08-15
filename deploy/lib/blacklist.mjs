/**
 * Read and lift blacklist entries from the ledger.
 *
 * Until 2026-08-15 there was no way to lift a ban short of editing the DB —
 * not in the dashboard, not in the CLI. P0 can be wrong (pos#5 GUNICORN
 * permanently banned a creator whose token then round-tripped +261%), so an
 * operator who disagrees with a ban needs a supported way to say so.
 *
 * Lifting a CREATOR ban also resets that creator's rug_count: vet.ts fails
 * `creator_rug_history` on rug_count > 0 and re-blacklists on every future
 * vet, so clearing the blacklist row alone would silently re-ban the creator
 * on its next mint. The two are one decision.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runtimePaths } from "./runtime-paths.mjs";

function openDb(root, readonly) {
  const require = createRequire(resolve(root, "package.json"));
  const Database = require("better-sqlite3");
  return new Database(runtimePaths(root).dbPath, { readonly, fileMustExist: true });
}

/** All current entries, newest first, with expiry rendered. */
export function listBlacklist(root, limit = 200) {
  const db = openDb(root, true);
  try {
    return db.prepare(
      `SELECT key, kind, reason, created_ts, expires_ts
       FROM blacklist ORDER BY created_ts DESC LIMIT ?`
    ).all(limit).map((r) => ({
      ...r,
      permanent: r.expires_ts === null,
      expires_at: r.expires_ts === null ? null : new Date(r.expires_ts * 1000).toISOString(),
    }));
  } finally { db.close(); }
}

/**
 * Lift entries by exact key. Returns what was removed. `keys` may mix token
 * mints and creator addresses; a creator's rug_count is reset alongside.
 */
export function clearBlacklist(root, keys) {
  if (!Array.isArray(keys) || !keys.length) throw new Error("keys[] required");
  const clean = keys.map((k) => String(k).trim()).filter((k) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(k));
  if (!clean.length) throw new Error("no valid base58 keys");
  const db = openDb(root, false);
  try {
    const rows = db.prepare(
      `SELECT key, kind, reason FROM blacklist WHERE key IN (${clean.map(() => "?").join(",")})`
    ).all(...clean);
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM blacklist WHERE key IN (${clean.map(() => "?").join(",")})`).run(...clean);
      const creators = rows.filter((r) => r.kind === "creator").map((r) => r.key);
      if (creators.length) {
        db.prepare(
          `UPDATE creators SET rug_count = 0 WHERE address IN (${creators.map(() => "?").join(",")})`
        ).run(...creators);
      }
    });
    tx();
    return { removed: rows, notFound: clean.filter((k) => !rows.some((r) => r.key === k)) };
  } finally { db.close(); }
}
