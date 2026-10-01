# Out-of-minutes fallback

After [setup](./setup), your jobs stay on GitHub-hosted runners. They move to your machine only when GitHub refuses to start them: out of minutes, over a spending limit, or a failed payment.

## How it works

While `gh-runner` is running, it watches the repo's runs. When GitHub refuses a job for billing reasons, it:

1. Sets `GH_RUNNER_LINUX=gh-runner-linux` (one variable per label it serves), so new jobs resolve to this machine.
2. Re-runs refused runs from the last 24 hours. Runs from forks are never re-run.

It deletes the variables again when:

- a GitHub-hosted job succeeds again,
- a new month starts and the included minutes reset, or
- the `gh-runner` session ends.

## What to expect

| Minutes left? | `gh-runner` running? | Jobs run on                            |
| ------------- | -------------------- | -------------------------------------- |
| yes           | either               | GitHub-hosted, as before               |
| no            | yes                  | your machine, after at most one re-run |
| no            | no                   | nowhere until you start `gh-runner`    |

## Recovering from a hard kill

If `gh-runner` is killed without cleaning up (`kill -9`, power loss), the variable stays set and jobs wait for a runner. The next `gh-runner` clears it on startup, or delete it yourself:

```sh
gh variable delete GH_RUNNER_LINUX
```

## Notes

- A session only sets variables for labels it serves. A Linux machine never pulls in macOS jobs.
- It reads GitHub's own "job not started" verdict, so it needs no billing permissions.
- Setting variables needs repo admin, the same as registering a runner.
- The [fallback simulation](https://github.com/singerbj/gh-runner/blob/main/.github/workflows/fallback-simulation.yml) tests this cycle on every change.
