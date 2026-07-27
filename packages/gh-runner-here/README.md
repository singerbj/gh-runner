# gh-runner-here

Temporarily register the machine you're sitting at as a GitHub Actions **self-hosted runner** for the repo you're standing in — then let it clean up after itself.

```bash
cd ~/code/my-repo
npx gh-runner-here
```

It registers an ephemeral runner, waits for one job, deregisters, and deletes everything it downloaded. Ctrl+C at any point does the same.

## Why

Some jobs only make sense on your hardware: an Apple silicon build, a GPU test suite, something that needs a VPN, a device on your desk, or a 4-minute cloud job that takes 20 seconds locally. Standing up a permanent self-hosted runner for that is a lot of ceremony. This is the two-word version.

## Install

Nothing to install — `npx gh-runner-here` is the intended usage. If you reach for it often:

```bash
npm install -g gh-runner-here
```

**Requires** [`gh`](https://cli.github.com), authenticated (`gh auth login`), and admin rights on the target repo. macOS and Linux, x64 or arm64.

## Use it

```bash
gh-runner-here                       # detect the repo from cwd, run one job, exit
gh-runner-here --keep                # stay online for many jobs until Ctrl+C
gh-runner-here --labels gpu,cuda-12  # extra labels on top of the host label
gh-runner-here --repo owner/name     # target a repo other than cwd
```

On startup it prints the label to target:

```yaml
jobs:
  build:
    runs-on: [self-hosted, my-macbook-pro]
```

### Options

| Option                   | Description                                                     |
| ------------------------ | --------------------------------------------------------------- |
| `--keep`                 | Stay online for multiple jobs (default: exit after one)         |
| `--labels a,b,c`         | Extra labels in addition to the default host label              |
| `--repo OWNER/NAME`      | Target a specific repo instead of detecting from cwd            |
| `--name NAME`            | Runner name to register (default: `<host>-<pid>`)               |
| `--allow-public`         | Permit registration on a public repo (**dangerous**, see below) |
| `--runner-version X.Y.Z` | Pin the runner version (default: latest release)                |
| `--cache-dir PATH`       | Where to cache runner tarballs                                  |
| `-h, --help`             | Show help                                                       |
| `-v, --version`          | Show version                                                    |

## Safety

**Public repos are refused by default.** On a public repo, anyone can open a pull request, and a workflow that runs on `pull_request` would execute their code on your machine with your user's privileges. `--allow-public` exists as an escape hatch for repos where you trust every contributor who can open a PR — reach for it deliberately.

Everything else is designed to leave nothing behind:

- The runner is **ephemeral** by default — GitHub retires it after one job.
- The working directory is a fresh `mktemp -d`, removed on exit.
- Deregistration runs on normal exit, on error, and on Ctrl+C.
- Your credentials stay in `gh`; this tool never handles a long-lived token.

## Programmatic use

```ts
import { ghRunnerHere, createLogger } from "gh-runner-here";

const summary = await ghRunnerHere(
  { repo: "octocat/hello-world", labels: ["gpu"], keep: false },
  { logger: createLogger(), signal: AbortSignal.timeout(30 * 60_000) },
);

console.log(summary.runnerName, summary.labels);
```

`ghRunnerHere` resolves once the runner has finished and been deregistered. Aborting the signal shuts it down and cleans up.

## How it works

1. Checks `gh` is installed and authenticated.
2. Resolves the repo from cwd (or `--repo`) and refuses public ones.
3. Downloads the matching `actions/runner` release, cached under `${XDG_CACHE_HOME:-~/.cache}/gh-runner-here`.
4. Mints a short-lived registration token via the GitHub API and runs `config.sh --ephemeral`.
5. Runs `run.sh` in the foreground.
6. Mints a removal token, runs `config.sh remove`, and deletes the temp directory.

## License

MIT
