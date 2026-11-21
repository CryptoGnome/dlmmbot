---
title: Fees
description: 1% usage fee — buys and burns GNME on live winning closes.
---

# Fees

DLMM Bot takes **1% of measured profit** on each **live winning close**. That cut buys and burns [GNME](https://solscan.io/token/BaDjVCpABEVCdt4LT7ivuzA4izBwJCqnDjrLa8XBtT38) — CryptoGnome’s existing token from [GNME Mining](https://www.gnmemining.com/), a separate Solana mining game. The bot does not mint its own token; the fee supports that one.

Paper mode never spends. Losses and break-even closes are not charged. The fee is fixed product behavior, not a Settings toggle.

The fee is charged per winning close and shows up in that position's realized PnL, so every profit figure the bot and dashboard report is already net of it. Shares collect in a pot that is burned once it reaches 0.001 SOL: a smaller amount would cost about as much in network fees as it burns, so it waits for the next one. Nothing is waived.

<p class="cta-row">
  <a class="doc-btn" href="https://www.gnmemining.com/" target="_blank" rel="noreferrer">GNME Mining</a>
  <a class="doc-btn ghost" href="https://solscan.io/token/BaDjVCpABEVCdt4LT7ivuzA4izBwJCqnDjrLa8XBtT38" target="_blank" rel="noreferrer">GNME on Solscan</a>
</p>
