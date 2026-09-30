import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LABEL,
  FIX_BRANCH_PREFIX,
  fallbackRunsOn,
  osLabel,
  runnerVariable,
} from "./constants.js";
import { CliError } from "./errors.js";
import { CommandFailedError, execCapture } from "./exec.js";
import type { CommandRunner, ExecOptions } from "./exec.js";
import type { GhClient } from "./gh.js";
import type { Logger } from "./logger.js";
import { assertLabel } from "./options.js";
import {
  PROBE_JOB_ID,
  applyWorkflowFix,
  hostedRunnerOs,
  inspectWorkflows,
  listWorkflowFiles,
} from "./workflows.js";
import type { RunsOnFix, RunsOnTarget } from "./workflows.js";

/**
 * The label a rewritten job moves to when GitHub-hosted runners can't start.
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

/** One rewritten job: where it lives, what it asked for, and where it can move. */
export interface FixedJob {
  file: string;
  job: string;
  /** The gh-runner label it moves to when GitHub-hosted runners can't start. */
  label: string;
  /** The hosted runner it keeps using otherwise, e.g. `["macos-14"]`. */
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
      /** True when the PR also takes out a probe job an older version wrote. */
      removesProbe: boolean;
    };

/**
 * Opens a pull request that lets GitHub-hosted jobs move onto a gh-runner when
 * — and only when — the repo can't start hosted jobs.
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

    // A repo an older version fixed may have nothing left to repoint and still
    // need this PR, to take its probe job back out.
    if (wanted.length === 0 && !report.legacyProbe) {
      return { status: "no-changes" };
    }

    const byFile = new Map<string, RunsOnTarget[]>();
    for (const target of wanted) {
      byFile.set(target.file, [...(byFile.get(target.file) ?? []), target]);
    }

    const files: string[] = [];
    let removesProbe = false;
    for (const name of (await listWorkflowFiles(worktree)) ?? []) {
      const file = `.github/workflows/${name}`;
      const path = join(worktree, file);
      const source = await readFile(path, "utf8");
      const fixes: RunsOnFix[] = (byFile.get(file) ?? []).map((target) => ({
        target,
        label: labelFor(target),
      }));

      const output = applyWorkflowFix(source, { fixes });
      if (output === source) continue;

      removesProbe ||= source.includes(`${PROBE_JOB_ID}:`) && !output.includes(`${PROBE_JOB_ID}:`);
      await writeFile(path, output);
      files.push(file);
    }

    if (files.length === 0) {
      return { status: "no-changes" };
    }

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
      { cwd: worktree },
    );

    const done = { branch, base, files, jobs, removesProbe };

    if (options.dryRun) {
      return { status: "dry-run", url: null, ...done };
    }

    await git(["push", "--quiet", "-u", "origin", branch], { cwd: worktree });

    const url = await gh.createPullRequest({
      repo,
      base,
      head: branch,
      title: pullRequestTitle(jobs),
      body: pullRequestBody(jobs, removesProbe),
      cwd: worktree,
    });

    return { status: "opened", url, ...done };
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

function jobsFor(jobs: readonly FixedJob[], label: string): string[] {
  return jobs.filter((entry) => entry.label === label).map((entry) => entry.job);
}

function commitMessage(jobs: readonly FixedJob[]): string {
  return [
    pullRequestTitle(jobs),
    "",
    "Each job keeps the GitHub-hosted runner it uses today, and moves to a",
    "self-hosted gh-runner only while GitHub won't start hosted jobs here —",
    "no minutes left, a spending limit, a failed payment. gh-runner sets a",
    "repository variable per label when that happens, and clears it again.",
    ...(jobs.length > 0
      ? [
          "",
          ...fixLabels(jobs).map(
            (label) => `  ${runnerVariable(label)}: ${jobsFor(jobs, label).join(", ")}`,
          ),
        ]
      : []),
    "",
    "Generated by gh-runner.",
  ].join("\n");
}

function pullRequestTitle(jobs: readonly FixedJob[]): string {
  if (jobs.length === 0) return `Replace the ${PROBE_JOB_ID} job with runner variables`;
  const count = `${jobs.length} job${jobs.length === 1 ? "" : "s"}`;
  return `Let ${count} fall back to a self-hosted runner when out of Actions minutes`;
}

function pullRequestBody(jobs: readonly FixedJob[], removesProbe: boolean): string {
  const list = jobs
    .map(
      (entry) =>
        `- \`${entry.job}\` in \`${entry.file}\`: \`${fallbackRunsOn(entry.label, entry.from)}\``,
    )
    .join("\n");

  const changes =
    jobs.length > 0
      ? `Each of these jobs keeps running on the GitHub-hosted runner it uses today. It moves to a
self-hosted runner only while GitHub won't start hosted jobs in this repo:

${list}`
      : `Nothing moves. The jobs that used to wait on the \`${PROBE_JOB_ID}\` job read their runner
variable directly instead.`;

  const probe = removesProbe
    ? `
The \`${PROBE_JOB_ID}\` job an older version of gh-runner added is gone. It needed a runner of its
own before anything else could be scheduled, which is exactly what a repo out of minutes doesn't
have.
`
    : "";

  return `## What this changes

${changes}
${probe}
## How it works

Nothing in this workflow checks anything. \`runs-on\` reads a repository variable, which GitHub
resolves before any runner is involved. The variable is unset normally, so the job runs where it
always has. **No self-hosted runner is needed for this to work.**

[\`gh-runner\`](https://www.npmjs.com/package/@singerbj/gh-runner) sets the variable, from outside
Actions. While it's running it watches this repo's runs. When GitHub refuses to start a job for
billing reasons — no minutes left, a spending limit, a failed payment — it sets the variable for
each label it serves, such as \`${runnerVariable(osLabel("linux"))}=${osLabel("linux")}\`, and re-runs the refused runs
so they land on it. It clears the variables when it stops, when a hosted job succeeds again, or
when a new month resets the included minutes.

## Before you merge

- Setting a variable needs admin on the repo — the same rights registering a runner needs.
- Out of minutes with no \`gh-runner\` running, jobs fail the way they do today; there's nowhere
  for them to run. Starting \`gh-runner\` re-runs the ones refused in the last day.
- A runner killed too hard to clean up (\`kill -9\`, a power cut) can leave a variable set. Jobs
  then wait for it rather than using a GitHub-hosted runner. Deleting the variable is always safe.

---
_Generated by [gh-runner](https://github.com/singerbj/gh-runner)_
`;
}
