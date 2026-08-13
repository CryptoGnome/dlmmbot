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

export function fmtSol(n: number | null | undefined, digits = 4): string {
  if (n == null || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}`;
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}
