import { useEffect, useMemo, useState } from "react";
import { Badge, Panel } from "@/components/ui";
import { Icon } from "@/lib/icons";
import { WIKI_SECTIONS, wikiSectionById } from "@/wiki/content";
import type { WikiBlock, WikiTone } from "@/wiki/types";
import { BookMarked, Search } from "lucide-react";

function toneClass(tone: WikiTone): string {
  return {
    ok: "border-ok/50 text-ok",
    warn: "border-warn/50 text-warn",
    accent: "border-accent/50 text-accent",
    danger: "border-danger/50 text-danger",
    fg: "border-grid text-fg",
  }[tone];
}

function BlockView({ block }: { block: WikiBlock }) {
  switch (block.type) {
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
        <ul className="list-disc space-y-1.5 pl-4 text-[13px] leading-relaxed text-muted">
          {block.items.map((item) => (
            <li key={item}>{item}</li>
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
              <tr className="border-b border-grid bg-panel/40">
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
                      className={`px-2.5 py-2 leading-snug text-muted ${j === 0 ? "whitespace-nowrap text-fg" : ""}`}
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
        <div className={`border px-3 py-2.5 ${toneClass(block.tone)}`}>
          {block.title ? (
            <div className="mb-1 text-[10px] font-semibold tracking-[0.14em] uppercase opacity-90">
              {block.title}
            </div>
          ) : null}
          <p className="text-[12px] leading-relaxed text-fg/90">{block.text}</p>
        </div>
      );
    default:
      return null;
  }
}

function sectionMatches(q: string, id: string, title: string, summary: string, blocks: WikiBlock[]): boolean {
  if (!q) return true;
  const hay = [
    id,
    title,
    summary,
    ...blocks.flatMap((b) => {
      if (b.type === "p" || b.type === "h3" || b.type === "callout") return [b.text, "title" in b ? b.title ?? "" : ""];
      if (b.type === "ul" || b.type === "ol") return b.items;
      if (b.type === "table") return [...b.headers, ...b.rows.flat()];
      return [];
    }),
  ].join("\n").toLowerCase();
  return hay.includes(q);
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
    return WIKI_SECTIONS.filter((s) => sectionMatches(q, s.id, s.title, s.summary, s.blocks));
  }, [query]);

  const section = wikiSectionById(
    filtered.some((s) => s.id === sectionId) ? sectionId : filtered[0]?.id,
  );

  useEffect(() => {
    const base = "#/wiki";
    const next = section.id === WIKI_SECTIONS[0].id ? base : `${base}?s=${section.id}`;
    if (window.location.hash !== next) window.history.replaceState(null, "", next);
  }, [section.id]);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 max-w-2xl">
          <h1 className="font-display flex items-center gap-2 text-lg font-semibold tracking-wide">
            <Icon icon={BookMarked} size={18} className="text-accent" />
            Wiki
          </h1>
          <p className="mt-1 text-[12px] leading-relaxed text-dim">
            Operator manual for how DLMM Bot scans, sizes, manages, and exits — plus what each
            dashboard surface means. Mirrors STRATEGY.md; live knobs still come from Settings / config.toml.
          </p>
        </div>
        <label className="relative block w-full sm:w-64">
          <Icon
            icon={Search}
            size={12}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-dim"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search wiki…"
            className="w-full border border-grid bg-transparent py-1.5 pr-2 pl-7 text-[12px] text-fg placeholder:text-dim"
          />
        </label>
      </div>

      <div className="grid gap-3 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav className="panel h-fit max-h-[70vh] overflow-y-auto lg:sticky lg:top-0">
          <div className="border-b border-grid px-3 py-1.5 text-[10px] tracking-[0.14em] text-dim uppercase">
            Contents
          </div>
          <ul className="py-1">
            {filtered.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-panel/80 ${
                    s.id === section.id ? "border-l-2 border-accent bg-accent/5" : "border-l-2 border-transparent"
                  }`}
                  onClick={() => setSectionId(s.id)}
                >
                  <span className={`text-[12px] ${s.id === section.id ? "text-fg" : "text-muted"}`}>
                    {s.title}
                  </span>
                  <span className="text-[10px] leading-snug text-dim line-clamp-2">{s.summary}</span>
                </button>
              </li>
            ))}
            {!filtered.length ? (
              <li className="px-3 py-3 text-[11px] text-dim">No sections match.</li>
            ) : null}
          </ul>
        </nav>

        <Panel
          title={section.title}
          right={<Badge tone="accent">{section.id}</Badge>}
          bodyClassName="space-y-3"
        >
          <p className="text-[12px] leading-relaxed text-dim">{section.summary}</p>
          {section.blocks.map((b, i) => (
            <BlockView key={i} block={b} />
          ))}
        </Panel>
      </div>
    </div>
  );
}
