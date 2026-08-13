import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { HistorySnap } from "@/lib/types";
import { fmtRet, fmtSol, fmtUsd } from "@/lib/format";

const axis = { stroke: "#5c6b7f", fontSize: 11, tick: { fill: "#5c6b7f" } };
const grid = { stroke: "#1e2633", strokeDasharray: "3 5" };

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

/** Cumulative profit only — SOL (left) and USD (right). */
export function EquityChart({ data }: { data: HistorySnap["equity"] }) {
  if (!data.length) return <Empty msg="No profit history yet" />;
  const last = data[data.length - 1]!;
  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 flex flex-wrap gap-4 px-1 text-[12px]">
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
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 48, left: 4, bottom: 4 }}>
            <defs>
              <linearGradient id="solFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3ecf8e" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#3ecf8e" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid {...grid} />
            <XAxis dataKey="day" {...axis} tickFormatter={(d: string) => d.slice(5)} />
            <YAxis
              yAxisId="sol"
              {...axis}
              width={56}
              tickFormatter={(v: number) => `${v.toFixed(2)}`}
              label={{ value: "SOL", angle: -90, position: "insideLeft", fill: "#5c6b7f", fontSize: 10 }}
            />
            <YAxis
              yAxisId="usd"
              orientation="right"
              {...axis}
              width={52}
              tickFormatter={(v: number) => `$${v.toFixed(0)}`}
              label={{ value: "USD", angle: 90, position: "insideRight", fill: "#5c6b7f", fontSize: 10 }}
            />
            <Tooltip
              cursor={{ stroke: "#5c6b7f", strokeDasharray: "3 3" }}
              content={({ active, label, payload }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0]?.payload as {
                  cum_sol?: number; cum_usd?: number; sol?: number; usd?: number; day_pct?: number | null;
                };
                const pct = row?.day_pct;
                return (
                  <ChartTip
                    title={String(label)}
                    rows={[
                      {
                        label: "Cum SOL",
                        value: fmtSol(row?.cum_sol),
                        tone: (row?.cum_sol ?? 0) >= 0 ? "ok" : "danger",
                      },
                      {
                        label: "Cum USD",
                        value: fmtUsd(row?.cum_usd),
                        tone: (row?.cum_usd ?? 0) >= 0 ? "accent" : "danger",
                      },
                      {
                        label: "Day",
                        value: withPct(fmtSol(row?.sol), pct),
                        tone: (row?.sol ?? 0) >= 0 ? "ok" : "danger",
                      },
                    ]}
                  />
                );
              }}
            />
            <Area
              yAxisId="sol"
              type="monotone"
              dataKey="cum_sol"
              name="SOL"
              stroke="#3ecf8e"
              fill="url(#solFill)"
              strokeWidth={2}
            />
            <Area
              yAxisId="usd"
              type="monotone"
              dataKey="cum_usd"
              name="USD"
              stroke="#5b9fd4"
              fill="transparent"
              strokeWidth={2}
              strokeDasharray="4 3"
            />
          </AreaChart>
        </ResponsiveContainer>
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
            <Cell key={i} fill={(row.pnl as number) >= 0 ? "#3ecf8e" : "#e06c75"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
