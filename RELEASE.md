# Release workflow

Two long-lived branches, semver tags on production, and a staging path you can host separately.

## Branches

| Branch | Role | Who deploys here |
|--------|------|------------------|
| **`develop`** | Day-to-day work — features, fixes, docs, dashboard | Your **staging / dev** bot (`DEPLOY_BRANCH=develop`) |
| **`main`** | Production — only what you have tested and want released | **Production** bot + public site (`DEPLOY_BRANCH=main`) |

```text
feature/fix branches  →  develop  →  (test on staging)  →  main  →  tag vX.Y.Z
```

- **Never** push untested work straight to `main`.
- **Do** merge `develop` → `main` when staging looks good (PR preferred).
- After a release, merge `main` back into `develop` so the version bump and any hotfixes stay aligned:

```bash
git checkout develop && git pull && git merge origin/main && git push
```

## Daily development

```bash
git checkout develop
git pull origin develop
# … edit …
git commit -m "…"
git push origin develop
```

Staging server (PM2 auto-deploy watcher):

```bash
# in data/.env or PM2 env for meteora-deploy
DEPLOY_BRANCH=develop
```

Production server:

```bash
DEPLOY_BRANCH=main
```

Cloudflare Pages (**dlmmbot.com**): production branch **`main`**. Optionally add a preview project or branch alias for `develop` if you want a public staging site.

## Cutting a release (semver)

Current version lives in root **`package.json`** (`version` field). Tags are **`vMAJOR.MINOR.PATCH`** (e.g. `v0.2.0`).

### 1. Merge to `main`

Open a PR **`develop` → `main`**. CI must be green. Merge (squash or merge commit — your choice; tags always point at explicit release commits on `main`).

### 2. Cut semver on `main` (protected branch)

| Bump | When |
|------|------|
| **patch** | Bug fixes, small ops tweaks, no behavior contract change |
| **minor** | New features, new dashboard tabs, new config keys (backward compatible) |
| **major** | Breaking changes — config renames, exit-rule semantics, DB migrations operators must act on |

`main` is protected — do **not** rely on the Actions **Release** workflow alone (it tries to push directly to `main` and will fail). Use a short-lived release branch + PR:

```bash
git fetch origin
git checkout -B release/vX.Y.Z origin/main
npm version patch   # or minor / major — updates package.json + lockfile root only
git commit -am "Release vX.Y.Z"
git push -u origin release/vX.Y.Z
gh pr create --base main --head release/vX.Y.Z --title "Release vX.Y.Z" --body "Semver bump only."
# CI green → merge and delete the branch:
gh pr merge <n> --merge --delete-branch
git tag -a vX.Y.Z <merge-sha> -m "DLMM Bot vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --title "DLMM Bot vX.Y.Z" --generate-notes --latest
```

**Delete release branches after merge.** Only `develop` and `main` are long-lived. A merged `release/vX.Y.Z` (or feature branch) left on GitHub is clutter — always merge with `--delete-branch`, or run:

```bash
git push origin --delete release/vX.Y.Z
```

Production auto-deploy (if `DEPLOY_BRANCH=main`) picks up the release commit within ~30s.

### Optional: Actions Release workflow

GitHub → **Actions** → **Release** only works if `main` allows the bot to push. With branch protection, prefer the PR flow above.

### 3. Sync `develop`

Merge `main` back into `develop` (see above) so the next dev cycle starts from the released version.

## Version visibility

The dashboard build pill reads **`package.json` version**, the deploy **branch** (`DEPLOY_BRANCH`), and git describe from the running checkout — after a release, operators see the new semver on `main`.

## Recommended GitHub settings

**Settings → Branches → Branch protection**

- **`main`**: require PR, require CI (`CI` workflow), no force-push
- **`develop`**: require CI on PRs; direct push OK if you are solo

**Settings → General → Pull Requests**: enable **Automatically delete head branches** after merge (backup if `--delete-branch` is forgotten).

**Settings → General → Releases**: enable “Generate release notes” (workflow uses this).

## Hotfix (production broken)

```bash
git checkout main && git pull
# fix, commit
git push origin main
# Run Release workflow (patch bump) on main
git checkout develop && git merge origin/main && git push
```

Prefer hotfixing on `main` only when staging cannot wait; otherwise fix on `develop`, verify, then merge and release.
