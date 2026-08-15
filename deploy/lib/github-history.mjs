/**
 * GitHub commit + release history for PaaS hosts (Railway, etc.) where local
 * `.git` is missing or not trustworthy. Also used on VPS for release notes
 * shown on the Changes tab.
 *
 * Failures (403 rate-limit, network) must never crash the dashboard process.
 * Last-good releases are mirrored to data/github-releases-cache.json so a
 * cold start under rate-limit still paints the Changes tab.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shortSha, shasMatch } from "./git-source.mjs";
import { runtimePaths } from "./runtime-paths.mjs";
import {
  labelCommits,
  normalizeGithubRelease,
  subjectFromCommitMessage,
} from "./release-labels.mjs";

const GH_TTL_MS = Number(process.env.DASH_GIT_POLL_MS || 30_000);
/** Back off longer after hard failures so we don't hammer a 403 rate-limit. */
const GH_ERR_TTL_MS = Math.max(GH_TTL_MS, 120_000);
/** Releases change slowly — don't burn the unauthenticated 60/hr quota. */
const RELEASE_TTL_MS = Math.max(GH_TTL_MS, Number(process.env.DASH_RELEASE_POLL_MS || 300_000));

/** @type {{
 *   at: number,
 *   key: string | null,
 *   tipSha: string | null,
 *   tipMessage: string | null,
 *   recent: object[],
 *   pending: object[],
 *   releases: object[],
 *   releasesAt: number,
 *   behindCount: number,
 *   inflight: Promise<void> | null,
 *   errAt: number,
 *   root: string | null,
 * }} */
let cache = {
  at: 0,
  key: null,
  tipSha: null,
  tipMessage: null,
  recent: [],
  pending: [],
  releases: [],
  releasesAt: 0,
  behindCount: 0,
  inflight: null,
  errAt: 0,
  root: null,
};

export function clearGithubHistoryCacheForTests() {
  cache = {
    at: 0,
    key: null,
    tipSha: null,
    tipMessage: null,
    recent: [],
    pending: [],
    releases: [],
    releasesAt: 0,
    behindCount: 0,
    inflight: null,
    errAt: 0,
    root: null,
  };
}

function releasesDiskPath(root) {
  return join(runtimePaths(root).dataDir, "github-releases-cache.json");
}

export function loadDiskReleases(root) {
  if (!root) return [];
  try {
    const raw = JSON.parse(readFileSync(releasesDiskPath(root), "utf8"));
    const list = Array.isArray(raw?.releases) ? raw.releases.filter((r) => r?.tag) : [];
    if (list.length) return list;
  } catch { /* fall through to bundled seed */ }
  try {
    const seedPath = join(root, "deploy", "github-releases-seed.json");
    const raw = JSON.parse(readFileSync(seedPath, "utf8"));
    return Array.isArray(raw?.releases) ? raw.releases.filter((r) => r?.tag) : [];
  } catch {
    return [];
  }
}

export function saveDiskReleases(root, releases) {
  if (!root || !Array.isArray(releases) || !releases.length) return;
  try {
    mkdirSync(runtimePaths(root).dataDir, { recursive: true });
    writeFileSync(
      releasesDiskPath(root),
      JSON.stringify({ at: Date.now(), releases }),
    );
  } catch { /* volume may be read-only in odd setups */ }
}

function ensureDiskReleases() {
  if (cache.releases.length || !cache.root) return;
  const disk = loadDiskReleases(cache.root);
  if (disk.length) {
    cache.releases = disk;
    cache.releasesAt = Date.now();
  }
}

function githubHeaders() {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "dlmmbot-dashboard",
  };
  const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Soft-fail: never throw — 403/network must not become unhandled rejections. */
export async function githubJson(url) {
  try {
    const res = await fetch(url, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Same risk buckets as local `riskTagsForSha` in live-book-snapshot. */
export function riskTagsFromPaths(paths) {
  const tags = new Set();
  for (const raw of paths) {
    const f = String(raw || "").replace(/\\/g, "/");
    if (!f) continue;
    if (/^dashboard\//.test(f) || /^deploy\/dashboard-server/.test(f)) tags.add("dash");
    else if (/^(docs\/|docs-site\/|llms)/.test(f) || /\.md$/i.test(f)) tags.add("docs");
    else if (/package(-lock)?\.json$/.test(f) || /^dashboard\/package/.test(f)) tags.add("deps");
    else if (/^deploy\//.test(f) || /^\.github\//.test(f) || /^railway/.test(f)) tags.add("deploy");
    else if (
      /^src\/(manager|risk|ranges|scanner|vetting)\//.test(f)
      || f === "STRATEGY.md"
      || f === "config.toml"
      || /^src\/executor\//.test(f)
    ) tags.add("strategy");
    else if (/^src\//.test(f)) tags.add("core");
  }
  const order = ["strategy", "deps", "deploy", "core", "dash", "docs"];
  return order.filter((t) => tags.has(t));
}

export function normalizeGithubCommit(c, { files } = {}) {
  const full = typeof c?.sha === "string" ? c.sha : null;
  const msg = String(c?.commit?.message ?? c?.message ?? "");
  const subject = subjectFromCommitMessage(msg);
  const dateStr = c?.commit?.committer?.date || c?.commit?.author?.date || c?.date;
  const atMs = dateStr ? Date.parse(dateStr) : NaN;
  const paths = Array.isArray(files)
    ? files.map((f) => (typeof f === "string" ? f : f?.filename)).filter(Boolean)
    : Array.isArray(c?.files)
      ? c.files.map((f) => f?.filename).filter(Boolean)
      : [];
  const risk = paths.length ? riskTagsFromPaths(paths) : [];
  return {
    sha: shortSha(full),
    full,
    subject,
    at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : null,
    ts: Number.isFinite(atMs) ? Math.floor(atMs / 1000) : null,
    ...(risk.length ? { risk } : {}),
  };
}

function parseGithubUrl(repoUrl) {
  const m = String(repoUrl || "").match(/github\.com[/:]([^/]+)\/([^/#?\s]+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/i, "") };
}

function markFail(key) {
  ensureDiskReleases();
  cache = {
    ...cache,
    at: Date.now(),
    errAt: Date.now(),
    key,
    inflight: null,
  };
}

/**
 * Stale-while-revalidate cache of tip + commits + releases for Changes.
 * @param {{ repoUrl: string, branch: string, headFull: string | null, releasesOnly?: boolean, root?: string }} opts
 */
export function scheduleGithubHistory({
  repoUrl,
  branch,
  headFull,
  releasesOnly = false,
  root = null,
} = {}) {
  const parsed = parseGithubUrl(repoUrl);
  if (!parsed || !branch) return;
  if (root) cache.root = root;
  ensureDiskReleases();

  const key = `${parsed.owner}/${parsed.repo}@${branch}|${headFull || ""}|${releasesOnly ? "r" : "f"}`;
  const now = Date.now();
  const ttl = cache.errAt && now - cache.errAt < GH_ERR_TTL_MS ? GH_ERR_TTL_MS : GH_TTL_MS;
  if (cache.key === key && now - cache.at < ttl) return;
  if (cache.inflight) return;

  cache.inflight = (async () => {
    try {
      const { owner, repo } = parsed;
      const base = `https://api.github.com/repos/${owner}/${repo}`;
      const needReleases = !cache.releases.length
        || (now - cache.releasesAt) > RELEASE_TTL_MS;

      const tipP = githubJson(`${base}/commits/${encodeURIComponent(branch)}`);
      const relP = needReleases
        ? githubJson(`${base}/releases?per_page=12`)
        : Promise.resolve(null);

      const [tip, relRaw] = await Promise.all([tipP, relP]);

      if (!tip && needReleases && !Array.isArray(relRaw)) {
        markFail(key);
        return;
      }

      const tipSha = typeof tip?.sha === "string" ? tip.sha : null;
      const tipMessage = tip
        ? subjectFromCommitMessage(String(tip?.commit?.message ?? ""))
        : null;

      let releases = cache.releases;
      let releasesAt = cache.releasesAt;
      if (needReleases) {
        if (Array.isArray(relRaw)) {
          const next = relRaw.map(normalizeGithubRelease).filter(Boolean);
          if (next.length) {
            releases = next;
            releasesAt = Date.now();
            saveDiskReleases(cache.root, releases);
          }
        } else {
          // Keep memory/disk releases; tip may still have succeeded.
          ensureDiskReleases();
          releases = cache.releases;
        }
      }

      let recent = cache.recent;
      let pending = cache.pending;
      let behindCount = cache.behindCount;

      if (!releasesOnly) {
        const recentSha = headFull || tipSha || branch;
        const recentRaw = await githubJson(
          `${base}/commits?sha=${encodeURIComponent(recentSha)}&per_page=20`,
        );
        recent = Array.isArray(recentRaw)
          ? labelCommits(recentRaw.map((c) => normalizeGithubCommit(c)), releases)
          : [];

        pending = [];
        behindCount = 0;
        if (headFull && tipSha && !shasMatch(headFull, tipSha)) {
          const cmp = await githubJson(
            `${base}/compare/${encodeURIComponent(headFull)}...${encodeURIComponent(tipSha)}`,
          );
          behindCount = typeof cmp?.ahead_by === "number" ? cmp.ahead_by : 0;
          const commits = Array.isArray(cmp?.commits) ? [...cmp.commits].reverse() : [];
          const enriched = [];
          for (let i = 0; i < Math.min(commits.length, 20); i++) {
            const c = commits[i];
            if (i < 5 && c?.sha) {
              const detail = await githubJson(`${base}/commits/${c.sha}`);
              if (detail) {
                enriched.push(normalizeGithubCommit(detail));
                continue;
              }
            }
            enriched.push(normalizeGithubCommit(c));
          }
          pending = labelCommits(enriched, releases);
        }
      } else if (cache.recent.length) {
        recent = labelCommits(cache.recent, releases);
        pending = labelCommits(cache.pending, releases);
      }

      cache = {
        at: Date.now(),
        key,
        tipSha: tipSha ?? cache.tipSha,
        tipMessage: tipMessage ?? cache.tipMessage,
        recent,
        pending,
        releases,
        releasesAt,
        behindCount,
        inflight: null,
        errAt: tip || (needReleases && Array.isArray(relRaw)) ? 0 : cache.errAt,
        root: cache.root,
      };
    } catch {
      markFail(key);
    }
  })().catch(() => {
    markFail(key);
  });
}

/** Snapshot of last successful GitHub history fetch (may be empty on first hit). */
export function readGithubHistoryCache(root = null) {
  if (root) cache.root = root;
  ensureDiskReleases();
  return {
    tipSha: cache.tipSha,
    tipMessage: cache.tipMessage,
    recent: cache.recent,
    pending: cache.pending,
    releases: cache.releases,
    behindCount: cache.behindCount,
    fetchedAt: cache.at || null,
    ok: !!(cache.tipSha || cache.recent.length || cache.releases.length),
  };
}

export { labelCommits, operatorCommitLabel, summarizeReleaseBody } from "./release-labels.mjs";
