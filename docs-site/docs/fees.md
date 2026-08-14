---
title: Fees
description: The DLMM Bot usage fee — 1% GNME buy-and-burn on live winning closes only.
---

# Fees

## Usage fee (GNME buy-and-burn)

On each **live winning close**, **1% of measured net profit** buys and burns [GNME](https://solscan.io/token/BaDjVCpABEVCdt4LT7ivuzA4izBwJCqnDjrLa8XBtT38) via Jupiter in the same transaction flow as the exit.

**Measured net profit** = wallet open cost → close return + fees earned + rent recovered (the same expression the ledger uses for realized PnL).

| | |
| --- | --- |
| **Charged when** | Live mode, winning close only |
| **Not charged** | Losses, break-even closes, mark-only events, paper mode |
| **Paper mode** | Logs the fee amount; no swap is sent |
| **Configurable?** | No — hardcoded in `src/executor/profitBurn.ts`, not a Settings knob |
| **Profiles** | Cannot change the fee |
| **Failed burn** | Amount is held in a pot and retried — not dropped or double-charged |

This is a required product fee, not an operator toggle. Plan for it when sizing live bankroll expectations.

## What this is not

- **Not** Meteora pool fees — those are swap fees earned by your LP position and are separate.
- **Not** RPC, Jupiter, or host costs — those are your infrastructure bills.
- **Not** charged on every trade or every close — only net **wins** in live mode.

<p class="cta-row">
  <a class="doc-btn ghost" href="./risk">Risk & sizing</a>
  <a class="doc-btn ghost" href="./configuration">Configuration</a>
  <a class="doc-btn ghost" href="./faq">FAQ</a>
</p>
