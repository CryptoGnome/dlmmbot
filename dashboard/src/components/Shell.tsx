import type { LiveWatch } from "@/lib/types";
import type { LiveStatus } from "@/lib/api";
import type { ReactNode } from "react";
import { BookText, CircleDot, ExternalLink } from "lucide-react";
import { GithubMark, Icon, PauseCircle, tabIcon, Unplug, Zap } from "@/lib/icons";

export type TabId = "overview" | "book" | "analytics" | "activity" | "errors" | "research" | "changes" | "settings";

const DOCS_URL = "https://dlmmbot.com/setup/";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "book", label: "Book" },
  { id: "analytics", label: "Analytics" },
  { id: "activity", label: "Activity" },
  { id: "errors", label: "Errors" },
  { id: "research", label: "Research" },
  { id: "changes", label: "Changes" },
  { id: "settings", label: "Settings" },
];

export function parseTab(hash: string): TabId {
  const id = hash.replace(/^#\/?/, "").split("?")[0] || "overview";
  return TABS.some((t) => t.id === id) ? (id as TabId) : "overview";
}

function BuildPill({ build, onOpenChanges }: {
  build: LiveWatch["build"];
  onOpenChanges?: () => void;
}) {
  const sync = build.sync ?? "unknown";
  const syncTone =
    sync === "current" && !build.dirty ? "ok"
      : sync === "behind" || build.dirty || sync === "diverged" ? "warn"
        : sync === "ahead" ? "accent" : "muted";
  const syncLabel =
    sync === "current" && build.dirty ? "DIRTY"
      : sync === "current" ? "CURRENT"
        : sync === "behind" && build.needs_approval ? "APPROVE"
          : sync === "behind" ? "BEHIND"
            : sync === "ahead" ? "AHEAD"
              : sync === "diverged" ? "DIVERGED" : "GIT?";
  const tip = [
    build.message ? `"${build.message}"` : null,
    `disk ${build.describe ?? build.head ?? "—"}`,
    build.running && build.running !== build.describe ? `running ${build.running}` : null,
    build.origin ? `github ${build.origin}` : "github ?",
    sync,
    build.behind_count ? `${build.behind_count} pending` : null,
    build.dirty ? "tracked working tree dirty" : null,
    build.auto_update === false
      ? (build.needs_approval ? "manual — approve on Changes" : "manual approve mode")
      : null,
    sync === "behind" ? "click → Changes" : "click → GitHub commits",
  ].filter(Boolean).join(" · ");
  const cls =
    syncTone === "ok" ? "border-ok/70 text-ok"
      : syncTone === "warn" ? "border-warn/70 text-warn"
        : syncTone === "accent" ? "border-accent/70 text-accent"
          : "border-grid text-muted";
  const branch = build.branch || "master";
  const href = build.commits_url
    ?? (build.repo_url
      ? `${build.repo_url.replace(/\/$/, "")}/commits/${encodeURIComponent(branch)}`
      : "https://github.com/CryptoGnome/dlmmbot/commits/master");
  const pulse = sync === "behind" || (build.running != null && build.describe != null
    && build.running !== build.describe);

  const body = (
    <>
      <GithubMark size={11} />
      v{build.version ?? "?"} {build.describe ?? build.head ?? "—"} · {syncLabel}
      {sync === "behind" && build.origin ? ` → ${build.origin}` : ""}
      {sync === "behind" && build.behind_count ? ` (+${build.behind_count})` : ""}
    </>
  );

  const className = `inline-flex cursor-pointer items-center gap-1 border bg-transparent px-1.5 py-0.5 text-[10px] tracking-widest no-underline hover:border-hover hover:text-hover ${cls}${pulse ? " build-pill-pulse" : ""}`;

  if (sync === "behind" && onOpenChanges) {
    return (
      <button
        type="button"
        title={tip}
        className={className}
        onClick={onOpenChanges}
      >
        {body}
      </button>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={tip}
      className={className}
    >
      {body}
    </a>
  );
}

function DocsLink({ className }: { className?: string }) {
  return (
    <a
      href={DOCS_URL}
      target="_blank"
      rel="noreferrer"
      className={className}
      title="Open setup docs"
    >
      <Icon icon={BookText} size={14} className="opacity-80" />
      Docs
      <Icon icon={ExternalLink} size={10} className="opacity-50" />
    </a>
  );
}

export function Shell({
  tab, onTab, watch, live, stale, children, rangeTabs,
}: {
  tab: TabId;
  onTab: (t: TabId) => void;
  watch: LiveWatch | null;
  live: LiveStatus;
  stale: boolean;
  children: ReactNode;
  rangeTabs?: ReactNode;
}) {
  return (
    <div className="flex h-screen overflow-hidden bg-bg text-fg">
      <aside className="hidden h-full w-44 shrink-0 border-r border-grid md:flex md:flex-col">
        <div className="shrink-0 border-b border-grid px-3 py-4">
          <div className="font-display text-sm font-semibold tracking-[0.14em]">DLMM</div>
          <div className="mt-0.5 text-[10px] tracking-widest text-dim">BOT OPS</div>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto py-2">
          {TABS.map((t) => {
            const TabIcon = tabIcon[t.id];
            const pending = t.id === "changes" && watch?.build?.sync === "behind";
            const errN = t.id === "errors" ? (watch?.error_stats?.count_1h ?? 0) : 0;
            return (
              <button
                key={t.id}
                type="button"
                className={`shell-nav-btn${pending || errN > 0 ? " build-pill-pulse" : ""}`}
                data-active={tab === t.id}
                onClick={() => onTab(t.id)}
              >
                <Icon icon={TabIcon} size={14} className="opacity-80" />
                {t.label}
                {pending && watch?.build?.behind_count ? (
                  <span className="ml-auto text-[9px] text-warn">+{watch.build.behind_count}</span>
                ) : null}
                {errN > 0 ? (
                  <span className="ml-auto text-[9px] text-danger">+{errN}</span>
                ) : null}
              </button>
            );
          })}
        </nav>
        <div className="shrink-0 border-t border-grid py-2">
          <DocsLink className="shell-nav-btn no-underline" />
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-grid px-3 py-2.5 md:px-4">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] tracking-widest ${
                stale ? "border-danger/70 text-danger" : "border-ok/70 text-ok"
              }`}
              title={stale ? "bot heartbeat stale / off" : "bot heartbeat fresh"}
            >
              <Icon icon={stale ? Unplug : CircleDot} size={11} />
              {stale ? "OFF" : "ON"}
            </span>
            <span
              className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] tracking-widest ${
                live === "open" ? "border-ok/70 text-ok" : "border-danger/70 text-danger"
              }`}
              title={live === "open" ? "websocket connected" : live === "connecting" ? "websocket connecting" : "websocket disconnected"}
            >
              <Icon icon={Zap} size={11} />
              {live === "open" ? "WS ON" : "WS OFF"}
            </span>
            {watch && (
              <span
                className={
                  watch.ops?.halted
                    ? "inline-flex items-center gap-1 border border-danger/70 px-1.5 py-0.5 text-[10px] tracking-widest text-danger"
                    : watch.cluster.tripped
                      ? "inline-flex items-center gap-1 border border-danger/70 px-1.5 py-0.5 text-[10px] tracking-widest text-danger"
                      : "inline-flex items-center gap-1 border border-ok/70 px-1.5 py-0.5 text-[10px] tracking-widest text-ok"
                }
              >
                <Icon icon={PauseCircle} size={11} />
                {watch.ops?.halted
                  ? "HALTED"
                  : watch.cluster.tripped
                    ? `BRAKE ${watch.cluster.remainingMin}m`
                    : "BRAKE OFF"}
              </span>
            )}
            {watch?.build && (
              <BuildPill build={watch.build} onOpenChanges={() => onTab("changes")} />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted">
            <span>{watch?.heartbeat?.mode ?? "—"}</span>
            <span className="text-dim">|</span>
            <span>hb {watch?.heartbeat_age_s ?? "—"}s</span>
            <span className="text-dim">|</span>
            <span>{watch?.host ?? "—"}</span>
            {rangeTabs}
          </div>
        </header>

        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-grid px-2 py-1.5 md:hidden no-scrollbar">
          {TABS.map((t) => {
            const TabIcon = tabIcon[t.id];
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onTab(t.id)}
                className={
                  tab === t.id
                    ? "inline-flex shrink-0 items-center gap-1 border border-ok px-2.5 py-1 text-[10px] tracking-wider text-ok uppercase"
                    : "inline-flex shrink-0 items-center gap-1 border border-transparent px-2.5 py-1 text-[10px] tracking-wider text-muted uppercase hover:text-hover"
                }
              >
                <Icon icon={TabIcon} size={12} />
                {t.label}
              </button>
            );
          })}
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 border border-transparent px-2.5 py-1 text-[10px] tracking-wider text-muted no-underline uppercase hover:text-hover"
          >
            <Icon icon={BookText} size={12} />
            Docs
          </a>
        </div>

        <main className="min-h-0 flex-1 space-y-3 overflow-auto px-3 py-3 md:px-4 md:py-4">
          {children}
        </main>
      </div>
    </div>
  );
}
