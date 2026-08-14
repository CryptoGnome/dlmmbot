---
title: Advanced setup
description: Run DLMM Bot locally or on a VPS with PM2 and auto-deploy.
---

# Advanced setup

For people with a server, or who want to run on their own PC. Most newcomers should use [Easy setup (Railway)](./easy).

::: warning
Same risk rules: paper first, burner only, never commit `.env`.
:::

## When to use this

| Path | Best for |
| --- | --- |
| [Easy (Railway)](./easy) | No server. Public HTTPS. Auto-redeploy. |
| **This guide** | VPS / home box / local PC with full control. |
| Same bot | Identical code and paper/live gates. |

## Local install (paper)

| Need | Get it | Check |
| --- | --- | --- |
| **Node.js 20+** | [nodejs.org](https://nodejs.org) | `node -v` |
| **Git** | [git-scm.com](https://git-scm.com) | `git --version` |

### 1. Clone & install

```bash
git clone https://github.com/CryptoGnome/dlmmbot.git
cd dlmmbot
npm install
```

`better-sqlite3` compiling is normal. Windows may need VS Build Tools.

### 2. Create `.env`

```bash
cp .env.example .env
```

```bash
FARMER_MODE=paper
RPC_URL=https://api.mainnet-beta.solana.com
```

### 3. Force paper in runtime config

First run seeds gitignored `data/config.toml` from the repo template. Edit that file (or use Settings) — not the tracked `config.toml`.

```toml
# data/config.toml
[exec]
mode = "paper"
```

::: tip
Live needs **both** this and `FARMER_MODE=live`.
:::

### 4. Run

```bash
npm run run
```

```bash
npm run status
npm run halt
```

## Commands

```bash
npm run scan | vet | run | status | halt | force-close | test
npm run dash:build && npm run dash
```

## Local dashboard

```bash
DASH_TOKEN=pick-a-long-random-password
DASH_PORT=8787
```

```bash
npm run dash:build
npm run dash
```

Open [http://localhost:8787](http://localhost:8787) with that token.

The **Errors** tab streams structured runtime failures over WebSocket. Overview has **Halt / Resume** (same `HALT` file as `npm run halt`). Pending updates on **Changes** show risk chips (`strategy`, `deps`, `deploy`, `dash`, `docs`).

## Keys & going live

Phantom burner → `WALLET_PRIVATE_KEY`, private RPC, Jupiter key.

```bash
# data/.env (seeded from .env on first run)
FARMER_MODE=live
RPC_URL=https://your-private-rpc
JUPITER_API_KEY=…
WALLET_PRIVATE_KEY=…
```

```toml
# data/config.toml
[exec]
mode = "live"
```

::: danger Burner only
One bot process per wallet/DB.
:::

## PM2 on a VPS

```bash
npm install -g pm2
pm2 start deploy/ecosystem.config.cjs --only meteora-farmer
pm2 start deploy/ecosystem.config.cjs --only meteora-dash
pm2 save
pm2 startup
pm2 logs meteora-farmer
```

Ecosystem sets `FARMER_CONFIG_PATH` / `FARMER_ENV_PATH` / `FARMER_DB_PATH` under `data/` so Settings never dirties git. `meteora-deploy` in the same ecosystem is the git pull watcher — start it only if you want updates from `master`.

## Auto-deploy

```bash
pm2 start deploy/ecosystem.config.cjs --only meteora-deploy
pm2 save
```

Auto-update is **on by default**. To review commits before they land: Settings → Wallet & secrets → turn **Auto-update** off. When GitHub is ahead, open **Changes** and click the checkmark (**Approve**) — the watcher then pulls that tip.

::: tip
Don’t SCP a dirty tree and expect CURRENT — push + pull (or let the watcher do it).
:::

## Dashboard from outside

- **Tailscale / ZeroTier** — private access from your phone
- **Cloudflare Tunnel** — public HTTPS without opening ports
- **Reverse proxy + HTTPS** on a VPS with a domain

::: danger
Don’t expose `:8787` raw without a strong `DASH_TOKEN` (and HTTPS).
:::

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `better-sqlite3` build fail | VS Build Tools / `build-essential` |
| Already running / lock | Only if sure: `npm run release` |
| BEHIND on version pill | Start `meteora-deploy`, or approve on Changes if auto-update is off, or `git pull` |
| Want the simple path | [Easy setup (Railway)](./easy) |
