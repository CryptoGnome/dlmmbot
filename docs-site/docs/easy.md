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

### 1. Fork, then deploy from GitHub

Railway only deploys GitHub repos **you can access**. You are not a collaborator on ours, so:

1. On GitHub: open [CryptoGnome/dlmmbot](https://github.com/CryptoGnome/dlmmbot) → **Fork** (your account / org).
2. Railway → **New Project → Deploy from GitHub** → pick **your fork** (`you/dlmmbot`). One service is enough — start/build come from `railway.toml`.

Connect the Railway GitHub App to that fork if prompted. Later updates: merge/rebase upstream `main` into your fork (or sync fork in GitHub), and Railway will redeploy.

Boot defaults: paper mode, public `PORT`, volume-backed `config.toml` / `.env`.

Set a strong dash token **before** you open the site (this is your dashboard password — not a short word):

<DashTokenGen />

1. Use the **Generate** / **Copy** buttons above (or your password manager: create a random password, **32+ characters**).
2. Railway → your service → **Variables** → add `DASH_TOKEN` = that value → **Redeploy**.

If you skip this, the bot still generates a token onto the volume (logs only show the first 8 characters on purpose — deploy logs get screenshotted). You would then need shell access to `/app/data/.env` to read it. Setting the Railway variable is the safe path.

### 2. Volume at `/app/data` (required)

Without this, every redeploy wipes SQLite, Settings, and the wallet. You’ll also see this in deploy logs:

`[railway] no volume detected — attach a volume at /app/data…`

There is **no** “Volumes” tab on the service by itself in the current Railway UI. Add the volume from the **project canvas**:

1. Open your Railway **project** (the canvas with your `dlmmbot` service card).
2. Click the **`+ Add`** button (top of the canvas), **or** right‑click empty canvas space, **or** `⌘K` / `Ctrl+K` → search **Volume**.
3. Choose **Volume**.
4. When prompted, **attach it to your bot service** (the GitHub deploy card — not a new empty service).
5. Set **Mount path** exactly to:
   ```
   /app/data
   ```
   (Must be `/app/data` — not `/data` and not `data`. Railway runs the app under `/app`.)
6. Save. Railway will **redeploy** the service so the mount is active.

Confirm in the next deploy logs:

- Good: `[railway] volume mount=/app/data …`
- Bad (still missing): `[railway] no volume detected …`

Official reference: [Railway Volumes](https://docs.railway.com/volumes).

### 3. Public domain

**Settings → Networking → Generate domain.** That’s the dashboard URL.

## Open the dashboard

Open the domain. Log in with the `DASH_TOKEN` you set as a Railway variable (`?token=…` or the login box).

## Finish in Settings

First login opens a wizard: **accept the Terms & risk waiver**, then only the steps still missing (RPC, Jupiter, **burner wallet**, paper/live). If you already set `RPC_URL` / `JUPITER_API_KEY` / `GMGN_API_KEY` as Railway variables (and redeployed), the wizard detects them and skips those prompts — paste only to replace. Writes go to `/app/data` — the git checkout stays clean.

After Finish, the trading engine stays **OFF** (header toggle). Flip it ON when you want paper (or live) ticks. Choosing **live** in the wizard (or Settings) restarts the farmer once so the header shows LIVE.

| Key | Required | Get it |
| --- | --- | --- |
| `RPC_URL` | Yes | [Helius](https://dashboard.helius.dev/signup) mainnet URL |
| `JUPITER_API_KEY` | Before live | [Jupiter Portal](https://developers.jup.ag/portal) |
| `GMGN_API_KEY` | Optional | [gmgn.ai/ai](https://gmgn.ai/ai) — see below |

### GMGN key (optional)

Trending bonuses + honeypot/sell-tax checks. The bot only needs the **query API key** (`GMGN_API_KEY`) — not a GMGN trading private key.

<GmgnKeyGen />

1. After GMGN shows your API key, add it as a Railway variable **`GMGN_API_KEY`** (or paste in the setup wizard / **Settings → Wallet & secrets**) and redeploy.
2. Running **two bots** (e.g. staging + production)? Generate a **second** public key above and create a **separate** GMGN API key for the other server.

<p class="note warn">Sharing one <code>GMGN_API_KEY</code> across two live bots doubles API load and triggers rate limits. Use one key per instance.</p>

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
| Dash unauthorized | Confirm Railway `DASH_TOKEN` matches what you paste / `?token=` |
| History / Settings wiped | Project canvas → **`+ Add`** → **Volume** → attach to service → mount **`/app/data`**, then redeploy (logs must show `volume mount=`) |
| Healthcheck failing | Wait for first build; path is `/health` |
