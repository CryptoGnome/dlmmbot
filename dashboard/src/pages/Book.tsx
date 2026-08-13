import type { HistorySnap, LiveWatch } from "@/lib/types";
import { exitLabel, shortTime } from "@/lib/utils";
import { Panel } from "@/components/ui";
import { TokenSymbol } from "@/components/TokenSymbol";
import { ClosePnlCell, OpenPositionCard } from "@/components/OpenPositionCard";

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
              {watch.open.map((p) => (
                <OpenPositionCard key={p.id} p={p} />
              ))}
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
                    <th className="pb-1.5 font-normal text-right">Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {hist.ladder.slice(0, 20).map((r) => (
                    <tr key={r.id} className="border-t border-grid align-top">
                      <td className="py-1.5 pr-2 text-muted whitespace-nowrap">{shortTime(r.at)}</td>
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
