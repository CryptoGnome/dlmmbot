import { useMemo, useState } from "react";
import type { ErrorLogEntry, LiveWatch } from "@/lib/types";
import { Badge, Panel } from "@/components/ui";
import { Icon } from "@/lib/icons";
import { shortTime, timeAgo } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { dismissErrors, clearErrorLog } from "@/lib/api";
import {
  copyText, errorIssueUrl, formatErrorDump, formatErrorLogDump,
} from "@/lib/errorReport";
import { errorPresentation, kindLabel, kindTone } from "@/lib/errorPresent";
import {
  Bug, Check, ChevronDown, ChevronRight, Copy, ExternalLink, OctagonX, Trash2, X,
} from "lucide-react";
import { TokenSymbol } from "@/components/TokenSymbol";

type Filter = "all" | "attention" | "transient" | "warn" | "fatal";

function levelTone(level: string): "danger" | "warn" | "accent" | "fg" {
  if (level === "fatal") return "danger";
  if (level === "error") return "danger";
  if (level === "warn") return "warn";
  return "fg";
}

function ErrorRow({
  e, watch, expanded, onToggle, onDismiss, busy,
}: {
  e: ErrorLogEntry;
  watch: LiveWatch | null;
  expanded: boolean;
  onToggle: () => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  const pres = errorPresentation(e);
  const dump = formatErrorDump(e, watch, pres);
  const issueHref = errorIssueUrl(e, watch, pres);

  return (
    <li className="border-t border-grid first:border-0">
      <div className="flex items-start gap-2 py-2.5">
        <button
          type="button"
          className="mt-0.5 shrink-0 text-dim hover:text-fg"
          onClick={onToggle}
          aria-expanded={expanded}
          title={expanded ? "Collapse" : "Expand"}
        >
          <Icon icon={expanded ? ChevronDown : ChevronRight} size={14} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={levelTone(e.level)}>{e.level}</Badge>
            <Badge tone={kindTone(pres.kind)}>{kindLabel(pres.kind)}</Badge>
            <span className="font-mono text-[10px] text-dim">#{e.id}</span>
            <span className="text-[10px] tracking-wider text-muted uppercase">
              {e.source}{e.code ? `/${e.code}` : ""}
            </span>
            {e.symbol || e.mint ? (
              <TokenSymbol
                symbol={e.symbol}
                mint={e.mint}
                name={e.name}
                iconUrl={e.icon_url}
              />
            ) : null}
            <span className="ml-auto shrink-0 text-[10px] text-dim tabular-nums">
              {shortTime(e.at)} · {timeAgo(e.at)}
            </span>
          </div>
          <p className="mt-1 text-[13px] font-medium leading-snug text-fg">
            {pres.label}
          </p>
          {pres.hint && (
            <p className="mt-1 text-[11px] leading-snug text-muted">{pres.hint}</p>
          )}
          <p className="mt-1 break-words font-mono text-[11px] leading-snug text-dim">
            {e.message}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              className="inline-flex items-center gap-1 border border-grid px-2 py-1 text-[10px] tracking-wider text-muted uppercase hover:text-hover"
              onClick={() => {
                void (async () => {
                  const ok = await copyText(dump);
                  toast({
                    title: ok ? "Copied error" : "Copy failed",
                    detail: ok ? `#${e.id}` : "Clipboard blocked",
                    tone: ok ? "ok" : "danger",
                    kind: "event",
                  });
                })();
              }}
            >
              <Icon icon={Copy} size={10} />
              Copy
            </button>
            <a
              href={issueHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 border border-accent/50 px-2 py-1 text-[10px] tracking-wider text-accent no-underline uppercase hover:border-hover hover:text-hover"
            >
              <Icon icon={Bug} size={10} />
              GitHub issue
              <Icon icon={ExternalLink} size={9} className="opacity-60" />
            </a>
            <button
              type="button"
              disabled={busy}
              className="inline-flex items-center gap-1 border border-grid px-2 py-1 text-[10px] tracking-wider text-muted uppercase hover:border-ok/60 hover:text-ok disabled:opacity-40"
              onClick={onDismiss}
              title="Hide this error from the live log"
            >
              <Icon icon={X} size={10} />
              Dismiss
            </button>
          </div>
        </div>
      </div>
      {expanded && (
        <div className="mb-3 ml-6 space-y-2 border border-grid bg-panel/40 p-2.5">
          {(e.mint || e.pool || e.position_id != null || e.build || e.host) && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px]">
              {e.position_id != null && (
                <>
                  <dt className="text-dim">Position</dt>
                  <dd className="font-mono text-fg">#{e.position_id}</dd>
                </>
              )}
              {e.mint && (
                <>
                  <dt className="text-dim">Mint</dt>
                  <dd className="break-all font-mono text-fg">{e.mint}</dd>
                </>
              )}
              {e.pool && (
                <>
                  <dt className="text-dim">Pool</dt>
                  <dd className="break-all font-mono text-fg">{e.pool}</dd>
                </>
              )}
              {e.host && (
                <>
                  <dt className="text-dim">Host</dt>
                  <dd className="font-mono text-fg">{e.host}</dd>
                </>
              )}
              {e.build && (
                <>
                  <dt className="text-dim">Build</dt>
                  <dd className="font-mono text-fg">{e.build}</dd>
                </>
              )}
              {e.pid != null && (
                <>
                  <dt className="text-dim">PID</dt>
                  <dd className="font-mono text-fg">{e.pid}</dd>
                </>
              )}
            </dl>
          )}
          {e.stack && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-warn">
              {e.stack}
            </pre>
          )}
          {e.detail != null && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted">
              {typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail, null, 2)}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

export function ErrorsPage({ watch }: { watch: LiveWatch | null }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const allRaw = watch?.recent_errors ?? [];
  const all = useMemo(
    () => allRaw.filter((e) => !hidden.has(e.id)),
    [allRaw, hidden],
  );
  const stats = watch?.error_stats;
  const items = useMemo(() => {
    if (filter === "all") return all;
    if (filter === "attention") {
      return all.filter((e) => errorPresentation(e).kind === "incident");
    }
    if (filter === "transient") {
      return all.filter((e) => errorPresentation(e).kind === "transient");
    }
    return all.filter((e) => e.level === filter);
  }, [all, filter]);

  const attentionCount = useMemo(
    () => all.filter((e) => errorPresentation(e).kind === "incident").length,
    [all],
  );

  async function runDismiss(opts: { ids?: number[]; all?: boolean }) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await dismissErrors(opts);
      if (opts.all) {
        setHidden(new Set(allRaw.map((e) => e.id)));
      } else if (opts.ids?.length) {
        setHidden((prev) => {
          const next = new Set(prev);
          for (const id of opts.ids!) next.add(id);
          return next;
        });
      }
      toast({
        title: opts.all ? "Dismissed all errors" : "Dismissed",
        detail: `${res.dismissed} hidden`,
        tone: "ok",
        kind: "event",
      });
    } catch (e) {
      toast({
        title: "Dismiss failed",
        detail: (e as Error).message,
        tone: "danger",
        kind: "event",
      });
    } finally {
      setBusy(false);
    }
  }

  async function runClear() {
    if (busy) return;
    const ok = window.confirm(
      "Permanently delete ALL rows in the error log?\n\nDismiss only hides them; Clear removes them from the DB so it doesn’t keep growing.",
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await clearErrorLog();
      setHidden(new Set(allRaw.map((e) => e.id)));
      setOpenId(null);
      toast({
        title: "Error log cleared",
        detail: `${res.cleared} rows deleted`,
        tone: "ok",
        kind: "event",
      });
    } catch (e) {
      toast({
        title: "Clear failed",
        detail: (e as Error).message,
        tone: "danger",
        kind: "event",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display flex items-center gap-2 text-lg font-semibold tracking-wide">
            <Icon icon={OctagonX} size={18} className="text-danger" />
            Errors
          </h1>
          <p className="text-[11px] text-dim">
            Labeled runtime log — transient API blips are warnings, not bot failures.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            className="inline-flex items-center gap-1 border border-grid px-2.5 py-1.5 text-[10px] tracking-wider text-muted uppercase hover:text-hover"
            disabled={!items.length || busy}
            onClick={() => {
              void (async () => {
                const ok = await copyText(formatErrorLogDump(items, watch));
                toast({
                  title: ok ? "Copied error log" : "Copy failed",
                  detail: ok ? `${items.length} entries` : "Clipboard blocked",
                  tone: ok ? "ok" : "danger",
                  kind: "event",
                });
              })();
            }}
          >
            <Icon icon={Copy} size={11} />
            Copy all
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 border border-grid px-2.5 py-1.5 text-[10px] tracking-wider text-muted uppercase hover:border-ok/60 hover:text-ok disabled:opacity-40"
            disabled={!all.length || busy}
            onClick={() => void runDismiss({ all: true })}
            title="Hide every undismissed error from the live log (kept in DB)"
          >
            <Icon icon={X} size={11} />
            Dismiss all
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 border border-grid px-2.5 py-1.5 text-[10px] tracking-wider text-muted uppercase hover:border-danger/60 hover:text-danger disabled:opacity-40"
            disabled={busy}
            onClick={() => void runClear()}
            title="Permanently delete all error_log rows from the database"
          >
            <Icon icon={Trash2} size={11} />
            Clear log
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-[11px]">
        <Badge tone="danger">attention {attentionCount}</Badge>
        <Badge tone="warn">24h {stats?.count_24h ?? 0}</Badge>
        <Badge tone="fg">{all.length} loaded</Badge>
        {(["all", "attention", "transient", "warn", "fatal"] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            className={`border px-2 py-0.5 text-[10px] tracking-wider uppercase ${
              filter === f ? "border-ok/70 text-ok" : "border-grid text-dim hover:text-muted"
            }`}
            onClick={() => setFilter(f)}
          >
            {f === "attention" ? "needs attention" : f}
            {f === "attention" ? ` ${attentionCount}` : f !== "all" ? ` ${all.filter((e) => {
              if (f === "transient") return errorPresentation(e).kind === "transient";
              return e.level === f;
            }).length}` : ""}
          </button>
        ))}
      </div>

      <Panel
        title="Live error log"
        right={<Badge tone={attentionCount ? "danger" : "ok"}>{attentionCount}</Badge>}
      >
        {!items.length ? (
          <div className="flex items-center gap-2 py-6 justify-center text-[12px] text-dim">
            <Icon icon={Check} size={14} className="text-ok" />
            No errors in the live window
            {filter !== "all" ? ` (filter: ${filter})` : ""}.
          </div>
        ) : (
          <ul>
            {items.map((e) => (
              <ErrorRow
                key={e.id}
                e={e}
                watch={watch}
                expanded={openId === e.id}
                onToggle={() => setOpenId((id) => (id === e.id ? null : e.id))}
                busy={busy}
                onDismiss={() => void runDismiss({ ids: [e.id] })}
              />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
