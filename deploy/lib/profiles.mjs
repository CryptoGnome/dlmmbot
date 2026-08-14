/**
 * Settings profiles — official (repo), local (data/profiles), community (GitHub).
 */
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { runtimePaths } from "./runtime-paths.mjs";
import { applyConfigUpdates, flattenConfig, parseConfig } from "./config-edit.mjs";

/** Bot-settings paths profiles may touch. Never includes secrets or exec.mode. */
export const PROFILE_ALLOWLIST = new Set([
  "sizing.max_positions",
  "sizing.min_position_sol",
  "sizing.kelly_max_position_frac",
  "sizing.reserve_sol",
  "manage.stop_loss_frac",
  "manage.claim_min_sol",
  "manage.profit_lock_enabled",
  "manage.max_age_h",
  "gates.mcap_min_usd",
  "gates.tvl_min_usd",
  "gates.tvl_max_usd",
  "gates.vol_30m_min_usd",
  "gates.fee_tvl_24h_min_pct",
  "gates.fee_tvl_30m_daily_min_pct",
  "gates.max_pool_share_pct",
  "entry.bin_rent_budget_sol",
  "entry.bin_rent_hard_sol",
  "vetting.age_min_enabled",
  "vetting.age_min_minutes",
  "vetting.age_max_enabled",
  "vetting.age_max_days",
  "vetting.insider_gate_enabled",
  "vetting.insider_cluster_max_pct",
  "vetting.holder_gate_enabled",
  "vetting.single_holder_max_pct",
  "vetting.top10_max_pct",
  "vetting.rugcheck_veto_enabled",
  "vetting.rugcheck_veto_normalised",
  "vetting.creator_rug_enabled",
  "vetting.gmgn_security_enabled",
  "entry.tranche_enabled",
  "follow.enabled",
  "manage.reentry_max_per_24h",
  "manage.loss_reentry_cooldown_h",
  "rotation.displacement_enabled",
  "gmgn.enabled",
  "majors.enabled",
  "majors.size_sol",
  "majors.max_slots",
  "majors.symbol_allowlist",
]);

const BLOCKED = new Set(["exec.mode"]);

const CACHE_MS = 10 * 60 * 1000;
/** @type {{ at: number, index: object | null, profiles: Map<string, object> }} */
let communityCache = { at: 0, index: null, profiles: new Map() };

function profilesRepo() {
  return process.env.PROFILES_REPO || "CryptoGnome/dlmmbot";
}
function profilesRef() {
  return process.env.PROFILES_REF || "master";
}
function rawBase() {
  return `https://raw.githubusercontent.com/${profilesRepo()}/${profilesRef()}/profiles`;
}

function localDir(root) {
  const dir = join(runtimePaths(root).dataDir, "profiles");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function officialDir(root) {
  return resolve(root, "profiles", "official");
}

function slugify(name) {
  return String(name || "profile")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "profile";
}

export { slugify };

/**
 * @param {unknown} raw
 * @returns {{ ok: true, profile: object } | { ok: false, error: string }}
 */
export function parseProfile(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return { ok: false, error: "invalid JSON" }; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, error: "profile must be an object" };
  }
  if (obj.schema !== 1) return { ok: false, error: "unsupported schema (need 1)" };
  if (!obj.id || typeof obj.id !== "string") return { ok: false, error: "missing id" };
  if (!obj.name || typeof obj.name !== "string") return { ok: false, error: "missing name" };
  if (!obj.updates || typeof obj.updates !== "object" || Array.isArray(obj.updates)) {
    return { ok: false, error: "missing updates" };
  }
  return { ok: true, profile: obj };
}

/** Strip blocked / unknown paths from updates. */
export function sanitizeUpdates(updates) {
  /** @type {Record<string, unknown>} */
  const out = {};
  /** @type {string[]} */
  const dropped = [];
  for (const [k, v] of Object.entries(updates || {})) {
    if (BLOCKED.has(k) || !PROFILE_ALLOWLIST.has(k)) {
      dropped.push(k);
      continue;
    }
    out[k] = v;
  }
  return { updates: out, dropped };
}

export function readOfficialProfiles(root) {
  const dir = officialDir(root);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    try {
      const parsed = parseProfile(readFileSync(join(dir, f), "utf8"));
      if (parsed.ok) out.push({ ...parsed.profile, source: "official", file: f });
    } catch { /* skip bad file */ }
  }
  return out;
}

export function readLocalProfiles(root) {
  const dir = localDir(root);
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    try {
      const parsed = parseProfile(readFileSync(join(dir, f), "utf8"));
      if (parsed.ok) out.push({ ...parsed.profile, source: "local", file: f });
    } catch { /* skip */ }
  }
  return out;
}

export function listProfiles(root) {
  return {
    official: readOfficialProfiles(root),
    local: readLocalProfiles(root),
    share: shareMeta(),
  };
}

export function shareMeta() {
  const repo = profilesRepo();
  const ref = profilesRef();
  const docsUrl = process.env.PROFILES_DOCS_URL || "https://dlmmbot.com/setup/profiles";
  return {
    repo,
    ref,
    /** Opens GitHub “create file”; non-collaborators are prompted to fork (browser-only — fine on Railway). */
    new_file_base: `https://github.com/${repo}/new/${ref}?filename=profiles/community/`,
    edit_index_url: `https://github.com/${repo}/edit/${ref}/profiles/community/index.json`,
    /** Public docs (VitePress) — not the GitHub README. */
    docs_url: docsUrl,
    /** @deprecated alias of docs_url for older dashboard builds */
    community_readme: docsUrl,
    fork_hint:
      "You do not need git on your bot host. Use github.com in the browser. If you are not a collaborator, GitHub asks you to Fork first — that is expected.",
  };
}

export function snapshotAllowlistedConfig(root) {
  const flat = flattenConfig(parseConfig(root));
  /** @type {Record<string, unknown>} */
  const updates = {};
  for (const path of PROFILE_ALLOWLIST) {
    if (path in flat) updates[path] = flat[path];
  }
  return updates;
}

/**
 * @param {string} root
 * @param {{ name: string, description?: string, author?: string, tags?: string[], id?: string }} opts
 */
export function saveLocalProfile(root, opts) {
  const name = String(opts.name || "").trim();
  if (!name) throw new Error("name required");
  const id = slugify(opts.id || name);
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error("id must be lowercase slug");
  const { updates } = sanitizeUpdates(snapshotAllowlistedConfig(root));
  const profile = {
    schema: 1,
    id,
    name,
    description: String(opts.description || "").slice(0, 400),
    author: String(opts.author || "local").slice(0, 64),
    tags: Array.isArray(opts.tags) ? opts.tags.map(String).slice(0, 8) : ["local"],
    updated: new Date().toISOString().slice(0, 10),
    updates,
  };
  const path = join(localDir(root), `${id}.json`);
  writeFileSync(path, JSON.stringify(profile, null, 2) + "\n", "utf8");
  return { ...profile, source: "local", file: `${id}.json` };
}

export function deleteLocalProfile(root, id) {
  const safe = slugify(id);
  const path = join(localDir(root), `${safe}.json`);
  if (!existsSync(path)) throw new Error("local profile not found");
  unlinkSync(path);
  return { ok: true, id: safe };
}

function findOfficial(root, id) {
  return readOfficialProfiles(root).find((p) => p.id === id) || null;
}

function findLocal(root, id) {
  return readLocalProfiles(root).find((p) => p.id === id) || null;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json,text/plain,*/*" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export async function fetchCommunityIndex() {
  const now = Date.now();
  if (communityCache.index && now - communityCache.at < CACHE_MS) {
    return communityCache.index;
  }
  try {
    const text = await fetchText(`${rawBase()}/community/index.json`);
    const index = JSON.parse(text);
    communityCache = { at: now, index, profiles: communityCache.profiles };
    return index;
  } catch (e) {
    if (communityCache.index) return communityCache.index;
    return { schema: 1, profiles: [], error: e.message ?? String(e) };
  }
}

export async function fetchCommunityProfile(id) {
  const safe = slugify(id);
  const now = Date.now();
  if (communityCache.profiles.has(safe) && now - communityCache.at < CACHE_MS) {
    return communityCache.profiles.get(safe);
  }
  const index = await fetchCommunityIndex();
  const meta = (index.profiles || []).find((p) => p.id === safe);
  const file = meta?.file || `${safe}.json`;
  const text = await fetchText(`${rawBase()}/community/${file}`);
  const parsed = parseProfile(text);
  if (!parsed.ok) throw new Error(parsed.error);
  communityCache.profiles.set(safe, { ...parsed.profile, source: "community", file });
  return communityCache.profiles.get(safe);
}

export async function listCommunityProfiles() {
  const index = await fetchCommunityIndex();
  const share = shareMeta();
  return {
    profiles: index.profiles || [],
    error: index.error || null,
    share,
    fetched_at: communityCache.at || null,
  };
}

/**
 * Resolve a profile by source+id, or use inline updates.
 * @returns {{ profile: object | null, updates: Record<string, unknown>, dropped: string[] }}
 */
export async function resolveProfileUpdates(root, body) {
  if (body?.updates && typeof body.updates === "object") {
    const { updates, dropped } = sanitizeUpdates(body.updates);
    return { profile: null, updates, dropped };
  }
  const source = body?.source;
  const id = body?.id;
  if (!source || !id) throw new Error("pass { source, id } or { updates }");
  let profile = null;
  if (source === "official") profile = findOfficial(root, id);
  else if (source === "local") profile = findLocal(root, id);
  else if (source === "community") profile = await fetchCommunityProfile(id);
  else throw new Error(`unknown source: ${source}`);
  if (!profile) throw new Error(`profile not found: ${source}/${id}`);
  const { updates, dropped } = sanitizeUpdates(profile.updates);
  return { profile, updates, dropped };
}

export function previewProfileDiff(root, updates) {
  const flat = flattenConfig(parseConfig(root));
  /** @type {Array<{ path: string, from: unknown, to: unknown }>} */
  const changes = [];
  for (const [path, to] of Object.entries(updates)) {
    const from = flat[path];
    const same =
      Array.isArray(from) && Array.isArray(to)
        ? JSON.stringify(from) === JSON.stringify(to)
        : from === to;
    if (!same) changes.push({ path, from: from ?? null, to });
  }
  return { changes, current: flat };
}

export function applyProfileUpdates(root, updates) {
  const { updates: clean, dropped } = sanitizeUpdates(updates);
  if (!Object.keys(clean).length) throw new Error("no allowlisted updates to apply");
  const result = applyConfigUpdates(root, clean);
  return { ...result, dropped };
}

export function githubProposeUrl(slug) {
  const safe = slugify(slug);
  const share = shareMeta();
  return `${share.new_file_base}${safe}.json`;
}
