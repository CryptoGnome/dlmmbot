import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { HistorySnap } from "@/lib/types";

const EXIT_COLORS: Record<string, string> = {
  P0_safety: "#ff2d55",
  P1_stop: "#ff2d55",
  P2_rotation: "#ffb020",
  P3_above: "#00c853",
  P5_below: "#ffb020",
  escape: "#00e5ff",
  manual: "#7cff9a",
};

const SKIP_COLORS = ["#39ff14", "#00e5ff", "#ffb020", "#ff2d55", "#00c853", "#7cff9a", "#3d6b4a", "#ffffff"];

const axis = { stroke: "#3d6b4a", fontSize: 10, tick: { fill: "#3d6b4a" } };
const grid = { stroke: "#1a2e22", strokeDasharray: "2 4" };

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
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#39ff14" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#39ff14" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid {...grid} />
        <XAxis dataKey="day" {...axis} tickFormatter={(d: string) => d.slice(5)} />
        <YAxis {...axis} width={48} tickFormatter={(v: number) => v.toFixed(2)} />
        <Tooltip
          contentStyle={{ background: "#0c1410", border: "1px solid #39ff14", borderRadius: 0, fontFamily: "JetBrains Mono", fontSize: 11 }}
          labelStyle={{ color: "#7cff9a" }}
        />
        <Area type="monotone" dataKey="cum_realized" name="cum realized" stroke="#39ff14" fill="url(#eqFill)" strokeWidth={1.5} />
        <Line type="monotone" dataKey="cum_fees" name="cum fees" stroke="#00e5ff" strokeWidth={1} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function ExitsChart({ data, reasons }: { data: HistorySnap["exits"]; reasons: string[] }) {
  if (!data.length) return <Empty msg="NO SERIES // no exits in range" />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid {...grid} />
        <XAxis dataKey="day" {...axis} tickFormatter={(d: string) => d.slice(5)} />
        <YAxis {...axis} width={48} tickFormatter={(v: number) => v.toFixed(2)} />
        <Tooltip
          contentStyle={{ background: "#0c1410", border: "1px solid #00e5ff", borderRadius: 0, fontFamily: "JetBrains Mono", fontSize: 11 }}
        />
        <Legend wrapperStyle={{ fontSize: 10, color: "#7cff9a" }} />
        {reasons.map((r) => (
          <Bar key={r} dataKey={r} stackId="pnl" fill={EXIT_COLORS[r] ?? "#7cff9a"} />
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
        <Tooltip
          contentStyle={{ background: "#0c1410", border: "1px solid #39ff14", borderRadius: 0, fontFamily: "JetBrains Mono", fontSize: 11 }}
        />
        <Legend wrapperStyle={{ fontSize: 10, color: "#7cff9a" }} />
        {gates.slice(0, 5).map((g, i) => (
          <Line key={g} type="monotone" dataKey={g} stroke={SKIP_COLORS[i]!} strokeWidth={1.2} dot={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
