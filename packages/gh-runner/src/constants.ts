import type { RunnerOs } from "./platform.js";

/**
 * The label every runner registers, whatever it is running on. Workflows can
 * say `runs-on: [self-hosted, gh-runner]` and get whichever machine is free.
 */
export const DEFAULT_LABEL = "gh-runner";

/**
 * One label per operating system, registered alongside {@link DEFAULT_LABEL}.
 * A job that genuinely needs macOS asks for `gh-runner-mac` and will never be
 * handed the Linux box someone else has online.
 */
export const OS_LABELS: Readonly<Record<RunnerOs, string>> = {
  osx: "gh-runner-mac",
  linux: "gh-runner-linux",
  win: "gh-runner-windows",
};

export function osLabel(os: RunnerOs): string {
  return OS_LABELS[os];
}

/** The OS a `gh-runner-*` label pins to, or null if it isn't one of ours. */
export function osForLabel(label: string): RunnerOs | null {
  const wanted = label.toLowerCase();
  for (const [os, value] of Object.entries(OS_LABELS)) {
    if (value === wanted) return os as RunnerOs;
  }
  return null;
}

/** Human name for an OS, as GitHub spells it. */
export const OS_NAMES: Readonly<Record<RunnerOs, string>> = {
  osx: "macOS",
  linux: "Linux",
  win: "Windows",
};

/**
 * Prefix for the branch the workflow-fix pull request is opened from. Every run
 * appends a random suffix, so a branch left behind by an earlier run — locally
 * or on the remote — can never collide with this one.
 */
export const FIX_BRANCH_PREFIX = "gh-runner/target-self-hosted";

/**
 * The repository variable that moves jobs asking for `label` onto a gh-runner.
 *
 * `runs-on` can read `vars` before any runner is involved, which is the whole
 * trick: whether a repo can still start GitHub-hosted jobs can't be decided by
 * a job — a job needs a runner, and "GitHub won't start one here" is the one
 * answer it could never give. So `gh-runner` decides from outside Actions and
 * hands the answer to the scheduler here.
 *
 * One variable per label, holding the label itself, so the workflow reads as
 * plainly as it can: `vars.GH_RUNNER_LINUX || 'ubuntu-latest'`. A session only
 * sets the ones for labels it actually serves — a Linux box never pulls macOS
 * jobs into a queue nothing will answer.
 *
 * `gh-runner` and `gh-runner-*` map to `GH_RUNNER` and `GH_RUNNER_*`; any other
 * label, from `--fix-label`, to `GH_RUNNER_LABEL_*`, so the two can't collide.
 */
export function runnerVariable(label: string): string {
  const upper = label.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_");
  const lower = label.toLowerCase();
  if (lower === DEFAULT_LABEL) return "GH_RUNNER";
  if (lower.startsWith(`${DEFAULT_LABEL}-`)) return upper;
  return `GH_RUNNER_LABEL_${upper}`;
}

/** The label a {@link runnerVariable} name stands for — lossy only for `.` and `_` in custom labels. */
export function labelForVariable(name: string): string | null {
  if (name === "GH_RUNNER") return DEFAULT_LABEL;
  const custom = /^GH_RUNNER_LABEL_([A-Z0-9_]+)$/.exec(name);
  if (custom?.[1]) return custom[1].toLowerCase().replaceAll("_", "-");
  const ours = /^GH_RUNNER_([A-Z0-9_]+)$/.exec(name);
  if (ours?.[1]) return `${DEFAULT_LABEL}-${ours[1].toLowerCase().replaceAll("_", "-")}`;
  return null;
}

/** A value for a GitHub expression string literal: `'...'`, quotes doubled. */
export function expressionString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The `runs-on` value the workflow fix writes: the GitHub-hosted runner the job
 * always used, unless `gh-runner` has said the repo can't start one.
 *
 * ```yaml
 * runs-on: ${{ vars.GH_RUNNER_LINUX || 'ubuntu-latest' }}
 * ```
 *
 * A hosted `runs-on` with several labels keeps them all, as `fromJSON('[...]')`.
 */
export function fallbackRunsOn(
  label: string,
  hosted: readonly string[],
  variable?: string,
): string {
  const fallback =
    hosted.length === 1
      ? expressionString(hosted[0] as string)
      : `fromJSON(${expressionString(JSON.stringify(hosted))})`;
  return `\${{ ${variable ?? `vars.${runnerVariable(label)}`} || ${fallback} }}`;
}
