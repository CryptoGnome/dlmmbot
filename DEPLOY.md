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

## Liveness monitoring (out-of-process)

Every alert the farmer sends originates inside the farmer, so none of them can
tell you the farmer is gone — "no Telegram messages" reads identically to "quiet
market". `deploy/heartbeat-check.cjs` closes that gap from outside the process.

The manager writes a `meta.heartbeat` row at the end of every tick (ts, pid,
build, mode, open positions, probe failures). The checker reads it read-only and
alerts to the same Telegram chat when it is older than 5 minutes — 20 ticks at
`poll_s = 15`. It alerts on the falling edge and then at most hourly, so a long
outage is a handful of messages rather than one every two minutes.

Install:

    crontab -e
    */2 * * * * node deploy/heartbeat-check.cjs >> /tmp/farmer-heartbeat.log 2>&1

Run it by hand any time with `npm run heartbeat-check`. Exit codes: 0 healthy,
1 stale or missing (alert sent), 2 the checker itself could not read the DB —
which deliberately does NOT alert, so a broken checker cannot page you at 3am
about itself.

It is dependency-free and imports nothing from `src/` on purpose: a monitor that
shares a failure mode with the thing it monitors is not a monitor. Note it runs
on the same box, so it detects a dead process, not a dead machine.

## Recovering a stuck position row

If a position is closed on chain but its DB row is still `open`, the manager
will now throw on every mark rather than mark it worthless, and reconcile will
refuse to orphan it. That is deliberate — see the 2026-08-10 watchdog commit —
but it means the row needs a human:

    npm run force-close -- <id> "why"

It checks the chain first and refuses if any tracked position account still
exists, so it cannot be used to write off a live position. `exit_sol` and
`close_return_sol` are left NULL because the outcome is genuinely unknown; such
a row contributes 0 to realized PnL rather than a fabricated number.
