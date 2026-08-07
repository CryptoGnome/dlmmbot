import { readFileSync, watchFile } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";

// Typed mirror of config.toml. Sections/keys must match STRATEGY.md defaults.
export interface Config {
  scanner: { interval_s: number; pages: number; copycat_ignore_h: number };
  gates: {
    tvl_min_usd: number; tvl_max_usd: number; mcap_min_usd: number;
    fee_tvl_24h_min_pct: number; fee_tvl_30m_daily_min_pct: number;
    vol_30m_min_usd: number; vol_trend_min: number;
    base_fee_min_pct: number; base_fee_max_pct: number;
    bin_step_min_new: number;
    fee_collection: "prefer_quote" | "quote_only" | "both_only" | "any";
    quote_mints: string[]; price_divergence_max_pct: number;
    max_pool_share_pct: number;
  };
  vetting: {
    single_holder_max_pct: number; top10_max_pct: number;
    insider_cluster_max_pct: number; rugcheck_veto_normalised: number;
    age_min_minutes: number; age_max_days: number;
    allow_token2022_extensions: string[];
  };
  timing: { freefall_15m_max_pct: number; ath_proximity_pct: number; vol_spike_ratio: number; vol_spike_bonus: number };
  score: {
    w_fee_momentum: number; w_turnover: number; w_vetting_soft: number;
    w_timing: number; w_pool_structure: number;
  };
  entry: {
    fib_bottom: number; max_down_pct: number; min_down_pct: number;
    max_position_accounts: number; bin_rent_budget_sol: number;
    liquidity_slippage_pct: number;
    tranche_enabled: boolean; tranche_score_min: number; tranche_size_pct: number;
  };
  manage: {
    poll_s: number;
    safety_tvl_drop_pct: number; safety_wallet_dump_pct: number;
    safety_new_whale_pct: number; safety_price_crash_pct: number;
    stop_loss_frac: number; loss_reentry_cooldown_h: number;
    rotation_fee_daily_min_pct: number; rotation_polls: number;
    rotation_vol_30m_min_usd: number; max_age_h: number;
    above_range_pct: number; above_range_sustain_min: number;
    rebalance_max_per_6h: number; rebalance_cost_max_pct_of_fees: number;
    reentry_ladder_mult: number; reentry_max_per_24h: number; house_money_rule: boolean;
    claim_min_sol: number; claim_min_txcost_mult: number; claim_interval_h: number;
    grace_claim_min_sol: number;
    fee_destination: "bank" | "compound" | "hybrid"; compound_score_min: number;
    escape_hatch_depth_pct: number; escape_hatch_recovery_pct: number;
    profit_lock_enabled: boolean; profit_lock_at_frac: number;
    profit_lock_withdraw_pct: number; profit_lock_max_fires: number;
    below_range_grace_min: number;
  };
  sizing: {
    max_positions: number; min_position_sol: number;
    kelly_enabled: boolean; kelly_fraction: number; kelly_lookback: number;
    kelly_min_samples: number; kelly_cold_start_frac: number;
    kelly_max_position_frac: number; kelly_block_negative: boolean;
    reserve_sol: number; reserve_pct: number; per_token_max_pct: number;
    score_mult_low: number; score_mult_mid: number; score_mult_high: number;
    circuit_daily_loss_pct: number; circuit_pause_h: number;
    circuit_weekly_triggers_halt: number;
    regime_filter: boolean; regime_sol_24h_halve_pct: number; regime_sol_24h_pause_pct: number;
  };
  rotation: {
    alpha_slots: number; alpha_score_min: number;
    displacement_enabled: boolean; displacement_margin: number;
    displacement_min_hold_min: number; displacement_value_frac_min: number;
    displacement_max_per_6h: number;
  };
  exec: {
    mode: "paper" | "live"; use_zap: boolean;
    exit_slippage_bps: number; safety_exit_slippage_bps: number;
    tx_retries: number; paper_promotion_days: number;
  };
  gmgn: {
    enabled: boolean; intervals: Array<"1m" | "5m" | "1h" | "6h" | "24h">;
    min_liquidity_usd: number; require_renounced: boolean;
    bonus_sustained: number; bonus_emerging: number; bonus_fading: number;
  };
  watchdog: { rpc_blind_close_all: boolean; rpc_blind_after_min: number };
  apis: { meteora_datapi: string; rugcheck: string; jupiter_quote: string; jupiter_price: string };
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
