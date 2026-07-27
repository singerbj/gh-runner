import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LABEL, FIX_BRANCH_PREFIX, osLabel } from "./constants.js";
import { CliError } from "./errors.js";
import { CommandFailedError, execCapture } from "./exec.js";
import type { CommandRunner, ExecOptions } from "./exec.js";
import type { GhClient } from "./gh.js";
import type { Logger } from "./logger.js";
import { assertLabel } from "./options.js";
import { applyRunsOnFix, hostedRunnerOs, inspectWorkflows } from "./workflows.js";
import type { RunsOnTarget } from "./workflows.js";

/**
 * The label a rewritten job should ask for.
 *
 * A job that ran on `macos-14` needs a Mac, so it gets `gh-runner-mac` and will
 * never be handed the Linux box someone else has online. Only jobs whose image
 * we can't place fall back to the generic label, which any machine answers.
 * An explicit `--fix-label` beats all of it.
 */
export function fixLabelFor(target: RunsOnTarget, override?: string | undefined): string {
  if (override) return override;
  const os = hostedRunnerOs(target.labels);
  return os ? osLabel(os) : DEFAULT_LABEL;
}

export interface WorkflowFixOptions {
  repo: string;
  /** Absolute path to the user's checkout — never modified. */
  repoRoot: string;
  /**
   * Forces this label onto every rewritten job. Left unset — the default — each
   * job gets the label pinned to the OS it already ran on.
   */
  label?: string | undefined;
  /** Restrict the rewrite to these job ids. Empty means every hosted job. */
  jobs?: readonly string[];
  /** Overrides the generated branch name. Used verbatim, suffix and all. */
  branch?: string;
  commandRunner: CommandRunner;
  gh: GhClient;
  logger: Logger;
  signal?: AbortSignal;
  /** Do everything except push and open the PR. */
  dryRun?: boolean;
}

/** One rewritten job: where it lives, what it asked for, and what it asks for now. */
export interface FixedJob {
  file: string;
  job: string;
  /** The label written into `runs-on`, alongside `self-hosted`. */
  label: string;
  /** The labels the job used to ask for, e.g. `["macos-14"]`. */
  from: string[];
}

export type WorkflowFixResult =
  | { status: "no-changes" }
  | { status: "branch-exists"; branch: string; url: string | null }
  | {
      status: "opened" | "dry-run";
      branch: string;
      base: string;
      url: string | null;
      files: string[];
      jobs: FixedJob[];
    };

/**
 * Opens a pull request that points GitHub-hosted jobs at this runner.
 *
 * Each job keeps the platform it already had: the OS named in its current
 * `runs-on` picks the label, so a `macos-14` job asks for `gh-runner-mac` and
 * only ever lands on a Mac.
 *
 * The rewrite happens in a throwaway `git worktree` checked out from the
 * default branch, so the user's working tree, index, and current branch are
 * never touched — even if they have uncommitted work in flight. The worktree
 * and its local branch are removed on every exit path.
 *
 * Both names carry a random suffix. Cleanup can only fail when the process is
 * killed mid-run, and a leftover branch or worktree from that run must not be
 * what stops the next one.
 */
export async function proposeWorkflowFix(options: WorkflowFixOptions): Promise<WorkflowFixResult> {
  const { repo, repoRoot, commandRunner, gh, logger, signal } = options;
  // An override is spliced into YAML that becomes a commit, so it gets checked
  // here as well as in parseArgs — this is a public entry point too. Left unset
  // the label comes from osLabel/DEFAULT_LABEL, which are ours already.
  const override =
    options.label === undefined ? undefined : assertLabel("--fix-label", options.label);
  const labelFor = (target: RunsOnTarget) => fixLabelFor(target, override);
  const runId = randomBytes(4).toString("hex");
  const branch = options.branch ?? `${FIX_BRANCH_PREFIX}-${runId}`;
  const exec: ExecOptions = { cwd: repoRoot, ...(signal ? { signal } : {}) };

  const git = (args: string[], overrides: ExecOptions = {}) =>
    execCapture(commandRunner, "git", args, { ...exec, ...overrides });

  const base = await gh.defaultBranch(repo);

  logger.say(`Preparing a workflow fix on ${branch}...`);
  try {
    await git(["fetch", "--quiet", "origin", base]);
  } catch {
    throw new CliError(`couldn't fetch origin/${base} — is this checkout connected to ${repo}?`);
  }

  // A previous run already pushed a fix branch. Its name won't match ours, so
  // match on the prefix instead — the point is not to stack a second PR.
  const pushed = await pushedFixBranch(commandRunner, exec, options.branch);
  if (pushed) {
    return {
      status: "branch-exists",
      branch: pushed,
      url: await gh.pullRequestForBranch(repo, pushed),
    };
  }

  const tmpRoot = await mkdtemp(join(tmpdir(), "gh-runner-fix-"));
  const worktree = join(tmpRoot, `workflows-${runId}`);

  try {
    try {
      await git(["worktree", "add", "--quiet", "-b", branch, worktree, `origin/${base}`]);
    } catch (error) {
      // git says 255 for every one of these. A stack trace over a bare exit
      // code is the least useful thing we could show at this point.
      const detail = error instanceof CommandFailedError ? error.result.stderr.trim() : "";
      throw new CliError(
        `couldn't check out ${branch} in a temporary worktree${detail ? `\n       ${detail}` : ""}`,
      );
    }

    // Re-scan inside the worktree: the user's working copy may be ahead of, or
    // behind, the branch the PR is actually built on. Only `hosted` is used, and
    // that verdict doesn't depend on the label set we pass.
    const report = await inspectWorkflows(worktree, [[override ?? DEFAULT_LABEL]]);
    const wanted = options.jobs?.length
      ? report.hosted.filter((target) => options.jobs?.includes(target.job))
      : report.hosted;

    if (wanted.length === 0) {
      return { status: "no-changes" };
    }

    const byFile = new Map<string, RunsOnTarget[]>();
    for (const target of wanted) {
      byFile.set(target.file, [...(byFile.get(target.file) ?? []), target]);
    }

    for (const [file, targets] of byFile) {
      const path = join(worktree, file);
      const source = await readFile(path, "utf8");
      await writeFile(path, applyRunsOnFix(source, targets, labelFor));
    }

    const files = [...byFile.keys()].toSorted();
    const jobs: FixedJob[] = wanted.map((target) => ({
      file: target.file,
      job: target.job,
      label: labelFor(target),
      from: target.labels,
    }));

    await git(["add", "--", ...files], { cwd: worktree });
    await git(
      [
        ...(await identityArgs(commandRunner, exec)),
        "commit",
        "--quiet",
        "-m",
        commitMessage(jobs),
      ],
      {
        cwd: worktree,
      },
    );

    if (options.dryRun) {
      return { status: "dry-run", branch, base, url: null, files, jobs };
    }

    await git(["push", "--quiet", "-u", "origin", branch], { cwd: worktree });

    const url = await gh.createPullRequest({
      repo,
      base,
      head: branch,
      title: pullRequestTitle(jobs),
      body: pullRequestBody(jobs),
      cwd: worktree,
    });

    return { status: "opened", branch, base, url, files, jobs };
  } finally {
    // Leave nothing behind: no worktree, no local branch, no temp directory.
    await commandRunner("git", ["worktree", "remove", "--force", worktree], exec).catch(() => {});
    await rm(tmpRoot, { recursive: true, force: true });
    // `branch -D` refuses to delete a branch that is checked out somewhere, and
    // a worktree we failed to remove still counts. Drop the registration first
    // — prune only touches worktrees whose directory is already gone.
    await commandRunner("git", ["worktree", "prune"], exec).catch(() => {});
    await commandRunner("git", ["branch", "-D", branch], exec).catch(() => {});
  }
}

/**
 * A fix branch already on the remote, or null. With no explicit branch this
 * matches every suffix the generator can produce, plus the unsuffixed name
 * older versions pushed.
 */
async function pushedFixBranch(
  commandRunner: CommandRunner,
  exec: ExecOptions,
  branch: string | undefined,
): Promise<string | null> {
  const pattern = branch ? `refs/heads/${branch}` : `refs/heads/${FIX_BRANCH_PREFIX}*`;
  const result = await commandRunner(
    "git",
    ["ls-remote", "--heads", "origin", pattern],
    exec,
  ).catch(() => null);
  if (!result || result.code !== 0) return null;

  for (const line of result.stdout.split("\n")) {
    const ref = line.split("\t")[1]?.trim();
    if (ref?.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  }
  return null;
}

/** Falls back to a bot identity only when the user has no git identity configured. */
async function identityArgs(commandRunner: CommandRunner, exec: ExecOptions): Promise<string[]> {
  const email = await commandRunner("git", ["config", "user.email"], exec).catch(() => null);
  if (email && email.code === 0 && email.stdout.trim()) {
    return [];
  }
  return ["-c", "user.name=gh-runner", "-c", "user.email=gh-runner@users.noreply.github.com"];
}

/** The distinct labels the rewrite writes, in the order jobs first ask for them. */
export function fixLabels(jobs: readonly FixedJob[]): string[] {
  return [...new Set(jobs.map((entry) => entry.label))];
}

function jobList(jobs: readonly FixedJob[]): string {
  return jobs
    .map(({ file, job, label, from }) => {
      const was = from.length > 0 ? ` — was \`${from.join(", ")}\`` : "";
      return `- \`${job}\` in \`${file}\` → \`[self-hosted, ${label}]\`${was}`;
    })
    .join("\n");
}

function commitMessage(jobs: readonly FixedJob[]): string {
  const labels = fixLabels(jobs);
  const only = labels.length === 1 ? labels[0] : undefined;

  const count = `${jobs.length} job${jobs.length === 1 ? "" : "s"}`;

  return [
    only
      ? `Point ${count} at the self-hosted ${only} runner`
      : `Point ${count} at self-hosted runners`,
    "",
    only
      ? `runs-on is now [self-hosted, ${only}], so these jobs run on whichever\nmachine is currently registered under that label.`
      : "runs-on now asks for the label pinned to the OS each job already ran on,\nso a macOS build still lands on a macOS machine:",
    ...(only
      ? []
      : ["", ...labels.map((label) => `  ${label}: ${jobsFor(jobs, label).join(", ")}`)]),
    "",
    "Generated by gh-runner.",
  ].join("\n");
}

function jobsFor(jobs: readonly FixedJob[], label: string): string[] {
  return jobs.filter((entry) => entry.label === label).map((entry) => entry.job);
}

function pullRequestTitle(jobs: readonly FixedJob[]): string {
  const labels = fixLabels(jobs);
  return labels.length === 1
    ? `Run CI on a self-hosted \`${labels[0]}\` runner`
    : "Run CI on self-hosted runners";
}

function pullRequestBody(jobs: readonly FixedJob[]): string {
  const labels = fixLabels(jobs);
  const list = labels.map((label) => `\`${label}\``).join(", ");
  const one = labels.length === 1;

  return `## What this changes

\`runs-on\` now targets a self-hosted runner for:

${jobList(jobs)}

Each job keeps the platform it had: a \`macos-*\` job asks for \`${osLabel("osx")}\`, \`ubuntu-*\` for
\`${osLabel("linux")}\`, \`windows-*\` for \`${osLabel("win")}\`. A job whose image doesn't name an OS gets the
generic \`${DEFAULT_LABEL}\` label, which any registered machine answers.

## Why

[\`gh-runner\`](https://www.npmjs.com/package/@singerbj/gh-runner) registers a developer machine as an
ephemeral self-hosted runner under \`${DEFAULT_LABEL}\`, plus the label for the OS it is running
(\`${osLabel("osx")}\`, \`${osLabel("linux")}\`, \`${osLabel("win")}\`). Jobs have to ask for a label before they can
land on it, so this PR makes ${one ? "that label" : "those labels"} a stable contract in the workflow YAML.

## Before you merge

These jobs will **only** run while a machine is registered under ${list}. With no runner
online they queue instead of failing, so this is a deliberate trade: faster, local hardware in
exchange for CI that depends on someone running \`npx @singerbj/gh-runner\`.

Keep hosted runs for anything that must pass without a human present, and repoint only the jobs
that genuinely need your hardware.

---
_Generated by [gh-runner](https://github.com/singerbj/gh-runner)_
`;
}
