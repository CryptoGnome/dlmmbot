/**
 * Halt control — same HALT file the farmer watches (repo-root / FARMER_ROOT).
 * While present the farmer closes opens and idles; Resume deletes the file.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function haltPath(root) {
  return resolve(root, "HALT");
}

export function readHaltState(root) {
  const path = haltPath(root);
  if (!existsSync(path)) {
    return { halted: false, halt_at: null, path };
  }
  let haltAt = null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw) {
      const t = Date.parse(raw);
      haltAt = Number.isFinite(t) ? new Date(t).toISOString() : raw;
    }
  } catch { /* */ }
  return { halted: true, halt_at: haltAt, path };
}

export function requestHalt(root) {
  const path = haltPath(root);
  const at = new Date().toISOString();
  writeFileSync(path, `${at}\n`);
  return { halted: true, halt_at: at, path, note: "HALT set — farmer will close opens and idle until Resume." };
}

export function clearHalt(root) {
  const path = haltPath(root);
  if (existsSync(path)) unlinkSync(path);
  return { halted: false, halt_at: null, path, note: "HALT cleared — farmer resumes on the next tick." };
}
