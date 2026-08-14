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

## Share a profile (Railway / browser)

1. Dashboard: **Settings → Profiles → Share to GitHub**.
2. Follow the modal (copy JSON + index row → create file → edit `index.json`).
3. GitHub will ask you to **fork** if you cannot push to this repo — that is expected.
4. You never need `git` on the bot host (Railway included); use github.com only.

Details: [`community/README.md`](community/README.md).
