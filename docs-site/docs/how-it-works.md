---
title: How the bot works
description: The full DLMM Bot pipeline for newcomers — scan, vet, enter, manage, exit — plus the three sleeves and follow mode.
---

# How the bot works

DLMM Bot is an automated liquidity-provider (LP) bot for [Meteora DLMM](https://meteora.ag) pools on Solana. In one sentence: **it parks SOL in bins just under a hot token's price, earns a fee every time traders move through those bins, and cashes back to SOL by fixed mechanical rules.**

Think of it like a market stall under the current price: shoppers (traders) walk through our bins, we collect a tiny fee each time, and we leave when the rules say leave — not when we "feel" like it.

::: warning Risk first
Memecoin LP can wipe a wallet. The bot is built defense-first (paper mode by default, hard safety gates, mechanical stops), but it cannot catch every rug. **Burner wallet only. Not financial advice.** See [Risk & sizing](./risk).
:::

## The pipeline

Everything runs from one tick loop:

```
scan → vet → enter → manage → exit
  ↑                              │
  └──────── capital rotates ─────┘
```

| Stage | What happens | How often |
|---|---|---|
| **Scan** | Sweep Meteora's pool list for busy SOL-quoted pools; dedupe copycat tickers; apply hard pool gates (TVL, fees, volume, base fee); score survivors 0–100 | Every 60s |
| **Vet** | Fresh on-chain + RugCheck checks on the token itself: authorities revoked, holder concentration, insider clusters, creator rug history, age window | At entry time |
| **Enter** | Open a **one-sided SOL** position below the current price (BidAsk shape for memes, Spot for majors), sized by Kelly + score, within rent budgets | When a candidate passes everything and a slot is free |
| **Manage** | Poll each open position and walk the P0→P5 priority ladder: safety exits, stop loss, rotation, take-profit, fee claims, below-range handling | Every 15s |
| **Exit** | Close the position, swap any leftover tokens back to SOL (Zap SDK, Jupiter fallback), record measured PnL in SQLite | When a rule fires — never on gut feel |

Two design choices run through all of it:

- **SOL is the unit of account.** Wins and losses are measured in SOL that actually left and returned to the wallet — not notional marks, not USD screenshots.
- **Rules beat gut feel.** The bot has no whale chat to consult. Wherever a human trader would "ask the group," the bot takes the strictly more defensive branch.

## Why one-sided SOL below price?

The default entry never buys the token up front. The bot places only SOL, in bins **below** the current price:

1. If price **dips** into the range, the bins mechanically buy tokens on the way down (cheaper each bin).
2. If price **recovers** back up through the range, the same bins sell those tokens back for SOL — above the acquisition price — plus every trade paid a fee.
3. If price **never visits** the range, the SOL just sits there untouched: no profit, but no loss either (only idle capital and a little rent).

The bot is not guessing the top. It waits for price to come to it, earns the round trip, and leaves.

## The three sleeves

One scanner pipeline, three playbooks. The **sleeve** is stamped on each position at entry and decides its range shape, sizing, and manage rules.

| Sleeve | What it trades | Range shape | Sizing (current defaults) |
|---|---|---|---|
| **micro** | Very young/small memes, mcap $100k–$200k | BidAsk below price | 0.5× the core Kelly size, max 0.45 SOL, at most **1** slot, ≤5% of wallet total — loss budget first |
| **meme** | The main book: memes, mcap ≥ $200k | BidAsk below price | Kelly × score multiplier; the bread-and-butter strategy |
| **majors** | Allowlisted SOL-quoted alts (PUMP, JTO, BONK, WIF, RAY, JUP, …) | **Spot** (uniform bins, 12% below / 6% above price) | Fixed 0.75 SOL, max 1 slot, separate slower manage rules |

Majors run **after** meme entries each tick, and only when at least `meme_reserve_slots` (2) remain free — hot memes always keep headroom. Stable pairs like SOL‑USDC are permanently out of scope, not a "later" feature.

## Managing a position: the P0→P5 ladder

Every open position is checked top-to-bottom against a priority ladder every 15 seconds. **First match wins — a higher rule always preempts a lower one.**

| Rule | Name | One-liner |
|---|---|---|
| **P0** | Safety exit | Rug signals → close *now*, dump token to SOL, blacklist token + creator |
| **P1** | Stop loss | Position worth < 75% of entry in SOL → close, take the loss |
| **P2** | Rotation | Fees/volume went cold, or position too old → free the slot |
| **P3** | Above range | Price climbed out the top → take profit (or exit slowly if it never visited us) |
| **P4** | In range | Earning: claim/bank fees, maybe profit-lock a slice, escape hatch |
| **P5** | Below range | 100% token after a short grace → close, swap to SOL, cool down |

Full details with every threshold: [Strategy reference](./strategy).

## Follow mode (careful re-entry)

After a clean up-and-out close (P3), the token often keeps running. Follow mode may re-enter the same token — but only through deliberately picky gates, because simulation over recorded price paths showed unguarded chasing loses money:

```
P3 close ──arms──▶ wait for: hot volume (≥$100k/30m)
                          + 15% retrace from the peak
                          + fresh token vetting
                └──▶ open a tighter leg (30% deep, 0.25 SOL)
                └──▶ re-arm only after a NEW chain high (up-only)
                └──▶ chain ends on: any non-P3 close, 3 legs,
                     −0.075 SOL cumulative loss, cold volume, or 12h
```

While a follow chain owns a token, the normal scanner skips it — one owner of re-entry timing per token. See [Strategy reference → Follow mode](./strategy#p3-f-follow-mode).

## Paper vs live

- **Paper (default):** the full brain runs — real scanning, real vetting, real pool data — but fills are simulated. Identical database records, flagged `paper`. No wallet needed.
- **Live:** real SOL. Deliberately double-locked: it requires **both** `FARMER_MODE=live` in the environment **and** `[exec] mode = "live"` in config. One switch alone stays safe.

The built-in promotion gate: `npm run status` tracks consecutive profitable paper days and marks you **eligible** after 7. See [Risk & sizing → Paper first](./risk#paper-first-the-promotion-gate).

## What's actually running

| Process | Job |
|---|---|
| **Farmer** | The tick loop — scans, vets, opens, manages, closes. The strategy lives here. |
| **Dashboard** | The web UI: live positions, charts, HALT button, settings, the in-app Wiki. |
| **Deploy watcher** (optional, PM2 path) | Pulls new builds from GitHub — automatically, or after you Approve. |
| **SQLite + config** | `data/farmer.db` (positions, decisions, errors) and `data/config.toml` (your knobs, hot-reloaded). |

The chain is the source of truth: on every startup the bot enumerates the wallet's actual on-chain DLMM positions, diffs against the database, and repairs the DB to match.

## Related

- [Strategy reference](./strategy) — every gate, threshold, and exit rule
- [Risk & sizing](./risk) — Kelly, brakes, HALT/PAUSE, promotion gate
- [Configuration reference](./configuration) — every knob in `config.toml`
- [Dashboard guide](./dashboard) — tab-by-tab tour
- [Easy setup (Railway)](./easy) · [Advanced setup](./advanced)
