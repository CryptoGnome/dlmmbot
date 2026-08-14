# Community profiles

Curated settings packs shared by operators. Merged via PR — the dashboard gallery reads this folder from GitHub.

## Rules

1. One JSON file per profile: `profiles/community/<slug>.json` (`slug` = lowercase `[a-z0-9-]+`).
2. Add an entry to `index.json` in the same PR.
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
