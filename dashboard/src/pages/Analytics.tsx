import type { HistorySnap, LiveWatch } from "@/lib/types";
import { exitLabel, fmtRet, fmtSol, gateLabel, shortTime } from "@/lib/utils";
import { Badge, Panel } from "@/components/ui";
import { EquityChart, ExitsChart } from "@/components/Charts";
import { TokenSymbol } from "@/components/TokenSymbol";

export function AnalyticsPage({
  watch, hist,
}: {
  watch: LiveWatch | null;
  hist: HistorySnap | null;
}) {
  const near = watch?.bin_rent_near_miss.since_fix;

  return (
    <div className="space-y-3">
      <div>
        <h1 className="font-display text-lg font-semibold tracking-wide">Analytics</h1>
        <p className="text-[11px] text-dim">Charts, skips, and integrity checks.</p>
      </div>

      <div className="grid items-stretch gap-3 xl:grid-cols-2">
        <Panel title="Profit over time (SOL + USD)" className="h-full">
          <div className="h-[280px] xl:h-[320px]">
            <EquityChart data={hist?.equity ?? []} />
          </div>
        </Panel>
        <Panel title="Daily profit from closes" className="h-full">
          <div className="h-[280px] xl:h-[320px]">
            <ExitsChart data={hist?.exits ?? []} />
          </div>
          {(hist?.exit_by_reason?.length ?? 0) > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-grid pt-2.5 text-[11px] sm:grid-cols-3">
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
        </Panel>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel
          title="Why candidates were skipped"
          right={<Badge tone={watch?.open_failed_since_fix.n ? "danger" : "ok"}>
            open fails {watch?.open_failed_since_fix.n ?? 0}
          </Badge>}
        >
          <ul className="space-y-1 text-[12px]">
            {(hist?.skip_top ?? []).slice(0, 8).map((s) => (
              <li key={s.g} className="flex items-baseline justify-between gap-4 border-t border-grid pt-1.5 first:border-0 first:pt-0">
                <span className="min-w-0 truncate text-muted">{gateLabel(s.g)}</span>
                <span className="shrink-0 tabular-nums text-fg">{s.n.toLocaleString()}</span>
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

        <Panel title="Integrity">
          <div className="space-y-2 text-[12px]">
            <div className="flex justify-between">
              <span className="text-dim">Mark-gap checks</span>
              <Badge tone={watch?.integrity.mark_gaps.pass ? "ok" : "warn"}>
                {watch?.integrity.mark_gaps.fail_count ?? "—"} fails / {watch?.integrity.mark_gaps.positions_checked ?? "—"}
              </Badge>
            </div>
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
