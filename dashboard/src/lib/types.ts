export type RangeKey = "7d" | "30d" | "all";

export interface LiveWatch {
  ts: number;
  at: string;
  host: string;
  /** Bot burner wallet (base58). Public address only. */
  wallet_pubkey?: string | null;
  /** Active book — paper|live; position/PnL slices never mix the other mode. */
  book_mode?: "paper" | "live";
  ops?: {
    /** Soft pause — no trades; positions stay open. */
    paused?: boolean;
    pause_at?: string | null;
    /** Emergency halt — closes opens, then idles. */
    halted?: boolean;
    halt_at?: string | null;
  };
  build: {
    version?: string;
    branch?: string;
    head: string | null;
    /** railway | vercel | git | env | … — where the SHA came from */
    head_source?: string;
    head_source_label?: string;
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
    pending?: Array<{
      sha: string | null;
      subject: string;
      at: string | null;
      ts: number | null;
      /** strategy | deps | deploy | core | dash | docs */
      risk?: string[];
    }>;
    /** Fingerprint of dashboard/dist — client prompts Reload when this changes. */
    ui_build?: string | null;
    /** Recent GitHub releases (tag + operator summary) for Changes. */
    releases?: Array<{
      tag: string;
      name: string;
      summary: string | null;
      at: string | null;
      ts: number | null;
      url: string | null;
    }>;
    /** PM2 auto-deploy on by default; off = approve from Changes. */
    auto_update?: boolean;
    approve_sha?: string | null;
    approved_at?: string | null;
    /** Behind + auto_update off + not yet approved for current origin tip. */
    needs_approval?: boolean;
    deploy_gate?: string;
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
    name?: string | null;
    icon_url?: string | null;
    entry_sol: number; entry_price?: number; open_cost_sol?: number | null;
    opened: string;     fees_claimed_sol?: number;
    /** Operator asked for a close; the farmer actions it on the next tick. */
    close_requested_at?: number | null;
    min_bin_id?: number; max_bin_id?: number; range_status?: string;
    /** Latest Meteora datapi snapshot for this pool (from scanner). */
    pool?: {
      tvl_usd: number | null;
      vol_30m_usd: number | null;
      vol_1h_usd: number | null;
      vol_24h_usd: number | null;
      fee_tvl_30m_pct: number | null;
      fee_tvl_24h_pct: number | null;
      fees_24h_usd: number | null;
      age_s: number | null;
    } | null;
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
  /** Structured runtime errors (error_log) — live via WS watch. */
  recent_errors?: ErrorLogEntry[];
  error_stats?: {
    count_1h: number;
    count_24h: number;
    last_id: number | null;
    last_ts: number | null;
  };
  /** Mint → display metadata (icon/name/symbol) for TokenSymbol + client cache. */
  token_meta?: Record<string, {
    mint: string;
    symbol: string | null;
    name: string | null;
    icon_url: string | null;
  }>;
  /** GMGN smart-money / KOL rolling window (farmer → data/smartflow.json). */
  smartflow?: SmartflowSnap | null;
}

export interface SmartflowTokenRow {
  mint: string;
  symbol?: string | null;
  name?: string | null;
  icon_url?: string | null;
  smart_wallets: number;
  new_joiners: number;
  net_usd: number;
  buy_usd: number;
  sell_usd: number;
  kol_names: string[];
  trade_count: number;
}

export interface SmartflowTradeRow {
  hash: string;
  mint: string;
  maker: string;
  side: "buy" | "sell";
  usd: number;
  ts: number;
  at: string;
  kol: string | null;
  feed: "smartmoney" | "kol";
  symbol?: string | null;
  name?: string | null;
  icon_url?: string | null;
}

export interface SmartflowSnap {
  at: string | null;
  ts: number | null;
  last_poll_at: string | null;
  last_poll_ms: number;
  stale: boolean;
  running: boolean;
  enabled: boolean;
  window_min: number;
  next_feed: "smartmoney" | "kol";
  trade_count: number;
  tokens: SmartflowTokenRow[];
  recent: SmartflowTradeRow[];
}

export interface ErrorLogEntry {
  id: number;
  ts: number;
  at: string;
  /** Acknowledged: out of the badge and the counts, still in the log. */
  dismissed?: boolean;
  level: "error" | "warn" | "fatal" | string;
  source: string;
  code: string | null;
  message: string;
  stack: string | null;
  detail: unknown;
  /** Plain-language title (stored at log time). */
  label?: string | null;
  /** transient | degraded | incident */
  kind?: string | null;
  hint?: string | null;
  position_id: number | null;
  symbol: string | null;
  mint: string | null;
  pool: string | null;
  name?: string | null;
  icon_url?: string | null;
  build: string | null;
  host: string | null;
  pid: number | null;
}

export interface ActivityEvent {
  at: string;
  kind: "entry" | "exit" | "skip" | "fail" | "event" | "cluster";
  symbol?: string | null;
  mint?: string | null;
  pool?: string | null;
  name?: string | null;
  icon_url?: string | null;
  score?: number | null;
  size?: number | null;
  sleeve?: string | null;
  gate?: string | null;
  pnl?: number | null;
  detail?: string | null;
  /** On-chain signature when this row is a real tx (open/close/claim/…). */
  tx_sig?: string | null;
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
  book_mode?: "paper" | "live";
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
    /** Under-filled residue not yet sold by the sweep — provisional credit. */
    stranded_sol?: number | null;
    fees_at_close_sol?: number | null;
    exit_sol?: number | null;
    exit_move_sol?: number | null;
  }>;
  skip_top: Array<{ g: string; n: number }>;
  skip_series: Array<Record<string, string | number>>;
  activity: Array<{ day: string; entered: number; skipped: number; open_failed?: number }>;
  stats?: AnalyticsStats;
}

export interface AnalyticsBucket {
  n: number;
  pnl: number;
  entry_sol: number;
  pct: number | null;
  wins: number;
  losses: number;
  win_rate: number | null;
  avg_pnl: number | null;
  hold_median_h: number | null;
}

export interface AnalyticsStats {
  headline: {
    closes: number;
    win_rate: number | null;
    avg_win_sol: number | null;
    avg_loss_sol: number | null;
    expectancy_sol: number | null;
    fees_sol: number;
    inventory_sol: number | null;
    pnl_sol: number;
  };
  by_reason: Array<AnalyticsBucket & { reason: string }>;
  by_sleeve: Array<AnalyticsBucket & { sleeve: string }>;
  fee_vs_inventory: {
    fees_sol: number;
    inventory_sol: number | null;
    n_with_inventory: number;
  };
  tokens_best: Array<AnalyticsBucket & { symbol: string; mint?: string }>;
  tokens_worst: Array<AnalyticsBucket & { symbol: string; mint?: string }>;
  follow: AnalyticsBucket & { chains: number };
  funnel: {
    entered: number;
    skipped: number;
    open_failed: number;
    fail_rate: number | null;
    skip_share: Array<{ g: string; n: number; share: number | null }>;
    fail_codes: Array<{ code: string; n: number }>;
    entry_scores: { n: number; median: number | null; p25: number | null; p75: number | null };
  };
  time_in_range: { avg_pct: number | null; n: number; with_marks: number };
  fee_tvl_buckets: Array<AnalyticsBucket & {
    label: string; fee_tvl_min: number; fee_tvl_max: number;
  }>;
  capital_series: Array<{
    day: string; unrealized_sol: number; fees_sol: number; realized_sol: number;
  }>;
  cluster_pressure: {
    hard_loss_exits: number;
    pnl: number;
    recent: Array<{
      id: number; symbol: string; mint?: string; reason: string; pnl: number; at: string;
    }>;
  };
}
