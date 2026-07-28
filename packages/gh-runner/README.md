# gh-runner

Temporarily register the machine you're sitting at as a GitHub Actions **self-hosted runner** for the repo you're standing in — then let it clean up after itself.

```bash
cd ~/code/my-repo
npx @singerbj/gh-runner
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
Update 3 jobs to self-hosted runs-on (gh-runner-linux, gh-runner-mac) and open a pull request? [y/N] y
==> Preparing a workflow fix on gh-runner/target-self-hosted-9f3c1ab7...
    ✓ .github/workflows/ci.yml → build prefers gh-runner-linux, else ubuntu-latest
    ✓ .github/workflows/ci.yml → bundle prefers gh-runner-mac, else macos-14
      no gh-runner-mac runner in this session — start one with: gh-runner mac
    Pull request opened: https://github.com/octocat/thing/pull/42
```

**A repointed job still runs when nobody is home.** It uses your machine while a runner is online and the runner it already had when none is — so merging the PR can't leave CI waiting on hardware nobody started:

```yaml
jobs:
  gh-runner-check:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      runners: "${{ steps.pick.outputs.runners }}"
    steps:
      - uses: singerbj/gh-runner/actions/pick-runner@<sha> # v1.0.3
        id: pick
        with:
          targets: |
            {
              "linux": { "labels": ["self-hosted","gh-runner-linux"], "fallback": "ubuntu-latest" }
            }

  build:
    needs: [gh-runner-check]
    runs-on: ${{ fromJSON(needs.gh-runner-check.outputs.runners).linux || 'ubuntu-latest' }}
```

**Each job keeps the platform it already had.** The image in its current `runs-on` picks the label, so a `macos-14` job asks for `gh-runner-mac` and can only ever land on a Mac — never on whichever machine happens to be free. `ubuntu-*` gets `gh-runner-linux`, `windows-*` gets `gh-runner-windows`, and every variant of those names is understood (`macos-13-xlarge`, `ubuntu-24.04-arm`, `ubuntu-latest-8-cores`). Only a job whose runner name says nothing about an OS — a larger runner you named yourself — falls back to the generic `gh-runner`, which any registered machine answers. The same name is also its fallback, so a macOS job that can't find your Mac goes back to `macos-14` rather than to a Linux box.

If a label has no runner in this session, it says so and tells you which command starts one — but those jobs run on GitHub in the meantime rather than queueing.

### How a workflow knows the runner is up

`runs-on` can't call an API, and the one that lists self-hosted runners needs repo admin — a permission no workflow's `GITHUB_TOKEN` can be granted. So the runner announces itself instead.

While `gh-runner` is up it publishes a ref per label, `refs/gh-runner/online/<label>/<unix-seconds>`, and re-stamps it every two minutes. The `gh-runner-check` job reads those refs with nothing but `contents: read` and the built-in token — **no secret to create, no PAT to rotate, nothing to configure in the repo**. Markers are removed on exit, and one that stops being re-stamped is ignored after seven minutes, so a laptop that closes mid-session sends the next run back to GitHub-hosted instead of stranding it.

The refs live outside `refs/heads` and `refs/tags`, so they never appear as branches or releases. Publishing them needs push access, which you already have; without it the runner still works and simply says the jobs will use their fallback.

The probe [fails open](../../actions/pick-runner). A missing token, an API error, a malformed input, or no runner online all resolve to the fallback runner, and the generated `runs-on` carries its own `|| 'ubuntu-latest'` in case the probe job produces nothing at all.

The rewrite happens in a throwaway [`git worktree`](https://git-scm.com/docs/git-worktree) checked out from your default branch — **your working tree, index, staged changes, and current branch are never touched**, even with work in flight. The worktree and its local branch are removed on every exit path, including failures.

The branch and the worktree directory both carry a random suffix, so a run that was killed before it could clean up can never block the next one. If a fix branch is already on the remote, whatever its suffix, it says so instead of stacking a second pull request on top of it.

Only the bytes it has to are spliced — each `runs-on` value, each job's `needs`, and one insertion above the first job — so comments, formatting, and every other line survive the edit.

Only GitHub-hosted jobs get repointed. A job already asking for `self-hosted` with labels you lack is left alone, because the fix there is on your side (`--labels`), not in the YAML.

- `--fix-workflows` opens the PR without asking (useful when there's no terminal to prompt on).
- `--fix-jobs build,test` limits the rewrite to specific job ids.
- `--fix-label gh-runner-mac` forces one label onto every rewritten job, instead of letting each job keep its own platform. Each job's fallback is still its own.
- `--self-hosted-probe` lets the `gh-runner-check` job run here too — see below.
- `--no-hosted-fallback` leaves no GitHub-hosted runner named anywhere, so jobs queue for a self-hosted one instead of falling back — see below.
- `--no-fix-workflows` never offers.
- `--no-workflow-check` skips the audit entirely.

### When GitHub-hosted runners aren't available at all

The `gh-runner-check` job runs on `ubuntu-latest`. It's the one job that has to start before any of the others can be scheduled, so it takes the runner that is always there.

Except when it isn't. If hosted runners are unavailable to the repo — hosted minutes exhausted, a spending limit reached, a payment that failed — that job can't start, so nothing downstream of it is scheduled either:

```
Pick runners
  The job was not started because recent account payments have failed or your
  spending limit needs to be increased.
```

Self-hosted runners are free and unaffected by any of that, so the work itself would have run fine. `--self-hosted-probe` gets it out of the way:

```bash
npx @singerbj/gh-runner --fix-workflows --self-hosted-probe
```

The probe job is then written as

```yaml
runs-on: ${{ vars.GH_RUNNER_PROBE_RUNS_ON && fromJSON(vars.GH_RUNNER_PROBE_RUNS_ON) || 'ubuntu-latest' }}
```

and `gh-runner` sets the `GH_RUNNER_PROBE_RUNS_ON` repository variable to `["self-hosted","gh-runner"]` while a runner is online, re-asserting it on every heartbeat and deleting it on exit. With a runner up, **nothing in the workflow needs a GitHub-hosted runner**; with none, the variable is gone and the probe is back on `ubuntu-latest`. It also saves the hosted minutes the probe job spends on every run today.

A repository variable is the only thing a runner can set that `runs-on` can read — the probe job can't read its own output, which is the whole reason it exists.

**The trade:** a variable has no expiry, and the marker refs do. A runner killed hard enough to skip its cleanup — `kill -9`, a laptop losing power — leaves the variable set, and the probe job then queues until a runner is back rather than falling back to hosted. That's why this is opt-in. Clearing it by hand is always safe:

```bash
gh variable delete GH_RUNNER_PROBE_RUNS_ON
```

Setting the variable needs admin on the repo, the same rights registering a runner already needs. Without it the session says so once and carries on, and the probe job stays hosted.

Re-running the fix is how you switch a repo between the two: on a repo that's already been fixed, with no job left to repoint, it opens a PR that changes only the probe job's own `runs-on`.

If the branch already exists on the remote, it links the open PR instead of stacking a second one.

### When they're never coming back

`--self-hosted-probe` fixes the probe job. It does not fix the jobs downstream of it, and on a repo that genuinely cannot start a hosted runner, that gap is the whole problem.

Every repointed job is written as

```yaml
runs-on: ${{ fromJSON(needs.gh-runner-check.outputs.runners).linux || 'ubuntu-latest' }}
```

and the probe resolves that key to `ubuntu-latest` whenever no runner is online. The `||` and the probe's own fallback both name a hosted runner, on purpose: the default is to fail _open_, so a merged fix can never leave CI waiting on hardware nobody started.

Under a spending limit, failing open is failing. The fallback can't start either, so every job hits the same error the probe job used to — just later. If hosted runners are unavailable rather than merely unwanted:

```bash
npx @singerbj/gh-runner --fix-workflows --no-hosted-fallback
```

Nothing in the rewritten workflows then names a GitHub-hosted runner. The probe job asks for its labels outright — no variable, no fallback, nothing left to choose between:

```yaml
runs-on: [self-hosted, gh-runner]
```

and every job it feeds falls through to the labels it prefers rather than to a hosted image:

```yaml
runs-on: ${{ fromJSON(needs.gh-runner-check.outputs.runners).linux || fromJSON('["self-hosted","gh-runner-linux"]') }}
```

A job with no runner online now **queues** instead of failing. Queued is the better failure: the run completes as soon as someone starts `gh-runner`, with no re-run needed.

The flag implies `--self-hosted-probe`, because a hosted probe job would fail the workflow before any of those fallbacks could matter.

**The trade:** this fails _closed_. A broken token, an API error, or simply nobody running `gh-runner` leaves CI queued rather than green — jobs wait up to GitHub's 24-hour limit and are then cancelled. That's the right trade only when the hosted alternative doesn't exist; for every other repo, keep the fallback.

Re-running the fix switches a repo either way, including one already fixed the ordinary way — it converts the jobs, not just the probe. The runner each job originally used is kept in the probe's `targets` input under `hosted`, so re-running without the flag restores the fallbacks exactly:

```jsonc
"linux": { "labels": ["self-hosted","gh-runner-linux"], "fallback": ["self-hosted","gh-runner-linux"], "hosted": "ubuntu-latest" }
```

### Options

| Option                   | Description                                                        |
| ------------------------ | ------------------------------------------------------------------ |
| `--once`, `--ephemeral`  | Take one job, then deregister (default: stay online)               |
| `--labels a,b,c`         | Extra labels on top of the `gh-runner` set and the host label      |
| `--repo OWNER/NAME`      | Target a specific repo instead of detecting from cwd               |
| `--name NAME`            | Runner name to register (default: `<host>-<pid>`)                  |
| `--allow-public`         | Register even if the repo isn't confirmed private (**dangerous**)  |
| `--all`                  | Serve every platform this machine can                              |
| `--os a,b`, `--platform` | Platforms to serve (same as positional arguments)                  |
| `--docker-image IMAGE`   | Image for containerised runners (default GitHub's runner image)    |
| `--docker-platform P`    | Container platform, e.g. `linux/amd64`                             |
| `--runner-version X.Y.Z` | Pin the runner version (default: latest release)                   |
| `--cache-dir PATH`       | Where to cache runner tarballs                                     |
| `--no-workflow-check`    | Skip the `runs-on` audit of `.github/workflows`                    |
| `--fix-workflows`        | Open the workflow PR without asking first                          |
| `--no-fix-workflows`     | Never offer to open it                                             |
| `--fix-jobs a,b`         | Limit the fix to these job ids                                     |
| `--fix-label LABEL`      | Force one label on every job the fix PR rewrites                   |
| `--self-hosted-probe`    | Let the fix PR's probe job run here too, not only on a hosted one  |
| `--no-hosted-fallback`   | Name no hosted runner anywhere; jobs queue instead of falling back |
| `-h, --help`             | Show help                                                          |
| `-v, --version`          | Show version                                                       |

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

- The runner lives exactly as long as the command: no daemon, no service, nothing that survives the terminal.
- `--once` registers it as **ephemeral**, so GitHub retires it after a single job.
- Containerised runners isolate the job from your filesystem entirely: no volumes, no Docker socket, nothing mounted.
- A native runner's working directory is a fresh `mktemp -d`, removed on exit; a containerised one writes nothing to the host at all.
- Deregistration runs on normal exit, on error, and on Ctrl+C.
- The workflow fix runs in a disposable worktree and never writes to your checkout.

### Known limits

- **`config.sh --token` puts the registration token in argv.** The native path has no other way to pass it, so on a shared machine another local account can read it for the second or two registration takes. It expires in an hour and only ever grants "register a runner on this repo". The container path doesn't have this problem.
- **A job is only as isolated as the mode you chose.** Native means none.

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

The workflow pieces are exported on their own too: `inspectWorkflows`, `parseRunsOn`, `classifyTarget`, `hostedRunnerOs`, `applyRunsOnFix`, `fixLabelFor`, and `proposeWorkflowFix`.

## How it works

1. Checks `gh` is installed and authenticated.
2. Resolves the repo from cwd (or `--repo`) and refuses any it can't confirm is private.
3. Works out which platforms this machine can serve — probing Docker only if something other than the host OS is in play — then takes them from the arguments, the menu, or the single possible answer.
4. Audits `.github/workflows` for a `runs-on` that matches any of the chosen runners, and offers the PR if none does.
5. Starts one runner per platform, in parallel:
   - **Native** — downloads the matching `actions/runner` release (cached under `${XDG_CACHE_HOME:-~/.cache}/gh-runner`), checks it against the SHA-256 that release publishes, unpacks it into a fresh temp directory, mints a short-lived registration token, and runs `config.sh` then `run.sh`.
   - **Container** — mints the same kind of token and runs GitHub's runner image, passing every value in through the environment. Nothing touches the host disk.
6. Keeps them online, taking jobs, until you stop the command. `--once` adds `--ephemeral` so each retires after a single job instead.
7. Cleans up on every exit path: native runners run `config.sh remove` and lose their temp directory; containers are force-removed and deregistered through the API, since `config.sh` is gone with the container.

## License

MIT
