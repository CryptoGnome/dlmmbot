#!/usr/bin/env bash
# Auto-deploy watcher — run this under PM2 on the server (see ecosystem.config.cjs).
# Polls origin/$BRANCH and deploys ONLY when origin is strictly ahead of the
# local branch: pull, reinstall deps if manifests changed, typecheck, and
# restart the farmer only if the typecheck passes. A broken push therefore
# never kills the running bot — it keeps running the last good build and the
# watcher logs the failure until a fixed commit lands.
#
# Deliberately inert unless the checkout is ON $BRANCH and behind origin:
#   feature branch checked out -> skip (branch work must not touch the live bot)
#   local commits not pushed   -> skip (nothing has been published to deploy)
#   diverged history           -> skip and warn (needs a human)
#
# The previous version compared HEAD to origin/$BRANCH and acted on ANY
# inequality, in either direction. Ordinary branch work — the documented
# convention for this repo — therefore restarted the live trading bot every
# poll (7 restarts in 5 minutes on 2026-08-08) and, worse, "deployed" unpushed
# branch code to it while logging a backwards `new commits detected` line.

set -u
cd "$(dirname "$0")/.."

POLL_SECONDS="${DEPLOY_POLL_SECONDS:-30}"
APP_NAME="${DEPLOY_APP_NAME:-meteora-farmer}"
BRANCH="${DEPLOY_BRANCH:-master}"

echo "[deploy] watching origin/$BRANCH every ${POLL_SECONDS}s (app: $APP_NAME)"

# Skips are steady states, not events: log a reason only when it changes, so a
# day on a feature branch leaves one line instead of 2,880.
last_skip=""
note_skip() {
  [ "$1" = "$last_skip" ] && return 0
  echo "[deploy] $1"
  last_skip="$1"
}

while true; do
  if ! git fetch origin "$BRANCH" --quiet 2>/dev/null; then
    note_skip "fetch failed (offline?) — will retry"
    sleep "$POLL_SECONDS"; continue
  fi

  CURRENT=$(git symbolic-ref --quiet --short HEAD || echo "(detached HEAD)")
  if [ "$CURRENT" != "$BRANCH" ]; then
    note_skip "checkout is on '$CURRENT', not '$BRANCH' — deploys paused until it returns"
    sleep "$POLL_SECONDS"; continue
  fi

  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse "origin/$BRANCH")

  if [ "$LOCAL" = "$REMOTE" ]; then
    last_skip=""
    sleep "$POLL_SECONDS"; continue
  fi

  # Strictly behind origin is the only deployable state: LOCAL must be an
  # ancestor of REMOTE. Anything else is local work or a mess, never a deploy.
  if ! git merge-base --is-ancestor "$LOCAL" "$REMOTE"; then
    if git merge-base --is-ancestor "$REMOTE" "$LOCAL"; then
      note_skip "local $BRANCH is ahead of origin (unpushed commits) — nothing to deploy"
    else
      note_skip "local $BRANCH has diverged from origin — manual intervention needed"
    fi
    sleep "$POLL_SECONDS"; continue
  fi

  last_skip=""
  echo "[deploy] origin/$BRANCH advanced ($(git rev-parse --short "$LOCAL") -> $(git rev-parse --short "$REMOTE")), pulling..."
  if ! git pull --ff-only origin "$BRANCH"; then
    note_skip "pull failed (uncommitted changes in the way?) — manual intervention needed"
    sleep "$POLL_SECONDS"; continue
  fi

  if git diff --name-only "$LOCAL" HEAD | grep -qE '^package(-lock)?\.json$'; then
    echo "[deploy] dependency manifests changed — npm ci"
    npm ci || { echo "[deploy] npm ci FAILED — not restarting"; sleep "$POLL_SECONDS"; continue; }
  fi

  if npx tsc --noEmit; then
    echo "[deploy] typecheck passed — restarting $APP_NAME"
    pm2 restart "$APP_NAME" --update-env
    echo "[deploy] deployed $(git rev-parse --short HEAD): $(git log -1 --pretty=%s)"
  else
    echo "[deploy] TYPECHECK FAILED — keeping the running (old) build, will retry on next push"
  fi

  sleep "$POLL_SECONDS"
done
