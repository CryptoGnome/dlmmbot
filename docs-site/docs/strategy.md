---
title: Strategy reference
description: The full DLMM Bot rulebook — pool gates, token vetting, scoring, entry shape, the P0–P5 exit ladder, follow mode, and blacklist rules.
---

# Strategy reference

This page mirrors [STRATEGY.md](https://github.com/CryptoGnome/dlmmbot/blob/master/STRATEGY.md), the repo's live spec, in plain language. Values shown are the **current shipped defaults from `config.toml`** — several were deliberately tightened after live book review, so where the spec's original bracketed default differs, this page shows what actually runs. Everything here is hot-reloadable via [Settings / config.toml](./configuration).

Philosophy: **capital preservation first.** One-sided SOL bid-ask below price as the default entry, mechanical exits instead of conviction-holding, PnL denominated in SOL. Wherever a human would "ask the group," the bot is strictly more defensive.

## 1. Scanning

Runs every **60s**:

1. **Pool sweep** — `GET dlmm.datapi.meteora.ag/pools`, non-blacklisted pools with TVL > $5,000, sorted by 30-minute fee/TVL, first **3** pages.
2. **Dedupe to canonical token** — group pools by token mint. If multiple tokens share a symbol (copycats), only the one with the highest 24h volume is considered; the rest are ignored for **24h**.
3. **Best pool per token** — highest `fee_tvl_ratio_24h` among that token's pools that pass the pool gates. One pool per token.
4. Output: scored candidates → vetting → entry queue (best score first, ties broken by younger pool).

Optional discovery enrichment: GMGN trending and smart-money feeds (needs `GMGN_API_KEY`; auto-off without one — [how to get a key](./api-keys#gmgn-api-key-gmgn_api_key-optional)). These only add **score bonuses** (capped at +10 total) — never a substitute for vetting.

## 2. Pool gates (hard)

A candidate pool must pass **every** gate:

| Gate | Current default | Why |
|---|---|---|
| TVL | ≥ $5,000 and ≤ $2,000,000 | Below: no routing, arb-only. Above: fees too diluted for meme mode |
| Market cap | ≥ $100,000 ($100–200k routes to the **micro** sleeve) | Hard floor |
| Fee/TVL 24h (or lifetime if pool < 24h old) | ≥ 20%/day | The meme-pool heat threshold |
| Fee/TVL 30m, annualized to daily | ≥ 10%/day | Catches pools that *were* hot but died |
| Volume 30m | ≥ $25,000 | Fees need flow *now*, not this morning |
| Volume trend `vol_1h / (vol_24h/24)` | ≥ 0.8 | Current hour at least ~80% of the daily average — not in freefall |
| Base fee | 0.2%–5% | > 5% = arb-only pools |
| Bin step | ≥ 80 for tokens < 7 days old | Wide coverage with fewer bins |
| Fee collection | `prefer_quote` — quote-only (SOL) pools get a score bonus; both-token pools stay eligible | Quote-only pools pay fees pre-converted to SOL. Hard modes `quote_only` / `both_only` / `any` exist in config |
| Quote token | SOL required | Accumulate-SOL thesis; stable/USDC pairs are out of scope |
| Pool price vs Jupiter quote | divergence ≤ 2% | The oracle-glitch / empty-pool trap |
| Pool share | our position ≤ 20% of pool TVL | Otherwise *we'd be* the exit liquidity |

## 3. Token vetting gates (hard)

Computed **fresh at entry time** from RPC + the RugCheck free API:

- Mint authority revoked, freeze authority revoked.
- Token program: SPL Token, or Token-2022 with **no** extensions beyond metadata (no transfer fees or hooks).
- Single holder ≤ **15%** of supply; top-10 holders ≤ **40%** — both excluding labeled pool vaults, lockers, and burn addresses.
- Insider/funding clusters ≤ **10%** of supply (same-funder wallet clustering + launch-slot snipers).
- Creator has **zero** rugged tokens in our DB or RugCheck's `creatorTokens`. One strike = permanent creator blacklist.
- RugCheck `score_normalised` < **41** (their "Danger" line) — used as a **veto only**, never as approval.
- Token age ≥ **45 min** (survive the instant-rug window) and ≤ **14 days** in meme mode. Age is the mint's age via RugCheck, not the pool's.
- Not on our blacklist (§8 below).

Each vetting check has a master on/off switch in Settings (age min/max, insider gate, holder gate, RugCheck veto, creator-rug gate, GMGN honeypot/sell-tax gate). Off = skip that hard fail; thresholds still apply when on.

## 4. Timing filter (soft — feeds the score)

These never override a hard fail; they only tilt the score (how big, how soon):

- Price not in freefall: 15m return ≥ **−20%**.
- Not top-blasting: price within **3%** of ATH plus stoch-RSI-style overextension on 5m candles → penalty. The bot enters *after* a retrace leg, not into a vertical.
- Buy/sell imbalance from OHLCV volume: heavy net selling in the last 5m → penalty.
- Volume ignition: last 5m candle ≥ **3×** the trailing-hour average → bonus.

## 5. Opportunity score (0–100)

Weighted blend, drives sizing and queue priority:

| Component | Weight |
|---|---|
| Fee/TVL momentum (30m vs 24h) | 30% |
| Volume/TVL turnover | 20% |
| Vetting softness (holder distribution quality, holder growth, maker diversity) | 25% |
| Timing (§4) | 15% |
| Pool structure (bin-step fit, fee tier vs competition) | 10% |

GMGN trending bonuses (sustained +8, emerging +4, fading +3) and smart-money flow bonuses stack on top but are capped at **+10 combined**; heavy smart-money net selling (> $5,000) applies a −8 penalty.

## 6. Entry execution

Default shape — one-sided SOL, **BidAsk**, below current price:

1. Compute swing high/low from 5m OHLCV over the pool's life (max 24h lookback).
2. Range top = active bin. Range bottom = the *shallower* of: fib **0.786** retracement of the swing, or **−50%** from current price. Floor of **−40%** minimum depth — never a thin sliver. (The planner also derives a cap from the P0 crash threshold, so no bins are planned below where P0 would already have fired.)
3. Translate to bin IDs. A DLMM position account spans ≤ 69 bins; if the range needs more, split into at most **2** position accounts.
4. **Bin-array rent** (~0.075 SOL per array, non-refundable when arrays are new): soft budget one array — shrink the range first. Hard budget two arrays (0.15 SOL) only when score ≥ **80**. The bot quotes actual uninitialized arrays on-chain; RPC quote failure falls back to the worst-case estimate (fail closed). Never more than two arrays.
5. Open with `StrategyType.BidAsk`, SOL side only (`totalXAmount = 0`).
6. Tx policy: active-bin liquidity slippage **5%** (≈5 bins at bin step 100 — the earlier 1% setting produced 100% of live open failures as `ExceededBinSlippageTolerance`). Priority fee auto from recent fees; a failed program simulation never resends the same tx; **3** network retries, then abandon and re-quote. On bin-slippage rejection the live path **rebuilds** the position rather than spamming the same bad transaction.
7. **Second tranche**: for score ≥ **85**, an additional BidAsk pocket *below* the primary, sized at **50%** of the primary, down toward −70% (clamped by the P0 safety floor). Skipped on the micro sleeve, when the primary already fills the floor, or when slots/size floors block it. Tranches count toward max open positions.

**Exit swap path:** on close, the token side converts to SOL via the Meteora Zap SDK (Jupiter V6), with a lite-Jupiter fallback. Normal exits use **50 bps** swap slippage; P0 safety exits use **1000 bps** (speed over price).

## 7. The P0–P5 exit ladder

Each open position is polled every **15s**. Rules are checked in strict priority order — **first match wins**:

| Priority | Name | Trigger | Action |
|---|---|---|---|
| **P0** | Safety exit | Any of: pool TVL −40% in 10 min · single wallet sells >3% of supply in one tx · tracked insider cluster distributing · new whale >10% · metadata changed or RugCheck flips to Danger · price −60% from entry (**at any age** — there is deliberately no time window) | Remove 100% + close immediately, market-dump token→SOL at 10% slippage, **blacklist token + creator**, log incident |
| **P1** | Stop loss | Mark-to-market in SOL (both sides + unclaimed fees) < entry × **0.75** | Close, swap token→SOL, realize loss, 24h re-entry cooldown. No conviction override — ever |
| **P2** | Rotation | Fee rate (30m annualized) < 5%/day for 3 consecutive polls, or 30m volume < $5,000; or position age > 48h (then it stays only if it would qualify as a *fresh* entry today) | Close — dead weight; capital rotates to the queue |
| **P3** | Above range | Price > range top by 5%, sustained | Close via zap, recover rent, record PnL. See win vs missed below |
| **P4** | In range | Earning | Claim/bank fees; escape hatch; profit lock (below) |
| **P5** | Below range | Price under the bottom bin — position is 100% token | Hold **15 min** grace (wick tolerance), then close, swap all token→SOL, realize the loss, 24h cooldown. Coinciding safety signal escalates to P0 |

### P3: win vs missed

Two cases that look the same but mean opposite things:

- **Win** — price dipped *into* the range, then recovered above it. Every bin it climbed back through sold our tokens above acquisition price; the position ends ~100% SOL with round-trip profit + fees. Exit after **10 min** sustained above range (short, so follow mode can arm).
- **Missed** — price pumped without ever entering the range. The SOL was never touched: no profit, no loss, just idle capital. Exit after **45 min** sustained (a shorter timer was churning ~0.002 SOL rent per round trip on slots the bot wasn't refilling).

### Re-entry after P3 (anti-chasing)

- The token goes back through the **full pipeline as a fresh candidate** — including the timing filter — so re-entry happens after a retrace signal, never into a vertical pump.
- **Ladder decay:** each successive re-entry on the same token within 24h sizes at **0.75×** the previous; max **2** re-entries. A re-entry must still clear a 0.2 SOL viability floor.
- **Rate limits:** ≤ 2 rebalances per position per 6h; skip entirely if projected rent + tx cost > 25% of fees earned so far.
- **House-money rule is off** (it banked notional profit with no release path; deployable only ever fell).

### P3-F: Follow mode

Optional overtime after any P3 close (win or missed), designed **not** to chase — the gate set below was the only configuration at/above breakeven in simulation over the recorded post-exit price paths:

- A P3 close on a main position **arms a chain**.
- A leg opens only when **all** hold: pool 30m volume ≥ **$100,000** (4× the normal entry floor) · current 30m **and** 1h fee rates annualized ≥ the 24h gate (bypassing the stale 24h average) · price retraced **15%** from the post-exit/post-high peak · fresh token vetting passes.
- Leg shape: one-sided SOL BidAsk, **30%** deep (tighter than the 40% default), top at current price, escape hatch disabled.
- **Up-only:** after a leg closes up-and-out, the chain re-arms only once price makes a **new chain high**. This condition alone separated +EV from −EV in the sim.
- Chain ends on: any non-P3 leg close · **3** legs · cumulative chain PnL ≤ **−0.075 SOL** · 3 consecutive polls under the normal volume floor · **12h** age · blacklist or vet fail. A failed leg open cools the chain 300s.
- Legs are fixed at **0.25 SOL**, exempt from the re-entry ladder, and excluded from the main Kelly ledger — the mode must earn bigger sizing with its own closed-leg evidence.
- While a chain is live, the normal pipeline skips that token: one owner of re-entry timing per token.

## 8. P4 detail: fees, escape hatch, profit lock

- **Claim** when unclaimed fees ≥ max(0.05 SOL, 20× estimated tx cost), or every 4h, whichever first. When price first drops below range, fees are claimed immediately (min 0.005 SOL) so token-side fees convert to SOL at the top of a dump, not the bottom.
- **Fee destination `bank`:** token-side fees swap to SOL at claim time and bank to the wallet. (A `compound` mode exists in config for pools scoring ≥ 70 but banking is the shipped behavior; majors also bank only.)
- **Escape hatch:** if price fell through > **60%** of the range depth and then recovers to the upper **25%** of the range → close and re-enter. This realizes fees and resets near the average acquisition price instead of round-tripping the whole dip. Disabled on follow legs and majors.
- **Profit lock:** if mark-to-market ≥ entry × **1.30** while still in range → withdraw **30%** of liquidity (position stays open and earning) and zap it to SOL. Fires at most **once** per position. A floor under strong runners without giving up the fee stream.

## 9. Majors sleeve (separate playbook)

SOL-quoted majors/alts on a symbol allowlist (`PUMP`, `ANSEM`, `JTO`, `BONK`, `WIF`, `RAY`, `JUP`), discovered by their own sweep. Key differences from meme:

| Aspect | Majors behavior |
|---|---|
| Shape | **Spot** (uniform bins), 12% below / 6% above price — SOL biased to the downside |
| Timing entry | RSI(14) ≤ 45, **or** price in the bottom 40% of the 24h swing; never above 75% of the swing |
| Size | Fixed 0.75 SOL, max 1.5 SOL per position, max **1** slot, ≤40% of wallet |
| Stop loss | entry × **0.60** (wider than meme — spot holds inventory) |
| Below-range grace | **120 min** (vs meme 15) |
| Escape hatch / profit lock | Off — majors hold through dips |
| Rotation | Much slower: 20 consecutive polls under a 0.05%/day fee floor; max age 168h; above-range sustains 240/480 min |
| Fees | Bank only, claim min 0.02 SOL |

Majors run after meme entries and only when ≥ 2 slots stay free for memes. Token age must be ≥ 7 days.

## 10. Blacklist & skip rules

Kept in the `blacklist` table with reason + expiry:

| Kind | What lands there |
|---|---|
| **Permanent** | Creators with any rug in history; tokens that triggered P0; Token-2022 with transfer-fee/hook extensions |
| **24h cooldown** | Copycat losers of symbol dedupe; tokens that hard-failed vetting; tokens exited at a loss |
| **Structural skips** (never candidates, not blacklisted) | Base fee > 5% pools; non-SOL quotes (incl. SOL-USDC); pools where our position would exceed 20% of TVL |

Every skip is logged with the failing gate in the `decisions` table — the tuning dataset. Skipped candidates get outcome backfill (did the ones we passed on moon or rug?) so gates can be tightened or loosened with evidence, not vibes.

## 11. Accounting

- **SOL is the unit of account** (USD stored as a snapshot column for readability).
- Per position: fees claimed + fees unclaimed + (exit value − entry value) − rent − tx costs, all in SOL. Realized PnL is **measured wallet delta** — what actually left and returned — never our own intent.
- **Reconciliation:** on startup, the chain wins. The bot enumerates the wallet's actual DLMM positions, diffs against the DB, repairs, and logs discrepancies.

## Related

- [How it works](./how-it-works) — the newcomer's tour of this same material
- [Risk & sizing](./risk) — Kelly, circuit breaker, cluster brake, HALT
- [Configuration reference](./configuration) — every threshold above as a config key
- [FAQ](./faq) — honest answers about losing money
- [STRATEGY.md](https://github.com/CryptoGnome/dlmmbot/blob/master/STRATEGY.md) — the raw spec with live-book history
