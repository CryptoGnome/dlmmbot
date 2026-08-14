---
title: Configuration reference
description: Every section and key in config.toml with its shipped default — hot-reloaded at runtime, edited via the dashboard Settings or data/config.toml.
---

# Configuration reference

Every knob the bot obeys lives in one TOML file. Key facts before the tables:

- **Runtime config lives under `data/`** (`data/config.toml`, or wherever `FARMER_CONFIG_PATH` points — `/app/data` on Railway). The repo's `config.toml` is only a **template** copied on first run. Edit the runtime copy (or use dashboard **Settings**), never the tracked file.
- **Hot-reload:** changes apply within seconds while the bot runs — no restart. A file that fails to parse is ignored and the previous config stays active.
- Dashboard **Settings → Bot settings** writes these same keys, and [Settings profiles](./profiles) apply curated packs of them.
- Defaults below are the shipped template values. Several were deliberately tightened from the original spec after live trading (noted where interesting).

::: warning Don't casually weaken safety keys
Stops, brakes, and vetting gates exist because the alternatives lost money in the live book. Change with evidence — see [Risk & sizing](./risk).
:::

## `[scanner]`

| Key | Default | Meaning |
|---|---|---|
| `interval_s` | `60` | Seconds between scanner sweeps |
| `pages` | `3` | Meteora datapi pages per sweep (100 pools/page) |
| `copycat_ignore_h` | `24` | Losers of symbol dedupe ignored this long (hours) |

## `[gates]` — pool hard gates

| Key | Default | Meaning |
|---|---|---|
| `tvl_min_usd` | `5000` | Minimum pool TVL |
| `tvl_max_usd` | `2000000` | Maximum pool TVL (above: fees too diluted) |
| `mcap_min_usd` | `100000` | Hard market-cap floor |
| `mcap_micro_max_usd` | `200000` | $100–200k mcap routes to the micro sleeve |
| `mcap_micro_score_min` | `75` | Micro needs a higher score than the normal 60 floor |
| `micro_tvl_min_usd` | `15000` | Stricter TVL floor for micro only |
| `micro_max_pool_share_pct` | `10` | Micro position may not exceed this % of pool TVL |
| `micro_size_mult` | `0.5` | Micro sizes at half the core Kelly size |
| `micro_max_position_sol` | `0.45` | Absolute micro position cap |
| `micro_max_slots` | `1` | At most one micro position at a time |
| `micro_deploy_cap_pct` | `5` | Max % of wallet in open micro positions |
| `fee_tvl_24h_min_pct` | `20` | Min 24h fee/TVL, %/day |
| `fee_tvl_30m_daily_min_pct` | `10` | Min 30m fee/TVL annualized to daily, %/day |
| `vol_30m_min_usd` | `25000` | Min 30-minute volume |
| `vol_trend_min` | `0.8` | `vol_1h / (vol_24h/24)` floor — not in freefall |
| `base_fee_min_pct` / `base_fee_max_pct` | `0.2` / `5.0` | Base-fee band; >5% pools are arb-only |
| `bin_step_min_new` | `80` | Min bin step for tokens < 7 days old |
| `fee_collection` | `"prefer_quote"` | `prefer_quote` (bonus for SOL-only fee pools), `quote_only`, `both_only`, or `any` |
| `quote_mints` | SOL mint | Allowed quote tokens (SOL only in meme mode) |
| `price_divergence_max_pct` | `2.0` | Max pool price vs Jupiter quote divergence |
| `max_pool_share_pct` | `20` | Skip if our position would exceed this % of pool TVL |

## `[vetting]` — token hard gates

Master switches (also in Settings UI) — off skips that hard fail; thresholds apply when on:

| Key | Default | Meaning |
|---|---|---|
| `age_min_enabled` | `true` | Block "too young" (mint age via RugCheck, not pool age) |
| `age_max_enabled` | `true` | Block "too old" |
| `insider_gate_enabled` | `true` | Block high insider / funding-cluster % |
| `holder_gate_enabled` | `true` | Block single-holder / top-10 concentration |
| `rugcheck_veto_enabled` | `true` | Block high RugCheck score (the rugged-creator flag stays on regardless) |
| `creator_rug_enabled` | `true` | Block creators with prior rugs |
| `gmgn_security_enabled` | `true` | Block honeypot / sell-tax flags from GMGN |

Thresholds:

| Key | Default | Meaning |
|---|---|---|
| `single_holder_max_pct` | `15` | Max % of supply for any single holder |
| `top10_max_pct` | `40` | Max % for top-10 holders combined |
| `insider_cluster_max_pct` | `10` | Max % held by insider/funding clusters |
| `rugcheck_veto_normalised` | `41` | RugCheck "Danger" veto line |
| `age_min_minutes` | `45` | Survive the instant-rug window |
| `age_max_days` | `14` | Meme-mode age ceiling |
| `allow_token2022_extensions` | `["metadata"]` | Token-2022 extensions tolerated (nothing else) |

## `[timing]` — soft, feeds the score

| Key | Default | Meaning |
|---|---|---|
| `freefall_15m_max_pct` | `-20` | 15m return below this = penalty |
| `ath_proximity_pct` | `3` | Within this % of ATH + overextension = penalty |
| `vol_spike_ratio` | `3` | Last 5m candle ≥ 3× trailing-hour average = ignition |
| `vol_spike_bonus` | `0.25` | Score bonus for ignition |

## `[score_caps]`, `[smartflow]`, `[score]`

| Key | Default | Meaning |
|---|---|---|
| `score_caps.bonus_cap_total` | `10` | Trending + smart-flow bonuses combined never exceed this |
| `smartflow.window_min` | `30` | Rolling window (minutes) for GMGN smart-money feeds |
| `smartflow.min_wallets` / `bonus_wallets` | `3` / `4` | ≥3 distinct smart wallets buying → +4 |
| `smartflow.min_joiners` / `bonus_joiners` | `2` / `4` | ≥2 newly-joining wallets → +4 |
| `smartflow.bonus_kol` | `4` | Any KOL buy in window → +4 |
| `smartflow.net_sell_penalty_usd` / `penalty_net_sell` | `5000` / `8` | Net smart-money selling beyond $5k → −8 |
| `score.w_fee_momentum` | `30` | Score weight: fee/TVL momentum |
| `score.w_turnover` | `20` | Score weight: volume/TVL turnover |
| `score.w_vetting_soft` | `25` | Score weight: soft vetting quality |
| `score.w_timing` | `15` | Score weight: timing filter |
| `score.w_pool_structure` | `10` | Score weight: bin step / fee tier fit (weights sum to 100) |

## `[entry]`

| Key | Default | Meaning |
|---|---|---|
| `fib_bottom` | `0.786` | Fib retracement anchoring the range bottom |
| `max_down_pct` | `50` | Max range depth below price (was 65; deepest bins sat below where P0 fires) |
| `min_down_pct` | `40` | Minimum depth — never a thin sliver |
| `max_position_accounts` | `2` | Max DLMM position accounts per entry (69 bins each) |
| `bin_rent_budget_sol` | `0.075` | Soft rent budget (one bin array) — shrink range first |
| `bin_rent_hard_sol` | `0.15` | Hard budget (two arrays), only when score qualifies |
| `bin_rent_hard_score_min` | `80` | Score needed for the two-array budget |
| `liquidity_slippage_pct` | `5.0` | Active-bin slippage at open (≈5 bins at step 100; 1% caused 100% of live open failures) |
| `tranche_enabled` | `true` | Second, deeper BidAsk pocket for top scores |
| `tranche_score_min` | `85` | Score needed for a tranche |
| `tranche_size_pct` | `50` | Tranche size as % of primary |
| `tranche_max_down_pct` | `70` | Tranche target depth (clamped by the P0 safety margin to ~50%) |

## `[manage]` — the P0–P5 state machine

| Key | Default | Meaning |
|---|---|---|
| `poll_s` | `15` | Seconds between position polls |
| `safety_tvl_drop_pct` | `40` | P0: pool TVL drop in 10 min |
| `safety_wallet_dump_pct` | `3` | P0: single holder's supply-% drop between polls |
| `safety_new_whale_pct` | `10` | P0: new wallet exceeding this % of supply |
| `holder_poll_s` | `90` | Holder-snapshot interval per open position |
| `safety_price_crash_pct` | `-60` | P0: price vs entry, **at any age** — deliberately no time window |
| `stop_loss_frac` | `0.75` | P1: close when SOL value < entry × this |
| `loss_reentry_cooldown_h` | `24` | Cooldown after a loss exit |
| `rotation_fee_daily_min_pct` | `5` | P2: fee-rate floor, %/day |
| `rotation_polls` | `3` | P2: consecutive polls under the floor before rotating |
| `rotation_vol_30m_min_usd` | `5000` | P2: 30m volume floor |
| `max_age_h` | `48` | P2: forced re-evaluation age |
| `above_range_pct` | `5` | P3: how far above range top counts as "above" |
| `above_range_sustain_min` | `10` | P3 wins exit after 10 min (short so follow can arm) |
| `above_range_missed_sustain_min` | `45` | P3 misses wait 45 min (10 min was churning rent) |
| `rebalance_max_per_6h` | `2` | Re-entry/rebalance rate limit |
| `rebalance_cost_max_pct_of_fees` | `25` | Skip if rent+tx would exceed this % of fees earned |
| `reentry_ladder_mult` | `0.75` | Each re-entry sizes at this × the previous |
| `reentry_max_per_24h` | `2` | Max re-entries per token per 24h |
| `house_money_rule` | `false` | Off: it banked notional profit with no release path |
| `claim_min_sol` | `0.05` | P4: claim when unclaimed fees reach this |
| `claim_min_txcost_mult` | `20` | …or ≥ 20× estimated tx cost |
| `claim_interval_h` | `4` | …or every 4h regardless |
| `grace_claim_min_sol` | `0.005` | Claim floor when price first drops below range (bank fees at the top of a dump) |
| `fee_destination` | `"bank"` | `bank` (swap fees to SOL, wallet) — `compound`/`hybrid` reserved |
| `compound_score_min` | `70` | Min pool score for compounding (if ever enabled) |
| `escape_hatch_depth_pct` | `60` | Escape hatch: dip through this % of range depth… |
| `escape_hatch_recovery_pct` | `25` | …then recovery into the top % of range → close & reset |
| `profit_lock_enabled` | `true` | Bank a slice of strong runners |
| `profit_lock_at_frac` | `1.30` | Fires at mark ≥ entry × 1.30 while in range |
| `profit_lock_withdraw_pct` | `30` | Withdraw this % of liquidity |
| `profit_lock_max_fires` | `1` | At most once per position |
| `below_range_grace_min` | `15` | P5: wick-tolerance grace before closing |

## `[sizing]` — Kelly & portfolio limits

| Key | Default | Meaning |
|---|---|---|
| `max_positions` | `5` | Max concurrent positions (tranches count) |
| `min_position_sol` | `0.3` | Floor — below it, fees can't beat tx+rent overhead |
| `min_reentry_sol` | `0.2` | Separate viability floor for re-entries (reused accounts are cheaper) |
| `kelly_enabled` | `true` | Kelly sizing from your own closed-trade ledger |
| `kelly_fraction` | `0.25` | Quarter-Kelly (half-Kelly assumes a *proven* edge) |
| `kelly_lookback` | `50` | Closed positions in the rolling estimate |
| `kelly_min_samples` | `50` | Below this, cold start applies |
| `kelly_cold_start_frac` | `0.03` | Cold start: flat 3% of wallet per position |
| `kelly_max_position_frac` | `0.10` | Hard cap: no position exceeds 10% of wallet |
| `kelly_block_negative` | `false` | Off: negative edge clamps to the min-size floor instead of a permanent stop |
| `reserve_sol` | `1.0` | Operational reserve, never deployed |
| `reserve_pct` | `10` | Plus this % of bankroll held back for rent/fees |
| `per_token_max_pct` | `40` | Max % of deployable in one token incl. tranche |
| `score_mult_low` / `mid` / `high` | `0.5` / `1.0` / `1.5` | Size tilt for score 60–70 / 70–85 / 85+ |
| `circuit_daily_loss_pct` | `3` | Circuit breaker: realized 24h loss % of bankroll |
| `circuit_pause_h` | `12` | Breaker pause length |
| `circuit_weekly_triggers_halt` | `2` | Two trips in 7 days → full halt until resumed |
| `cluster_brake_exits` | `4` | Cluster brake: this many lossy hard exits… |
| `cluster_brake_window_h` | `6` | …within this window… |
| `cluster_brake_pause_h` | `2` | …pauses new entries this long |
| `cluster_brake_loss_pct` | `10` | "Lossy" = realized ≤ −10% of entry |
| `regime_filter` | `true` | SOL/USD regime filter on |
| `regime_sol_24h_halve_pct` | `-8` | SOL −8%/24h → halve new sizes |
| `regime_sol_24h_pause_pct` | `-15` | SOL −15%/24h → pause new entries |

## `[follow]` — up-only re-entry chains

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Follow mode on |
| `min_vol_30m_usd` | `100000` | Arm only at 4× the normal entry volume floor |
| `retrace_arm_pct` | `15` | Required dip from the post-exit / post-high peak |
| `range_depth_pct` | `30` | Leg depth (tighter than the 40% default) |
| `leg_size_sol` | `0.25` | Fixed leg size — the mode earns more with its own ledger |
| `max_legs` | `3` | Per chain |
| `chain_loss_budget_sol` | `0.075` | Chain ends when cumulative leg PnL breaches this |
| `chain_max_age_h` | `12` | Chain lifetime |
| `cold_polls_end` | `3` | Consecutive polls under the normal volume floor ends the chain |
| `open_fail_cooldown_s` | `300` | Wait after a failed leg open |

## `[majors]` — spot parking for allowlisted alts

| Key | Default | Meaning |
|---|---|---|
| `enabled` / `discovery` | `true` / `true` | Sleeve on; discovery sweep on |
| `discovery_pages` | `8` | Datapi pages for the majors sweep |
| `symbol_allowlist` | `PUMP, ANSEM, JTO, BONK, WIF, RAY, JUP` | Only these symbols |
| `mcap_min_usd` | `0` | No mcap floor (allowlist is the gate) |
| `age_min_days` | `7` | Token must be ≥ 7 days old |
| `strategy_shape` | `"spot"` | Uniform bins — not the meme BidAsk ramp |
| `range_below_pct` / `range_above_pct` | `12` / `6` | Band below/above price — SOL biased to the downside |
| `entry_rsi_period` / `entry_rsi_max` | `14` / `45` | Enter when RSI ≤ 45 (oversold)… |
| `entry_swing_position_max` | `0.40` | …or price in the bottom 40% of the 24h swing |
| `entry_swing_avoid_top` | `0.75` | Never enter above 75% of the swing range |
| `fee_tvl_24h_min_pct` / `fee_tvl_30m_daily_min_pct` | `0.08` / `0.05` | Much lower heat floors than meme |
| `tvl_min_usd` / `tvl_max_usd` | `100000` / `10000000` | TVL band |
| `vol_30m_min_usd` | `5000` | Volume floor |
| `max_pool_share_pct` | `5` | Pool-share cap |
| `size_sol` / `max_position_sol` | `0.75` / `1.5` | Fixed entry size / absolute cap |
| `max_slots` | `1` | One majors position at a time |
| `deploy_cap_pct` | `40` | Max % of wallet in majors |
| `meme_reserve_slots` | `2` | Majors only enter when this many slots stay free for memes |
| `stop_loss_frac` | `0.60` | Wider stop than meme (spot holds inventory) |
| `escape_hatch_enabled` | `false` | Majors hold through dips |
| `below_range_grace_min` | `120` | 2h grace below range (vs meme 15m) |
| `claim_min_sol` | `0.02` | Claim floor |
| `fee_compound` | `false` | Bank only |
| `profit_lock_enabled` | `false` | Off for majors |
| `max_age_h` | `168` | One-week age cap |
| `above_range_sustain_min` / `above_range_missed_sustain_min` | `240` / `480` | Slow take-profit timers |
| `rotation_fee_daily_min_pct` | `0.05` | Rotation floor (must sit at/below the entry floor) |
| `rotation_vol_30m_min_usd` | `2000` | Rotation volume floor |
| `rotation_polls` | `20` | Sustained decay before rotating |
| `[[majors.pools]]` | PUMP, ANSEM seeds | Optional whitelist seeds; discovery still finds the best live pool per symbol |

## `[rotation]` — capital agility

| Key | Default | Meaning |
|---|---|---|
| `alpha_slots` | `1` | Slots reserved for score ≥ `alpha_score_min` only |
| `alpha_score_min` | `85` | The alpha bar |
| `displacement_enabled` | `true` | Full book + exceptional candidate → close weakest |
| `displacement_margin` | `15` | Candidate must beat the weakest's *current* score by this |
| `displacement_min_hold_min` | `30` | Positions younger than this are safe |
| `displacement_value_frac_min` | `0.97` | Never displace a position > 3% underwater |
| `displacement_max_per_6h` | `2` | Displacement rate limit |

## `[exec]`

| Key | Default | Meaning |
|---|---|---|
| `mode` | `paper` \| `live` | Live **also** requires `FARMER_MODE=live` in the environment — both switches or nothing trades |
| `use_zap` | `true` | Meteora Zap SDK (Jupiter V6) for token→SOL; lite-Jupiter fallback on failure |
| `exit_slippage_bps` | `50` | Normal exit swap slippage |
| `safety_exit_slippage_bps` | `1000` | P0 safety exits: speed over price |
| `tx_retries` | `3` | Network retries before abandoning and re-quoting |
| `paper_promotion_days` | `7` | Consecutive profitable paper days for live eligibility |

::: info Not a knob
The 1% GNME buy-and-burn usage fee is hardcoded in `src/executor/profitBurn.ts` — it is deliberately **not** a config key. See [Fees](./fees).
:::

## `[watchdog]`

| Key | Default | Meaning |
|---|---|---|
| `rpc_blind_after_min` | `5` | After this long without a successful mark: **alert and freeze new entries** — never liquidate blind. (The old blind close-all was *removed from the code* in 2026‑08, not just disabled.) |

## `[gmgn]`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Auto-off when `GMGN_API_KEY` is empty |
| `intervals` | `["5m", "1h"]` | Trending windows checked each scan |
| `min_liquidity_usd` | `10000` | Liquidity floor for trending entries |
| `bonus_sustained` / `bonus_emerging` / `bonus_fading` | `8` / `4` / `3` | Score bonus: trending in both windows / 5m only / 1h only |
| `require_renounced` | `true` | Trending entry says mint/freeze not renounced → pre-vet skip |

## `[apis]`

| Key | Default |
|---|---|
| `meteora_datapi` | `https://dlmm.datapi.meteora.ag` |
| `rugcheck` | `https://api.rugcheck.xyz` |
| `jupiter_quote` | `https://lite-api.jup.ag/swap/v1` |
| `jupiter_price` | `https://lite-api.jup.ag/price/v3` |
| `jup_datapi` | `https://datapi.jup.ag` (undocumented; soft signals only) |

## Environment variables (`.env` / `data/.env`)

Not in `config.toml`, but part of the same picture:

| Var | Meaning |
|---|---|
| `FARMER_MODE` | `paper` (default) or `live` — half of the live double lock |
| `RPC_URL` | Solana RPC endpoint — we suggest [Helius](https://www.helius.dev/) mainnet (`https://mainnet.helius-rpc.com/?api-key=…`) |
| `JUPITER_API_KEY` | [Jupiter Developer Portal](https://developers.jup.ag/portal) API key for exit swaps (free tier OK) |
| `GMGN_API_KEY` | Optional — [GMGN](https://gmgn.ai/ai) query key for trending/vetting enrichment. See [API keys](./api-keys#gmgn-api-key-gmgn_api_key-optional) |
| `WALLET_PRIVATE_KEY` / `WALLET_KEYPAIR_PATH` | Live wallet (or use the dashboard's encrypted wallet instead) |
| `WALLET_PASSPHRASE` | Optional (Railway): auto-unlock the encrypted wallet on boot |
| `DASH_TOKEN` / `DASH_PORT` | Dashboard auth token and port (default 8787) |
| `FARMER_CONFIG_PATH` / `FARMER_ENV_PATH` / `FARMER_DB_PATH` | Override runtime file locations (PM2 ecosystem sets these under `data/`) |

## Related

- [Strategy reference](./strategy) — what these thresholds do in context
- [Risk & sizing](./risk) — the safety keys explained
- [Settings profiles](./profiles) — curated packs of these knobs
- [Dashboard guide](./dashboard) — editing settings from the UI
- [config.toml (repo template)](https://github.com/CryptoGnome/dlmmbot/blob/main/config.toml)
