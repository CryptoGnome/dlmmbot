# Meteora Farmer — Strategy & System Specification

Status: DRAFT for review. Every number in `[brackets]` is a config default, tunable in `config.toml` without code changes.

Philosophy (from the Tux/Gmet playbook): **capital preservation first**. One-sided SOL bid-ask below price as the default entry shape, mechanical exits instead of conviction-holding, PnL denominated in SOL. The bot has no whale chat to consult, so wherever the humans "ask the group," the bot must be strictly more defensive.

---

## 1. Scanning — building the candidate list

Runs every `[60s]`.

1. **Pool sweep** — `GET dlmm.datapi.meteora.ag/pools`
   `filter_by: is_blacklisted=false && tvl > [5000]`, `sort_by: fee_tvl_ratio_30m:desc`, first `[3]` pages.
2. **Dedupe to canonical token** — group pools by token mint; if multiple tokens share a symbol (copycats), only the one with the highest 24h volume is considered; the rest are ignored for `[24h]`.
3. **Per-token: pick the best pool** — highest `fee_tvl_ratio_24h` among that token's pools that pass pool gates (§2.1). One pool per token.
4. Output: scored candidates → vetting (§3) → entry queue.

Optional secondary source `[off by default]`: GMGN trending list as a *discovery* input (requires API key). Never a substitute for our own vetting.

## 2. Entry criteria

A candidate must pass **every hard gate**. Soft criteria feed the opportunity score, which drives sizing (§5) and queue priority.

### 2.1 Pool gates (hard)

| Gate | Default | Why |
|---|---|---|
| TVL | ≥ `[$5,000]` and ≤ `[$2,000,000]` | Below: no routing, arb-only. Above: fees too diluted for meme mode |
| Fee/TVL 24h (or lifetime if pool < 24h old) | ≥ `[20%]`/day | The video's meme threshold |
| Fee/TVL 30m annualized to daily | ≥ `[10%]`/day | Catches pools that *were* hot but died |
| Volume 30m | ≥ `[$25,000]` | Fees need flow now, not this morning |
| Volume trend: `vol_1h / (vol_24h/24)` | ≥ `[0.8]` | Current hour at least ~80% of the daily average hour — not in freefall |
| Base fee | `[0.2%–5%]` | >5% = arb-only pools (video) |
| Bin step | ≥ `[80]` for tokens < 7 days old | Wide coverage with fewer bins |
| Fee collection | `[prefer_quote]` — quote-only (SOL) pools get a score bonus; both-token pools stay eligible | User preference: fees in SOL. Quote-only pools (`collect_fee_mode=1`, ~13% of pools) pay fees pre-converted to SOL — no swap at claim. Both-token pools still bank to SOL via claim-time swap. Hard modes `quote_only`/`both_only` available in config |
| Quote token | SOL `[required]` | Gmet's accumulate-SOL thesis; USDC mode later |
| Pool price vs Jupiter quote divergence | ≤ `[2%]` | The video's oracle-glitch / empty-pool trap |

### 2.2 Token gates (hard) — the vetting engine

Computed fresh at entry time from RPC + RugCheck free API (see VETTING.md — reverse-engineered scoring notes):

- Mint authority revoked, freeze authority revoked.
- Token program: SPL Token, or Token-2022 with **no** extensions beyond metadata (no transfer fee/hooks).
- Single holder ≤ `[15%]` of supply, top-10 holders ≤ `[40%]` — both excluding labeled pool vaults, lockers, burn.
- Insider/funding clusters ≤ `[10%]` of supply (same-funder wallet clustering + launch-slot snipers).
- Creator has **zero** tokens in our DB or RugCheck's `creatorTokens` that rugged. One strike = permanent creator blacklist.
- RugCheck `score_normalised` < `[41]` (their "Danger" line) — used as a veto only, never as approval.
- Token age ≥ `[45 min]` (survive the instant-rug window; the video author got burned skipping this) and ≤ `[14 days]` in meme mode.
- Not on our blacklist (§7).

### 2.3 Timing filter (soft but scored)

- Price not in freefall: 15m return ≥ `[-20%]`.
- Not top-blasting: if price is within `[3%]` of its ATH *and* stoch-RSI-style overextension on 5m candles, score penalty (we enter *after* a retrace leg, like the video's fib-anchored entries).
- Buy/sell imbalance from OHLCV volume: heavy net selling in last 5m = penalty (video checks this).

### 2.4 Opportunity score (0–100, drives sizing + priority)

Weighted blend `[weights in config]`: fee/TVL momentum (30m vs 24h) 30%, volume/TVL turnover 20%, vetting softness (holder distribution quality, holder growth, maker diversity) 25%, timing (§2.3) 15%, pool structure (bin step fit, fee tier vs competition) 10%. Entry queue is score-descending; ties broken by younger pool.

## 3. Entry execution

Default shape — **Tux entry**: one-sided SOL, bid-ask, below current price.

1. Compute swing high/low from 5m OHLCV over the pool's life (max 24h lookback).
2. Range top = active bin. Range bottom = the *shallower* of: fib `[0.786]` retracement of the swing, or `[-65%]` from current price. Floor of `[-40%]` minimum depth — never a thin sliver.
3. Translate to bin IDs. A DLMM position account spans ≤ 69 bins: if the range needs more, either widen bin-step choice (§2.1) or split into `[max 2]` position accounts.
4. Bin rent budget: unrecoverable new-bin initialization cost ≤ `[0.05 SOL]` per position, else shrink range.
5. `initializePositionAndAddLiquidityByStrategy` with `StrategyType.BidAsk`, `totalXAmount = 0` (SOL side only).
6. Tx policy: slippage `[1%]` — prefer a failed tx over a bad fill (video), priority fee auto from recent fees, `[3]` retries, then abandon and re-quote.
6b. **Exit/rebalance execution — official Zap SDK** (`@meteora-ag/zap-sdk`, verified in Meteora docs):
   - All exits use `zapOutThroughJupiter` (`percentageToZapOut: 100`) — withdraw + swap token side to SOL through Jupiter in one orchestrated flow. Normal exits `[50 bps]` swap slippage; P0 safety exits `[1000 bps]` (speed over price).
   - P3 re-entries and the P4 escape hatch use `rebalanceDlmmPosition` + `estimateDlmmRebalanceSwap` — remove, swap, re-add at new range in a single sequence instead of hand-rolled steps.
   - Partial profit locks use plain `removeLiquidity(bps)` (no close) — DLMM supports fractional withdrawal.
   - Requires a Jupiter API key in config (free tier exists); fallback path if Zap SDK misbehaves: manual `removeLiquidity(shouldClaimAndClose)` + direct Jupiter swap — both paths implemented, config-selectable `[zap]`.
7. **Second tranche** `[off by default]`: for score ≥ `[85]`, an additional wider "worst-case" range (Gmet's dual-range), sized at `[50%]` of the primary, down to fib 0.786-below-the-low.

## 4. Position management — the state machine

Each open position is polled every `[30s]`. States and transitions, in strict priority order (a higher rule preempts a lower one):

### P0 — SAFETY EXIT (checked first, always)
Trigger on any of:
- Pool TVL drops > `[40%]` in 10 min (LP pull).
- Any single wallet sells > `[3%]` of supply in one tx, or a tracked insider cluster starts distributing.
- Top-holder set changes violently (new wallet > `[10%]`).
- Metadata changed, or RugCheck report flips to Danger.
- Token price -`[60%]` from our entry price in < 15 min (rug in progress).

Action: `removeLiquidity(100%, shouldClaimAndClose)` immediately, market-dump token side via Jupiter with elevated slippage `[10%]`, blacklist token + creator, log incident. Speed over price.

### P1 — STOP LOSS
Position mark-to-market in SOL (both sides valued at current price + unclaimed fees) < entry SOL × `[0.75]` → close, swap token side to SOL, realize loss. Token goes on `[24h]` re-entry cooldown. **No conviction override — the bot always takes Gmet's "conviction deteriorated" branch.**

### P2 — ROTATION EXIT (opportunity died)
- Pool `fee_tvl_ratio_30m` annualized < `[5%]`/day for `[3]` consecutive polls, or volume 30m < `[$5,000]` → close (position is dead weight; capital rotates to the queue).
- Position age > `[48h]` in meme mode → forced re-evaluation: stays only if it would qualify as a *fresh entry* today.

### P3 — PRICE ABOVE RANGE → TAKE PROFIT
Two distinct cases, because they mean opposite things:

**(a) Price dipped into our range, then recovered above it — the win condition.** Every bin the price climbed back through sold our accumulated tokens back to SOL *above* our acquisition price; once fully above range, the position is ~100% SOL with the round-trip profit + fees realized. Action: if price > range top by `[+5%]` sustained `[10 min]` → close via zap-out (recover position rent), record realized PnL.

**(b) Price pumped without ever entering our range.** Our SOL was never touched — no profit, no loss, just idle capital sitting below a runaway price. Same close, but recorded as `missed` not `win` (the distinction matters for gate tuning).

**Re-entry after a P3 close — anti-chasing rules:**
- The token goes back through the **full §2 pipeline as a fresh candidate**, including the §2.3 timing filter — so re-entry only happens after a retrace signal, never into a vertical pump.
- Ladder decay: each successive re-entry on the same token within `[24h]` sizes at `[0.75×]` the previous, max `[2]` re-entries — late legs of a pump carry more downside than early ones.
- Rate limits: ≤ `[2]` rebalances per position per `[6h]`; skip entirely if projected rent + tx cost > `[25%]` of fees earned so far.
- **House-money rule** `[on]`: after a profitable close, only the original base size is eligible for redeployment into the *same* token; the profit above entry goes to the banked balance (§5). Winners pay the bankroll, not the next bet on the same coin.

### P3-F — FOLLOW MODE (up-only re-entry after an up-and-out close) `[on]`

Added 2026-08-11. Decided by simulation over the 17 recorded post-exit price paths:
unguarded chasing is negative-EV at every depth/shape (median hot-window retrace is
26%, p75 34%, so tight "top blast" ranges get run through), and this gate set was the
only configuration at/above breakeven at the measured in-range fee rate — with zero
simulated stops or below-range cuts. A P3 close leaves the position 100% SOL, so every
follow re-entry is swapless.

- Any P3 close (win or missed) on a main position **arms a chain** (`follow_chains`).
- A leg opens only when ALL hold: pool `vol_30m ≥ [$100k]` (4× the entry floor),
  current-window heat (30m AND 1h fee rates annualized ≥ the 24h gate — deliberately
  bypassing the stale 24h average, which TVL growth dilutes on exactly the best pools),
  price retraced `[15%]` from the post-exit/post-high peak, and fresh §2.2 vetting.
- Range: one-sided SOL bid-ask, `[30%]` deep (tighter than the [40%] default), top at
  current price. Escape hatch disabled on follow legs (its depth is a fraction of range
  width — at 30% it would fire on ordinary wiggles).
- **Up-only**: after each leg closes up-and-out, the chain re-arms only once price makes
  a NEW chain high. This condition alone separated +EV from −EV in the sim.
- Chain ends on: any non-P3 leg close, `[3]` legs, cumulative chain PnL ≤ −`[0.075]` SOL,
  `[3]` consecutive polls under the normal volume floor, `[12h]` age, blacklist, or vet fail.
- Legs size at `[0.25]` SOL, are exempt from the §P3 re-entry ladder and `reentry_limit`
  (the volume + up-only gates replace them), and are excluded from the main Kelly ledger —
  the mode earns bigger sizing with its own closed-leg evidence, per the §10 principle.
- While a chain is live, the normal pipeline skips that token (`follow_active`): one
  owner of re-entry timing per token.

### P4 — IN RANGE (earning) — fee handling
- Claim when unclaimed fees ≥ max(`[0.05 SOL]`, `[20×]` estimated tx cost) or every `[4h]`, whichever first.
- Fee destination `[bank]`: token-side fees swapped to SOL via Jupiter at claim time; SOL banked to the wallet. Alternative `compound`: fees re-added to the position (only when pool score ≥ `[70]`).
- **Escape hatch** (Gmet's reshape, simplified): if price has fallen through > `[60%]` of our range depth and then recovers to the upper `[25%]` of the range, close and re-enter — this realizes fees and resets the token side near our average acquisition price rather than round-tripping.
- **Profit lock** `[on]`: if position mark-to-market (SOL) ≥ entry × `[1.30]` while still in range, withdraw `[30%]` of liquidity via partial `removeLiquidity` (position stays open and earning) and zap the withdrawn portion to SOL. Fires at most `[once]` per position. Locks in a floor on strong runners without giving up the fee stream.

### P5 — BELOW RANGE (100% token, the red-alert case)
Mechanical, no discussion: hold for `[15 min]` grace (wick tolerance). If price hasn't re-entered the range: close, swap all token to SOL, realize the loss, cooldown the token `[24h]`. If a safety signal coincides → escalate to P0 handling.

## 5. Position sizing & portfolio limits

- **Bankroll**: whatever the dedicated burner wallet holds. Operational reserve `[1.0 SOL]` + `[10%]` of bankroll held back for rent, priority fees, and claim txs — never deployed.
- **Max concurrent positions**: `[7]` (range 6–8; tranches count toward this). Note the interaction with min position size: at 0.5 SOL minimum per position, running 7 slots needs a deployable bankroll of ≥ ~3.5 SOL to actually fill them — with less, the bot simply runs fewer, larger slots (`effective_slots = min(7, floor(deployable / min_position))`).
- **Base size — Kelly criterion** `[on]`: per-position fraction of wallet = `f* × [0.5]` (half-Kelly), where `f* = p − (1−p)/b` is estimated from our **own rolling closed-position ledger** (`[50]` most recent, `p` = win rate, `b` = avgWin/avgLoss as return fractions). Rationale: half-Kelly keeps ~75% of optimal growth with far smaller drawdowns, and buffers estimation error — over-betting past full Kelly turns long-run growth negative.
  - **Cold start** (< `[10]` closed positions): flat `[3%]` of wallet per position.
  - **Hard cap**: `[10%]` of wallet per position regardless of how good f* looks.
  - **Negative-edge brake** `[on]`: if the ledger says f* ≤ 0, new entries stop entirely — the strategy must re-earn its sizing with evidence (gates/config get tuned, paper results improve, brake lifts itself).
  - **Small-bankroll floor**: min position `[0.5 SOL]` beats strict Kelly when the wallet is small (below it, fees can't beat tx+rent overhead).
- **Score multiplier** (tilt within the Kelly budget): score 60–70 → `[0.5×]`, 70–85 → `[1.0×]`, 85+ → `[1.5×]` (still capped by the 10% wallet cap and deployable).
- **Per-token cap**: `[1]` primary position (+ optional tranche). Never two tokens from the same creator. Never > `[40%]` of deployable in one token including its tranche.
- **Min position**: `[0.5 SOL]` — below this, fees don't beat tx+rent overhead.
- **Circuit breaker**: realized loss > `[10%]` of bankroll in rolling 24h → no new entries for `[12h]` (open positions still managed). Two triggers in 7 days → full halt until manually resumed.
- **Regime filter** `[on]`: SOL/USD -`[8%]` in 24h → halve all new position sizes; -`[15%]` → pause new entries (meme liquidity dies in SOL crashes).
- **Capital agility** (room for spectacular newcomers):
  - **Alpha slot(s)** `[1]` of max positions accept only candidates scoring ≥ `[85]` — ordinary opportunities can never fill the whole book.
  - **Displacement**: with a full book, a candidate scoring ≥ `[85]` may displace the weakest open position if it beats that position's *current* pool score by ≥ `[15]` points — but never a position held < `[30 min]`, never one more than `[3%]` underwater (no realizing losses to chase), and at most `[2]` displacements per 6h. The displaced position exits via the normal rotation path; the decision log records `displaced_by:<mint>`.
- **Kill switch**: `halt` command / file flag → close everything, swap to SOL, stop.
- **Banked balance**: profits skimmed by the house-money rule (§P3) and profit locks (§P4) accumulate in a `banked` ledger — still in the wallet, but excluded from `deployable` until manually released via config. The bankroll ratchets up only by deliberate choice, not by winning streak.

## 6. What to flag and never look at (skip rules)

Maintained in the `blacklist` table with reason + expiry:

- **Permanent**: creators with a rug in history; tokens that triggered P0; Token-2022 with transfer-fee/hook extensions.
- **24h**: copycat losers of the symbol-dedupe (§1.2); tokens that hard-failed vetting; tokens exited at a loss (re-entry cooldown).
- **Structural skips** (not blacklisted, just never candidates): base fee > 5% pools (arb-only), quote-only fee pools, non-SOL quote (this mode), stables/majors pairs (separate future "majors mode" with its own thresholds: 1%/day target, spot shape, wider TA-based ranges — the video's JTO/DRAM/BOT style), pools where our position would exceed `[20%]` of pool TVL (we'd *be* the exit liquidity).

## 7. Persistence & profit tracking (SQLite, `data/farmer.db`)

Tables:
- `tokens` (mint, symbol, creator, launchpad, first_seen, vetting snapshots), `creators` (address, tokens_launched, rug_count — grows into our own moat), `pools` (address, bin_step, fees, per-poll metric snapshots for offline replay/tuning).
- `positions` (pool, mint, mode paper|live, entry_ts/px/size, range bins, strategy shape, tranche_of, exit_ts/px/reason, rent_paid, status).
- `events` (position_id, ts, type: claim|rebalance|safety|deposit|withdraw, tx_sig, amounts, SOL value, tx_cost).
- `decisions` (ts, mint, action: entered|skipped|exited, full feature vector + which gate failed) — **the tuning dataset**; skipped candidates get outcome backfill (did the ones we passed on moon or rug?) so gates can be loosened/tightened with evidence.
- `pnl_daily` (realized SOL, unrealized SOL, fees SOL, rent+gas SOL, USD marks).
- `blacklist`, `config_history` (every config change, ts).

**PnL accounting**: SOL is the unit of account (USD stored as a snapshot column). Per position: fees claimed + fees unclaimed + (exit value − entry value) − rent − tx costs, all in SOL. Rollups: daily PnL, win rate, avg hold time, fee-APR realized vs IL suffered, cost drag (rent+gas as % of fees — silently eats meme LPs).

**Reconciliation**: on startup, on-chain state wins — enumerate wallet's DLMM positions, diff vs DB, repair, log discrepancies. All amounts from parsed tx results, never from our own intent.

## 8. Modes, ops, observability

- **`paper` (default)**: full pipeline runs, "positions" are simulated against live pool/bin data (fees estimated from actual per-bin fee growth), identical DB records flagged `paper`. Promotion gate to live: `[≥ 7 days]` paper run with positive net SOL PnL after simulated costs.
- **`live`**: requires explicit config flag + env var both set. Wallet keypair path from env; scanner processes never see the key (executor is a separate process with an internal queue).
- **Dashboard**: local web page (single Express route) — open positions with live state, PnL curves, decision log, blacklist; plus `status` CLI.
- **Alerts** `[optional]`: Telegram bot on P0/P1 exits, circuit breaker, low-SOL warning, process crash (systemd/PM2 restart + notify).
- **Config**: `config.toml`, hot-reloaded; every value in this doc lives there.

## 9. Known costs & failure modes we accept

- Bin rent partially unrecoverable on first-funded bins (budgeted §3.4); position rent (~0.057 SOL) refunded on close.
- Meme-mode expectancy comes from many small fee wins + rare full losses on rugs that beat our safety triggers. The vetting engine cannot catch a well-executed slow rug; sizing caps (§5) are the real defense.
- Free RugCheck reports are cached — our own RPC checks are the fresh layer; RugCheck is a veto, not a green light.
- RPC outage → manager can't see; watchdog: if polling blind > `[5 min]`, attempt safety-close-all via fallback RPC `[on]`.

## 10. Deferred / future features

- **Majors mode / core fallback** (JTO/tokenized-stock/HYPE-SOL style, per both source authors' "safer plays" tier): `[~1%]`/day fee target, spot/curve shapes, stoch-RSI-style entries, week-scale holds, compound-into-position fee policy, curated whitelist of blue-chip pairs. Deployed as a **fallback allocation**: capital the meme scanner isn't using parks here instead of idling. Sizing design (agreed 2026-08-07):
  - **Separate Kelly ledger per mode** — meme and majors return distributions are incompatible; pooling samples corrupts both estimators.
  - Majors uses **continuous Kelly (f\* = μ/σ² on daily mark-to-market returns of the majors book)** rather than discrete win/loss — week-scale holds produce too few closed-trade samples, daily marks activate the estimator in ~2 weeks. Half-Kelly and hard caps as in meme mode.
  - **Bucket cap** `[~40–50%]` of deployable + **headroom guarantee**: always keep ≥ `[2]` meme slots' worth of capital uncommitted so the parking lot never blocks a spectacular meme opportunity (recalling majors capital costs exit fees and minutes).
- USDC-quote mode. Auto-compounding schedules. Multi-wallet sharding.
- Weight auto-tuning from the `decisions` outcome dataset (simple grid search first, nothing fancy).
- GMGN API enrichment; RugCheck paid WebSocket firehose (`$12/mo`) if scanner latency matters.
- Pool *creation* (the video covers it) — deliberately out of scope: different game, worse EV for us.
