#!/usr/bin/env bash
# Auto-deploy watcher — run this under PM2 on the server (see ecosystem.config.cjs).
# Polls origin/master; on new commits: pull, reinstall deps if manifests changed,
# typecheck, and ONLY restart the farmer if the typecheck passes. A broken push
# therefore never kills the running bot — it keeps running the last good build
# and the watcher logs the failure until a fixed commit lands.

set -u
cd "$(dirname "$0")/.."

POLL_SECONDS="${DEPLOY_POLL_SECONDS:-30}"
APP_NAME="${DEPLOY_APP_NAME:-meteora-farmer}"
BRANCH="${DEPLOY_BRANCH:-master}"

echo "[deploy] watching origin/$BRANCH every ${POLL_SECONDS}s (app: $APP_NAME)"

while true; do
  git fetch origin "$BRANCH" --quiet 2>/dev/null || { echo "[deploy] fetch failed (offline?)"; sleep "$POLL_SECONDS"; continue; }
  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse "origin/$BRANCH")

  if [ "$LOCAL" != "$REMOTE" ]; then
    echo "[deploy] new commits detected ($LOCAL -> $REMOTE), pulling..."
    if ! git pull --ff-only origin "$BRANCH"; then
      echo "[deploy] pull failed (diverged history?) — manual intervention needed"
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
  fi

  sleep "$POLL_SECONDS"
done
