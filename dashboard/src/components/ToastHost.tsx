import { useEffect, useState } from "react";
import { dismissToast, getToasts, subscribeToasts, type ToastItem, type ToastTone } from "@/lib/toast";
import { Icon, eventGateIcon, feedKindIcon } from "@/lib/icons";
import type { FeedKind } from "@/lib/activityFeed";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

function borderTone(tone: ToastTone) {
  return tone === "ok" ? "border-l-ok"
    : tone === "danger" ? "border-l-danger"
      : tone === "warn" ? "border-l-warn"
        : tone === "accent" ? "border-l-accent"
          : "border-l-grid";
}

function textTone(tone: ToastTone) {
  return tone === "ok" ? "text-ok"
    : tone === "danger" ? "text-danger"
      : tone === "warn" ? "text-warn"
        : tone === "accent" ? "text-accent"
          : "text-muted";
}

function ToastRow({ t }: { t: ToastItem }) {
  const kind = (t.kind ?? "event") as FeedKind;
  const KindIcon = kind === "event" && t.detail
    ? eventGateIcon(undefined)
    : (feedKindIcon[kind] ?? feedKindIcon.event);

  return (
    <div
      role="status"
      className={cn(
        "toast-item panel pointer-events-auto flex w-[min(22rem,calc(100vw-1.5rem))] items-start gap-2.5 border-l-2 px-3 py-2.5 shadow-[0_12px_32px_rgba(0,0,0,0.55)]",
        borderTone(t.tone),
        t.leaving ? "toast-leave" : "toast-enter",
      )}
    >
      <span className={cn("mt-0.5", textTone(t.tone))}>
        <Icon icon={KindIcon} size={13} />
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn("text-[12px] font-medium leading-snug", t.tone === "muted" ? "text-fg" : textTone(t.tone))}>
          {t.title}
        </div>
        {t.detail && (
          <div className="mt-0.5 text-[10px] leading-snug text-dim">{t.detail}</div>
        )}
        {t.action?.onClick && (
          <button
            type="button"
            className="mt-2 inline-flex items-center border border-accent/50 bg-accent/10 px-2 py-1 text-[10px] tracking-wider text-accent uppercase hover:bg-accent/20"
            onClick={() => {
              const fn = t.action?.onClick;
              dismissToast(t.id);
              fn?.();
            }}
          >
            {t.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        className="shrink-0 text-dim hover:text-hover"
        aria-label="Dismiss"
        onClick={() => dismissToast(t.id)}
      >
        <Icon icon={X} size={12} />
      </button>
    </div>
  );
}

export function ToastHost() {
  const [, tick] = useState(0);
  useEffect(() => subscribeToasts(() => tick((n) => n + 1)), []);
  const items = getToasts();
  if (!items.length) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-3 right-3 z-[60] flex flex-col gap-2 md:bottom-4 md:right-4"
      aria-live="polite"
    >
      {items.map((t) => (
        <ToastRow key={t.id} t={t} />
      ))}
    </div>
  );
}
