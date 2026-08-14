import type { HistorySnap, LiveWatch, RangeKey } from "./types";
import { tokenFromUrl } from "./utils";

const WATCH_KEY = "dlmm_dash_watch";
const HIST_PREFIX = "dlmm_dash_hist_";
const SETTINGS_KEY = "dlmm_dash_settings";
const LEGACY_WATCH_KEY = "meteora_dash_watch";
const LEGACY_HIST_PREFIX = "meteora_dash_hist_";
const LEGACY_SETTINGS_KEY = "meteora_dash_settings";

type Envelope<T> = { at: number; data: T };

function read<T>(key: string): Envelope<T> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Envelope<T>;
    if (!parsed?.data || typeof parsed.at !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function write<T>(key: string, data: T): void {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* quota / private mode */
  }
}

function authHeaders(): HeadersInit {
  const t = tokenFromUrl();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export function cachedWatch(): LiveWatch | null {
  return read<LiveWatch>(WATCH_KEY)?.data
    ?? read<LiveWatch>(LEGACY_WATCH_KEY)?.data
    ?? null;
}

export function cachedHistory(range: RangeKey): HistorySnap | null {
  return read<HistorySnap>(HIST_PREFIX + range)?.data
    ?? read<HistorySnap>(LEGACY_HIST_PREFIX + range)?.data
    ?? null;
}

export type SettingsBundle = {
  config: FlatConfig;
  env: EnvRow[];
  setup: SetupStatus;
};

export function cachedSettings(): SettingsBundle | null {
  return read<SettingsBundle>(SETTINGS_KEY)?.data
    ?? read<SettingsBundle>(LEGACY_SETTINGS_KEY)?.data
    ?? null;
}

function cacheSettings(bundle: SettingsBundle): void {
  write(SETTINGS_KEY, bundle);
}

export function refreshSettingsCache(patch: Partial<SettingsBundle>): void {
  const cur = cachedSettings();
  if (!cur) return;
  cacheSettings({ ...cur, ...patch });
}

/** One round-trip for Settings boot (config + env + setup). Falls back on older dash servers. */
export async function fetchSettingsBootstrap(opts?: {
  onStatus?: (line: string) => void;
}): Promise<SettingsBundle> {
  const note = opts?.onStatus ?? (() => {});
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  note("Contacting dashboard…");
  try {
    note("GET /api/settings (config + env + setup)…");
    const res = await fetch(`/api/settings${q}`, { headers: authHeaders() });
    if (res.ok) {
      note("Reading response…");
      const data = await res.json() as SettingsBundle;
      const n = data.config ? Object.keys(data.config).length : 0;
      note(`Got ${n} setting(s)${data.env ? `, ${data.env.length} env row(s)` : ""}`);
      cacheSettings(data);
      note("Cached for next open");
      return data;
    }
    note(`Combined endpoint returned ${res.status} — falling back…`);
  } catch {
    note("Combined endpoint unavailable — fetching pieces separately…");
  }
  note("GET /api/config…");
  const configP = fetchConfig();
  note("GET /api/env…");
  const envP = fetchEnv();
  note("GET /api/setup/status…");
  const setupP = fetchSetupStatus();
  const [config, env, setup] = await Promise.all([configP, envP, setupP]);
  note(`Got ${Object.keys(config).length} setting(s), ${env.length} env row(s)`);
  const bundle = { config, env, setup };
  cacheSettings(bundle);
  note("Cached for next open");
  return bundle;
}

export async function fetchWatch(): Promise<LiveWatch> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/watch${q}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`watch ${res.status}`);
  const data = await res.json() as LiveWatch;
  write(WATCH_KEY, data);
  return data;
}

export async function fetchHistory(range: RangeKey): Promise<HistorySnap> {
  const t = tokenFromUrl();
  const params = new URLSearchParams({ range });
  if (t) params.set("token", t);
  const res = await fetch(`/api/history?${params}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`history ${res.status}`);
  const data = await res.json() as HistorySnap;
  write(HIST_PREFIX + range, data);
  return data;
}

export type FlatConfig = Record<string, string | number | boolean | string[] | null>;

export async function fetchConfig(): Promise<FlatConfig> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/config${q}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`config ${res.status}`);
  const data = await res.json() as { config: FlatConfig };
  return data.config;
}

export async function patchConfig(updates: Record<string, unknown>): Promise<{
  applied: string[];
  config: FlatConfig;
}> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/config${q}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ updates }),
  });
  const data = await res.json() as { applied?: string[]; config?: FlatConfig; error?: string };
  if (!res.ok) throw new Error(data.error ?? `config patch ${res.status}`);
  return { applied: data.applied ?? [], config: data.config ?? {} };
}

export type MajorsSearchHit = {
  symbol: string;
  poolCount: number;
  onAllowlist: boolean;
  best: {
    address: string;
    name: string;
    quote: string;
    tvlUsd: number;
    feeTvl24hPct: number;
    vol30mUsd: number;
    ageDays: number | null;
    gateFails: string[];
    statusTone: "ok" | "warn" | "dim";
    statusText: string;
    ready: boolean;
  };
};

export async function searchMajorsSymbols(q: string, limit = 12): Promise<{
  query: string;
  hits: MajorsSearchHit[];
  cachedAt: number | null;
}> {
  const t = tokenFromUrl();
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (t) params.set("token", t);
  const res = await fetch(`/api/majors/search?${params}`, { headers: authHeaders() });
  const data = await res.json() as { hits?: MajorsSearchHit[]; query?: string; cachedAt?: number | null; error?: string };
  if (!res.ok) throw new Error(data.error ?? `majors search ${res.status}`);
  return { query: data.query ?? q, hits: data.hits ?? [], cachedAt: data.cachedAt ?? null };
}

export type EnvRow = {
  key: string;
  set: boolean;
  secret: boolean;
  value: string | null;
  editable?: boolean;
};

export async function fetchEnv(): Promise<EnvRow[]> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/env${q}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`env ${res.status}`);
  const data = await res.json() as { env: EnvRow[] };
  return data.env;
}

export async function unlockSecrets(confirm: string): Promise<{ ok: boolean; keys: string[] }> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/secrets/unlock${q}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ confirm }),
  });
  const data = await res.json() as { ok?: boolean; keys?: string[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? `unlock ${res.status}`);
  return { ok: !!data.ok, keys: data.keys ?? [] };
}

export async function patchSecrets(
  confirm: string,
  updates: Record<string, string>,
): Promise<{ applied: string[]; env: EnvRow[]; note?: string }> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/secrets${q}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ confirm, updates }),
  });
  const data = await res.json() as {
    applied?: string[]; env?: EnvRow[]; note?: string; error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? `secrets ${res.status}`);
  return { applied: data.applied ?? [], env: data.env ?? [], note: data.note };
}

export type SetupStatus = {
  needsWizard: boolean;
  needsTerms: boolean;
  termsVersion: string;
  coreReady: boolean;
  hasRpc: boolean;
  hasJupiterApiKey: boolean;
  hasGmgnApiKey: boolean;
  farmerMode: string;
  setup: {
    completed: boolean;
    skipped: boolean;
    completedAt: string | null;
    termsVersion: string | null;
    termsAcceptedAt: string | null;
  };
  wallet: {
    encrypted: boolean;
    unlocked: boolean;
    /** True if encrypted file OR plain .env key is present. */
    ready?: boolean;
    /** env | unlocked | encrypted | none */
    source?: string;
    publicKey: string | null;
    createdAt: string | null;
  };
};

export async function fetchSetupStatus(): Promise<SetupStatus> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/setup/status${q}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`setup ${res.status}`);
  return await res.json() as SetupStatus;
}

export async function fetchTerms(): Promise<{ version: string; markdown: string }> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/setup/terms${q}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`terms ${res.status}`);
  return await res.json() as { version: string; markdown: string };
}

export async function acceptTerms(opts: {
  confirm: string;
  version: string;
}): Promise<SetupStatus & { ok: boolean }> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/setup/accept-terms${q}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      confirm: opts.confirm,
      version: opts.version,
      accepted: true,
    }),
  });
  const data = await res.json() as SetupStatus & { ok?: boolean; error?: string };
  if (!res.ok) throw new Error(data.error ?? `accept terms ${res.status}`);
  return { ...data, ok: !!data.ok };
}

export async function completeSetup(opts?: { skipped?: boolean }): Promise<SetupStatus & { ok: boolean }> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/setup/complete${q}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ skipped: !!opts?.skipped }),
  });
  const data = await res.json() as SetupStatus & { ok?: boolean; error?: string };
  if (!res.ok) throw new Error(data.error ?? `setup complete ${res.status}`);
  return { ...data, ok: !!data.ok };
}

export async function generateWallet(opts: {
  confirm: string;
  passphrase: string;
  overwrite?: boolean;
}): Promise<{ publicKey: string; secretOnce: string; note?: string; status: SetupStatus }> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/wallet/generate${q}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  const data = await res.json() as {
    publicKey?: string; secretOnce?: string; note?: string; status?: SetupStatus; error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? `wallet generate ${res.status}`);
  return {
    publicKey: data.publicKey!,
    secretOnce: data.secretOnce!,
    note: data.note,
    status: data.status!,
  };
}

export async function importWallet(opts: {
  confirm: string;
  passphrase: string;
  secret: string;
  overwrite?: boolean;
}): Promise<{ publicKey: string; note?: string; status: SetupStatus }> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/wallet/import${q}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  const data = await res.json() as {
    publicKey?: string; note?: string; status?: SetupStatus; error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? `wallet import ${res.status}`);
  return { publicKey: data.publicKey!, note: data.note, status: data.status! };
}

export async function unlockWallet(opts: {
  confirm: string;
  passphrase: string;
}): Promise<{ ok: boolean; publicKey: string; note?: string; status: SetupStatus }> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/wallet/unlock${q}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  const data = await res.json() as {
    ok?: boolean; publicKey?: string; note?: string; status?: SetupStatus; error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? `wallet unlock ${res.status}`);
  return {
    ok: !!data.ok,
    publicKey: data.publicKey!,
    note: data.note,
    status: data.status!,
  };
}

export type DeployPrefs = {
  autoUpdate: boolean;
  approveSha: string | null;
  approvedAt: string | null;
};

export async function fetchDeployPrefs(): Promise<DeployPrefs> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/deploy-prefs${q}`, { headers: authHeaders() });
  const data = await res.json() as { prefs?: DeployPrefs; error?: string };
  if (!res.ok) throw new Error(data.error ?? `deploy prefs ${res.status}`);
  return data.prefs ?? { autoUpdate: true, approveSha: null, approvedAt: null };
}

export async function patchDeployPrefs(updates: { autoUpdate: boolean }): Promise<DeployPrefs> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/deploy-prefs${q}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  const data = await res.json() as { prefs?: DeployPrefs; error?: string };
  if (!res.ok) throw new Error(data.error ?? `deploy prefs patch ${res.status}`);
  return data.prefs ?? { autoUpdate: true, approveSha: null, approvedAt: null };
}

export async function approveDeployUpdate(): Promise<{ ok: boolean; note?: string; prefs: DeployPrefs }> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/deploy-approve${q}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: "{}",
  });
  const data = await res.json() as {
    ok?: boolean; note?: string; prefs?: DeployPrefs; error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? `deploy approve ${res.status}`);
  return {
    ok: !!data.ok,
    note: data.note,
    prefs: data.prefs ?? { autoUpdate: false, approveSha: null, approvedAt: null },
  };
}

export async function postHalt(action: "halt" | "resume", confirm: string): Promise<{
  ok: boolean;
  halted: boolean;
  halt_at: string | null;
  paused?: boolean;
  note?: string;
}> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/halt${q}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ action, confirm }),
  });
  const data = await res.json() as {
    ok?: boolean; halted?: boolean; halt_at?: string | null; paused?: boolean; note?: string; error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? `halt ${res.status}`);
  return {
    ok: !!data.ok,
    halted: !!data.halted,
    halt_at: data.halt_at ?? null,
    paused: data.paused,
    note: data.note,
  };
}

/** Soft engine ON/OFF (PAUSE file) — does not close positions. */
export async function postEngine(action: "on" | "off"): Promise<{
  ok: boolean;
  paused: boolean;
  pause_at: string | null;
  halted?: boolean;
  note?: string;
}> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/engine${q}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const data = await res.json() as {
    ok?: boolean; paused?: boolean; pause_at?: string | null; halted?: boolean; note?: string; error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? `engine ${res.status}`);
  return {
    ok: !!data.ok,
    paused: !!data.paused,
    pause_at: data.pause_at ?? null,
    halted: data.halted,
    note: data.note,
  };
}

/** Soft-dismiss error_log rows (hide from Errors tab / badge; kept in DB). */
export async function dismissErrors(opts: { ids?: number[]; all?: boolean }): Promise<{
  ok: boolean;
  dismissed: number;
}> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/errors/dismiss${q}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(opts.all ? { all: true } : { ids: opts.ids ?? [] }),
  });
  const data = await res.json() as { ok?: boolean; dismissed?: number; error?: string };
  if (!res.ok) throw new Error(data.error ?? `dismiss ${res.status}`);
  return { ok: !!data.ok, dismissed: Number(data.dismissed) || 0 };
}

/** Permanently delete error_log rows (all, or dismissed-only). */
export async function clearErrorLog(opts: { dismissedOnly?: boolean } = {}): Promise<{
  ok: boolean;
  cleared: number;
}> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/errors/clear${q}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ dismissed_only: !!opts.dismissedOnly }),
  });
  const data = await res.json() as { ok?: boolean; cleared?: number; error?: string };
  if (!res.ok) throw new Error(data.error ?? `clear ${res.status}`);
  return { ok: !!data.ok, cleared: Number(data.cleared) || 0 };
}

export type SettingsProfile = {
  schema: number;
  id: string;
  name: string;
  description?: string;
  author?: string;
  tags?: string[];
  updated?: string;
  updates?: Record<string, unknown>;
  source?: "official" | "local" | "community";
  file?: string;
};

export type ProfileShareMeta = {
  repo: string;
  ref: string;
  new_file_base: string;
  edit_index_url?: string;
  /** Public docs at dlmmbot.com/setup/profiles */
  docs_url?: string;
  /** @deprecated alias of docs_url */
  community_readme: string;
  fork_hint?: string;
};

export async function fetchProfiles(): Promise<{
  official: SettingsProfile[];
  local: SettingsProfile[];
  share: ProfileShareMeta;
}> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/profiles${q}`, { headers: authHeaders() });
  const data = await res.json() as {
    official?: SettingsProfile[]; local?: SettingsProfile[]; share?: ProfileShareMeta; error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? `profiles ${res.status}`);
  return {
    official: data.official ?? [],
    local: data.local ?? [],
    share: data.share ?? {
      repo: "CryptoGnome/dlmmbot",
      ref: "main",
      new_file_base: "",
      community_readme: "https://dlmmbot.com/setup/profiles",
      docs_url: "https://dlmmbot.com/setup/profiles",
    },
  };
}

export async function fetchCommunityProfiles(): Promise<{
  profiles: Array<{
    id: string; name: string; author?: string; description?: string;
    tags?: string[]; file?: string; updated?: string;
  }>;
  error: string | null;
  share: ProfileShareMeta;
}> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/profiles/community${q}`, { headers: authHeaders() });
  const data = await res.json() as {
    profiles?: Array<{
      id: string; name: string; author?: string; description?: string;
      tags?: string[]; file?: string; updated?: string;
    }>;
    error?: string | null;
    share?: ProfileShareMeta;
  };
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `community ${res.status}`);
  return {
    profiles: data.profiles ?? [],
    error: data.error ?? null,
    share: data.share ?? {
      repo: "CryptoGnome/dlmmbot",
      ref: "main",
      new_file_base: "",
      community_readme: "https://dlmmbot.com/setup/profiles",
      docs_url: "https://dlmmbot.com/setup/profiles",
    },
  };
}

export async function saveLocalProfileApi(opts: {
  name: string; description?: string; author?: string; id?: string;
}): Promise<SettingsProfile> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/profiles/local${q}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  const data = await res.json() as { ok?: boolean; profile?: SettingsProfile; error?: string };
  if (!res.ok || !data.profile) throw new Error(data.error ?? `save ${res.status}`);
  return data.profile;
}

export async function deleteLocalProfileApi(id: string): Promise<void> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/profiles/local/${encodeURIComponent(id)}${q}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  const data = await res.json() as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `delete ${res.status}`);
}

export async function previewProfileApi(body: {
  source?: string; id?: string; updates?: Record<string, unknown>;
}): Promise<{
  changes: Array<{ path: string; from: unknown; to: unknown }>;
  updates: Record<string, unknown>;
  dropped: string[];
  profile: SettingsProfile | null;
}> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/profiles/preview${q}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json() as {
    changes?: Array<{ path: string; from: unknown; to: unknown }>;
    updates?: Record<string, unknown>;
    dropped?: string[];
    profile?: SettingsProfile | null;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? `preview ${res.status}`);
  return {
    changes: data.changes ?? [],
    updates: data.updates ?? {},
    dropped: data.dropped ?? [],
    profile: data.profile ?? null,
  };
}

export async function applyProfileApi(body: {
  source?: string; id?: string; updates?: Record<string, unknown>;
}): Promise<{ applied: string[]; config: FlatConfig }> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/profiles/apply${q}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json() as {
    applied?: string[]; config?: FlatConfig; error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? `apply ${res.status}`);
  return { applied: data.applied ?? [], config: data.config ?? {} };
}

export async function fetchProfileSnapshot(name?: string): Promise<{
  updates: Record<string, unknown>;
  share_url: string;
  share: ProfileShareMeta;
  slug: string;
}> {
  const t = tokenFromUrl();
  const params = new URLSearchParams();
  if (t) params.set("token", t);
  if (name?.trim()) params.set("name", name.trim());
  const q = params.toString() ? `?${params}` : "";
  const res = await fetch(`/api/profiles/snapshot${q}`, { headers: authHeaders() });
  const data = await res.json() as {
    updates?: Record<string, unknown>;
    share_url?: string;
    share?: ProfileShareMeta;
    slug?: string;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? `snapshot ${res.status}`);
  return {
    updates: data.updates ?? {},
    share_url: data.share_url ?? "",
    share: data.share ?? {
      repo: "CryptoGnome/dlmmbot",
      ref: "main",
      new_file_base: "",
      community_readme: "https://dlmmbot.com/setup/profiles",
      docs_url: "https://dlmmbot.com/setup/profiles",
    },
    slug: data.slug ?? "my-profile",
  };
}

export type LiveStatus = "connecting" | "open" | "closed";

type LiveHandlers = {
  onWatch: (w: LiveWatch) => void;
  onHistory: (h: HistorySnap, range: RangeKey) => void;
  onError: (msg: string) => void;
  onStatus?: (s: LiveStatus) => void;
};

/** One WebSocket for watch + history. Reconnects with backoff. */
export function connectLive(handlers: LiveHandlers): {
  setRange: (range: RangeKey) => void;
  close: () => void;
} {
  let range: RangeKey = "30d";
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const status = (s: LiveStatus) => handlers.onStatus?.(s);

  const url = () => {
    const t = tokenFromUrl();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const q = t ? `?token=${encodeURIComponent(t)}` : "";
    return `${proto}//${location.host}/ws${q}`;
  };

  const connect = () => {
    if (closed) return;
    status("connecting");
    const sock = new WebSocket(url());
    ws = sock;

    sock.onopen = () => {
      attempt = 0;
      status("open");
      sock.send(JSON.stringify({ type: "range", range }));
    };

    sock.onmessage = (ev) => {
      let msg: { type?: string; data?: unknown; range?: string; error?: string };
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === "watch" && msg.data) {
        const data = msg.data as LiveWatch;
        write(WATCH_KEY, data);
        handlers.onWatch(data);
      } else if (msg.type === "history" && msg.data) {
        const r = (msg.range === "7d" || msg.range === "30d" || msg.range === "all"
          ? msg.range : range) as RangeKey;
        const data = msg.data as HistorySnap;
        write(HIST_PREFIX + r, data);
        handlers.onHistory(data, r);
      } else if (msg.type === "error" && msg.error) {
        handlers.onError(msg.error);
      }
    };

    sock.onerror = () => {
      /* onclose handles retry */
    };

    sock.onclose = () => {
      status("closed");
      if (ws === sock) ws = null;
      if (closed) return;
      const delay = Math.min(10_000, 500 * 2 ** attempt);
      attempt += 1;
      timer = setTimeout(connect, delay);
    };
  };

  connect();

  return {
    setRange(next) {
      range = next;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "range", range }));
      }
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
      ws = null;
    },
  };
}
