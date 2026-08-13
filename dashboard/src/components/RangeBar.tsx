import { gmgnUrl } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SquareArrowOutUpRight } from "lucide-react";
import { rangeStatusIcon } from "@/lib/icons";

const SUB = "₀₁₂₃₄₅₆₇₈₉";

/** Compact meme price: 0.00000713 → 0.0₅713 */
export function fmtTinyPrice(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p) || p <= 0) return "—";
  if (p >= 1) return p.toFixed(3);
  if (p >= 0.01) return p.toFixed(4);
  const fixed = p.toFixed(18);
  const m = /^0\.(0+)([1-9]\d{0,2})/.exec(fixed);
  if (!m) return p.toExponential(2);
  const zeros = m[1].length;
  const digits = m[2];
  const z = String(zeros).split("").map((d) => SUB[Number(d)] ?? d).join("");
  return `0.0${z}${digits}`;
}

export type RangeStatus = "in" | "above" | "below" | "out" | "unknown";

export function RangeBar({
  minBin, maxBin, activeBin, status, minPrice, maxPrice, className,
}: {
  minBin: number; maxBin: number; activeBin: number | null;
  status: RangeStatus;
  minPrice?: number | null; maxPrice?: number | null;
  className?: string;
}) {
  const pad = Math.max(8, Math.ceil((maxBin - minBin + 1) * 0.2));
  let lo = minBin - pad;
  let hi = maxBin + pad;
  if (activeBin != null) {
    if (activeBin < lo) lo = activeBin - pad;
    if (activeBin > hi) hi = activeBin + pad;
  }
  const span = Math.max(hi - lo, 1);
  const left = ((minBin - lo) / span) * 100;
  const width = ((maxBin - minBin) / span) * 100;
  const priceX = activeBin != null ? ((activeBin - lo) / span) * 100 : null;
  const out = status === "above" || status === "below" || status === "out";

  return (
    <div className={cn("min-w-[140px]", className)}>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] tabular-nums">
        <span className="text-fg">{fmtTinyPrice(minPrice)} – {fmtTinyPrice(maxPrice)}</span>
        {out && <span className="text-warn" title={status === "above" ? "Above range" : "Below range"}>▲</span>}
      </div>
      <div className="relative h-2 w-full rounded-sm bg-grid">
        <div
          className="absolute top-0 h-full rounded-sm bg-accent/70"
          style={{ left: `${left}%`, width: `${Math.max(width, 1.5)}%` }}
        />
        {priceX != null && (
          <div
            className={cn(
              "absolute top-[-2px] h-3 w-0.5 -translate-x-1/2",
              out ? "bg-warn" : "bg-ok",
            )}
            style={{ left: `${Math.min(100, Math.max(0, priceX))}%` }}
            title={`bin ${activeBin}`}
          />
        )}
      </div>
      <div className="mt-0.5 text-[10px] text-dim">
        {status === "above" ? "price above range" : status === "below" ? "price below range" : status === "in" ? "in range" : "—"}
      </div>
    </div>
  );
}

export function StatusBadge({ status }: { status: RangeStatus }) {
  const IconCmp = rangeStatusIcon[status] ?? rangeStatusIcon.unknown;
  if (status === "in") {
    return (
      <span className="inline-flex items-center gap-1 border border-ok px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-ok">
        <IconCmp size={10} strokeWidth={1.75} aria-hidden />in
      </span>
    );
  }
  if (status === "above") {
    return (
      <span className="inline-flex items-center gap-1 border border-warn px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-warn">
        <IconCmp size={10} strokeWidth={1.75} aria-hidden />above
      </span>
    );
  }
  if (status === "below") {
    return (
      <span className="inline-flex items-center gap-1 border border-danger px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-danger">
        <IconCmp size={10} strokeWidth={1.75} aria-hidden />below
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 border border-dim px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-dim">
      <IconCmp size={10} strokeWidth={1.75} aria-hidden />—
    </span>
  );
}

export function GmgnLink({ mint }: { mint?: string | null }) {
  const url = gmgnUrl(mint);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-4 w-4 items-center justify-center border border-ok/70 text-ok hover:bg-ok/15"
      title="Open on GMGN"
    >
      <SquareArrowOutUpRight className="h-2.5 w-2.5" strokeWidth={2.5} />
    </a>
  );
}
