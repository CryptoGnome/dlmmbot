/**
 * Halt control — HALT file on the runtime data volume (and legacy repo-root).
 * While present the farmer closes opens and idles; Resume deletes the file.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { runtimePaths } from "./runtime-paths.mjs";

export function haltPath(root) {
  return runtimePaths(root).haltPath;
}

function haltCandidates(root) {
  const p = runtimePaths(root);
  return [...new Set([p.haltPath, p.legacyHaltPath])];
}

export function readHaltState(root) {
  for (const path of haltCandidates(root)) {
    if (!existsSync(path)) continue;
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
  return { halted: false, halt_at: null, path: haltPath(root) };
}

export function requestHalt(root) {
  const path = haltPath(root);
  const at = new Date().toISOString();
  writeFileSync(path, `${at}\n`);
  const legacy = runtimePaths(root).legacyHaltPath;
  if (legacy !== path && existsSync(legacy)) {
    try { unlinkSync(legacy); } catch { /* */ }
  }
  return { halted: true, halt_at: at, path, note: "HALT set — farmer will close opens and idle until Resume." };
}

export function clearHalt(root) {
  for (const path of haltCandidates(root)) {
    if (existsSync(path)) unlinkSync(path);
  }
  return { halted: false, halt_at: null, path: haltPath(root), note: "HALT cleared — farmer resumes on the next tick." };
}
