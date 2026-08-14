# Community profiles

Curated settings packs shared by operators. Merged via PR — the dashboard gallery reads this folder from GitHub at runtime (works on Railway / VPS / local).

## Share from the dashboard (browser-only — no git on the bot)

You do **not** need to clone the bot to your PC. Railway and remote hosts are fine: do everything in **github.com** while logged into GitHub.

1. In the bot: **Settings → Profiles → Share to GitHub** (or **How to contribute**).
2. In the guided modal: **Copy JSON**, then **Copy index row**.
3. Click **Create `<slug>.json`** — opens github.com (works from Railway; no files leave your host except what you paste).
4. If you are not a collaborator, GitHub shows **Fork this repository** — accept that. You are editing **your fork**, then proposing a PR upstream. That is the normal open-source path.
5. Paste the JSON into the new file and commit on the fork.
6. Still on your fork, open **Edit index.json** (link in the modal) and add the copied row to the `profiles` array (same branch).
7. **Contribute → Open pull request** against `CryptoGnome/dlmmbot` `master`.

No `git` CLI on the bot, no VS Code, no downloading the Railway volume. Dashboard Wiki → **Settings profiles** has the same walkthrough.

## Rules

1. One JSON file per profile: `profiles/community/<slug>.json` (`slug` = lowercase `[a-z0-9-]+`).
2. Add an entry to `index.json` in the **same** PR.
3. Only Bot settings knobs (no secrets, no `exec.mode`, no RPC/wallet keys).
4. Keep `description` honest about risk (aggressive packs should say so).
5. Prefer small diffs vs official Balanced — easier to review.

## Index entry shape

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
