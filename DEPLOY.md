# Server deployment

## One-time setup

```bash
git clone https://github.com/CryptoGnome/meteora-farmer.git
cd meteora-farmer
npm install
cp .env.example .env        # then fill in: RPC_URL, JUPITER_API_KEY, GMGN_API_KEY
npm i -g pm2
pm2 start deploy/ecosystem.config.cjs
pm2 save && pm2 startup     # survive reboots (follow the printed instructions)
```

This starts two PM2 apps:

- **meteora-farmer** — the bot (`npm run run`), auto-restarted on crash.
- **meteora-deploy** — the auto-deploy watcher: polls `origin/master` every 30s;
  on new commits it pulls, runs `npm ci` if dependency manifests changed,
  typechecks, and **only restarts the bot if the typecheck passes**. A broken
  push never takes down the running bot — it keeps the last good build and
  retries when a fixed commit lands. GitHub Actions CI also typechecks every
  push, so a red X on the commit means the server won't deploy it.

## Workflow after setup

Push to `master` from anywhere → server picks it up within ~30s and restarts
the bot on the new code. Watch it with:

```bash
pm2 logs meteora-deploy --lines 20
```

```bash
pm2 logs meteora-farmer --lines 50
```

## Not in the repo (transfer manually, once)

- `.env` — API keys. Never commit.
- `data/farmer.db` — copy from the dev machine if you want decision-log /
  Kelly-sample / promotion-day history to carry over; omit for a fresh ledger.
- Wallet keypair file (live mode only) — put it outside the repo directory and
  point `WALLET_KEYPAIR_PATH` at it.

## Important

- **Run the bot on ONE machine at a time.** The single-instance lock is
  per-machine; a dev-PC loop and a server loop would double-trade the same
  strategy (and in live mode, the same wallet). When the server takes over,
  stop the local loop.
- Restarts are safe: positions live in SQLite; paper mode resumes them, live
  mode reconciles against the chain at startup (chain wins).
- Config changes in `config.toml` hot-reload without a restart — but pushing
  them through git triggers a restart via the watcher anyway, which is also fine.
