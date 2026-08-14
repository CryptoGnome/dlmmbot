---
title: API keys
description: Helius RPC, Jupiter, and GMGN — where to sign up, how to copy keys into the dashboard wizard or Settings.
---

# API keys

Paste these in the first-run **setup wizard** or **Settings → Wallet & secrets** (writes to `data/.env` on your volume).

| Key | Required? | Free tier? | What it powers |
| --- | --- | --- | --- |
| **`RPC_URL`** (Helius) | **Yes** | Yes (signup) | On-chain reads, vetting, tx simulation |
| **`JUPITER_API_KEY`** | **Yes** before live | Yes | Exit swaps (token → SOL), profit-burn, `simulate-zap` |
| **`GMGN_API_KEY`** | Optional (recommended) | Yes | Trending discovery, smart-money feeds, honeypot/sell-tax vetting |

Without GMGN the bot still runs on Meteora datapi + RPC + RugCheck — GMGN adds score bonuses (capped at +10) and extra security flags.

## Helius RPC (`RPC_URL`)

Public RPC works for a smoke test. Live needs a private endpoint.

<p class="cta-row">
  <a class="doc-btn" href="https://dashboard.helius.dev/signup" target="_blank" rel="noreferrer">Sign up at Helius</a>
  <a class="doc-btn ghost" href="https://www.helius.dev/docs/api-reference/endpoints" target="_blank" rel="noreferrer">Endpoint docs</a>
</p>

1. Create a project → **RPC** → copy the **Mainnet** HTTPS URL
2. Paste into the wizard or `RPC_URL` in Settings / `.env`

Example: `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`

## Jupiter API key (`JUPITER_API_KEY`)

Live exits route through Jupiter. Paper simulates fills, but you still want a key for `npm run simulate-zap` before going live.

<p class="cta-row">
  <a class="doc-btn" href="https://developers.jup.ag/portal" target="_blank" rel="noreferrer">Jupiter Portal</a>
  <a class="doc-btn ghost" href="https://developers.jup.ag/docs/portal/setup" target="_blank" rel="noreferrer">Setup guide</a>
</p>

1. Sign in (Google, GitHub, or email)
2. Create or join a **team**
3. **API Keys → Create** — name it (e.g. `dlmmbot-prod`)
4. Copy the key **immediately** — Jupiter shows the full value once
5. Paste into the wizard or `JUPITER_API_KEY`

Free tier (1 req/s) is enough to start.

## GMGN API key (`GMGN_API_KEY`) — optional

Query-only trending + honeypot/sell-tax checks. The bot never trades through GMGN, so you do **not** need `GMGN_PRIVATE_KEY`.

<p class="cta-row">
  <a class="doc-btn" href="https://gmgn.ai/ai" target="_blank" rel="noreferrer">Open GMGN</a>
  <a class="doc-btn ghost" href="https://docs.gmgn.ai/index/generate-public-key" target="_blank" rel="noreferrer">Generate a public key</a>
</p>

### 1. Generate a key pair (Ed25519)

**Terminal (Linux / macOS / WSL / VPS):**

```bash
openssl genpkey -algorithm Ed25519 -out gmgn_private.pem
openssl pkey -in gmgn_private.pem -pubout -out gmgn_public.pem
cat gmgn_public.pem   # copy this whole block for step 2
```

Keep `gmgn_private.pem` off the bot. **GUI:** GMGN’s key-generator app → **Generate 1 Key Pair** → copy the **public** key.

<p class="note warn">Paste the entire public key, including the <code>BEGIN</code> / <code>END PUBLIC KEY</code> lines, into GMGN’s form.</p>

### 2. Create the API key on GMGN

1. Sign up at [gmgn.ai/ai](https://gmgn.ai/ai)
2. Open the **API key** panel
3. Paste your **public** key → copy the **API Key** GMGN shows you
4. Paste that value as `GMGN_API_KEY`

Rate limit: GMGN’s query API uses a leaky bucket (`rate=20` / `capacity=20`, heavier weight on holders/traders) and documents ~1 req/s as a safe floor. The farmer runs **one serial CLI queue**, waits for each call to finish before the next, parks ~5 minutes (or until `reset_at`) on 429 — never spam the cooldown, that extends bans — and degrades to Meteora-only data while cooling down. **One API key per running bot** — staging + production sharing a key will 429.

## Quick copy checklist

```bash
# data/.env (or wizard / Settings)
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
JUPITER_API_KEY=your_jupiter_key
GMGN_API_KEY=your_gmgn_key          # optional
```

<p class="cta-row">
  <a class="doc-btn ghost" href="./easy">Easy setup</a>
  <a class="doc-btn ghost" href="./advanced">Advanced setup</a>
  <a class="doc-btn ghost" href="./configuration">Configuration</a>
</p>
