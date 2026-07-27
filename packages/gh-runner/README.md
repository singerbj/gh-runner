# gh-runner

Temporarily register the machine you're sitting at as a GitHub Actions **self-hosted runner** for the repo you're standing in — then let it clean up after itself.

```bash
cd ~/code/my-repo
npx gh-runner
```

It checks your workflows actually target a self-hosted runner, registers one under the `gh-runner` label, and **stays online for as long as the command runs** — taking job after job. Stop it with Ctrl+C and it deregisters and deletes everything it downloaded.

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
gh-runner                       # pick platforms from a menu, stay online until Ctrl+C
gh-runner linux                 # or just name them
gh-runner mac linux             # one runner each, in parallel
gh-runner --all                 # every platform this machine can serve
gh-runner --once                # take a single job, then deregister and exit
gh-runner --labels gpu,cuda-12  # extra labels on top of the defaults
gh-runner --repo owner/name     # target a repo other than cwd
```

## Choosing platforms

With no platform named and a terminal to draw on, it asks:

```
? Which platforms should this machine serve?
  ↑↓ move · space toggle · a all · enter confirm · ctrl-c cancel
❯ ◉ macOS    native — this machine
  ◯ Linux    in a container, via Docker
  ✗ Windows  needs a Windows machine — Windows containers only run on Windows
```

Your own OS is pre-ticked, so the common case is one keypress. Anything this machine can't be is shown with the reason and can't be selected.

When there's only one possible answer — a Linux box, or a Mac without Docker running — it doesn't ask at all. It says what it's serving and why the rest are out, then gets on with it:

```
==> Linux is the only platform this machine can serve.
    ✗ macOS    needs a macOS machine — macOS can't be containerised
    ✗ Windows  needs a Windows machine — Windows containers only run on Windows
```

To skip the menu, name the platforms — as bare words or with `--os`:

```bash
gh-runner mac              # mac | macos | darwin | osx
gh-runner linux            # linux | ubuntu
gh-runner windows          # windows | win
gh-runner mac linux        # several
gh-runner --os mac,linux   # same thing
gh-runner --all            # everything possible here, no menu, no error
```

**Asking for a platform this machine can't be is an error**, not a warning:

```
$ gh-runner windows        # on a Mac
error: this machine can't run that runner
       Windows: needs a Windows machine — Windows containers only run on Windows
```

`--all` never errors — it takes what's possible and ignores the rest. With no terminal to prompt on and no platform named (a script, a cron job), it serves this machine's own OS.

Several platforms means several runners, registered and running in parallel, each with its own labels and its own cleanup. Their output is prefixed so you can tell them apart:

```
[macOS] ==> Runner is live. Waiting for a job...
[Linux] ==> Starting ghcr.io/actions/actions-runner:latest...
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

### Where Linux comes from

Asking for `linux` on a Mac or a Windows box runs the runner in a Docker container. It registers exactly the same labels a native Linux machine would (`gh-runner`, `gh-runner-linux`, `Linux`, `X64`/`ARM64`), so from GitHub's side it _is_ a Linux runner. Nothing is downloaded or unpacked on the host — GitHub's runner image already contains the runner.

```bash
gh-runner linux                                  # a container on a Mac, native on Linux
gh-runner linux --docker-platform linux/amd64    # x64 under emulation on Apple silicon
gh-runner linux --docker-image my/runner:1       # your own image
```

On a Linux host `linux` runs natively; passing `--docker-image` or `--docker-platform` puts it in a container instead, which is also how you sandbox a job away from your own filesystem.

What that buys you, honestly:

| Your machine | `gh-runner` (its own OS) | `gh-runner linux`             | Can never provide |
| ------------ | ------------------------ | ----------------------------- | ----------------- |
| macOS        | `gh-runner-mac`          | `gh-runner-linux` (container) | Windows           |
| Linux        | `gh-runner-linux`        | native, or sandboxed          | macOS, Windows    |
| Windows      | `gh-runner-windows`      | `gh-runner-linux` (container) | macOS             |

**Docker gets you Linux from anywhere. It cannot get you macOS or Windows** — which is why asking for those on the wrong machine is an error rather than a silent fallback.

- **macOS containers don't exist.** There is no macOS container runtime — the kernel has no equivalent of namespaces for this, and Apple's licence only permits macOS _virtual machines_, on Apple hardware. Only a real Mac can serve `gh-runner-mac`. (Apple's own `container` tool on macOS 15+ runs _Linux_ containers, not macOS ones.)
- **Windows containers only run on Windows hosts.** Containers share the host kernel, so a Linux or macOS box can't run them at any price. Even on Windows they're multi-gigabyte and there's no supported runner image, so `gh-runner-windows` means a real Windows machine.

Full three-OS coverage is therefore a Mac and a Windows box — with Docker covering Linux from either, so you don't need a third machine.

Two things to know about container mode:

- **No host mounts, no Docker socket.** The job can't see your filesystem, which is the main reason to use it — but it also means jobs that run `docker build` won't work, since mounting the socket would hand the container root on your machine. Run those natively.
- **The first run pulls a ~1 GB image.** After that it's cached by Docker.

### One machine, one OS (plus Linux)

`gh-runner` serves platforms **this machine can actually be**. On an Apple silicon MacBook that's macOS natively and Linux in a container — never Windows. To cover Windows you need a Windows machine; that's a hardware fact, not a missing feature.

The per-OS labels are what make several machines interchangeable: with a Mac and a Windows box both online, `[self-hosted, gh-runner]` goes to whichever is free, while `[self-hosted, gh-runner-mac]` only ever goes to the Mac.

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
| `--once`, `--ephemeral`  | Take one job, then deregister (default: stay online)            |
| `--labels a,b,c`         | Extra labels on top of the `gh-runner` set and the host label   |
| `--repo OWNER/NAME`      | Target a specific repo instead of detecting from cwd            |
| `--name NAME`            | Runner name to register (default: `<host>-<pid>`)               |
| `--allow-public`         | Permit registration on a public repo (**dangerous**, see below) |
| `--all`                  | Serve every platform this machine can                           |
| `--os a,b`, `--platform` | Platforms to serve (same as positional arguments)               |
| `--docker-image IMAGE`   | Image for containerised runners (default GitHub's runner image) |
| `--docker-platform P`    | Container platform, e.g. `linux/amd64`                          |
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

- The runner lives exactly as long as the command: no daemon, no service, nothing that survives the terminal.
- `--once` registers it as **ephemeral**, so GitHub retires it after a single job.
- Containerised runners isolate the job from your filesystem entirely: no volumes, no Docker socket, nothing mounted.
- A native runner's working directory is a fresh `mktemp -d`, removed on exit; a containerised one writes nothing to the host at all.
- Deregistration runs on normal exit, on error, and on Ctrl+C.
- The workflow fix runs in a disposable worktree and never writes to your checkout.
- Your credentials stay in `gh`; this tool never handles a long-lived token.
- Commands are spawned without a shell, so tokens and repo names can't be re-read as shell syntax.

## Programmatic use

```ts
import { ghRunner, createLogger } from "gh-runner";

const { runners, workflows } = await ghRunner(
  { repo: "octocat/hello-world", platforms: ["mac", "linux"], labels: ["gpu"] },
  { logger: createLogger(), signal: AbortSignal.timeout(30 * 60_000) },
);

for (const runner of runners) {
  console.log(runner.runnerName, runner.mode, runner.labels);
}
console.log(workflows?.matches); // jobs that will land here
```

`ghRunner` resolves once every runner has finished and been deregistered. Aborting the signal shuts them down and cleans up. It never prompts unless you pass `confirm` / `selectPlatforms` in the context — `createConfirm()` and `terminalPlatformPicker` are the terminal implementations.

The workflow pieces are exported on their own too: `inspectWorkflows`, `parseRunsOn`, `classifyTarget`, `applyRunsOnFix`, and `proposeWorkflowFix`.

## How it works

1. Checks `gh` is installed and authenticated.
2. Resolves the repo from cwd (or `--repo`) and refuses public ones.
3. Works out which platforms this machine can serve — probing Docker only if something other than the host OS is in play — then takes them from the arguments, the menu, or the single possible answer.
4. Audits `.github/workflows` for a `runs-on` that matches any of the chosen runners, and offers the PR if none does.
5. Starts one runner per platform, in parallel:
   - **Native** — downloads the matching `actions/runner` release (cached under `${XDG_CACHE_HOME:-~/.cache}/gh-runner`), unpacks it into a fresh temp directory, mints a short-lived registration token, and runs `config.sh` then `run.sh`.
   - **Container** — mints the same kind of token and runs GitHub's runner image, passing every value in through the environment. Nothing touches the host disk.
6. Keeps them online, taking jobs, until you stop the command. `--once` adds `--ephemeral` so each retires after a single job instead.
7. Cleans up on every exit path: native runners run `config.sh remove` and lose their temp directory; containers are force-removed and deregistered through the API, since `config.sh` is gone with the container.

## License

MIT
