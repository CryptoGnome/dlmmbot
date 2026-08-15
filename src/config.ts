import { copyFileSync, existsSync, mkdirSync, readFileSync, watchFile } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "smol-toml";

/** Prefer gitignored data/ for live knobs so Settings never dirties the checkout. */
(function ensureRuntimeDefaults() {
  const root = process.cwd();
  const data = process.env.FARMER_DB_PATH
    ? dirname(resolve(process.env.FARMER_DB_PATH))
    : resolve(root, "data");
  mkdirSync(data, { recursive: true });
  if (!process.env.FARMER_CONFIG_PATH) process.env.FARMER_CONFIG_PATH = join(data, "config.toml");
  if (!process.env.FARMER_ENV_PATH) process.env.FARMER_ENV_PATH = join(data, ".env");
  if (!process.env.FARMER_DB_PATH) process.env.FARMER_DB_PATH = join(data, "farmer.db");
  if (!process.env.FARMER_PAUSE_PATH) process.env.FARMER_PAUSE_PATH = join(data, "PAUSE");
  if (!process.env.FARMER_HALT_PATH) process.env.FARMER_HALT_PATH = join(data, "HALT");
  const cfg = process.env.FARMER_CONFIG_PATH;
  if (cfg && !existsSync(cfg)) {
    const tmpl = resolve(root, "config.toml");
    if (existsSync(tmpl)) copyFileSync(tmpl, cfg);
  }
  const envFile = process.env.FARMER_ENV_PATH;
  if (envFile && !existsSync(envFile)) {
    const tmpl = resolve(root, ".env");
    if (existsSync(tmpl)) copyFileSync(tmpl, envFile);
  }
})();

// Typed mirror of config.toml. Sections/keys must match STRATEGY.md defaults.
export interface Config {
  scanner: {
    interval_s: number; pages: number; copycat_ignore_h: number;
    /**
     * Among a token's gate-passing pools of the same bin step, the deepest wins;
     * fee/TVL breaks ties only within this % of the deepest pool's TVL. Optional:
     * defaults in code for installs whose config predates the key.
     */
    sibling_tvl_tie_pct?: number;
  };
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
    gmgn_trader_tags_enabled?: boolean;
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
    /** Non-refundable bin rent may not exceed this % of the position (0 = no cap). */
    bin_rent_max_pos_pct?: number;
    liquidity_slippage_pct: number;
    tranche_enabled: boolean; tranche_score_min: number; tranche_size_pct: number;
    /** Target depth for second tranche (clamped by P0 safety margin like primary). */
    tranche_max_down_pct: number;
  };
  manage: {
    poll_s: number;
    safety_tvl_drop_pct: number; safety_wallet_dump_pct: number;
    /**
     * Token cooldown (hours) after a P0 `tvl_drain` exit, instead of the
     * permanent token+creator ban the rug-evidence triggers get. Optional:
     * defaults in code for installs whose config predates the key.
     */
    tvl_drain_cooldown_h?: number;
    /**
     * Suppress a `tvl_drain` exit when price has risen at least this % over the
     * same 10-min window — the pool is being traded through, not drained. 0
     * disables the veto. Deliberately high: exiting early is cheap, staying in
     * a rug is not.
     */
    tvl_drain_price_rise_veto_pct?: number;
    /**
     * `tvl_drain` needs a meaningful baseline. Below this median TVL, or on a
     * pool younger than this, the 10-min median is noise (thin pools swing
     * 40-50% on ordinary LP moves; a newborn's baseline is its own birth) and
     * the trigger is skipped. pool_dead / price_crash still cover a real collapse.
     */
    tvl_drain_min_tvl_usd?: number;
    tvl_drain_min_pool_age_min?: number;
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
    /**
     * Bankroll-scaled position floor (§5). The effective floor is
     * `max(min_position_floor_sol, min(min_position_sol, equity × min_position_pct))`
     * — see `minPositionSol()`. Optional: installs whose volume config predates
     * these keys fall back to the same defaults in code.
     */
    min_position_pct?: number; min_position_floor_sol?: number;
    /** Global sizing: kelly (ledger) or fixed per-sleeve SOL / % of deployable. */
    mode: "kelly" | "fixed";
    /** Mirror of mode==="kelly" — kept for older profiles / snapshots. */
    kelly_enabled: boolean; kelly_fraction: number; kelly_lookback: number;
    kelly_min_samples: number; kelly_cold_start_frac: number;
    kelly_max_position_frac: number; kelly_block_negative: boolean;
    kelly_core_unit: "kelly" | "sol" | "pct"; kelly_core_sol: number; kelly_core_pct: number; kelly_core_mult: number;
    kelly_micro_unit: "kelly" | "sol" | "pct"; kelly_micro_sol: number; kelly_micro_pct: number; kelly_micro_mult: number;
    kelly_majors_unit: "kelly" | "sol" | "pct"; kelly_majors_sol: number; kelly_majors_pct: number; kelly_majors_mult: number;
    kelly_follow_unit: "kelly" | "sol" | "pct"; kelly_follow_sol: number; kelly_follow_pct: number; kelly_follow_mult: number;
    fixed_core_unit: "sol" | "pct"; fixed_core_sol: number; fixed_core_pct: number;
    fixed_micro_unit: "sol" | "pct"; fixed_micro_sol: number; fixed_micro_pct: number;
    fixed_majors_unit: "sol" | "pct"; fixed_majors_sol: number; fixed_majors_pct: number;
    fixed_follow_unit: "sol" | "pct"; fixed_follow_sol: number; fixed_follow_pct: number;
    reserve_sol: number; reserve_pct: number;
    /** Cap on the flat `reserve_sol` as a % of equity, so a small wallet keeps a deployable bankroll. */
    reserve_max_pct?: number;
    per_token_max_pct: number;
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
    exit_slippage_bps: number; safety_exit_slippage_bps: number;
    tx_retries: number; paper_promotion_days: number;
    /**
     * Priority fee + compute budget (see src/executor/priorityFee.ts). Optional:
     * installs whose volume config predates these keys use the same defaults
     * from code.
     */
    priority_fee_percentile?: number;
    priority_fee_floor_microlamports?: number;
    priority_fee_cap_microlamports?: number;
    priority_fee_retry_mult?: number;
    compute_unit_margin_pct?: number;
    compute_unit_fallback?: number;
  };
  gmgn: {
    enabled: boolean; intervals: Array<"1m" | "5m" | "1h" | "6h" | "24h">;
    min_liquidity_usd: number; require_renounced: boolean;
    bonus_sustained: number; bonus_emerging: number; bonus_fading: number;
  };
  watchdog: { rpc_blind_after_min: number };
  apis: { meteora_datapi: string; rugcheck: string; jupiter_quote: string; jupiter_price: string; jup_datapi: string };
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

const CONFIG_PATH = resolve(process.env.FARMER_CONFIG_PATH!);

// Minimal .env loader (no dependency): KEY=VALUE lines, # comments,
// existing process.env always wins. The loader is first-set-wins, so the
// runtime volume's .env (FARMER_ENV_PATH — where the dashboard and
// railway-start write) is listed FIRST: the old order let a stale key in the
// repo checkout's .env silently override every dashboard settings write.
(() => {
  const files = [
    process.env.FARMER_ENV_PATH,
    resolve(process.cwd(), ".env"),
  ].filter(Boolean) as string[];
  for (const file of files) {
    try {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      for (const line of lines) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (!m || line.trimStart().startsWith("#")) continue;
        const [, key, value] = m;
        if (key && process.env[key] === undefined) process.env[key] = value;
      }
    } catch {
      /* missing file — fine */
    }
  }
})();

// Every top-level section the code reads. A parse that comes back without one
// of these is either a truncated read (racing a settings write) or a gutted
// file — swapping it in would make gate comparisons like `tvl < undefined`
// silently false, i.e. hard gates silently passing.
const REQUIRED_SECTIONS = [
  "scanner", "gates", "vetting", "timing", "score_caps", "smartflow", "score",
  "entry", "manage", "sizing", "follow", "majors", "rotation", "exec", "gmgn",
  "watchdog", "apis",
] as const;

/** Recursively fill keys missing from `target` with the template's values. */
function fillMissing(target: Record<string, unknown>, template: Record<string, unknown>): void {
  for (const [key, tmplVal] of Object.entries(template)) {
    const cur = target[key];
    if (cur === undefined) {
      target[key] = tmplVal;
    } else if (
      cur !== null && typeof cur === "object" && !Array.isArray(cur) &&
      tmplVal !== null && typeof tmplVal === "object" && !Array.isArray(tmplVal)
    ) {
      fillMissing(cur as Record<string, unknown>, tmplVal as Record<string, unknown>);
    }
  }
}

/** Prefer explicit mode; else derive from kelly_enabled. Keep the two in sync. */
function normalizeSizing(raw: Record<string, unknown>): void {
  const s = raw.sizing as Record<string, unknown> | undefined;
  if (!s || typeof s !== "object") return;
  if (s.mode !== "kelly" && s.mode !== "fixed") {
    s.mode = s.kelly_enabled === false ? "fixed" : "kelly";
  }
  s.kelly_enabled = s.mode === "kelly";
}

function load(): Config {
  const raw = parse(readFileSync(CONFIG_PATH, "utf8")) as unknown as Record<string, unknown>;
  // Derive mode from kelly_enabled *before* template fill — otherwise a missing
  // mode would always become "kelly" from the template and ignore kelly_enabled=false.
  normalizeSizing(raw);
  // Back-fill keys the repo template gained after this deployment's runtime
  // config.toml was seeded — data/config.toml is copied exactly once, so a new
  // key read by newer code was silently `undefined` forever (NaN sizing,
  // gates comparing against undefined). Values the operator set always win;
  // only absent keys are filled.
  const tmplPath = resolve(process.cwd(), "config.toml");
  if (resolve(CONFIG_PATH) !== tmplPath && existsSync(tmplPath)) {
    try {
      fillMissing(raw, parse(readFileSync(tmplPath, "utf8")) as unknown as Record<string, unknown>);
    } catch { /* unreadable template — run with what we have */ }
  }
  normalizeSizing(raw);
  for (const section of REQUIRED_SECTIONS) {
    if (raw[section] === undefined || typeof raw[section] !== "object") {
      throw new Error(`config.toml is missing required section [${section}] — refusing to load a gutted config`);
    }
  }
  return raw as unknown as Config;
}

let current: Config = load();
const listeners: Array<(c: Config) => void> = [];

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

/**
 * Volume `.env` FARMER_MODE (Settings / wizard) overrides boot-time process env
 * (Railway defaults). Without this, a spawned `FARMER_MODE=paper` sticks forever
 * and paper→live from the dashboard never takes effect.
 */
export function syncFarmerModeFromDisk(): void {
  const envFile = process.env.FARMER_ENV_PATH;
  if (!envFile) return;
  try {
    const text = readFileSync(envFile, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.trimStart().startsWith("#")) continue;
      const m = /^\s*FARMER_MODE\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = (m[1] ?? "").trim();
      if (
        (v.startsWith('"') && v.endsWith('"'))
        || (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      v = v.trim().toLowerCase();
      if (v === "live" || v === "paper") process.env.FARMER_MODE = v;
      break;
    }
  } catch { /* missing .env is fine */ }
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

/**
 * The positions.mode value this process reads and writes. The DB is shared
 * across the paper→live promotion flow, so every open-position / risk query
 * must filter on it — a live loop must never manage (or count, or learn from)
 * paper rows, and vice versa.
 */
export function currentMode(): "paper" | "live" {
  return isLive() ? "live" : "paper";
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";
