#!/usr/bin/env bash
# Starts gh-runner as a Linux runner for GH_RUNNER_REPO. Anything passed as the
# container's command is appended to gh-runner's arguments, e.g. `--labels gpu`.
set -euo pipefail

if [ -z "${GH_TOKEN:-}" ] || [ -z "${GH_RUNNER_REPO:-}" ]; then
  echo "gh-runner: set GH_TOKEN and GH_RUNNER_REPO (owner/name)" >&2
  # A restart policy would otherwise retry this as fast as Docker allows.
  sleep 30
  exit 1
fi

args=(linux --repo "$GH_RUNNER_REPO" --name "${GH_RUNNER_NAME:-$(hostname)}" --no-fix-workflows)
if [ -n "${GH_RUNNER_LABELS:-}" ]; then
  args+=(--labels "$GH_RUNNER_LABELS")
fi

exec gh-runner "${args[@]}" "$@"
