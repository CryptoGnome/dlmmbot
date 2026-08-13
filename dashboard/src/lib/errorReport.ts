/** Prefill GitHub issues from a dashboard error_log row. */
import type { ErrorLogEntry, LiveWatch } from "./types";

const REPO = "https://github.com/CryptoGnome/dlmmbot";

export function formatErrorDump(e: ErrorLogEntry, watch?: LiveWatch | null): string {
  const lines = [
    `## DLMM Bot error #${e.id}`,
    "",
    `- **When:** ${e.at}`,
    `- **Level:** ${e.level}`,
    `- **Source:** ${e.source}${e.code ? ` / ${e.code}` : ""}`,
    `- **Host:** ${e.host ?? "—"}`,
    `- **Build:** ${e.build ?? watch?.build?.describe ?? "—"}`,
    `- **PID:** ${e.pid ?? "—"}`,
  ];
  if (e.symbol) lines.push(`- **Symbol:** ${e.symbol}`);
  if (e.position_id != null) lines.push(`- **Position:** #${e.position_id}`);
  if (e.mint) lines.push(`- **Mint:** \`${e.mint}\``);
  if (e.pool) lines.push(`- **Pool:** \`${e.pool}\``);
  lines.push("", "### Message", "", "```", e.message, "```");
  if (e.stack) lines.push("", "### Stack", "", "```", e.stack, "```");
  if (e.detail != null) {
    lines.push(
      "",
      "### Detail",
      "",
      "```json",
      typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail, null, 2),
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

export function errorIssueUrl(e: ErrorLogEntry, watch?: LiveWatch | null): string {
  const title = `[error] ${e.source}${e.code ? `/${e.code}` : ""}: ${e.message.slice(0, 80)}`;
  let body = formatErrorDump(e, watch);
  // GitHub URL length soft limit — keep the issue openable.
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
