import { useCallback, useEffect, useRef, useState } from "react";
import { cachedHistory, cachedWatch, fetchHistory, fetchWatch } from "@/lib/api";
import type { HistorySnap, LiveWatch, RangeKey } from "@/lib/types";
import { exitLabel, fmtPct, fmtRet, fmtSol, fmtUsd, gateLabel, shortTime, tokenFromUrl } from "@/lib/utils";
import { Badge, Kpi, Panel, RangeTabs } from "@/components/ui";
import { EquityChart, ExitsChart } from "@/components/Charts";
import { TokenSymbol } from "@/components/TokenSymbol";
import { RangeBar, StatusBadge, type RangeStatus } from "@/components/RangeBar";

export default function App() {
  const [range, setRange] = useState<RangeKey>("30d");
  const [watch, setWatch] = useState<LiveWatch | null>(() => cachedWatch());
  const [hist, setHist] = useState<HistorySnap | null>(() => cachedHistory("30d"));
  const [err, setErr] = useState<string | null>(null);
  const [updated, setUpdated] = useState<number>(() => {
    const w = cachedWatch();
    return w?.ts ? w.ts * 1000 : 0;
  });
  const [fromCache, setFromCache] = useState(() => !!(cachedWatch() || cachedHistory("30d")));
  const hasWatch = useRef(!!cachedWatch());
  const hasHist = useRef(!!cachedHistory("30d"));

  const loadWatch = useCallback(async () => {
    try {
      const w = await fetchWatch();
      setWatch(w);
      hasWatch.current = true;
      setErr(null);
      setUpdated(Date.now());
      setFromCache(false);
    } catch (e) {
      if (!hasWatch.current) setErr((e as Error).message);
    }
  }, []);

  const loadHist = useCallback(async (r: RangeKey) => {
    const cached = cachedHistory(r);
    if (cached) {
      setHist(cached);
      hasHist.current = true;
    }
    try {
      const h = await fetchHistory(r);
      setHist(h);
      hasHist.current = true;
      setFromCache(false);
    } catch (e) {
      if (!hasHist.current) setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!tokenFromUrl()) {
      setErr("missing token — open with ?token=YOUR_DASH_TOKEN");
      return;
    }
    void loadWatch();
    void loadHist(range);
    const a = setInterval(() => void loadWatch(), 15_000);
    const b = setInterval(() => void loadHist(range), 60_000);
    return () => { clearInterval(a); clearInterval(b); };
  }, [loadWatch, loadHist, range]);

  // Instantly paint cached history when range tabs change
  useEffect(() => {
    const cached = cachedHistory(range);
    if (cached) {
      setHist(cached);
      setFromCache(true);
    }
  }, [range]);

  const stale = watch?.heartbeat_age_s != null && watch.heartbeat_age_s > 60;
  const pnl24 = watch?.book.last_24h.pnl ?? 0;
  const pct24 = watch?.book.last_24h.pct ?? null;
  const allPnl = watch?.book.all_time_live.pnl ?? 0;
  const allPct = watch?.book.all_time_live.pct ?? null;
  const near = watch?.bin_rent_near_miss.since_fix;
  const lastEq = hist?.equity?.[hist.equity.length - 1];

  return (
    <div className="min-h-screen bg-bg text-fg">
      <div className="w-full space-y-3 px-4 py-3 md:px-6 md:py-4">
        <header className="panel flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold tracking-[0.18em] text-fg">METEORA // LIVE OPS</span>
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
          <div className="border border-danger/60 bg-panel px-3 py-2 text-danger text-[11px]">
            ERR // {err}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <Kpi
            label="Total balance"
            value={watch?.balance?.total_sol != null ? `${watch.balance.total_sol.toFixed(2)} SOL` : "—"}
            tone="accent"
            sub={
              watch?.balance?.total_usd != null
                ? `≈ ${fmtUsd(watch.balance.total_usd)} · wallet ${(watch.balance.wallet_sol ?? 0).toFixed(2)} + open ${(watch.balance.deployed_sol ?? 0).toFixed(2)}`
                : watch?.balance?.wallet_sol != null
                  ? `wallet ${watch.balance.wallet_sol.toFixed(2)} + open ${(watch.balance.deployed_sol ?? 0).toFixed(2)}`
                  : "waiting for heartbeat wallet"
            }
          />
          <Kpi label="Open positions" value={String(watch?.open.length ?? 0)} sub={`max ${watch?.config.max_positions ?? "—"}`} />
          <Kpi
            label="Last 24h"
            value={fmtSol(pnl24)}
            pct={pct24}
            tone={pnl24 >= 0 ? "ok" : "danger"}
            sub={`${watch?.book.last_24h.n ?? 0} closes · return on capital`}
          />
          <Kpi
            label="All-time profit"
            value={fmtSol(allPnl)}
            pct={allPct}
            tone={allPnl >= 0 ? "ok" : "danger"}
            sub={lastEq ? `≈ ${fmtUsd(lastEq.cum_usd)}` : `${watch?.book.all_time_live.n ?? 0} closes`}
          />
          <Kpi
            label="Kelly size"
            value={fmtPct(watch?.kelly.appliedFraction)}
            tone="accent"
            sub={`${watch?.kelly.regime ?? "—"} · ${watch?.kelly.samples ?? 0} samples`}
          />
          <Kpi
            label="Cluster brake"
            value={watch?.cluster.tripped ? `ON ${watch.cluster.remainingMin}m` : "OFF"}
            tone={watch?.cluster.tripped ? "warn" : "ok"}
            sub={watch?.heartbeat?.entriesFrozen ? "entries frozen" : "entries allowed"}
          />
        </div>

        <div className="grid gap-3 xl:grid-cols-2">
          <Panel title="Profit over time (SOL + USD)" className="min-h-[320px] xl:min-h-[420px]">
            <div className="h-[280px] xl:h-[360px]">
              <EquityChart data={hist?.equity ?? []} />
            </div>
          </Panel>
          <Panel title="Daily profit from closes" className="min-h-[320px] xl:min-h-[420px]">
            <div className="flex h-[280px] flex-col xl:h-[360px]">
              <div className="mb-2 min-h-0 flex-1">
                <ExitsChart data={hist?.exits ?? []} />
              </div>
              {(hist?.exit_by_reason?.length ?? 0) > 0 && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-grid pt-2 text-[11px] sm:grid-cols-3">
                  {hist!.exit_by_reason.map((r) => (
                    <div key={r.reason} className="flex justify-between gap-2">
                      <span className="text-muted truncate">{exitLabel(r.reason)} ×{r.n}</span>
                      <span className={`tabular-nums shrink-0 ${r.pnl >= 0 ? "text-ok" : "text-danger"}`}>
                        {fmtSol(r.pnl, 3)}
                        {r.pct != null && <span className="ml-1 opacity-80">{fmtRet(r.pct)}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Panel>
        </div>

        <div className="grid gap-3 xl:grid-cols-2">
          <Panel title="Open positions">
            {!watch?.open.length ? (
              <div className="py-8 text-center text-[12px] tracking-wider text-dim">No open positions</div>
            ) : (
              <div className="space-y-3">
                {watch.open.map((p) => {
                  const m = p.mark;
                  const pnl = m?.pnl_sol;
                  const fees = (m?.unclaimed_fees_sol ?? 0) + (p.fees_claimed_sol ?? 0);
                  const status = (p.range?.status ?? m?.status ?? "unknown") as RangeStatus;
                  const underwater = pnl != null && pnl < 0;
                  return (
                    <div key={p.id} className="border border-grid bg-bg/40 px-3 py-2.5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-accent text-[11px]">#{p.id}</span>
                            <TokenSymbol symbol={p.symbol} mint={p.mint} />
                            <StatusBadge status={status} />
                            {underwater && (
                              <span className="text-[10px] uppercase tracking-wider text-danger">underwater</span>
                            )}
                            {!underwater && pnl != null && pnl > 0 && (
                              <span className="text-[10px] uppercase tracking-wider text-ok">in profit</span>
                            )}
                          </div>
                          <div className="text-[11px] text-muted">
                            size {p.entry_sol.toFixed(3)} SOL · opened {shortTime(p.opened)}
                            {m?.value_sol != null && <> · mark {m.value_sol.toFixed(3)} SOL</>}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-4 text-right text-[12px]">
                          <div>
                            <div className="text-[10px] text-dim uppercase tracking-wider">PnL</div>
                            <div className={`tabular-nums font-semibold ${pnl == null ? "text-dim" : pnl >= 0 ? "text-ok" : "text-danger"}`}>
                              {pnl == null ? "—" : fmtSol(pnl, 3)}
                            </div>
                            {m?.pct != null && (
                              <div className={`text-[10px] tabular-nums ${m.pct >= 0 ? "text-ok" : "text-danger"}`}>
                                {fmtRet(m.pct)}
                              </div>
                            )}
                          </div>
                          <div>
                            <div className="text-[10px] text-dim uppercase tracking-wider">Fees</div>
                            <div className="tabular-nums text-fg">{fmtSol(fees, 4)}</div>
                            <div className="text-[10px] text-dim">
                              u {(m?.unclaimed_fees_sol ?? 0).toFixed(4)}
                            </div>
                          </div>
                        </div>
                      </div>
                      {p.range?.min_bin != null && p.range.max_bin != null && (
                        <div className="mt-2.5 border-t border-grid pt-2">
                          <RangeBar
                            minBin={p.range.min_bin}
                            maxBin={p.range.max_bin}
                            activeBin={p.range.active_bin}
                            status={status}
                            minPrice={p.range.min_price}
                            maxPrice={p.range.max_price}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel title="Recent closes">
            {!hist?.ladder.length ? (
              <div className="py-8 text-center text-[12px] tracking-wider text-dim">No closes in this range</div>
            ) : (
              <div className="max-h-[280px] overflow-auto">
                <table className="w-full text-left text-[12px]">
                  <thead className="sticky top-0 bg-panel text-dim">
                    <tr>
                      <th className="pb-1 font-normal">When</th>
                      <th className="pb-1 font-normal">Symbol</th>
                      <th className="pb-1 font-normal">Reason</th>
                      <th className="pb-1 font-normal text-right">PnL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hist.ladder.map((r) => (
                      <tr key={r.id} className="border-t border-grid">
                        <td className="py-1.5 text-muted whitespace-nowrap">{shortTime(r.at)}</td>
                        <td className="py-1.5"><TokenSymbol symbol={r.symbol} mint={r.mint} /></td>
                        <td className="py-1.5 text-muted">{exitLabel(r.exit_reason)}</td>
                        <td className={`py-1.5 text-right tabular-nums ${r.pnl >= 0 ? "text-ok" : "text-danger"}`}>
                          <div>{fmtSol(r.pnl, 3)}</div>
                          {r.pct != null && <div className="text-[10px] opacity-80">{fmtRet(r.pct)}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        <div className="grid gap-3 xl:grid-cols-2">
          <Panel
            title="Why candidates were skipped"
            right={<Badge tone={watch?.open_failed_since_fix.n ? "danger" : "ok"}>
              open fails {watch?.open_failed_since_fix.n ?? 0}
            </Badge>}
          >
            <ul className="space-y-1.5 text-[12px]">
              {(hist?.skip_top ?? []).slice(0, 8).map((s) => (
                <li key={s.g} className="flex justify-between gap-3 border-t border-grid pt-1.5 first:border-0 first:pt-0">
                  <span className="text-muted">{gateLabel(s.g)}</span>
                  <span className="tabular-nums text-fg shrink-0">{s.n.toLocaleString()}</span>
                </li>
              ))}
              {!hist?.skip_top?.length && (
                <li className="py-4 text-center text-dim">No skips in this range</li>
              )}
            </ul>
            {!!watch?.book.last_24h.by_reason.length && (
              <div className="mt-3 border-t border-grid pt-2">
                <div className="mb-1 text-[10px] tracking-wider text-dim uppercase">Last 24h by exit type</div>
                {watch.book.last_24h.by_reason.map((r) => (
                  <div key={r.exit_reason} className="flex justify-between text-[12px]">
                    <span className="text-muted">{exitLabel(r.exit_reason)} ×{r.n}</span>
                    <span className={r.pnl >= 0 ? "text-ok" : "text-danger"}>
                      {fmtSol(r.pnl, 3)}
                      {r.pct != null && <span className="ml-1 opacity-80">{fmtRet(r.pct)}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title={`High-score skips (rent budget, score ≥ ${near?.score_min ?? 70})`}>
            <div className="mb-2 flex flex-wrap gap-2 text-[12px]">
              <Badge tone={near && near.n > 0 ? "warn" : "ok"}>{near?.n ?? 0} since fix</Badge>
              {near?.best && (
                <span className="text-muted inline-flex flex-wrap items-center gap-1">
                  best: <TokenSymbol symbol={near.best.symbol} mint={near.best.mint} />
                  {" "}score {near.best.score} · rent {near.best.estRentSol}/{near.best.rentBudget} SOL
                </span>
              )}
            </div>
            {!near?.recent.length ? (
              <div className="py-4 text-center text-[12px] text-dim">None</div>
            ) : (
              <div className="max-h-[220px] overflow-auto">
                <table className="w-full text-left text-[12px]">
                  <thead className="text-dim">
                    <tr>
                      <th className="pb-1 font-normal">When</th>
                      <th className="pb-1 font-normal">Symbol</th>
                      <th className="pb-1 font-normal">Score</th>
                      <th className="pb-1 font-normal">Est rent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {near.recent.map((r, i) => (
                      <tr key={`${r.at}-${i}`} className="border-t border-grid">
                        <td className="py-1.5 text-muted whitespace-nowrap">{shortTime(r.at)}</td>
                        <td className="py-1.5"><TokenSymbol symbol={r.symbol} mint={r.mint} /></td>
                        <td className="py-1.5 tabular-nums text-warn">{r.score}</td>
                        <td className="py-1.5 tabular-nums text-muted">
                          {r.estRentSol ?? "—"} / {r.rentBudget ?? "—"} SOL
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-3 space-y-1 border-t border-grid pt-2 text-[12px]">
              <div className="flex justify-between">
                <span className="text-dim">Mark-gap checks</span>
                <Badge tone={watch?.integrity.mark_gaps.pass ? "ok" : "warn"}>
                  {watch?.integrity.mark_gaps.fail_count ?? "—"} fails / {watch?.integrity.mark_gaps.positions_checked ?? "—"}
                </Badge>
              </div>
              {(watch?.p3_missed_since_fix ?? []).slice(0, 3).map((p) => (
                <div key={p.id} className="flex justify-between gap-2 text-muted">
                  <span className="inline-flex items-center gap-1">
                    Missed #{p.id} <TokenSymbol symbol={p.symbol} mint={p.mint} />
                  </span>
                  <span className="tabular-nums shrink-0">
                    {fmtSol(p.pnl, 3)}
                    {p.pct != null && <span className="ml-1">{fmtRet(p.pct)}</span>}
                    {" · "}{p.hold_min}m
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <footer className="px-1 pb-2 text-[10px] text-dim">
          Live every 15s · history every 60s · updated {updated ? new Date(updated).toLocaleTimeString() : "—"}
          {fromCache ? " · showing cache" : ""} · read-only
        </footer>
      </div>
    </div>
  );
}
