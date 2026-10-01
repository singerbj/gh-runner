# Getting started

`gh-runner` registers the machine you're on as a self-hosted GitHub Actions runner for the repo you're in. It takes jobs while the command runs, then deregisters and cleans up.

## Requirements

- [`gh`](https://cli.github.com), logged in with `gh auth login`
- Admin rights on the target repo
- A **private** repo ([why](/reference/security))
- macOS, Linux or Windows, on x64 or arm64

## Run it

No install needed:

```sh
cd ~/code/my-repo
npx @singerbj/gh-runner@latest
```

Or install it globally and use `gh-runner`:

```sh
npm install -g @singerbj/gh-runner
```

Pick platforms from the menu, and the runner goes live:

```txt
? Which platforms should this machine serve?
❯ ◉ macOS    native
  ◉ Linux    in a container, via Docker
  ✗ Windows  needs a Windows machine

==> Runner is live. Waiting for a job...
```

Press **Ctrl+C** to stop. The runner is deregistered and its files are deleted.

## Target it from a workflow

```yaml
jobs:
  build:
    runs-on: [self-hosted, gh-runner]
    steps:
      - uses: actions/checkout@v5
      - run: npm ci && npm test
```

See [Platforms & labels](./platforms) to pin a job to one OS.

## Common commands

```sh
gh-runner setup                 # open a PR so jobs can fall back to gh-runner
gh-runner                       # pick platforms from a menu
gh-runner mac linux             # one runner each, in parallel
gh-runner --all                 # every platform this machine can serve
gh-runner --once                # take one job, then exit
gh-runner --labels gpu          # add extra labels
gh-runner --repo owner/name     # target a repo other than cwd
```

All flags are in the [CLI reference](/reference/cli).

## Next steps

- [Set up a repo](./setup) so jobs fall back to your machine when GitHub runs out of minutes.
- [Run it with Docker](./docker) to keep a runner online permanently.
