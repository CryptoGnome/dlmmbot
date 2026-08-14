---
title: Dashboard guide
description: Tab-by-tab tour of the DLMM Bot ops dashboard — Overview, Positions, Activity, Analytics, Research, Errors, Changes, Settings, Wiki — plus the setup wizard, encrypted wallet, and HALT.
---

# Dashboard guide

The dashboard is the web UI that ships with the bot: a live window onto the farmer process, read-only against the SQLite ledger, plus settings writes, the setup wizard, and encrypted wallet management. On Railway it's your public HTTPS URL; locally it's `http://localhost:8787/?token=…` (see [Advanced setup](./advanced)).

You don't need every tab every day. **Overview** for "am I ok?", **Positions** for open trades, **Activity** when something weird happens, **Wiki** when you forget a rule.

## First login: the setup wizard

When RPC and wallet are missing, first login opens a wizard that walks through:

1. **Confirm the dash token** — from Railway deploy logs (`generated DASH_TOKEN=…`) or your `DASH_TOKEN` env var.
2. **RPC & APIs** — paste a [Helius](https://www.helius.dev/) mainnet RPC URL, a [Jupiter](https://developers.jup.ag/portal) API key (required), and optionally [GMGN](https://gmgn.ai/ai) (free — see [API keys](./api-keys)).
3. **Wallet** — create a new Solana keypair, or import a Phantom base58 private key. Either way it's encrypted with a passphrase (AES-256-GCM) and stored as `wallet.enc.json` on your data volume. The wizard forces a password retype and shows a one-time backup.
4. **Choose paper or live** — live still needs the [double lock](./risk#paper-first-the-promotion-gate).
5. Optionally **unlock** the wallet into `.env` for trading (or set `WALLET_PASSPHRASE` on Railway to auto-unlock on boot).

::: danger Burner only
Create a fresh wallet or import a burner. Never your main wallet.
:::

## Header: the health lights

| Pill / control | Meaning |
|---|---|
| **ON/OFF** | Soft pause. OFF = no new trades, no exits initiated; positions stay open and watched (`PAUSE` file). |
| **HALT** (red) | Emergency close-all: confirm with your dash token → the farmer closes every open position, swaps to SOL, and idles until Resume. Separate from ON/OFF. |
| **HB** | Farmer alive? Shows seconds since the last finished tick — green = fresh, red = stuck or missing. It is tick age, not a wall clock. |
| **WS** | This browser page's live websocket feed. |
| **PAPER / LIVE** | Current mode. |
| **BRAKE** | Appears when the cluster brake has paused new entries. |
| **Build pill + Auto switch** | Shows release version, deploy branch, SHA, and sync (CURRENT / BEHIND / …). The Auto on/off switch beside it chooses auto-pull vs Approve-on-Changes. |
| **Host / wallet chip** | Which machine, and the wallet when known. |

## The tabs

### Overview

The money snapshot: account value, open profit with slot occupancy (e.g. `3 of 5 · 2 free`), and the equity chart. Engine ON/OFF and HALT live in the header, so this tab plus the header answers "is everything fine?" in one glance.

### Positions

Open positions (each with its slot badge) and recent closes. The range bar on an open position splits by color: **purple ≈ SOL still waiting** in bins below price, **blue ≈ already converted to token** as price walked down through the bins. Close rows separate **Move** (deposit/IL) from **Fees** so you can see *why* a close netted what it did.

### Activity

The live play-by-play: entries, exits, claims, skips, follow-chain events. SOL amounts are color-coded — green for inflows/wins, blue for capital deployed (entries), red only for actual losses. On-chain rows link to Solscan.

### Analytics

Why you made or lost SOL: exits by reason (P0–P5), performance by sleeve, and skip statistics. This is where you check whether a knob change did anything before touching the next one.

### Research

Public X (Twitter) credits for people whose playbooks informed the strategy. **Not partners, not trade signals.**

### Errors

Structured runtime failures streamed over WebSocket. Each row carries a plain label — **Transient** (API blip, auto-retries), **Degraded** (partial), **Needs attention** (review) — plus the stack, mint/pool context, a copy-dump button for bug reports, and a shortcut to open a GitHub issue. Dismiss what you've handled.

### Changes (Changelog)

Pending git updates from GitHub. Each commit gets **risk chips** (`strategy` / `deps` / `deploy` / `core` / `dash` / `docs`) — a quick "how spicy is this update?" hint, not a substitute for reading the subjects. With auto-update **on** (the default), the deploy watcher pulls, rebuilds, and restarts on its own; with it **off**, this tab shows BEHIND and an **Approve** button pulls that tip when you click it.

### Settings

Two halves:

- **Bot settings** — the strategy knobs (sizing incl. Kelly, risk brakes, vetting filters, sleeves), persisted to `data/config.toml` on your volume and hot-reloaded by the farmer within seconds. Also home of **[Profiles](./profiles)**: official Conservative / Balanced / Aggressive packs, your own local saves, and the community gallery with a diff preview before Apply. Profiles never flip paper/live or touch secrets (see [Fees](./fees) for what stays fixed).
- **Wallet & secrets** — the encrypted wallet vault (create / import from Phantom / unlock), `RPC_URL`, API keys, and the auto-update preference.

Settings writes go to the `data/` volume, never the git checkout — so the build pill showing DIRTY always means real code drift, not knob changes.

### Wiki

The in-dashboard operator manual — a friendlier mirror of [STRATEGY.md](https://github.com/CryptoGnome/dlmmbot/blob/main/STRATEGY.md): big picture, sleeves, scanning, entries, the P0–P5 ladder, follow mode, sizing, skips, accounting, and a glossary. It's kept in sync with the code whenever behavior changes.

## Encrypted wallet: create, import, unlock

The dashboard's wallet vault is the recommended way to hold the live key:

- **Create** — generates a fresh keypair in the browser flow, encrypts it with your passphrase, stores only `wallet.enc.json` on the volume.
- **Import** — paste a Phantom base58 private key (a burner!); same encryption. The plaintext never lands on disk unencrypted.
- **Unlock** — decrypts into the runtime `.env` so the farmer can sign. On Railway, setting `WALLET_PASSPHRASE` as a service variable auto-unlocks on boot; otherwise unlock manually after each restart.

Keys live on **your** volume/host — this is not a hosted custody service.

## Halting from the dashboard

The red **HALT** button asks for your dash token, then writes the same `HALT` file as `npm run halt`: the farmer closes every open position, swaps residuals to SOL, and idles. **Resume** clears it. Use ON/OFF instead when you just want to stop *new* activity without closing the book — see [HALT vs PAUSE vs OFF](./risk#halt-vs-pause-vs-off).

## Related

- [Easy setup (Railway)](./easy) — getting a dashboard URL in the first place
- [Advanced setup](./advanced) — local dashboard, tunnels, PM2
- [Settings profiles](./profiles) — packs, saving, community sharing
- [Configuration reference](./configuration) — what every Bot-settings knob does
- [Risk & sizing](./risk) — HALT/PAUSE semantics and the brakes
