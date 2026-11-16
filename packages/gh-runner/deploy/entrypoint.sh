#!/usr/bin/env bash
# Starts gh-runner as a Linux runner. With GH_RUNNER_REPO it serves that one
# repo; without it, every private repo the token can see whose workflows send
# jobs to gh-runner (GH_RUNNER_OWNER and GH_RUNNER_REPOS narrow or name them).
# Anything passed as the container's command is appended to gh-runner's
# arguments, e.g. `--labels gpu`.
set -euo pipefail

if [ -z "${GH_TOKEN:-}" ]; then
  echo "gh-runner: set GH_TOKEN, and optionally GH_RUNNER_REPO (owner/name)" >&2
  echo "gh-runner: how to: https://gh-runner.benjaminjsinger.com/guide/docker#configuration" >&2
  # A restart policy would otherwise retry this as fast as Docker allows.
  sleep 30
  exit 1
fi

args=(linux --name "${GH_RUNNER_NAME:-$(hostname)}" --no-fix-workflows)
if [ -n "${GH_RUNNER_REPO:-}" ]; then
  args+=(--repo "$GH_RUNNER_REPO")
else
  if [ -n "${GH_RUNNER_REPOS:-}" ]; then
    args+=(--repos "$GH_RUNNER_REPOS")
  fi
  if [ -n "${GH_RUNNER_OWNER:-}" ]; then
    args+=(--owner "$GH_RUNNER_OWNER")
  elif [ -z "${GH_RUNNER_REPOS:-}" ]; then
    args+=(--all-repos)
  fi
fi
if [ -n "${GH_RUNNER_LABELS:-}" ]; then
  args+=(--labels "$GH_RUNNER_LABELS")
fi

exec gh-runner "${args[@]}" "$@"
