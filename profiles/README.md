# Settings profiles

JSON packs of allowlisted Bot settings knobs (same dotted paths as the dashboard Settings form).

## Layout

| Path | Purpose |
|---|---|
| `official/` | Built-in Conservative / Balanced / Aggressive |
| `community/` | Shared profiles via PR + `index.json` gallery |

## Schema (v1)

```json
{
  "schema": 1,
  "id": "my-slug",
  "name": "Display name",
  "description": "One or two sentences.",
  "author": "github-or-handle",
  "tags": ["risk-on"],
  "updated": "2026-08-14",
  "updates": {
    "sizing.max_positions": 5,
    "manage.stop_loss_frac": 0.75
  }
}
```

- Only paths exposed in Bot settings are applied.
- `exec.mode` is never applied from a profile (cannot flip paper/live).
- Secrets, wallet, RPC, and the GNME usage fee are never part of a profile.

## Share a profile

1. In the dashboard: Settings → Profiles → **Share** / Export JSON.
2. Open **Propose on GitHub** (or add `profiles/community/<slug>.json` via PR).
3. Add a row to [`community/index.json`](community/index.json) in the same PR.

See [`community/README.md`](community/README.md).
