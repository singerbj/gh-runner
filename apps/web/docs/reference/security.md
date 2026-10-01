# Security

::: danger A native runner runs jobs as you
Anyone who can trigger a job on the `gh-runner` label gets your shell, home directory, SSH keys and `gh` login while the runner is up.
:::

## Guarantees

- **Public repos are refused.** Anyone can open a PR on a public repo. If visibility can't be confirmed, it's refused too. `--allow-public` overrides this.
- **The runner is verified.** The `actions/runner` download is checked against GitHub's published SHA-256 before it's unpacked, including from cache.
- **No long-lived tokens.** Everything goes through `gh`. Registration tokens are minted per run and expire within the hour.
- **Jobs don't inherit tokens.** `GH_TOKEN`, `GITHUB_TOKEN` and the enterprise variants are removed from the runner's environment.
- **No shell.** Commands are spawned without a shell, so input can't be re-read as shell syntax.
- **Cleanup on every exit.** Normal exit, error and Ctrl+C all deregister the runner and delete its files.

## Limits

- **Private isn't the same as trusted.** Every collaborator who can push can run code on your machine.
- **Native runners aren't sandboxed.** Use `gh-runner linux` with Docker to keep jobs off your filesystem.
- **The native registration token is briefly in argv.** Other local accounts could read it for a second or two. It only grants "register a runner on this repo".
- **Same-user jobs can find tokens.** A job can read `GH_TOKEN` from `/proc` in the Docker image, or your `gh` login on a native runner. Scope tokens to one repo.

## Reporting a vulnerability

Report privately through [GitHub Security Advisories](https://github.com/singerbj/gh-runner/security/advisories/new). Don't open a public issue. Full details are in [SECURITY.md](https://github.com/singerbj/gh-runner/blob/main/SECURITY.md).
