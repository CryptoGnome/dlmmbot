import type { HistorySnap, LiveWatch, RangeKey } from "@/lib/types";
import { cn, exitLabel, fmtPct, fmtSol, fmtUsd, shortTime } from "@/lib/utils";
import { Badge, Panel, RangeTabs } from "@/components/ui";
import { EquityChart } from "@/components/Charts";
import { TokenSymbol } from "@/components/TokenSymbol";
import { ActivityFeedList } from "@/components/ActivityFeed";
import { buildActivityFeed } from "@/lib/activityFeed";
import { ClosePnlCell, OpenPositionCard } from "@/components/OpenPositionCard";
import { LiveNum } from "@/components/LiveNum";

function HeroStat({
  label, value, signal, pct, tone = "fg", sub,
}: {
  label: string;
  value: string;
  /** Drives flash direction when WS updates change this stat. */
  signal?: number | null;
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
        <LiveNum
          signal={signal ?? value}
          className={cn("font-display text-3xl font-semibold tabular-nums leading-none tracking-tight md:text-4xl", toneClass)}
        >
          {value}
        </LiveNum>
        {pct != null && (
          <LiveNum
            signal={pct}
            className={cn("text-base font-semibold tabular-nums", pct >= 0 ? "text-ok" : "text-danger")}
          >
            {pct > 0 ? "+" : ""}{(pct * 100).toFixed(1)}%
          </LiveNum>
        )}
      </div>
      {sub && <div className="mt-2 text-[12px] leading-snug text-muted">{sub}</div>}
    </div>
  );
}

export function OverviewPage({
  watch, hist, range, onRange, onOpenActivity,
}: {
  watch: LiveWatch | null;
  hist: HistorySnap | null;
  range: RangeKey;
  onRange: (r: RangeKey) => void;
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
  let openEntry = 0;
  let openPnlKnown = 0;
  for (const p of open) {
    const n = p.mark?.total_pnl_sol ?? p.mark?.pnl_sol;
    if (n != null) {
      openPnl += n;
      openEntry += p.entry_sol ?? 0;
      openPnlKnown += 1;
    }
  }
  const openPct = openPnlKnown && openEntry > 0 ? openPnl / openEntry : null;

  return (
    <div className="flex min-h-[calc(100dvh-7.5rem)] flex-col gap-4">
      <div className="panel grid gap-6 px-5 py-5 sm:grid-cols-2 xl:grid-cols-4">
        <HeroStat
          label="Total balance"
          value={bal != null ? `${bal.toFixed(2)} SOL` : "—"}
          signal={bal}
          tone="accent"
          sub={
            balUsd != null
              ? `≈ ${fmtUsd(balUsd)} · wallet ${(watch?.balance?.wallet_sol ?? 0).toFixed(2)} + open ${(watch?.balance?.deployed_sol ?? 0).toFixed(2)}`
              : "waiting for heartbeat wallet"
          }
        />
        <HeroStat
          label="Open profit"
          value={openPnlKnown ? fmtSol(openPnl, 3) : "—"}
          signal={openPnlKnown ? openPnl : null}
          pct={openPct}
          tone={!openPnlKnown ? "fg" : openPnl >= 0 ? "ok" : "danger"}
          sub={`${open.length} open · live marks via WebSocket`}
        />
        <HeroStat
          label="Last 24h profit"
          value={fmtSol(pnl24)}
          signal={pnl24}
          pct={pct24}
          tone={pnl24 >= 0 ? "ok" : "danger"}
          sub={`${watch?.book.last_24h.n ?? 0} closes`}
        />
        <HeroStat
          label="All-time profit"
          value={fmtSol(allPnl)}
          signal={allPnl}
          pct={allPct}
          tone={allPnl >= 0 ? "ok" : "danger"}
          sub={`${watch?.book.all_time_live.n ?? 0} closes · Kelly ${fmtPct(watch?.kelly.appliedFraction)}`}
        />
      </div>

      <Panel
        title="Equity"
        right={<RangeTabs value={range} onChange={onRange} />}
        className="shrink-0"
        bodyClassName="flex flex-col"
      >
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
              {open.map((p) => (
                <OpenPositionCard key={p.id} p={p} live />
              ))}
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
                  <th className="pb-1.5 font-normal text-right">Profit</th>
                </tr>
              </thead>
              <tbody>
                {closes.slice(0, 8).map((r) => (
                  <tr key={r.id} className="border-t border-grid align-top">
                    <td className="py-1.5 pr-2 whitespace-nowrap text-muted">{shortTime(r.at)}</td>
                    <td className="py-1.5 pr-2"><TokenSymbol symbol={r.symbol} mint={r.mint} /></td>
                    <td className="py-1.5 pr-2 text-muted">{exitLabel(r.exit_reason)}</td>
                    <ClosePnlCell
                      pnl={r.pnl}
                      pct={r.pct}
                      exitMove={r.exit_move_sol}
                      fees={r.fees_sol}
                      recovered={r.recovered_sol}
                      openCost={r.open_cost_sol}
                      closeReturn={r.close_return_sol}
                      entrySol={r.entry_sol}
                    />
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
