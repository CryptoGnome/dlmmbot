---
title: API keys
description: Helius RPC, Jupiter, and GMGN — where to sign up, how to copy keys into the dashboard wizard or Settings.
---

# API keys

One checklist for every external key the bot uses. Paste them in the first-run **setup wizard** or **Settings → Wallet & secrets** (writes to `data/.env` on your volume).

| Key | Required? | Free tier? | What it powers |
| --- | --- | --- | --- |
| **`RPC_URL`** (Helius) | **Yes** | Yes (signup) | On-chain reads, vetting, tx simulation |
| **`JUPITER_API_KEY`** | **Yes** before live | Yes | Exit swaps (token → SOL), profit-burn, `simulate-zap` |
| **`GMGN_API_KEY`** | Optional (recommended) | Yes | Trending discovery, smart-money feeds, honeypot/sell-tax vetting |

Without GMGN the bot still runs on Meteora datapi + RPC + RugCheck — GMGN adds score bonuses (capped at +10) and extra security flags.

---

## Helius RPC (`RPC_URL`)

We suggest [Helius](https://www.helius.dev/) for Solana mainnet. Public RPC endpoints work for a smoke test but rate-limit during live trading.

1. Sign up at [dashboard.helius.dev/signup](https://dashboard.helius.dev/signup)
2. Create a project → open **RPC** → copy the **Mainnet** HTTPS URL
3. Paste into the wizard or `RPC_URL` in Settings / `.env`

Example: `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`

[Helius RPC endpoint docs](https://www.helius.dev/docs/api-reference/endpoints)

---

## Jupiter API key (`JUPITER_API_KEY`)

Live exits route through Jupiter. Paper simulates fills but you still want a key for `npm run simulate-zap` before going live.

1. Open [developers.jup.ag/portal](https://developers.jup.ag/portal) and sign in (Google, GitHub, or email)
2. Create or join a **team** in your organization
3. **API Keys** → **Create** → name it (e.g. `dlmmbot-prod`)
4. Copy the key **immediately** — Jupiter shows the full value **once**
5. Paste into the wizard or `JUPITER_API_KEY` in Settings / `.env`

Free tier (1 req/s) is enough to start.

- [Jupiter setup guide](https://developers.jup.ag/docs/portal/setup)
- [API keys docs](https://developers.jup.ag/docs/portal/api-keys)

---

## GMGN API key (`GMGN_API_KEY`) — optional

[GMGN](https://gmgn.ai/) feeds trending tokens and smart-money flow into the scanner, and adds honeypot / sell-tax checks at vet time. **Query-only** — the bot never uses GMGN to trade, so you do **not** need `GMGN_PRIVATE_KEY`.

### 1. Generate a key pair (Ed25519)

Pick one method:

**Terminal (Linux / macOS / WSL / VPS):**

```bash
openssl genpkey -algorithm Ed25519 -out gmgn_private.pem
openssl pkey -in gmgn_private.pem -pubout -out gmgn_public.pem
cat gmgn_public.pem   # copy this whole block for step 2
```

Store `gmgn_private.pem` somewhere safe if you ever use GMGN trading tools yourself — **do not** paste the private key into DLMM Bot.

**GUI:** follow [GMGN → Generate Public Key](https://docs.gmgn.ai/index/generate-public-key) and download their key-generator app → **Generate 1 Key Pair** → copy the **public** key.

::: warning Public key format
Paste the **entire** public key including the `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----` lines into GMGN's form.
:::

### 2. Create the API key on GMGN

1. Sign up at [gmgn.ai/ai](https://gmgn.ai/ai) (email, wallet, or Telegram)
2. Open the **API key** panel
3. Paste your **public key** → submit → copy the **API Key** GMGN shows you
4. Paste that value into the wizard or `GMGN_API_KEY` in Settings / `.env`

That's it — only `GMGN_API_KEY` goes in the bot env. Rate limit is ~1 req/s; the farmer paces calls and degrades gracefully if GMGN is missing or rate-limited.

- [GMGN Agent API overview](https://docs.gmgn.ai/index/gmgn-agent-api)
- [Generate public key (full guide)](https://docs.gmgn.ai/index/generate-public-key)

---

## Quick copy checklist

```bash
# data/.env (or wizard / Settings)
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
JUPITER_API_KEY=your_jupiter_key
GMGN_API_KEY=your_gmgn_key          # optional
```

## Related

- [Easy setup](./easy) · [Advanced setup](./advanced)
- [Configuration](./configuration) — `[gmgn]` toggles and vetting gates
- [FAQ → GMGN](./faq#do-i-need-the-gmgn-api-key)
