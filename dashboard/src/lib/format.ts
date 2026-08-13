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
    majors_open_failed: "Majors open failed",
    tranche_open_failed: "Tranche open failed",
    follow_active: "Follow chain active",
    majors_swing_high: "Majors near swing high",
    majors_rsi_warmup: "Majors RSI warming up",
    majors_entry_timing: "Majors timing",
    majors_fee_tvl_30m: "Majors low 30m fee",
    majors_token_open: "Majors already open",
    slots_full: "Slots full",
    already_positioned: "Already in token",
    size_zero: "Size below floor",
    reentry_limit: "Re-entry cooldown",
    insider_clusters: "Insider clusters",
    age_min: "Too young",
    age_max: "Too old",
    claim: "Fee claim",
    profit_lock: "Profit lock",
    rebalance: "Rebalance",
    rebalance_partial: "Partial rebalance",
    rent_reclaim: "Rent reclaim",
    force_close: "Force close",
  };
  return map[gate] ?? gate.replace(/_/g, " ");
}

const TZ = "America/New_York";

/** Parse API times (UTC ISO or `YYYY-MM-DD HH:MM:SS`) into a Date. */
function parseUtc(isoOrSql: string): Date | null {
  const raw = isoOrSql.trim();
  if (!raw) return null;
  // Already has timezone / Z
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // SQL datetime from sqlite is UTC without zone
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if (!m) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6] ?? 0),
  ));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Compact Eastern time: `08-13 10:33 AM` */
export function shortTime(isoOrSql: string | null | undefined): string {
  if (!isoOrSql) return "—";
  const d = parseUtc(isoOrSql);
  if (!d) return "—";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("dayPeriod")}`;
}

/** Relative age: `just now`, `5 minutes ago`, `2 hours ago`, `3 days ago`. */
export function timeAgo(isoOrSql: string | null | undefined, nowMs = Date.now()): string {
  if (!isoOrSql) return "—";
  const d = parseUtc(isoOrSql);
  if (!d) return "—";
  const sec = Math.max(0, Math.floor((nowMs - d.getTime()) / 1000));
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return min === 1 ? "1 minute ago" : `${min} minutes ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return hr === 1 ? "1 hour ago" : `${hr} hours ago`;
  const day = Math.floor(hr / 24);
  if (day < 60) return day === 1 ? "1 day ago" : `${day} days ago`;
  const mo = Math.floor(day / 30);
  return mo === 1 ? "1 month ago" : `${mo} months ago`;
}

/** Footer / clock: Eastern `10:33:52 AM` */
export function clockTime(ms: number | Date | null | undefined): string {
  if (ms == null) return "—";
  const d = ms instanceof Date ? ms : new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(d);
}
