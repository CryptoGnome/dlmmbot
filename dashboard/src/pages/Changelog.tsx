import { useState } from "react";
import { Panel, Badge } from "@/components/ui";
import { shortTime, timeAgo } from "@/lib/utils";
import type { LiveWatch } from "@/lib/types";
import { Icon } from "@/lib/icons";
import { ExternalLink, ScrollText, Check, Tag } from "lucide-react";
import { approveDeployUpdate } from "@/lib/api";
import { toast } from "@/lib/toast";

type Release = NonNullable<LiveWatch["build"]["releases"]>[number];

function parseSemver(raw: string | null | undefined): [number, number, number] | null {
  const m = /v?(\d+)\.(\d+)\.(\d+)/i.exec(String(raw ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** true if a is strictly newer than b (semver). */
function semverNewer(a: string, b: string): boolean {
  const A = parseSemver(a);
  const B = parseSemver(b);
  if (!A || !B) return false;
  for (let i = 0; i < 3; i++) {
    if (A[i]! > B[i]!) return true;
    if (A[i]! < B[i]!) return false;
  }
  return false;
}

function hostVersionTag(version: string | undefined): string {
  const v = String(version ?? "").replace(/^v/i, "");
  return v ? `v${v}` : "";
}

function ReleasesList({
  items,
  empty,
  currentTag,
}: {
  items: Release[];
  empty: string;
  currentTag?: string;
}) {
  if (!items.length) {
    return <p className="text-[12px] text-dim">{empty}</p>;
  }
  return (
    <ul className="space-y-0">
      {items.map((r) => {
        const isCurrent = currentTag
          && parseSemver(r.tag)
          && parseSemver(currentTag)
          && !semverNewer(r.tag, currentTag)
          && !semverNewer(currentTag, r.tag);
        return (
          <li
            key={r.tag}
            className="flex items-start gap-3 border-t border-grid py-2.5 first:border-0"
          >
            <span className="w-[7.25rem] shrink-0 text-[10px] leading-tight text-dim">
              {r.at ? (
                <>
                  <span className="block tabular-nums">{shortTime(r.at)}</span>
                  <span className="mt-0.5 block">{timeAgo(r.at)}</span>
                </>
              ) : (
                "—"
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={isCurrent ? "ok" : "accent"}>{r.tag}</Badge>
                {isCurrent && <Badge tone="ok">on this host</Badge>}
                {r.url ? (
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[13px] text-fg no-underline hover:text-hover"
                  >
                    {r.summary || r.name || r.tag}
                    <Icon icon={ExternalLink} size={10} className="opacity-60" />
                  </a>
                ) : (
                  <span className="text-[13px] text-fg">{r.summary || r.name || r.tag}</span>
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
  const releases = b?.releases ?? [];
  const currentTag = hostVersionTag(b?.version);
  const pendingReleases = currentTag
    ? releases.filter((r) => semverNewer(r.tag, currentTag))
    : [];
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
          Operator view = GitHub releases (what changed), not every merge commit
          {b?.branch ? ` · ${b.branch}` : ""}
          {currentTag ? ` · running ${currentTag}` : ""}
          {b?.release_url ? (
            <>
              {" · "}
              <a
                href={b.release_url}
                target="_blank"
                rel="noreferrer"
                className="text-accent no-underline hover:text-hover"
              >
                All releases
              </a>
            </>
          ) : null}
          {" · "}
          <span className={auto ? "text-ok" : "text-warn"}>
            {auto ? "auto-update on" : "manual approve"}
          </span>
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
                {pendingReleases.length > 0
                  ? `${pendingReleases.length} release${pendingReleases.length === 1 ? "" : "s"}`
                  : b?.behind_count && b.behind_count > 0
                    ? "unreleased commits"
                    : "behind"}
              </Badge>
            </div>
          }
        >
          <p className="mb-3 text-[11px] text-dim">
            GitHub is ahead of this host
            {b?.origin ? ` (origin ${b.origin}` : ""}
            {b?.head ? `, disk ${b.head}` : ""}
            {b?.origin ? ")" : ""}
            {b?.behind_count ? ` · ${b.behind_count} commit${b.behind_count === 1 ? "" : "s"}` : ""}
            .{" "}
            {auto
              ? "Auto-deploy usually picks this up within a minute."
              : needsApproval
                ? "Auto-update is off — review the release notes below, then Approve."
                : "Approved — waiting for meteora-deploy to pull."}
          </p>
          {pendingReleases.length > 0 ? (
            <ReleasesList items={pendingReleases} empty="" />
          ) : (
            <p className="text-[12px] text-dim">
              No newer release tag yet — branch tip is ahead of {currentTag || "this host"} with
              unreleased commits (feature merges / syncs). Deploy still applies; the next cut
              will show as a release here.
            </p>
          )}
        </Panel>
      )}

      <Panel
        title="Releases"
        right={
          <span className="inline-flex items-center gap-1 text-[10px] tracking-wider text-muted uppercase">
            <Icon icon={Tag} size={11} />
            what shipped
          </span>
        }
      >
        {b?.running && b.running !== b.describe && (
          <p className="mb-3 text-[11px] text-warn">
            Farmer process still on {b.running} — restarting after deploy.
          </p>
        )}
        <ReleasesList
          items={releases}
          currentTag={currentTag || undefined}
          empty="No releases loaded yet. Wait a few seconds for the GitHub poll, or set GITHUB_TOKEN on the host if api.github.com is rate-limiting (common on Railway shared IPs). Last-good notes are cached on the volume once fetched."
        />
      </Panel>
    </div>
  );
}
