# CLI

```sh
gh-runner [platforms...] [options]
gh-runner setup [options]
```

## Commands

| Command           | Description                                                            |
| ----------------- | ---------------------------------------------------------------------- |
| `gh-runner`       | Register runners and take jobs until stopped                           |
| `gh-runner setup` | Open a PR so jobs [fall back](/guide/fallback) to gh-runner, then exit |

## Platforms

Pass any of `mac`, `linux`, `windows` as arguments, or use `--os mac,linux`. With none, a menu is shown. With no terminal, it serves the host OS. See [Platforms & labels](/guide/platforms).

## Runner options

| Option                   | Description                                       |
| ------------------------ | ------------------------------------------------- |
| `--once`, `--ephemeral`  | Take one job, then deregister                     |
| `--labels a,b`           | Extra labels                                      |
| `--repo OWNER/NAME`      | Target repo (default: detected from cwd)          |
| `--name NAME`            | Runner name (default: `<host>-<pid>`)             |
| `--all`                  | Serve every platform this machine can             |
| `--os a,b`, `--platform` | Platforms to serve                                |
| `--allow-public`         | Allow repos not confirmed private (**dangerous**) |
| `--runner-version X.Y.Z` | Pin the runner version (default: latest)          |
| `--cache-dir PATH`       | Where to cache runner downloads                   |

## Docker options

| Option                 | Description                            |
| ---------------------- | -------------------------------------- |
| `--docker-image IMAGE` | Runner image (default: GitHub's)       |
| `--docker-platform P`  | Container platform, e.g. `linux/amd64` |

## Workflow options

| Option                | Description                              |
| --------------------- | ---------------------------------------- |
| `--dry-run`           | `setup` only: list changes, push nothing |
| `--fix-workflows`     | Open the workflow PR without asking      |
| `--no-fix-workflows`  | Never offer the workflow PR              |
| `--fix-jobs a,b`      | Only rewrite these job ids               |
| `--fix-label LABEL`   | Use one label for every rewritten job    |
| `--no-workflow-check` | Skip the `runs-on` check                 |

## Other

| Option            | Description  |
| ----------------- | ------------ |
| `-h`, `--help`    | Show help    |
| `-v`, `--version` | Show version |
