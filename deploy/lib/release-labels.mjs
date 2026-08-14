/**
 * Operator-facing labels for Changes tab — prefer release notes over
 * "Merge pull request #N" / bare "Release vX.Y.Z" subjects.
 */

/** Prefer merge-commit body line over GitHub's default merge subject. */
export function subjectFromCommitMessage(msg) {
  const lines = String(msg || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const first = lines[0] || "(no subject)";
  if (/^Merge pull request #\d+/i.test(first) && lines[1]) {
    return lines[1].slice(0, 160);
  }
  return first.slice(0, 160);
}

/** Plain one-liner from a GitHub release body (markdown-ish). */
export function summarizeReleaseBody(body, maxLen = 220) {
  if (!body || typeof body !== "string") return null;
  const skip = /^(#{1,3}\s|full changelog|\*\*full changelog|what's changed|<!--|semver bump|release v?\d)/i;
  const lines = body
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l
      .replace(/^#+\s*/, "")
      .replace(/^\*\*(.+)\*\*$/, "$1")
      .replace(/^[*•\-]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/\s+by @\S+ in https?:\/\/\S+/gi, "")
      .trim())
    .filter((l) => l && !skip.test(l) && l.length > 2);
  if (!lines.length) return null;
  const joined = lines.slice(0, 3).join(" · ");
  return joined.length > maxLen ? `${joined.slice(0, maxLen - 1)}…` : joined;
}

export function normalizeGithubRelease(r) {
  const tag = typeof r?.tag_name === "string" ? r.tag_name : null;
  if (!tag) return null;
  const body = typeof r?.body === "string" ? r.body : "";
  const published = r?.published_at || r?.created_at;
  const atMs = published ? Date.parse(published) : NaN;
  const name = typeof r?.name === "string" && r.name.trim() ? r.name.trim() : tag;
  return {
    tag,
    name,
    summary: summarizeReleaseBody(body) || (name !== tag ? name : null),
    body: body.slice(0, 4000) || null,
    at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : null,
    ts: Number.isFinite(atMs) ? Math.floor(atMs / 1000) : null,
    url: typeof r?.html_url === "string" ? r.html_url : null,
  };
}

function tagFromText(s) {
  const m = /\bv?(\d+\.\d+\.\d+)\b/i.exec(s);
  return m ? `v${m[1]}` : null;
}

/**
 * Rewrite noisy git subjects using release notes when available.
 * @param {string} subject
 * @param {Array<{ tag: string, summary?: string | null, name?: string | null }>} releases
 */
export function operatorCommitLabel(subject, releases = []) {
  const s = String(subject || "").trim();
  if (!s) return "(no subject)";

  const mergeRel = /Merge pull request #\d+ from [^/\s]+\/release\/(v?\d+\.\d+\.\d+)/i.exec(s);
  if (mergeRel) {
    const tag = mergeRel[1].startsWith("v") ? mergeRel[1] : `v${mergeRel[1]}`;
    const rel = releases.find((r) => r.tag === tag);
    if (rel?.summary) return `${tag} — ${rel.summary}`;
    return `${tag} — release`;
  }

  const mergeFeat = /Merge pull request #(\d+) from .+/i.exec(s);
  if (mergeFeat) {
    return `Merge PR #${mergeFeat[1]}`;
  }

  const bareRel = /^Release (v?\d+\.\d+\.\d+)(?:\s*[—–-]\s*(.+))?$/i.exec(s);
  if (bareRel) {
    const tag = bareRel[1].startsWith("v") ? bareRel[1] : `v${bareRel[1]}`;
    const inline = (bareRel[2] || "").trim();
    if (inline && !/^semver bump/i.test(inline)) return `${tag} — ${inline}`;
    const rel = releases.find((r) => r.tag === tag);
    if (rel?.summary) return `${tag} — ${rel.summary}`;
    if (rel?.name && rel.name !== tag && !/^DLMM Bot /i.test(rel.name)) {
      return `${tag} — ${rel.name}`;
    }
    return tag;
  }

  // "Sync develop with main after v0.3.11" → keep as-is but prefer release blurb if only a sync
  const syncAfter = /^Sync develop with main after (v?\d+\.\d+\.\d+)/i.exec(s);
  if (syncAfter) {
    const tag = syncAfter[1].startsWith("v") ? syncAfter[1] : `v${syncAfter[1]}`;
    return `Synced develop ← ${tag}`;
  }

  const tag = tagFromText(s);
  if (tag && /^release\b/i.test(s)) {
    const rel = releases.find((r) => r.tag === tag);
    if (rel?.summary && s.length < 40) return `${tag} — ${rel.summary}`;
  }

  return s.length > 160 ? `${s.slice(0, 159)}…` : s;
}

/** Attach display labels to commit rows. */
export function labelCommits(commits, releases) {
  if (!Array.isArray(commits)) return [];
  return commits.map((c) => ({
    ...c,
    subject: operatorCommitLabel(c.subject ?? c.message ?? "", releases),
  }));
}
