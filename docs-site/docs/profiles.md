---
title: Settings profiles
description: Official, local, and community settings packs — apply in the dashboard, share via browser PR (Railway-friendly).
---

# Settings profiles

Packs of Bot settings knobs (same paths as **Settings → Bot settings**). Apply with a diff preview. Profiles never flip paper/live mode, never touch RPC/wallet secrets, and never change [product fees](./fees).

| Kind | Where it lives | Who sees it |
|---|---|---|
| **Official** | Shipped in the bot (`Conservative` / `Balanced` / `Aggressive`) | Everyone |
| **My profiles** | Your data volume (`data/profiles/`) | Only your bot |
| **Community** | GitHub gallery under `profiles/community/` | Everyone after a PR merges |

Open **Settings → Profiles** in the dashboard. The in-dashboard Wiki → **Settings profiles** has the short operator tour; this page is the full share guide.

## Apply a pack

1. Pick Official, My profiles, or Community.
2. **Preview** — see exactly which knobs change.
3. **Apply** — bot hot-reloads within a couple of seconds.

## Save your own

On **My profiles**, name the current Bot settings and **Save current**. That snapshot stays on your Railway volume / VPS disk until you delete it.

## Share to the community gallery (browser-only)

You do **not** need to clone the bot to a PC, and you do **not** need `git` on Railway. Stay logged into [github.com](https://github.com) in the browser.

### Steps

1. In the bot: **Settings → Profiles → Share to GitHub** (or **How to contribute**).
2. In the guided modal: **Copy JSON**, then **Copy index row**.
3. Click **Create `<slug>.json`** — opens GitHub’s create-file page.
4. If you are not a collaborator, GitHub shows **Fork this repository** — accept that. You edit **your fork**, then open a PR upstream. That is expected.
5. Paste the JSON into the new file and commit on the fork.
6. Still on your fork, open **Edit index.json** (link in the modal) and add the copied row to the `profiles` array (same branch).
7. **Contribute → Open pull request** against `CryptoGnome/dlmmbot` `master`.

After merge, the dashboard gallery picks it up (community cache ~10 minutes).

::: tip Fork = normal
Most operators are not collaborators. The fork prompt is the open-source path — not a bug.
:::

## Rules for community PRs

1. One JSON file per profile: `profiles/community/<slug>.json` (`slug` = lowercase `[a-z0-9-]+`).
2. Add an entry to `profiles/community/index.json` in the **same** PR.
3. Only Bot settings knobs (no secrets, no `exec.mode`, no RPC/wallet keys).
4. Keep `description` honest about risk (aggressive packs should say so).
5. Prefer small diffs vs official Balanced — easier to review.

## Profile JSON shape

```json
{
  "schema": 1,
  "id": "my-slug",
  "name": "Display name",
  "description": "One or two sentences.",
  "author": "github-or-handle",
  "tags": ["community"],
  "updated": "2026-08-14",
  "updates": {
    "sizing.max_positions": 5,
    "manage.stop_loss_frac": 0.75
  }
}
```

### Index row (same PR)

```json
{
  "id": "my-slug",
  "name": "My pack",
  "author": "you",
  "description": "…",
  "tags": ["community"],
  "file": "my-slug.json",
  "updated": "2026-08-14"
}
```

## Related

- Dashboard: **Settings → Profiles** and Wiki → **Settings profiles**
- Easy setup: [Railway](./easy)
- Advanced setup: [local / VPS](./advanced)
