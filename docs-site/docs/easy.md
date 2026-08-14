---
title: Easy setup (Railway)
description: One-click Railway deploy for DLMM Bot. Paper first, then live from the dashboard.
---

# Easy setup (Railway)

One service. Config is automated. You attach a volume once, open the public URL, then finish secrets in our dashboard Settings UI.

[Sign up on Railway →](https://railway.com?referralCode=SCj9lN)

::: warning Risk
Memecoin LP can wipe a wallet. Not financial advice. **Burner only.**
:::

::: tip Settings profiles
In **Settings → Profiles**: apply Conservative / Balanced / Aggressive, save your own pack, or browse the community gallery. **Share to GitHub** works on Railway with no host git. Details: [Settings profiles](./profiles).
:::

## What’s automated

The repo ships a `railway.toml` so Railway builds the dashboard and runs **farmer + dash together** in one service. On boot it:

- Defaults to `FARMER_MODE=paper` (safe)
- Listens on Railway’s public `PORT`
- Seeds persistent `config.toml` + `.env` on the volume
- Auto-generates a `DASH_TOKEN` if you didn’t set one (printed in logs)

::: tip
Volumes still can’t be declared in TOML (Railway limitation). Attaching `/app/data` once is the only infra click left.
:::

## Deploy (3 steps)

### 1. Sign up & deploy the repo

[railway.com?referralCode=SCj9lN](https://railway.com?referralCode=SCj9lN) → **New Project → Deploy from GitHub** → `CryptoGnome/dlmmbot` (or your fork).

One service is enough. Start/build commands come from `railway.toml` — you should not need to type them.

### 2. Attach a volume at `/app/data`

Service → click the service → **Volumes** → Add → mount path `/app/data`. This keeps SQLite, Settings, and your token across redeploys.

::: tip
Redeploy after attaching so the mount is live.
:::

### 3. Generate a public domain

Settings → Networking → **Generate domain**. That’s your dashboard URL.

## Open the dashboard

Open the public URL. If you didn’t set `DASH_TOKEN`, check **Deploy logs** for `[railway] generated DASH_TOKEN=…` and paste that token.

::: tip
Optional but recommended: copy that token into Railway Variables as `DASH_TOKEN` so it never rotates.
:::

## Finish in our Settings UI

First login opens a **setup wizard** for the core pieces (RPC, Jupiter API key, wallet, mode). With the volume attached, Settings writes to `/app/data/config.toml` (and `.env`) — the repo template stays clean so git never shows DIRTY from knobs.

### API keys (wizard or Settings → Wallet & secrets)

See **[API keys](./api-keys)** for full signup steps (Helius, Jupiter, optional GMGN).

| Key | Required? | Where |
| --- | --- | --- |
| **`RPC_URL`** | Yes | [Helius](https://dashboard.helius.dev/signup) mainnet URL |
| **`JUPITER_API_KEY`** | Yes before live | [Jupiter Portal](https://developers.jup.ag/portal) |
| **`GMGN_API_KEY`** | Optional (free) | [gmgn.ai/ai](https://gmgn.ai/ai) — trending + vetting enrichment |

- Leave paper mode until you’re comfortable
- Create an encrypted burner wallet under Settings → Wallet & secrets, or import from Phantom — never paste your main wallet
- Optional: set `WALLET_PASSPHRASE` on Railway to auto-unlock on boot
- Tune token-safety / sizing under Settings → Bot settings (persisted under the volume)

::: danger Burner only
Never use your main wallet.
:::

## Going live

::: danger Real SOL
Burner only. One farmer process per wallet.
:::

- Paper looked sane
- Burner + Helius RPC + Jupiter key set (wizard or Settings / Railway Variables)
- Set `FARMER_MODE=live` (Railway variable or Settings)
- Set `[exec] mode = "live"` in Settings / config
- Restart / redeploy so both switches are live

::: tip
Live requires **both** env and config. One alone stays safe.
:::

## Cost

Trial credits, then Hobby (~$5) + usage is the realistic always-on floor (volume needs a paid plan tier). [Pricing](https://railway.com/pricing?referralCode=SCj9lN). Own hardware: [Advanced](./advanced).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Build fails on native module | Node 20 (Railpack default); check `better-sqlite3` logs |
| Dash unauthorized | Token from logs or Railway `DASH_TOKEN` |
| History / Settings wiped | Volume at `/app/data`, then redeploy |
| Healthcheck failing | Wait for first build; path is `/health` |
| Want local / PM2 | [Advanced setup](./advanced) |
