import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowLeftRight,
  Coins,
  HandCoins,
  Layers,
  Package,
  Percent,
  Receipt,
} from "lucide-react";
import type { LiveWatch } from "@/lib/types";
import { cn, fmtRet, fmtSol, fmtUsdCompact, shortTime } from "@/lib/utils";
import { TokenSymbol } from "@/components/TokenSymbol";
import { RangeBar, SleeveBadge, StatusBadge, type RangeStatus } from "@/components/RangeBar";
import { LiveNum } from "@/components/LiveNum";

type OpenPos = LiveWatch["open"][number];

function toneN(n: number | null | undefined) {
  return n == null ? "text-dim" : n >= 0 ? "text-ok" : "text-danger";
}

/** Label + icon with a plain-English hover tip. */
function Metric({
  icon: I,
  label,
  tip,
  children,
}: {
  icon: LucideIcon;
  label: string;
  tip: string;
  children: ReactNode;
}) {
  return (
    <span
      className="inline-flex items-center gap-1"
      title={tip}
    >
      <I size={11} strokeWidth={1.75} className="shrink-0 text-dim" aria-hidden />
      <span className="text-dim">{label}</span>
      <span className="tabular-nums">{children}</span>
    </span>
  );
}

export function OpenPositionCard({ p, live = false }: { p: OpenPos; live?: boolean }) {
  const m = p.mark;
  const pnl = m?.total_pnl_sol ?? m?.pnl_sol;
  const depositPnl = m?.inv_pnl_sol;
  const feeU = m?.unclaimed_fees_sol ?? 0;
  const feeC = p.fees_claimed_sol ?? m?.fees_claimed_sol ?? 0;
  const status = (p.range?.status ?? m?.status ?? "unknown") as RangeStatus;
  const underwater = pnl != null && pnl < 0;
  const winning = !underwater && pnl != null && pnl > 0;

  const flash = (signal: number | null | undefined, node: ReactNode) =>
    live ? <LiveNum signal={signal}>{node}</LiveNum> : node;

  return (
    <div className="border border-grid bg-bg/40 px-3 py-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-accent" title="Position id">#{p.id}</span>
            <TokenSymbol symbol={p.symbol} mint={p.mint} />
            <SleeveBadge sleeve={p.sleeve} follow={p.follow} />
            <StatusBadge status={status} />
            {underwater && (
              <span className="text-[10px] uppercase tracking-wider text-danger" title="Total profit is negative right now">
                losing
              </span>
            )}
            {winning && (
              <span className="text-[10px] uppercase tracking-wider text-ok" title="Total profit is positive right now">
                winning
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
            <span title="SOL deposited when this position opened">
              Deposited <span className="tabular-nums text-fg">{p.entry_sol.toFixed(3)}</span>
            </span>
            <span title="When the bot opened this position">
              Opened {shortTime(p.opened)}
            </span>
            {m?.age_s != null && (
              <span title="Seconds since the bot last marked this position on-chain">
                Marked <span className="tabular-nums text-fg">{Math.round(m.age_s)}s</span> ago
              </span>
            )}
            {m?.value_sol != null && (
              <span title="Estimated SOL you’d get back right now (LP + unclaimed fees)">
                Worth now{" "}
                {flash(
                  m.value_sol,
                  <span className="tabular-nums text-fg">{m.value_sol.toFixed(3)}{m.unreliable ? "*" : ""}</span>,
                )}
              </span>
            )}
            {m?.value_sol == null && m?.unreliable && (
              <span className="text-warn" title="Couldn’t read a fresh value from the pool">
                Value unavailable
              </span>
            )}
          </div>
        </div>
        <div className="text-right" title="Deposit change + unclaimed fees + fees already claimed">
          <div className="text-[10px] uppercase tracking-wider text-dim">Total profit</div>
          {flash(
            pnl,
            <div className={cn(
              "tabular-nums font-semibold",
              m?.unreliable ? "text-warn"
                : pnl == null ? "text-dim"
                  : pnl >= 0 ? "text-ok" : "text-danger",
            )}>
              {m?.unreliable && pnl == null ? "unavailable"
                : pnl == null ? "—"
                  : fmtSol(pnl, 3)}
            </div>,
          )}
          {m?.pct != null && flash(
            m.pct,
            <div className={cn(
              "text-[10px] tabular-nums",
              m.unreliable ? "text-warn" : m.pct >= 0 ? "text-ok" : "text-danger",
            )}>
              {fmtRet(m.pct)}{m.unreliable ? " · stale" : ""}
            </div>,
          )}
          {m?.unreliable && m.pct == null && (
            <div className="text-[10px] text-warn">Waiting for update</div>
          )}
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
        <Metric
          icon={Package}
          label="Deposit P&L"
          tip="Change in your LP deposit vs what you put in (fees not counted here)"
        >
          {flash(depositPnl, <span className={toneN(depositPnl)}>{depositPnl == null ? "—" : fmtSol(depositPnl, 4)}</span>)}
        </Metric>
        <Metric
          icon={Coins}
          label="Unclaimed fees"
          tip="Trading fees earned but still sitting in the position"
        >
          {flash(feeU, <span className={toneN(feeU)}>{fmtSol(feeU, 4)}</span>)}
        </Metric>
        <Metric
          icon={HandCoins}
          label="Fees claimed"
          tip="Fees already withdrawn to the wallet from this position"
        >
          <span className={toneN(feeC)}>{fmtSol(feeC, 4)}</span>
        </Metric>
        {p.open_cost_sol != null && (
          <Metric
            icon={Receipt}
            label="Open cost"
            tip="SOL that left the wallet when opening (deposit + rent/fees)"
          >
            <span className="text-fg">{p.open_cost_sol.toFixed(3)}</span>
          </Metric>
        )}
      </div>

      {p.pool && (p.pool.vol_24h_usd != null || p.pool.fees_24h_usd != null || p.pool.fee_tvl_24h_pct != null) && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
          {p.pool.vol_24h_usd != null && (
            <Metric
              icon={Activity}
              label="Pool vol 24h"
              tip="Pool trading volume over ~24h (Meteora datapi via last scanner snapshot)"
            >
              <span className="text-fg">{fmtUsdCompact(p.pool.vol_24h_usd)}</span>
            </Metric>
          )}
          {p.pool.fees_24h_usd != null && (
            <Metric
              icon={Coins}
              label="Pool fees 24h"
              tip="Estimated pool-wide fees over ~24h = TVL × fee/TVL 24h (not your share)"
            >
              <span className="text-fg">{fmtUsdCompact(p.pool.fees_24h_usd)}</span>
            </Metric>
          )}
          {p.pool.fee_tvl_24h_pct != null && (
            <Metric
              icon={Percent}
              label="Fee/TVL 24h"
              tip="Meteora fee/TVL ratio over 24h — same signal the bot gates / scores on (not annualized APR)"
            >
              <span className="text-fg">{p.pool.fee_tvl_24h_pct.toFixed(2)}%</span>
            </Metric>
          )}
          {p.pool.vol_30m_usd != null && (
            <Metric
              icon={Activity}
              label="Vol 30m"
              tip="Pool volume in the last ~30 minutes"
            >
              <span className="text-fg">{fmtUsdCompact(p.pool.vol_30m_usd)}</span>
            </Metric>
          )}
          {p.pool.tvl_usd != null && (
            <Metric
              icon={Layers}
              label="TVL"
              tip="Pool total value locked"
            >
              <span className="text-fg">{fmtUsdCompact(p.pool.tvl_usd)}</span>
            </Metric>
          )}
        </div>
      )}

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
}

/** Compact close-row P&L with plain labels + hover tips. */
export function ClosePnlCell({
  pnl, pct, exitMove, fees, recovered, openCost, closeReturn, entrySol,
}: {
  pnl: number;
  pct?: number | null;
  exitMove?: number | null;
  fees?: number | null;
  recovered?: number | null;
  openCost?: number | null;
  closeReturn?: number | null;
  entrySol?: number;
}) {
  return (
    <td className="py-1.5 text-right tabular-nums">
      <div
        className={pnl >= 0 ? "font-semibold text-ok" : "font-semibold text-danger"}
        title="Realized profit for this close"
      >
        {fmtSol(pnl, 3)}
        {pct != null && (
          <span className="ml-1 text-[10px] font-normal opacity-80">{fmtRet(pct)}</span>
        )}
      </div>
      <div className="mt-0.5 space-y-0.5 text-[10px] text-muted">
        <div className="flex flex-wrap justify-end gap-x-2 gap-y-0.5">
          <span className="inline-flex items-center gap-0.5" title="Profit/loss from the LP deposit alone (before fees)">
            <Layers size={10} strokeWidth={1.75} className="text-dim" aria-hidden />
            Exit <span className={toneN(exitMove)}>{exitMove == null ? "—" : fmtSol(exitMove, 4)}</span>
          </span>
          <span className="inline-flex items-center gap-0.5" title="Fees collected while this position was open">
            <Coins size={10} strokeWidth={1.75} className="text-dim" aria-hidden />
            Fees <span className={toneN(fees)}>{fmtSol(fees ?? 0, 4)}</span>
          </span>
          {(recovered ?? 0) !== 0 && (
            <span className="inline-flex items-center gap-0.5" title="Extra SOL recovered later (e.g. leftover tokens sold)">
              <ArrowLeftRight size={10} strokeWidth={1.75} className="text-dim" aria-hidden />
              Recovered <span className={toneN(recovered)}>{fmtSol(recovered ?? 0, 4)}</span>
            </span>
          )}
        </div>
        {(openCost != null || closeReturn != null) && (
          <div className="text-dim" title="Wallet SOL out when opened → wallet SOL back when closed">
            Opened {openCost?.toFixed(3) ?? "—"} → closed {closeReturn?.toFixed(3) ?? "—"}
            {entrySol != null && entrySol > 0 && <> · deposited {entrySol.toFixed(3)}</>}
          </div>
        )}
      </div>
    </td>
  );
}
