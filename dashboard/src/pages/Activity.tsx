import type { LiveWatch } from "@/lib/types";
import { exitLabel, shortTime } from "@/lib/utils";
import { Badge, Panel } from "@/components/ui";
import { TokenSymbol } from "@/components/TokenSymbol";

type FeedItem = {
  at: string;
  kind: "entry" | "exit" | "fail" | "cluster";
  label: string;
  detail?: string;
  tone?: "ok" | "danger" | "warn" | "muted";
};

export function ActivityPage({ watch }: { watch: LiveWatch | null }) {
  const items: FeedItem[] = [];

  for (const r of watch?.recent_passes ?? []) {
    items.push({
      at: r.at,
      kind: "entry",
      label: `entered ${r.symbol}`,
      detail: [
        r.score != null ? `score ${r.score.toFixed(1)}` : null,
        r.size != null ? `${r.size.toFixed(2)} SOL` : null,
        r.sleeve && r.sleeve !== "meme" ? r.sleeve : null,
        r.isAlpha ? "alpha" : null,
      ].filter(Boolean).join(" · "),
      tone: "ok",
    });
  }

  for (const r of watch?.open_failed_since_fix.recent ?? []) {
    items.push({
      at: r.at,
      kind: "fail",
      label: `open failed${r.code ? ` (${r.code})` : ""}`,
      detail: r.error?.slice(0, 120) ?? r.mint.slice(0, 8),
      tone: "danger",
    });
  }

  for (const r of watch?.cluster.recent ?? []) {
    if (!r.exit_ts) continue;
    items.push({
      at: new Date(r.exit_ts * 1000).toISOString(),
      kind: "cluster",
      label: `cluster ${r.symbol ?? "?"} ${exitLabel(r.exit_reason)}`,
      tone: "warn",
    });
  }

  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return (
    <div className="space-y-3">
      <div>
        <h1 className="font-display text-lg font-semibold tracking-wide">Activity</h1>
        <p className="text-[11px] text-dim">Recent entries, open failures, and cluster exits.</p>
      </div>

      <Panel
        title="Feed"
        right={<Badge tone="ok">{items.length} events</Badge>}
      >
        {!items.length ? (
          <div className="py-8 text-center text-[12px] text-dim">No recent activity in the watch snapshot</div>
        ) : (
          <ul className="space-y-0">
            {items.slice(0, 40).map((it, i) => (
              <li key={`${it.at}-${it.kind}-${i}`} className="flex gap-3 border-t border-grid py-2 first:border-0">
                <span className="w-16 shrink-0 text-[10px] text-dim tabular-nums">{shortTime(it.at)}</span>
                <div className="min-w-0 flex-1">
                  <div className={
                    it.tone === "ok" ? "text-ok"
                      : it.tone === "danger" ? "text-danger"
                        : it.tone === "warn" ? "text-warn"
                          : "text-fg"
                  }>
                    {it.label}
                  </div>
                  {it.detail && <div className="text-[11px] text-muted truncate">{it.detail}</div>}
                </div>
                <Badge tone={it.kind === "entry" ? "ok" : it.kind === "fail" ? "danger" : "warn"}>
                  {it.kind}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Recent passes (table)" right={<Badge tone="ok">{watch?.recent_passes?.length ?? 0}</Badge>}>
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
