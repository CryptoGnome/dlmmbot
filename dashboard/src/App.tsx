import { useCallback, useEffect, useState } from "react";
import { fetchHistory, fetchWatch } from "@/lib/api";
import type { HistorySnap, LiveWatch, RangeKey } from "@/lib/types";
import { fmtPct, fmtSol, tokenFromUrl } from "@/lib/utils";
import { Badge, Kpi, Panel, RangeTabs } from "@/components/ui";
import { EquityChart, ExitsChart, SkipChart } from "@/components/Charts";

export default function App() {
  const [watch, setWatch] = useState<LiveWatch | null>(null);
  const [hist, setHist] = useState<HistorySnap | null>(null);
  const [range, setRange] = useState<RangeKey>("30d");
  const [err, setErr] = useState<string | null>(null);
  const [updated, setUpdated] = useState<number>(0);

  const loadWatch = useCallback(async () => {
    try {
      const w = await fetchWatch();
      setWatch(w);
      setErr(null);
      setUpdated(Date.now());
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  const loadHist = useCallback(async () => {
    try {
      const h = await fetchHistory(range);
      setHist(h);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [range]);

  useEffect(() => {
    if (!tokenFromUrl()) {
      setErr("missing token — open with ?token=YOUR_DASH_TOKEN");
      return;
    }
    void loadWatch();
    void loadHist();
    const a = setInterval(() => void loadWatch(), 15_000);
    const b = setInterval(() => void loadHist(), 60_000);
    return () => { clearInterval(a); clearInterval(b); };
  }, [loadWatch, loadHist]);

  useEffect(() => { void loadHist(); }, [range, loadHist]);

  const stale = watch?.heartbeat_age_s != null && watch.heartbeat_age_s > 60;
  const pnl24 = watch?.book.last_24h.pnl ?? 0;
  const allPnl = watch?.book.all_time_live.pnl ?? 0;
  const near = watch?.bin_rent_near_miss.since_fix;

  return (
    <div className="scanlines min-h-screen bg-bg text-fg">
      <div className="mx-auto max-w-[1440px] space-y-3 p-3 md:p-4">
        {/* Header */}
        <header className="panel flex flex-wrap items-center justify-between gap-3 px-3 py-2">
          <div className="flex items-center gap-3">
            <span className="text-sm font-bold tracking-[0.2em]">METEORA // LIVE OPS</span>
            <span className={`live-blink text-[10px] tracking-widest ${stale ? "text-danger" : "text-ok"}`}>
              ● {stale ? "STALE" : "LIVE"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted">
            <span>build {watch?.build.head ?? "—"}</span>
            <span className="text-dim">|</span>
            <span>{watch?.heartbeat?.mode ?? "—"}</span>
            <span className="text-dim">|</span>
            <span>hb {watch?.heartbeat_age_s ?? "—"}s</span>
            <span className="text-dim">|</span>
            <span>{watch?.host ?? "—"}</span>
            <RangeTabs value={range} onChange={setRange} />
          </div>
        </header>

        {err && (
          <div className="border border-danger bg-panel px-3 py-2 text-danger text-[11px]">
            ERR // {err}
          </div>
        )}

        {/* KPI strip */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          <Kpi label="Open" value={String(watch?.open.length ?? 0)} sub={`max ${watch?.config.max_positions ?? "—"}`} />
          <Kpi label="PnL 24h" value={fmtSol(pnl24)} tone={pnl24 >= 0 ? "ok" : "danger"} sub={`${watch?.book.last_24h.n ?? 0} closes`} />
          <Kpi label="All-time" value={fmtSol(allPnl)} tone={allPnl >= 0 ? "ok" : "danger"} sub={`${watch?.book.all_time_live.n ?? 0} closes`} />
          <Kpi
            label="Kelly"
            value={fmtPct(watch?.kelly.appliedFraction)}
            tone="accent"
            sub={`${watch?.kelly.regime ?? "—"} · n=${watch?.kelly.samples ?? 0}`}
          />
          <Kpi
            label="Cluster"
            value={watch?.cluster.tripped ? `ON ${watch.cluster.remainingMin}m` : "OFF"}
            tone={watch?.cluster.tripped ? "warn" : "ok"}
            sub={watch?.heartbeat?.entriesFrozen ? "ENTRIES FROZEN" : "entries open"}
          />
        </div>

        {/* Charts — centerpiece */}
        <div className="grid gap-2 lg:grid-cols-2">
          <Panel title="Equity // cum realized + fees" className="min-h-[280px] lg:min-h-[360px]">
            <div className="h-[240px] lg:h-[300px]">
              <EquityChart data={hist?.equity ?? []} />
            </div>
          </Panel>
          <Panel title="Exits // daily PnL by reason" className="min-h-[280px] lg:min-h-[360px]">
            <div className="h-[240px] lg:h-[300px]">
              <ExitsChart data={hist?.exits ?? []} reasons={hist?.exit_reasons ?? []} />
            </div>
          </Panel>
        </div>

        {/* Mid tables */}
        <div className="grid gap-2 lg:grid-cols-2">
          <Panel title="Open positions">
            {!watch?.open.length ? (
              <div className="py-6 text-center text-[11px] tracking-wider text-dim">NO POSITIONS // book flat</div>
            ) : (
              <table className="w-full text-left text-[11px]">
                <thead className="text-dim">
                  <tr>
                    <th className="pb-1 font-normal">ID</th>
                    <th className="pb-1 font-normal">SYM</th>
                    <th className="pb-1 font-normal">ENTRY</th>
                    <th className="pb-1 font-normal">OPENED</th>
                  </tr>
                </thead>
                <tbody>
                  {watch.open.map((p) => (
                    <tr key={p.id} className="border-t border-grid">
                      <td className="py-1.5 text-accent">#{p.id}</td>
                      <td className="py-1.5">{p.symbol}</td>
                      <td className="py-1.5 tabular-nums">{p.entry_sol.toFixed(3)}</td>
                      <td className="py-1.5 text-muted">{p.opened}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title="Exit ladder // recent closes">
            {!hist?.ladder.length ? (
              <div className="py-6 text-center text-[11px] tracking-wider text-dim">NO CLOSES // in range</div>
            ) : (
              <div className="max-h-[220px] overflow-auto">
                <table className="w-full text-left text-[11px]">
                  <thead className="sticky top-0 bg-panel text-dim">
                    <tr>
                      <th className="pb-1 font-normal">AT</th>
                      <th className="pb-1 font-normal">SYM</th>
                      <th className="pb-1 font-normal">WHY</th>
                      <th className="pb-1 font-normal text-right">PNL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hist.ladder.map((r) => (
                      <tr key={r.id} className="border-t border-grid">
                        <td className="py-1 text-muted whitespace-nowrap">{r.at?.slice(5, 16)}</td>
                        <td className="py-1">{r.symbol}</td>
                        <td className="py-1 text-dim">{r.exit_reason}</td>
                        <td className={`py-1 text-right tabular-nums ${r.pnl >= 0 ? "text-ok" : "text-danger"}`}>
                          {fmtSol(r.pnl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        {/* Bottom */}
        <div className="grid gap-2 lg:grid-cols-2">
          <Panel
            title="Skip funnel // top gates"
            right={<Badge tone={watch?.open_failed_since_fix.n ? "danger" : "ok"}>
              open_fail {watch?.open_failed_since_fix.n ?? 0}
            </Badge>}
          >
            <div className="mb-3 h-[160px]">
              <SkipChart
                data={hist?.skip_series ?? []}
                gates={(hist?.skip_top ?? []).map((s) => s.g)}
              />
            </div>
            <ul className="space-y-1 text-[11px]">
              {(hist?.skip_top ?? []).slice(0, 6).map((s) => (
                <li key={s.g} className="flex justify-between border-t border-grid pt-1">
                  <span className="text-muted">{s.g}</span>
                  <span className="tabular-nums text-fg">{s.n.toLocaleString()}</span>
                </li>
              ))}
            </ul>
            {!!watch?.book.last_24h.by_reason.length && (
              <div className="mt-3 border-t border-grid pt-2">
                <div className="mb-1 text-[10px] tracking-wider text-dim uppercase">24h exits</div>
                {watch.book.last_24h.by_reason.map((r) => (
                  <div key={r.exit_reason} className="flex justify-between text-[11px]">
                    <span className="text-muted">{r.exit_reason} ×{r.n}</span>
                    <span className={r.pnl >= 0 ? "text-ok" : "text-danger"}>{fmtSol(r.pnl)}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title={`bin_rent near-miss // score ≥ ${near?.score_min ?? 70}`}>
            <div className="mb-2 flex gap-2 text-[11px]">
              <Badge tone={near && near.n > 0 ? "warn" : "ok"}>{near?.n ?? 0} since fix</Badge>
              {near?.best && (
                <span className="text-muted">
                  best {near.best.score} @ {near.best.mint} · rent {near.best.estRentSol}/{near.best.rentBudget}
                </span>
              )}
            </div>
            {!near?.recent.length ? (
              <div className="py-4 text-center text-[11px] text-dim">NO NEAR-MISSES</div>
            ) : (
              <div className="max-h-[200px] overflow-auto">
                <table className="w-full text-left text-[11px]">
                  <thead className="text-dim">
                    <tr>
                      <th className="pb-1 font-normal">AT</th>
                      <th className="pb-1 font-normal">MINT</th>
                      <th className="pb-1 font-normal">SCORE</th>
                      <th className="pb-1 font-normal">RENT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {near.recent.map((r, i) => (
                      <tr key={`${r.at}-${i}`} className="border-t border-grid">
                        <td className="py-1 text-muted whitespace-nowrap">{r.at?.slice(5)}</td>
                        <td className="py-1 text-accent">{r.mint}</td>
                        <td className="py-1 tabular-nums text-warn">{r.score}</td>
                        <td className="py-1 tabular-nums text-dim">
                          {r.estRentSol ?? "—"}/{r.rentBudget ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-3 space-y-1 border-t border-grid pt-2 text-[11px]">
              <div className="flex justify-between">
                <span className="text-dim">mark-gap integrity</span>
                <Badge tone={watch?.integrity.mark_gaps.pass ? "ok" : "warn"}>
                  {watch?.integrity.mark_gaps.fail_count ?? "—"} fails / {watch?.integrity.mark_gaps.positions_checked ?? "—"}
                </Badge>
              </div>
              {(watch?.follow_since_fix ?? []).map((f) => (
                <div key={f.state} className="flex justify-between text-muted">
                  <span>follow {f.state}</span>
                  <span>×{f.n} · {fmtSol(f.pnl)}</span>
                </div>
              ))}
              {(watch?.p3_missed_since_fix ?? []).slice(0, 3).map((p) => (
                <div key={p.id} className="flex justify-between text-muted">
                  <span>P3 miss #{p.id} {p.symbol}</span>
                  <span>{fmtSol(p.pnl)} · {p.hold_min}m</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <footer className="px-1 pb-2 text-[10px] text-dim">
          poll watch 15s · history 60s · last ui update {updated ? new Date(updated).toLocaleTimeString() : "—"} · read-only
        </footer>
      </div>
    </div>
  );
}
