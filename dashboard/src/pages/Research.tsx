import { Badge, Panel } from "@/components/ui";
import { Icon } from "@/lib/icons";
import {
  PLAYBOOK_NOTES,
  RESEARCH_CREDITS,
  researchSuggestionIssueUrl,
} from "@/lib/researchCredits";
import { ExternalLink, Lightbulb, Microscope } from "lucide-react";

export function ResearchPage() {
  const suggestUrl = researchSuggestionIssueUrl();

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 max-w-2xl">
          <h1 className="font-display flex items-center gap-2 text-lg font-semibold tracking-wide">
            <Icon icon={Microscope} size={18} className="text-accent" />
            Research
          </h1>
          <p className="mt-1 text-[12px] leading-relaxed text-dim">
            Public voices on X whose Meteora DLMM talk we studied while building DLMM Bot.
            Credits only — not partners, not signals, not financial advice. We kept what survived
            our ledger and dropped what was just APR screenshots.
          </p>
        </div>

        <a
          href={suggestUrl}
          target="_blank"
          rel="noreferrer"
          className="group relative shrink-0 overflow-hidden border border-accent/50 bg-accent/10 px-3.5 py-3 no-underline transition-colors hover:border-accent hover:bg-accent/15 sm:max-w-[16.5rem]"
          title="Opens a prefilled GitHub issue on CryptoGnome/dlmmbot"
        >
          <div className="pointer-events-none absolute -right-4 -top-4 h-16 w-16 rounded-full bg-accent/10 blur-2xl transition-opacity group-hover:opacity-100" />
          <div className="relative flex items-start gap-2.5">
            <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center border border-accent/60 text-accent">
              <Icon icon={Lightbulb} size={14} />
            </span>
            <div className="min-w-0 space-y-1">
              <div className="text-[10px] font-semibold tracking-[0.14em] text-accent uppercase">
                Contribute
              </div>
              <p className="text-[12px] leading-snug text-fg">
                Got research for the bot’s learning library?
              </p>
              <p className="text-[11px] leading-snug text-muted">
                Submit a thread, essay, or playbook — we review it with our agent and note anything that belongs in STRATEGY.
              </p>
              <span className="inline-flex items-center gap-1 pt-0.5 text-[10px] tracking-wider text-accent uppercase">
                Open GitHub issue <Icon icon={ExternalLink} size={10} />
              </span>
            </div>
          </div>
        </a>
      </div>

      <Panel title="On X" right={<Badge tone="accent">{RESEARCH_CREDITS.length}</Badge>}>
        <ul className="divide-y divide-grid">
          {RESEARCH_CREDITS.map((c) => (
            <li key={c.handle} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <a
                    href={c.url ?? `https://x.com/${c.handle}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-display text-[14px] font-semibold text-fg hover:text-hover"
                  >
                    @{c.handle}
                  </a>
                  <span className="text-[11px] text-muted">{c.name}</span>
                  <Badge tone="accent">{c.role}</Badge>
                </div>
                <p className="text-[12px] leading-snug text-dim">{c.note}</p>
              </div>
              <a
                href={c.url ?? `https://x.com/${c.handle}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 self-start border border-grid px-2 py-1 text-[10px] tracking-wider text-muted uppercase hover:border-accent hover:text-accent"
              >
                Open <Icon icon={ExternalLink} size={10} />
              </a>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Playbook names" right={<Badge tone="warn">STRATEGY.md</Badge>}>
        <p className="mb-3 text-[11px] text-dim">
          Nicknames baked into the spec. Some map cleanly to X; others live as Discord / video lore we could not pin to one handle.
        </p>
        <ul className="space-y-3">
          {PLAYBOOK_NOTES.map((p) => (
            <li key={p.name} className="border border-grid px-3 py-2">
              <div className="font-display text-[13px] font-semibold">{p.name}</div>
              <p className="mt-1 text-[12px] leading-snug text-dim">{p.note}</p>
            </li>
          ))}
        </ul>
      </Panel>

      <p className="px-1 text-[10px] leading-relaxed text-dim">
        Missing someone we leaned on? Use{" "}
        <a href={suggestUrl} target="_blank" rel="noreferrer" className="text-accent no-underline hover:text-hover">
          the research issue form
        </a>
        . Opinions are theirs; bugs and losses are ours.
      </p>
    </div>
  );
}
