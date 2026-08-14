/**
 * GitHub commit history for PaaS hosts (Railway, etc.) where local `.git`
 * is missing or not trustworthy. Used by live-book-snapshot for Changes tab.
 */
import { shortSha, shasMatch } from "./git-source.mjs";

const GH_TTL_MS = Number(process.env.DASH_GIT_POLL_MS || 30_000);

/** @type {{
 *   at: number,
 *   key: string | null,
 *   tipSha: string | null,
 *   tipMessage: string | null,
 *   recent: object[],
 *   pending: object[],
 *   behindCount: number,
 *   inflight: Promise<void> | null,
 * }} */
let cache = {
  at: 0,
  key: null,
  tipSha: null,
  tipMessage: null,
  recent: [],
  pending: [],
  behindCount: 0,
  inflight: null,
};

export function clearGithubHistoryCacheForTests() {
  cache = {
    at: 0,
    key: null,
    tipSha: null,
    tipMessage: null,
    recent: [],
    pending: [],
    behindCount: 0,
    inflight: null,
  };
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

async function githubJson(url) {
  const res = await fetch(url, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`github ${res.status}`);
  return res.json();
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
  const subject = msg.split("\n")[0].slice(0, 120) || "(no subject)";
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

/**
 * Stale-while-revalidate cache of tip + commit lists for Changes on PaaS.
 * @param {{ repoUrl: string, branch: string, headFull: string | null }} opts
 */
export function scheduleGithubHistory({ repoUrl, branch, headFull }) {
  const parsed = parseGithubUrl(repoUrl);
  if (!parsed || !branch) return;
  const key = `${parsed.owner}/${parsed.repo}@${branch}|${headFull || ""}`;
  const now = Date.now();
  if (cache.key === key && now - cache.at < GH_TTL_MS) return;
  if (cache.inflight) return;

  cache.inflight = (async () => {
    try {
      const { owner, repo } = parsed;
      const base = `https://api.github.com/repos/${owner}/${repo}`;

      const tip = await githubJson(
        `${base}/commits/${encodeURIComponent(branch)}`,
      );
      const tipSha = typeof tip?.sha === "string" ? tip.sha : null;
      const tipMessage = String(tip?.commit?.message ?? "").split("\n")[0].slice(0, 120) || null;

      // History of what is running (walk from deployed SHA when known).
      const recentSha = headFull || tipSha || branch;
      const recentRaw = await githubJson(
        `${base}/commits?sha=${encodeURIComponent(recentSha)}&per_page=20`,
      );
      const recent = Array.isArray(recentRaw)
        ? recentRaw.map((c) => normalizeGithubCommit(c))
        : [];

      let pending = [];
      let behindCount = 0;
      if (headFull && tipSha && !shasMatch(headFull, tipSha)) {
        const cmp = await githubJson(
          `${base}/compare/${encodeURIComponent(headFull)}...${encodeURIComponent(tipSha)}`,
        );
        behindCount = typeof cmp?.ahead_by === "number" ? cmp.ahead_by : 0;
        const commits = Array.isArray(cmp?.commits) ? [...cmp.commits].reverse() : [];
        // Enrich first few with file-based risk tags (rate-limit friendly).
        const enriched = [];
        for (let i = 0; i < Math.min(commits.length, 20); i++) {
          const c = commits[i];
          if (i < 5 && c?.sha) {
            try {
              const detail = await githubJson(`${base}/commits/${c.sha}`);
              enriched.push(normalizeGithubCommit(detail));
              continue;
            } catch { /* fall through */ }
          }
          enriched.push(normalizeGithubCommit(c));
        }
        pending = enriched;
      }

      cache = {
        at: Date.now(),
        key,
        tipSha,
        tipMessage,
        recent,
        pending,
        behindCount,
        inflight: null,
      };
    } catch {
      cache = { ...cache, at: Date.now(), key, inflight: null };
    }
  })();
}

/** Snapshot of last successful GitHub history fetch (may be empty on first hit). */
export function readGithubHistoryCache() {
  return {
    tipSha: cache.tipSha,
    tipMessage: cache.tipMessage,
    recent: cache.recent,
    pending: cache.pending,
    behindCount: cache.behindCount,
    fetchedAt: cache.at || null,
    ok: !!(cache.tipSha || cache.recent.length),
  };
}
