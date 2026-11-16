# Always on with Docker

For a server that should always take jobs (a home lab, a VPS, a Coolify host), use the prebuilt image `ghcr.io/singerbj/gh-runner` (amd64 and arm64). The runner is online while the container is up and deregisters when it stops.

With just `GH_TOKEN` set, it serves [every repo](./all-repos) the token can see that uses gh-runner, and picks up new ones as you set them up. Set `GH_RUNNER_REPO` to serve one repo instead. Run it on several servers and they [share the work](./all-repos#several-machines).

## Docker

```sh
docker run -d --restart unless-stopped --stop-timeout 60 \
  -e GH_TOKEN=github_pat_… \
  -v gh-runner-cache:/home/runner/.cache ghcr.io/singerbj/gh-runner
```

## Docker Compose

```sh
curl -fsSLO https://github.com/singerbj/gh-runner/releases/latest/download/docker-compose.yml
printf 'GH_TOKEN=%s\n' "github_pat_…" > .env
docker compose up -d
docker compose logs -f   # wait for "Runner is live"
```

::: details docker-compose.yml
<<< ../../../../packages/gh-runner/deploy/docker-compose.yml
:::

## Coolify

1. Add a **Docker Compose Empty** resource and paste the compose file.
2. Set `GH_TOKEN` (and optionally `GH_RUNNER_REPO`) under **Environment Variables**.
3. Deploy. No domain or port needed.

## Configuration

The container needs `GH_TOKEN`. Without it, it logs `set GH_TOKEN` and exits. Set variables wherever you run it:

- **Docker:** `-e GH_TOKEN=… -e GH_RUNNER_REPO=owner/name`
- **Docker Compose:** a `.env` file next to `docker-compose.yml`, as [above](#docker-compose)
- **Coolify:** the resource's **Environment Variables** tab, then redeploy

### Creating the token

1. Open [**New fine-grained token**](https://github.com/settings/personal-access-tokens/new).
2. **Resource owner:** you, or the organisation. **Repository access:** _All repositories_ to serve every repo, or _Only select repositories_ to limit which ones it can see.
3. **Repository permissions:** **Administration**, **Actions** and **Variables**, each _Read and write_, and **Contents** _Read-only_ so it can read the workflows.
4. Generate it and use it as `GH_TOKEN`.

For an organisation's repos, set `GH_RUNNER_OWNER` to its name.

| Variable           | Required | Description                                                                                      |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------ |
| `GH_TOKEN`         | yes      | Fine-grained token: **Administration**, **Actions**, **Variables** read/write, **Contents** read |
| `GH_RUNNER_REPO`   | no       | `owner/name` of one private repo to serve. Unset: every repo that uses gh-runner                 |
| `GH_RUNNER_OWNER`  | no       | Users or orgs to scan instead of the token's account, comma-separated                            |
| `GH_RUNNER_REPOS`  | no       | Serve exactly these repos, comma-separated `owner/name`                                          |
| `GH_RUNNER_NAME`   | no       | Runner name (default: container hostname)                                                        |
| `GH_RUNNER_LABELS` | no       | Extra labels, comma-separated                                                                    |

Arguments passed as the container's command go to `gh-runner`, e.g. `command: ["--runner-version", "2.334.0"]`.

## Limits

- **Linux only.** It serves `gh-runner-linux` and `gh-runner`.
- **GitHub's runner image, plus Node LTS and `gh`.** Jobs run on Ubuntu as a user with passwordless `sudo`, so `apt-get` and `npx playwright install --with-deps` work. It's the same image `gh-runner linux` runs in Docker.
- **No Docker socket.** `docker build`, `services:` and `container:` jobs won't run.
- **Run [setup](./setup) first** so your workflows can fall back to it.

::: warning Scope the token to repos you trust
Jobs don't inherit `GH_TOKEN`, but they run as the same user and could read it from `/proc` — and it reaches every repo it was given. Only give it repos where you trust everyone who can push, or set `GH_RUNNER_REPO` and scope the token to that one.
:::
