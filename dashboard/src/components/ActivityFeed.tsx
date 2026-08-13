import { TokenSymbol } from "@/components/TokenSymbol";
import { cn, fmtSol, shortTime } from "@/lib/utils";
import type { FeedItem } from "@/lib/activityFeed";
import { Icon, eventGateIcon, feedKindIcon } from "@/lib/icons";

function toneClass(tone: FeedItem["tone"]) {
  return tone === "ok" ? "text-ok"
    : tone === "danger" ? "text-danger"
      : tone === "warn" ? "text-warn"
        : tone === "accent" ? "text-accent"
          : "text-muted";
}

function solClass(n: number) {
  return n > 0 ? "text-ok" : n < 0 ? "text-danger" : "text-muted";
}

export function ActivityFeedList({
  items,
  empty = "No recent activity",
  dense = false,
}: {
  items: FeedItem[];
  empty?: string;
  dense?: boolean;
}) {
  if (!items.length) {
    return (
      <div className={cn(
        "flex items-center justify-center text-[12px] text-dim",
        dense ? "min-h-[72px]" : "min-h-[140px]",
      )}>
        {empty}
      </div>
    );
  }

  return (
    <ul className="space-y-0">
      {items.map((it, i) => {
        const KindIcon = it.kind === "event" && it.gate
          ? eventGateIcon(it.gate)
          : feedKindIcon[it.kind];
        const tone = toneClass(it.tone);
        const sz = dense ? 11 : 12;
        const sol = it.sol;
        return (
          <li
            key={`${it.at}-${it.kind}-${it.symbol}-${i}`}
            className={cn(
              "flex items-start gap-3 border-t border-grid first:border-0",
              dense ? "py-1.5" : "py-2",
            )}
          >
            <span className="w-16 shrink-0 text-[10px] text-dim tabular-nums">{shortTime(it.at)}</span>
            <span className={cn("mt-0.5 shrink-0", tone)} title={it.kind}>
              <Icon icon={KindIcon} size={sz} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {(it.symbol && it.symbol !== "?") || it.mint ? (
                  <TokenSymbol
                    symbol={it.symbol && it.symbol !== "?" ? it.symbol : (it.mint?.slice(0, 6) ?? "?")}
                    mint={it.mint}
                  />
                ) : null}
                <span className={cn(dense ? "text-[12px]" : "text-[13px]", tone === "text-muted" ? "text-fg" : tone)}>
                  {it.label}
                </span>
              </div>
              {it.detail && (
                <div className="truncate text-[11px] text-muted">{it.detail}</div>
              )}
            </div>
            {sol != null && (
              <span
                className={cn(
                  "mt-0.5 shrink-0 tabular-nums font-medium",
                  dense ? "text-[11px]" : "text-[12px]",
                  solClass(sol),
                )}
                title="SOL flow (+in / −out) or exit PnL"
              >
                {fmtSol(sol, 3)}
              </span>
            )}
            <span className={cn("mt-0.5 shrink-0", tone)} title={it.kind}>
              <Icon icon={feedKindIcon[it.kind]} size={sz} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
