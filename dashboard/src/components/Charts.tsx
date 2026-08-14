import { useMemo } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { HistorySnap } from "@/lib/types";
import { fmtRet, fmtSol, fmtUsd } from "@/lib/format";

const axis = { stroke: "#6B6B6B", fontSize: 11, tick: { fill: "#6B6B6B" } };
const grid = { stroke: "#2A2A2A", strokeDasharray: "3 5" };

function Empty({ msg }: { msg: string }) {
  return (
    <div className="flex h-full min-h-[140px] items-center justify-center text-[12px] tracking-wider text-dim">
      {msg}
    </div>
  );
}

type TipRow = { label: string; value: string; tone?: "ok" | "danger" | "accent" | "fg" };

function ChartTip({ title, rows }: { title?: string; rows: TipRow[] }) {
  if (!rows.length) return null;
  const toneClass = {
    ok: "text-ok",
    danger: "text-danger",
    accent: "text-accent",
    fg: "text-fg",
  } as const;
  return (
    <div className="rounded-sm border border-grid bg-bg px-2.5 py-2 text-[12px] text-fg shadow-lg shadow-black/50">
      {title && <div className="mb-1 text-[11px] text-muted">{title}</div>}
      <div className="space-y-0.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-4">
            <span className="text-muted">{r.label}</span>
            <span className={`tabular-nums font-medium ${toneClass[r.tone ?? "fg"]}`}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function withPct(value: string, pct: number | null | undefined): string {
  if (pct == null) return value;
  return `${value} (${fmtRet(pct)})`;
}

/** Cumulative SOL equity with daily close P&L bars overlaid. */
export function EquityChart({
  data,
  exits,
}: {
  data: HistorySnap["equity"];
  exits?: HistorySnap["exits"];
}) {
  const chartData = useMemo(() => {
    const byDay = Object.fromEntries((exits ?? []).map((e) => [e.day, e]));
    return data.map((row) => {
      const ex = byDay[row.day];
      return {
        ...row,
        close_pnl: ex?.pnl ?? null,
        close_n: ex?.n ?? 0,
        close_pct: ex?.pct ?? null,
      };
    });
  }, [data, exits]);

  if (!data.length) return <Empty msg="No profit history yet" />;
  const last = data[data.length - 1]!;
  return (
    <div className="flex h-full min-h-[280px] flex-col">
      <div className="mb-1 flex shrink-0 flex-wrap gap-4 px-1 text-[12px]">
        <div>
          <span className="text-dim">Total SOL </span>
          <span className={last.cum_sol >= 0 ? "text-ok font-semibold" : "text-danger font-semibold"}>
            {fmtSol(last.cum_sol)}
          </span>
          {last.day_pct != null && (
            <span className={`ml-1 ${last.day_pct >= 0 ? "text-ok" : "text-danger"}`}>
              today {fmtRet(last.day_pct)}
            </span>
          )}
        </div>
        <div>
          <span className="text-dim">Total USD </span>
          <span className={last.cum_usd >= 0 ? "text-ok font-semibold" : "text-danger font-semibold"}>
            {fmtUsd(last.cum_usd)}
          </span>
        </div>
      </div>
      <div className="relative min-h-0 w-full flex-1" style={{ minHeight: 260 }}>
        <div className="absolute inset-0">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
              <defs>
                <linearGradient id="solFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#00FF85" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#00FF85" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...grid} />
              <XAxis dataKey="day" {...axis} tickFormatter={(d: string) => d.slice(5)} />
              <YAxis
                {...axis}
                width={56}
                tickFormatter={(v: number) => `${v.toFixed(2)}`}
                label={{ value: "SOL", angle: -90, position: "insideLeft", fill: "#6B6B6B", fontSize: 10 }}
              />
              <Tooltip
                cursor={{ stroke: "#6B6B6B", strokeDasharray: "3 3" }}
                content={({ active, label, payload }) => {
                  if (!active || !payload?.length) return null;
                  const row = payload[0]?.payload as {
                    cum_sol?: number; cum_usd?: number; close_pnl?: number | null;
                    close_n?: number; close_pct?: number | null;
                  };
                  const rows: TipRow[] = [
                    {
                      label: "Cum SOL",
                      value: fmtSol(row?.cum_sol),
                      tone: (row?.cum_sol ?? 0) >= 0 ? "ok" : "danger",
                    },
                  ];
                  if (row?.close_pnl != null) {
                    rows.push({
                      label: "Close P&L",
                      value: withPct(fmtSol(row.close_pnl), row.close_pct),
                      tone: row.close_pnl >= 0 ? "ok" : "danger",
                    });
                    if ((row.close_n ?? 0) > 0) {
                      rows.push({ label: "Closes", value: String(row.close_n), tone: "fg" });
                    }
                  }
                  rows.push({
                    label: "Cum USD",
                    value: fmtUsd(row?.cum_usd),
                    tone: (row?.cum_usd ?? 0) >= 0 ? "accent" : "danger",
                  });
                  return <ChartTip title={String(label)} rows={rows} />;
                }}
              />
              <Bar dataKey="close_pnl" name="Close P&L" barSize={10} radius={[2, 2, 0, 0]} fillOpacity={0.45}>
                {chartData.map((row, i) => (
                  <Cell
                    key={i}
                    fill={row.close_pnl == null ? "transparent" : row.close_pnl >= 0 ? "#00FF85" : "#FF4D6A"}
                  />
                ))}
              </Bar>
              <Area
                type="monotone"
                dataKey="cum_sol"
                name="Equity"
                stroke="#00FF85"
                fill="url(#solFill)"
                strokeWidth={2}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

/** Daily net PnL bars — green win / red loss. */
export function ExitsChart({ data }: { data: HistorySnap["exits"] }) {
  if (!data.length) return <Empty msg="No closes in this range" />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 12, right: 12, left: 4, bottom: 4 }}>
        <CartesianGrid {...grid} />
        <XAxis dataKey="day" {...axis} tickFormatter={(d: string) => d.slice(5)} />
        <YAxis {...axis} width={56} tickFormatter={(v: number) => `${v.toFixed(2)}`} />
        <Tooltip
          cursor={{ fill: "rgba(92,107,127,0.15)" }}
          content={({ active, label, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0]?.payload as { pnl?: number; n?: number; pct?: number | null };
            const pnl = row?.pnl ?? 0;
            const n = row?.n ?? 0;
            return (
              <ChartTip
                title={String(label)}
                rows={[
                  {
                    label: "Day PnL",
                    value: withPct(fmtSol(pnl), row?.pct),
                    tone: pnl >= 0 ? "ok" : "danger",
                  },
                  {
                    label: "Closes",
                    value: String(n),
                    tone: "fg",
                  },
                ]}
              />
            );
          }}
        />
        <Bar dataKey="pnl" name="Day PnL" radius={[2, 2, 0, 0]}>
          {data.map((row, i) => (
            <Cell key={i} fill={(row.pnl as number) >= 0 ? "#00FF85" : "#FF4D6A"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Open-book proxy: daily unrealized from pnl_daily. */
export function CapitalChart({
  data,
}: {
  data: NonNullable<HistorySnap["stats"]>["capital_series"];
}) {
  if (!data.length) return <Empty msg="No capital series yet" />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 12, right: 12, left: 4, bottom: 4 }}>
        <CartesianGrid {...grid} />
        <XAxis dataKey="day" {...axis} tickFormatter={(d: string) => d.slice(5)} />
        <YAxis {...axis} width={56} tickFormatter={(v: number) => `${v.toFixed(1)}`} />
        <Tooltip
          cursor={{ stroke: "#6B6B6B", strokeDasharray: "3 3" }}
          content={({ active, label, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0]?.payload as {
              unrealized_sol?: number; fees_sol?: number; realized_sol?: number;
            };
            return (
              <ChartTip
                title={String(label)}
                rows={[
                  { label: "Unrealized", value: fmtSol(row?.unrealized_sol), tone: "accent" },
                  { label: "Day fees", value: fmtSol(row?.fees_sol), tone: "ok" },
                  { label: "Day realized", value: fmtSol(row?.realized_sol), tone: (row?.realized_sol ?? 0) >= 0 ? "ok" : "danger" },
                ]}
              />
            );
          }}
        />
        <Area
          type="monotone"
          dataKey="unrealized_sol"
          name="Unrealized"
          stroke="#1E90FF"
          fill="rgba(30,144,255,0.15)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Daily entered / skipped / open-failed. */
export function FunnelChart({
  data,
}: {
  data: HistorySnap["activity"];
}) {
  if (!data.length) return <Empty msg="No funnel activity in range" />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 12, right: 12, left: 4, bottom: 4 }}>
        <CartesianGrid {...grid} />
        <XAxis dataKey="day" {...axis} tickFormatter={(d: string) => d.slice(5)} />
        <YAxis {...axis} width={40} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: "rgba(92,107,127,0.15)" }}
          content={({ active, label, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0]?.payload as {
              entered?: number; skipped?: number; open_failed?: number;
            };
            return (
              <ChartTip
                title={String(label)}
                rows={[
                  { label: "Entered", value: String(row?.entered ?? 0), tone: "ok" },
                  { label: "Skipped", value: String(row?.skipped ?? 0), tone: "fg" },
                  { label: "Open fail", value: String(row?.open_failed ?? 0), tone: "danger" },
                ]}
              />
            );
          }}
        />
        <Bar dataKey="entered" name="Entered" stackId="a" fill="#00FF85" />
        <Bar dataKey="skipped" name="Skipped" stackId="a" fill="#6B6B6B" />
        <Bar dataKey="open_failed" name="Open fail" stackId="a" fill="#FF4D6A" />
      </BarChart>
    </ResponsiveContainer>
  );
}
