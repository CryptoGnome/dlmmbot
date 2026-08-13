import type { HistorySnap, LiveWatch, RangeKey } from "./types";
import { tokenFromUrl } from "./utils";

function authHeaders(): HeadersInit {
  const t = tokenFromUrl();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export async function fetchWatch(): Promise<LiveWatch> {
  const t = tokenFromUrl();
  const q = t ? `?token=${encodeURIComponent(t)}` : "";
  const res = await fetch(`/api/watch${q}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`watch ${res.status}`);
  return res.json() as Promise<LiveWatch>;
}

export async function fetchHistory(range: RangeKey): Promise<HistorySnap> {
  const t = tokenFromUrl();
  const params = new URLSearchParams({ range });
  if (t) params.set("token", t);
  const res = await fetch(`/api/history?${params}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`history ${res.status}`);
  return res.json() as Promise<HistorySnap>;
}
