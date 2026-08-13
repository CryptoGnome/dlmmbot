export type RangeKey = "7d" | "30d" | "all";

export interface LiveWatch {
  ts: number;
  at: string;
  host: string;
  build: { head: string | null; message: string | null; fix_sha: string | null; fix_ts: number; fix_at: string };
  config: Record<string, number | boolean | null>;
  heartbeat: {
    ts?: number; pid?: number; build?: string; mode?: string;
    open?: number; probeFailures?: number; entriesFrozen?: boolean;
  } | null;
  heartbeat_age_s: number | null;
  open: Array<{ id: number; symbol: string; mode: string; state: string; entry_sol: number; opened: string }>;
  book: {
    all_time_live: { n: number; pnl: number };
    since_fix: { by_reason: ExitAgg[]; n: number; pnl: number };
    last_24h: { by_reason: ExitAgg[]; n: number; pnl: number };
  };
  kelly: {
    samples: number; regime: string; appliedFraction: number;
    fullKelly: number | null; winRate: number | null;
  };
  cluster: { tripped: boolean; count: number; remainingMin: number; recent: unknown[] };
  open_failed_since_fix: {
    n: number; by_code: Record<string, number>;
    recent: Array<{ at: string; mint: string; code: string | null; error?: string }>;
  };
  integrity: {
    mark_gaps: {
      positions_checked: number; fail_count: number; pass: boolean;
      worst: Array<{ position_id: number; n: number; mean_gap: number; max_gap: number }>;
      fails: Array<{ position_id: number; n: number; mean_gap: number; max_gap: number }>;
    };
    per_bin_closes: { closes: number; with_bins: number };
  };
  follow_since_fix: Array<{ state: string; n: number; pnl: number }>;
  p3_missed_since_fix: Array<{ id: number; symbol: string; at: string; pnl: number; hold_min: number }>;
  bin_rent_near_miss: {
    since_fix: NearMiss;
    last_24h: NearMiss;
  };
}

export interface ExitAgg {
  exit_reason: string;
  n: number;
  pnl: number;
  avg_pnl: number;
}

export interface NearMiss {
  n: number;
  score_min: number;
  by_gate: Array<{ g: string; n: number }>;
  best: NearMissRow | null;
  recent: NearMissRow[];
}

export interface NearMissRow {
  at: string;
  mint?: string;
  pool?: string;
  gate: string;
  score: number;
  estRentSol?: number | null;
  binCount?: number | null;
  bottomPct?: number | null;
  rentBudget?: number | null;
}

export interface HistorySnap {
  range: RangeKey;
  since: number;
  at: string;
  equity: Array<{
    day: string; realized: number; unrealized: number; fees: number; costs: number;
    cum_realized: number; cum_fees: number;
  }>;
  exits: Array<Record<string, string | number>>;
  exit_reasons: string[];
  ladder: Array<{
    id: number; symbol: string; exit_reason: string; at: string;
    exit_ts: number; pnl: number; entry_sol: number;
  }>;
  skip_top: Array<{ g: string; n: number }>;
  skip_series: Array<Record<string, string | number>>;
  activity: Array<{ day: string; entered: number; skipped: number }>;
}
