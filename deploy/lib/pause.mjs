/**
 * Soft pause — PAUSE file on the runtime data volume (and legacy repo-root).
 * Farmer keeps heartbeat but skips manage/entry/sweep (positions stay open).
 * Distinct from HALT (which closes everything first).
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { runtimePaths } from "./runtime-paths.mjs";

export function pausePath(root) {
  return runtimePaths(root).pausePath;
}

function pauseCandidates(root) {
  const p = runtimePaths(root);
  return [...new Set([p.pausePath, p.legacyPausePath])];
}

export function readPauseState(root) {
  for (const path of pauseCandidates(root)) {
    if (!existsSync(path)) continue;
    let pauseAt = null;
    try {
      const raw = readFileSync(path, "utf8").trim();
      if (raw) {
        const t = Date.parse(raw);
        pauseAt = Number.isFinite(t) ? new Date(t).toISOString() : raw;
      }
    } catch { /* */ }
    return { paused: true, pause_at: pauseAt, path };
  }
  return { paused: false, pause_at: null, path: pausePath(root) };
}

export function requestPause(root) {
  const path = pausePath(root);
  const at = new Date().toISOString();
  writeFileSync(path, `${at}\n`);
  // Drop legacy root file so a stale ON/OFF can't disagree after migrate.
  const legacy = runtimePaths(root).legacyPausePath;
  if (legacy !== path && existsSync(legacy)) {
    try { unlinkSync(legacy); } catch { /* */ }
  }
  return {
    paused: true,
    pause_at: at,
    path,
    note: "PAUSE set — trading engine idle; open positions left alone until ON.",
  };
}

export function clearPause(root) {
  for (const path of pauseCandidates(root)) {
    if (existsSync(path)) unlinkSync(path);
  }
  return {
    paused: false,
    pause_at: null,
    path: pausePath(root),
    note: "PAUSE cleared — trading resumes on the next tick (unless HALT is set).",
  };
}
