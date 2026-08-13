import type { HistorySnap, LiveWatch } from "@/lib/types";
import { cn, exitLabel, fmtPct, fmtRet, fmtSol, fmtUsd, shortTime } from "@/lib/utils";
import { Badge, Panel } from "@/components/ui";
import { EquityChart } from "@/components/Charts";
import { TokenSymbol } from "@/components/TokenSymbol";
import { RangeBar, StatusBadge, type RangeStatus } from "@/components/RangeBar";
import { ActivityFeedList } from "@/components/ActivityFeed";
import { buildActivityFeed } from "@/lib/activityFeed";

const toneN = (n: number | null | undefined) =>
  n == null ? "text-dim" : n >= 0 ? "text-ok" : "text-danger";

function HeroStat({
  label, value, pct, tone = "fg", sub,
}: {
  label: string;
  value: string;
  pct?: number | null;
  tone?: "fg" | "ok" | "danger" | "accent" | "warn";
  sub?: string;
}) {
  const toneClass = {
    fg: "text-fg", ok: "text-ok", danger: "text-danger", accent: "text-accent", warn: "text-warn",
  }[tone];
  return (
    <div className="min-w-0">
      <div className="text-[11px] tracking-[0.16em] text-dim uppercase">{label}</div>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-2">
        <span className={cn("font-display text-3xl font-semibold tabular-nums leading-none tracking-tight md:text-4xl", toneClass)}>
          {value}
        </span>
        {pct != null && (
          <span className={cn("text-base font-semibold tabular-nums", pct >= 0 ? "text-ok" : "text-danger")}>
            {pct > 0 ? "+" : ""}{(pct * 100).toFixed(1)}%
          </span>
        )}
      </div>
      {sub && <div className="mt-2 text-[12px] leading-snug text-muted">{sub}</div>}
    </div>
  );
}

export function OverviewPage({
  watch, hist, onOpenActivity,
}: {
  watch: LiveWatch | null;
  hist: HistorySnap | null;
  onOpenActivity?: () => void;
}) {
  const pnl24 = watch?.book.last_24h.pnl ?? 0;
  const pct24 = watch?.book.last_24h.pct ?? null;
  const allPnl = watch?.book.all_time_live.pnl ?? 0;
  const allPct = watch?.book.all_time_live.pct ?? null;
  const bal = watch?.balance?.total_sol;
  const balUsd = watch?.balance?.total_usd;
  const open = watch?.open ?? [];
  const closes = hist?.ladder ?? [];
  const feedPreview = buildActivityFeed(watch, 3);

  let openPnl = 0;
  let openPnlKnown = 0;
  for (const p of open) {
    const n = p.mark?.total_pnl_sol ?? p.mark?.pnl_sol;
    if (n != null) {
      openPnl += n;
      openPnlKnown += 1;
    }
  }

  return (
    <div className="flex min-h-[calc(100dvh-7.5rem)] flex-col gap-4">
      <div className="panel grid gap-6 px-5 py-5 sm:grid-cols-2 xl:grid-cols-4">
        <HeroStat
          label="Total balance"
          value={bal != null ? `${bal.toFixed(2)} SOL` : "—"}
          tone="accent"
          sub={
            balUsd != null
              ? `≈ ${fmtUsd(balUsd)} · wallet ${(watch?.balance?.wallet_sol ?? 0).toFixed(2)} + open ${(watch?.balance?.deployed_sol ?? 0).toFixed(2)}`
              : "waiting for heartbeat wallet"
          }
        />
        <HeroStat
          label="Open PnL (marks)"
          value={openPnlKnown ? fmtSol(openPnl, 3) : "—"}
          tone={!openPnlKnown ? "fg" : openPnl >= 0 ? "ok" : "danger"}
          sub={`${open.length} open · ${openPnlKnown} marked`}
        />
        <HeroStat
          label="Last 24h realized"
          value={fmtSol(pnl24)}
          pct={pct24}
          tone={pnl24 >= 0 ? "ok" : "danger"}
          sub={`${watch?.book.last_24h.n ?? 0} closes`}
        />
        <HeroStat
          label="All-time realized"
          value={fmtSol(allPnl)}
          pct={allPct}
          tone={allPnl >= 0 ? "ok" : "danger"}
          sub={`${watch?.book.all_time_live.n ?? 0} closes · Kelly ${fmtPct(watch?.kelly.appliedFraction)}`}
        />
      </div>

      <Panel title="Equity" className="shrink-0" bodyClassName="flex flex-col">
        <div className="h-[280px] w-full md:h-[320px]">
          <EquityChart data={hist?.equity ?? []} />
        </div>
      </Panel>

      <Panel
        title="Activity"
        right={
          onOpenActivity ? (
            <button
              type="button"
              onClick={onOpenActivity}
              className="text-[11px] text-accent hover:text-hot"
            >
              view all →
            </button>
          ) : (
            <Badge tone="ok">{feedPreview.length}</Badge>
          )
        }
        className="shrink-0"
      >
        <ActivityFeedList
          items={feedPreview}
          dense
          empty="Waiting for live ops events…"
        />
      </Panel>

      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-2">
        <Panel
          title="Open positions"
          right={<Badge tone="ok">{open.length}</Badge>}
          className="min-h-0"
        >
          {!open.length ? (
            <div className="flex min-h-[140px] items-center justify-center text-[12px] text-dim">
              No open positions
            </div>
          ) : (
            <div className="space-y-2">
              {open.map((p) => {
                const m = p.mark;
                const pnl = m?.total_pnl_sol ?? m?.pnl_sol;
                const inv = m?.inv_pnl_sol;
                const feeU = m?.unclaimed_fees_sol ?? 0;
                const feeC = p.fees_claimed_sol ?? m?.fees_claimed_sol ?? 0;
                const status = (p.range?.status ?? m?.status ?? "unknown") as RangeStatus;
                const underwater = pnl != null && pnl < 0;
                return (
                  <div key={p.id} className="border border-grid bg-bg/40 px-3 py-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[11px] text-accent">#{p.id}</span>
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
                          {m?.value_sol != null && <> · mark {m.value_sol.toFixed(3)} SOL{m.unreliable ? "*" : ""}</>}
                          {m?.liq_sol != null && <> · liq {m.liq_sol.toFixed(3)}</>}
                          {m?.value_sol == null && m?.unreliable && <> · mark unavailable</>}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] uppercase tracking-wider text-dim">Total PnL</div>
                        <div className={cn(
                          "tabular-nums font-semibold",
                          m?.unreliable ? "text-warn"
                            : pnl == null ? "text-dim"
                              : pnl >= 0 ? "text-ok" : "text-danger",
                        )}>
                          {m?.unreliable && pnl == null ? "mark bad"
                            : pnl == null ? "—"
                              : fmtSol(pnl, 3)}
                        </div>
                        {m?.pct != null && (
                          <div className={cn(
                            "text-[10px] tabular-nums",
                            m.unreliable ? "text-warn" : m.pct >= 0 ? "text-ok" : "text-danger",
                          )}>
                            {fmtRet(m.pct)}{m.unreliable ? " · last good" : ""}
                          </div>
                        )}
                        {m?.unreliable && m.pct == null && (
                          <div className="text-[10px] text-warn">awaiting mark</div>
                        )}
                      </div>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] tabular-nums text-muted">
                      <span>inv <span className={toneN(inv)}>{inv == null ? "—" : fmtSol(inv, 4)}</span></span>
                      <span>fees u <span className={toneN(feeU)}>{fmtSol(feeU, 4)}</span></span>
                      <span>claimed <span className={toneN(feeC)}>{fmtSol(feeC, 4)}</span></span>
                      {p.open_cost_sol != null && (
                        <span>open cost {p.open_cost_sol.toFixed(3)}</span>
                      )}
                    </div>
                    {p.range?.min_bin != null && p.range.max_bin != null && (
                      <div className="mt-2 border-t border-grid pt-1.5">
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

        <Panel
          title="Recent closes"
          right={<Badge tone={closes.length ? "accent" : "ok"}>{Math.min(closes.length, 8)} shown</Badge>}
          className="min-h-0"
        >
          {!closes.length ? (
            <div className="flex min-h-[140px] items-center justify-center text-[12px] text-dim">
              No closes in this range
            </div>
          ) : (
            <table className="w-full text-left text-[12px]">
              <thead className="text-dim">
                <tr>
                  <th className="pb-1.5 pr-2 font-normal">When</th>
                  <th className="pb-1.5 pr-2 font-normal">Symbol</th>
                  <th className="pb-1.5 pr-2 font-normal">Reason</th>
                  <th className="pb-1.5 font-normal text-right">PnL breakdown</th>
                </tr>
              </thead>
              <tbody>
                {closes.slice(0, 8).map((r) => (
                  <tr key={r.id} className="border-t border-grid align-top">
                    <td className="py-1.5 pr-2 whitespace-nowrap text-muted">{shortTime(r.at)}</td>
                    <td className="py-1.5 pr-2"><TokenSymbol symbol={r.symbol} mint={r.mint} /></td>
                    <td className="py-1.5 pr-2 text-muted">{exitLabel(r.exit_reason)}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      <div className={r.pnl >= 0 ? "font-semibold text-ok" : "font-semibold text-danger"}>
                        {fmtSol(r.pnl, 3)}
                        {r.pct != null && (
                          <span className="ml-1 text-[10px] font-normal opacity-80">{fmtRet(r.pct)}</span>
                        )}
                      </div>
                      <div className="mt-0.5 space-y-0.5 text-[10px] text-muted">
                        <div>
                          exit <span className={toneN(r.exit_move_sol)}>
                            {r.exit_move_sol == null ? "—" : fmtSol(r.exit_move_sol, 4)}
                          </span>
                          {" · "}fees <span className={toneN(r.fees_sol)}>{fmtSol(r.fees_sol ?? 0, 4)}</span>
                          {(r.recovered_sol ?? 0) !== 0 && (
                            <>
                              {" · "}rec <span className={toneN(r.recovered_sol)}>
                                {fmtSol(r.recovered_sol ?? 0, 4)}
                              </span>
                            </>
                          )}
                        </div>
                        {(r.open_cost_sol != null || r.close_return_sol != null) && (
                          <div className="text-dim">
                            cost {r.open_cost_sol?.toFixed(3) ?? "—"} → ret {r.close_return_sol?.toFixed(3) ?? "—"}
                            {r.entry_sol > 0 && <> · size {r.entry_sol.toFixed(3)}</>}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!!watch?.book.last_24h.by_reason.length && (
            <div className="mt-3 border-t border-grid pt-2">
              <div className="mb-1 text-[10px] tracking-wider text-dim uppercase">24h PnL by exit</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {watch.book.last_24h.by_reason.map((r) => (
                  <div key={r.exit_reason} className="flex gap-2 text-[11px]">
                    <span className="text-muted">{exitLabel(r.exit_reason)} ×{r.n}</span>
                    <span className={cn("tabular-nums", r.pnl >= 0 ? "text-ok" : "text-danger")}>
                      {fmtSol(r.pnl, 3)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
