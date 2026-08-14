import type { LiveWatch } from "./types";
import { formatErrorDump } from "./errorReport";

const REPO = "https://github.com/CryptoGnome/dlmmbot";

export type BugCategory = "bug" | "enhancement" | "setup" | "dashboard" | "strategy";
export type BugArea =
  | "scanner"
  | "vetting"
  | "entry"
  | "manage"
  | "dashboard"
  | "deploy"
  | "wallet"
  | "api"
  | "other";
export type BugSeverity = "blocking" | "annoying" | "cosmetic";
export type EnhancementImpact = "nice" | "helpful" | "important";
export type BugHost = "railway" | "vps" | "local" | "unknown";

export const BUG_CATEGORIES: { id: BugCategory; label: string; hint: string }[] = [
  { id: "bug", label: "Bug", hint: "Wrong behavior or a crash" },
  { id: "enhancement", label: "Enhancement", hint: "Improvement or change — not a bug" },
  { id: "setup", label: "Setup", hint: "Deploy, install, or first run" },
  { id: "dashboard", label: "Dashboard", hint: "This UI or the wizard" },
  { id: "strategy", label: "Trading", hint: "Entries, exits, sizing, sleeves" },
];

export const BUG_AREAS: { id: BugArea; label: string }[] = [
  { id: "scanner", label: "Scanner" },
  { id: "vetting", label: "Vetting" },
  { id: "entry", label: "Entry" },
  { id: "manage", label: "Manage / exits" },
  { id: "dashboard", label: "Dashboard" },
  { id: "deploy", label: "Deploy / updates" },
  { id: "wallet", label: "Wallet" },
  { id: "api", label: "API keys / RPC" },
  { id: "other", label: "Other" },
];

export const BUG_SEVERITIES: { id: BugSeverity; label: string; hint: string }[] = [
  { id: "blocking", label: "Blocking", hint: "Can't trade or bot is stuck" },
  { id: "annoying", label: "Annoying", hint: "Works but wrong or confusing" },
  { id: "cosmetic", label: "Minor", hint: "UI copy, layout, docs" },
];

export const ENHANCEMENT_IMPACTS: { id: EnhancementImpact; label: string; hint: string }[] = [
  { id: "nice", label: "Nice to have", hint: "Polish or convenience" },
  { id: "helpful", label: "Would help", hint: "Clearer ops or fewer mistakes" },
  { id: "important", label: "Important", hint: "Strongly wanted for daily use" },
];

export const BUG_HOSTS: { id: BugHost; label: string }[] = [
  { id: "railway", label: "Railway" },
  { id: "vps", label: "VPS / PM2" },
  { id: "local", label: "Local PC" },
  { id: "unknown", label: "Not sure" },
];

export type BugReportForm = {
  category: BugCategory;
  area: BugArea;
  severity: BugSeverity;
  impact: EnhancementImpact;
  host: BugHost;
  summary: string;
  steps: string;
  expected: string;
  actual: string;
  proposal: string;
  why: string;
  includeErrors: boolean;
  includeScreenshots: boolean;
};

export type ReportAttachment = {
  id: string;
  file: File;
  previewUrl: string;
};

export const defaultBugForm = (): BugReportForm => ({
  category: "bug",
  area: "other",
  severity: "annoying",
  impact: "helpful",
  host: "unknown",
  summary: "",
  steps: "",
  expected: "",
  actual: "",
  proposal: "",
  why: "",
  includeErrors: true,
  includeScreenshots: false,
});

export function isEnhancement(form: Pick<BugReportForm, "category">): boolean {
  return form.category === "enhancement";
}

export function guessHost(watch?: LiveWatch | null): BugHost {
  const h = (watch?.host ?? "").toLowerCase();
  if (h.includes("railway")) return "railway";
  if (h.includes("localhost") || h.includes("127.0.0.1")) return "local";
  if (h) return "vps";
  return "unknown";
}

function label<T extends string>(
  list: { id: T; label: string }[],
  id: T,
): string {
  return list.find((x) => x.id === id)?.label ?? id;
}

function envBlock(watch?: LiveWatch | null, ws?: string): string[] {
  const mode = (watch?.heartbeat?.mode ?? "unknown").toLowerCase();
  const b = watch?.build;
  return [
    "- **Mode:** " + (mode === "live" ? "live" : mode === "paper" ? "paper" : mode),
    "- **Build:** " + (b?.describe ?? b?.head ?? "—"),
    "- **Git sync:** " + (b?.sync ?? "—"),
    "- **Host:** " + (watch?.host ?? "—"),
    "- **Open positions:** " + (watch?.open?.length ?? "—"),
    "- **HB age (s):** " + (watch?.heartbeat_age_s ?? "—"),
    "- **Dashboard WS:** " + (ws ?? "—"),
    "- **Errors (1h):** " + (watch?.error_stats?.count_1h ?? 0),
  ];
}

function screenshotBlock(names: string[]): string[] {
  if (!names.length) return [];
  return [
    "",
    "## Screenshots",
    "",
    names.map((n) => `- ${n}`).join("\n"),
    "",
    "_Paste image(s) into the GitHub issue after it opens (Ctrl+V / drag-drop)._",
  ];
}

export function buildBugReportBody(
  form: BugReportForm,
  watch?: LiveWatch | null,
  ws?: string,
  screenshotNames: string[] = [],
): string {
  if (isEnhancement(form)) {
    const lines = [
      "## Proposal",
      "",
      form.summary.trim() || "<!-- What should change? -->",
      "",
      "## Category",
      "",
      "- **Type:** Enhancement",
      `- **Area:** ${label(BUG_AREAS, form.area)}`,
      `- **Impact:** ${label(ENHANCEMENT_IMPACTS, form.impact)}`,
      `- **Where running:** ${label(BUG_HOSTS, form.host)}`,
      "",
      "## Suggested change",
      "",
      form.proposal.trim() || form.steps.trim() || "<!-- Concrete behavior or UI change -->",
      "",
      "## Why it helps",
      "",
      form.why.trim() || form.expected.trim() || "<!-- Operator pain this solves -->",
      "",
      "## Environment",
      "",
      ...envBlock(watch, ws),
      ...screenshotBlock(screenshotNames),
    ];
    return lines.join("\n");
  }

  const lines = [
    "## Summary",
    "",
    form.summary.trim() || "<!-- What happened? -->",
    "",
    "## Category",
    "",
    `- **Type:** ${label(BUG_CATEGORIES, form.category)}`,
    `- **Area:** ${label(BUG_AREAS, form.area)}`,
    `- **Severity:** ${label(BUG_SEVERITIES, form.severity)}`,
    `- **Where running:** ${label(BUG_HOSTS, form.host)}`,
    "",
    "## Steps to reproduce",
    "",
    form.steps.trim() || "1. \n2. \n3.",
    "",
    "## Expected",
    "",
    form.expected.trim() || "<!-- What should have happened? -->",
    "",
    "## Actual",
    "",
    form.actual.trim() || "<!-- What happened instead? -->",
    "",
    "## Environment",
    "",
    ...envBlock(watch, ws),
    ...screenshotBlock(screenshotNames),
  ];

  if (form.includeErrors && watch?.recent_errors?.length) {
    const slice = watch.recent_errors.slice(0, 3);
    lines.push("", "## Recent errors (from dashboard)", "");
    for (const e of slice) {
      lines.push(formatErrorDump(e, watch), "", "---", "");
    }
  }

  return lines.join("\n").replace(/\n---\n\n$/, "");
}

export function bugReportTitle(form: BugReportForm): string {
  const area = label(BUG_AREAS, form.area);
  const kind = isEnhancement(form) ? "enhancement" : form.category === "bug" ? "bug" : "issue";
  const summary = form.summary.trim().split(/\n/)[0]?.slice(0, 72) || "report from dashboard";
  return `[${kind}] ${area}: ${summary}`;
}

export function bugReportIssueUrl(
  form: BugReportForm,
  watch?: LiveWatch | null,
  ws?: string,
  screenshotNames: string[] = [],
): string {
  let body = buildBugReportBody(form, watch, ws, screenshotNames);
  if (body.length > 5500) {
    body = `${body.slice(0, 5400)}\n\n…(truncated — copy full report from the dashboard)`;
  }
  const q = new URLSearchParams({
    template: isEnhancement(form) ? "enhancement.md" : "bug_report.md",
    title: bugReportTitle(form),
    body,
  });
  return `${REPO}/issues/new?${q.toString()}`;
}

export async function copyImageFile(file: File): Promise<boolean> {
  try {
    const type = file.type.startsWith("image/") ? file.type : "image/png";
    const blob = file.type === type ? file : new Blob([await file.arrayBuffer()], { type });
    await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
    return true;
  } catch {
    return false;
  }
}
