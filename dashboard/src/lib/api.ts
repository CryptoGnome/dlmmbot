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
    // quota / private mode — ignore
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

export function cacheAgeMs(kind: "watch" | "history", range?: RangeKey): number | null {
  const env = kind === "watch"
    ? read<LiveWatch>(WATCH_KEY)
    : read<HistorySnap>(HIST_PREFIX + (range ?? "30d"));
  return env ? Date.now() - env.at : null;
}

/** Network fetch; updates localStorage on success. */
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
