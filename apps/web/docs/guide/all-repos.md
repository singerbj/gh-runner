# Every repo at once

One command serves every repo of yours that uses gh-runner:

```sh
npx @singerbj/gh-runner --all-repos
```

It lists the repos you own, reads each one's workflows on its default branch, and registers a runner for every **private** repo with a job that targets gh-runner — `runs-on: [self-hosted, gh-runner…]`, or the `vars.GH_RUNNER_*` [fallback](./fallback) that [setup](./setup) writes. Repos with only GitHub-hosted jobs, a bare `[self-hosted]` (your own runners), or labels this machine can't serve are left alone.

It rescans every 10 minutes, so a repo you run `gh-runner setup` in later is picked up without a restart, and one whose workflows stop targeting gh-runner has its runner taken down. A repo nothing was pushed to isn't read again.

```sh
gh-runner --all-repos mac linux        # pick platforms as usual; asked once, not per repo
gh-runner --owner my-org               # an organisation's repos (implies --all-repos)
gh-runner --owner me,my-org            # several owners
gh-runner --repos me/api,me/web        # exactly these, no scan
```

Output from each repo's runner is prefixed with `[owner/name]`. Ctrl+C deregisters all of them.

## Several machines

Start it on as many machines as you like — a laptop, a home server, a [Docker](./docker) container on a VPS. They share the work without talking to each other: each registers its own runner in every repo, with the same labels, and GitHub hands each queued job to whichever matching runner is idle. Turn one off and the others keep taking jobs; turn it back on and it rejoins.

The [out-of-minutes fallback](./fallback) works the same way. Any machine that sees GitHub refusing hosted jobs sets the repo's `GH_RUNNER_*` variable, and a machine shutting down leaves the variable set while another runner with that label is still online, so jobs don't bounce back to hosted runners that can't start them.

## Things to know

- **One runner per repo per platform.** Personal GitHub accounts can't register account-wide runners, so each repo gets its own. Each idle runner is a small background process; a machine serving ten repos runs ten, and can take up to ten jobs at once.
- **Public repos are skipped** — any fork could run code on your machine. `--allow-public` includes them.
- **It never opens pull requests.** Run [`gh-runner setup`](./setup) inside a repo to point its workflows at gh-runner; the next scan finds it.
- **A repo that fails** (no admin rights, say) is retried with a growing back-off, without affecting the others.
- **Your token needs to read workflows.** With `gh auth login` that's already true. A fine-grained token also needs **Contents: read** — see [Docker](./docker#creating-the-token).
