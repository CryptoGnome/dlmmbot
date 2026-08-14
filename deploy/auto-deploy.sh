#!/usr/bin/env bash
# Auto-deploy watcher — run this under PM2 on the server (see ecosystem.config.cjs).
# Polls origin/$BRANCH and deploys ONLY when origin is strictly ahead of the
# local branch: verifies the new commit (npm ci if manifests changed,
# typecheck + tests + dashboard build) in a detached throwaway worktree, and
# only on green moves the live checkout to the new SHA and restarts the
# farmer — waiting for data/busy.flag to clear first so a restart never lands
# mid-executor-transaction. A broken push therefore never kills the running
# bot — it keeps running the last good build and the watcher logs the failure
# until a fixed commit lands.
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

# PM2 under a stripped PATH (common after `pm2 restart meteora-deploy`) used to
# print "deployed" while never restarting the farmer. Resolve an absolute binary
# up front; prefer explicit PM2_BIN, then PATH, then known install locations.
resolve_pm2() {
  if [ -n "${PM2_BIN:-}" ] && [ -x "$PM2_BIN" ]; then printf '%s\n' "$PM2_BIN"; return 0; fi
  if command -v pm2 >/dev/null 2>&1; then command -v pm2; return 0; fi
  local c
  for c in \
    "${HOME}/.npm-global/bin/pm2" \
    "${HOME}/.local/share/pnpm/pm2" \
    /usr/local/bin/pm2 \
    /usr/bin/pm2
  do
    if [ -x "$c" ]; then printf '%s\n' "$c"; return 0; fi
  done
  return 1
}

PM2=$(resolve_pm2) || {
  echo "[deploy] FATAL: pm2 not found (set PM2_BIN or install pm2 on PATH) — exiting so PM2 can restart this watcher"
  exit 1
}
echo "[deploy] watching origin/$BRANCH every ${POLL_SECONDS}s (app: $APP_NAME, pm2: $PM2)"

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
# Tests passed + pull applied but pm2 restart failed — keep retrying while idle.
pending_restart=""

# The farmer touches data/busy.flag around executor-critical sections (zap
# swap sent, add-liquidity pending, DB row not yet finalized). Restarting
# inside that window strands tokens or leaves an on-chain position the ledger
# only knows as `pending`. Wait for the flag to clear before restarting; after
# the timeout proceed anyway — a wedged flag must not block deploys forever.
BUSY_FLAG="${FARMER_BUSY_FLAG:-data/busy.flag}"
BUSY_WAIT_S="${DEPLOY_BUSY_WAIT_S:-120}"

wait_for_idle() {
  [ -e "$BUSY_FLAG" ] || return 0
  echo "[deploy] $BUSY_FLAG present — waiting up to ${BUSY_WAIT_S}s for the farmer to finish its in-flight executor work"
  local waited=0
  while [ -e "$BUSY_FLAG" ] && [ "$waited" -lt "$BUSY_WAIT_S" ]; do
    sleep 2
    waited=$((waited + 2))
  done
  if [ -e "$BUSY_FLAG" ]; then
    echo "[deploy] WARNING: $BUSY_FLAG still present after ${BUSY_WAIT_S}s — restarting anyway (flag may be stale)"
  else
    echo "[deploy] busy flag cleared after ${waited}s"
  fi
  return 0
}

restart_app() {
  echo "[deploy] typecheck + tests passed — restarting $APP_NAME via $PM2"
  wait_for_idle
  if "$PM2" restart "$APP_NAME" --update-env; then
    echo "[deploy] deployed $(git rev-parse --short HEAD): $(git log -1 --pretty=%s)"
    pending_restart=""
    last_failed=""
    last_skip=""
    return 0
  fi
  echo "[deploy] ERROR: $PM2 restart $APP_NAME failed — will retry every ${POLL_SECONDS}s (checkout stays on $(git rev-parse --short HEAD))"
  pending_restart=1
  return 1
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
    if [ -n "$pending_restart" ]; then
      restart_app || true
      sleep "$POLL_SECONDS"; continue
    fi
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

  # Operator gate: auto-update off until Changes → Approve (dashboard writes data/deploy-prefs.json).
  # Fail CLOSED: any error evaluating the prefs means "hold", never "deploy" —
  # an evaluation crash must not silently override an operator who turned
  # auto-update off.
  DEPLOY_GATE=$(node --input-type=module -e "
    import { shouldAutoDeploy } from './deploy/lib/deploy-prefs.mjs';
    const r = shouldAutoDeploy(process.cwd(), process.argv[1]);
    process.stdout.write(r.ok ? 'ok:' + r.reason : 'wait');
  " "$REMOTE" 2>/dev/null || echo "hold:error")
  case "$DEPLOY_GATE" in
    ok:*) ;;
    wait)
      note_skip "auto-update off — $(git rev-parse --short "$REMOTE") waiting for Approve on Changes tab"
      sleep "$POLL_SECONDS"; continue
      ;;
    *)
      note_skip "deploy gate could not be evaluated (got '$DEPLOY_GATE') — holding $(git rev-parse --short "$REMOTE") until it works"
      sleep "$POLL_SECONDS"; continue
      ;;
  esac

  last_skip=""
  echo "[deploy] origin/$BRANCH advanced ($(git rev-parse --short "$LOCAL") -> $(git rev-parse --short "$REMOTE")) — verifying in a detached worktree (gate=$DEPLOY_GATE)"

  DEPS_CHANGED=0
  DASH_CHANGED=0
  git diff --name-only "$LOCAL" "$REMOTE" | grep -qE '^package(-lock)?\.json$' && DEPS_CHANGED=1
  git diff --name-only "$LOCAL" "$REMOTE" | grep -qE '^dashboard/' && DASH_CHANGED=1

  # Verify the NEW commit in a throwaway worktree so the live checkout never
  # holds an untested build. Previously the pull happened first: for the whole
  # npm-ci + typecheck + test window the working tree held the unverified
  # commit, and any unrelated crash there made PM2 autorestart boot it.
  WORKTREE="$(pwd)/.deploy-verify"
  rm -rf "$WORKTREE"
  git worktree prune >/dev/null 2>&1 || true

  FAILURE=""
  git worktree add --detach "$WORKTREE" "$REMOTE" >/dev/null || FAILURE="worktree add"

  if [ -z "$FAILURE" ]; then
    if [ "$DEPS_CHANGED" = 1 ]; then
      echo "[deploy] dependency manifests changed — npm ci (worktree)"
      (cd "$WORKTREE" && npm ci) || FAILURE="npm ci"
    else
      # Deps unchanged — reuse the live node_modules for verification.
      ln -s "$(pwd)/node_modules" "$WORKTREE/node_modules" || FAILURE="node_modules link"
    fi
  fi
  if [ -z "$FAILURE" ] && ! (cd "$WORKTREE" && npx tsc --noEmit); then
    FAILURE="typecheck"
  fi
  if [ -z "$FAILURE" ] && [ -f "$WORKTREE/tsconfig.deploy.json" ] \
    && ! (cd "$WORKTREE" && npx tsc -p tsconfig.deploy.json --noEmit); then
    FAILURE="deploy typecheck"
  fi
  if [ -z "$FAILURE" ] && ! (cd "$WORKTREE" && npm test); then
    FAILURE="tests"
  fi
  if [ -z "$FAILURE" ] && [ "$DASH_CHANGED" = 1 ]; then
    echo "[deploy] dashboard/ changed — building SPA (worktree)"
    if [ -f "$WORKTREE/dashboard/package-lock.json" ]; then
      (cd "$WORKTREE/dashboard" && npm ci && npm run build) || FAILURE="dashboard build"
    else
      (cd "$WORKTREE/dashboard" && npm install && npm run build) || FAILURE="dashboard build"
    fi
  fi

  if [ -n "$FAILURE" ]; then
    echo "[deploy] $FAILURE FAILED for $(git rev-parse --short "$REMOTE") — live checkout untouched, $APP_NAME stays on $(git rev-parse --short "$LOCAL")"
    last_failed="$REMOTE"
    rm -rf "$WORKTREE"
    git worktree prune >/dev/null 2>&1 || true
    sleep "$POLL_SECONDS"; continue
  fi

  # Verified green — only now touch the live checkout. Untracked files that the
  # incoming commit adds (e.g. an SCP'd script left in deploy/) would be
  # clobbered by reset --hard. Quarantine those only — never touch dirty
  # tracked edits; those still need a human.
  mkdir -p .deploy-quarantine
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if [ -e "$f" ] && [ -z "$(git ls-files -- "$f")" ]; then
      dest=".deploy-quarantine/$(echo "$f" | tr '/' '__').$(date +%s)"
      echo "[deploy] quarantining untracked $f -> $dest (would be clobbered)"
      mv -- "$f" "$dest" || true
    fi
  done < <(git diff --name-only --diff-filter=A "$LOCAL" "$REMOTE")

  if ! git reset --hard --quiet "$REMOTE"; then
    echo "[deploy] ERROR: could not advance the live checkout to $(git rev-parse --short "$REMOTE") — manual intervention needed"
    last_failed="$REMOTE"
    rm -rf "$WORKTREE"
    git worktree prune >/dev/null 2>&1 || true
    sleep "$POLL_SECONDS"; continue
  fi

  SWAP_FAILURE=""
  if [ "$DEPS_CHANGED" = 1 ]; then
    echo "[deploy] syncing live node_modules — npm ci"
    npm ci || SWAP_FAILURE="npm ci (live tree)"
  fi
  if [ -z "$SWAP_FAILURE" ] && [ "$DASH_CHANGED" = 1 ] && [ -d "$WORKTREE/dashboard/dist" ]; then
    # Reuse the dist verified in the worktree instead of building twice.
    rm -rf dashboard/dist
    cp -R "$WORKTREE/dashboard/dist" dashboard/dist || SWAP_FAILURE="dashboard dist copy"
  fi
  rm -rf "$WORKTREE"
  git worktree prune >/dev/null 2>&1 || true

  if [ -z "$SWAP_FAILURE" ]; then
    restart_app || true
    node --input-type=module -e "
      import { clearApprove } from './deploy/lib/deploy-prefs.mjs';
      clearApprove(process.cwd());
    " 2>/dev/null || true
    if [ "$DASH_CHANGED" = 1 ] || [ -d dashboard/dist ]; then
      echo "[deploy] restarting meteora-dash (if present)"
      "$PM2" restart meteora-dash --update-env 2>/dev/null \
        || "$PM2" start deploy/ecosystem.config.cjs --only meteora-dash 2>/dev/null \
        || echo "[deploy] meteora-dash not started (ok if DASH_TOKEN unset / app not added yet)"
    fi
  else
    # `pm2 restart` runs the WORKING TREE, and the reset above already moved it
    # onto the new commit that could not be made runnable. Leaving it there
    # means the next restart from ANY cause — a later deploy, a reboot,
    # `pm2 resurrect`, a human — silently boots a build whose node_modules or
    # dashboard assets are wrong. Put the tree back so "keeping the running
    # (old) build" is true of the code on disk and not just of the live process.
    echo "[deploy] $SWAP_FAILURE FAILED at $(git rev-parse --short HEAD) — rolling the checkout back to $(git rev-parse --short "$LOCAL")"
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
