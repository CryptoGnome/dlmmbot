/**
 * Operator "close this position now" request.
 *
 * The dashboard cannot close a position itself: only the farmer loop holds the
 * executor, the wallet keypair and the position accounts. So this records the
 * request on the row and the next manage tick performs the real close, books
 * the PnL and reports it — the same path every other exit takes.
 *
 * Deliberately NOT a write-off. `force-close` marks a row closed with nothing
 * behind it on chain; this asks for an actual on-chain close. Confusing the two
 * would strand real liquidity, so this refuses anything already closed and
 * never touches exit_ts / exit_sol itself.
 */
import { createRequire } from "node:module";
import { runtimePaths } from "./runtime-paths.mjs";

function openDb(root) {
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3");
  return new Database(runtimePaths(root).dbPath, { fileMustExist: true });
}

const OPEN_STATES = new Set(["open", "pending"]);

/**
 * @param {string} root
 * @param {number} id position id
 * @returns {{ ok: true, id: number, symbol: string, requested_at: number, already: boolean }}
 */
export function requestPositionClose(root, id) {
  const posId = Number(id);
  if (!Number.isInteger(posId) || posId <= 0) {
    const e = new Error("a numeric position id is required");
    e.statusCode = 400;
    throw e;
  }
  const db = openDb(root);
  try {
    const row = db.prepare(
      "SELECT id, symbol, state, mode, exit_ts, close_requested_at FROM positions WHERE id = ?",
    ).get(posId);
    if (!row) {
      const e = new Error(`no position #${posId}`);
      e.statusCode = 404;
      throw e;
    }
    if (row.exit_ts !== null || !OPEN_STATES.has(row.state)) {
      const e = new Error(`pos#${posId} ${row.symbol ?? ""} is already closed (${row.state})`);
      e.statusCode = 409;
      throw e;
    }
    // Idempotent: a double-click must not look like a failure, and must not
    // reset the timestamp (which is the audit record of when it was asked for).
    if (row.close_requested_at != null) {
      return {
        ok: true, id: posId, symbol: row.symbol ?? "?", mode: row.mode,
        requested_at: row.close_requested_at, already: true,
        note: "close already requested — the farmer will action it on the next tick",
      };
    }
    const at = Math.floor(Date.now() / 1000);
    db.prepare("UPDATE positions SET close_requested_at = ? WHERE id = ? AND exit_ts IS NULL")
      .run(at, posId);
    return {
      ok: true, id: posId, symbol: row.symbol ?? "?", mode: row.mode,
      requested_at: at, already: false,
      note: "close requested — the farmer closes it on the next manage tick",
    };
  } finally {
    db.close();
  }
}
