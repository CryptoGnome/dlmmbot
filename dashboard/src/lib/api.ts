import type { HistorySnap, LiveWatch, RangeKey } from "./types";
import { tokenFromUrl } from "./utils";

const WATCH_KEY = "meteora_dash_watch";
const HIST_PREFIX = "meteora_dash_hist_";

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
  return read<LiveWatch>(WATCH_KEY)?.data ?? null;
}

export function cachedHistory(range: RangeKey): HistorySnap | null {
  return read<HistorySnap>(HIST_PREFIX + range)?.data ?? null;
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
