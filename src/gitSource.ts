/**
 * Deploy-context detection + commit resolution (mirrors deploy/lib/git-source.mjs).
 * Used by the farmer heartbeat — dashboard uses the .mjs copy.
 */

export type DeployContext =
  | "railway" | "vercel" | "render" | "fly" | "cloudflare" | "heroku" | "kubernetes" | "local";

export type HeadSource = DeployContext | "git" | "env" | "unknown";

const COMMIT_SHA_ENVS = [
  "RAILWAY_GIT_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_SHA",
  "RENDER_GIT_COMMIT",
  "CF_PAGES_COMMIT_SHA",
  "SOURCE_COMMIT",
  "COMMIT_SHA",
  "GIT_COMMIT",
  "GITHUB_SHA",
] as const;

export function detectDeployContext(): DeployContext {
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) return "railway";
  if (process.env.VERCEL === "1" || process.env.VERCEL_ENV) return "vercel";
  if (process.env.RENDER) return "render";
  if (process.env.FLY_APP_NAME) return "fly";
  if (process.env.CF_PAGES || process.env.CF_PAGES_COMMIT_SHA) return "cloudflare";
  if (process.env.HEROKU_APP_NAME || process.env.DYNO) return "heroku";
  if (process.env.KUBERNETES_SERVICE_HOST) return "kubernetes";
  return "local";
}

export function usesPlatformHead(ctx: DeployContext = detectDeployContext()): boolean {
  return ctx !== "local";
}

export function envCommitSha(): string | null {
  for (const key of COMMIT_SHA_ENVS) {
    const v = (process.env[key] ?? "").trim();
    if (/^[0-9a-f]{7,40}$/i.test(v)) return v.toLowerCase();
  }
  return null;
}
