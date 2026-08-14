/** Prefill GitHub issues from a dashboard error_log row. */
import type { ErrorLogEntry, LiveWatch } from "./types";
import { errorPresentation, type ErrorPresentation } from "./errorPresent";

const REPO = "https://github.com/CryptoGnome/dlmmbot";

export function formatErrorDump(
  e: ErrorLogEntry,
  watch?: LiveWatch | null,
  pres?: ErrorPresentation,
): string {
  const p = pres ?? errorPresentation(e);
  const lines = [
    `## DLMM Bot error #${e.id}`,
    "",
    `- **When:** ${e.at}`,
    `- **Label:** ${p.label}`,
    `- **Kind:** ${p.kind}`,
    `- **Level:** ${e.level}`,
    `- **Source:** ${e.source}${e.code ? ` / ${e.code}` : ""}`,
    `- **Host:** ${e.host ?? "—"}`,
    `- **Build:** ${e.build ?? watch?.build?.describe ?? "—"}`,
    `- **PID:** ${e.pid ?? "—"}`,
  ];
  if (p.hint) lines.push(`- **Hint:** ${p.hint}`);
  if (e.symbol) lines.push(`- **Symbol:** ${e.symbol}`);
  if (e.position_id != null) lines.push(`- **Position:** #${e.position_id}`);
  if (e.mint) lines.push(`- **Mint:** \`${e.mint}\``);
  if (e.pool) lines.push(`- **Pool:** \`${e.pool}\``);
  lines.push("", "### Message", "", "```", e.message, "```");
  if (e.stack) lines.push("", "### Stack", "", "```", e.stack, "```");
  if (e.detail != null) {
    const detail = typeof e.detail === "object" && e.detail !== null
      ? { ...(e.detail as Record<string, unknown>) }
      : e.detail;
    if (typeof detail === "object" && detail !== null) delete (detail as Record<string, unknown>)._present;
    lines.push(
      "",
      "### Detail",
      "",
      "```json",
      typeof detail === "string" ? detail : JSON.stringify(detail, null, 2),
      "```",
    );
  }
  if (watch?.build) {
    lines.push(
      "",
      "### Host context",
      "",
      `- Disk: ${watch.build.describe ?? watch.build.head ?? "—"}`,
      `- Running: ${watch.build.running ?? "—"}`,
      `- Sync: ${watch.build.sync ?? "—"}`,
    );
  }
  return lines.join("\n");
}

export function formatErrorLogDump(entries: ErrorLogEntry[], watch?: LiveWatch | null): string {
  const header = [
    `# DLMM Bot error log`,
    `Exported ${new Date().toISOString()}`,
    `Host build: ${watch?.build?.describe ?? "—"}`,
    `Count: ${entries.length}`,
    "",
  ].join("\n");
  return header + entries.map((e) => formatErrorDump(e, watch)).join("\n\n---\n\n");
}

export function errorIssueUrl(
  e: ErrorLogEntry,
  watch?: LiveWatch | null,
  pres?: ErrorPresentation,
): string {
  const p = pres ?? errorPresentation(e);
  const title = `[${p.kind}] ${p.label}: ${e.message.slice(0, 60)}`;
  let body = formatErrorDump(e, watch, p);
  if (body.length > 5500) body = `${body.slice(0, 5400)}\n\n…(truncated for URL length — paste full dump from Errors tab)`;
  const q = new URLSearchParams({
    template: "bot_error.md",
    title,
    body,
  });
  return `${REPO}/issues/new?${q.toString()}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
