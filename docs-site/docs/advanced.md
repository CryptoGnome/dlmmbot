---
title: Advanced setup
description: Run DLMM Bot locally or on a VPS with PM2 and auto-deploy.
---

# Advanced setup

Your PC or a Linux VPS. Same bot and paper/live gates as Railway. Newcomers: start on Easy.

<p class="cta-row">
  <a class="doc-btn" href="https://www.vultr.com/?ref=9917878-9J" target="_blank" rel="noreferrer">Get a Vultr VPS</a>
  <a class="doc-btn ghost" href="./easy">Easy setup</a>
  <a class="doc-btn ghost" href="./api-keys">API keys</a>
</p>

## VPS on Vultr

Spin up Ubuntu, SSH in, then follow [PM2](#pm2-on-a-vps). We run production on a small box in this ballpark:

| | Minimum |
| --- | --- |
| **CPU** | 2 vCPU |
| **RAM** | 4 GB |
| **Disk** | 80 GB NVMe |
| **OS** | Ubuntu 24.04 LTS |

Deploy verification (`npm ci`, typecheck, tests, dashboard build) is the RAM spike — day-to-day the farmer + dash + watcher stay light. Pick a region close to your RPC (US West/East is common for Helius). Then `git clone`, `npm install`, PM2.

## Required API keys

Helius RPC and Jupiter before live. GMGN optional, recommended, free.

| Key | Sign up |
| --- | --- |
| **`RPC_URL`** | [Helius](https://dashboard.helius.dev/signup) → Mainnet RPC URL |
| **`JUPITER_API_KEY`** | [developers.jup.ag/portal](https://developers.jup.ag/portal) |
| **`GMGN_API_KEY`** | [gmgn.ai/ai](https://gmgn.ai/ai) — [full steps](./api-keys#gmgn-api-key-gmgn_api_key-optional) |

The first-run wizard walks through RPC + Jupiter. GMGN can wait.

<p class="cta-row">
  <a class="doc-btn ghost" href="./api-keys">Full key signup</a>
</p>

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
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
JUPITER_API_KEY=your_jupiter_key
```

### 3. Force paper in runtime config

First run seeds gitignored `data/config.toml` from the repo template. Edit that file (or Settings) — not the tracked `config.toml`.

```toml
# data/config.toml
[exec]
mode = "paper"
```

Live needs **both** this and `FARMER_MODE=live`. One switch stays paper.

### 4. Run

```bash
npm run run
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
# optional: bind loopback only (default 0.0.0.0)
DASH_HOST=127.0.0.1
```

The dash speaks plain HTTP. Keep it on a trusted LAN or behind HTTPS.

```bash
npm run dash:build
npm run dash
```

Open [http://localhost:8787](http://localhost:8787) with that token.

**Errors** streams runtime failures. Header **ON/OFF** soft-pauses (positions stay open). Red **HALT** closes all opens then idles. **Changes** shows pending updates with risk chips. **Wiki** is the in-dashboard operator manual.

## Keys & going live

Encrypted wallet via the dashboard (recommended) or `WALLET_PRIVATE_KEY` for advanced installs. Fresh burner only — one bot process per wallet/DB.

```bash
# data/.env (seeded from .env on first run)
FARMER_MODE=live
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
JUPITER_API_KEY=your_jupiter_key
WALLET_PRIVATE_KEY=…
```

```toml
# data/config.toml
[exec]
mode = "live"
```

## PM2 on a VPS

```bash
npm install -g pm2
pm2 start deploy/ecosystem.config.cjs --only meteora-farmer
pm2 start deploy/ecosystem.config.cjs --only meteora-dash
pm2 save
pm2 startup
pm2 logs meteora-farmer
```

Ecosystem sets `FARMER_CONFIG_PATH` / `FARMER_ENV_PATH` / `FARMER_DB_PATH` under `data/` so Settings never dirties git. `meteora-deploy` is the git pull watcher — start it only if you want updates from `main` (or `develop` on staging).

## Auto-deploy

```bash
pm2 start deploy/ecosystem.config.cjs --only meteora-deploy
pm2 save
```

Auto-update is **on by default**. To review first: flip **Auto on/off** next to the GitHub build pill. When GitHub is ahead, **Changes → Approve**. Don’t SCP a dirty tree and expect CURRENT — push + pull.

## Dashboard from outside

- **Tailscale / ZeroTier** — private access from your phone
- **Cloudflare Tunnel** — public HTTPS without opening ports
- **Reverse proxy + HTTPS** on a VPS with a domain

<p class="note bad">Don’t expose <code>:8787</code> raw without a strong <code>DASH_TOKEN</code> and HTTPS.</p>

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `better-sqlite3` build fail | VS Build Tools / `build-essential` |
| Already running / lock | Only if sure: `npm run release` |
| BEHIND on version pill | Start `meteora-deploy`, or Approve on Changes, or `git pull` |
| Want the simple path | [Easy setup (Railway)](./easy) |
