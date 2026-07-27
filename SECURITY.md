# Security

## Reporting a vulnerability

Report privately through [GitHub Security Advisories](https://github.com/singerbj/gh-runner/security/advisories/new). Please don't open a public issue for something exploitable.

Include what you did, what happened, and what you expected. A proof of concept helps but isn't required to file.

Expect an acknowledgement within a week. Fixes ship as a patch release to `@singerbj/gh-runner`, with an advisory once users have had a chance to upgrade.

## What this tool does, and what that means

`gh-runner` registers the machine it runs on as a GitHub Actions self-hosted runner. **A native runner executes CI jobs as the user who started the command** — same shell, same home directory, same SSH keys, same `gh` login. That is the point of the tool, and it is also the whole threat model: anyone who can cause a job to run on the `gh-runner` label has, for as long as the command is up, the access you have.

So the security of a `gh-runner` session is mostly the security of the repo you point it at.

### The guarantees

- **Repos that aren't confirmed private are refused.** Public means any fork can open a pull request and run code here. A visibility that `gh` couldn't determine — logged out, rate-limited, offline — is refused on the same footing: an unanswered question is not a "no". `--allow-public` overrides this, deliberately and per-run.
- **The runner binary is verified before it is executed.** The `actions/runner` tarball is checked against the SHA-256 that release publishes, on a cache hit as much as on a fresh download. The cache lives in an ordinary writable directory, so a file being there proves nothing on its own. A mismatch aborts the run; a release that publishes no checksum produces a warning rather than a silent pass.
- **No long-lived credential is ever handled.** Every network call goes through `gh`, using the login already on the machine. Registration and removal tokens are short-lived, minted per run, and are the only tokens this tool touches.
- **Nothing is spawned through a shell.** Arguments are passed as argv, so a token or repo name can never be re-read as shell syntax. The Docker registration token travels in the environment rather than argv, which `ps` and `/proc/<pid>/cmdline` expose to every local account.
- **Cleanup runs on every exit path** — success, error, and Ctrl+C. Native runners deregister and lose their temp directory; containers are force-removed and deregistered through the API.

### The limits

These are known, accepted, and worth knowing before you run it:

- **Private is not the same as trusted.** Every collaborator who can push a branch or open a PR on a private repo can run code on your machine while a runner is up. Judge a repo by who can trigger its workflows, not by its visibility flag.
- **A native runner is not sandboxed at all.** If that matters, serve Linux from a container (`gh-runner linux` with Docker available): no volumes, no Docker socket, nothing mounted from the host.
- **`config.sh --token` puts the registration token in argv** on the native path, because the runner offers no other way to pass it. Another local account can read it during the second or two registration takes. It expires within the hour and grants only "register a runner on this repo".
- **`--allow-public` really is dangerous.** It exists for repos where you trust every contributor who can open a pull request. There is no safe way to use it on a repo where you don't.
- **The workflow-fix PR changes where CI runs.** Merging one means those jobs only run while someone has a runner online. That is a CI availability decision as much as a security one — the PR body says so, and it is worth reading before merging.

## Supported versions

Fixes land on the latest published version of `@singerbj/gh-runner`. There are no maintained release branches; upgrade to the latest patch.
