import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function Panel({
  title, children, className, right,
}: {
  title?: string; children: ReactNode; className?: string; right?: ReactNode;
}) {
  return (
    <section className={cn("panel flex flex-col", className)}>
      {title && (
        <header className="flex items-center justify-between border-b border-grid px-3 py-1.5">
          <h2 className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
            {title}
          </h2>
          {right}
        </header>
      )}
      <div className="flex-1 p-3">{children}</div>
    </section>
  );
}

export function Kpi({
  label, value, sub, tone = "fg",
}: {
  label: string; value: string; sub?: string; tone?: "fg" | "accent" | "warn" | "danger" | "ok" | "muted";
}) {
  const toneClass = {
    fg: "text-fg",
    accent: "text-accent",
    warn: "text-warn",
    danger: "text-danger",
    ok: "text-ok",
    muted: "text-muted",
  }[tone];
  return (
    <div className="panel px-3 py-2.5">
      <div className="text-[10px] tracking-[0.16em] text-dim uppercase">{label}</div>
      <div className={cn("mt-1 text-xl font-semibold tabular-nums", toneClass)}>{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-dim">{sub}</div>}
    </div>
  );
}

export function Badge({
  children, tone = "fg",
}: {
  children: ReactNode; tone?: "fg" | "accent" | "warn" | "danger" | "ok";
}) {
  const border = {
    fg: "border-fg text-fg",
    accent: "border-accent text-accent",
    warn: "border-warn text-warn",
    danger: "border-danger text-danger",
    ok: "border-ok text-ok",
  }[tone];
  return (
    <span className={cn("inline-flex border px-1.5 py-0.5 text-[10px] tracking-wider uppercase", border)}>
      {children}
    </span>
  );
}

export function RangeTabs({
  value, onChange,
}: {
  value: string; onChange: (v: "7d" | "30d" | "all") => void;
}) {
  const opts = ["7d", "30d", "all"] as const;
  return (
    <div className="flex gap-0 border border-grid">
      {opts.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className={cn(
            "px-2.5 py-1 text-[10px] tracking-wider uppercase transition-colors",
            value === o ? "bg-accent text-bg" : "text-muted hover:text-fg",
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}
