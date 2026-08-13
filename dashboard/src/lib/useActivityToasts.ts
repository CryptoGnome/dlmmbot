import { useEffect, useRef } from "react";
import { buildActivityFeed, type FeedItem } from "@/lib/activityFeed";
import { toast } from "@/lib/toast";
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
