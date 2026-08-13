import type { ActivityEvent, LiveWatch } from "@/lib/types";
import { exitLabel, fmtRet, gateLabel } from "@/lib/utils";

export type FeedKind = ActivityEvent["kind"];

export type FeedItem = {
  at: string;
  kind: FeedKind;
  label: string;
  detail?: string;
  /** Signed wallet SOL flow (+in / −out) or exit PnL — colored in the feed. */
  sol?: number | null;
  tone: "ok" | "danger" | "warn" | "accent" | "muted";
  mint?: string | null;
  symbol?: string | null;
  name?: string | null;
  icon_url?: string | null;
  gate?: string | null;
};

function toneFor(kind: FeedKind, pnl?: number | null): FeedItem["tone"] {
  // Entry = SOL leaving the wallet → red. Exit color follows PnL.
  if (kind === "entry") return "danger";
  if (kind === "fail") return "danger";
  if (kind === "exit") return pnl != null && pnl < 0 ? "danger" : "ok";
  if (kind === "skip" || kind === "cluster") return "warn";
  return "accent";
}

/** Wallet flow / PnL to highlight. Entry size is outflow (−). */
function solFor(e: ActivityEvent): number | null {
  if (e.kind === "entry" && e.size != null) return -Math.abs(e.size);
  if (e.kind === "exit" && e.pnl != null) return e.pnl;
  if (e.kind === "event") {
    const v = e.pnl ?? e.size;
    return v != null ? v : null;
  }
  return null;
}

function labelFor(e: ActivityEvent): string {
  switch (e.kind) {
    case "entry":
      return "entered";
    case "exit":
      return `closed · ${exitLabel(e.gate)}`;
    case "fail":
      return "open failed";
    case "skip":
      return "skipped";
    case "event":
      return gateLabel(e.gate ?? "event");
    case "cluster":
      return `cluster · ${exitLabel(e.gate)}`;
    default:
      return e.symbol && e.symbol !== "?" ? e.symbol : "?";
  }
}

function detailFor(e: ActivityEvent): string | undefined {
  const bits: Array<string | null | undefined> = [];
  if (e.kind === "skip" || e.kind === "fail") bits.push(e.gate ? gateLabel(e.gate) : null);
  if (e.score != null) bits.push(`score ${e.score.toFixed(1)}`);
  // Size on skip/fail is context only (no wallet move yet).
  if (e.size != null && (e.kind === "skip" || e.kind === "fail")) {
    bits.push(`${e.size.toFixed(2)} SOL`);
  }
  if (e.sleeve && e.sleeve !== "meme") bits.push(e.sleeve);
  if (e.detail) bits.push(e.detail);
  if (e.kind === "exit" && e.pnl != null && e.size && e.size > 0) {
    bits.push(fmtRet(e.pnl / e.size));
  }
  const s = bits.filter(Boolean).join(" · ");
  return s || undefined;
}

/** Prefer server `recent_activity`; fall back to older watch fields. */
export function buildActivityFeed(watch: LiveWatch | null, limit = 80): FeedItem[] {
  if (!watch) return [];

  if (watch.recent_activity?.length) {
    const meta = watch.token_meta ?? {};
    return watch.recent_activity.slice(0, limit).map((e) => {
      const m = e.mint ? meta[e.mint] : null;
      return {
        at: e.at,
        kind: e.kind,
        label: labelFor(e),
        detail: detailFor(e),
        sol: solFor(e),
        tone: toneFor(e.kind, e.pnl),
        mint: e.mint,
        symbol: e.symbol ?? m?.symbol,
        name: e.name ?? m?.name,
        icon_url: e.icon_url ?? m?.icon_url,
        gate: e.gate,
      };
    });
  }

  // Legacy fallback before dashboard-server redeploy
  const items: FeedItem[] = [];
  for (const r of watch.recent_passes ?? []) {
    items.push({
      at: r.at,
      kind: "entry",
      label: `entered ${r.symbol}`,
      detail: [
        r.score != null ? `score ${r.score.toFixed(1)}` : null,
        r.sleeve && r.sleeve !== "meme" ? r.sleeve : null,
      ].filter(Boolean).join(" · ") || undefined,
      sol: r.size != null ? -Math.abs(r.size) : null,
      tone: "danger",
      mint: r.mint,
      symbol: r.symbol,
    });
  }
  for (const r of watch.open_failed_since_fix?.recent ?? []) {
    items.push({
      at: r.at,
      kind: "fail",
      label: `open failed${r.code ? ` (${r.code})` : ""}`,
      detail: r.error?.slice(0, 120) ?? r.mint.slice(0, 8),
      tone: "danger",
      mint: r.mint,
    });
  }
  for (const r of watch.cluster?.recent ?? []) {
    if (!r.exit_ts) continue;
    items.push({
      at: new Date(r.exit_ts * 1000).toISOString(),
      kind: "cluster",
      label: `cluster ${r.symbol ?? "?"} ${exitLabel(r.exit_reason)}`,
      tone: "warn",
      symbol: r.symbol,
    });
  }
  for (const r of watch.p3_missed_since_fix ?? []) {
    items.push({
      at: r.at,
      kind: "exit",
      label: `missed ${r.symbol}`,
      detail: `${r.hold_min}m`,
      sol: r.pnl,
      tone: "warn",
      mint: r.mint,
      symbol: r.symbol,
    });
  }
  for (const r of watch.bin_rent_near_miss?.last_24h?.recent ?? []) {
    items.push({
      at: r.at,
      kind: "skip",
      label: `skipped ${r.symbol ?? "?"}`,
      detail: `${gateLabel(r.gate)} · score ${r.score}`,
      tone: "warn",
      mint: r.mint,
      symbol: r.symbol,
    });
  }
  return items
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}
