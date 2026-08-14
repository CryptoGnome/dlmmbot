import type { LiveWatch } from "@/lib/types";
import { patchDeployPrefs, type LiveStatus } from "@/lib/api";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookText, Check, CircleDot, Copy, ExternalLink, Wallet } from "lucide-react";
import { HaltToggle } from "@/components/HaltControl";
import { GithubMark, Icon, PauseCircle, tabIcon, Unplug, Zap } from "@/lib/icons";
import { copyText } from "@/lib/errorReport";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export type TabId = "overview" | "book" | "analytics" | "activity" | "errors" | "research" | "wiki" | "changes" | "settings";

const DOCS_URL = "https://dlmmbot.com/setup/";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "book", label: "Book" },
  { id: "analytics", label: "Analytics" },
  { id: "activity", label: "Activity" },
  { id: "errors", label: "Errors" },
  { id: "research", label: "Research" },
  { id: "wiki", label: "Wiki" },
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

/** Compact header switch — sits next to the GitHub build pill. */
function AutoUpdateToggle({ autoUpdate }: { autoUpdate: boolean | undefined }) {
  const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState<boolean | null>(null);
  const on = override ?? (autoUpdate !== false);

  useEffect(() => {
    if (override == null) return;
    if ((autoUpdate !== false) === override) setOverride(null);
  }, [autoUpdate, override]);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={busy}
      title={
        on
          ? "Auto-update ON — host pulls new GitHub commits automatically. Click to require Approve on Changes."
          : "Auto-update OFF — approve pending commits on Changes. Click to turn auto back on."
      }
      onClick={() => {
        void (async () => {
          const next = !on;
          setBusy(true);
          setOverride(next);
          try {
            await patchDeployPrefs({ autoUpdate: next });
            toast({
              title: next ? "Auto-update on" : "Auto-update off",
              detail: next
                ? "New commits deploy automatically."
                : "Approve updates from the Changes tab.",
              tone: next ? "ok" : "warn",
              kind: "event",
            });
          } catch (e) {
            setOverride(null);
            toast({
              title: "Couldn’t save update pref",
              detail: (e as Error).message,
              tone: "danger",
              kind: "fail",
            });
          } finally {
            setBusy(false);
          }
        })();
      }}
      className={cn(
        "inline-flex items-center gap-1.5 border bg-transparent px-1.5 py-0.5 text-[10px] tracking-widest uppercase disabled:opacity-50",
        on ? "border-ok/70 text-ok hover:border-hover hover:text-hover" : "border-warn/70 text-warn hover:border-hover hover:text-hover",
      )}
    >
      Auto
      <span
        className={cn(
          "relative h-3.5 w-6 shrink-0 rounded-full border transition-colors",
          on ? "border-ok/70 bg-ok/30" : "border-warn/40 bg-panel",
        )}
        aria-hidden
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 h-2 w-2 rounded-full bg-fg transition-transform",
            on ? "translate-x-2.5" : "",
          )}
        />
      </span>
      {on ? "on" : "off"}
    </button>
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

function shortPk(pk: string) {
  return pk.length > 12 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : pk;
}

function WalletPubkeyButton({ pubkey }: { pubkey: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function copy() {
    const ok = await copyText(pubkey);
    setCopied(ok);
    toast({
      title: ok ? "Wallet copied" : "Copy failed",
      detail: ok ? shortPk(pubkey) : "Clipboard blocked",
      tone: ok ? "ok" : "danger",
      kind: "event",
    });
    if (ok) window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] tracking-widest uppercase",
          open ? "border-accent/70 text-accent" : "border-grid text-dim hover:border-hover hover:text-hover",
        )}
        title="Bot wallet address"
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Icon icon={Wallet} size={11} />
        {shortPk(pubkey)}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Bot wallet address"
          className="absolute right-0 z-40 mt-1 w-[min(22rem,calc(100vw-1.5rem))] border border-grid bg-panel p-2.5 shadow-lg"
        >
          <div className="mb-1.5 text-[10px] tracking-wider text-dim uppercase">Bot wallet</div>
          <p className="break-all font-mono text-[11px] leading-snug text-fg">{pubkey}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              className="inline-flex items-center gap-1 border border-accent/50 px-2 py-1 text-[10px] tracking-wider text-accent uppercase hover:border-hover hover:text-hover"
              onClick={() => void copy()}
            >
              <Icon icon={copied ? Check : Copy} size={10} />
              {copied ? "Copied" : "Copy"}
            </button>
            <a
              href={`https://solscan.io/account/${pubkey}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 border border-grid px-2 py-1 text-[10px] tracking-wider text-muted no-underline uppercase hover:text-hover"
            >
              Solscan
              <Icon icon={ExternalLink} size={9} className="opacity-60" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

export function Shell({
  tab, onTab, watch, live, stale, children,
}: {
  tab: TabId;
  onTab: (t: TabId) => void;
  watch: LiveWatch | null;
  live: LiveStatus;
  stale: boolean;
  children: ReactNode;
}) {
  const mode = (watch?.heartbeat?.mode ?? "").toLowerCase();
  const modeLive = mode === "live";
  const hbAge = watch?.heartbeat_age_s;
  const showBrake = !!watch?.cluster?.tripped && !watch?.ops?.halted;

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
            <HaltToggle watch={watch} />
            <span
              className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] tracking-widest ${
                stale ? "border-danger/70 text-danger" : "border-grid text-dim"
              }`}
              title={
                stale
                  ? `farmer heartbeat stale${hbAge != null ? ` (${hbAge}s)` : ""}`
                  : `farmer heartbeat fresh${hbAge != null ? ` (${hbAge}s)` : ""}`
              }
            >
              <Icon icon={stale ? Unplug : CircleDot} size={11} />
              {stale ? "HB?" : "HB"}
            </span>
            <span
              className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] tracking-widest ${
                live === "open" ? "border-ok/70 text-ok" : "border-danger/70 text-danger"
              }`}
              title={live === "open" ? "websocket connected" : live === "connecting" ? "websocket connecting" : "websocket disconnected"}
            >
              <Icon icon={Zap} size={11} />
              {live === "open" ? "WS" : "WS OFF"}
            </span>
            {mode ? (
              <span
                className={`inline-flex items-center border px-1.5 py-0.5 text-[10px] tracking-widest ${
                  modeLive ? "border-accent/70 text-accent" : "border-grid text-muted"
                }`}
                title={modeLive ? "live trading" : "paper / simulation"}
              >
                {modeLive ? "LIVE" : "PAPER"}
              </span>
            ) : null}
            {showBrake && (
              <span
                className="inline-flex items-center gap-1 border border-danger/70 px-1.5 py-0.5 text-[10px] tracking-widest text-danger"
                title="Cluster brake — new entries paused"
              >
                <Icon icon={PauseCircle} size={11} />
                BRAKE {watch?.cluster?.remainingMin ?? "?"}m
              </span>
            )}
            {watch?.build && (
              <>
                <BuildPill build={watch.build} onOpenChanges={() => onTab("changes")} />
                <AutoUpdateToggle autoUpdate={watch.build.auto_update} />
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {watch?.wallet_pubkey ? (
              <WalletPubkeyButton pubkey={watch.wallet_pubkey} />
            ) : null}
            {watch?.host ? (
              <div
                className="max-w-[12rem] truncate text-[10px] tracking-wider text-dim uppercase"
                title={`host ${watch.host}`}
              >
                {watch.host}
              </div>
            ) : null}
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
