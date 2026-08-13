export type RangeKey = "7d" | "30d" | "all";

export interface LiveWatch {
  ts: number;
  at: string;
  host: string;
  build: {
    version?: string;
    branch?: string;
    head: string | null;
    message: string | null;
    describe?: string | null;
    dirty?: boolean;
    origin?: string | null;
    /** current | behind | ahead | diverged | unknown */
    sync?: string;
    behind_count?: number;
    repo_url?: string | null;
    release_url?: string | null;
    commits_url?: string | null;
    /** Bot process `git describe` from heartbeat (may differ from disk HEAD). */
    running?: string | null;
    fetched_at?: number | null;
    recent?: Array<{ sha: string | null; subject: string; at: string | null; ts: number | null }>;
    pending?: Array<{ sha: string | null; subject: string; at: string | null; ts: number | null }>;
    fix_sha: string | null;
    fix_ts: number;
    fix_at: string;
  };
  config: Record<string, number | boolean | null>;
  heartbeat: {
    ts?: number; pid?: number; build?: string; mode?: string;
    open?: number; probeFailures?: number; entriesFrozen?: boolean;
    walletSol?: number | null;
  } | null;
  heartbeat_age_s: number | null;
  balance?: {
    wallet_sol: number | null;
    deployed_sol: number;
    total_sol: number | null;
    sol_usd: number | null;
    total_usd: number | null;
    wallet_usd: number | null;
  };
  open: Array<{
    id: number; symbol: string; mint?: string; mode: string; state: string;
    /** meme | micro | majors */
    sleeve?: string | null;
    follow?: boolean;
    entry_sol: number; entry_price?: number; open_cost_sol?: number | null;
    opened: string; fees_claimed_sol?: number;
    min_bin_id?: number; max_bin_id?: number; range_status?: string;
    range?: {
      min_bin: number; max_bin: number; active_bin: number | null;
      min_price: number | null; max_price: number | null; price: number | null;
      status: string;
    };
    mark?: {
      value_sol: number | null;
      liq_sol?: number | null;
      pnl_sol: number | null;
      inv_pnl_sol?: number | null;
      total_pnl_sol?: number | null;
      pct: number | null;
      unclaimed_fees_sol: number | null;
      fees_claimed_sol: number;
      in_range: boolean;
      status?: string;
      unreliable?: boolean;
      active_bin_id?: number | null;
      price?: number | null;
      age_s: number | null;
      at: string;
    } | null;
  }>;
  book: {
    all_time_live: { n: number; pnl: number; entry_sol?: number; pct?: number | null };
    since_fix: BookWindow;
    last_24h: BookWindow;
  };
  meteora?: {
    closed_n: number | null;
    closed_pnl_sol: number | null;
    closed_pct: number | null;
    open_n: number | null;
    open_bal_sol: number | null;
    open_pnl_sol: number | null;
    source: string;
  } | null;
  kelly: {
    samples: number; regime: string; appliedFraction: number;
    fullKelly: number | null; winRate: number | null;
  };
  cluster: {
    tripped: boolean;
    count: number;
    remainingMin: number;
    recent: Array<{ exit_ts?: number; exit_reason?: string; symbol?: string }>;
  };
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
  p3_missed_since_fix: Array<{
    id: number; symbol: string; mint?: string; at: string;
    pnl: number; entry_sol?: number; pct?: number | null; hold_min: number;
  }>;
  bin_rent_near_miss: {
    since_fix: NearMiss;
    last_24h: NearMiss;
  };
  recent_passes: Array<{
    at: string;
    mint?: string | null;
    pool?: string | null;
    symbol?: string;
    score: number | null;
    size?: number | null;
    sleeve?: string | null;
    isAlpha?: boolean;
    baseScore?: number | null;
  }>;
  recent_activity?: ActivityEvent[];
}

export interface ActivityEvent {
  at: string;
  kind: "entry" | "exit" | "skip" | "fail" | "event" | "cluster";
  symbol?: string | null;
  mint?: string | null;
  pool?: string | null;
  score?: number | null;
  size?: number | null;
  sleeve?: string | null;
  gate?: string | null;
  pnl?: number | null;
  detail?: string | null;
}

export interface BookWindow {
  by_reason: ExitAgg[];
  n: number;
  pnl: number;
  entry_sol?: number;
  pct?: number | null;
}

export interface ExitAgg {
  exit_reason: string;
  n: number;
  pnl: number;
  avg_pnl: number;
  entry_sol?: number;
  pct?: number | null;
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
  mint?: string | null;
  pool?: string | null;
  symbol?: string;
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
    day: string; sol: number; usd: number; cum_sol: number; cum_usd: number;
    sol_usd: number | null; day_pct?: number | null;
  }>;
  exits: Array<{ day: string; n: number; pnl: number; entry_sol?: number; pct?: number | null }>;
  exit_by_reason: Array<{ reason: string; n: number; pnl: number; entry_sol?: number; pct?: number | null }>;
  exit_reasons: string[];
  ladder: Array<{
    id: number; symbol: string; mint?: string; exit_reason: string; at: string;
    exit_ts: number; pnl: number; entry_sol: number; pct?: number | null;
    open_cost_sol?: number | null;
    close_return_sol?: number | null;
    fees_sol?: number | null;
    recovered_sol?: number | null;
    fees_at_close_sol?: number | null;
    exit_sol?: number | null;
    exit_move_sol?: number | null;
  }>;
  skip_top: Array<{ g: string; n: number }>;
  skip_series: Array<Record<string, string | number>>;
  activity: Array<{ day: string; entered: number; skipped: number }>;
}
