---
title: Easy setup (Railway)
description: One-click Railway deploy for DLMM Bot. Paper first, then live from the dashboard.
---

# Easy setup (Railway)

One service. Attach a volume, open the URL, finish secrets in the dashboard.

<p class="cta-row">
  <a class="doc-btn" href="https://railway.com?referralCode=SCj9lN" target="_blank" rel="noreferrer">Deploy on Railway</a>
  <a class="doc-btn ghost" href="./api-keys">API keys</a>
</p>

## Deploy

### 1. New project from GitHub

Railway → **New Project → Deploy from GitHub** → `CryptoGnome/dlmmbot` (or your fork). One service is enough — start/build come from `railway.toml`.

Boot defaults: paper mode, public `PORT`, volume-backed `config.toml` / `.env`, and a generated `DASH_TOKEN` in the logs if you didn’t set one.

### 2. Volume at `/app/data`

Service → **Volumes** → Add → mount `/app/data`. Keeps SQLite, Settings, and the wallet across redeploys. Redeploy once after attaching.

### 3. Public domain

**Settings → Networking → Generate domain.** That’s the dashboard URL.

## Open the dashboard

Open the domain. If `DASH_TOKEN` isn’t a Railway variable yet, copy `[railway] generated DASH_TOKEN=…` from **Deploy logs** and paste it at the login prompt. Then save it as a Railway variable so it doesn’t rotate.

## Finish in Settings

First login opens a wizard: **accept the Terms & risk waiver**, then RPC, Jupiter key, encrypted burner wallet, paper/live. Writes go to `/app/data` — the git checkout stays clean.

| Key | Required | Get it |
| --- | --- | --- |
| `RPC_URL` | Yes | [Helius](https://dashboard.helius.dev/signup) mainnet URL |
| `JUPITER_API_KEY` | Before live | [Jupiter Portal](https://developers.jup.ag/portal) |
| `GMGN_API_KEY` | Optional | [gmgn.ai/ai](https://gmgn.ai/ai) |

<p class="cta-row">
  <a class="doc-btn ghost" href="./api-keys">Full key signup</a>
  <a class="doc-btn ghost" href="./profiles">Settings profiles</a>
</p>

Stay in paper until you’re comfortable. Optional: set `WALLET_PASSPHRASE` on Railway to auto-unlock on boot.

## Going live

Needs **both** `FARMER_MODE=live` (Railway variable or Settings) **and** `[exec] mode = "live"` in config. One switch alone stays paper. Restart/redeploy after both are set. One farmer process per wallet.

## Cost

Hobby (~$5) plus usage after trial credits — a volume needs a paid tier. Own hardware: [Advanced](./advanced).

<p class="cta-row">
  <a class="doc-btn ghost" href="https://railway.com/pricing?referralCode=SCj9lN" target="_blank" rel="noreferrer">Railway pricing</a>
  <a class="doc-btn ghost" href="./advanced">Advanced setup</a>
</p>

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Native module build fail | Node 20; check `better-sqlite3` logs |
| Dash unauthorized | Token from logs, or Railway `DASH_TOKEN` |
| History / Settings wiped | Volume at `/app/data`, then redeploy |
| Healthcheck failing | Wait for first build; path is `/health` |
