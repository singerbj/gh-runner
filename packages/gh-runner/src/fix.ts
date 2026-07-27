import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIX_BRANCH_PREFIX } from "./constants.js";
import { CliError } from "./errors.js";
import { CommandFailedError, execCapture } from "./exec.js";
import type { CommandRunner, ExecOptions } from "./exec.js";
import type { GhClient } from "./gh.js";
import type { Logger } from "./logger.js";
import { assertLabel } from "./options.js";
import { applyRunsOnFix, inspectWorkflows } from "./workflows.js";
import type { RunsOnTarget } from "./workflows.js";

export interface WorkflowFixOptions {
  repo: string;
  /** Absolute path to the user's checkout — never modified. */
  repoRoot: string;
  label: string;
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

export type WorkflowFixResult =
  | { status: "no-changes" }
  | { status: "branch-exists"; branch: string; url: string | null }
  | {
      status: "opened" | "dry-run";
      branch: string;
      base: string;
      url: string | null;
      files: string[];
      jobs: Array<{ file: string; job: string }>;
    };

/**
 * Opens a pull request that points GitHub-hosted jobs at this runner.
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
  // This is spliced into YAML that becomes a commit; parseArgs checks it, but
  // this is also a public entry point.
  const label = assertLabel("--fix-label", options.label);
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
    // behind, the branch the PR is actually built on.
    const report = await inspectWorkflows(worktree, [[label]]);
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
      await writeFile(path, applyRunsOnFix(source, targets, label));
    }

    const files = [...byFile.keys()].toSorted();
    const jobs = wanted.map((target) => ({ file: target.file, job: target.job }));

    await git(["add", "--", ...files], { cwd: worktree });
    await git(
      [
        ...(await identityArgs(commandRunner, exec)),
        "commit",
        "--quiet",
        "-m",
        commitMessage(label, jobs),
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
      title: `Run CI on a self-hosted \`${label}\` runner`,
      body: pullRequestBody(label, jobs),
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

function jobList(jobs: ReadonlyArray<{ file: string; job: string }>): string {
  return jobs.map(({ file, job }) => `- \`${job}\` in \`${file}\``).join("\n");
}

function commitMessage(label: string, jobs: ReadonlyArray<{ file: string; job: string }>): string {
  return [
    `Point ${jobs.length} job${jobs.length === 1 ? "" : "s"} at the self-hosted ${label} runner`,
    "",
    `runs-on is now [self-hosted, ${label}], so these jobs run on whichever`,
    "machine is currently registered under that label.",
    "",
    "Generated by gh-runner.",
  ].join("\n");
}

function pullRequestBody(
  label: string,
  jobs: ReadonlyArray<{ file: string; job: string }>,
): string {
  return `## What this changes

\`runs-on\` now targets \`[self-hosted, ${label}]\` for:

${jobList(jobs)}

## Why

[\`gh-runner\`](https://www.npmjs.com/package/@singerbj/gh-runner) registers a developer machine as an
ephemeral self-hosted runner under the \`${label}\` label. Jobs have to ask for that label before
they can land on it, so this PR makes the label a stable contract in the workflow YAML.

## Before you merge

These jobs will **only** run while a machine is registered under \`${label}\`. With no runner
online they queue instead of failing, so this is a deliberate trade: faster, local hardware in
exchange for CI that depends on someone running \`npx @singerbj/gh-runner\`.

Keep hosted runs for anything that must pass without a human present, and repoint only the jobs
that genuinely need your hardware.

If a job needs a specific operating system, add the label GitHub attaches automatically —
\`runs-on: [self-hosted, ${label}, macOS]\` (or \`Linux\`, or \`Windows\`). Without it the job goes
to whichever registered machine is free.

---
_Generated by [gh-runner](https://github.com/singerbj/gh-runner)_
`;
}
