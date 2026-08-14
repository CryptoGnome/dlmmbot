import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

export function Spinner({
  size = 16,
  className,
  label = "Loading",
}: {
  size?: number;
  className?: string;
  /** Accessible name for screen readers */
  label?: string;
}) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn("inline-flex shrink-0 text-accent", className)}
    >
      <Loader2 size={size} strokeWidth={1.75} className="animate-spin" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Page / panel placeholder while async data loads. Reuse anywhere. */
export function LoadingState({
  label = "Loading…",
  className,
  compact = false,
  steps,
  elapsedSec,
}: {
  label?: string;
  className?: string;
  /** Smaller inline block (panels) vs page-sized */
  compact?: boolean;
  /** Live progress lines (newest last) — proves the page is not stuck */
  steps?: string[];
  /** Optional elapsed seconds shown next to the label */
  elapsedSec?: number;
}) {
  const recent = steps?.length ? steps.slice(-8) : null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex flex-col items-center justify-center gap-2.5 text-dim",
        compact ? "min-h-[5rem] py-5" : "min-h-[12rem] border border-grid bg-panel py-12",
        className,
      )}
    >
      <Spinner size={compact ? 18 : 24} label={label} />
      <span className="text-[11px] tracking-[0.14em] uppercase">
        {label}
        {elapsedSec != null && elapsedSec > 0 ? (
          <span className="ml-2 tabular-nums tracking-normal text-muted normal-case">
            {elapsedSec}s
          </span>
        ) : null}
      </span>
      {recent && recent.length > 0 && (
        <div className="mt-1 w-full max-w-md border border-grid/80 bg-bg/40 px-3 py-2 text-left">
          <div className="mb-1 text-[9px] tracking-[0.16em] text-muted uppercase">Status</div>
          <ul className="max-h-36 space-y-0.5 overflow-y-auto font-mono text-[10px] leading-snug text-dim">
            {recent.map((line, i) => (
              <li
                key={`${i}-${line.slice(0, 24)}`}
                className={i === recent.length - 1 ? "text-fg" : undefined}
              >
                <span className="text-muted">›</span> {line}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Panel({
  title, children, className, right, bodyClassName,
}: {
  title?: string; children: ReactNode; className?: string; right?: ReactNode; bodyClassName?: string;
}) {
  return (
    <section className={cn("panel flex flex-col", className)}>
      {title && (
        <header className="flex shrink-0 items-center justify-between border-b border-grid px-3 py-1.5">
          <h2 className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">
            {title}
          </h2>
          {right}
        </header>
      )}
      <div className={cn("min-h-0 flex-1 p-3", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Kpi({
  label, value, sub, tone = "fg", pct,
}: {
  label: string; value: string; sub?: string;
  tone?: "fg" | "accent" | "warn" | "danger" | "ok" | "muted";
  pct?: number | null;
}) {
  const toneClass = {
    fg: "text-fg",
    accent: "text-accent",
    warn: "text-warn",
    danger: "text-danger",
    ok: "text-ok",
    muted: "text-muted",
  }[tone];
  const pctTone = pct == null ? "text-dim" : pct >= 0 ? "text-ok" : "text-danger";
  return (
    <div className="panel px-3 py-2.5">
      <div className="text-[10px] tracking-[0.16em] text-dim uppercase">{label}</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-2">
        <span className={cn("text-xl font-semibold tabular-nums leading-none", toneClass)}>{value}</span>
        {pct != null && (
          <span className={cn("text-sm font-semibold tabular-nums", pctTone)}>
            {pct > 0 ? "+" : ""}{(pct * 100).toFixed(1)}%
          </span>
        )}
      </div>
      {sub && <div className="mt-1 text-[10px] leading-snug text-dim">{sub}</div>}
    </div>
  );
}

export function Badge({
  children, tone = "fg", title,
}: {
  children: ReactNode; tone?: "fg" | "accent" | "warn" | "danger" | "ok"; title?: string;
}) {
  const border = {
    fg: "border-fg text-fg",
    accent: "border-accent text-accent",
    warn: "border-warn text-warn",
    danger: "border-danger text-danger",
    ok: "border-ok text-ok",
  }[tone];
  return (
    <span title={title} className={cn("inline-flex items-center justify-center border px-1.5 py-0.5 text-[10px] tracking-wider uppercase", border)}>
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
            value === o ? "bg-ok text-bg" : "text-muted hover:text-hover",
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}
