import type { AnalyticsBucket, HistorySnap, LiveWatch, RangeKey } from "@/lib/types";
import { cn, exitLabel, fmtRet, fmtSol, gateLabel, shortTime } from "@/lib/utils";
import { Badge, Kpi, Panel, RangeTabs } from "@/components/ui";
import { CapitalChart, EquityChart, ExitsChart, FunnelChart } from "@/components/Charts";
import { TokenSymbol } from "@/components/TokenSymbol";

function tonePnl(n: number | null | undefined) {
  if (n == null) return "text-dim";
  return n >= 0 ? "text-ok" : "text-danger";
}

function ShareBar({ share }: { share: number | null }) {
  if (share == null) return null;
  return (
    <div className="mt-0.5 h-1 w-full max-w-[8rem] bg-grid">
      <div className="h-full bg-accent" style={{ width: `${Math.min(100, share * 100)}%` }} />
    </div>
  );
}

function BucketRows({
  rows,
  labelOf,
}: {
  rows: Array<AnalyticsBucket & { key: string; label: string }>;
  labelOf?: (r: { key: string; label: string }) => string;
}) {
  if (!rows.length) {
    return <p className="py-3 text-center text-[12px] text-dim">No closes in this range</p>;
  }
  return (
    <ul className="space-y-1.5 text-[12px]">
      {rows.map((r) => (
        <li key={r.key} className="border-t border-grid pt-1.5 first:border-0 first:pt-0">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-muted">
              {labelOf ? labelOf(r) : r.label}
              <span className="ml-1 text-dim">×{r.n}</span>
            </span>
            <span className={cn("shrink-0 tabular-nums font-medium", tonePnl(r.pnl))}>
              {fmtSol(r.pnl, 3)}
              {r.pct != null && <span className="ml-1 opacity-80">{fmtRet(r.pct)}</span>}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] text-dim">
            {r.win_rate != null && <span>Win {(r.win_rate * 100).toFixed(0)}%</span>}
            {r.hold_median_h != null && <span>Hold {r.hold_median_h.toFixed(1)}h med</span>}
            {r.avg_pnl != null && <span>Avg {fmtSol(r.avg_pnl, 4)}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function TokenList({
  rows, empty,
}: {
  rows: Array<AnalyticsBucket & { symbol: string; mint?: string }>;
  empty: string;
}) {
  if (!rows.length) return <p className="py-2 text-[12px] text-dim">{empty}</p>;
  return (
    <ul className="space-y-1 text-[12px]">
      {rows.map((r) => (
        <li key={`${r.mint ?? r.symbol}-${r.pnl}`} className="flex items-baseline justify-between gap-2">
          <span className="inline-flex min-w-0 items-center gap-1 truncate">
            <TokenSymbol symbol={r.symbol} mint={r.mint} />
            <span className="text-dim">×{r.n}</span>
          </span>
          <span className={cn("shrink-0 tabular-nums", tonePnl(r.pnl))}>
            {fmtSol(r.pnl, 3)}
            {r.pct != null && <span className="ml-1 opacity-80">{fmtRet(r.pct)}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function AnalyticsPage({
  watch, hist, range, onRange,
}: {
  watch: LiveWatch | null;
  hist: HistorySnap | null;
  range: RangeKey;
  onRange: (r: RangeKey) => void;
}) {
  const s = hist?.stats;
  const h = s?.headline;
  const near = watch?.bin_rent_near_miss.since_fix;
  const bal = watch?.balance;
  const utilPct = bal?.total_sol && bal.total_sol > 0 && bal.deployed_sol != null
    ? bal.deployed_sol / bal.total_sol
    : null;

  const reasonRows = (s?.by_reason ?? []).map((r) => ({
    ...r,
    key: r.reason,
    label: exitLabel(r.reason),
  }));
  const sleeveRows = (s?.by_sleeve ?? []).map((r) => ({
    ...r,
    key: r.sleeve,
    label: r.sleeve,
  }));

  return (
    <div className="space-y-3">
      <div>
        <h1 className="font-display text-lg font-semibold tracking-wide">Analytics</h1>
        <p className="text-[11px] text-dim">
          Edge, funnel, and ops for the selected range — charts update over WebSocket.
        </p>
      </div>

      {/* Headline strip */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        <Kpi label="Closes" value={h ? String(h.closes) : "—"} tone="fg" />
        <Kpi
          label="Win rate"
          value={h?.win_rate != null ? `${(h.win_rate * 100).toFixed(0)}%` : "—"}
          tone={h?.win_rate != null && h.win_rate >= 0.5 ? "ok" : "warn"}
        />
        <Kpi
          label="Avg win"
          value={h?.avg_win_sol != null ? fmtSol(h.avg_win_sol, 3) : "—"}
          tone="ok"
        />
        <Kpi
          label="Avg loss"
          value={h?.avg_loss_sol != null ? fmtSol(h.avg_loss_sol, 3) : "—"}
          tone="danger"
        />
        <Kpi
          label="Expectancy"
          value={h?.expectancy_sol != null ? fmtSol(h.expectancy_sol, 4) : "—"}
          sub="Per close"
          tone={h?.expectancy_sol != null && h.expectancy_sol >= 0 ? "ok" : "danger"}
        />
        <Kpi
          label="Fees collected"
          value={h ? fmtSol(h.fees_sol, 3) : "—"}
          tone="ok"
        />
        <Kpi
          label="Inventory P&L"
          value={h?.inventory_sol != null ? fmtSol(h.inventory_sol, 3) : "—"}
          sub="Deposit move ex-fees"
          tone={h?.inventory_sol != null && h.inventory_sol >= 0 ? "ok" : "danger"}
        />
        <Kpi
          label="Net P&L"
          value={h ? fmtSol(h.pnl_sol, 3) : "—"}
          tone={h && h.pnl_sol >= 0 ? "ok" : "danger"}
        />
      </div>

      {/* Top charts */}
      <div className="grid items-stretch gap-3 xl:grid-cols-2">
        <Panel
          title="Equity & daily closes"
          right={<RangeTabs value={range} onChange={onRange} />}
          className="h-full"
        >
          <div className="h-[280px] xl:h-[320px]">
            <EquityChart data={hist?.equity ?? []} exits={hist?.exits} />
          </div>
        </Panel>
        <Panel title="Daily profit from closes" className="h-full">
          <div className="h-[280px] xl:h-[320px]">
            <ExitsChart data={hist?.exits ?? []} />
          </div>
        </Panel>
      </div>

      {/* Edge */}
      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="P&L by exit reason" right={<Badge tone="accent">edge</Badge>}>
          <BucketRows rows={reasonRows} />
        </Panel>
        <Panel title="P&L by sleeve" right={<Badge tone="accent">meme · micro · majors · follow</Badge>}>
          <BucketRows rows={sleeveRows} />
          {s?.follow && s.follow.n > 0 && (
            <div className="mt-3 border-t border-grid pt-2 text-[11px] text-muted">
              Follow legs: {s.follow.n} closes · {s.follow.chains} chains ·{" "}
              <span className={tonePnl(s.follow.pnl)}>{fmtSol(s.follow.pnl, 3)}</span>
              {s.follow.win_rate != null && (
                <span className="text-dim"> · win {(s.follow.win_rate * 100).toFixed(0)}%</span>
              )}
            </div>
          )}
        </Panel>
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        <Panel title="Fee vs inventory">
          <div className="space-y-2 text-[12px]">
            <div className="flex justify-between">
              <span className="text-dim">Fees collected</span>
              <span className="tabular-nums text-ok">{fmtSol(s?.fee_vs_inventory.fees_sol ?? 0, 3)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-dim">Inventory move</span>
              <span className={cn("tabular-nums", tonePnl(s?.fee_vs_inventory.inventory_sol))}>
                {s?.fee_vs_inventory.inventory_sol != null
                  ? fmtSol(s.fee_vs_inventory.inventory_sol, 3)
                  : "—"}
              </span>
            </div>
            <p className="text-[10px] leading-snug text-dim">
              If fees dominate, the book is earning as an LP. If inventory dominates, directional moves are driving P&L.
            </p>
          </div>
        </Panel>
        <Panel title="Best tokens">
          <TokenList rows={s?.tokens_best ?? []} empty="No winners yet" />
        </Panel>
        <Panel title="Worst tokens">
          <TokenList rows={s?.tokens_worst ?? []} empty="No losers yet" />
        </Panel>
      </div>

      {/* Funnel */}
      <div className="grid gap-3 xl:grid-cols-2">
        <Panel
          title="Entry funnel"
          right={
            <Badge tone={s?.funnel.open_failed ? "danger" : "ok"}>
              fail {(s?.funnel.fail_rate != null ? `${(s.funnel.fail_rate * 100).toFixed(0)}%` : "—")}
            </Badge>
          }
        >
          <div className="mb-3 grid grid-cols-3 gap-2 text-center text-[12px]">
            <div className="border border-grid px-2 py-2">
              <div className="text-[10px] text-dim uppercase">Entered</div>
              <div className="mt-1 font-semibold tabular-nums text-ok">{s?.funnel.entered ?? 0}</div>
            </div>
            <div className="border border-grid px-2 py-2">
              <div className="text-[10px] text-dim uppercase">Skipped</div>
              <div className="mt-1 font-semibold tabular-nums text-fg">{s?.funnel.skipped ?? 0}</div>
            </div>
            <div className="border border-grid px-2 py-2">
              <div className="text-[10px] text-dim uppercase">Open fail</div>
              <div className="mt-1 font-semibold tabular-nums text-danger">{s?.funnel.open_failed ?? 0}</div>
            </div>
          </div>
          <div className="h-[180px]">
            <FunnelChart data={hist?.activity ?? []} />
          </div>
          {(s?.funnel.entry_scores.n ?? 0) > 0 && (
            <div className="mt-3 border-t border-grid pt-2 text-[11px] text-muted">
              Entry scores · n={s!.funnel.entry_scores.n}
              {s!.funnel.entry_scores.median != null && (
                <> · med {s!.funnel.entry_scores.median.toFixed(0)}</>
              )}
              {s!.funnel.entry_scores.p25 != null && s!.funnel.entry_scores.p75 != null && (
                <> · p25–p75 {s!.funnel.entry_scores.p25.toFixed(0)}–{s!.funnel.entry_scores.p75.toFixed(0)}</>
              )}
            </div>
          )}
          {watch?.kelly && (
            <div className="mt-2 text-[11px] text-muted">
              Kelly · {watch.kelly.samples} samples ·{" "}
              {watch.kelly.winRate != null ? `${(watch.kelly.winRate * 100).toFixed(0)}% win` : "—"} ·{" "}
              {(watch.kelly.appliedFraction * 100).toFixed(1)}% frac · {watch.kelly.regime}
            </div>
          )}
        </Panel>

        <Panel title="Why we skip / fail opens">
          <div className="mb-2 text-[10px] tracking-wider text-dim uppercase">Top skip gates</div>
          <ul className="space-y-1.5 text-[12px]">
            {(s?.funnel.skip_share ?? []).slice(0, 8).map((row) => (
              <li key={row.g}>
                <div className="flex justify-between gap-2">
                  <span className="min-w-0 truncate text-muted">{gateLabel(row.g)}</span>
                  <span className="shrink-0 tabular-nums text-fg">
                    {row.n.toLocaleString()}
                    {row.share != null && (
                      <span className="ml-1 text-dim">{(row.share * 100).toFixed(0)}%</span>
                    )}
                  </span>
                </div>
                <ShareBar share={row.share} />
              </li>
            ))}
            {!s?.funnel.skip_share?.length && (
              <li className="py-2 text-dim">No skips in this range</li>
            )}
          </ul>
          <div className="mt-3 border-t border-grid pt-2">
            <div className="mb-1 text-[10px] tracking-wider text-dim uppercase">Open-fail codes</div>
            {(s?.funnel.fail_codes ?? []).length ? (
              <ul className="space-y-1 text-[12px]">
                {s!.funnel.fail_codes.map((c) => (
                  <li key={c.code} className="flex justify-between gap-2">
                    <span className="truncate font-mono text-[11px] text-muted">{c.code}</span>
                    <span className="tabular-nums text-danger">{c.n}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] text-dim">No open fails in range</p>
            )}
          </div>
        </Panel>
      </div>

      {/* Extra edge: fee/TVL buckets + capital + TIR */}
      <div className="grid gap-3 xl:grid-cols-3">
        <Panel title="Entry fee/TVL vs outcome">
          {(s?.fee_tvl_buckets ?? []).length ? (
            <ul className="space-y-2 text-[12px]">
              {s!.fee_tvl_buckets.map((b) => (
                <li key={b.label} className="border-t border-grid pt-1.5 first:border-0 first:pt-0">
                  <div className="flex justify-between gap-2">
                    <span className="text-muted">
                      {b.label}
                      <span className="ml-1 text-dim">
                        ({b.fee_tvl_min.toFixed(1)}–{b.fee_tvl_max.toFixed(1)}%)
                      </span>
                    </span>
                    <span className={cn("tabular-nums", tonePnl(b.pnl))}>
                      {fmtSol(b.pnl, 3)}
                      <span className="ml-1 text-dim">×{b.n}</span>
                    </span>
                  </div>
                  {b.win_rate != null && (
                    <div className="text-[10px] text-dim">Win {(b.win_rate * 100).toFixed(0)}%</div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-3 text-[12px] text-dim">Need entry fee/TVL on closes to bucket</p>
          )}
        </Panel>
        <Panel
          title="Capital / open book"
          right={
            utilPct != null ? (
              <Badge tone="accent">{(utilPct * 100).toFixed(0)}% deployed</Badge>
            ) : undefined
          }
        >
          <div className="mb-2 text-[11px] text-muted">
            Now{" "}
            {bal?.deployed_sol != null ? `${bal.deployed_sol.toFixed(2)} SOL open` : "—"}
            {bal?.wallet_sol != null && <> · {bal.wallet_sol.toFixed(2)} wallet</>}
          </div>
          <div className="h-[160px]">
            <CapitalChart data={s?.capital_series ?? []} />
          </div>
          <p className="mt-2 text-[10px] text-dim">
            Chart = daily unrealized from pnl_daily (open-book proxy).
          </p>
        </Panel>
        <Panel title="Time in range">
          <div className="text-[28px] font-semibold tabular-nums text-fg">
            {s?.time_in_range.avg_pct != null
              ? `${(s.time_in_range.avg_pct * 100).toFixed(0)}%`
              : "—"}
          </div>
          <p className="mt-1 text-[11px] text-muted">
            Avg share of marks in-range while open
            {s?.time_in_range.with_marks != null && (
              <> · {s.time_in_range.with_marks}/{s.time_in_range.n} closes with marks</>
            )}
          </p>
        </Panel>
      </div>

      {/* Ops */}
      <div className="grid gap-3 xl:grid-cols-2">
        <Panel
          title="Ops · cluster & mark health"
          right={
            <Badge tone={watch?.cluster.tripped ? "danger" : "ok"}>
              {watch?.cluster.tripped ? `brake ${watch.cluster.remainingMin}m` : "brake off"}
            </Badge>
          }
        >
          <div className="space-y-2 text-[12px]">
            <div className="flex justify-between">
              <span className="text-dim">Hard loss exits (P0/P1 ≤ −10%)</span>
              <span className="tabular-nums">
                {s?.cluster_pressure.hard_loss_exits ?? 0}
                <span className={cn("ml-2", tonePnl(s?.cluster_pressure.pnl))}>
                  {fmtSol(s?.cluster_pressure.pnl ?? 0, 3)}
                </span>
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-dim">Mark-gap checks</span>
              <Badge tone={watch?.integrity.mark_gaps.pass ? "ok" : "warn"}>
                {watch?.integrity.mark_gaps.fail_count ?? "—"} fails / {watch?.integrity.mark_gaps.positions_checked ?? "—"}
              </Badge>
            </div>
            {(s?.cluster_pressure.recent ?? []).slice(0, 4).map((r) => (
              <div key={r.id} className="flex justify-between gap-2 border-t border-grid pt-1.5 text-muted">
                <span className="inline-flex items-center gap-1 truncate">
                  {exitLabel(r.reason)} <TokenSymbol symbol={r.symbol} mint={r.mint} />
                </span>
                <span className={cn("shrink-0 tabular-nums", tonePnl(r.pnl))}>
                  {fmtSol(r.pnl, 3)} · {shortTime(r.at)}
                </span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Ops · P3 missed & rent near-misses">
          <div className="space-y-2 text-[12px]">
            <div className="flex justify-between items-center">
              <span className="text-dim">Rent near-misses · score ≥ {near?.score_min ?? 70}</span>
              <Badge tone={near && near.n > 0 ? "warn" : "ok"}>{near?.n ?? 0} since fix</Badge>
            </div>
            {(watch?.p3_missed_since_fix ?? []).slice(0, 5).map((p) => (
              <div key={p.id} className="flex justify-between gap-2 text-muted border-t border-grid pt-1.5">
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
            {!watch?.p3_missed_since_fix?.length && (
              <p className="text-dim">No P3-missed closes since fix</p>
            )}
            {!!near?.recent.length && (
              <div className="border-t border-grid pt-2">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-dim">Recent near-misses</div>
                {near.recent.slice(0, 5).map((r, i) => (
                  <div key={`${r.at}-${i}`} className="flex justify-between text-[11px] text-muted">
                    <span>{shortTime(r.at)} <TokenSymbol symbol={r.symbol} mint={r.mint} /></span>
                    <span className="tabular-nums text-warn">{r.score} · {r.estRentSol}/{r.rentBudget}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
