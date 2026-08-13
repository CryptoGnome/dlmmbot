import { readFileSync, watchFile } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";

// Typed mirror of config.toml. Sections/keys must match STRATEGY.md defaults.
export interface Config {
  scanner: { interval_s: number; pages: number; copycat_ignore_h: number };
  gates: {
    tvl_min_usd: number; tvl_max_usd: number; mcap_min_usd: number;
    mcap_micro_max_usd: number; mcap_micro_score_min: number;
    micro_tvl_min_usd: number; micro_max_pool_share_pct: number;
    micro_size_mult: number; micro_max_position_sol: number;
    micro_max_slots: number; micro_deploy_cap_pct: number;
    fee_tvl_24h_min_pct: number; fee_tvl_30m_daily_min_pct: number;
    vol_30m_min_usd: number; vol_trend_min: number;
    base_fee_min_pct: number; base_fee_max_pct: number;
    bin_step_min_new: number;
    fee_collection: "prefer_quote" | "quote_only" | "both_only" | "any";
    quote_mints: string[]; price_divergence_max_pct: number;
    max_pool_share_pct: number;
  };
  vetting: {
    /** When false, skip that hard fail (thresholds still stored for when re-enabled). */
    age_min_enabled?: boolean;
    age_max_enabled?: boolean;
    insider_gate_enabled?: boolean;
    holder_gate_enabled?: boolean;
    rugcheck_veto_enabled?: boolean;
    creator_rug_enabled?: boolean;
    gmgn_security_enabled?: boolean;
    single_holder_max_pct: number; top10_max_pct: number;
    insider_cluster_max_pct: number; rugcheck_veto_normalised: number;
    age_min_minutes: number; age_max_days: number;
    allow_token2022_extensions: string[];
  };
  timing: { freefall_15m_max_pct: number; ath_proximity_pct: number; vol_spike_ratio: number; vol_spike_bonus: number };
  score_caps: { bonus_cap_total: number };
  smartflow: {
    window_min: number;
    min_wallets: number; bonus_wallets: number;
    min_joiners: number; bonus_joiners: number;
    bonus_kol: number;
    net_sell_penalty_usd: number; penalty_net_sell: number;
  };
  score: {
    w_fee_momentum: number; w_turnover: number; w_vetting_soft: number;
    w_timing: number; w_pool_structure: number;
  };
  entry: {
    fib_bottom: number; max_down_pct: number; min_down_pct: number;
    max_position_accounts: number; bin_rent_budget_sol: number;
    bin_rent_hard_sol: number; bin_rent_hard_score_min: number;
    liquidity_slippage_pct: number;
    tranche_enabled: boolean; tranche_score_min: number; tranche_size_pct: number;
    /** Target depth for second tranche (clamped by P0 safety margin like primary). */
    tranche_max_down_pct: number;
  };
  manage: {
    poll_s: number;
    safety_tvl_drop_pct: number; safety_wallet_dump_pct: number;
    safety_new_whale_pct: number; safety_price_crash_pct: number;
    stop_loss_frac: number; loss_reentry_cooldown_h: number;
    rotation_fee_daily_min_pct: number; rotation_polls: number;
    rotation_vol_30m_min_usd: number; max_age_h: number;
    above_range_pct: number; above_range_sustain_min: number;
    above_range_missed_sustain_min: number;
    rebalance_max_per_6h: number; rebalance_cost_max_pct_of_fees: number;
    reentry_ladder_mult: number; reentry_max_per_24h: number; house_money_rule: boolean;
    claim_min_sol: number; claim_min_txcost_mult: number; claim_interval_h: number;
    grace_claim_min_sol: number;
    fee_destination: "bank" | "compound" | "hybrid"; compound_score_min: number;
    escape_hatch_depth_pct: number; escape_hatch_recovery_pct: number;
    profit_lock_enabled: boolean; profit_lock_at_frac: number;
    profit_lock_withdraw_pct: number; profit_lock_max_fires: number;
    below_range_grace_min: number;
    holder_poll_s: number;
  };
  sizing: {
    max_positions: number; min_position_sol: number; min_reentry_sol: number;
    kelly_enabled: boolean; kelly_fraction: number; kelly_lookback: number;
    kelly_min_samples: number; kelly_cold_start_frac: number;
    kelly_max_position_frac: number; kelly_block_negative: boolean;
    reserve_sol: number; reserve_pct: number; per_token_max_pct: number;
    score_mult_low: number; score_mult_mid: number; score_mult_high: number;
    circuit_daily_loss_pct: number; circuit_pause_h: number;
    circuit_weekly_triggers_halt: number;
    cluster_brake_exits: number; cluster_brake_window_h: number; cluster_brake_pause_h: number;
    /** Only count P0/P1 with realized return ≤ −this % of entry (0 = count all). */
    cluster_brake_loss_pct: number;
    regime_filter: boolean; regime_sol_24h_halve_pct: number; regime_sol_24h_pause_pct: number;
  };
  follow: {
    enabled: boolean;
    min_vol_30m_usd: number; retrace_arm_pct: number;
    range_depth_pct: number; leg_size_sol: number;
    max_legs: number; chain_loss_budget_sol: number;
    chain_max_age_h: number; cold_polls_end: number;
    open_fail_cooldown_s: number;
  };
  majors: {
    enabled: boolean;
    discovery: boolean; discovery_pages: number;
    symbol_allowlist: string[]; mcap_min_usd: number; age_min_days: number;
    pools: Array<{ pool: string; symbol?: string }>;
    strategy_shape: "spot" | "bidask";
    range_below_pct: number; range_above_pct: number;
    entry_rsi_period: number; entry_rsi_max: number;
    entry_swing_position_max: number; entry_swing_avoid_top: number;
    fee_tvl_24h_min_pct: number; fee_tvl_30m_daily_min_pct: number;
    tvl_min_usd: number; tvl_max_usd: number; vol_30m_min_usd: number;
    max_pool_share_pct: number; size_sol: number; max_position_sol: number;
    max_slots: number; deploy_cap_pct: number; meme_reserve_slots: number;
    stop_loss_frac: number;
    escape_hatch_enabled: boolean; escape_hatch_depth_pct: number; escape_hatch_recovery_pct: number;
    below_range_grace_min: number;
    claim_min_sol: number; fee_compound: boolean; profit_lock_enabled: boolean;
    max_age_h: number; above_range_sustain_min: number; above_range_missed_sustain_min: number;
    rotation_fee_daily_min_pct: number; rotation_vol_30m_min_usd: number;
    /** Consecutive decay polls before P2 (defaults to manage.rotation_polls if unset). */
    rotation_polls: number;
  };
  rotation: {
    alpha_slots: number; alpha_score_min: number;
    displacement_enabled: boolean; displacement_margin: number;
    displacement_min_hold_min: number; displacement_value_frac_min: number;
    displacement_max_per_6h: number;
  };
  exec: {
    mode: "paper" | "live"; use_zap: boolean;
    /** When false, escape hatch closes instead of Zap reshape-in-place. */
    escape_rebalance_enabled?: boolean;
    exit_slippage_bps: number; safety_exit_slippage_bps: number;
    tx_retries: number; paper_promotion_days: number;
  };
  gmgn: {
    enabled: boolean; intervals: Array<"1m" | "5m" | "1h" | "6h" | "24h">;
    min_liquidity_usd: number; require_renounced: boolean;
    bonus_sustained: number; bonus_emerging: number; bonus_fading: number;
  };
  watchdog: { rpc_blind_after_min: number };
  apis: { meteora_datapi: string; rugcheck: string; jupiter_quote: string; jupiter_price: string; jup_datapi: string };
  /** 1% of measured net profit → buy mint → burn (live closes only). */
  profit_burn: {
    enabled: boolean;
    mint: string;
    /** Fraction of measured net PnL to spend (0.01 = 1%). */
    profit_frac: number;
    /** Skip when fee SOL is below this (dust). */
    min_sol: number;
    slippage_bps: number;
  };
}

export interface Env {
  rpcUrl: string;
  rpcUrlFallback: string | undefined;
  jupiterApiKey: string | undefined;
  gmgnApiKey: string | undefined;
  walletPrivateKey: string | undefined;
  walletKeypairPath: string | undefined;
  farmerMode: string;
}

const CONFIG_PATH = resolve(process.cwd(), "config.toml");

// Minimal .env loader (no dependency): KEY=VALUE lines, # comments,
// existing process.env always wins.
(() => {
  try {
    const lines = readFileSync(resolve(process.cwd(), ".env"), "utf8").split(/\r?\n/);
    for (const line of lines) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trimStart().startsWith("#")) continue;
      const [, key, value] = m;
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* no .env file — fine, env()/defaults cover it */
  }
})();

let current: Config = load();
const listeners: Array<(c: Config) => void> = [];

function load(): Config {
  const raw = parse(readFileSync(CONFIG_PATH, "utf8"));
  return raw as unknown as Config;
}

export function config(): Config {
  return current;
}

/** Replace live config for unit tests. Pass null to reload config.toml. */
export function _setConfigForTests(c: Config | null): void {
  current = c === null ? load() : c;
}

export function onConfigChange(fn: (c: Config) => void): void {
  listeners.push(fn);
}

/** Hot reload: re-parse config.toml when it changes; bad TOML keeps the old config. */
export function startConfigWatcher(): void {
  watchFile(CONFIG_PATH, { interval: 2000 }, () => {
    try {
      current = load();
      for (const fn of listeners) fn(current);
    } catch (e) {
      console.error("[config] reload failed, keeping previous config:", e);
    }
  });
}

export function env(): Env {
  return {
    rpcUrl: process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com",
    rpcUrlFallback: process.env.RPC_URL_FALLBACK || undefined,
    jupiterApiKey: process.env.JUPITER_API_KEY || undefined,
    gmgnApiKey: process.env.GMGN_API_KEY || undefined,
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY || undefined,
    walletKeypairPath: process.env.WALLET_KEYPAIR_PATH || undefined,
    farmerMode: process.env.FARMER_MODE ?? "paper",
  };
}

/** Live trading requires BOTH config.toml mode=live AND FARMER_MODE=live env. */
export function isLive(): boolean {
  return config().exec.mode === "live" && env().farmerMode === "live";
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";
