---
title: How the bot works
description: The full DLMM Bot pipeline for newcomers — scan, vet, enter, manage, exit — plus the three sleeves and follow mode.
---

# How the bot works

An automated LP bot for [Meteora DLMM](https://meteora.ag) on Solana: **park SOL in bins just under a hot token’s price, earn a fee when traders move through, cash back to SOL by fixed rules.**

Like a stall under the current price: shoppers walk through the bins, we collect a tiny fee, and we leave when the rules say leave.

<p class="note warn">Memecoin LP can wipe a wallet. Burner only. See <a href="./risk">Risk &amp; sizing</a>.</p>

## The pipeline

Everything runs from one tick loop:

```
scan → vet → enter → manage → exit
  ↑                              │
  └──────── capital rotates ─────┘
```

| Stage | What happens | How often |
|---|---|---|
| **Scan** | Sweep Meteora’s pool list for busy SOL-quoted pools; dedupe copycat tickers; hard pool gates; score 0–100 | Every 60s |
| **Vet** | On-chain + RugCheck: authorities, holders, insider clusters, creator rug history, age | At entry time |
| **Enter** | One-sided SOL below price (BidAsk for memes, Spot for majors), Kelly + score, rent budgets | Slot free + candidate passed |
| **Manage** | P0→P5 ladder: safety, stop, rotation, take-profit, fee claims, below-range | Every 15s |
| **Exit** | Close, swap leftovers to SOL (Zap SDK, Jupiter fallback), record measured PnL | When a rule fires |

- **SOL is the unit of account.** Wins and losses are wallet SOL in and out — not USD screenshots.
- **Rules beat gut feel.** Wherever a human would “ask the group,” the bot takes the more defensive branch.

## Why one-sided SOL below price?

The default entry never buys the token up front. Only SOL, in bins **below** the current price:

1. Price **dips** into the range → bins buy tokens cheaper each step.
2. Price **recovers** through the range → those bins sell above acquisition, plus fees both ways.
3. Price **never visits** → SOL sits untouched: no profit, no loss (idle capital + a little rent).

The bot waits for price to come to it. It is not guessing the top.

## The three sleeves

Sleeve is stamped at entry and decides range shape, sizing, and manage rules.

| Sleeve | What it trades | Range shape | Sizing (current defaults) |
|---|---|---|---|
| **micro** | Young/small memes, mcap $100k–$200k | BidAsk below price | 0.5× Kelly, max 0.45 SOL, **1** slot, ≤5% of wallet |
| **meme** | Main book, mcap ≥ $200k | BidAsk below price | Kelly × score multiplier |
| **majors** | Allowlisted SOL-quoted alts (PUMP, JTO, BONK, WIF, RAY, JUP, …) | **Spot** (12% below / 6% above) | Fixed 0.75 SOL, max 1 slot, slower manage |

Majors run **after** meme entries, and only when at least `meme_reserve_slots` (2) remain free. Stable pairs like SOL‑USDC are permanently out of scope.

## Managing a position: the P0→P5 ladder

Checked top-to-bottom every 15 seconds. **First match wins.**

| Rule | Name | One-liner |
|---|---|---|
| **P0** | Safety exit | Rug signals → close *now*, dump to SOL, blacklist token + creator |
| **P1** | Stop loss | Worth < 75% of entry in SOL → close |
| **P2** | Rotation | Fees/volume went cold, or too old → free the slot |
| **P3** | Above range | Climbed out the top → take profit (or exit slowly if it never visited) |
| **P4** | In range | Claim/bank fees, maybe profit-lock a slice |
| **P5** | Below range | 100% token after a short grace → close, swap, cool down |

Full thresholds: [Strategy reference](./strategy).

## Follow mode (careful re-entry)

After a clean up-and-out close (P3), follow mode may re-enter — through picky gates. Unguarded chasing lost money in simulation:

```
P3 close ──arms──▶ wait for: hot volume (≥$100k/30m)
                          + 15% retrace from the peak
                          + fresh token vetting
                └──▶ open a tighter leg (30% deep, 0.25 SOL)
                └──▶ re-arm only after a NEW chain high (up-only)
                └──▶ chain ends on: any non-P3 close, 3 legs,
                     −0.075 SOL cumulative loss, cold volume, or 12h
```

While a follow chain owns a token, the normal scanner skips it. [Strategy → Follow mode](./strategy#p3-f-follow-mode).

## Paper vs live

- **Paper (default):** full brain, real pool data, simulated fills. No wallet needed.
- **Live:** real SOL. Needs **both** `FARMER_MODE=live` **and** `[exec] mode = "live"`. One switch stays paper.

Promotion gate: `npm run status` marks **eligible** after 7 consecutive profitable paper days. [Risk → Paper first](./risk#paper-first-the-promotion-gate).

## What's actually running

| Process | Job |
|---|---|
| **Farmer** | Tick loop — scans, vets, opens, manages, closes. |
| **Dashboard** | Positions, charts, HALT, settings, Wiki. |
| **Deploy watcher** (optional) | Pulls new builds from GitHub. |
| **SQLite + config** | `data/farmer.db` and `data/config.toml` (hot-reloaded). |

On every startup the bot enumerates on-chain DLMM positions and repairs the DB to match. The chain wins.

<p class="cta-row">
  <a class="doc-btn ghost" href="./strategy">Strategy</a>
  <a class="doc-btn ghost" href="./risk">Risk & sizing</a>
  <a class="doc-btn ghost" href="./easy">Easy setup</a>
</p>
