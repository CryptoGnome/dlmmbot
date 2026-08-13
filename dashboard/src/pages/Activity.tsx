import type { LiveWatch } from "@/lib/types";
import { buildActivityFeed, type FeedKind } from "@/lib/activityFeed";
import { Badge, Panel } from "@/components/ui";
import { ActivityFeedList } from "@/components/ActivityFeed";
import { TokenSymbol } from "@/components/TokenSymbol";
import { shortTime } from "@/lib/utils";
import { Icon, feedKindIcon } from "@/lib/icons";

export function ActivityPage({ watch }: { watch: LiveWatch | null }) {
  const items = buildActivityFeed(watch, 80);
  const byKind = items.reduce<Record<string, number>>((a, it) => {
    a[it.kind] = (a[it.kind] ?? 0) + 1;
    return a;
  }, {});

  return (
    <div className="space-y-3">
      <div>
        <h1 className="font-display text-lg font-semibold tracking-wide">Activity</h1>
        <p className="text-[11px] text-dim">
          Live ops feed — entries, exits, claims, skips (high-signal), and open failures.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-[11px]">
        {(["entry", "exit", "skip", "fail", "event"] as FeedKind[]).map((k) => (
          <Badge key={k} tone={k === "fail" ? "danger" : k === "skip" ? "warn" : k === "event" ? "accent" : "ok"}>
            <span className="inline-flex items-center gap-1">
              <Icon icon={feedKindIcon[k]} size={10} />
              {k} {byKind[k] ?? 0}
            </span>
          </Badge>
        ))}
      </div>

      <Panel title="Live feed" right={<Badge tone="ok">{items.length} events</Badge>}>
        <ActivityFeedList items={items} empty="No recent activity in the watch snapshot" />
      </Panel>

      <Panel title="Recent entries" right={<Badge tone="ok">{watch?.recent_passes?.length ?? 0}</Badge>}>
        {!(watch?.recent_passes?.length) ? (
          <div className="py-4 text-center text-[12px] text-dim">No entries in the last 7d</div>
        ) : (
          <table className="w-full text-left text-[12px]">
            <thead className="text-dim">
              <tr>
                <th className="pb-1.5 pr-2 font-normal">When</th>
                <th className="pb-1.5 pr-2 font-normal">Symbol</th>
                <th className="pb-1.5 pr-2 font-normal">Sleeve</th>
                <th className="pb-1.5 pr-2 font-normal text-right">Score</th>
                <th className="pb-1.5 font-normal text-right">Size</th>
              </tr>
            </thead>
            <tbody>
              {watch.recent_passes.map((r, i) => (
                <tr key={`${r.at}-${r.mint}-${i}`} className="border-t border-grid">
                  <td className="py-1.5 pr-2 text-muted whitespace-nowrap">{shortTime(r.at)}</td>
                  <td className="py-1.5 pr-2">
                    <TokenSymbol symbol={r.symbol} mint={r.mint} />
                  </td>
                  <td className="py-1.5 pr-2 text-muted">{r.sleeve ?? "meme"}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-ok">
                    {r.score != null ? r.score.toFixed(1) : "—"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-muted">
                    {r.size != null ? `${r.size.toFixed(2)} SOL` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
