import type { LiveWatch } from "@/lib/types";
import { Badge, Panel } from "@/components/ui";
import { TokenSymbol } from "@/components/TokenSymbol";
import { Icon } from "@/lib/icons";
import { shortTime, timeAgo, fmtUsdCompact } from "@/lib/utils";
import { ExternalLink, Radio, Users, Waves } from "lucide-react";

function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return fmtUsdCompact(n);
}

function shortAddr(a: string | null | undefined): string {
  if (!a) return "—";
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

export function SmartFlowPage({ watch }: { watch: LiveWatch | null }) {
  const sf = watch?.smartflow;
  const tokens = sf?.tokens ?? [];
  const recent = sf?.recent ?? [];
  const stale = !!sf?.stale;
  const running = !!sf?.running;
  const enabled = sf?.enabled !== false;

  return (
    <div className="space-y-3">
      <div>
        <h1 className="font-display flex items-center gap-2 text-lg font-semibold tracking-wide">
          <Icon icon={Waves} size={18} className="text-accent" />
          Smart flow
        </h1>
        <p className="text-[11px] text-dim">
          GMGN smart-money + KOL buys in the rolling {sf?.window_min ?? 30}m window — same signal the
          scorer uses. Updates when the farmer polls (~2 min).
          {sf?.last_poll_at ? (
            <>
              {" "}Last poll {timeAgo(sf.last_poll_at)}
              {sf.next_feed ? ` · next ${sf.next_feed}` : ""}
            </>
          ) : null}
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-[11px]">
        <Badge tone={running ? "ok" : "fg"}>
          <span className="inline-flex items-center gap-1">
            <Icon icon={Radio} size={10} />
            {running ? "collector on" : "collector off"}
          </span>
        </Badge>
        <Badge tone={stale ? "warn" : "ok"}>{stale ? "stale" : "fresh"}</Badge>
        <Badge tone="accent">
          <span className="inline-flex items-center gap-1">
            <Icon icon={Users} size={10} />
            {tokens.length} tokens
          </span>
        </Badge>
        <Badge tone="fg">{sf?.trade_count ?? 0} trades</Badge>
      </div>

      {!enabled || (!running && !tokens.length && !recent.length) ? (
        <Panel title="No smart-flow data yet">
          <p className="text-[12px] text-dim">
            Needs <code className="text-muted">GMGN_API_KEY</code> and a running farmer. The collector
            writes <code className="text-muted">data/smartflow.json</code> every poll; this tab
            streams it over the live watch feed.
          </p>
        </Panel>
      ) : null}

      <Panel
        title="Hot tokens"
        right={<Badge tone="ok">{tokens.length}</Badge>}
      >
        {!tokens.length ? (
          <p className="text-[12px] text-dim">No smart-money / KOL activity in the window yet.</p>
        ) : (
          <table className="w-full text-left text-[12px]">
            <thead className="text-dim">
              <tr>
                <th className="pb-1.5 pr-2 font-normal">Token</th>
                <th className="pb-1.5 pr-2 font-normal text-right">Smart</th>
                <th className="pb-1.5 pr-2 font-normal text-right">New</th>
                <th className="pb-1.5 pr-2 font-normal text-right">Net</th>
                <th className="pb-1.5 font-normal">KOLs</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.mint} className="border-t border-grid">
                  <td className="py-1.5 pr-2">
                    <a
                      href={`https://gmgn.ai/sol/token/${t.mint}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-fg no-underline hover:text-hover"
                    >
                      <TokenSymbol symbol={t.symbol} mint={t.mint} name={t.name} iconUrl={t.icon_url} />
                      <Icon icon={ExternalLink} size={9} className="opacity-50" />
                    </a>
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-ok">{t.smart_wallets}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-muted">{t.new_joiners}</td>
                  <td className={`py-1.5 pr-2 text-right tabular-nums ${t.net_usd >= 0 ? "text-ok" : "text-danger"}`}>
                    {usd(t.net_usd)}
                  </td>
                  <td className="py-1.5 text-[11px] text-muted">
                    {t.kol_names?.length
                      ? t.kol_names.slice(0, 4).map((k) => `@${k.replace(/^@/, "")}`).join(" · ")
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        title="Recent tape"
        right={<Badge tone="accent">{recent.length}</Badge>}
      >
        {!recent.length ? (
          <p className="text-[12px] text-dim">Waiting for the next GMGN track poll.</p>
        ) : (
          <ul className="divide-y divide-grid">
            {recent.map((t, i) => (
              <li key={`${t.hash}-${i}`} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
                <span className="w-[6.5rem] shrink-0 text-[10px] leading-tight text-dim">
                  <span className="block tabular-nums">{shortTime(t.at)}</span>
                  <span className="mt-0.5 block">{timeAgo(t.at)}</span>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={t.side === "buy" ? "ok" : "danger"}>{t.side}</Badge>
                    <Badge tone={t.feed === "kol" ? "accent" : "fg"}>{t.feed}</Badge>
                    <TokenSymbol symbol={t.symbol} mint={t.mint} name={t.name} iconUrl={t.icon_url} />
                    <span className={`tabular-nums ${t.side === "buy" ? "text-ok" : "text-danger"}`}>
                      {usd(t.usd)}
                    </span>
                    {t.kol ? <span className="text-[11px] text-accent">@{t.kol.replace(/^@/, "")}</span> : null}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-muted">
                    {shortAddr(t.maker)}
                    {t.hash ? (
                      <>
                        {" · "}
                        <a
                          href={`https://solscan.io/tx/${t.hash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent no-underline hover:text-hover"
                        >
                          {shortAddr(t.hash)}
                        </a>
                      </>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
