import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function tokenFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const q = params.get("token");
  if (q) {
    sessionStorage.setItem("dash_token", q);
    // Scrub the token from the address bar / history so it can't be
    // shoulder-surfed, bookmarked, or leaked via referrer.
    try {
      params.delete("token");
      const qs = params.toString();
      const clean = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
      window.history.replaceState(window.history.state, "", clean);
    } catch {
      /* history API unavailable — non-fatal */
    }
    return q;
  }
  return sessionStorage.getItem("dash_token") ?? "";
}

export { fmtSol, fmtUsd, fmtUsdCompact, fmtPct, fmtRet, gmgnUrl, exitLabel, gateLabel, shortTime, timeAgo, clockTime, slotsSummary } from "./format";
