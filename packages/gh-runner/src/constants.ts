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

/** Where the probe action the fix PR calls is published from. */
export const ACTION_REPO = "singerbj/gh-runner";
export const ACTION_PATH = "actions/pick-runner";

/**
 * The `uses:` the fix PR writes.
 *
 * A tag is a mutable pointer, and this one lands in someone else's workflow, so
 * it is resolved to the commit it names and pinned to that — with the tag left
 * in a trailing comment, the same way this repo pins the actions it consumes.
 * Without a resolved commit the tag is written on its own; a fix PR is more
 * useful than no fix PR, and the tag is still one this repo published.
 */
export function actionRef(version: string, sha?: string | null): string {
  const tag = `v${version}`;
  const base = `${ACTION_REPO}/${ACTION_PATH}`;
  return sha ? `${base}@${sha} # ${tag}` : `${base}@${tag}`;
}

/**
 * Repository variable a live runner sets so the probe job itself can skip
 * GitHub-hosted runners.
 *
 * `runs-on` is resolved before any job starts, so it can't read the probe's
 * output — `needs` is what the probe exists to feed. `vars` is the one context
 * a runner can write to that `runs-on` can read, which makes this the only way
 * to keep a rewritten workflow off hosted runners entirely.
 */
export const PROBE_RUNS_ON_VAR = "GH_RUNNER_PROBE_RUNS_ON";

/**
 * What that variable holds while a runner is up.
 *
 * Always this exact value, whichever platform published it: every runner
 * registers {@link DEFAULT_LABEL}, so any of them can answer the probe job —
 * all it does is read refs. A constant also makes two sessions agree, so
 * publishing is idempotent and cleanup can't clobber a sibling's value.
 */
export const PROBE_RUNS_ON_VALUE = JSON.stringify(["self-hosted", DEFAULT_LABEL]);

/** The probe job's `runs-on` before this option existed, and without it. */
export const HOSTED_PROBE_RUNS_ON = "ubuntu-latest";

/**
 * The probe job's `runs-on` with the self-hosted probe on: the variable when a
 * runner published one, and the hosted runner when none did.
 *
 * A variable has no expiry — unlike the marker refs, which age out — so a
 * runner killed hard enough to skip its cleanup leaves this set and the probe
 * job queues until a runner comes back. That is the trade this option makes,
 * and why it is opt-in.
 */
export const SELF_HOSTED_PROBE_RUNS_ON =
  `\${{ vars.${PROBE_RUNS_ON_VAR} && fromJSON(vars.${PROBE_RUNS_ON_VAR}) ` +
  `|| '${HOSTED_PROBE_RUNS_ON}' }}`;

/**
 * The probe job's `runs-on` with `--no-hosted-fallback`: the labels themselves,
 * named outright.
 *
 * No variable and no expression, because there is nothing left to choose
 * between — both branches of {@link SELF_HOSTED_PROBE_RUNS_ON} would resolve to
 * this once the hosted side is gone. A workflow written this way queues until a
 * runner is up rather than falling through to a runner the repo can't start.
 */
export const SELF_HOSTED_ONLY_PROBE_RUNS_ON = `[self-hosted, ${DEFAULT_LABEL}]`;

/**
 * Repository variable that says GitHub-hosted runners can't start jobs in this
 * repo right now — included minutes used up, a spending limit hit, a failed
 * payment.
 *
 * This is what `--hosted-first` hangs on. Whether a repo is out of minutes can't
 * be decided by a job, because a job needs a runner and the whole question is
 * whether one will start; `runs-on` can read `vars` before any runner is
 * involved. So the decision is made outside Actions — by `gh-runner`, on the
 * machine that is about to take the work — and handed to the scheduler here.
 *
 * Any non-empty value means blocked. `gh-runner` writes the time it noticed,
 * which is what lets it retry the hosted runners once a new month begins.
 */
export const HOSTED_BLOCKED_VAR = "GH_RUNNER_HOSTED_BLOCKED";

/** A value for a GitHub expression string literal: `'...'`, quotes doubled. */
export function expressionString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A label list as an expression: a bare string for one, `fromJSON('[...]')` for more. */
export function expressionLabels(labels: readonly string[]): string {
  return labels.length === 1
    ? expressionString(labels[0] as string)
    : `fromJSON(${expressionString(JSON.stringify(labels))})`;
}

/**
 * The `runs-on` value `--hosted-first` writes: the runner the job always used,
 * unless {@link HOSTED_BLOCKED_VAR} says the repo can't start one.
 *
 * ```yaml
 * runs-on: ${{ vars.GH_RUNNER_HOSTED_BLOCKED && fromJSON('["self-hosted","gh-runner-linux"]') || 'ubuntu-latest' }}
 * ```
 *
 * The self-hosted side is always written with `fromJSON` — even a single label
 * — so the shape is fixed and a later run can read it back.
 */
export function hostedFirstRunsOn(
  labels: readonly string[],
  hosted: readonly string[],
  variable = `vars.${HOSTED_BLOCKED_VAR}`,
): string {
  const selfHosted = `fromJSON(${expressionString(JSON.stringify(labels))})`;
  return `\${{ ${variable} && ${selfHosted} || ${expressionLabels(hosted)} }}`;
}

/** The key a job reads out of the probe job's output — `linux`, `mac`, `windows`. */
export const OS_KEYS: Readonly<Record<RunnerOs, string>> = {
  osx: "mac",
  linux: "linux",
  win: "windows",
};

/** A probe output key for any label, so `--fix-label` works the same way. */
export function probeKey(label: string): string {
  const os = osForLabel(label);
  if (os) return OS_KEYS[os];
  const key = label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(key) ? key : `runner_${key}`;
}
