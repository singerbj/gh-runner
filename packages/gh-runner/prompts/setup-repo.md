Set this repository up to fall back to gh-runner (https://github.com/singerbj/gh-runner) when GitHub-hosted Actions runners can't start.

Every job stays on the GitHub-hosted runner it already uses. gh-runner moves jobs to a self-hosted machine only while GitHub refuses to start hosted jobs (out of minutes, a spending limit, a failed payment), by setting repository variables that the workflows read.

1. Run `npx @singerbj/gh-runner setup` in the repository. It checks the repo is private, rewrites each GitHub-hosted `runs-on`, and opens a pull request. It registers no runner. If it says the repo is public, stop and tell me: gh-runner refuses public repos. If it can't run because `gh` isn't installed or logged in, make the same edit by hand, as described at the end, and commit it on a new branch.

2. Review the change, and list for me any rewritten job that might not work on a gh-runner machine. Don't change them. Look for:
   - `container:`, `services:`, or steps that run `docker`. The Docker deployment of gh-runner has no Docker socket.
   - An architecture in the runner name, such as `ubuntu-24.04-arm` or an Intel `macos-13`. The fallback machine may have a different CPU.
   - Tools the job uses without installing them. GitHub's images come with far more than a personal machine or a container.

3. Add a short "Self-hosted fallback" section to the README (or CONTRIBUTING.md, if CI is documented there), pushed to the same pull request branch. It should say:
   - Jobs run on GitHub-hosted runners, and fall back to a gh-runner machine only when the repository can't start hosted jobs.
   - `npx @singerbj/gh-runner` serves jobs from a machine for as long as it runs (needs `gh auth login` and admin rights on the repo).
   - https://github.com/singerbj/gh-runner/releases/latest/download/docker-compose.yml keeps a Linux runner online permanently.
   - If a runner machine dies without cleaning up, jobs can wait for a runner that isn't there. `gh variable delete GH_RUNNER_LINUX` (or `_MAC`, `_WINDOWS`, or plain `GH_RUNNER`) sends them back to GitHub-hosted runners.

4. Don't set the `GH_RUNNER_*` variables, add secrets or add jobs. gh-runner manages the variables itself.

Only if `gh-runner setup` couldn't run: in each `.github/workflows/*.yml` or `*.yaml` file, replace the `runs-on` value of every job on a GitHub-hosted runner, keeping the original runner name exactly as written:

- `ubuntu-latest` (any `ubuntu-*`) becomes `${{ vars.GH_RUNNER_LINUX || 'ubuntu-latest' }}`
- `macos-14` (any `macos-*`) becomes `${{ vars.GH_RUNNER_MAC || 'macos-14' }}`
- `windows-latest` (any `windows-*`) becomes `${{ vars.GH_RUNNER_WINDOWS || 'windows-latest' }}`
- a name with no OS in it, such as `my-big-runner`, becomes `${{ vars.GH_RUNNER || 'my-big-runner' }}`
- a list, such as `[ubuntu-latest, gpu]`, becomes `${{ vars.GH_RUNNER_LINUX || fromJSON('["ubuntu-latest","gpu"]') }}`

Leave jobs alone whose `runs-on` is already self-hosted, an expression such as `${{ matrix.os }}`, or a `group:`. Change nothing but those values. Then check each changed file still parses with `npx --yes yaml valid < file`.

Finish with a pull request whose description has a table of every job (file, job, old `runs-on`, new `runs-on` or why it was skipped), followed by the list from step 2.
