/** Ephemeral toasts — max few visible; pressure shortens TTL instead of piling up. */

export type ToastTone = "ok" | "danger" | "warn" | "accent" | "muted";

export type ToastInput = {
  title: string;
  detail?: string;
  tone?: ToastTone;
  /** Override base lifetime (ms). */
  ttlMs?: number;
  /** Dedup key — same id replaces existing. */
  id?: string;
  kind?: string;
};

export type ToastItem = {
  id: string;
  title: string;
  detail?: string;
  tone: ToastTone;
  kind?: string;
  createdAt: number;
  expiresAt: number;
  leaving: boolean;
};

const MAX_VISIBLE = 2;
const BASE_TTL = 4_500;
const BUSY_TTL = 2_000;
const FADE_MS = 260;
const BUSY_WINDOW = 4_000;

let seq = 0;
let toasts: ToastItem[] = [];
let busyUntil = 0;
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function emit() {
  for (const fn of listeners) fn();
}

function underPressure(now = Date.now()) {
  const active = toasts.filter((t) => !t.leaving).length;
  return active >= MAX_VISIBLE || now < busyUntil;
}

function clearTimer(id: string) {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
}

function scheduleExpiry(id: string, at: number) {
  clearTimer(id);
  const wait = Math.max(0, at - Date.now());
  timers.set(
    id,
    setTimeout(() => dismissToast(id), wait),
  );
}

function forceLeave(id: string) {
  const t = toasts.find((x) => x.id === id);
  if (!t || t.leaving) return;
  t.leaving = true;
  clearTimer(id);
  timers.set(
    id,
    setTimeout(() => {
      toasts = toasts.filter((x) => x.id !== id);
      timers.delete(id);
      emit();
    }, FADE_MS),
  );
  emit();
}

/** Soft-dismiss (fade). */
export function dismissToast(id: string) {
  forceLeave(id);
}

export function getToasts(): ToastItem[] {
  return toasts;
}

export function subscribeToasts(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function toast(input: ToastInput): string {
  const now = Date.now();
  const busy = underPressure(now);
  if (busy) busyUntil = now + BUSY_WINDOW;

  const ttl = input.ttlMs ?? (busy ? BUSY_TTL : BASE_TTL);
  const id = input.id ?? `t${++seq}`;

  const existing = toasts.find((t) => t.id === id && !t.leaving);
  if (existing) {
    existing.title = input.title;
    existing.detail = input.detail;
    existing.tone = input.tone ?? existing.tone;
    existing.kind = input.kind ?? existing.kind;
    existing.expiresAt = now + ttl;
    scheduleExpiry(id, existing.expiresAt);
    emit();
    return id;
  }

  // Cap visible: drop oldest immediately (fast fade), don't grow a pile.
  const active = toasts.filter((t) => !t.leaving);
  if (active.length >= MAX_VISIBLE) {
    forceLeave(active[0]!.id);
    // Remaining toasts expire sooner under pressure.
    for (const t of toasts) {
      if (t.leaving) continue;
      t.expiresAt = Math.min(t.expiresAt, now + BUSY_TTL);
      scheduleExpiry(t.id, t.expiresAt);
    }
  }

  const item: ToastItem = {
    id,
    title: input.title,
    detail: input.detail,
    tone: input.tone ?? "muted",
    kind: input.kind,
    createdAt: now,
    expiresAt: now + ttl,
    leaving: false,
  };
  toasts = [...toasts.filter((t) => !t.leaving || t.id !== id), item];
  // Keep at most MAX + 1 leaving for animation.
  const living = toasts.filter((t) => !t.leaving);
  const leaving = toasts.filter((t) => t.leaving).slice(-1);
  toasts = [...leaving, ...living].slice(-MAX_VISIBLE - 1);
  scheduleExpiry(id, item.expiresAt);
  emit();
  return id;
}
