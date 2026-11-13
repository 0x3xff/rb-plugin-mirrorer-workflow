# Roblox plugin mirror

A GitHub Actions workflow that logs into Roblox with your `.ROBLOSECURITY` cookie, checks each
asset id in `plugins.json`, and for the ones your account owns, downloads the plugin and commits it
— but only when the bytes actually changed. The mirror branch's git history becomes a changelog of
every plugin update.

## Branch layout

| Branch | Holds | Notes |
| --- | --- | --- |
| `workflow` | `.github/workflows/`, `scripts/`, this README | **Must be the repository's default branch** |
| `main` | `plugins/*.rbxm`, `plugins.json`, `plugins.lock.json` | Only ever written by the workflow |

`workflow` has to be the default branch because GitHub only fires `schedule` from the default
branch's copy of a workflow file, and only lists dispatchable workflows from there. The job checks
out `main` separately and pushes its commits to it.

## Setup

1. **Secret.** Settings → Secrets and variables → Actions → New repository secret:
   name `ROBLOSECURITY`, value = the whole `_|WARNING:-DO-NOT-SHARE-THIS...|_` cookie value.
2. **Write access.** Settings → Actions → General → Workflow permissions → *Read and write*.
3. **Default branch.** Settings → General → Default branch → switch to `workflow`.
4. Keep the repo **private** — the mirrored `.rbxm` files are plugin source you bought.

## Using it

**Add a plugin:** Actions → Update plugins → Run workflow → put the asset id (or several, comma
separated) in `asset_ids`. The ids are appended to `plugins.json` on `main` and committed, so every
later run keeps checking them.

**Daily:** the `schedule` trigger re-checks everything in `plugins.json` at 04:17 UTC. Nothing
changed upstream → no commit, no noise. A plugin got republished → a commit with just that file.

**Stop tracking something:** delete its id from `plugins.json` on `main`. The already-mirrored file
stays; it just stops being checked.

| Input | Default | Meaning |
| --- | --- | --- |
| `asset_ids` | — | Ids to add and check this run, comma separated |
| `acquire_free` | `false` | If an asset is not owned **and currently costs nothing**, send the Creator Store "Get" request, then mirror it. `expectedPrice` is pinned to `0`, so Roblox rejects the request if the asset is not actually free — it can never spend money. |
| `dry_run` | `false` | Check and report only: download nothing, write nothing, commit nothing |

`plugins.json` is a plain array of ids:

```json
["96645663824840", "1234567890"]
```

## What a run does

| Step | Endpoint |
| --- | --- |
| Identify the account | `users.roblox.com/v1/users/authenticated` |
| Read name + price | `apis.roblox.com/toolbox-service/v1/items/details` |
| Ownership check | `inventory.roblox.com/v1/users/{userId}/items/Asset/{assetId}/is-owned` |
| Acquire (opt-in only) | `apis.roblox.com/marketplace-fiat-service/v1/product/purchase` |
| Download | `assetdelivery.roblox.com/v1/asset/?id={assetId}` (follows the CDN pointer) |

Not owned → reported and skipped, nothing written. Owned → downloaded, hashed, and written to
`plugins/<name>-<assetId>.rbxm` only if the sha256 differs from last time. `plugins.lock.json`
records name, creator, hash, size, and first-seen / last-changed per asset. A plugin renamed on the
Store is moved to the new filename and the old file deleted. Every run writes a status table to the
job summary.

### Why commits can't conflict

The job checks out `main` by **ref name**, so it always starts from the branch tip rather than the
SHA that triggered the run. The commit step then, per attempt, fetches the current tip,
`git reset --mixed` onto it (keeping the downloads in the working tree), and stages *only* the paths
that run produced, read from a list the script writes. So a commit that landed meanwhile is never
conflicted with and never clobbered — and nothing outside this run's own output can be deleted.

## Running it locally

```sh
ROBLOSECURITY="paste-cookie" DRY_RUN=1 node scripts/update-plugins.js
```

Run it from a checkout of `main` (or point `PLUGINS_FILE` / `LOCK_FILE` / `OUT_DIR` at one).
Env vars: `ROBLOSECURITY` (required), `ASSET_IDS`, `PLUGINS_FILE`, `LOCK_FILE`, `OUT_DIR`,
`ACQUIRE_FREE`, `DRY_RUN`, `BASE_DELAY_MS`, `CHANGED_PATHS_FILE`. Node 18+, no npm packages.

Exit codes: `0` fine · `2` some assets failed — whatever succeeded is still written and committed,
then the run is marked red · `1` fatal, e.g. the cookie was rejected or the id list is empty.

## Notes

- **The cookie is a full login.** Actions secrets only, never committed. The script never prints it.
- Logging out of Roblox in a browser invalidates it; runs then fail with `cookie rejected (HTTP 401)`
  and you re-paste the secret.
- Requests are throttled (1.2 s apart) with backoff on `429`/`5xx`, and the `x-csrf-token` handshake
  is automatic.
- `.gitattributes` marks `.rbxm` as binary so git doesn't try to diff it. To read the Lua inside one,
  open it in Studio or use [rbx-dom](https://github.com/rojo-rbx/rbx-dom).
