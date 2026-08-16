/**
 * Emergency disk reclaim, callable from the dashboard while the farmer cannot
 * write. Exists because of 2026-08-16: the Railway volume filled to ENOSPC,
 * the farmer crash-looped, and NOTHING in-band could free a byte — SQLite
 * cannot even DELETE with zero free space (it needs a journal page first), and
 * a volume resize turned out to be staged-not-applied for over an hour.
 *
 * What CAN free space on a full disk, in order:
 *  1. Delete non-DB files (lock/flag/snapshot/tmp). Small, but instant, and a
 *     few KB is enough for SQLite to write a journal page.
 *  2. WAL checkpoint (TRUNCATE). In WAL mode every uncheckpointed write lives
 *     in farmer.db-wal; on a disk that filled under heavy writing that file
 *     can be tens of MB. Checkpointing folds it into pages the main file
 *     already owns and truncates the WAL to zero — no new space required.
 *  3. With room to journal, prune the append-only tables oldest-first, then
 *     VACUUM to hand the space back to the filesystem.
 * Reports every step so the operator sees exactly what moved.
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { runtimePaths } from "./runtime-paths.mjs";

function openDb(root) {
  const require = createRequire(resolve(root, "package.json"));
  const Database = require("better-sqlite3");
  return new Database(runtimePaths(root).dbPath, { fileMustExist: true });
}

function fileBytes(p) { try { return statSync(p).size; } catch { return 0; } }

export function diskRescue(root, opts = {}) {
  const dbPath = runtimePaths(root).dbPath;
  const dir = dirname(dbPath);
  const keepRows = opts.keepSkippedRows ?? 20_000;
  const report = { steps: [], before: {}, after: {} };

  const snapshot = () => ({
    db: fileBytes(dbPath),
    wal: fileBytes(`${dbPath}-wal`),
    shm: fileBytes(`${dbPath}-shm`),
    other: readdirSync(dir).filter((f) => !f.startsWith("farmer.db")).map((f) => [f, fileBytes(join(dir, f))]),
  });
  report.before = snapshot();

  // 1. Non-DB files. The lock is only safe to remove if the farmer is not
  //    running; the caller says so (default: leave it).
  const removable = readdirSync(dir).filter((f) =>
    f === "smartflow.json" || f.endsWith(".tmp") || f === "busy.flag" || (opts.removeLock && f === "farmer.lock"),
  );
  for (const f of removable) {
    const p = join(dir, f);
    const bytes = fileBytes(p);
    try { unlinkSync(p); report.steps.push({ step: "unlink", file: f, bytes, ok: true }); }
    catch (e) { report.steps.push({ step: "unlink", file: f, bytes, ok: false, error: e.message }); }
  }

  const db = openDb(root);
  try {
    // 2. WAL checkpoint — the one SQLite op that can free bytes with no headroom.
    try {
      const r = db.pragma("wal_checkpoint(TRUNCATE)");
      report.steps.push({ step: "wal_checkpoint", result: r, walAfter: fileBytes(`${dbPath}-wal`), ok: true });
    } catch (e) { report.steps.push({ step: "wal_checkpoint", ok: false, error: e.message }); }

    // 3. Prune, oldest-first, in chunks, until only `keepRows` skipped rows
    //    remain. entered/exited are never touched.
    let pruned = { snapshots: 0, decisions: 0 };
    try {
      pruned.snapshots = db.prepare("DELETE FROM pool_snapshots").run().changes;
      const total = db.prepare("SELECT COUNT(*) c FROM decisions WHERE action='skipped'").get().c;
      const excess = Math.max(0, total - keepRows);
      if (excess > 0) {
        pruned.decisions = db.prepare(
          "DELETE FROM decisions WHERE rowid IN (SELECT rowid FROM decisions WHERE action='skipped' ORDER BY ts ASC LIMIT ?)"
        ).run(excess).changes;
      }
      report.steps.push({ step: "prune", ...pruned, keptSkipped: Math.min(total, keepRows), ok: true });
    } catch (e) { report.steps.push({ step: "prune", ...pruned, ok: false, error: e.message }); }

    // 4. Give the space back.
    try { db.exec("VACUUM"); report.steps.push({ step: "vacuum", ok: true }); }
    catch (e) { report.steps.push({ step: "vacuum", ok: false, error: e.message }); }
  } finally { db.close(); }

  report.after = snapshot();
  return report;
}
