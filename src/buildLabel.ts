import { execFileSync } from "node:child_process";

/**
 * Build / commit label for heartbeat + error rows.
 * Prefer platform-injected SHA (Railway has no git binary at runtime), then local git.
 */
export function resolveBuildLabel(cwd = process.cwd()): string {
  const envSha = (
    process.env.RAILWAY_GIT_COMMIT_SHA
    || process.env.SOURCE_COMMIT
    || process.env.COMMIT_SHA
    || ""
  ).trim();
  if (envSha) return envSha.length > 12 ? envSha.slice(0, 12) : envSha;
  try {
    return execFileSync("git", ["describe", "--always", "--dirty"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}
