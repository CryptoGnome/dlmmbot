import { SquareArrowOutUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import { gmgnUrl } from "@/lib/format";
import { lookupTokenMeta, rememberTokenMeta } from "@/lib/tokenMetaCache";
import { cn } from "@/lib/utils";

/** Symbol (+ optional Jupiter icon) with green GMGN link. */
export function TokenSymbol({
  symbol, mint, name, iconUrl, className,
}: {
  symbol?: string | null;
  mint?: string | null;
  name?: string | null;
  iconUrl?: string | null;
  className?: string;
}) {
  const cached = mint ? lookupTokenMeta(mint) : null;
  const icon = iconUrl || cached?.icon_url || null;
  const tip = name || cached?.name || null;
  const label = symbol || cached?.symbol || (mint ? mint.slice(0, 6) : "?");
  const url = gmgnUrl(mint);
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
    if (mint && (iconUrl || name || symbol)) {
      rememberTokenMeta({
        mint,
        symbol: symbol ?? null,
        name: name ?? null,
        icon_url: iconUrl ?? null,
      });
    }
  }, [mint, iconUrl, name, symbol]);

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} title={tip || undefined}>
      {icon && !imgFailed ? (
        <img
          src={icon}
          alt=""
          width={16}
          height={16}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-4 w-4 shrink-0 rounded-sm bg-panel object-cover"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-grid bg-panel text-[8px] font-semibold text-dim"
          aria-hidden
        >
          {(label || "?").slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="font-semibold text-fg">{label}</span>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={tip ? `${tip} on GMGN` : "Open on GMGN"}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center border border-ok/70 text-ok hover:bg-ok/15"
          onClick={(e) => e.stopPropagation()}
        >
          <SquareArrowOutUpRight className="h-2.5 w-2.5" strokeWidth={2.5} />
        </a>
      )}
    </span>
  );
}
