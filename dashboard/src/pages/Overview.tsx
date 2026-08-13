import type { HistorySnap, LiveWatch } from "@/lib/types";
import { cn, exitLabel, fmtPct, fmtRet, fmtSol, fmtUsd, shortTime } from "@/lib/utils";
import { Badge, Panel } from "@/components/ui";
import { EquityChart } from "@/components/Charts";
import { TokenSymbol } from "@/components/TokenSymbol";
import { StatusBadge, type RangeStatus } from "@/components/RangeBar";

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
  watch, hist,
}: {
  watch: LiveWatch | null;
  hist: HistorySnap | null;
}) {
  const pnl24 = watch?.book.last_24h.pnl ?? 0;
  const pct24 = watch?.book.last_24h.pct ?? null;
  const allPnl = watch?.book.all_time_live.pnl ?? 0;
  const allPct = watch?.book.all_time_live.pct ?? null;
  const bal = watch?.balance?.total_sol;
  const balUsd = watch?.balance?.total_usd;
  const open = watch?.open ?? [];
  const closes = hist?.ladder ?? [];

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
            <ul className="divide-y divide-grid">
              {open.map((p) => {
                const m = p.mark;
                const pnl = m?.total_pnl_sol ?? m?.pnl_sol;
                const status = (p.range?.status ?? m?.status ?? "unknown") as RangeStatus;
                return (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="text-[10px] text-dim">#{p.id}</span>
                      <TokenSymbol symbol={p.symbol} mint={p.mint} />
                      <StatusBadge status={status} />
                      <span className="text-[11px] text-muted tabular-nums">{p.entry_sol.toFixed(2)} SOL</span>
                    </div>
                    <div className="text-right">
                      <div className={cn(
                        "tabular-nums text-[13px] font-semibold",
                        pnl == null ? "text-dim" : pnl >= 0 ? "text-ok" : "text-danger",
                      )}>
                        {pnl == null ? "—" : fmtSol(pnl, 3)}
                      </div>
                      {m?.pct != null && (
                        <div className={cn("text-[10px] tabular-nums", m.pct >= 0 ? "text-ok" : "text-danger")}>
                          {fmtRet(m.pct)}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
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
            <ul className="divide-y divide-grid">
              {closes.slice(0, 8).map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="w-14 shrink-0 text-[10px] text-dim tabular-nums">{shortTime(r.at)}</span>
                    <TokenSymbol symbol={r.symbol} mint={r.mint} />
                    <span className="truncate text-[11px] text-muted">{exitLabel(r.exit_reason)}</span>
                  </div>
                  <div className="text-right">
                    <div className={cn(
                      "tabular-nums text-[13px] font-semibold",
                      r.pnl >= 0 ? "text-ok" : "text-danger",
                    )}>
                      {fmtSol(r.pnl, 3)}
                    </div>
                    {r.pct != null && (
                      <div className={cn("text-[10px] tabular-nums", r.pct >= 0 ? "text-ok" : "text-danger")}>
                        {fmtRet(r.pct)}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
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
