Set this repository up to use gh-runner (https://github.com/singerbj/gh-runner) as a fallback for GitHub Actions.

gh-runner registers a machine as a self-hosted runner. The setup keeps every job on the GitHub-hosted runner it already uses, and moves jobs to a gh-runner machine only while GitHub refuses to start hosted jobs (out of Actions minutes, over a spending limit, a failed payment). gh-runner sets and clears the repository variables that make that switch. The workflows only have to read them.

Do the following, and don't change anything else.

1. Check the repository is private or internal: `gh repo view --json visibility --jq .visibility`. If it's public, stop and tell me why: gh-runner refuses public repos, because anyone who can open a pull request could run code on the runner machine.

2. In every file under `.github/workflows/` ending in `.yml` or `.yaml`, find each job whose `runs-on` names a GitHub-hosted runner, and replace only that value:

   - `ubuntu-latest`, or any `ubuntu-*`, becomes `${{ vars.GH_RUNNER_LINUX || 'ubuntu-latest' }}`
   - `macos-14`, or any `macos-*`, becomes `${{ vars.GH_RUNNER_MAC || 'macos-14' }}`
   - `windows-latest`, or any `windows-*`, becomes `${{ vars.GH_RUNNER_WINDOWS || 'windows-latest' }}`
   - A hosted name that says nothing about an OS (a larger runner the org named), such as `my-big-runner`, becomes `${{ vars.GH_RUNNER || 'my-big-runner' }}`
   - A list, such as `[ubuntu-latest, gpu]`, becomes `${{ vars.GH_RUNNER_LINUX || fromJSON('["ubuntu-latest","gpu"]') }}`

   Keep the job's original runner name, exactly as written, inside the quotes. Pick the variable from the OS the image name starts with (`ubuntu`, `macos` or `windows`), so a macOS job can only ever fall back to a Mac. Use exactly this expression shape: `${{ vars.<VARIABLE> || '<original>' }}`. gh-runner recognises that shape when it audits the workflows.

   Leave these jobs alone, and list each one in your summary with the reason:
   - `runs-on` already contains `self-hosted` or a `gh-runner` label.
   - `runs-on` is already an expression, such as `${{ matrix.os }}`. Say what would be needed to convert it, but don't rewrite it.
   - `runs-on` is a `group:` mapping.
   - Jobs with `uses:` (a reusable workflow) and no `runs-on`.

   Edit only the `runs-on` value. Keep comments, quoting style, indentation and every other line byte-for-byte.

3. List the rewritten jobs that might not work on a gh-runner machine, so I can decide about them. Don't change them. Look for:
   - `container:` or `services:`, or steps that run `docker`. The Docker Compose deployment of gh-runner has no Docker socket, and a laptop may not have Docker running.
   - An architecture in the runner name, such as `ubuntu-24.04-arm` or `macos-13` (Intel). The fallback machine may have a different CPU.
   - Preinstalled tools the job relies on without installing them. GitHub's images come with a lot that a personal machine or a container may lack.

4. Don't create or set the `GH_RUNNER_*` variables, add secrets, or add jobs. gh-runner manages the variables itself. Whenever they're unset, every job runs exactly where it did before this change.

5. Add a short "Self-hosted fallback" section to the README (or CONTRIBUTING.md, if that's where CI is documented). It should say:
   - Jobs run on GitHub-hosted runners, and fall back to a gh-runner machine only when the repository can't start hosted jobs.
   - To serve jobs from a machine for as long as the command runs: `npx @singerbj/gh-runner` (needs `gh auth login` and admin rights on this repo).
   - To keep a Linux runner online permanently: the Docker Compose file attached to every gh-runner release, https://github.com/singerbj/gh-runner/releases/latest/download/docker-compose.yml
   - If a runner machine is killed without cleaning up, jobs can wait for a runner that isn't there. `gh variable delete GH_RUNNER_LINUX` (or `_MAC`, `_WINDOWS`, or plain `GH_RUNNER`) sends them back to GitHub-hosted runners.

6. Validate every workflow file you changed with a YAML parser (for example `npx --yes yaml valid < file`, or `actionlint` if it's installed). Then commit on a new branch, and open a pull request if you can. The pull request description should include a table of every job: file, job id, old `runs-on`, new `runs-on`, or the reason it was skipped. Add the list from step 3 below it.
