# Always on with Docker

For a server that should always take jobs (a home lab, a VPS, a Coolify host), use the prebuilt image `ghcr.io/singerbj/gh-runner` (amd64 and arm64). The runner is online while the container is up and deregisters when it stops.

## Docker

```sh
docker run -d --restart unless-stopped --stop-timeout 60 \
  -e GH_TOKEN=github_pat_… -e GH_RUNNER_REPO=you/your-repo \
  -v gh-runner:/home/node ghcr.io/singerbj/gh-runner
```

## Docker Compose

```sh
curl -fsSLO https://github.com/singerbj/gh-runner/releases/latest/download/docker-compose.yml
printf 'GH_TOKEN=%s\nGH_RUNNER_REPO=%s\n' "github_pat_…" "you/your-repo" > .env
docker compose up -d
docker compose logs -f   # wait for "Runner is live"
```

::: details docker-compose.yml
<<< ../../../../packages/gh-runner/deploy/docker-compose.yml
:::

## Coolify

1. Add a **Docker Compose Empty** resource and paste the compose file.
2. Set `GH_TOKEN` and `GH_RUNNER_REPO` under **Environment Variables**.
3. Deploy. No domain or port needed.

## Configuration

The container needs `GH_TOKEN` and `GH_RUNNER_REPO`. Without them it logs `set GH_TOKEN and GH_RUNNER_REPO` and exits. Set them wherever you run it:

- **Docker:** `-e GH_TOKEN=… -e GH_RUNNER_REPO=owner/name`
- **Docker Compose:** a `.env` file next to `docker-compose.yml`, as [above](#docker-compose)
- **Coolify:** the resource's **Environment Variables** tab, then redeploy

### Creating the token

1. Open [**New fine-grained token**](https://github.com/settings/personal-access-tokens/new).
2. **Resource owner:** the repo's owner. **Repository access:** _Only select repositories_, and pick the one repo.
3. **Repository permissions:** **Administration**, **Actions** and **Variables**, each _Read and write_.
4. Generate it and use it as `GH_TOKEN`. `GH_RUNNER_REPO` is that repo as `owner/name`, e.g. `singerbj/gh-runner`.

| Variable           | Required | Description                                                                                |
| ------------------ | -------- | ------------------------------------------------------------------------------------------ |
| `GH_TOKEN`         | yes      | Fine-grained token for one repo: **Administration**, **Actions**, **Variables** read/write |
| `GH_RUNNER_REPO`   | yes      | `owner/name` of a private repo                                                             |
| `GH_RUNNER_NAME`   | no       | Runner name (default: container hostname)                                                  |
| `GH_RUNNER_LABELS` | no       | Extra labels, comma-separated                                                              |

Arguments passed as the container's command go to `gh-runner`, e.g. `command: ["--runner-version", "2.334.0"]`.

## Limits

- **Linux only.** It serves `gh-runner-linux` and `gh-runner`.
- **No Docker socket.** `docker build`, `services:` and `container:` jobs won't run.
- **Run [setup](./setup) first** so your workflows can fall back to it.

::: warning Scope the token to one repo
Jobs don't inherit `GH_TOKEN`, but they run as the same user and could read it from `/proc`. Only use this on a repo where you trust everyone who can push.
:::
