/**
 * Deploy-context detection + commit/branch resolution for the build pill.
 * PaaS (Railway, Vercel, …) → platform-injected SHA wins over a stale/missing .git.
 * VPS PM2 / dev → local git checkout is authoritative.
 */

/** Branch names from env — restrict to sane git ref characters. */
export function safeBranch(raw) {
  const b = (raw ?? "").trim();
  return /^[A-Za-z0-9][\w./-]*$/.test(b) ? b : "main";
}

/** Where this process is running — drives which head SHA source to trust. */
export function detectDeployContext() {
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) return "railway";
  if (process.env.VERCEL === "1" || process.env.VERCEL_ENV) return "vercel";
  if (process.env.RENDER) return "render";
  if (process.env.FLY_APP_NAME) return "fly";
  if (process.env.CF_PAGES || process.env.CF_PAGES_COMMIT_SHA) return "cloudflare";
  if (process.env.HEROKU_APP_NAME || process.env.DYNO) return "heroku";
  if (process.env.KUBERNETES_SERVICE_HOST) return "kubernetes";
  return "local";
}

/** PaaS/container deploys inject the built SHA — local .git may be absent or stale. */
export function usesPlatformHead(ctx = detectDeployContext()) {
  return ctx !== "local";
}

const COMMIT_SHA_ENVS = [
  "RAILWAY_GIT_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_SHA",
  "RENDER_GIT_COMMIT",
  "CF_PAGES_COMMIT_SHA",
  "SOURCE_COMMIT",
  "COMMIT_SHA",
  "GIT_COMMIT",
  "GITHUB_SHA",
];

/** First valid hex SHA from known platform / CI env vars. */
export function envCommitSha() {
  for (const key of COMMIT_SHA_ENVS) {
    const v = (process.env[key] ?? "").trim();
    if (/^[0-9a-f]{7,40}$/i.test(v)) return v.toLowerCase();
  }
  return null;
}

const BRANCH_ENVS = [
  "DEPLOY_BRANCH",
  "RAILWAY_GIT_BRANCH",
  "VERCEL_GIT_COMMIT_REF",
  "RENDER_GIT_BRANCH",
  "CF_PAGES_BRANCH",
  "GITHUB_REF_NAME",
  "GIT_BRANCH",
];

/** Deploy branch — explicit DEPLOY_BRANCH wins, then platform, then main. */
export function resolveDeployBranch() {
  for (const key of BRANCH_ENVS) {
    let v = (process.env[key] ?? "").trim();
    if (!v) continue;
    if (key === "GITHUB_REF_NAME" && v.startsWith("refs/heads/")) {
      v = v.slice("refs/heads/".length);
    }
    return safeBranch(v);
  }
  return "main";
}

const MESSAGE_ENVS = [
  "RAILWAY_GIT_COMMIT_MESSAGE",
  "VERCEL_GIT_COMMIT_MESSAGE",
  "RENDER_GIT_COMMIT_MESSAGE",
];

export function envCommitMessage() {
  for (const key of MESSAGE_ENVS) {
    const line = (process.env[key] ?? "").trim().split("\n")[0].slice(0, 120);
    if (line) return line;
  }
  return null;
}

export function shortSha(full) {
  if (!full) return null;
  return full.length > 7 ? full.slice(0, 7) : full;
}

export function shasMatch(a, b) {
  if (!a || !b) return false;
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  return x === y || x.startsWith(y) || y.startsWith(x);
}

export function syncFromShas(headFull, originFull) {
  if (!headFull || !originFull) return "unknown";
  return shasMatch(headFull, originFull) ? "current" : "behind";
}

/**
 * Resolve the running commit SHA from the best source for this host.
 * @param {string} root repo root
 * @param {(root: string, args: string[]) => string|null} git run git CLI (null on failure)
 */
export function resolveHeadSha(root, git) {
  const ctx = detectDeployContext();
  const envSha = envCommitSha();
  const localSha = (git(root, ["rev-parse", "HEAD"]) || "").toLowerCase();
  const localOk = /^[0-9a-f]{7,40}$/.test(localSha);

  if (usesPlatformHead(ctx) && envSha) {
    return { sha: envSha, short: shortSha(envSha), source: ctx };
  }
  if (localOk) {
    return { sha: localSha, short: shortSha(localSha), source: "git" };
  }
  if (envSha) {
    return { sha: envSha, short: shortSha(envSha), source: "env" };
  }
  return { sha: null, short: null, source: "unknown" };
}

/** Human label for build-pill tooltips. */
export function headSourceLabel(source) {
  const labels = {
    railway: "Railway deploy SHA",
    vercel: "Vercel deploy SHA",
    render: "Render deploy SHA",
    fly: "Fly deploy SHA",
    cloudflare: "Cloudflare Pages SHA",
    heroku: "Heroku deploy SHA",
    kubernetes: "container env SHA",
    git: "local git checkout",
    env: "COMMIT_SHA env",
    unknown: "unknown",
  };
  return labels[source] ?? source;
}
