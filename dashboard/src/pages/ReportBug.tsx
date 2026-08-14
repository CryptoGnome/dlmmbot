import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveStatus } from "@/lib/api";
import type { LiveWatch } from "@/lib/types";
import { Badge, Panel } from "@/components/ui";
import { Icon } from "@/lib/icons";
import {
  BUG_AREAS,
  BUG_CATEGORIES,
  BUG_HOSTS,
  BUG_SEVERITIES,
  ENHANCEMENT_IMPACTS,
  buildBugReportBody,
  bugReportIssueUrl,
  copyImageFile,
  defaultBugForm,
  guessHost,
  isEnhancement,
  type BugReportForm,
  type ReportAttachment,
} from "@/lib/bugReport";
import { copyText } from "@/lib/errorReport";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Bug, Copy, ExternalLink, ImagePlus, X } from "lucide-react";

const MAX_SHOTS = 3;
const MAX_SHOT_BYTES = 2 * 1024 * 1024;

function ChipRow<T extends string>({
  options,
  value,
  onChange,
  hintKey,
}: {
  options: { id: T; label: string; hint?: string }[];
  value: T;
  onChange: (v: T) => void;
  hintKey?: "hint";
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          title={hintKey ? o[hintKey] : undefined}
          onClick={() => onChange(o.id)}
          className={cn(
            "border px-2.5 py-1.5 text-[11px] tracking-wide transition-colors",
            value === o.id
              ? "border-ok bg-ok/10 text-ok"
              : "border-grid text-muted hover:border-dim hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ReportBugPage({
  watch,
  live,
}: {
  watch: LiveWatch | null;
  live: LiveStatus;
}) {
  const [form, setForm] = useState<BugReportForm>(() => defaultBugForm());
  const [attachments, setAttachments] = useState<ReportAttachment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const ws = live === "open" ? "connected" : live === "connecting" ? "connecting" : "disconnected";
  const errN = watch?.error_stats?.count_1h ?? 0;
  const enhancement = isEnhancement(form);
  const shotNames = form.includeScreenshots ? attachments.map((a) => a.file.name) : [];
  const preview = useMemo(
    () => buildBugReportBody(form, watch, ws, shotNames),
    [form, watch, ws, shotNames],
  );
  const issueUrl = useMemo(
    () => bugReportIssueUrl(form, watch, ws, shotNames),
    [form, watch, ws, shotNames],
  );

  useEffect(() => {
    const host = guessHost(watch);
    if (host !== "unknown") setForm((f) => (f.host === "unknown" ? { ...f, host } : f));
  }, [watch?.host]);

  useEffect(() => {
    return () => {
      attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    };
  }, [attachments]);

  const set = <K extends keyof BugReportForm>(key: K, val: BugReportForm[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  const setCategory = (category: BugReportForm["category"]) => {
    setForm((f) => ({
      ...f,
      category,
      includeErrors: category === "enhancement" ? false : f.includeErrors,
    }));
  };

  const canSubmit = form.summary.trim().length >= 8;

  function addFiles(files: FileList | File[]) {
    const next = [...attachments];
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        toast({ title: "Images only", detail: file.name, tone: "warn", kind: "event" });
        continue;
      }
      if (file.size > MAX_SHOT_BYTES) {
        toast({ title: "Too large", detail: `${file.name} — max 2 MB`, tone: "warn", kind: "event" });
        continue;
      }
      if (next.length >= MAX_SHOTS) {
        toast({ title: "Limit reached", detail: `Max ${MAX_SHOTS} screenshots`, tone: "warn", kind: "event" });
        break;
      }
      next.push({
        id: `${Date.now()}-${file.name}`,
        file,
        previewUrl: URL.createObjectURL(file),
      });
    }
    setAttachments(next);
    if (next.length && !form.includeScreenshots) set("includeScreenshots", true);
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      const hit = prev.find((a) => a.id === id);
      if (hit) URL.revokeObjectURL(hit.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }

  async function openIssue() {
    if (!canSubmit) {
      toast({
        title: "Add a short summary first",
        detail: "At least 8 characters so the GitHub title makes sense.",
        tone: "warn",
        kind: "event",
      });
      return;
    }
    window.open(issueUrl, "_blank", "noopener,noreferrer");
    if (form.includeScreenshots && attachments.length) {
      const ok = await copyImageFile(attachments[0].file);
      toast({
        title: ok ? "Issue opened — paste screenshot" : "Issue opened",
        detail: ok
          ? attachments.length > 1
            ? `First of ${attachments.length} copied — Ctrl+V in GitHub. Use Copy on others below.`
            : "Screenshot copied — Ctrl+V in the GitHub issue body."
          : `Add ${attachments.length} screenshot(s) manually in GitHub (drag-drop or paste).`,
        tone: ok ? "ok" : "warn",
        kind: "event",
      });
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 max-w-2xl">
          <h1 className="font-display flex items-center gap-2 text-lg font-semibold tracking-wide">
            <Icon icon={Bug} size={18} className="text-accent" />
            Report
          </h1>
          <p className="mt-1 text-[12px] leading-relaxed text-dim">
            Bug or enhancement — pick a type, describe it, optionally attach screenshots,
            and open a prefilled GitHub issue. Build context attaches automatically.
          </p>
        </div>
        {errN > 0 ? (
          <Badge tone="danger" title="Errors in the last hour">{errN} err / 1h</Badge>
        ) : null}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="space-y-3">
          <Panel title="What is it?">
            <div className="space-y-3">
              <div>
                <div className="mb-1.5 text-[10px] tracking-[0.14em] text-dim uppercase">Type</div>
                <ChipRow
                  options={BUG_CATEGORIES}
                  value={form.category}
                  onChange={setCategory}
                  hintKey="hint"
                />
              </div>
              <div>
                <div className="mb-1.5 text-[10px] tracking-[0.14em] text-dim uppercase">Area</div>
                <ChipRow options={BUG_AREAS} value={form.area} onChange={(v) => set("area", v)} />
              </div>
              <div>
                <div className="mb-1.5 text-[10px] tracking-[0.14em] text-dim uppercase">
                  {enhancement ? "Impact" : "Severity"}
                </div>
                <ChipRow
                  options={enhancement ? ENHANCEMENT_IMPACTS : BUG_SEVERITIES}
                  value={enhancement ? form.impact : form.severity}
                  onChange={(v) => set(enhancement ? "impact" : "severity", v as never)}
                  hintKey="hint"
                />
              </div>
              <div>
                <div className="mb-1.5 text-[10px] tracking-[0.14em] text-dim uppercase">Where running</div>
                <ChipRow options={BUG_HOSTS} value={form.host} onChange={(v) => set("host", v)} />
              </div>
            </div>
          </Panel>

          <Panel title={enhancement ? "Propose a change" : "Describe it"}>
            <div className="space-y-3">
              <label className="block">
                <span className="text-[10px] tracking-[0.14em] text-dim uppercase">
                  {enhancement ? "Proposal" : "Summary"}
                </span>
                <textarea
                  className="input-field mt-1 min-h-[4.5rem] resize-y"
                  placeholder={
                    enhancement
                      ? "What should change? One or two sentences."
                      : "One or two sentences — what broke or confused you?"
                  }
                  value={form.summary}
                  onChange={(e) => set("summary", e.target.value)}
                />
              </label>

              {enhancement ? (
                <>
                  <label className="block">
                    <span className="text-[10px] tracking-[0.14em] text-dim uppercase">Suggested change</span>
                    <textarea
                      className="input-field mt-1 min-h-[5rem] resize-y text-[11px]"
                      placeholder="Concrete behavior, UI, config knob, or docs tweak…"
                      value={form.proposal}
                      onChange={(e) => set("proposal", e.target.value)}
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] tracking-[0.14em] text-dim uppercase">Why it helps</span>
                    <textarea
                      className="input-field mt-1 min-h-[4rem] resize-y text-[11px]"
                      placeholder="Operator pain this solves, workflow it improves…"
                      value={form.why}
                      onChange={(e) => set("why", e.target.value)}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="block">
                    <span className="text-[10px] tracking-[0.14em] text-dim uppercase">Steps to reproduce</span>
                    <textarea
                      className="input-field mt-1 min-h-[5rem] resize-y font-mono text-[11px]"
                      placeholder={"1. Open Settings\n2. Change …\n3. See …"}
                      value={form.steps}
                      onChange={(e) => set("steps", e.target.value)}
                    />
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="text-[10px] tracking-[0.14em] text-dim uppercase">Expected</span>
                      <textarea
                        className="input-field mt-1 min-h-[4rem] resize-y text-[11px]"
                        placeholder="What should have happened?"
                        value={form.expected}
                        onChange={(e) => set("expected", e.target.value)}
                      />
                    </label>
                    <label className="block">
                      <span className="text-[10px] tracking-[0.14em] text-dim uppercase">Actual</span>
                      <textarea
                        className="input-field mt-1 min-h-[4rem] resize-y text-[11px]"
                        placeholder="What happened instead?"
                        value={form.actual}
                        onChange={(e) => set("actual", e.target.value)}
                      />
                    </label>
                  </div>
                  <label className="flex cursor-pointer items-start gap-2 text-[11px] text-muted">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-ok"
                      checked={form.includeErrors}
                      onChange={(e) => set("includeErrors", e.target.checked)}
                    />
                    <span>
                      Attach up to 3 recent errors from the Errors tab
                      {watch?.recent_errors?.length
                        ? ` (${Math.min(3, watch.recent_errors.length)} available)`
                        : " (none right now)"}
                    </span>
                  </label>
                </>
              )}
            </div>
          </Panel>

          <Panel title="Screenshots (optional)">
            <div className="space-y-3">
              <label className="flex cursor-pointer items-start gap-2 text-[11px] text-muted">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-ok"
                  checked={form.includeScreenshots}
                  onChange={(e) => {
                    set("includeScreenshots", e.target.checked);
                    if (!e.target.checked) setAttachments([]);
                  }}
                />
                <span>Include screenshots in this report (paste into GitHub after the issue opens)</span>
              </label>

              {form.includeScreenshots ? (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.length) addFiles(e.target.files);
                      e.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={attachments.length >= MAX_SHOTS}
                    className="inline-flex items-center gap-2 border border-dashed border-grid px-3 py-2 text-[11px] tracking-wide text-muted hover:border-dim hover:text-fg disabled:opacity-40"
                  >
                    <Icon icon={ImagePlus} size={14} />
                    Add screenshot{attachments.length ? ` (${attachments.length}/${MAX_SHOTS})` : ""}
                  </button>
                  {attachments.length ? (
                    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {attachments.map((a) => (
                        <li key={a.id} className="relative border border-grid bg-panel">
                          <img
                            src={a.previewUrl}
                            alt=""
                            className="aspect-video w-full object-cover object-top"
                          />
                          <div className="flex items-center justify-between gap-1 border-t border-grid px-1.5 py-1">
                            <span className="min-w-0 truncate font-mono text-[9px] text-dim">{a.file.name}</span>
                            <div className="flex shrink-0 gap-0.5">
                              <button
                                type="button"
                                title="Copy image"
                                className="p-0.5 text-dim hover:text-fg"
                                onClick={() => {
                                  void (async () => {
                                    const ok = await copyImageFile(a.file);
                                    toast({
                                      title: ok ? "Screenshot copied" : "Copy failed",
                                      detail: ok ? "Paste into GitHub with Ctrl+V" : "Try drag-drop in GitHub",
                                      tone: ok ? "ok" : "danger",
                                      kind: "event",
                                    });
                                  })();
                                }}
                              >
                                <Icon icon={Copy} size={10} />
                              </button>
                              <button
                                type="button"
                                title="Remove"
                                className="p-0.5 text-dim hover:text-danger"
                                onClick={() => removeAttachment(a.id)}
                              >
                                <Icon icon={X} size={10} />
                              </button>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[10px] text-dim">PNG/JPG/WebP, max 2 MB each. Not uploaded anywhere until you paste in GitHub.</p>
                  )}
                </>
              ) : null}
            </div>
          </Panel>
        </div>

        <div className="space-y-3">
          <Panel title="Auto-filled context">
            <ul className="space-y-1 text-[11px] text-muted">
              <li>Mode: <span className="text-fg">{(watch?.heartbeat?.mode ?? "—").toLowerCase() || "—"}</span></li>
              <li>Build: <span className="font-mono text-fg">{watch?.build?.describe ?? watch?.build?.head ?? "—"}</span></li>
              <li>Host: <span className="font-mono text-fg">{watch?.host ?? "—"}</span></li>
              <li>Open: <span className="tabular-nums text-fg">{watch?.open?.length ?? "—"}</span></li>
            </ul>
          </Panel>

          <Panel title="Preview" bodyClassName="p-0">
            <pre className="max-h-[16rem] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[10px] leading-relaxed text-dim">
              {preview}
            </pre>
          </Panel>

          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => void openIssue()}
              className="inline-flex w-full items-center justify-center gap-2 border border-accent/60 bg-accent/10 px-3 py-2.5 text-[11px] tracking-[0.12em] text-accent uppercase transition-colors hover:border-accent hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Open GitHub issue
              <Icon icon={ExternalLink} size={12} />
            </button>
            <button
              type="button"
              className="inline-flex w-full items-center justify-center gap-2 border border-grid px-3 py-2 text-[10px] tracking-wider text-muted uppercase hover:text-fg"
              onClick={() => {
                void (async () => {
                  const ok = await copyText(preview);
                  toast({
                    title: ok ? "Copied report" : "Copy failed",
                    detail: ok ? "Paste into GitHub if the link truncates." : "Clipboard blocked",
                    tone: ok ? "ok" : "danger",
                    kind: "event",
                  });
                })();
              }}
            >
              <Icon icon={Copy} size={10} />
              Copy full text
            </button>
            <p className="text-[10px] leading-snug text-dim">
              Opens <span className="text-muted">CryptoGnome/dlmmbot</span> in a new tab.
              Screenshots stay local until you paste them into GitHub — nothing uploads automatically.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
