import { useEffect, useState } from "react";
import { Clock, ExternalLink } from "lucide-react";
import { TokenSymbol } from "@/components/TokenSymbol";
import { cn, fmtSol, shortTime, timeAgo } from "@/lib/utils";
import type { FeedItem } from "@/lib/activityFeed";
import { Icon, eventGateIcon, feedKindIcon } from "@/lib/icons";

const SOLSCAN_TX = "https://solscan.io/tx/";

function toneClass(tone: FeedItem["tone"]) {
  return tone === "ok" ? "text-ok"
    : tone === "danger" ? "text-danger"
      : tone === "warn" ? "text-warn"
        : tone === "accent" ? "text-accent"
          : "text-muted";
}

function solClass(n: number, kind: FeedItem["kind"]) {
  if (n > 0) return "text-ok";
  if (n === 0) return "text-muted";
  // Red only for realized losses. Entries / claims / other outflows are capital moving — blue.
  if (kind === "exit") return "text-danger";
  return "text-accent";
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
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

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

  const now = Date.now();

  return (
    <ul className="space-y-0">
      {items.map((it, i) => {
        const KindIcon = it.kind === "event" && it.gate
          ? eventGateIcon(it.gate)
          : feedKindIcon[it.kind];
        const tone = toneClass(it.tone);
        const sz = dense ? 11 : 12;
        const sol = it.sol;
        const txHref = it.txSig ? `${SOLSCAN_TX}${it.txSig}` : null;
        return (
          <li
            key={`${it.at}-${it.kind}-${it.symbol}-${i}`}
            className={cn(
              "flex items-start gap-3 border-t border-grid first:border-0",
              dense ? "py-1.5" : "py-2",
            )}
          >
            <span
              className={cn(
                "shrink-0 text-[10px] text-dim leading-tight",
                dense ? "w-[6.5rem]" : "w-[7.25rem]",
              )}
              title={it.at}
            >
              <span className="block tabular-nums">{shortTime(it.at)}</span>
              <span className="mt-0.5 flex items-center gap-0.5 text-dim/90">
                <Icon icon={Clock} size={9} className="opacity-70" />
                <span className={dense ? "truncate" : undefined}>{timeAgo(it.at, now)}</span>
              </span>
            </span>
            <span className={cn("mt-0.5 shrink-0", tone)} title={it.kind}>
              <Icon icon={KindIcon} size={sz} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {(it.symbol && it.symbol !== "?") || it.mint ? (
                  <TokenSymbol
                    symbol={it.symbol && it.symbol !== "?" ? it.symbol : (it.mint?.slice(0, 6) ?? "?")}
                    mint={it.mint}
                    name={it.name}
                    iconUrl={it.icon_url}
                  />
                ) : null}
                <span className={cn(dense ? "text-[12px]" : "text-[13px]", tone === "text-muted" ? "text-fg" : tone)}>
                  {it.label}
                </span>
                {txHref ? (
                  <a
                    href={txHref}
                    target="_blank"
                    rel="noreferrer"
                    title="Open transaction on Solscan"
                    className="inline-flex shrink-0 items-center gap-1 border border-accent/50 px-1.5 py-0.5 text-[10px] tracking-wider text-accent no-underline hover:border-accent hover:bg-accent/10 hover:text-hover"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Solscan
                    <Icon icon={ExternalLink} size={9} />
                  </a>
                ) : null}
              </div>
              {it.detail && (
                <div className="truncate text-[11px] text-muted">{it.detail}</div>
              )}
            </div>
            {sol != null && (
              txHref ? (
                <a
                  href={txHref}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(
                    "mt-0.5 shrink-0 tabular-nums font-medium no-underline hover:underline",
                    dense ? "text-[11px]" : "text-[12px]",
                    solClass(sol, it.kind),
                  )}
                  title="Open transaction on Solscan"
                >
                  {fmtSol(sol, 3)}
                </a>
              ) : (
                <span
                  className={cn(
                    "mt-0.5 shrink-0 tabular-nums font-medium",
                    dense ? "text-[11px]" : "text-[12px]",
                    solClass(sol, it.kind),
                  )}
                  title="SOL flow: green in, blue deployed, red loss"
                >
                  {fmtSol(sol, 3)}
                </span>
              )
            )}
          </li>
        );
      })}
    </ul>
  );
}
