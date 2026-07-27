/**
 * The label every workflow should target. Registering it on every runner means
 * `runs-on: [self-hosted, gh-runner]` is a stable contract in a repo's YAML, no
 * matter whose machine is standing in today.
 */
export const DEFAULT_LABEL = "gh-runner";

/** Branch used for the workflow-fix pull request. */
export const FIX_BRANCH = "gh-runner/target-self-hosted";
