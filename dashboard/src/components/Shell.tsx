import type { LiveWatch } from "@/lib/types";
import type { LiveStatus } from "@/lib/api";
import type { ReactNode } from "react";
import { CircleDot } from "lucide-react";
import { GithubMark, Icon, PauseCircle, tabIcon, Unplug, Zap } from "@/lib/icons";

export type TabId = "overview" | "book" | "analytics" | "activity" | "research" | "settings";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "book", label: "Book" },
  { id: "analytics", label: "Analytics" },
  { id: "activity", label: "Activity" },
  { id: "research", label: "Research" },
  { id: "settings", label: "Settings" },
];

export function parseTab(hash: string): TabId {
  const id = hash.replace(/^#\/?/, "").split("?")[0] || "overview";
  return TABS.some((t) => t.id === id) ? (id as TabId) : "overview";
}

function BuildPill({ build }: { build: LiveWatch["build"] }) {
  const sync = build.sync ?? "unknown";
  const syncTone =
    sync === "current" && !build.dirty ? "ok"
      : sync === "behind" || build.dirty || sync === "diverged" ? "warn"
        : sync === "ahead" ? "accent" : "muted";
  const syncLabel =
    sync === "current" && build.dirty ? "DIRTY"
      : sync === "current" ? "CURRENT"
        : sync === "behind" ? "BEHIND"
          : sync === "ahead" ? "AHEAD"
            : sync === "diverged" ? "DIVERGED" : "GIT?";
  const tip = [
    build.message ? `"${build.message}"` : null,
    `disk ${build.describe ?? build.head ?? "—"}`,
    build.running && build.running !== build.describe ? `running ${build.running}` : null,
    build.origin ? `github ${build.origin}` : "github ?",
    sync,
    build.dirty ? "tracked working tree dirty" : null,
    "click → GitHub commits",
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
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={tip}
      className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] tracking-widest no-underline hover:border-hover hover:text-hover ${cls}`}
    >
      <GithubMark size={11} />
      v{build.version ?? "?"} {build.describe ?? build.head ?? "—"} · {syncLabel}
      {sync === "behind" && build.origin ? ` → ${build.origin}` : ""}
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
    <div className="flex min-h-screen bg-bg text-fg">
      <aside className="hidden w-44 shrink-0 border-r border-grid md:flex md:flex-col">
        <div className="border-b border-grid px-3 py-4">
          <div className="font-display text-sm font-semibold tracking-[0.14em]">METEORA</div>
          <div className="mt-0.5 text-[10px] tracking-widest text-dim">FARMER OPS</div>
        </div>
        <nav className="flex-1 py-2">
          {TABS.map((t) => {
            const TabIcon = tabIcon[t.id];
            return (
              <button
                key={t.id}
                type="button"
                className="shell-nav-btn"
                data-active={tab === t.id}
                onClick={() => onTab(t.id)}
              >
                <Icon icon={TabIcon} size={14} className="opacity-80" />
                {t.label}
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-grid px-3 py-2.5 md:px-4">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] tracking-widest ${
                stale ? "border-danger/70 text-danger" : "border-ok/70 text-ok"
              }`}
              title={stale ? "farmer heartbeat stale / off" : "farmer heartbeat fresh"}
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
                  watch.cluster.tripped
                    ? "inline-flex items-center gap-1 border border-danger/70 px-1.5 py-0.5 text-[10px] tracking-widest text-danger"
                    : "inline-flex items-center gap-1 border border-ok/70 px-1.5 py-0.5 text-[10px] tracking-widest text-ok"
                }
              >
                <Icon icon={PauseCircle} size={11} />
                {watch.cluster.tripped ? `BRAKE ${watch.cluster.remainingMin}m` : "BRAKE OFF"}
              </span>
            )}
            {watch?.build && <BuildPill build={watch.build} />}
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

        <div className="flex gap-1 overflow-x-auto border-b border-grid px-2 py-1.5 md:hidden no-scrollbar">
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
        </div>

        <main className="flex-1 space-y-3 overflow-auto px-3 py-3 md:px-4 md:py-4">
          {children}
        </main>
      </div>
    </div>
  );
}
