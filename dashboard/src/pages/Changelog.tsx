import { useState } from "react";
import { Panel, Badge } from "@/components/ui";
import { shortTime, timeAgo } from "@/lib/utils";
import type { LiveWatch } from "@/lib/types";
import { Icon } from "@/lib/icons";
import { ExternalLink, ScrollText, Check } from "lucide-react";
import { approveDeployUpdate } from "@/lib/api";
import { toast } from "@/lib/toast";

type Commit = NonNullable<LiveWatch["build"]["recent"]>[number] & { risk?: string[] };

const RISK_TONE: Record<string, "danger" | "warn" | "accent" | "ok" | "fg"> = {
  strategy: "danger",
  deps: "warn",
  deploy: "warn",
  core: "accent",
  dash: "ok",
  docs: "fg",
};

function CommitList({
  items,
  empty,
  repoUrl,
  showRisk,
}: {
  items: Commit[];
  empty: string;
  repoUrl?: string | null;
  showRisk?: boolean;
}) {
  if (!items.length) {
    return <p className="text-[12px] text-dim">{empty}</p>;
  }
  return (
    <ul className="space-y-0">
      {items.map((c, i) => {
        const href = c.sha && repoUrl
          ? `${repoUrl.replace(/\/$/, "")}/commit/${c.sha}`
          : null;
        return (
          <li
            key={`${c.sha}-${i}`}
            className="flex items-start gap-3 border-t border-grid py-2 first:border-0"
          >
            <span className="w-[7.25rem] shrink-0 text-[10px] leading-tight text-dim">
              {c.at ? (
                <>
                  <span className="block tabular-nums">{shortTime(c.at)}</span>
                  <span className="mt-0.5 block">{timeAgo(c.at)}</span>
                </>
              ) : (
                "—"
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[13px] text-fg">{c.subject}</span>
                {showRisk && (c.risk?.length ? c.risk : ["docs"]).map((t) => (
                  <Badge key={t} tone={RISK_TONE[t] ?? "fg"}>{t}</Badge>
                ))}
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-muted">
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-accent no-underline hover:text-hover"
                  >
                    {c.sha}
                    <Icon icon={ExternalLink} size={9} className="opacity-60" />
                  </a>
                ) : (
                  c.sha ?? "—"
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function ChangelogPage({ watch }: { watch: LiveWatch | null }) {
  const b = watch?.build;
  const pending = b?.pending ?? [];
  const recent = b?.recent ?? [];
  const behind = b?.sync === "behind";
  const auto = b?.auto_update !== false;
  const needsApproval = !!b?.needs_approval;
  const approvedWaiting = behind && !auto && !needsApproval && !!b?.approve_sha;
  const [busy, setBusy] = useState(false);

  const onApprove = async () => {
    setBusy(true);
    try {
      const r = await approveDeployUpdate();
      toast({
        title: "Update approved",
        detail: r.note ?? "Deploy watcher will pull shortly.",
        tone: "ok",
        kind: "event",
      });
    } catch (e) {
      toast({
        title: "Approve failed",
        detail: (e as Error).message,
        tone: "danger",
        kind: "fail",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <h1 className="font-display flex items-center gap-2 text-lg font-semibold tracking-wide">
          <Icon icon={ScrollText} size={18} className="text-accent" />
          Changes
        </h1>
        <p className="text-[11px] text-dim">
          Recent deploys on this host
          {b?.branch ? ` · ${b.branch}` : ""}
          {b?.commits_url ? (
            <>
              {" · "}
              <a
                href={b.commits_url}
                target="_blank"
                rel="noreferrer"
                className="text-accent no-underline hover:text-hover"
              >
                GitHub
              </a>
            </>
          ) : null}
          {" · "}
          <span className={auto ? "text-ok" : "text-warn"}>
            {auto ? "auto-update on" : "manual approve"}
          </span>
          <span className="text-dim"> (toggle next to the build pill in the header)</span>
        </p>
      </div>

      {behind && (
        <Panel
          title="Pending update"
          right={
            <div className="flex items-center gap-2">
              {needsApproval && (
                <button
                  type="button"
                  title="Approve & deploy this update"
                  disabled={busy}
                  onClick={() => void onApprove()}
                  className="inline-flex items-center gap-1 border border-ok/70 bg-ok/10 px-2 py-1 text-[10px] tracking-wider text-ok uppercase hover:bg-ok/20 disabled:opacity-50"
                >
                  <Icon icon={Check} size={12} />
                  {busy ? "…" : "Approve"}
                </button>
              )}
              {approvedWaiting && (
                <Badge tone="ok">approved — deploying</Badge>
              )}
              <Badge tone="warn">
                {b?.behind_count && b.behind_count > 0
                  ? `${b.behind_count} commit${b.behind_count === 1 ? "" : "s"}`
                  : "behind"}
              </Badge>
            </div>
          }
        >
          <p className="mb-3 text-[11px] text-dim">
            GitHub is ahead of this host
            {b?.origin ? ` (origin ${b.origin}` : ""}
            {b?.head ? `, disk ${b.head}` : ""}
            {b?.origin ? ")" : ""}.{" "}
            {auto
              ? "Auto-deploy usually picks these up within a minute."
              : needsApproval
                ? "Auto-update is off — review the commits, then click Approve (checkmark) to let the host pull."
                : "Approved — waiting for meteora-deploy to pull."}
          </p>
          <CommitList
            items={pending}
            empty="Behind, but no pending commit list yet — refresh shortly."
            repoUrl={b?.repo_url}
            showRisk
          />
        </Panel>
      )}

      <Panel
        title="On this host"
        right={<Badge tone="ok">{b?.describe ?? b?.head ?? "—"}</Badge>}
      >
        {b?.running && b.running !== b.describe && (
          <p className="mb-3 text-[11px] text-warn">
            Farmer process still on {b.running} — restarting after deploy.
          </p>
        )}
        <CommitList
          items={recent}
          empty="No commit history yet — on Railway this loads from GitHub within a few seconds. If it stays empty, set GITHUB_TOKEN (private repos) or check the deploy can reach api.github.com."
          repoUrl={b?.repo_url}
        />
      </Panel>
    </div>
  );
}
