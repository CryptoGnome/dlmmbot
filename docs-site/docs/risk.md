---
title: Risk & sizing
description: How DLMM Bot sizes positions (Kelly) and what stops it from digging holes — circuit breaker, cluster brake, regime filter, HALT/PAUSE, watchdog, and the paper-to-live promotion gate.
---

# Risk & sizing

Memecoin LP expectancy comes from **many small fee wins plus rare full losses** on rugs that beat the safety triggers. The vetting engine cannot catch a well-executed slow rug — sizing caps and brakes are the real defense. This page is how the bot decides *how big*, and everything that can stop it.

::: danger The honest frame
You can lose 100% of the funds under this bot's control. Nothing here removes that; it bounds it. Burner wallet only, paper first. Not financial advice.
:::

## The bankroll

The bankroll is whatever the dedicated burner wallet holds. Before anything deploys:

- **Operational reserve:** 1.0 SOL + 10% of bankroll is held back for rent, priority fees, and claim transactions — never deployed.
- **Slots:** max **5** concurrent positions (tranches count). Small wallets simply run fewer, larger slots: at the 0.3 SOL minimum position, effective slots = `min(5, floor(deployable / 0.3))`.

## Kelly sizing

Position size is a fraction of the wallet, learned from **your own rolling closed-trade ledger** — not from anyone's backtest:

1. **Cold start** — until 50 closed positions exist, every position is a flat **3% of wallet**.
2. **Estimate f\*** — from the 50 most recent closes: `f* = p − (1−p)/b`, where `p` = win rate and `b` = average win / average loss (as return fractions). The estimator uses **measured wallet-delta PnL**, not notional marks.
3. **Apply a fraction of it** — the bot bets `kelly_fraction × f*`. Shipped default is **0.25 (quarter-Kelly)**: half-Kelly is calibrated for a *known* edge, and a young book hasn't demonstrated one. Fractional Kelly keeps most of the growth with far smaller drawdowns and buffers estimation error — betting past full Kelly turns long-run growth negative.
4. **Score tilt** — the scan score multiplies the result: 0.5× (score 60–70), 1.0× (70–85), 1.5× (85+).
5. **Clamps** — hard cap **10% of wallet** per position no matter how good f\* looks; floor of **0.3 SOL** (below it, fees can't beat tx + rent overhead; re-entries get a separate 0.2 SOL floor).

**Negative edge:** if the ledger says f\* ≤ 0, the shipped behavior (`kelly_block_negative = false`) clamps sizing to the minimum floor — small size while the sample rebuilds. The alternative hard block (`true`) stops new entries entirely until the strategy re-earns its sizing; it's off by default because blocked entries produce no new closes, so f\* could never recover on its own.

Follow-mode legs are **excluded** from this ledger and fixed at 0.25 SOL — the mode must earn bigger sizing with its own closed-leg evidence.

## Per-token and pool-share caps

- **1** primary position per token (plus an optional tranche at score ≥ 85).
- Never two tokens from the same creator.
- Never more than **40%** of deployable in one token including its tranche.
- Never a position exceeding **20%** of pool TVL (10% for micro, 5% for majors) — beyond that, *we'd be* the exit liquidity.
- Micro sleeve: max 1 slot, 0.45 SOL cap, ≤5% of wallet total. Majors: max 1 slot, ≤40% of wallet, fixed 0.75 SOL entries.

## Bin-rent budget

Opening a range can create new bin arrays at ~0.075 SOL each, **non-refundable**. The gate:

- Soft budget **0.075 SOL** (one array) — the planner shrinks the range first.
- Hard budget **0.15 SOL** (two arrays) only when score ≥ **80**, and only after quoting the *actual* uninitialized arrays on-chain.
- Never more than two arrays. If the RPC quote fails, the bot assumes worst case and blocks (fail closed).

Position-account rent (~0.057 SOL) is refunded on close — bin-array rent is the cost that silently eats meme LPs, so it's budgeted explicitly.

## The brakes

Three independent systems can stop **new entries** (open positions are always still managed):

| Brake | Trips when | Effect |
|---|---|---|
| **Circuit breaker** | Realized loss > **3%** of bankroll in a rolling 24h | No new entries for **12h**. Two trips in 7 days → full halt until manually resumed |
| **Cluster brake** | **4** lossy hard exits (realized ≤ −10% of entry) within **6h** | Pause new entries **2h** — catches a dump cluster before the wallet-% breaker can |
| **Regime filter** | SOL/USD −**8%** in 24h → halve all new sizes; −**15%** → pause new entries | Meme liquidity dies in SOL crashes |

The circuit breaker started at the spec's 10% and was tightened to 3% after live data: the worst observed day (−0.159 SOL on a ~24 SOL book) was still under even the 3% line, which is why the cluster brake exists as a faster, count-based trigger.

## HALT vs PAUSE vs OFF

Three different "stop" concepts — don't confuse them:

| Control | What it does | Positions? | How |
|---|---|---|---|
| **PAUSE / engine OFF** | Freeze trading — no scans act, no entries, no exits initiated | **Stay open**, still watched | Dashboard header ON/OFF toggle, or `npm run pause` (writes a `PAUSE` file; run again to clear) |
| **HALT** | Kill switch: close **everything**, swap to SOL, then idle | **All closed** | Dashboard red HALT button (confirm with dash token), or `npm run halt` (writes a `HALT` file; run again to clear/resume) |
| **Paper mode** | Full pipeline, simulated fills, no wallet needed | Simulated | `FARMER_MODE=paper` (the default) |

## Watchdog & liveness

- **No blind liquidation.** If RPC goes dark for **5 minutes**, the bot alerts and freezes new entries — it never closes positions it cannot see. The old "blind close-all" was **removed from the code** (not just disabled): closing requires strictly more RPC than marking, so it could only ever complete when firing it was a mistake.
- **Out-of-process heartbeat.** The manager writes a heartbeat row at the end of every tick; `deploy/heartbeat-check.cjs` (run from cron, dependency-free, imports nothing from `src/`) alerts via Telegram when it goes stale. Every in-process alert dies with the process — "no messages" reads identically to "quiet market" — which is exactly why the checker lives outside.
- **Restart safety.** Positions live in SQLite. On startup the bot reconciles against the chain — **on-chain state wins** — repairs the DB, and resumes. Restarts are safe by design.

## One instance per wallet

The loop holds a lock file (`data/farmer.lock`). **Never run two bot processes against the same wallet/DB** — they would double-trade the same strategy, and in live mode, the same wallet. The lock is per-machine, so a dev-PC loop plus a server loop is the dangerous case; when the server takes over, stop the local one.

::: warning Windows kill gotcha
On Windows, killing a background `npm run run` kills only the npm wrapper — the `tsx` child **survives and keeps trading**. Kill every node process whose command line matches the repo path, then delete `data/farmer.lock`.
:::

## Paper first: the promotion gate

- **Paper is the default.** The full brain runs against live pool data; fills are simulated; no wallet is needed.
- **Promotion gate:** `npm run status` tracks a scoreboard of consecutive profitable paper days (realized + change in unrealized, after simulated costs). Eligibility requires **7 consecutive profitable days** (`paper_promotion_days`).
- **Live is double-gated:** it needs `[exec] mode = "live"` in config **and** `FARMER_MODE=live` in the environment. Either one alone keeps the bot in paper. This is deliberate: no single mis-click, bad config push, or stray env var can start spending real SOL.

The gate is advisory — the bot won't stop you from flipping both switches early — but the scoreboard exists so the decision is made on evidence.

## The usage fee

On each **live winning close**, 1% of the measured net profit buys and burns GNME in one Jupiter transaction. It is hardcoded (not a Settings knob), skipped on losses and mark-only closes, and logged-but-not-spent in paper mode. Details in the [FAQ](./faq#whats-the-1-gnme-burn-fee).

## What the safety net cannot do

Being honest about the limits:

- A **well-executed slow rug** passes vetting and bleeds out under the stop loss. Sizing caps are the only defense.
- P0 fires on signals — TVL collapse, dumps, whale changes, metadata flips — but a rug that beats the 15s poll can still take most of a position.
- RugCheck free reports are cached upstream; our own RPC checks are the fresh layer, and RugCheck is only ever a veto.
- The stop loss (P1) realizes −25%+ by definition. The live book's P1 exits were dump-throughs that kept falling after exit — the stop is doing its job, not failing.

## Related

- [Strategy reference](./strategy) — the P0–P5 ladder these brakes protect
- [Configuration reference](./configuration) — every brake threshold as a key
- [FAQ](./faq) — "Can I lose money?" and other direct answers
- [How it works](./how-it-works) — the pipeline overview
- [CLI reference](./cli) — `halt`, `pause`, `status`, `force-close`
