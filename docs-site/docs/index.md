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

## Understand the bot

- [How it works](./how-it-works) — the full pipeline for newcomers: scan → vet → enter → manage → exit, sleeves, follow mode
- [Strategy reference](./strategy) — every gate, the P0–P5 exit ladder, follow mode, blacklist rules
- [Risk & sizing](./risk) — Kelly, brakes, HALT/PAUSE, the paper→live promotion gate

## Reference

- [Configuration](./configuration) — every `config.toml` key with defaults
- [Dashboard guide](./dashboard) — tab-by-tab, setup wizard, encrypted wallet
- [CLI](./cli) — every command and when to use it
- [FAQ](./faq) — honest answers, starting with "can I lose money?" (yes)

Also see [STRATEGY.md](https://github.com/CryptoGnome/dlmmbot/blob/master/STRATEGY.md) for the raw spec with live-book history.

::: info Usage fee
On each **live** winning close, **1% of measured net profit** buys and burns **GNME** (`BaDjVCpABEVCdt4LT7ivuzA4izBwJCqnDjrLa8XBtT38`). This is a required product fee — not a Settings toggle. Paper mode logs it without spending.
:::

::: tip Settings profiles
Dashboard **Settings → Profiles**: official packs, local saves, and a GitHub community gallery. **Share to GitHub** is browser-only (fork when asked). Full guide: [Settings profiles](./profiles).
:::
