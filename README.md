# Roblox plugin mirror

A GitHub Actions workflow that logs into Roblox with your `.ROBLOSECURITY` cookie, checks
whether your account owns each plugin listed in `plugins.json`, downloads the owned ones, and
commits them back into this repo — so the repo's git history becomes a changelog of every
plugin update.

## Setup

1. Push this repo to GitHub.
2. Add the cookie as a secret: **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `ROBLOSECURITY`
   - Value: the `.ROBLOSECURITY` cookie value (the whole `_|WARNING:-DO-NOT-SHARE…` string)
   - Optional second secret: `DISCORD_WEBHOOK` for a short run summary in Discord.
3. List the plugins you want mirrored in `plugins.json`:

```json
{
  "plugins": [
    { "id": "96645663824840", "name": "optional label" },
    { "id": "1234567890" }
  ]
}
```

   Only `id` matters — the real name is read from the Creator Store at runtime. A bare array
   (`["96645663824840", 1234567890]`) works too.

4. Run it: **Actions → Update plugins → Run workflow**, or wait for the daily 04:17 UTC schedule.

Because the workflow pushes commits, make sure **Settings → Actions → General → Workflow
permissions** is set to *Read and write permissions*. If the default branch is protected, allow
`github-actions[bot]` to push to it.

## What a run does

For each asset id:

| Step | Endpoint |
| --- | --- |
| Identify the account | `users.roblox.com/v1/users/authenticated` |
| Read name + price | `apis.roblox.com/toolbox-service/v1/items/details` |
| Ownership check | `inventory.roblox.com/v1/users/{userId}/items/Asset/{assetId}/is-owned` |
| Acquire (opt-in only) | `apis.roblox.com/marketplace-fiat-service/v1/product/purchase` |
| Download | `assetdelivery.roblox.com/v1/asset/?id={assetId}` (follows the CDN redirect) |

Not owned → reported and skipped, nothing is written. Owned → the file is downloaded, hashed, and
written to `plugins/<name>-<assetId>.rbxm` **only if the bytes differ** from the last run, so
repeat runs produce no commits. `plugins.lock.json` tracks name, creator, sha256, size, and
first-seen / last-changed timestamps per asset. A plugin renamed on the Store is moved to the new
filename and the old one is deleted.

Each run writes a status table to the job summary.

## Workflow inputs (manual runs)

| Input | Default | Meaning |
| --- | --- | --- |
| `asset_ids` | — | Extra comma-separated asset ids to check this run, on top of `plugins.json` |
| `acquire_free` | `false` | If an asset is not owned **and currently costs nothing**, send the Creator Store "Get" request, then mirror it. The request pins the expected price to `0`, so Roblox rejects it if the asset is not actually free — it can never spend money. |
| `dry_run` | `false` | Check and report only: download nothing, write nothing, commit nothing |

## Running it locally

```sh
ROBLOSECURITY="paste-cookie" DRY_RUN=1 node scripts/update-plugins.js
```

Env vars: `ROBLOSECURITY` (required), `PLUGINS_FILE`, `LOCK_FILE`, `OUT_DIR`, `ASSET_IDS`,
`ACQUIRE_FREE`, `DRY_RUN`, `BASE_DELAY_MS`, `DISCORD_WEBHOOK`. Node 18+, no npm packages.

Exit codes: `0` fine, `2` some assets failed (anything that succeeded is still written, so the
workflow still commits those and then marks the run red), `1` fatal — e.g. the cookie was rejected.

## Notes

- **The cookie is a full login.** Keep it in Actions secrets only; never commit it. Logging out of
  Roblox in a browser invalidates it, and the workflow will then fail with
  `cookie rejected (HTTP 401)` — refresh the secret.
- Requests are throttled (1.2 s apart by default) and back off on `429`/`5xx`, and the `x-csrf-token`
  handshake is handled automatically.
- Roblox serves plugins as binary `.rbxm`; `.gitattributes` marks those as binary so git doesn't try
  to diff them. To read the Lua inside a mirrored file, open it in Studio or run it through
  [rbxm parsing tools](https://github.com/rojo-rbx/rbx-dom).
- Only one run at a time (`concurrency: update-plugins`), and the commit step rebases before pushing
  so a manual run and the schedule can't clobber each other.
