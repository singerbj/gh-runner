# gh-runner

Temporarily register the machine you're sitting at as a GitHub Actions **self-hosted runner** for the repo you're standing in — then let it clean up after itself.

```bash
cd ~/code/my-repo
npx @singerbj/gh-runner setup   # once: jobs fall back to gh-runner when hosted runners can't start
npx @singerbj/gh-runner         # whenever you want this machine to take jobs
```

It checks your workflows actually target a self-hosted runner, registers one under the `gh-runner` label, and **stays online for as long as the command runs** — taking job after job. Stop it with Ctrl+C and it deregisters and deletes everything it downloaded.

## Why

Some jobs only make sense on your hardware: an Apple silicon build, a GPU test suite, something that needs a VPN, a device on your desk, or a 4-minute cloud job that takes 20 seconds locally. Standing up a permanent self-hosted runner for that is a lot of ceremony. This is the one-command version.

## Install

Nothing to install — `npx @singerbj/gh-runner` is the intended usage. If you reach for it often:

```bash
npm install -g @singerbj/gh-runner
```

Either way the command is `gh-runner` — the scope is only how npm finds the package.

**Requires** [`gh`](https://cli.github.com), authenticated (`gh auth login`), and admin rights on the target repo. macOS, Linux, and Windows, on x64 or arm64.

## Use it

```bash
gh-runner setup                 # open the workflow PR, register nothing (--dry-run to preview)
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

`gh-runner setup` opens that pull request and exits, without registering a runner. It's the one command a new project needs:

```
$ npx @singerbj/gh-runner setup
==> Setting up octocat/thing to fall back to gh-runner...
    ✓ .github/workflows/ci.yml → build stays on ubuntu-latest — gh-runner-linux when out of minutes (GH_RUNNER_LINUX)
    Pull request opened: https://github.com/octocat/thing/pull/42
```

`--dry-run` shows the jobs it would change without pushing anything. It takes `--repo`, `--fix-jobs` and `--fix-label` too, and refuses a repo it can't confirm is private (`--allow-public` overrides), since no gh-runner would ever serve it.

A runner session offers the same pull request itself. When **no** job targets the runner, it asks:

```
Let 2 jobs use gh-runner-linux, gh-runner-mac when GitHub-hosted runners can't start, and open a pull request? [y/N] y
==> Preparing a workflow fix on gh-runner/target-self-hosted-9f3c1ab7...
    ✓ .github/workflows/ci.yml → build stays on ubuntu-latest — gh-runner-linux when out of minutes (GH_RUNNER_LINUX)
    ✓ .github/workflows/ci.yml → bundle stays on macos-14 — gh-runner-mac when out of minutes (GH_RUNNER_MAC)
      no gh-runner-mac runner in this session — start one with: gh-runner mac
    Pull request opened: https://github.com/octocat/thing/pull/42
```

**Every job keeps running on GitHub-hosted runners.** The PR changes one line per job:

```yaml
jobs:
  build:
    runs-on: ${{ vars.GH_RUNNER_LINUX || 'ubuntu-latest' }}
  bundle:
    runs-on: ${{ vars.GH_RUNNER_MAC || 'macos-14' }}
```

With the variable unset — which it is, unless the repo is out of minutes _and_ a `gh-runner` is up — that's exactly the `runs-on` the job had before. Merging the PR changes nothing about where CI runs, and nothing in it needs a self-hosted runner, a secret, or an extra job.

**Your machine only takes over when GitHub-hosted runners can't start** — the repo is out of included minutes, over a spending limit, or a payment failed. While `gh-runner` is running it watches the repo's runs, and when GitHub refuses to start a job for billing reasons (a job that failed on no runner, with no steps, annotated _"The job was not started because recent account payments have failed or your spending limit needs to be increased"_) it:

1. sets `GH_RUNNER_LINUX=gh-runner-linux` — one variable per label it serves — so every job from then on resolves to this machine, and
2. re-runs the refused runs from the last 24 hours, which now land here instead. Never a run from a fork: re-running someone else's code on your machine stays a decision for a person.

It reads GitHub's own verdict rather than doing arithmetic on billing data, so included minutes, budgets, spending limits and failed payments are all handled the same way, and it needs no billing scope.

**It hands everything back** — deletes the variables — when:

- a GitHub-hosted job succeeds again (a raised spending limit shows up in whichever workflows weren't rewritten),
- a new month starts and the included minutes reset. If hosted runners are still unavailable — a spending limit rather than a quota — the first job of the month is refused, and the variables go straight back up with that run re-run,
- **the session ends.** The variables mean "a gh-runner is here _and_ GitHub-hosted runners aren't", so they never outlive the machine that set them.

What to expect:

| Minutes left? | `gh-runner` running? | Jobs run on                                                                   |
| ------------- | -------------------- | ----------------------------------------------------------------------------- |
| yes           | either way           | GitHub-hosted, exactly as before                                              |
| no            | yes                  | your machine — after at most one refused run, which is re-run here            |
| no            | no                   | nowhere; GitHub refuses them. Start `gh-runner` and it re-runs the last day's |

A session only sets variables for labels it serves, so a Linux box never pulls macOS jobs into a queue nothing will answer. Two machines serving the same label share its variable: the one that leaves takes it down, and the one still running puts it back on its next check, two minutes later. An API error changes nothing, in either direction.

The one way a variable outlives its session is a kill too hard to clean up — `kill -9`, a power cut. Jobs for that label then wait for a runner instead of going to GitHub. The next `gh-runner` to start clears it on its first check; deleting it by hand is always safe too:

```bash
gh variable delete GH_RUNNER_LINUX
```

Setting a variable needs admin on the repo, the same rights registering a runner needs. Once the PR is merged a plain `npx @singerbj/gh-runner` is all it takes.

**Each job keeps the platform it already had.** The image in its current `runs-on` picks the label, so a `macos-14` job moves to `gh-runner-mac` and can only ever land on a Mac. `ubuntu-*` gets `gh-runner-linux`, `windows-*` gets `gh-runner-windows`, and every variant of those names is understood (`macos-13-xlarge`, `ubuntu-24.04-arm`, `ubuntu-latest-8-cores`). Only a job whose runner name says nothing about an OS — a larger runner you named yourself — gets the generic `gh-runner` (variable `GH_RUNNER`), which any registered machine answers.

[`.github/workflows/fallback-simulation.yml`](../../.github/workflows/fallback-simulation.yml) runs the whole cycle on every change against a mocked GitHub, and has GitHub's own expression engine resolve the `runs-on` above in both states.

#### Why there's no job deciding this

Earlier versions added a `gh-runner-check` job that chose each job's runner. Any job like that needs a runner of its own before anything else can be scheduled, and "GitHub won't start a hosted runner here" is precisely when it can't have one — the whole workflow fails with a runner sitting idle. `runs-on` can read repository variables before any runner is involved, so the decision is made outside Actions, by the machine about to take the work.

Re-running the fix on a repo an older version fixed converts it: every job gets its variable, with the labels and hosted runner the old probe recorded, and the `gh-runner-check` job is removed. (A job that reads the probe's output somewhere the fix didn't write keeps it, and keeps working.) The old `--self-hosted-probe`, `--no-hosted-fallback` and `--hosted-first` flags are accepted and ignored.

### Rewriting it yourself

The rewrite happens in a throwaway [`git worktree`](https://git-scm.com/docs/git-worktree) checked out from your default branch — **your working tree, index, staged changes, and current branch are never touched**, even with work in flight. The worktree and its local branch are removed on every exit path, including failures.

The branch and the worktree directory both carry a random suffix, so a run that was killed before it could clean up can never block the next one. If a fix branch is already on the remote, whatever its suffix, it says so instead of stacking a second pull request on top of it.

Only the bytes it has to are spliced — each `runs-on` value — so comments, formatting, and every other line survive the edit.

Only GitHub-hosted jobs get repointed. A job already asking for `self-hosted` with labels you lack is left alone, because the fix there is on your side (`--labels`), not in the YAML.

- `--fix-workflows` opens the PR without asking (useful when there's no terminal to prompt on).
- `--fix-jobs build,test` limits the rewrite to specific job ids.
- `--fix-label gh-runner-mac` forces one label onto every rewritten job, instead of letting each job keep its own platform. Each job's hosted runner is still its own.
- `--no-fix-workflows` never offers.
- `--no-workflow-check` skips the audit entirely.

### Options

| Option                   | Description                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| `--once`, `--ephemeral`  | Take one job, then deregister (default: stay online)              |
| `--labels a,b,c`         | Extra labels on top of the `gh-runner` set and the host label     |
| `--repo OWNER/NAME`      | Target a specific repo instead of detecting from cwd              |
| `--name NAME`            | Runner name to register (default: `<host>-<pid>`)                 |
| `--allow-public`         | Register even if the repo isn't confirmed private (**dangerous**) |
| `--all`                  | Serve every platform this machine can                             |
| `--os a,b`, `--platform` | Platforms to serve (same as positional arguments)                 |
| `--docker-image IMAGE`   | Image for containerised runners (default GitHub's runner image)   |
| `--docker-platform P`    | Container platform, e.g. `linux/amd64`                            |
| `--runner-version X.Y.Z` | Pin the runner version (default: latest release)                  |
| `--cache-dir PATH`       | Where to cache runner tarballs                                    |
| `--no-workflow-check`    | Skip the `runs-on` audit of `.github/workflows`                   |
| `--fix-workflows`        | Open the workflow PR without asking first                         |
| `--no-fix-workflows`     | Never offer to open it                                            |
| `--fix-jobs a,b`         | Limit the fix to these job ids                                    |
| `--fix-label LABEL`      | Force one label on every job the fix PR rewrites                  |
| `--dry-run`              | `setup` only: list the changes, push nothing                      |
| `-h, --help`             | Show help                                                         |
| `-v, --version`          | Show version                                                      |

## Keeping a runner online with Docker

`gh-runner` normally lives as long as the terminal it runs in. For a machine that should always be ready to take jobs (a home lab box, a VPS, a [Coolify](https://coolify.io) server), every release publishes an image, `ghcr.io/singerbj/gh-runner`, for `linux/amd64` and `linux/arm64`. `gh-runner` is the container's main process, so the runner is online whenever the container is up, comes back with it after a crash or reboot, and deregisters itself when the container stops.

The whole setup is two variables:

```bash
docker run -d --name gh-runner --restart unless-stopped --stop-timeout 60 \
  -e GH_TOKEN=github_pat_… -e GH_RUNNER_REPO=you/your-repo \
  -v gh-runner:/home/node \
  ghcr.io/singerbj/gh-runner
```

Or with Docker Compose, using the file every release attaches (it pins that release's image, so this URL is always the newest):

```bash
curl -fsSLO https://github.com/singerbj/gh-runner/releases/latest/download/docker-compose.yml
printf 'GH_TOKEN=%s\nGH_RUNNER_REPO=%s\n' "github_pat_…" "you/your-repo" > .env
docker compose up -d
docker compose logs -f      # wait for "Runner is live"
```

On **Coolify**: add a **Docker Compose Empty** resource, paste [`deploy/docker-compose.yml`](deploy/docker-compose.yml), set `GH_TOKEN` and `GH_RUNNER_REPO` under **Environment Variables**, and deploy. It needs no domain or port.

| Variable           | Required | What it is                                                                                               |
| ------------------ | -------- | -------------------------------------------------------------------------------------------------------- |
| `GH_TOKEN`         | yes      | A fine-grained token for the one repo, with **Administration**, **Actions** and **Variables** read/write |
| `GH_RUNNER_REPO`   | yes      | `owner/name`. Must be private                                                                            |
| `GH_RUNNER_NAME`   | no       | Runner name (default: the container's hostname)                                                          |
| `GH_RUNNER_LABELS` | no       | Extra labels, comma-separated                                                                            |

Anything passed as the container's command is added to `gh-runner`'s arguments, e.g. `command: ["--runner-version", "2.334.0"]`.

The image is `node:lts` plus `gh`, `tini` and `gh-runner`, running `gh-runner linux --repo … --no-fix-workflows` as the unprivileged `node` user. Its [`Dockerfile`](deploy/Dockerfile) and [`entrypoint.sh`](deploy/entrypoint.sh) are next to the compose file. Things to know:

- **Linux only.** It's a Linux container, so it serves `gh-runner-linux` (and `gh-runner`).
- **No Docker socket, no host mounts.** Jobs can't reach anything else on the server, but `docker build`, `services:` and `container:` jobs won't run there either.
- **Every job can read `GH_TOKEN`.** The runner passes its environment on to the jobs it runs. Scope the token to the one repo, and only use this on a repo where you trust everyone who can push.
- **The workflows need the fallback `runs-on` first.** Run `npx @singerbj/gh-runner setup` in the repo once.
- **Stopping it cleans up.** `docker stop` (or a Coolify stop) sends SIGTERM, and `gh-runner` deregisters the runner and deletes any variables it set within the 60-second grace period.

## Setting a repo up with an AI agent

[`prompts/setup-repo.md`](prompts/setup-repo.md) is a prompt for Claude Code, Copilot, Cursor or any other coding agent working in your repo. It has the agent:

- run `npx @singerbj/gh-runner setup`, or make the same `runs-on` edit by hand when `gh` isn't available there,
- list the jobs that may not work on a gh-runner machine (Docker, services, a particular CPU),
- add a short "Self-hosted fallback" section to your README, and
- finish with a PR that has a table of every job it changed or skipped.

Every release attaches it as `gh-runner-setup-prompt.md`, and the [landing page](https://singerbj.github.io/gh-runner/#ai-setup) has a copy button. The test suite checks each hand-edit example in the prompt against the expression `gh-runner` itself writes, so the two can't drift apart.

## Safety

**A native runner executes CI jobs as you.** Not sandboxed, not a separate account: whoever can cause a job to run on the `gh-runner` label gets your shell, your home directory, your SSH keys, and your `gh` login for as long as the command is up. Everything below follows from that.

**Repos that aren't confirmed private are refused.** On a public repo anyone can open a pull request, and a workflow that runs on `pull_request` would run their code here. If `gh` can't tell us the visibility at all — logged out, rate-limited, offline — that is treated the same way, because an unanswered question is not a "no". `--allow-public` overrides both, and is for repos where you trust every contributor who can open a PR. Reach for it deliberately.

**Private is not the same as safe.** Every collaborator who can push a branch or open a PR on a private repo can also run code on your machine while a runner is up. The blast radius is your whole user account, so match the runner to how much you'd trust each of those people at your keyboard. `--docker`-backed Linux runners are the way to keep a job off your filesystem.

The runner itself is checked before it is trusted:

- The `actions/runner` tarball is verified against the SHA-256 GitHub publishes for that release, **before** it is unpacked — on a cache hit as much as on a fresh download, since the cache directory is an ordinary writable path. A mismatch stops the run; a release with no published checksum warns rather than pretending.
- The registration token is passed to Docker through the environment, never on the command line, where `ps` and `/proc/<pid>/cmdline` would show it to every other account on the machine.
- Commands are spawned without a shell, so tokens and repo names can't be re-read as shell syntax.
- Your credentials stay in `gh`; this tool never handles a long-lived token.

And nothing is left behind:

- The runner lives exactly as long as the command: no daemon, no service, nothing that survives the terminal. (The [Docker image](#keeping-a-runner-online-with-docker) keeps the command running on purpose. Stopping the container is its Ctrl+C.)
- `--once` registers it as **ephemeral**, so GitHub retires it after a single job.
- Containerised runners isolate the job from your filesystem entirely: no volumes, no Docker socket, nothing mounted.
- A native runner's working directory is a fresh `mktemp -d`, removed on exit; a containerised one writes nothing to the host at all.
- Deregistration runs on normal exit, on error, and on Ctrl+C.
- The workflow fix runs in a disposable worktree and never writes to your checkout.

### Known limits

- **`config.sh --token` puts the registration token in argv.** The native path has no other way to pass it, so on a shared machine another local account can read it for the second or two registration takes. It expires in an hour and only ever grants "register a runner on this repo". The container path doesn't have this problem.
- **A job is only as isolated as the mode you chose.** Native means none.
- **With `GH_TOKEN` in the environment, jobs can read it.** The runner hands its environment to every job, so a token used to log `gh` in that way (as the Docker image does) is readable by any workflow that runs here. Scope it to the one repo.

## Programmatic use

```ts
import { ghRunner, createLogger } from "@singerbj/gh-runner";

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

The workflow pieces are exported on their own too: `inspectWorkflows`, `parseRunsOn`, `classifyTarget`, `hostedRunnerOs`, `applyWorkflowFix`, `fixLabelFor`, and `proposeWorkflowFix` — plus `HostedUsageWatcher`, which is what moves jobs here when the repo is out of minutes.

## How it works

1. Checks `gh` is installed and authenticated.
2. Resolves the repo from cwd (or `--repo`) and refuses any it can't confirm is private.
3. Works out which platforms this machine can serve — probing Docker only if something other than the host OS is in play — then takes them from the arguments, the menu, or the single possible answer.
4. Audits `.github/workflows` for a `runs-on` that matches any of the chosen runners, and offers the PR if none does.
5. Starts one runner per platform, in parallel:
   - **Native** — downloads the matching `actions/runner` release (cached under `${XDG_CACHE_HOME:-~/.cache}/gh-runner`), checks it against the SHA-256 that release publishes, unpacks it into a fresh temp directory, mints a short-lived registration token, and runs `config.sh` then `run.sh`.
   - **Container** — mints the same kind of token and runs GitHub's runner image, passing every value in through the environment. Nothing touches the host disk.
6. Keeps them online, taking jobs, until you stop the command. `--once` adds `--ephemeral` so each retires after a single job instead.
   While they're up it watches for GitHub refusing hosted jobs, and moves the fixed jobs here — and back — as described above.
7. Cleans up on every exit path: any runner variables it set are deleted; native runners run `config.sh remove` and lose their temp directory; containers are force-removed and deregistered through the API, since `config.sh` is gone with the container.

## License

MIT
