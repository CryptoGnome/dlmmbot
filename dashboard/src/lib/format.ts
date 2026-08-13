export function fmtSol(n: number | null | undefined, digits = 4): string {
  if (n == null || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)} SOL`;
}

export function fmtUsd(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(digits)}`;
}

/** Fraction 0.123 → "+12.3%". */
export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(digits)}%`;
}

export function fmtRet(n: number | null | undefined, digits = 1): string {
  return fmtPct(n, digits);
}

export function gmgnUrl(mint: string | null | undefined): string | null {
  if (!mint || mint.length < 32) return null;
  return `https://gmgn.ai/sol/token/${mint}`;
}

export function exitLabel(reason: string | null | undefined): string {
  const map: Record<string, string> = {
    P0_safety: "Safety exit",
    P1_stop: "Stop loss",
    P2_rotation: "Rotation",
    P3_above: "Above range",
    P5_below: "Below range",
    escape: "Escape hatch",
    manual: "Manual close",
  };
  return map[reason ?? ""] ?? (reason ?? "Unknown");
}

export function gateLabel(gate: string): string {
  const map: Record<string, string> = {
    fee_tvl_24h: "Low 24h fee/TVL",
    fee_tvl_30m_daily: "Low 30m fee momentum",
    vol_30m: "Low 30m volume",
    mcap_min: "Market cap too low",
    tvl_max: "TVL too high",
    bin_rent: "Range rent too high",
    majors_bin_rent: "Majors rent too high",
    open_failed: "Open tx failed",
    follow_active: "Follow chain active",
    majors_swing_high: "Majors near swing high",
    majors_rsi_warmup: "Majors RSI warming up",
    slots_full: "Slots full",
    already_positioned: "Already in token",
  };
  return map[gate] ?? gate.replace(/_/g, " ");
}

export function shortTime(isoOrSql: string | null | undefined): string {
  if (!isoOrSql) return "—";
  const s = isoOrSql.replace("T", " ").slice(0, 16);
  return s.slice(5);
}
