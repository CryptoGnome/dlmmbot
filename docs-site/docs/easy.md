---
title: Easy setup (Railway)
description: One-click Railway deploy for DLMM Bot. Paper first, then live from the dashboard.
---

# Easy setup (Railway)

One service. Attach a volume, open the URL, finish secrets in the dashboard.

<p class="cta-row">
  <a class="doc-btn" href="https://railway.com?referralCode=SCj9lN" target="_blank" rel="noreferrer">Deploy on Railway</a>
  <a class="doc-btn ghost" href="./api-keys">API keys</a>
  <a class="doc-btn ghost" href="./agents">For AI agents</a>
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

First login opens a wizard: **accept the Terms & risk waiver**, then RPC, Jupiter key, **burner wallet**, paper/live. Writes go to `/app/data` — the git checkout stays clean.

| Key | Required | Get it |
| --- | --- | --- |
| `RPC_URL` | Yes | [Helius](https://dashboard.helius.dev/signup) mainnet URL |
| `JUPITER_API_KEY` | Before live | [Jupiter Portal](https://developers.jup.ag/portal) |
| `GMGN_API_KEY` | Optional | [gmgn.ai/ai](https://gmgn.ai/ai) |

On the wallet step (or later under **Settings → Wallet & secrets**):

1. **Create new** (recommended) — dashboard generates a fresh Solana keypair, you set a passphrase, retype it, and save the one-time backup somewhere safe offline.
2. Or **Import Phantom** — paste a **burner** base58 private key only (never your main wallet). Same passphrase encryption.

Either way the key is stored encrypted as `wallet.enc.json` on the volume. Stay in **paper** until you’re comfortable. Optional: set `WALLET_PASSPHRASE` on Railway to auto-unlock on boot.

<p class="cta-row">
  <a class="doc-btn ghost" href="./api-keys">Full key signup</a>
  <a class="doc-btn ghost" href="./dashboard">Dashboard / wallet</a>
  <a class="doc-btn ghost" href="./profiles">Settings profiles</a>
</p>

## Going live

Paper first. When you’re ready for real SOL:

### 1. Burner wallet

If you skipped the wallet in the wizard: **Settings → Wallet & secrets → Create** (or Import a dedicated burner). Confirm the public address shown in the dash (header chip / Settings).

### 2. Fund it

Send **SOL** to that public address from another wallet (Phantom, exchange withdraw, etc.). Start small.

You need enough for:

- Position size(s) you expect to open
- An operational reserve (~1 SOL + ~10% of bankroll is held back for rent / priority / claims — see [Risk & sizing](./risk))
- A little headroom for failed tx retries

Paper mode does not need funded SOL. Live will not trade usefully on an empty wallet.

### 3. Unlock

Unlock the encrypted wallet in Settings (or rely on `WALLET_PASSPHRASE` on Railway). The farmer can only sign when the key is unlocked into runtime env.

### 4. Flip both live switches

Needs **both**:

- `FARMER_MODE=live` (Railway variable or Settings → secrets)
- `[exec] mode = "live"` in Settings / `data/config.toml`

One switch alone stays paper. Restart / redeploy after both are set. **One farmer process per wallet.**

<p class="note bad">Burner only. You can lose 100%. Accept the <a href="./terms">Terms</a> — we are not liable for losses.</p>

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
