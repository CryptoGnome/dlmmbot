import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function tokenFromUrl(): string {
  const q = new URLSearchParams(window.location.search).get("token");
  if (q) {
    sessionStorage.setItem("dash_token", q);
    return q;
  }
  return sessionStorage.getItem("dash_token") ?? "";
}

export { fmtSol, fmtUsd, fmtUsdCompact, fmtPct, fmtRet, gmgnUrl, exitLabel, gateLabel, shortTime, timeAgo, clockTime, slotsSummary } from "./format";
