---
title: For AI agents
description: Playbook so coding agents can install DLMM Bot for a human — Railway easy path, secrets, terms, and llms.txt links.
---

# For AI agents

You are installing **DLMM Bot** for a human operator. Prefer the **Easy (Railway)** path unless they already have a VPS and ask for Advanced.

<p class="cta-row">
  <a class="doc-btn" href="https://dlmmbot.com/llms.txt" target="_blank" rel="noreferrer">llms.txt</a>
  <a class="doc-btn ghost" href="https://dlmmbot.com/llms-full.txt" target="_blank" rel="noreferrer">llms-full.txt</a>
  <a class="doc-btn ghost" href="./easy">Easy setup</a>
</p>

## Read these first

1. [https://dlmmbot.com/llms.txt](https://dlmmbot.com/llms.txt) — short map (URLs + product facts)
2. [https://dlmmbot.com/llms-full.txt](https://dlmmbot.com/llms-full.txt) — fuller summary
3. This page + [Easy setup](./easy)
4. [Terms & risk waiver](./terms) — human must accept in the dashboard; software is as-is, they can lose 100%

Do **not** invent env vars, weaken live gates, commit secrets, or put a main wallet into the bot.

## Human paste prompt (optional)

If the human only gives you a short message, ask them to paste this (or treat it as your standing brief):

```text
Install DLMM Bot for me on Railway (easy path).

Read https://dlmmbot.com/llms.txt and https://dlmmbot.com/llms-full.txt,
then follow https://dlmmbot.com/setup/agents and https://dlmmbot.com/setup/easy.

Rules: paper mode first, burner wallet only, never commit .env or keys,
require Terms acceptance in the dashboard, do not flip live unless I explicitly ask.
Tell me every URL and secret I must create myself (Railway, Helius, Jupiter).
```

## Goal

A running **paper** farmer + public HTTPS dashboard where the human finishes secrets in the setup wizard.

Live mode is **out of scope** unless they explicitly ask — and then both `FARMER_MODE=live` and `[exec] mode = "live"` are required.

## Hard rules

| Do | Don't |
| --- | --- |
| Paper first | Flip live without an explicit ask |
| Burner wallet only | Import their main / cold wallet |
| Volume at `/app/data` on Railway | Let Settings wipe on redeploy (no volume) |
| Keep keys in the dashboard / volume | Commit `.env`, keys, or `DASH_TOKEN` to git |
| One bot process per wallet/DB | Run two farmers against the same wallet |
| Point them at [Terms](./terms) | Skip or auto-click Terms for them without disclosure |

## Recommended path — Railway

Canonical steps: [Easy setup](./easy). Summary:

1. **Railway** — [railway.com?referralCode=SCj9lN](https://railway.com?referralCode=SCj9lN) → New Project → Deploy from GitHub → `CryptoGnome/dlmmbot` (or their fork). One service. Build/start come from `railway.toml`.
2. **Volume** — mount `/app/data`. Redeploy once after attaching.
3. **Domain** — Networking → Generate domain.
4. **Dash token** — from deploy logs (`[railway] generated DASH_TOKEN=…`) or a Railway variable. Open `https://<domain>/?token=…`. Persist `DASH_TOKEN` as a Railway variable so it does not rotate.
5. **Wizard** — human accepts Terms, pastes RPC + Jupiter (+ optional GMGN), creates/imports an encrypted **burner**, stays on **paper**.

### Secrets the human must create

| Key | Required | Where |
| --- | --- | --- |
| `RPC_URL` | Yes | [Helius](https://dashboard.helius.dev/signup) mainnet HTTPS URL |
| `JUPITER_API_KEY` | Before live (get it in paper too) | [Jupiter Portal](https://developers.jup.ag/portal) |
| `GMGN_API_KEY` | Optional | [gmgn.ai/ai](https://gmgn.ai/ai) — [API keys](./api-keys) |
| Burner wallet | For live (paper can wait) | Dashboard wizard — create or Phantom import |

Full signup steps: [API keys](./api-keys).

## Advanced path (only if asked)

[Advanced setup](./advanced): Node 20+, clone `CryptoGnome/dlmmbot`, `npm install`, `data/config.toml` + `data/.env`, `npm run run` / PM2. Suggested VPS: [Vultr](https://www.vultr.com/?ref=9917878-9J) (~2 vCPU / 4 GB / 80 GB / Ubuntu 24.04).

## After install — verify

- Dashboard loads with the token
- Terms accepted (wizard or TermsGate)
- Mode shows **PAPER**
- Heartbeat / farmer process healthy after first ticks
- Wiki / Settings open without errors

Useful ops: [Dashboard guide](./dashboard), [CLI](./cli) (`status`, `halt`, `pause`), [FAQ](./faq).

## Going live (only if explicitly requested)

1. Create or import a **burner** in the dashboard (wizard or Settings → Wallet & secrets); never a main wallet
2. Fund that public address with SOL (start small; leave reserve for rent — see [Risk](./risk))
3. Unlock the wallet (or set `WALLET_PASSPHRASE` on Railway)
4. Paper looked sane; Helius + Jupiter set
5. Set **both** `FARMER_MODE=live` and `[exec] mode = "live"`
6. Restart / redeploy
7. One process per wallet

Details: [Easy → Going live](./easy#going-live). Usage fee on live wins: [Fees](./fees).

## Machine-readable indexes

| File | Use |
| --- | --- |
| [llms.txt](https://dlmmbot.com/llms.txt) | Link map + one-liners — start here |
| [llms-full.txt](https://dlmmbot.com/llms-full.txt) | Longer product / deploy / safety summary |

Repo mirrors: [`llms.txt`](https://github.com/CryptoGnome/dlmmbot/blob/main/llms.txt), [`llms-full.txt`](https://github.com/CryptoGnome/dlmmbot/blob/main/llms-full.txt).

## Link checklist

<div class="ref-list">
  <a href="https://dlmmbot.com/llms.txt">llms.txt <span>short agent map</span></a>
  <a href="https://dlmmbot.com/llms-full.txt">llms-full.txt <span>full agent summary</span></a>
  <a href="./easy">Easy — Railway <span>preferred install</span></a>
  <a href="./api-keys">API keys <span>Helius, Jupiter, GMGN</span></a>
  <a href="./terms">Terms &amp; waiver <span>required in dashboard</span></a>
  <a href="./advanced">Advanced <span>local / VPS / PM2</span></a>
  <a href="./dashboard">Dashboard <span>wizard, HALT, Settings</span></a>
  <a href="https://github.com/CryptoGnome/dlmmbot">GitHub <span>CryptoGnome/dlmmbot</span></a>
</div>
