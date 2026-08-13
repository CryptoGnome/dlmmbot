import { useEffect, useRef, useState } from "react";
import { cachedHistory, cachedWatch, connectLive, fetchSetupStatus } from "@/lib/api";
import type { HistorySnap, LiveWatch, RangeKey } from "@/lib/types";
import { clockTime, tokenFromUrl } from "@/lib/utils";
import { useActivityToasts } from "@/lib/useActivityToasts";
import { RangeTabs } from "@/components/ui";
import { Shell, parseTab, type TabId } from "@/components/Shell";
import { SetupWizard } from "@/components/SetupWizard";
import { ToastHost } from "@/components/ToastHost";
import { OverviewPage } from "@/pages/Overview";
import { BookPage } from "@/pages/Book";
import { AnalyticsPage } from "@/pages/Analytics";
import { ActivityPage } from "@/pages/Activity";
import { ResearchPage } from "@/pages/Research";
import { SettingsPage } from "@/pages/Settings";

export default function App() {
  const [tab, setTab] = useState<TabId>(() =>
    typeof window !== "undefined" ? parseTab(window.location.hash) : "overview",
  );
  const [range, setRange] = useState<RangeKey>("30d");
  const [watch, setWatch] = useState<LiveWatch | null>(() => cachedWatch());
  const [hist, setHist] = useState<HistorySnap | null>(() => cachedHistory("30d"));
  const [err, setErr] = useState<string | null>(null);
  const [updated, setUpdated] = useState<number>(() => {
    const w = cachedWatch();
    return w?.ts ? w.ts * 1000 : 0;
  });
  const [fromCache, setFromCache] = useState(() => !!(cachedWatch() || cachedHistory("30d")));
  const [live, setLive] = useState<"connecting" | "open" | "closed">("connecting");
  const [wizard, setWizard] = useState<"loading" | "show" | "done">("loading");
  const [setupInitial, setSetupInitial] = useState<Awaited<ReturnType<typeof fetchSetupStatus>> | null>(null);
  const hasWatch = useRef(!!cachedWatch());
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const connRef = useRef<ReturnType<typeof connectLive> | null>(null);

  const goTab = (t: TabId) => {
    setTab(t);
    const next = `#/${t}`;
    if (window.location.hash !== next) window.history.replaceState(null, "", next);
  };

  useEffect(() => {
    const onHash = () => setTab(parseTab(window.location.hash));
    window.addEventListener("hashchange", onHash);
    if (!window.location.hash) window.history.replaceState(null, "", "#/overview");
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!tokenFromUrl()) {
      setWizard("done");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const s = await fetchSetupStatus();
        if (cancelled) return;
        setSetupInitial(s);
        setWizard(s.needsWizard ? "show" : "done");
      } catch {
        if (!cancelled) setWizard("done");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!tokenFromUrl()) {
      setErr("missing token — open with ?token=YOUR_DASH_TOKEN");
      setLive("closed");
      return;
    }
    const conn = connectLive({
      onWatch(w) {
        setWatch(w);
        hasWatch.current = true;
        setErr(null);
        setUpdated(Date.now());
        setFromCache(false);
      },
      onHistory(h, r) {
        if (r !== rangeRef.current) return;
        setHist(h);
        setFromCache(false);
      },
      onError(msg) {
        if (!hasWatch.current) setErr(msg);
      },
      onStatus: setLive,
    });
    connRef.current = conn;
    return () => {
      conn.close();
      connRef.current = null;
    };
  }, []);

  useEffect(() => {
    const cached = cachedHistory(range);
    if (cached) {
      setHist(cached);
      setFromCache(true);
    }
    connRef.current?.setRange(range);
  }, [range]);

  const stale = watch?.heartbeat_age_s != null && watch.heartbeat_age_s > 60;
  const showRange = tab === "overview" || tab === "book" || tab === "analytics";
  useActivityToasts(watch, live, stale);

  return (
    <>
      {wizard === "show" && setupInitial && (
        <SetupWizard
          initial={setupInitial}
          onDone={() => setWizard("done")}
        />
      )}
      <ToastHost />
      <Shell
        tab={tab}
        onTab={goTab}
        watch={watch}
        live={live}
        stale={stale}
        rangeTabs={showRange ? <RangeTabs value={range} onChange={setRange} /> : undefined}
      >
        {err && (
          <div className="border border-danger/60 bg-panel px-3 py-2 text-danger text-[11px]">
            ERR // {err}
          </div>
        )}

        {tab === "overview" && (
          <OverviewPage watch={watch} hist={hist} onOpenActivity={() => goTab("activity")} />
        )}
        {tab === "book" && <BookPage watch={watch} hist={hist} />}
        {tab === "analytics" && <AnalyticsPage watch={watch} hist={hist} />}
        {tab === "activity" && <ActivityPage watch={watch} />}
        {tab === "research" && <ResearchPage />}
        {tab === "settings" && <SettingsPage />}

        <footer className="px-1 pb-2 text-[10px] text-dim">
          Live watch · history on range · updated {updated ? clockTime(updated) : "—"} ET
          {fromCache ? " · showing cache" : ""}
          {tab === "settings" ? " · config writes enabled" : ""}
        </footer>
      </Shell>
    </>
  );
}
