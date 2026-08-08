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

# Origin head whose build failed. Held so a broken push is retried when a fix
# lands on top of it, not re-typechecked every poll forever.
last_failed=""

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

  if [ "$REMOTE" = "$last_failed" ]; then
    note_skip "origin/$BRANCH head $(git rev-parse --short "$REMOTE") failed to build — $APP_NAME held on $(git rev-parse --short "$LOCAL"); push a fix on top of it"
    sleep "$POLL_SECONDS"; continue
  fi

  last_skip=""
  echo "[deploy] origin/$BRANCH advanced ($(git rev-parse --short "$LOCAL") -> $(git rev-parse --short "$REMOTE")), pulling..."
  if ! git pull --ff-only origin "$BRANCH"; then
    note_skip "pull failed (uncommitted changes in the way?) — manual intervention needed"
    sleep "$POLL_SECONDS"; continue
  fi

  DEPS_CHANGED=0
  git diff --name-only "$LOCAL" HEAD | grep -qE '^package(-lock)?\.json$' && DEPS_CHANGED=1

  FAILURE=""
  if [ "$DEPS_CHANGED" = 1 ]; then
    echo "[deploy] dependency manifests changed — npm ci"
    npm ci || FAILURE="npm ci"
  fi
  if [ -z "$FAILURE" ] && ! npx tsc --noEmit; then
    FAILURE="typecheck"
  fi

  if [ -z "$FAILURE" ]; then
    echo "[deploy] typecheck passed — restarting $APP_NAME"
    pm2 restart "$APP_NAME" --update-env
    echo "[deploy] deployed $(git rev-parse --short HEAD): $(git log -1 --pretty=%s)"
    last_failed=""
  else
    # `pm2 restart` runs the WORKING TREE, and the pull above already moved it
    # onto the bad commit. Leaving it there means the next restart from ANY
    # cause — a later deploy, a reboot, `pm2 resurrect`, a human — silently
    # boots the broken build. Put the tree back so "keeping the running (old)
    # build" is true of the code on disk and not just of the live process.
    echo "[deploy] $FAILURE FAILED at $(git rev-parse --short HEAD) — rolling the checkout back to $(git rev-parse --short "$LOCAL")"
    if git reset --hard --quiet "$LOCAL"; then
      if [ "$DEPS_CHANGED" = 1 ]; then
        npm ci || echo "[deploy] npm ci during rollback FAILED — node_modules may not match the restored code"
      fi
      echo "[deploy] checkout restored to $(git rev-parse --short HEAD) — $APP_NAME still on the last good build"
    else
      echo "[deploy] ROLLBACK FAILED — checkout is on broken code, do NOT restart $APP_NAME until it is fixed"
    fi
    last_failed="$REMOTE"
  fi

  sleep "$POLL_SECONDS"
done
