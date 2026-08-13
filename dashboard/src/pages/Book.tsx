import type { HistorySnap, LiveWatch } from "@/lib/types";
import { exitLabel, fmtRet, fmtSol, shortTime } from "@/lib/utils";
import { Panel } from "@/components/ui";
import { TokenSymbol } from "@/components/TokenSymbol";
import { RangeBar, StatusBadge, type RangeStatus } from "@/components/RangeBar";

export function BookPage({
  watch, hist,
}: {
  watch: LiveWatch | null;
  hist: HistorySnap | null;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h1 className="font-display text-lg font-semibold tracking-wide">Book</h1>
        <p className="text-[11px] text-dim">Open positions and recent closes.</p>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Open positions">
          {!watch?.open.length ? (
            <div className="py-8 text-center text-[12px] tracking-wider text-dim">No open positions</div>
          ) : (
            <div className="space-y-2">
              {watch.open.map((p) => {
                const m = p.mark;
                const pnl = m?.total_pnl_sol ?? m?.pnl_sol;
                const inv = m?.inv_pnl_sol;
                const feeU = m?.unclaimed_fees_sol ?? 0;
                const feeC = p.fees_claimed_sol ?? m?.fees_claimed_sol ?? 0;
                const status = (p.range?.status ?? m?.status ?? "unknown") as RangeStatus;
                const underwater = pnl != null && pnl < 0;
                const tone = (n: number | null | undefined) =>
                  n == null ? "text-dim" : n >= 0 ? "text-ok" : "text-danger";
                return (
                  <div key={p.id} className="border border-grid bg-bg/40 px-3 py-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 space-y-0.5">
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
                          {m?.value_sol != null && <> · mark {m.value_sol.toFixed(3)} SOL{m.unreliable ? "*" : ""}</>}
                          {m?.liq_sol != null && <> · liq {m.liq_sol.toFixed(3)}</>}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] text-dim uppercase tracking-wider">Total PnL</div>
                        <div className={`tabular-nums font-semibold ${
                          m?.unreliable ? "text-warn"
                            : pnl == null ? "text-dim"
                              : pnl >= 0 ? "text-ok" : "text-danger"
                        }`}>
                          {m?.unreliable && pnl == null ? "mark bad"
                            : pnl == null ? "—"
                              : fmtSol(pnl, 3)}
                        </div>
                        {m?.pct != null && (
                          <div className={`text-[10px] tabular-nums ${
                            m.unreliable ? "text-warn" : m.pct >= 0 ? "text-ok" : "text-danger"
                          }`}>
                            {fmtRet(m.pct)}{m.unreliable ? " · last good" : ""}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] tabular-nums text-muted">
                      <span>inv <span className={tone(inv)}>{inv == null ? "—" : fmtSol(inv, 4)}</span></span>
                      <span>fees u <span className={tone(feeU)}>{fmtSol(feeU, 4)}</span></span>
                      <span>claimed <span className={tone(feeC)}>{fmtSol(feeC, 4)}</span></span>
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

        <Panel title="Recent closes">
          {!hist?.ladder.length ? (
            <div className="py-8 text-center text-[12px] tracking-wider text-dim">No closes in this range</div>
          ) : (
            <>
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
                  {hist.ladder.slice(0, 20).map((r) => {
                    const tone = (n: number | null | undefined) =>
                      n == null ? "text-dim" : n >= 0 ? "text-ok" : "text-danger";
                    return (
                      <tr key={r.id} className="border-t border-grid align-top">
                        <td className="py-1.5 pr-2 text-muted whitespace-nowrap">{shortTime(r.at)}</td>
                        <td className="py-1.5 pr-2"><TokenSymbol symbol={r.symbol} mint={r.mint} /></td>
                        <td className="py-1.5 pr-2 text-muted">{exitLabel(r.exit_reason)}</td>
                        <td className="py-1.5 text-right tabular-nums">
                          <div className={r.pnl >= 0 ? "text-ok font-semibold" : "text-danger font-semibold"}>
                            {fmtSol(r.pnl, 3)}
                            {r.pct != null && (
                              <span className="ml-1 text-[10px] font-normal opacity-80">{fmtRet(r.pct)}</span>
                            )}
                          </div>
                          <div className="mt-0.5 space-y-0.5 text-[10px] text-muted">
                            <div>
                              exit <span className={tone(r.exit_move_sol)}>
                                {r.exit_move_sol == null ? "—" : fmtSol(r.exit_move_sol, 4)}
                              </span>
                              {" · "}fees <span className={tone(r.fees_sol)}>{fmtSol(r.fees_sol ?? 0, 4)}</span>
                              {(r.recovered_sol ?? 0) !== 0 && (
                                <>
                                  {" · "}rec <span className={tone(r.recovered_sol)}>
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
                    );
                  })}
                </tbody>
              </table>
              {hist.ladder.length > 20 && (
                <div className="mt-2 text-[10px] text-dim">Showing 20 of {hist.ladder.length} closes</div>
              )}
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
