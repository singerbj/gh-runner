# `pick-runner`

Resolves `runs-on` for a job: the self-hosted labels when a [`gh-runner`](https://www.npmjs.com/package/@singerbj/gh-runner) is online, and the GitHub-hosted runner the job used before when none is.

`gh-runner`'s workflow fix writes this job for you. It's documented here because it ends up in your repo, and nothing that lands in your workflows should be a black box.

## Why it exists

`runs-on` is evaluated before any step runs, so it can't ask an API anything — it can only read `github`, `needs`, `strategy`, `matrix`, `vars`, and `inputs`. A job that wants to choose its own runner therefore needs an earlier job to have chosen for it. That's this one.

The obvious implementation — call `GET /repos/{owner}/{repo}/actions/runners` — needs **admin** access to the repository, and `administration` isn't one of the scopes a workflow's `GITHUB_TOKEN` can be granted. Doing it that way means a PAT in a secret, in every repo, rotated forever.

So the runner publishes its own liveness instead. While it's registered, `gh-runner` writes a ref per label:

```
refs/gh-runner/online/gh-runner-linux/1753900000
```

re-stamps it every two minutes, and deletes it on exit. Reading refs needs only `contents: read`, which the built-in token has. The stamp is in the ref's _name_, so a heartbeat is two cheap API calls and never writes a git object; a marker nobody is re-stamping ages out on its own, which is what makes a hard kill self-healing rather than permanent.

## Usage

```yaml
jobs:
  gh-runner-check:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      runners: "${{ steps.pick.outputs.runners }}"
    steps:
      - uses: singerbj/gh-runner/actions/pick-runner@v1
        id: pick
        with:
          targets: |
            {
              "linux": { "labels": ["self-hosted","gh-runner-linux"], "fallback": "ubuntu-latest" },
              "mac":   { "labels": ["self-hosted","gh-runner-mac"],   "fallback": "macos-14" }
            }

  build:
    needs: [gh-runner-check]
    runs-on: ${{ fromJSON(needs.gh-runner-check.outputs.runners).linux || 'ubuntu-latest' }}
```

### Inputs

| Input        | Default                    | Description                                               |
| ------------ | -------------------------- | --------------------------------------------------------- |
| `targets`    | —                          | JSON: key → `{ labels, fallback }`. One key per platform. |
| `token`      | `${{ github.token }}`      | Only needs `contents: read`.                              |
| `repository` | `${{ github.repository }}` | Where to read markers from.                               |
| `max-age`    | `420`                      | Seconds a marker stays trusted — three missed heartbeats. |
| `api-url`    | `${{ github.api_url }}`    | For GitHub Enterprise Server.                             |

### Outputs

| Output       | Description                                                                     |
| ------------ | ------------------------------------------------------------------------------- |
| `runners`    | JSON: key → a label array (self-hosted) or the fallback runner name (a string). |
| `online`     | JSON array of the keys that resolved to a self-hosted runner.                   |
| `any-online` | `"true"` when at least one did.                                                 |

## It fails open, on purpose

A step that decides where everything else runs must never be the reason a build can't start. No token, an unreachable API, a 500, a `targets` input that isn't valid JSON — every one of them resolves to the fallback runner, logs a warning annotation, and exits 0.

The `runs-on` this writes carries its own `|| 'ubuntu-latest'` as well, so even an empty `runners` output lands the job on the runner it had before.

**Unless you asked it not to.** `gh-runner --fix-workflows --no-hosted-fallback` sets each target's `fallback` to its own `labels`, so an offline platform resolves to a `runs-on` only a self-hosted runner can answer and the job queues instead:

```jsonc
"linux": { "labels": ["self-hosted","gh-runner-linux"], "fallback": ["self-hosted","gh-runner-linux"], "hosted": "ubuntu-latest" }
```

That fails _closed_, which is the point: for a repo that can't start a hosted runner at all, falling back to one is the same failure with an extra step. `hosted` records the runner the fallback replaced so the change can be undone; this action ignores it.

What it deliberately does **not** do is guarantee your machine gets the job. A runner can go offline in the seconds between the probe and the job starting, in which case that job queues like any other self-hosted job. If a job must never run anywhere but your hardware, ask for the labels directly:

```yaml
runs-on: [self-hosted, gh-runner-linux]
```

## Cost

One extra job per workflow run: a few seconds on a GitHub-hosted runner, one API call.

## Where the probe job itself runs

`ubuntu-latest`, by default. It's the one job that has to start before any of the others can be scheduled, so it takes the runner that is always there.

That default has a sharp edge. If GitHub-hosted runners aren't available to the repo at all — hosted minutes exhausted, a spending limit reached, a failed payment — this job can't start, so nothing downstream of it is scheduled either. A repo whose work would all have run for free on your own machine still ends up with a red workflow.

`gh-runner --fix-workflows --self-hosted-probe` writes the probe job differently:

```yaml
gh-runner-check:
  runs-on: ${{ vars.GH_RUNNER_PROBE_RUNS_ON && fromJSON(vars.GH_RUNNER_PROBE_RUNS_ON) || 'ubuntu-latest' }}
```

`gh-runner` sets the `GH_RUNNER_PROBE_RUNS_ON` repository variable to `["self-hosted","gh-runner"]` while a runner is online, re-asserts it on every heartbeat, and deletes it on exit. With one up, the probe job runs on your machine and the workflow needs no hosted runner at all; with none, the variable is gone and the job is back on `ubuntu-latest`.

`vars` is the only context a runner can write to that `runs-on` can read — the probe job can't read its own output, which is the whole reason it exists.

The trade is that a repository variable has no expiry, and the marker refs do. A runner killed hard enough to skip its cleanup — `kill -9`, a laptop losing power — leaves the variable set, and the probe job then queues until a runner is back. Deleting the variable is always safe and puts the next run back on `ubuntu-latest`:

```
gh variable delete GH_RUNNER_PROBE_RUNS_ON
```

Setting the variable needs admin on the repo, the same rights registering a runner already needs. If `gh` can't write it, the session says so once and carries on — the probe job stays hosted.

`--no-hosted-fallback` goes one step further and drops the variable too, because with hosted runners off the table there is nothing left to choose between:

```yaml
gh-runner-check:
  runs-on: [self-hosted, gh-runner]
```

The probe job then queues like any other job, needs no admin rights, and cannot be affected by a stale variable.
