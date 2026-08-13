import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { HistorySnap } from "@/lib/types";

const EXIT_COLORS: Record<string, string> = {
  P0_safety: "#e06c75",
  P1_stop: "#f07178",
  P2_rotation: "#e0a84a",
  P3_above: "#3ecf8e",
  P5_below: "#d4a574",
  escape: "#a78bfa",
  manual: "#9aa8bc",
};

const SKIP_COLORS = ["#5b9fd4", "#2dd4bf", "#a78bfa", "#e0a84a", "#e06c75", "#3ecf8e", "#9aa8bc"];

const axis = { stroke: "#5c6b7f", fontSize: 10, tick: { fill: "#5c6b7f" } };
const grid = { stroke: "#1e2633", strokeDasharray: "3 5" };
const tip = {
  background: "#12171f",
  border: "1px solid #1e2633",
  borderRadius: 2,
  fontFamily: "JetBrains Mono",
  fontSize: 11,
  color: "#e8edf5",
};

function Empty({ msg }: { msg: string }) {
  return (
    <div className="flex h-full min-h-[140px] items-center justify-center text-[11px] tracking-wider text-dim">
      {msg}
    </div>
  );
}

export function EquityChart({ data }: { data: HistorySnap["equity"] }) {
  if (!data.length) return <Empty msg="NO SERIES // awaiting pnl_daily" />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 12, right: 12, left: 4, bottom: 4 }}>
        <defs>
          <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3ecf8e" stopOpacity={0.28} />
            <stop offset="100%" stopColor="#3ecf8e" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid {...grid} />
        <XAxis dataKey="day" {...axis} tickFormatter={(d: string) => d.slice(5)} />
        <YAxis {...axis} width={52} tickFormatter={(v: number) => v.toFixed(2)} />
        <Tooltip contentStyle={tip} labelStyle={{ color: "#9aa8bc" }} />
        <Area type="monotone" dataKey="cum_realized" name="cum realized" stroke="#3ecf8e" fill="url(#eqFill)" strokeWidth={2} />
        <Line type="monotone" dataKey="cum_fees" name="cum fees" stroke="#2dd4bf" strokeWidth={1.5} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function ExitsChart({ data, reasons }: { data: HistorySnap["exits"]; reasons: string[] }) {
  if (!data.length) return <Empty msg="NO SERIES // no exits in range" />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 12, right: 12, left: 4, bottom: 4 }}>
        <CartesianGrid {...grid} />
        <XAxis dataKey="day" {...axis} tickFormatter={(d: string) => d.slice(5)} />
        <YAxis {...axis} width={52} tickFormatter={(v: number) => v.toFixed(2)} />
        <Tooltip contentStyle={tip} />
        <Legend wrapperStyle={{ fontSize: 10, color: "#9aa8bc" }} />
        {reasons.map((r) => (
          <Bar key={r} dataKey={r} stackId="pnl" fill={EXIT_COLORS[r] ?? "#9aa8bc"} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function SkipChart({ data, gates }: { data: HistorySnap["skip_series"]; gates: string[] }) {
  if (!data.length || !gates.length) return <Empty msg="NO SERIES // no skips in range" />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid {...grid} />
        <XAxis dataKey="day" {...axis} tickFormatter={(d: string) => d.slice(5)} />
        <YAxis {...axis} width={40} />
        <Tooltip contentStyle={tip} />
        <Legend wrapperStyle={{ fontSize: 10, color: "#9aa8bc" }} />
        {gates.slice(0, 5).map((g, i) => (
          <Line key={g} type="monotone" dataKey={g} stroke={SKIP_COLORS[i]!} strokeWidth={1.5} dot={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
