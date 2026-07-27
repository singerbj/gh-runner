# gh-runner

Temporarily register the machine you're sitting at as a GitHub Actions **self-hosted runner** for the repo you're standing in — then let it clean up after itself.

```bash
cd ~/code/my-repo
npx gh-runner
```

It checks your workflows actually target a self-hosted runner, registers an ephemeral one under the `gh-runner` label, waits for a job, deregisters, and deletes everything it downloaded. Ctrl+C at any point does the same.

## Why

Some jobs only make sense on your hardware: an Apple silicon build, a GPU test suite, something that needs a VPN, a device on your desk, or a 4-minute cloud job that takes 20 seconds locally. Standing up a permanent self-hosted runner for that is a lot of ceremony. This is the one-command version.

## Install

Nothing to install — `npx gh-runner` is the intended usage. If you reach for it often:

```bash
npm install -g gh-runner
```

**Requires** [`gh`](https://cli.github.com), authenticated (`gh auth login`), and admin rights on the target repo. macOS, Linux, and Windows, on x64 or arm64.

## Use it

```bash
gh-runner                       # detect the repo from cwd, run one job, exit
gh-runner --keep                # stay online for many jobs until Ctrl+C
gh-runner --labels gpu,cuda-12  # extra labels on top of the defaults
gh-runner --repo owner/name     # target a repo other than cwd
```

Every runner registers under the same set of labels, so `runs-on` is a stable contract in your YAML no matter whose machine is standing in:

| Label               | Registered on    | Use it when                           |
| ------------------- | ---------------- | ------------------------------------- |
| `gh-runner`         | every machine    | the job doesn't care where it runs    |
| `gh-runner-mac`     | macOS only       | the job needs macOS                   |
| `gh-runner-linux`   | Linux only       | the job needs Linux                   |
| `gh-runner-windows` | Windows only     | the job needs Windows                 |
| `<hostname>`        | that one machine | the job needs _your_ box specifically |

```yaml
jobs:
  any-machine:
    runs-on: [self-hosted, gh-runner]
  mac-only:
    runs-on: [self-hosted, gh-runner-mac]
  linux-only:
    runs-on: [self-hosted, gh-runner-linux]
  windows-only:
    runs-on: [self-hosted, gh-runner-windows]
```

GitHub adds `self-hosted`, `macOS`/`Linux`/`Windows`, and `X64`/`ARM64` on top of those, so you can pin by architecture too.

### One machine, one runner

`gh-runner` registers **the machine it's running on** — nothing more. On an Apple silicon MacBook you get exactly one runner: `self-hosted, macOS, ARM64, gh-runner, gh-runner-mac, <hostname>`. It does not spin up Linux or Windows runners for you; there's no VM or container involved.

To cover several operating systems, run it on several machines — one `npx gh-runner` per box. That's what the per-OS labels are for: with a Mac and a Linux box both online, `[self-hosted, gh-runner]` goes to whichever is free, while `[self-hosted, gh-runner-mac]` only ever goes to the Mac.

The startup audit knows the difference. Run `gh-runner` on your Mac against a repo whose jobs ask for `gh-runner-linux` and it says so plainly:

```
! .github/workflows/ci.yml:12 → build wants gh-runner-linux, which this runner won't have
  that job wants Linux — run gh-runner on a Linux machine
```

rather than suggesting a `--labels` flag that would only lie to GitHub about what this machine is.

## The workflow check

Registering a runner nothing targets is the easiest way to waste ten minutes. On startup, `gh-runner` reads `.github/workflows/*.yml` and tells you which jobs will actually land here:

```
==> Checking .github/workflows for a matching runs-on...
    ✓ .github/workflows/bench.yml → bench will run here
    ! .github/workflows/ci.yml:9 → gpu wants cuda, which this runner won't have
      register it too with: --labels cuda
    ! no job targets this runner; 3 target GitHub-hosted runners
```

The workflows are parsed with a real YAML parser ([`yaml`](https://www.npmjs.com/package/yaml), the package's only dependency), so anchors and aliases resolve the way GitHub sees them, a `runs-on:` inside a `run:` script block is correctly ignored, and a malformed file is reported as malformed instead of silently mis-read. Every shape `runs-on` accepts is understood — a scalar, an inline list, a block sequence, and the `group:`/`labels:` mapping — and it says so rather than guessing when the value is a `${{ }}` expression or a bare runner group.

### Letting it fix them for you

When **no** job targets this runner, it offers to open a pull request:

```
Update 3 jobs to runs-on: [self-hosted, gh-runner] and open a pull request? [y/N] y
==> Preparing a workflow fix on gh-runner/target-self-hosted...
    ✓ .github/workflows/ci.yml → build now targets this runner
    Pull request opened: https://github.com/octocat/thing/pull/42
```

The rewrite happens in a throwaway [`git worktree`](https://git-scm.com/docs/git-worktree) checked out from your default branch — **your working tree, index, staged changes, and current branch are never touched**, even with work in flight. The worktree and its local branch are removed on every exit path, including failures.

Only the bytes of each `runs-on` value are spliced, so comments, formatting, and every other line survive the edit — the diff shows one changed line per job and nothing else.

Only GitHub-hosted jobs get repointed. A job already asking for `self-hosted` with labels you lack is left alone, because the fix there is on your side (`--labels`), not in the YAML.

- `--fix-workflows` opens the PR without asking (useful when there's no terminal to prompt on).
- `--fix-jobs build,test` limits the rewrite to specific job ids.
- `--fix-label gh-runner-mac` writes an OS-pinned label instead of the generic one.
- `--no-fix-workflows` never offers.
- `--no-workflow-check` skips the audit entirely.

If the branch already exists on the remote, it links the open PR instead of stacking a second one.

### Options

| Option                   | Description                                                     |
| ------------------------ | --------------------------------------------------------------- |
| `--keep`                 | Stay online for multiple jobs (default: exit after one)         |
| `--labels a,b,c`         | Extra labels on top of the `gh-runner` set and the host label   |
| `--repo OWNER/NAME`      | Target a specific repo instead of detecting from cwd            |
| `--name NAME`            | Runner name to register (default: `<host>-<pid>`)               |
| `--allow-public`         | Permit registration on a public repo (**dangerous**, see below) |
| `--runner-version X.Y.Z` | Pin the runner version (default: latest release)                |
| `--cache-dir PATH`       | Where to cache runner tarballs                                  |
| `--no-workflow-check`    | Skip the `runs-on` audit of `.github/workflows`                 |
| `--fix-workflows`        | Open the workflow PR without asking first                       |
| `--no-fix-workflows`     | Never offer to open it                                          |
| `--fix-jobs a,b`         | Limit the fix to these job ids                                  |
| `--fix-label LABEL`      | Label the fix PR writes (default `gh-runner`)                   |
| `-h, --help`             | Show help                                                       |
| `-v, --version`          | Show version                                                    |

## Safety

**Public repos are refused by default.** On a public repo, anyone can open a pull request, and a workflow that runs on `pull_request` would execute their code on your machine with your user's privileges. `--allow-public` exists as an escape hatch for repos where you trust every contributor who can open a PR — reach for it deliberately.

Everything else is designed to leave nothing behind:

- The runner is **ephemeral** by default — GitHub retires it after one job.
- The working directory is a fresh `mktemp -d`, removed on exit.
- Deregistration runs on normal exit, on error, and on Ctrl+C.
- The workflow fix runs in a disposable worktree and never writes to your checkout.
- Your credentials stay in `gh`; this tool never handles a long-lived token.
- Commands are spawned without a shell, so tokens and repo names can't be re-read as shell syntax.

## Programmatic use

```ts
import { ghRunner, createLogger } from "gh-runner";

const summary = await ghRunner(
  { repo: "octocat/hello-world", labels: ["gpu"], keep: false },
  { logger: createLogger(), signal: AbortSignal.timeout(30 * 60_000) },
);

console.log(summary.runnerName, summary.labels);
console.log(summary.workflows?.matches); // jobs that will land here
```

`ghRunner` resolves once the runner has finished and been deregistered. Aborting the signal shuts it down and cleans up. It never prompts unless you pass a `confirm` in the context — `createConfirm()` gives you the terminal one.

The workflow pieces are exported on their own too: `inspectWorkflows`, `parseRunsOn`, `classifyTarget`, `applyRunsOnFix`, and `proposeWorkflowFix`.

## How it works

1. Checks `gh` is installed and authenticated.
2. Resolves the repo from cwd (or `--repo`) and refuses public ones.
3. Audits `.github/workflows` for a `runs-on` that matches, and offers the PR if none does.
4. Downloads the matching `actions/runner` release, cached under `${XDG_CACHE_HOME:-~/.cache}/gh-runner`.
5. Mints a short-lived registration token via the GitHub API and runs `config.sh --ephemeral`.
6. Runs `run.sh` in the foreground.
7. Mints a removal token, runs `config.sh remove`, and deletes the temp directory.

## License

MIT
