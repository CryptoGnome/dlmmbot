import { useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  Ban,
  BookMarked,
  Boxes,
  Calculator,
  Check,
  ChevronRight,
  Coins,
  GitBranch,
  Layers,
  LayoutDashboard,
  LineChart,
  ListOrdered,
  Lock,
  Pause,
  Play,
  Radar,
  RefreshCw,
  Repeat2,
  Scale,
  Search,
  Shield,
  Sparkles,
  Wallet,
  X,
  Zap,
  Bot,
} from "lucide-react";
import { Badge, Panel } from "@/components/ui";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { WIKI_SECTIONS, wikiSectionById } from "@/wiki/content";
import type { WikiBlock, WikiIconKey, WikiSection, WikiTone } from "@/wiki/types";

const ICONS: Record<WikiIconKey, LucideIcon> = {
  radar: Radar,
  shield: Shield,
  coins: Coins,
  chart: LineChart,
  exit: ArrowDownToLine,
  bank: Wallet,
  bot: Bot,
  boxes: Boxes,
  layers: Layers,
  scan: Radar,
  entry: ArrowDownToLine,
  priority: ListOrdered,
  follow: Repeat2,
  scale: Scale,
  ban: Ban,
  layout: LayoutDashboard,
  refresh: RefreshCw,
  calc: Calculator,
  alert: AlertTriangle,
  book: BookMarked,
  zap: Zap,
  lock: Lock,
  play: Play,
  pause: Pause,
  check: Check,
  x: X,
};

/** Full chip/callout color — only when the tone carries meaning (halt, ban, caution). */
function toneChip(tone: WikiTone | undefined): string {
  switch (tone) {
    case "ok": return "border-ok/50 bg-ok/10 text-ok";
    case "warn": return "border-warn/50 bg-warn/10 text-warn";
    case "accent": return "border-accent/50 bg-accent/10 text-accent";
    case "danger": return "border-danger/50 bg-danger/10 text-danger";
    default: return "border-grid bg-panel text-fg";
  }
}

/** Icon-only accent — keeps cards/flows readable without painting whole tiles. */
function toneIcon(tone: WikiTone | undefined): string {
  switch (tone) {
    case "ok": return "border-ok/40 text-ok";
    case "warn": return "border-warn/40 text-warn";
    case "accent": return "border-accent/40 text-accent";
    case "danger": return "border-danger/40 text-danger";
    default: return "border-grid text-dim";
  }
}

function WikiGlyph({ name, size = 14, className }: { name?: WikiIconKey; size?: number; className?: string }) {
  const I = name ? ICONS[name] : Sparkles;
  return <Icon icon={I} size={size} className={className} />;
}

function blockSearchText(b: WikiBlock): string[] {
  switch (b.type) {
    case "tldr":
    case "p":
    case "h3":
      return [b.text];
    case "callout":
      return [b.text, b.title ?? ""];
    case "ul":
    case "ol":
      return b.items;
    case "table":
      return [...b.headers, ...b.rows.flat()];
    case "flow":
      return [b.title ?? "", ...b.steps.flatMap((s) => [s.label, s.detail ?? ""])];
    case "steps":
      return b.items.flatMap((s) => [s.title, s.text]);
    case "cards":
      return b.items.flatMap((c) => [c.title, c.text, c.badge ?? ""]);
    case "ladder":
      return [b.title ?? "", ...b.items.flatMap((i) => [i.code, i.title, i.when, i.then])];
    default:
      return [];
  }
}

function sectionMatches(q: string, s: WikiSection): boolean {
  if (!q) return true;
  const hay = [s.id, s.title, s.simple, s.summary, ...s.blocks.flatMap(blockSearchText)].join("\n").toLowerCase();
  return hay.includes(q);
}

function FlowBlock({
  title,
  steps,
}: {
  title?: string;
  steps: { label: string; detail?: string; icon?: WikiIconKey; tone?: WikiTone }[];
}) {
  return (
    <div className="space-y-2">
      {title ? (
        <div className="text-[10px] font-semibold tracking-[0.14em] text-dim uppercase">{title}</div>
      ) : null}
      <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-stretch">
        {steps.map((s, i) => (
          <div key={`${s.label}-${i}`} className="contents md:flex md:min-w-0 md:flex-1 md:basis-[8.5rem] md:items-stretch md:gap-2">
            <div className="flex min-w-0 flex-col gap-1.5 border border-grid bg-panel px-2.5 py-2.5 md:flex-1">
              <div className="flex items-center gap-2">
                <span className={cn("inline-flex h-6 w-6 items-center justify-center border", toneIcon(s.tone))}>
                  <WikiGlyph name={s.icon} size={13} />
                </span>
                <span className="text-[10px] tracking-wider text-dim tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              <div className="font-display text-[13px] font-semibold leading-tight text-fg">{s.label}</div>
              {s.detail ? <div className="text-[11px] leading-snug text-muted">{s.detail}</div> : null}
            </div>
            {i < steps.length - 1 ? (
              <>
                <div className="flex justify-center py-0.5 text-dim md:hidden" aria-hidden>
                  <Icon icon={ArrowRight} size={12} className="rotate-90" />
                </div>
                <div className="hidden items-center text-dim md:flex" aria-hidden>
                  <Icon icon={ChevronRight} size={14} />
                </div>
              </>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function StepsBlock({
  items,
}: {
  items: { title: string; text: string; icon?: WikiIconKey }[];
}) {
  return (
    <ol className="space-y-0 border border-grid">
      {items.map((item, i) => (
        <li
          key={item.title}
          className="flex gap-3 border-t border-grid px-3 py-3 first:border-0"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-accent/50 bg-accent/10 text-accent">
            <WikiGlyph name={item.icon} size={14} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[10px] tracking-wider text-dim tabular-nums">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="font-display text-[13px] font-semibold text-fg">{item.title}</span>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">{item.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function CardsBlock({
  items,
}: {
  items: { title: string; text: string; badge?: string; tone?: WikiTone; icon?: WikiIconKey }[];
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {items.map((c) => (
        <div key={c.title} className="flex gap-2.5 border border-grid bg-panel px-3 py-2.5">
          <span className={cn("mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center border", toneIcon(c.tone))}>
            <WikiGlyph name={c.icon} size={13} />
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-display text-[13px] font-semibold text-fg">{c.title}</span>
              {c.badge ? (
                <Badge tone={c.tone && c.tone !== "fg" ? c.tone : "fg"}>{c.badge}</Badge>
              ) : null}
            </div>
            <p className="text-[12px] leading-relaxed text-muted">{c.text}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function LadderBlock({
  title,
  items,
}: {
  title?: string;
  items: { code: string; title: string; when: string; then: string; tone: WikiTone }[];
}) {
  return (
    <div className="space-y-2">
      {title ? (
        <div className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.14em] text-dim uppercase">
          <Icon icon={GitBranch} size={12} className="text-accent" />
          {title}
        </div>
      ) : null}
      <div className="relative space-y-2 before:absolute before:top-3 before:bottom-3 before:left-[1.15rem] before:w-px before:bg-grid">
        {items.map((item, i) => (
          <div key={item.code} className="relative flex gap-3">
            <div
              className={cn(
                "relative z-[1] flex h-9 w-9 shrink-0 items-center justify-center border text-[10px] font-semibold tracking-wider",
                toneChip(item.tone),
              )}
            >
              {item.code}
            </div>
            <div className="min-w-0 flex-1 border border-grid px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-display text-[13px] font-semibold text-fg">{item.title}</span>
                {i === 0 ? <Badge tone="danger">checks first</Badge> : null}
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <div>
                  <div className="text-[9px] tracking-[0.14em] text-dim uppercase">If</div>
                  <p className="mt-0.5 text-[12px] leading-snug text-muted">{item.when}</p>
                </div>
                <div>
                  <div className="text-[9px] tracking-[0.14em] text-dim uppercase">Then</div>
                  <p className="mt-0.5 text-[12px] leading-snug text-fg/90">{item.then}</p>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BlockView({ block }: { block: WikiBlock }) {
  switch (block.type) {
    case "tldr":
      return (
        <div className="border border-grid bg-bg/40 px-3 py-3">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.14em] text-dim uppercase">
            <Icon icon={Sparkles} size={11} />
            In plain English
          </div>
          <p className="text-[13px] leading-relaxed text-fg">{block.text}</p>
        </div>
      );
    case "p":
      return <p className="text-[13px] leading-relaxed text-muted">{block.text}</p>;
    case "h3":
      return (
        <h3 className="pt-1 text-[11px] font-semibold tracking-[0.14em] text-dim uppercase">
          {block.text}
        </h3>
      );
    case "ul":
      return (
        <ul className="space-y-2">
          {block.items.map((item) => (
            <li key={item} className="flex gap-2 text-[13px] leading-relaxed text-muted">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 bg-accent" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="list-decimal space-y-1.5 pl-4 text-[13px] leading-relaxed text-muted">
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      );
    case "table":
      return (
        <div className="overflow-x-auto border border-grid">
          <table className="w-full min-w-[28rem] border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-grid bg-bg/40">
                {block.headers.map((h) => (
                  <th key={h} className="px-2.5 py-1.5 font-semibold tracking-wider text-dim uppercase">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="border-t border-grid align-top">
                  {row.map((cell, j) => (
                    <td
                      key={`${i}-${j}`}
                      className={cn("px-2.5 py-2 leading-snug text-muted", j === 0 && "whitespace-nowrap text-fg")}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "callout":
      return (
        <div className={cn("border px-3 py-2.5", toneChip(block.tone))}>
          {block.title ? (
            <div className="mb-1 text-[10px] font-semibold tracking-[0.14em] uppercase opacity-90">
              {block.title}
            </div>
          ) : null}
          <p className="text-[12px] leading-relaxed text-fg/90">{block.text}</p>
        </div>
      );
    case "flow":
      return <FlowBlock title={block.title} steps={block.steps} />;
    case "steps":
      return <StepsBlock items={block.items} />;
    case "cards":
      return <CardsBlock items={block.items} />;
    case "ladder":
      return <LadderBlock title={block.title} items={block.items} />;
    default:
      return null;
  }
}

export function WikiPage() {
  const [sectionId, setSectionId] = useState(() => {
    if (typeof window === "undefined") return WIKI_SECTIONS[0].id;
    const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    return q.get("s") || WIKI_SECTIONS[0].id;
  });
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return WIKI_SECTIONS.filter((s) => sectionMatches(q, s));
  }, [query]);

  const section = wikiSectionById(
    filtered.some((s) => s.id === sectionId) ? sectionId : filtered[0]?.id,
  );

  useEffect(() => {
    const base = "#/wiki";
    const next = section.id === WIKI_SECTIONS[0].id ? base : `${base}?s=${section.id}`;
    if (window.location.hash !== next) window.history.replaceState(null, "", next);
  }, [section.id]);

  const overviewFlow = WIKI_SECTIONS[0]?.blocks.find((b) => b.type === "flow");

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 max-w-2xl">
          <h1 className="font-display flex items-center gap-2 text-lg font-semibold tracking-wide">
            <Icon icon={BookMarked} size={18} className="text-accent" />
            Wiki
          </h1>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            New here? Start at <span className="text-fg">Big picture</span>, follow the arrows,
            then open any topic. Written so you can learn the bot without reading STRATEGY.md first.
          </p>
        </div>
        <label className="relative block w-full lg:w-64">
          <Icon
            icon={Search}
            size={12}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-dim"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search in plain words…"
            className="w-full border border-grid bg-transparent py-1.5 pr-2 pl-7 text-[12px] text-fg placeholder:text-dim"
          />
        </label>
      </div>

      {overviewFlow && overviewFlow.type === "flow" && !query ? (
        <Panel title="60-second tour" right={<Badge tone="accent">start here</Badge>} bodyClassName="space-y-3">
          <FlowBlock steps={overviewFlow.steps} />
          <button
            type="button"
            className="text-[11px] tracking-wider text-accent uppercase hover:text-hover"
            onClick={() => setSectionId("overview")}
          >
            Open Big picture →
          </button>
        </Panel>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[15.5rem_minmax(0,1fr)]">
        <nav className="panel h-fit max-h-[70vh] overflow-y-auto lg:sticky lg:top-0">
          <div className="border-b border-grid px-3 py-1.5 text-[10px] tracking-[0.14em] text-dim uppercase">
            Topics
          </div>
          <ul className="py-1">
            {filtered.map((s) => {
              const active = s.id === section.id;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-panel/80",
                      active ? "border-l-2 border-accent bg-accent/5" : "border-l-2 border-transparent",
                    )}
                    onClick={() => setSectionId(s.id)}
                  >
                    <span
                      className={cn(
                        "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center border",
                        active ? "border-accent/60 text-accent" : "border-grid text-dim",
                      )}
                    >
                      <WikiGlyph name={s.icon} size={12} />
                    </span>
                    <span className="min-w-0">
                      <span className={cn("block text-[12px]", active ? "text-fg" : "text-muted")}>
                        {s.title}
                      </span>
                      <span className="mt-0.5 block text-[10px] leading-snug text-dim line-clamp-2">
                        {s.simple}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {!filtered.length ? (
              <li className="px-3 py-3 text-[11px] text-dim">Nothing matched — try “halt” or “P0”.</li>
            ) : null}
          </ul>
        </nav>

        <Panel
          title={section.title}
          right={
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-flex h-6 w-6 items-center justify-center border border-accent/50 text-accent">
                <WikiGlyph name={section.icon} size={12} />
              </span>
              <Badge tone="accent">{section.id}</Badge>
            </span>
          }
          bodyClassName="space-y-4"
        >
          <div className="border border-grid bg-bg/40 px-3 py-2.5">
            <div className="text-[10px] font-semibold tracking-[0.14em] text-dim uppercase">
              Remember this
            </div>
            <p className="mt-1 font-display text-[15px] leading-snug font-semibold text-fg">
              {section.simple}
            </p>
          </div>
          <p className="text-[12px] leading-relaxed text-dim">{section.summary}</p>
          {section.blocks.map((b, i) => (
            <BlockView key={i} block={b} />
          ))}
        </Panel>
      </div>
    </div>
  );
}
