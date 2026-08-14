/**
 * Soft pause — PAUSE file at repo root.
 * Farmer keeps heartbeat but skips manage/entry/sweep (positions stay open).
 * Distinct from HALT (which closes everything first).
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function pausePath(root) {
  return resolve(root, "PAUSE");
}

export function readPauseState(root) {
  const path = pausePath(root);
  if (!existsSync(path)) {
    return { paused: false, pause_at: null, path };
  }
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

export function requestPause(root) {
  const path = pausePath(root);
  const at = new Date().toISOString();
  writeFileSync(path, `${at}\n`);
  return {
    paused: true,
    pause_at: at,
    path,
    note: "PAUSE set — trading engine idle; open positions left alone until ON.",
  };
}

export function clearPause(root) {
  const path = pausePath(root);
  if (existsSync(path)) unlinkSync(path);
  return {
    paused: false,
    pause_at: null,
    path,
    note: "PAUSE cleared — trading resumes on the next tick (unless HALT is set).",
  };
}
