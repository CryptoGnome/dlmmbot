---
title: Docs
description: Setup docs for DLMM Bot — Railway (easy) or local / VPS / PM2 (advanced).
---

# Docs

Pick a path. Same bot, same paper/live gates — only the host changes.

<div class="pick-grid">
  <a class="pick" href="./easy">
    <span class="tag">Recommended</span>
    <h3>Easy — Railway</h3>
    <p>No VPS. Public HTTPS dashboard. Auto-redeploy from GitHub. Best for most users.</p>
  </a>
  <a class="pick" href="./advanced">
    <span class="tag ops">Operators</span>
    <h3>Advanced — local / VPS</h3>
    <p>Run on your PC or server with PM2, auto-deploy watcher, and tunnels.</p>
  </a>
</div>

Also see [STRATEGY.md](https://github.com/CryptoGnome/dlmmbot/blob/master/STRATEGY.md) for exits and sizing logic.

::: info Usage fee
On each **live** winning close, **1% of measured net profit** buys and burns **GNME** (`BaDjVCpABEVCdt4LT7ivuzA4izBwJCqnDjrLa8XBtT38`). This is a required product fee — not a Settings toggle. Paper mode logs it without spending.
:::
