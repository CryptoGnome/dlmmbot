import { SquareArrowOutUpRight } from "lucide-react";
import { gmgnUrl } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Symbol + green external-link box → GMGN chart. */
export function TokenSymbol({
  symbol, mint, className,
}: {
  symbol?: string | null; mint?: string | null; className?: string;
}) {
  const url = gmgnUrl(mint);
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className="font-semibold text-fg">{symbol || "?"}</span>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title="Open on GMGN"
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center border border-ok/70 text-ok hover:bg-ok/15"
          onClick={(e) => e.stopPropagation()}
        >
          <SquareArrowOutUpRight className="h-2.5 w-2.5" strokeWidth={2.5} />
        </a>
      )}
    </span>
  );
}
