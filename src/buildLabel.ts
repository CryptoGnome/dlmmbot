import { execFileSync } from "node:child_process";
import { detectDeployContext, envCommitSha, usesPlatformHead } from "./gitSource.js";

/**
 * Build / commit label for heartbeat + error rows.
 * Platform deploy SHA on PaaS; local git on PM2/dev VPS.
 */
export function resolveBuildLabel(cwd = process.cwd()): string {
  const ctx = detectDeployContext();
  const envSha = envCommitSha();
  if (usesPlatformHead(ctx) && envSha) {
    return envSha.length > 12 ? envSha.slice(0, 12) : envSha;
  }
  try {
    const local = execFileSync("git", ["describe", "--always", "--dirty"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (local) return local;
  } catch { /* no git */ }
  if (envSha) return envSha.length > 12 ? envSha.slice(0, 12) : envSha;
  return "unknown";
}
