/**
 * Host update prefs — shared by auto-deploy.sh and the dashboard API.
 * Default: autoUpdate on (current behavior). When off, behind commits wait
 * until the operator approves from the Changes tab.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimePaths } from "./runtime-paths.mjs";

const FILE = "deploy-prefs.json";

function prefsPath(root) {
  return join(runtimePaths(root).dataDir, FILE);
}

/** @returns {{ autoUpdate: boolean, approveSha: string | null, approvedAt: string | null }} */
export function readDeployPrefs(root = process.cwd()) {
  const path = prefsPath(root);
  try {
    if (!existsSync(path)) {
      return { autoUpdate: true, approveSha: null, approvedAt: null };
    }
    const j = JSON.parse(readFileSync(path, "utf8"));
    return {
      autoUpdate: j.autoUpdate !== false,
      approveSha: typeof j.approveSha === "string" && j.approveSha ? j.approveSha : null,
      approvedAt: typeof j.approvedAt === "string" ? j.approvedAt : null,
    };
  } catch {
    return { autoUpdate: true, approveSha: null, approvedAt: null };
  }
}

export function writeDeployPrefs(root, next) {
  const { dataDir } = runtimePaths(root);
  mkdirSync(dataDir, { recursive: true });
  const cur = readDeployPrefs(root);
  const out = {
    autoUpdate: next.autoUpdate != null ? !!next.autoUpdate : cur.autoUpdate,
    approveSha: next.approveSha !== undefined ? next.approveSha : cur.approveSha,
    approvedAt: next.approvedAt !== undefined ? next.approvedAt : cur.approvedAt,
  };
  writeFileSync(prefsPath(root), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

/** True when the watcher should pull this remote SHA. */
export function shouldAutoDeploy(root, remoteSha) {
  const p = readDeployPrefs(root);
  if (p.autoUpdate) return { ok: true, reason: "auto" };
  if (p.approveSha && remoteSha && (
    p.approveSha === remoteSha
    || p.approveSha === "HEAD"
    || remoteSha.startsWith(p.approveSha)
    || p.approveSha.startsWith(remoteSha)
  )) {
    return { ok: true, reason: "approved" };
  }
  return { ok: false, reason: "manual" };
}

export function clearApprove(root) {
  return writeDeployPrefs(root, { approveSha: null, approvedAt: null });
}

export function approveDeploy(root, remoteSha) {
  return writeDeployPrefs(root, {
    approveSha: remoteSha || "HEAD",
    approvedAt: new Date().toISOString(),
  });
}
