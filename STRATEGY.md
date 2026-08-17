# Meteora Farmer — Strategy & System Specification

Status: **Live spec** (updated 2026-08-13). Bracketed `[defaults]` are the original design reference; **`config.toml` is what runs on gn0meserver** — many values were deliberately changed after live book review (see §11).

Operator-facing mirror: dashboard **Wiki** tab (`dashboard/src/wiki/content.ts`). When this spec or live behavior changes, update the Wiki in the same commit (`.cursor/rules/wiki-sync-on-commit.mdc`).

Philosophy (from the Tux/Gmet playbook): **capital preservation first**. One-sided SOL bid-ask below price as the default entry shape for meme/micro, mechanical exits instead of conviction-holding, PnL denominated in SOL. The bot has no whale chat to consult, so wherever the humans "ask the group," the bot must be strictly more defensive.

---

## 1. Scanning — building the candidate list

Runs every `[60s]`.

1. **Pool sweep** — `GET dlmm.datapi.meteora.ag/pools`
   `filter_by: is_blacklisted=false && tvl > [5000]`, `sort_by: fee_tvl_ratio_30m:desc`, first `[3]` pages.
2. **Dedupe to canonical token** — group pools by token mint; if multiple tokens share a symbol (copycats), only the one with the highest 24h volume is considered; the rest are ignored for `[24h]`.
3. **Per-token: pick the best pool** — the **deepest** (highest TVL) among that token's pools that pass pool gates (§2.1); `fee_tvl_ratio_24h` breaks ties only within `[25%]` of the deepest pool's TVL. One pool per token. *Was* "highest fee/TVL" — and since fee/TVL is inversely proportional to TVL, that structurally picked the *thinnest* sibling (measured 2026-08-15: 11 of 18 multi-pool mints on the board, and in 9 of those the deeper pool also had more absolute volume). Thin pools cost twice: less fee income, because volume happens where depth is; and TVL that swings 40–50% on ordinary LP repositioning, which is exactly what P0 `tvl_drain` reads as a rug — same token, same 4 minutes, an $8k pool swung 51% while its $67k sibling moved 9%. The gates are the family boundary: a bin-20 pool is never an alternative to a bin-100 pool because `bin_step_new` rejects it, so depth is compared only across shapes the strategy already accepts.
4. Output: scored candidates → vetting (§3) → entry queue.

Optional secondary source `[off by default]`: GMGN trending list as a *discovery* input (requires API key). Never a substitute for our own vetting.

### 1.1 Three-tier sleeves (shipped 2026-08-13)

One scanner pipeline, three deployment sleeves. Sleeve is recorded at entry and drives sizing + manage rules.

| Sleeve | Entry | Range shape | Sizing / caps |
|---|---|---|---|
| **micro** | Meme scanner, mcap `$100k–$200k` | BidAsk (meme planner) | `0.5×` Kelly, max 1 slot, 5% wallet deploy cap |
| **meme** | Meme scanner, mcap `≥ $200k` | BidAsk | Kelly + score multiplier; main strategy |
| **majors** | Discovery sweep + symbol allowlist + TA timing gates | **Spot** (uniform bins) | Fixed `0.75 SOL`; separate manage rules; excluded from meme Kelly |

Majors runs **after** meme entries each tick when open slots ≤ `meme_reserve_slots` (keeps headroom for hot memes). SOL-quoted alts only — stable pairs (SOL-USDC) are **out of scope**, not deferred.

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
| Quote token | SOL `[required]` | Gmet's accumulate-SOL thesis; stable/USDC pairs out of scope |
| Pool price vs Jupiter quote divergence | ≤ `[2%]` | The video's oracle-glitch / empty-pool trap. Fails **closed**: no usable Jupiter quote → distinct `price_divergence_unavailable` skip, never a pass |

### 2.2 Token gates (hard) — the vetting engine

Computed fresh at entry time from RPC + RugCheck free API:

- Mint authority revoked, freeze authority revoked.
- Token program: SPL Token, or Token-2022 with **no** extensions beyond metadata (no transfer fee/hooks).
- Single holder ≤ `[15%]` of supply, top-10 holders ≤ `[40%]` — both excluding labeled pool vaults, lockers, burn.
- Insider/funding clusters ≤ `[10%]` of supply (same-funder wallet clustering + launch-slot snipers).
- Creator has **zero** tokens in our DB or RugCheck's `creatorTokens` that rugged. One strike = permanent creator blacklist.
- RugCheck `score_normalised` < `[41]` (their "Danger" line) — used as a veto only, never as approval.
- Token age ≥ `[45 min]` — survive the instant-rug window; the video author got burned skipping this. This one is a **safety** gate and stays on.
- Token age ≤ `[14 days]` is **off by default** (`age_max_enabled = false`). It was a *fit* gate, never a safety gate, and a poor proxy: the pool gates (`fee_tvl_24h`, `fee_tvl_30m_daily`, `vol_30m`, `mcap_min`) already measure current traction directly, and anything clearing them is by definition active right now. A revived old meme catching a bid is a legitimate pool — the strategy wants fee flow, and fee flow does not care when the mint was created. Nothing else in the engine reads token age: it is recorded as a fact and carries no score, sizing or ranking weight, so allowing older mints adds no hidden penalty. Turn it back on to restore the ceiling.
- Not on our blacklist (§7) — checked for both the token mint **and** the creator address.

Fail-closed rule: when the engine is blind it fails, it does not pass on the gates it could still see. If both holder-data sources are down (no RugCheck report and no RPC holder resolution) → `holder_data_unavailable`; if no age source exists (RugCheck `detectedAt` and pool `created_at` both missing, and at least one age gate is enabled) → `age_unknown`. These transient fails skip the 24h token blacklist so the token is re-checked next sweep. A blind honeypot/sell-tax source is recorded as a `securityDataUnavailable` soft note (it is a cross-check layer, not the primary gate set).

### 2.3 Timing filter (soft but scored)

- Price not in freefall: 15m return ≥ `[-20%]`.
- Not top-blasting: if price is within `[3%]` of its ATH *and* stoch-RSI-style overextension on 5m candles, score penalty (we enter *after* a retrace leg, like the video's fib-anchored entries).
- Buy/sell imbalance from OHLCV volume: heavy net selling in last 5m = penalty (video checks this).

### 2.4 Opportunity score (0–100, drives sizing + priority)

Weighted blend `[weights in config]`: fee/TVL momentum (30m vs 24h) 30%, volume/TVL turnover 20%, vetting softness (holder distribution quality, holder growth, maker diversity) 25%, timing (§2.3) 15%, pool structure (bin step fit, fee tier vs competition) 10%. Entry queue is score-descending; ties broken by younger pool.

## 3. Entry execution

Default shape — **Tux entry**: one-sided SOL, bid-ask, below current price.

1. Compute swing high/low from 5m OHLCV over the pool's life (max 24h lookback). **Candle source** (2026-08-15): the Meteora datapi caps `/ohlcv` at **10 bars on every timeframe** — verified 5m/30m/1h/4h, no paging parameter helps — so this "24h lookback" was silently the last 50 minutes, the meme timing filter's "last hour" got 50 minutes, and majors RSI(14) was never computable (the majors timing gate had been swing-only since it was written; the first-ever majors entry, ANSEM pos#8, went in on a 50-minute swing reading 27% when the 8-hour reading was 67%). Candles now come from GeckoTerminal (`[100]` bars/call, keyless, `currency=token` so bars are SOL-denominated like `pool.price`), datapi as fallback — never fewer bars than before. `[candles]` in config.
2. Range top = active bin. Range bottom = the *shallower* of: fib `[0.786]` retracement of the swing, or `[-65%]` from current price. Floor of `[-40%]` minimum depth — never a thin sliver.
3. Translate to bin IDs. A DLMM position account spans ≤ 69 bins: if the range needs more, either widen bin-step choice (§2.1) or split into `[max 2]` position accounts.
4. Bin rent: soft budget `[0.075 SOL]` (one bin array) — shrink range first. If still over, quote **actual** uninitialized arrays on-chain; allow when actual ≤ soft, or ≤ `[0.15 SOL]` (two arrays) when score ≥ `[80]`. Never more than two arrays. RPC quote failure falls back to worst-case estimate (fail closed).
5. `initializePositionAndAddLiquidityByStrategy` with `StrategyType.BidAsk`, `totalXAmount = 0` (SOL side only).
6. Tx policy: active-bin slippage `[5%]` — maps to `ceil(pct / (binStep/100))` bins (5 bins at step 100). Was `[1%]` (=1 bin at step 100), which produced 100% of live `ExceededBinSlippageTolerance` open failures. Prefer a failed tx over a bad fill still holds for *swap* exits; for LP open, rebuild-on-slippage + a few bins of tolerance is correct. Program sim failures do not resend the same tx; `[3]` network retries, then abandon and re-quote.
6a. **Priority fee & compute budget.** A prioritization fee is `price × REQUESTED compute-unit limit`, charged on what the tx asks for rather than what it burns, so both halves are set deliberately. Price = the `[75th]` percentile of *nonzero* recent fees **for the accounts the tx writes** (`lockedWritableAccounts`) — a network-wide median under-prices a contended pool, and a contended pool is the only kind we transact on — clamped to `[10k]`–`[1M]` µlamports/CU and multiplied by `[1.5]` per retry attempt, since re-sending an identical fee is the one thing that cannot fix a fee-caused non-landing. Limit = simulated consumption + `[20%]`, probed against the 1.4M ceiling so a route that would blow the implicit 200k-per-instruction default still reports a usable number. The DLMM SDK sets its own simulated limit and Jupiter's `/swap` sets both halves; we add ours only to what we build (zap swap, wSOL unwrap, close-account batches), and never a second instruction of a kind already present.
6b. **Exit execution — one path.** After `removeLiquidity(shouldClaimAndClose)`, the token side goes to SOL through Jupiter's versioned `/swap` (multi-hop routes, address lookup tables, `dynamicComputeUnitLimit`, auto priority fee) with escalating slippage — the path that has closed every live position.
   - Normal exits `[50 bps]` swap slippage; P0 safety exits `[1000 bps]` (speed over price).
   - Partial profit locks: `removeLiquidity(bps)` then the withdrawn token side → SOL through the same swap.
   - **Escape hatch:** deep dip then recovery → **close** (realize fees / reset).
   - **The zap path was removed in v0.11.0** (`use_zap`, `@meteora-ag/zap-sdk`, the in-place escape reshape). It built a legacy, direct-routes-only, 30-account transaction — a strict subset of the versioned path — and produced three incidents in three days: 6025 `InvalidTokenAccount` from the SDK dropping setup instructions (v0.5.1), the reshape leaving empty position shells, and a 400-storm on every close that widened the stale-balance-read window (v0.10.1). Removed outright rather than left off-by-default: an off-by-default path is one that comes back on in somebody's old volume config, which is exactly what bit the live bot for two days. A stale `use_zap` key is ignored with a one-line warning.
7. **Second tranche** `[on]`: for score ≥ `[85]`, an additional BidAsk pocket *below* the primary (Gmet dual-range), sized at `[50%]` of the primary, down toward `tranche_max_down_pct` (clamped by the P0 safety floor). Skipped when the primary already fills that floor, on micro sleeve, or when slots/size floor block it.

## 4. Position management — the state machine

Each open position is polled every `[30s]`. States and transitions, in strict priority order (a higher rule preempts a lower one):

### P0 — SAFETY EXIT (checked first, always)
Trigger on any of:
- Pool TVL drops > `[40%]` in 10 min (LP pull).
- Any single wallet sells > `[3%]` of supply in one tx, or a tracked insider cluster starts distributing.
- Top-holder set changes violently (new wallet > `[10%]`).
- Metadata changed, or RugCheck report flips to Danger.
- Token price -`[60%]` from our entry price in < 15 min (rug in progress).

Action: `removeLiquidity(100%, shouldClaimAndClose)` immediately, market-dump token side via Jupiter with elevated slippage `[10%]`, log incident. Speed over price.

**Blacklist severity is split by what the trigger actually evidences** (2026-08-15):
- **Rug evidence** — `pool_dead`, `price_crash`, `rugcheck_flip`, holder/insider triggers → permanent token blacklist **+ one-strike creator ban**.
**`tvl_drain` needs a meaningful baseline** — it is skipped when the pool's median TVL over the window is under `[$20k]` or the pool is younger than `[20 min]`. Measured 2026-08-15 with no rug happening: a thin pool's TVL is a handful of LPs, so one repositioning is a 40% event (same token, same 4 minutes: $8k pool swung 51%, $67k pool 9%); a pool younger than the 10-minute window has its own birth as the baseline. Below either floor the drain read is noise; `pool_dead` and `price_crash` still cover a real collapse there. Unknown pool age does **not** suppress the trigger.

**`tvl_drain` also carries a price-rise veto** `[25%]`: if TVL fell but price rose ≥25% over the same 10-minute window, the pool is having its ask-side inventory **bought out** — traded through, not drained — and P0 does not fire. Note the tie-breaker is *price*, not volume: a rug is a stampede and prints heavy volume too, so volume cannot separate the cases. The veto bar is deliberately high because the error costs are asymmetric — exiting early costs ~0.002 SOL, sitting in a real rug does not. Flat or falling price still fires. The window is in-memory, so the median TVL, current TVL, price change and veto flag are now written to the decision row; before this a `tvl_drain` exit left nothing to audit.

- **`tvl_drain` — liquidity condition, not fraud** → token cooldown `[6h]` only, creator untouched.

**Holder-watch excludes non-wallets by identity, not by tag** (2026-08-15): the DLMM pool we are in is the largest holder of a fresh meme token, and its balance *falls* every time price runs up — buyers taking inventory out. Read as a wallet, that is a `wallet_dump` (a permanent token+creator ban) on a pool being traded through — the same failure shape as the `tvl_drain` false positive. GMGN's exchange tag is honoured but never relied on: our own pool address, every AMM program the vetting side knows, and burn sinks are excluded regardless of tagging. TVL falling 40% below its 10-minute median looks identical whether a thin pool is being *traded through*, LPs are churning in a pool minutes old, or liquidity is genuinely fleeing. The exit is cheap insurance and stays; a permanent ban on that reading is not. pos#5 GUNICORN: one reading on a 9-minute-old pool banned its creator for good, after which the token round-tripped +260% and the pool remained the highest fee/TVL on the board. Discriminator worth remembering: a drain with **heavy volume** is being traded through; a drain with **no volume** is liquidity walking.

### P1 — STOP LOSS
Position mark-to-market in SOL (both sides valued at current price + unclaimed fees) < entry SOL × `[0.75]` → close, swap token side to SOL, realize loss. Token goes on `[24h]` re-entry cooldown. **No conviction override — the bot always takes Gmet's "conviction deteriorated" branch.**

**Wick tolerance (2026-08-16):** while the position is **below range**, the stop must hold for `[4]` consecutive polls (~60s) before P1 fires; **in range it is immediate.** P5's grace timer exists to ride out wicks, but P1 ran ahead of it on a single 15s mark: 4680 pos#11 wicked −54% for under two minutes, P1 cut it at −25%, and the token was +58% within the hour — the biggest loss on the book, on a 5m candle that *closed* at −20%. (The larger bot hit the identical stop on the identical wick and only profited because its exit swap under-filled and the residual sweep sold the leftovers after the bounce — luck, not design.) A violent collapse is still caught immediately by P0 `price_crash`; the sustain only delays the *moderate* below-range case, which is exactly where a wick is plausible.

**Under-filled close (2026-08-16):** if a close leaves the token side in the wallet, that is not a closed position — it is one we stopped watching. The executor now checks the wallet balance for the mint after every close; leftovers are logged as `close_underfilled` with their SOL value, and ≥ `[25%]` of the mark raises an alert. The residual sweep still sells them; the operator just knows at close time instead of discovering it in the ledger.

**Operator close (2026-08-17):** the dashboard's per-position **Close** button (dash-token-authenticated like every other API call, with a confirm dialog as the misclick guard) records `close_requested_at` on the row; the next manage tick closes it through the normal executor path and books the PnL. It runs **ahead of P0–P5** — the operator looked at the position and decided, and no rule should get to relabel that exit (a P1 firing on the same tick would also blacklist the token and feed the cluster brake). Recorded as `manual`, so operator exits stay out of the strategy's own exit statistics. The dashboard cannot close anything itself: only the loop holds the wallet. This is **not** `force-close`, which only writes off rows with nothing left on chain and refuses a position that still holds liquidity.

**Most "under-fills" were stale reads (2026-08-17):** three of the day's four `close_underfilled` events *returned more SOL than the mark* — EYE pos#17 1.70×, BUTTHOLE pos#15 1.26×, MANLET pos#14 1.16×. A swap cannot under-fill and over-return at once. What happened: the close reads the wallet balance right after `removeLiquidity` to decide how much to sell, but a `confirmed` write on one RPC replica is not guaranteed visible on the replica that answers the next `confirmed` read (Helius load-balances). The read returned the **pre-remove** balance, the close sold that smaller number, and the true remainder was flagged as a strand. Fix: `tokenBalanceAfter(mint, sig)` resolves the slot the remove landed in and re-reads until the RPC's context slot reaches it (bounded ~6s, then falls back). The detector's post-swap read uses the same guard in reverse, so a lagging replica can no longer report a fully-sold position as a strand. Separately, `use_zap = true` (a pre-v0.5.1 volume config) sent every close through a direct-routes-only legacy tx that 400s on any fresh meme before falling back to the versioned `/swap` — burning seconds inside the very window this race lives in. Set false on the live bot; the template already shipped false.

**Correction, same day (v0.11.1):** the slot-pinned read did **not** stop it — Z500 pos#20 fired on the very build that carried it, with the same signature: returned 1.16× the mark, 9% left. Re-examining all four events: the over-return is 2×–19× *larger* than the leftover every time. A stale read alone would over-return by roughly zero. So the mark at close is **low** — the position held more than `valueOf()` computed — and the leftover is a symptom of that, not of the read. Two candidates survive: **(a)** `claimReward2` inside `shouldClaimAndClose` pays LM rewards in the pool's reward mint, which for some pools *is* the base token, landing tokens the mark never saw; **(b)** the exit swap's own send lands, its confirm throws, and a later slippage tier re-quotes against a wallet that has since been credited. Every close now logs a three-point token audit (pre-remove / post-remove / post-swap, plus the pool's reward mints) so the next event answers this rather than a fifth guess. Independently, the slippage ladder now re-reads the wallet between tiers: a thrown tier that actually landed is recognised (wallet 0 → stop, not fail) and a partial landing sells only what remains. That guard is correct regardless of which hypothesis wins.

**Resolved (v0.11.2, same evening):** the audit line answered it on its first flagged close — Z500 pos#102 on the server: `pre-remove=0 post-remove=0 sold=0 post-swap=53332678 chainX=53332678 removeTxs=1 swapTx=0`. Neither hypothesis. The remove landed, the wallet read **still returned 0**, the close sold nothing, and all 53M tokens were in the wallet by the time the detector looked. So it *was* the stale replica read all along — the v0.10.1 slot-pin had a hole: it only pins when `getSignatureStatuses` answers, and that lookup can itself hit a replica that has not seen the tx yet, returning `null` and silently falling back to an unpinned read. Two fixes: the status lookup now retries before giving up the pin, and the close treats a wallet reading below half of `chainX` after a sent remove as stale — waits for the credit rather than selling nothing. The over-return that misled the earlier analysis (`close_return ≈ 1.2× mark`) is simply the position-rent refund, present on clean closes too (pos#24: 1.228×, zero leftover); it never discriminated anything.

**Dust is not an incident (2026-08-17):** the leftover check only raises `close_underfilled` when the residue is at least `[0.002 SOL]` — the residual sweep's own floor, below which a sell costs more than it returns. Under it, the tokens are written off at close with a plain log line: no incident, no stranded credit. pos#15 BUTTHOLE closed **+0.0002 SOL — a win** — and still filed an error over 0.00045 SOL (0% of the mark) promising a sweep that was guaranteed to skip it. An **unpriceable** leftover is still flagged: being unable to value it is exactly when it must not be assumed worthless.

**Stranded leftovers are an asset, not a loss (2026-08-17):** realized PnL only sees the SOL that landed, and the sweep's credit arrives up to one sweep interval (`[10 min]`) later — so for that window an under-filled close reads as a near-total loss. It is not cosmetic: ANSEM pos#8 booked −0.5422 SOL at 08:09:53, **tripped the daily circuit breaker 52 seconds later**, and was −0.0100 once the sweep sold the residue at 08:11:45. The quoted value of the leftovers (a real swap quote, taken at close time) is now carried on the row and counted in realized PnL until the sweep replaces it with a measured number. **The credit expires after `[30 min]`** — if the residue cannot be sold, it is a bag we are holding rather than settlement lag, and the loss must show in full. Without that bound the fix would hide real losses, which is worse than the bug.

### P2 — ROTATION EXIT (opportunity died)
- **Meme/micro:** pool `fee_tvl_ratio_30m` annualized < `[5%]`/day for `[3]` consecutive polls, **or** volume 30m < `[$5,000]` → close (fast capital).
- **Majors (spot parking):** both fee **and** volume must be dead — fee annualized < `[0.02%]`/day **and** vol30m < `[$1,500]` for `[120]` polls (~30 min at 15s). Fee floor sits below entry (`[0.05%]`/d) on purpose (hysteresis); equal floors churned PUMP every ~15–45m while volume was still healthy.
- Position age > `[48h]` meme / `[168h]` majors → forced re-evaluation / max hold.

### P3 — PRICE ABOVE RANGE → TAKE PROFIT
Two distinct cases, because they mean opposite things:

**(a) Price dipped into our range, then recovered above it — the win condition.** Every bin the price climbed back through sold our accumulated tokens back to SOL *above* our acquisition price; once fully above range, the position is ~100% SOL with the round-trip profit + fees realized. Action: if price > range top by `[+5%]` sustained `[10 min]` → close via zap-out (recover position rent), record realized PnL.

**(b) Price pumped without ever entering our range.** Our SOL was never touched — no profit, no loss, just idle capital sitting below a runaway price. Same close shape, but sustained `[45 min]` (not 10) before exit, recorded as `missed` not `win`. The short timer was churning rent (~0.002 SOL) on slots we weren't refilling.

**Re-entry after a P3 close — anti-chasing rules:**
- The token goes back through the **full §2 pipeline as a fresh candidate**, including the §2.3 timing filter — so re-entry only happens after a retrace signal, never into a vertical pump.
- Ladder decay: each successive re-entry on the same token within `[24h]` sizes at `[0.75×]` the previous, max `[2]` re-entries — late legs of a pump carry more downside than early ones.
- Rate limits: ≤ `[2]` rebalances per position per `[6h]`; skip entirely if projected rent + tx cost > `[25%]` of fees earned so far.
- **House-money rule** `[off on live]` — was banking notional profit with no release path; deployable only ever fell. Disabled 2026-08-09.

### P3-F — FOLLOW MODE (up-only re-entry after an up-and-out close) `[on]`

Added 2026-08-11. Decided by simulation over the 17 recorded post-exit price paths:
unguarded chasing is negative-EV at every depth/shape (median hot-window retrace is
26%, p75 34%, so tight "top blast" ranges get run through), and this gate set was the
only configuration at/above breakeven at the measured in-range fee rate — with zero
simulated stops or below-range cuts. A P3 close leaves the position 100% SOL, so every
follow re-entry is swapless.

- Any P3 close (win or missed) on a main position **arms a chain** (`follow_chains`) — **provided the pool still has `vol_30m ≥ [$100k]` at close time** (the same bar a leg needs to fire). Measured 2026-08-17 over the server bot's 15 chains: only 3 ever fired a leg (5m, 15m, 52m after arming — all winners); the other 12 armed on pools that had already gone quiet — six died `volume_died` inside 60 s, the rest sat `awaiting_dip` for up to 4.6 h on a price that never moved 15% either way. Cost-free in SOL, but every armed chain holds the `follow_active` lock on its mint, and that lock was the #1 skip reason in the decisions table: the scanner passed on tokens a dead-ish chain still owned. No heat → no chain → no lock.
- **Dip timeout** `[90 min]`: a chain that sits `awaiting_dip` this long without its retrace ends (`dip_timeout`) and releases the mint. Measured from when the chain last entered `awaiting_dip`, not from chain start — a chain that just closed a winning leg goes `awaiting_high` first and is not charged for that wait. Every leg that ever fired did so inside 52 min. `0` disables.
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
  `[3]` consecutive polls under the normal volume floor, `[90 min]` awaiting a dip, `[12h]` age, blacklist, or vet fail.
- Legs size at `[0.25]` SOL, are exempt from the §P3 re-entry ladder and `reentry_limit`
  (the volume + up-only gates replace them), and are excluded from the main Kelly ledger —
  the mode earns bigger sizing with its own closed-leg evidence, per the §10 principle.
- While a chain is live, the normal pipeline skips that token (`follow_active`): one
  owner of re-entry timing per token.

### P4 — IN RANGE (earning) — fee handling
- Claim when unclaimed fees ≥ max(`[0.05 SOL]`, `[20×]` estimated tx cost) or every `[4h]`, whichever first.
- Fee destination `[bank]`: token-side fees swapped to SOL via Jupiter at claim time; SOL banked to the wallet. Alternative `compound`: fees re-added to the position (only when pool score ≥ `[70]`).
- **Escape hatch** (Gmet's reshape, simplified): if price has fallen through > `[60%]` of our range depth and then recovers to the upper `[25%]` of the range, close and re-enter — this realizes fees and resets the token side near our average acquisition price rather than round-tripping.
- **Profit lock** `[on]`: if position mark-to-market (SOL) ≥ entry × `[1.30]` while still in range, withdraw `[30%]` of liquidity via partial `removeLiquidity` (position stays open and earning) and swap the withdrawn portion to SOL. Fires at most `[once]` per position. Locks in a floor on strong runners without giving up the fee stream.

### P5 — BELOW RANGE (100% token, the red-alert case)
Mechanical, no discussion: hold for `[15 min]` grace (wick tolerance). If price hasn't re-entered the range: close, swap all token to SOL, realize the loss, cooldown the token `[24h]`. If a safety signal coincides → escalate to P0 handling.

## 5. Position sizing & portfolio limits

- **Bankroll**: whatever the dedicated burner wallet holds. Operational reserve `[1.0 SOL]` + `[10%]` of bankroll held back for rent, priority fees, and claim txs — never deployed. The flat part is capped at `[25%]` of equity, so a small wallet keeps a deployable bankroll (at 1.0 SOL flat, a 1 SOL wallet reserved *everything* and could never enter); no effect at or above 4 SOL.
- **Max concurrent positions**: `[7]` (range 6–8; tranches count toward this). Note the interaction with min position size: at 0.5 SOL minimum per position, running 7 slots needs a deployable bankroll of ≥ ~3.5 SOL to actually fill them — with less, the bot simply runs fewer, larger slots (`effective_slots = min(7, floor(deployable / min_position))`).
- **Base size — mode** `[kelly|fixed]`: default **Kelly**. Settings may flip the whole book to **Fixed**, where each sleeve (core / micro / majors / follow) uses exact SOL or % of deployable — no Kelly, no score size tilt. Fixed sizes below `min_position_sol` skip the entry (no silent bump). Hard wallet % cap, deployable, slots, and brakes still apply.
- **Kelly criterion** `[on when mode=kelly]`: per-position fraction of wallet = `f* × [0.25]` (quarter-Kelly shipped), where `f* = p − (1−p)/b` is estimated from our **own rolling closed-position ledger** (`[50]` most recent, `p` = win rate, `b` = avgWin/avgLoss as return fractions). Rationale: fractional Kelly keeps most of optimal growth with far smaller drawdowns, and buffers estimation error — over-betting past full Kelly turns long-run growth negative.
  - **Per-sleeve base** (Kelly mode): each sleeve picks **Kelly** (adaptive base × `[1.0]` mult), **SOL**, or **% deployable** — same shape as Fixed, but unit=Kelly uses the adaptive fraction above. Defaults: core/micro = Kelly ×1; majors/follow = fixed `[0.75]` / `[0.25]` SOL. Score multiplier applies on top for Kelly-unit sleeves.
  - **Cold start** (< `[50]` closed positions): flat `[3%]` of wallet per position.
  - **Hard cap**: `[10%]` of wallet per position regardless of how good f* looks.
  - **Negative-edge brake** `[off by default]`: if the ledger says f* ≤ 0 and armed, new entries stop; shipped off so sizing can fall to the min floor while the sample rebuilds.
  - **Small-bankroll floor**: min position beats strict Kelly when the wallet is small (below the floor, fees can't beat tx+rent overhead). The floor **scales with equity** — see *Min position* below.
- **Score multiplier** (Kelly only): score 60–70 → `[0.5×]`, 70–85 → `[1.0×]`, 85+ → `[1.5×]` (still capped by the 10% wallet cap and deployable).
- **Per-token cap**: `[1]` primary position (+ optional tranche). Never two tokens from the same creator. Never > `[40%]` of deployable in one token including its tranche.
- **Min position** — scales with the bankroll: `max([0.05 SOL], min([0.3 SOL], equity × [1%]))`. A flat floor silently switched the bot off for small operators: it is read as the Kelly base floor, as the entry cutoff, as the 10%-wallet-cap override, *and* as the slot divisor, so a 2 SOL wallet either never entered or entered at 15% of equity with the risk cap bypassed — and no bankroll under 20 SOL could take a 60–70 score, because half of a base pinned to the floor is always under the floor. Worked examples: 1 SOL → 0.05 | 5 → 0.05 | 10 → 0.10 | 20 → 0.20 | 30+ → 0.30 (unchanged). The `[0.05 SOL]` absolute floor is what per-trade overhead demands — a fresh mint's token-account rent + fees measured 0.00212 SOL, ~4% of it. `min_position_pct = 0` restores the flat floor.
- **Rent vs position**: non-refundable bin-array rent may not exceed `[25%]` of the position it buys, on top of the absolute `bin_rent_budget_sol`. At a 0.3 SOL entry the two are identical; it binds only on smaller positions, so a scaled-down entry self-selects into pools whose bin arrays are already initialised (actual rent ≈ 0) instead of spending most of itself to open.
- **Circuit breaker**: realized loss > `[10%]` of bankroll in rolling 24h → no new entries for `[12h]` (open positions still managed). Two triggers in 7 days → full halt until manually resumed.
- **Cluster brake** `[on]`: ≥ `[2]` P0/P1 exits in `[6h]` → pause new entries `[6h]` from the trip exit. Catches a dump cluster before the wallet-% breaker (Aug 12 printed −0.159 SOL on a ~24 SOL book — under a 3% line).
- **Regime filter** `[on]`: SOL/USD -`[8%]` in 24h → halve all new position sizes; -`[15%]` → pause new entries (meme liquidity dies in SOL crashes).
- **Capital agility** (room for spectacular newcomers):
  - **Alpha slot(s)** `[1]` of max positions accept only candidates scoring ≥ `[85]` — ordinary opportunities can never fill the whole book.
  - **Displacement**: with a full book, a candidate scoring ≥ `[85]` may displace the weakest open position if it beats that position's *current* pool score by ≥ `[15]` points — but never a position held < `[30 min]`, never one more than `[3%]` underwater (no realizing losses to chase), and at most `[2]` displacements per 6h. The displaced position exits via the normal rotation path; the decision log records `displaced_by:<mint>`.
- **Kill switch**: `halt` / HALT file → close everything, swap to SOL, stop. Soft `pause` / PAUSE file → freeze trading without closing (dashboard ON/OFF).
- **Usage fee (GNME burn)** `[required]`: 1% of *measured* wallet PnL on each winning close buys+burns GNME in one Jupiter tx. Hardcoded product fee — not a Settings knob. A pot only holds leftover if a swap fails. Mark-only closes are skipped. Paper logs the fee without sending.
- **Banked balance**: profits skimmed by the house-money rule (§P3) and profit locks (§P4) accumulate in a `banked` ledger — still in the wallet, but excluded from `deployable` until manually released via config. The bankroll ratchets up only by deliberate choice, not by winning streak.

## 6. What to flag and never look at (skip rules)

Maintained in the `blacklist` table with reason + expiry:

- **Permanent**: creators with a rug in history; tokens that triggered P0; Token-2022 with transfer-fee/hook extensions.
- **24h**: copycat losers of the symbol-dedupe (§1.2); tokens that hard-failed vetting; tokens exited at a loss (re-entry cooldown).
- **Structural skips** (not blacklisted, just never candidates): base fee > 5% pools (arb-only), quote-only fee pools, non-SOL quote (incl. SOL-USDC / stable pairs — out of scope), pools where our position would exceed `[20%]` of pool TVL (we'd *be* the exit liquidity).

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

- **`paper` (default)**: full pipeline runs, "positions" are simulated against live pool/bin data (fees estimated from actual per-bin fee growth), identical DB records flagged `paper`. Promotion gate to live: `[≥ 7 days]` paper run with positive net SOL PnL after simulated costs — consecutive **calendar** days; a day with no data (bot down) breaks the streak.
- **`live`**: requires explicit config flag + env var both set. Wallet keypair path from env; scanner processes never see the key (executor is a separate process with an internal queue).
- **Dashboard**: local web page (single Express route) — open positions with live state, PnL curves, decision log, blacklist; plus `status` CLI.
- **Alerts** `[optional]`: Telegram bot on P0/P1 exits, circuit breaker, low-SOL warning, process crash (systemd/PM2 restart + notify).
- **Config**: `config.toml`, hot-reloaded; every value in this doc lives there.

## 9. Known costs & failure modes we accept

- Bin rent: soft one-array budget + on-chain quote; hard two-array only at high score (budgeted §3.4); position rent (~0.057 SOL) refunded on close.
- Meme-mode expectancy comes from many small fee wins + rare full losses on rugs that beat our safety triggers. The vetting engine cannot catch a well-executed slow rug; sizing caps (§5) are the real defense.
- Free RugCheck reports are cached — our own RPC checks are the fresh layer; RugCheck is a veto, not a green light.
- RPC outage → manager can't see. The blind close-all was **removed 2026-08-10**: `close()`'s RPC set is a superset of `mark()`'s, so it could only finish when firing it was a mistake. Liveness is the out-of-process heartbeat, not in-process liquidation.

## 10. Roadmap checklist (2026-08-13)

### Shipped

- Live DLMM executor, wallet-delta PnL, P0–P5 state machine, escape hatch, follow mode
- GMGN trending/security/smart-money, holder-watch P0 (dump/whale), funding-cluster + launch-slot sniper fallback (`clusters.ts`)
- Cluster brake, open bin-slippage fix, P3 missed sustain (45m), `open_failed` error codes
- Range-shape instrumentation (`position_marks`, per-bin open/claim/close snapshots)
- Three-tier sleeves: micro loss-budget caps, meme (main), majors discovery + spot + TA entry + separate manage
- Residual token sweep, Telegram alerts, out-of-process heartbeat, config hot-reload, auto-deploy watcher
- Jupiter versioned /swap token→SOL on close/claim/sweep/profit-lock (the zap path was removed in v0.11.0)
- Escape hatch (deep dip → recovery → close)
- LAN ops dashboard (`meteora-dash` :8787) — phosphor terminal UI + equity/exit/skip charts
- Kelly on measured wallet PnL (n≥50 on live book); fee banking only (`fee_destination = bank`, `majors.fee_compound = false`)

### Active monitoring (operational — not new builds)

- Post gate-fix live book sample (still 0 closes as of 2026-08-13)
- First majors SPOT entries (TA gates may skip for long stretches)
- Kelly applied fraction — do not raise size/slots yet
- Mark-gap integrity (a) on **new** positions — 3 historical positions still fail max_gap 70–78s
- Profit-lock has never fired (0/57) — leave enabled, not a build target

### Do not ship (decided)

- **Meme BidAsk → Spot/Curve** — [RANGE-SHAPE-DECISION.md](RANGE-SHAPE-DECISION.md) programme closed; edge is escape hatch, tax is P1. Majors spot is a **separate strategy**, not a meme shape flip.
- **SOL-USDC / stable pairs** — out of scope permanently
- Weaken P1 stop, house-money rule, loosen follow `min_vol_30m_usd`, more concurrent slots, narrower meme ranges without escape-hatch rework
- Pool creation tooling — different game, worse EV

### Deferred (future build, if ever)

- Meme `compound` / `hybrid` fee destination (only `bank` implemented)
- Local dashboard (Express UI) — **shipped** as Vite SPA + `deploy/dashboard-server.mjs` (see DEPLOY.md)
- Weight auto-tuning from `decisions` table (n=57 too small; score doesn't separate escape vs P1)
- RugCheck paid WebSocket firehose if scanner latency matters
- Multi-wallet sharding
- Majors continuous Kelly on daily marks; on-chain fee compound (explicitly off)

## 11. Operating conclusions (live book 2026-08-07 → 2026-08-13)

57 closes, measured **+0.251 SOL**. Fees **+1.24**. The edge is the escape hatch (+0.62 / 9); the tax is P1 (−0.55 / 8). P3 is mostly slot-churn (18/27 near-zero, 13 red, many exactly the 10 min sustain).

**Keep (the plan was right):**
- BidAsk, `min_down_pct=40`, escape 60/25, `max_positions=3`, house-money **off**, follow volume/retrace gates, P1 at 0.75.
- All 8 P1s were `fell_deep=1` **and already below range**. They are dump-throughs, not aborted escapes. Escape winners never printed `value_frac` below ~0.83. The five instrumented P1s then fell another 24–86% in 2h — weakening P1 would have been worse. Do not move P1 to WACAP on this sample; RANGE-SHAPE named WACAP as a **Spot prerequisite**, and we are not shipping Spot.
- Follow: 7 chains, 2 legs, both green, 5 `volume_died`. Designed not to chase. Do not loosen `min_vol_30m_usd`.

**Change (shipped 2026-08-13):**
- **P3 missed sustain** — `above_range_missed_sustain_min = 45`. Wins stay at 10m so follow can arm.
- **Cluster brake** — 2× P0/P1 in 6h pauses entries 6h.
- **Open failures were `ExceededBinSlippageTolerance` (6004), not mystery sims.** `liquidity_slippage_pct` 1% → 1 bin at step 100; every meme tick failed (3255/3255 coded sim errors). Raised to 5% (5 bins; SDK default was already 3). `open_failed` decisions now store Anchor code + logs. Live open rebuilds on bin-slippage instead of resending the same tx. Follow cools 300s after a failed leg open.
- **Three-tier sleeves** — micro (100–200k loss-budget), meme (main BidAsk), majors (SOL-quoted alts, spot shape, TA entry, separate manage).
- **Majors fee banking** — `fee_compound = false`; all claimed fees to wallet.
- Kelly watched for a week on measured PnL (n≥50). Don't raise size or slots yet. Profit-lock never fired (0/57) — leave it.

**Live config divergences from bracket defaults** (intentional — see `config.toml` comments):

| Key | Spec default | Live |
|---|---|---|
| `max_positions` | 7 | **5** (was 3; raised 2026-08-13 for more concurrent meme opportunities) |
| `kelly_fraction` | 0.5 (half-Kelly) | **0.25** |
| `kelly_block_negative` | on | **off** (clamp to min size instead of hard stop) |
| `house_money_rule` | on | **off** |
| `circuit_daily_loss_pct` | 10 | **3** |
| `min_position_sol` | 0.5 | **0.3 ceiling on a bankroll-scaled floor** (`min_position_pct = 1%`, hard floor `0.05`; + `min_reentry_sol = 0.2`) |
| `max_down_pct` | 65 | **50** |

**Do not:** meme BidAsk→Spot/Curve, SOL-USDC, more slots, house-money, weaken P1, reintroduce a second swap path. Range-shape stopping sample is met; integrity (a) still fails on 3 historical poll gaps; the P&L split above is the decision.
