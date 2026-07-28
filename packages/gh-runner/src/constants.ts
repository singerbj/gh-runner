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
