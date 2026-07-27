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

/** Branch used for the workflow-fix pull request. */
export const FIX_BRANCH = "gh-runner/target-self-hosted";
