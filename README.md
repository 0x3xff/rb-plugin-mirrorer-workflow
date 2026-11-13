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
