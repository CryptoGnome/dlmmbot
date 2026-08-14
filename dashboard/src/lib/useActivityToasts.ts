import { useEffect, useRef } from "react";
import { buildActivityFeed, type FeedItem } from "@/lib/activityFeed";
import { toast } from "@/lib/toast";
import { errorPresentation } from "@/lib/errorPresent";
import type { LiveWatch } from "@/lib/types";
import type { LiveStatus } from "@/lib/api";
import { fmtSol } from "@/lib/utils";

const TOAST_KINDS = new Set(["entry", "exit", "fail", "cluster", "event"]);

function fingerprint(it: FeedItem) {
  return `${it.at}|${it.kind}|${it.symbol ?? ""}|${it.label}|${it.sol ?? ""}`;
}

function titleFor(it: FeedItem) {
  const sym = it.symbol && it.symbol !== "?" ? it.symbol : null;
  return sym ? `${sym} · ${it.label}` : it.label;
}

function detailFor(it: FeedItem) {
  const bits: string[] = [];
  if (it.detail) bits.push(it.detail);
  if (it.sol != null) {
    const sign = it.sol > 0 ? "+" : "";
    bits.push(`${sign}${fmtSol(it.sol)}`);
  }
  return bits.join(" · ") || undefined;
}

/** Watch live feed + system edges; skip the historical dump on first paint. */
export function useActivityToasts(
  watch: LiveWatch | null,
  live: LiveStatus,
  stale: boolean,
) {
  const seen = useRef<Set<string> | null>(null);
  const clusterWas = useRef(false);
  const staleWas = useRef(false);
  const liveWas = useRef<LiveStatus>("connecting");
  const primed = useRef(false);

  useEffect(() => {
    if (!watch) return;
    const feed = buildActivityFeed(watch, 40);

    if (!primed.current) {
      seen.current = new Set(feed.map(fingerprint));
      primed.current = true;
      clusterWas.current = !!watch.cluster?.tripped;
      staleWas.current = stale;
      liveWas.current = live;
      return;
    }

    const known = seen.current ?? new Set<string>();
    // Newest first in feed — toast oldest-new first so order feels chronological.
    const fresh = feed.filter((it) => TOAST_KINDS.has(it.kind) && !known.has(fingerprint(it)));
    fresh.reverse();
    for (const it of fresh) {
      const fp = fingerprint(it);
      known.add(fp);
      toast({
        id: fp,
        title: titleFor(it),
        detail: detailFor(it),
        tone: it.tone,
        kind: it.kind,
      });
    }
    // Bound memory
    if (known.size > 200) {
      const keep = feed.slice(0, 80).map(fingerprint);
      seen.current = new Set(keep);
    } else {
      seen.current = known;
    }
  }, [watch]);

  useEffect(() => {
    if (!primed.current) return;
    const tripped = !!watch?.cluster?.tripped;
    if (tripped && !clusterWas.current) {
      toast({
        id: "cluster-brake",
        title: "Cluster brake ON",
        detail: watch?.cluster?.remainingMin
          ? `${watch.cluster.remainingMin}m remaining`
          : "Entries paused",
        tone: "danger",
        kind: "cluster",
        ttlMs: 6_000,
      });
    }
    clusterWas.current = tripped;
  }, [watch?.cluster?.tripped, watch?.cluster?.remainingMin]);

  useEffect(() => {
    if (!primed.current) return;
    if (stale && !staleWas.current) {
      toast({
        id: "hb-stale",
        title: "Bot heartbeat stale",
        detail: "Process may be down or restarting",
        tone: "danger",
        kind: "fail",
        ttlMs: 6_000,
      });
    } else if (!stale && staleWas.current) {
      toast({
        id: "hb-ok",
        title: "Bot heartbeat restored",
        tone: "ok",
        kind: "event",
        ttlMs: 3_000,
      });
    }
    staleWas.current = stale;
  }, [stale]);

  useEffect(() => {
    if (!primed.current) return;
    const prev = liveWas.current;
    if (live === "closed" && prev === "open") {
      toast({
        id: "ws-down",
        title: "Live link dropped",
        detail: "Reconnecting…",
        tone: "warn",
        kind: "fail",
        ttlMs: 4_000,
      });
    } else if (live === "open" && prev === "closed") {
      toast({
        id: "ws-up",
        title: "Live link restored",
        tone: "ok",
        kind: "event",
        ttlMs: 2_800,
      });
    }
    liveWas.current = live;
  }, [live]);
}

/** Notify when GitHub is ahead, disk deploys, or the farmer process restarts on a new build. */
export function useBuildToasts(watch: LiveWatch | null) {
  const primed = useRef(false);
  const syncWas = useRef<string | null>(null);
  const originWas = useRef<string | null>(null);
  const headWas = useRef<string | null>(null);
  const runningWas = useRef<string | null>(null);

  useEffect(() => {
    const b = watch?.build;
    if (!b) return;

    const sync = b.sync ?? "unknown";
    const origin = b.origin ?? null;
    const head = b.head ?? b.describe ?? null;
    const running = b.running ?? null;

    if (!primed.current) {
      primed.current = true;
      syncWas.current = sync;
      originWas.current = origin;
      headWas.current = head;
      runningWas.current = running;
      return;
    }

    const becameBehind = sync === "behind" && syncWas.current !== "behind";
    const moreBehind = sync === "behind" && origin && origin !== originWas.current;
    if (becameBehind || moreBehind) {
      const n = b.behind_count && b.behind_count > 0 ? b.behind_count : null;
      const tip = b.pending?.[0]?.subject;
      const manual = b.auto_update === false;
      toast({
        id: `update-avail-${origin ?? "x"}`,
        title: n && n > 1 ? `${n} updates available` : "Update available",
        detail: tip
          ? `${origin ?? "origin"} · ${tip}${manual ? " — approve on Changes" : ""}`
          : manual
            ? `GitHub ${origin ?? "ahead"} — open Changes and Approve`
            : `GitHub ${origin ?? "ahead"} — see Changes`,
        tone: "warn",
        kind: "event",
        ttlMs: 7_000,
      });
    }

    if (head && headWas.current && head !== headWas.current) {
      toast({
        id: `deploy-${head}`,
        title: "Deploy landed on host",
        detail: b.message ? `${head} · ${b.message}` : head,
        tone: "ok",
        kind: "event",
        ttlMs: 6_000,
      });
    }

    if (running && runningWas.current && running !== runningWas.current) {
      toast({
        id: `bot-build-${running}`,
        title: "Bot updated",
        detail: `Now running ${running}`,
        tone: "ok",
        kind: "event",
        ttlMs: 6_000,
      });
    }

    syncWas.current = sync;
    originWas.current = origin;
    headWas.current = head;
    runningWas.current = running;
  }, [watch?.build]);
}

/** Toast when a new error_log row appears on the live watch stream. */
export function useErrorToasts(watch: LiveWatch | null) {
  const lastId = useRef<number | null>(null);
  const primed = useRef(false);

  useEffect(() => {
    const errs = watch?.recent_errors ?? [];
    const top = errs[0]?.id ?? null;
    if (!primed.current) {
      primed.current = true;
      lastId.current = top;
      return;
    }
    if (top == null || top === lastId.current) return;
    const prev = lastId.current ?? 0;
    const fresh = errs.filter((e) => {
      if (e.id <= prev) return false;
      const p = errorPresentation(e);
      return p.kind === "incident" || e.level === "fatal";
    }).slice(0, 3);
    fresh.reverse();
    for (const e of fresh) {
      const p = errorPresentation(e);
      toast({
        id: `err-${e.id}`,
        title: e.symbol ? `${p.label} · ${e.symbol}` : p.label,
        detail: (p.hint ?? e.message).slice(0, 120),
        tone: "danger",
        kind: "fail",
        ttlMs: 8_000,
      });
    }
    lastId.current = top;
  }, [watch?.error_stats?.last_id, watch?.recent_errors]);
}
