---
title: Dashboard guide
description: Tab-by-tab tour of the DLMM Bot ops dashboard — Overview, Positions, Activity, Analytics, Research, Errors, Changes, Settings, Wiki — plus the setup wizard, encrypted wallet, and HALT.
---

# Dashboard guide

Live window onto the farmer: ledger, settings, wizard, encrypted wallet. On Railway it’s your public HTTPS URL; locally `http://localhost:8787/?token=…`.

**Overview** for “am I ok?”, **Positions** for open trades, **Activity** when something looks off, **Wiki** when you forget a rule.

<p class="cta-row">
  <a class="doc-btn ghost" href="./easy">Easy setup</a>
  <a class="doc-btn ghost" href="./api-keys">API keys</a>
  <a class="doc-btn ghost" href="./profiles">Settings profiles</a>
</p>

## First login: the setup wizard

When RPC and wallet are missing, first login walks through:

1. **Terms & risk waiver** — scroll and accept [Terms](./terms) (required; also shown to existing installs that have not accepted yet).
2. **Dash token** — Railway variable `DASH_TOKEN` (≥24 random chars). Not the truncated prefix in deploy logs.
3. **RPC & APIs** — Helius mainnet URL, Jupiter key, optional GMGN.
4. **Wallet** — create a keypair or import a Phantom base58 key. Encrypted with a passphrase (AES-256-GCM) as `wallet.enc.json` on your volume. Password retype + one-time backup.
5. **Paper or live** — live still needs the [double lock](./risk#paper-first-the-promotion-gate).
6. Optionally **unlock** into `.env` (or set `WALLET_PASSPHRASE` on Railway to auto-unlock on boot).

<p class="note bad">Fresh burner only — never your main wallet.</p>

## Header: the health lights

| Pill / control | Meaning |
|---|---|
| **ON/OFF** | Soft pause. OFF = no new trades, no exits initiated; positions stay open (`PAUSE` file). |
| **HALT** (red) | Emergency close-all: confirm with dash token → close every open, swap to SOL, idle until Resume. |
| **HB** | Seconds since the last finished tick — green = fresh, red = stuck. Tick age, not wall clock. |
| **WS** | This browser’s live websocket. |
| **PAPER / LIVE** | Current mode. Positions, balances, and History follow this book only — paper and live share one DB but never mix on screen. |
| **BRAKE** | Cluster brake has paused new entries. |
| **Build pill + Auto switch** | Release, branch, SHA, sync. Auto on/off chooses auto-pull vs Approve-on-Changes. |
| **Host / wallet chip** | Which machine, and the wallet when known. |

## The tabs

### Overview

Account value, open profit with slot occupancy (e.g. `3 of 5 · 2 free`), equity chart. Header ON/OFF and HALT answer “is everything fine?”

### Positions

Open positions (slot badge) and recent closes. Range bar: **purple ≈ SOL still waiting** below price, **blue ≈ already converted to token**. Close rows split **Move** (deposit/IL) from **Fees**.

### Activity

Entries, exits, claims, skips, follow-chain events. Green = inflows/wins, blue = capital deployed, red = losses. On-chain rows link to Solscan.

### Analytics

Exits by reason (P0–P5), performance by sleeve, skip stats. Check whether a knob change did anything before touching the next one.

### Research

Public X (Twitter) credits for people whose playbooks informed the strategy. **Not partners, not trade signals.**

### Errors

Structured failures over WebSocket. **Transient** (API blip), **Degraded** (partial), **Needs attention** — plus stack, mint/pool, copy-dump, GitHub issue shortcut.

### Changes (Changelog)

Pending git updates with risk chips (`strategy` / `deps` / `deploy` / `core` / `dash` / `docs`). Auto-update **on** (default): watcher pulls, rebuilds, restarts. **Off**: BEHIND + **Approve** pulls that tip.

### Settings

- **Bot settings** — sizing, brakes, vetting, sleeves → `data/config.toml`, hot-reloaded. Home of [Profiles](./profiles). Packs never flip paper/live or touch secrets. [Fees](./fees) stay fixed.
- **Wallet & secrets** — vault, `RPC_URL`, API keys, auto-update preference.

Writes go to the `data/` volume, never git — a DIRTY build pill means real code drift.

### Wiki

In-dashboard operator manual — a friendlier mirror of [STRATEGY.md](https://github.com/CryptoGnome/dlmmbot/blob/main/STRATEGY.md). Kept in sync when behavior changes.

## Encrypted wallet

- **Create** — fresh keypair in the browser, encrypts with your passphrase, stores `wallet.enc.json`.
- **Import** — Phantom base58 private key (a burner); same encryption. Plaintext never lands on disk.
- **Unlock** — decrypts into runtime `.env`. On Railway, `WALLET_PASSPHRASE` auto-unlocks on boot.

Keys live on **your** volume/host — not hosted custody.

## Halting from the dashboard

Red **HALT** asks for your dash token, then writes the same `HALT` file as `npm run halt`: close everything, swap residuals to SOL, idle. **Resume** clears it. Use ON/OFF to stop *new* activity without closing the book — [HALT vs PAUSE vs OFF](./risk#halt-vs-pause-vs-off).

<p class="cta-row">
  <a class="doc-btn ghost" href="./advanced">Advanced setup</a>
  <a class="doc-btn ghost" href="./configuration">Configuration</a>
  <a class="doc-btn ghost" href="./risk">Risk & sizing</a>
</p>
