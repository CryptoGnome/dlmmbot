import { Badge } from "@/components/ui";
import { TokenSymbol } from "@/components/TokenSymbol";
import { cn, shortTime } from "@/lib/utils";
import type { FeedItem } from "@/lib/activityFeed";
import { Icon, eventGateIcon, feedKindIcon } from "@/lib/icons";

const kindTone = {
  entry: "ok",
  exit: "ok",
  fail: "danger",
  skip: "warn",
  event: "accent",
  cluster: "warn",
} as const;

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
        return (
          <li
            key={`${it.at}-${it.kind}-${it.symbol}-${i}`}
            className={cn(
              "flex gap-3 border-t border-grid first:border-0",
              dense ? "py-1.5" : "py-2",
            )}
          >
            <span className="w-16 shrink-0 text-[10px] text-dim tabular-nums">{shortTime(it.at)}</span>
            <div className={cn(
              "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border",
              it.tone === "ok" ? "border-ok/50 text-ok"
                : it.tone === "danger" ? "border-danger/50 text-danger"
                  : it.tone === "warn" ? "border-warn/50 text-warn"
                    : it.tone === "accent" ? "border-accent/50 text-accent"
                      : "border-grid text-muted",
            )}>
              <Icon icon={KindIcon} size={dense ? 11 : 12} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {it.symbol && it.symbol !== "?" ? (
                  <TokenSymbol symbol={it.symbol} mint={it.mint} />
                ) : null}
                <span className={cn(
                  dense ? "text-[12px]" : "text-[13px]",
                  it.tone === "ok" ? "text-ok"
                    : it.tone === "danger" ? "text-danger"
                      : it.tone === "warn" ? "text-warn"
                        : it.tone === "accent" ? "text-accent"
                          : "text-fg",
                )}>
                  {it.label}
                </span>
              </div>
              {it.detail && (
                <div className="truncate text-[11px] text-muted">{it.detail}</div>
              )}
            </div>
            <Badge tone={kindTone[it.kind] ?? "ok"} title={it.kind}>
              <Icon icon={feedKindIcon[it.kind]} size={11} />
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}
