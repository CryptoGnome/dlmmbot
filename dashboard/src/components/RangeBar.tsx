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

/**
 * Split the LP range into SOL (still waiting) vs token (already converted).
 * For SOL-quoted DLMM: bins below the active price hold Y/SOL; bins the
 * price has already crossed hold X/token. BidAsk-under starts all-SOL and
 * fills token-side as price walks down the range.
 */
export function rangeComposition(
  minBin: number,
  maxBin: number,
  activeBin: number | null,
): { solFrac: number; tokenFrac: number } {
  const span = Math.max(maxBin - minBin, 0);
  if (span <= 0) return { solFrac: 1, tokenFrac: 0 };
  if (activeBin == null) return { solFrac: 1, tokenFrac: 0 };
  if (activeBin > maxBin) return { solFrac: 1, tokenFrac: 0 };
  if (activeBin < minBin) return { solFrac: 0, tokenFrac: 1 };
  const solFrac = (activeBin - minBin) / span;
  return { solFrac, tokenFrac: 1 - solFrac };
}

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
  const { solFrac, tokenFrac } = rangeComposition(minBin, maxBin, activeBin);
  const solPct = Math.max(0, Math.min(100, solFrac * 100));
  const tokPct = Math.max(0, Math.min(100, tokenFrac * 100));

  return (
    <div className={cn("min-w-[140px]", className)}>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] tabular-nums">
        <span className="text-fg">{fmtTinyPrice(minPrice)} – {fmtTinyPrice(maxPrice)}</span>
        {out && <span className="text-warn" title={status === "above" ? "Above range" : "Below range"}>▲</span>}
      </div>
      <div className="relative h-2 w-full rounded-sm bg-grid">
        <div
          className="absolute top-0 h-full overflow-hidden rounded-sm"
          style={{ left: `${left}%`, width: `${Math.max(width, 1.5)}%` }}
          title={`≈${Math.round(solPct)}% SOL · ≈${Math.round(tokPct)}% token (by bin side of price)`}
        >
          {solPct > 0.5 && (
            <div
              className="absolute top-0 left-0 h-full bg-sol/80"
              style={{ width: `${solPct}%` }}
            />
          )}
          {tokPct > 0.5 && (
            <div
              className="absolute top-0 h-full bg-accent/80"
              style={{ left: `${solPct}%`, width: `${tokPct}%` }}
            />
          )}
        </div>
        {priceX != null && (
          <div
            className={cn(
              "absolute top-[-2px] z-[1] h-3 w-0.5 -translate-x-1/2",
              out ? "bg-warn" : "bg-ok",
            )}
            style={{ left: `${Math.min(100, Math.max(0, priceX))}%` }}
            title={`bin ${activeBin}`}
          />
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-dim">
        <span>
          {status === "above" ? "price above range" : status === "below" ? "price below range" : status === "in" ? "in range" : "—"}
        </span>
        <span className="inline-flex items-center gap-1.5" title="Bins left of price ≈ SOL still waiting; bins right ≈ already converted to token">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 bg-sol/80" />SOL
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 bg-accent/80" />token
          </span>
        </span>
      </div>
    </div>
  );
}

export function StatusBadge({ status }: { status: RangeStatus }) {
  const IconCmp = rangeStatusIcon[status] ?? rangeStatusIcon.unknown;
  if (status === "in") {
    return (
      <span
        className="inline-flex items-center gap-1 border border-ok px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-ok"
        title="Pool price is inside your LP range — earning fees"
      >
        <IconCmp size={10} strokeWidth={1.75} aria-hidden />in range
      </span>
    );
  }
  if (status === "above") {
    return (
      <span
        className="inline-flex items-center gap-1 border border-warn px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-warn"
        title="Pool price moved above your range — not earning until it comes back"
      >
        <IconCmp size={10} strokeWidth={1.75} aria-hidden />above range
      </span>
    );
  }
  if (status === "below") {
    return (
      <span
        className="inline-flex items-center gap-1 border border-danger px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-danger"
        title="Pool price moved below your range — waiting on exit rules"
      >
        <IconCmp size={10} strokeWidth={1.75} aria-hidden />below range
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 border border-dim px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-dim"
      title="Range status unknown"
    >
      <IconCmp size={10} strokeWidth={1.75} aria-hidden />—
    </span>
  );
}

/** Position sleeve: meme / micro / majors (+ follow overlay). */
export function SleeveBadge({
  sleeve,
  follow,
}: {
  sleeve?: string | null;
  follow?: boolean;
}) {
  const s = (sleeve ?? "meme").toLowerCase();
  const kind = s === "majors" || s === "micro" || s === "meme" ? s : "meme";
  const tip =
    kind === "majors" ? "Majors sleeve — SOL-quoted large-cap parking"
      : kind === "micro" ? "Micro sleeve — smaller mcap band, tighter size caps"
        : "Meme sleeve — default hot-pool entries";
  const cls =
    kind === "majors" ? "border-ok/70 text-ok"
      : kind === "micro" ? "border-warn/70 text-warn"
        : "border-accent/70 text-accent";

  return (
    <>
      <span
        className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${cls}`}
        title={tip}
      >
        {kind}
      </span>
      {follow && (
        <span
          className="inline-flex items-center gap-1 border border-hover/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-hover"
          title="Follow-chain leg — re-entry after an up-and-out"
        >
          follow
        </span>
      )}
    </>
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
