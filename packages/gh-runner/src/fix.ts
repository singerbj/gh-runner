import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_PATH,
  ACTION_REPO,
  DEFAULT_LABEL,
  FIX_BRANCH_PREFIX,
  HOSTED_PROBE_RUNS_ON,
  PROBE_RUNS_ON_VAR,
  SELF_HOSTED_ONLY_PROBE_RUNS_ON,
  SELF_HOSTED_PROBE_RUNS_ON,
  actionRef,
  osLabel,
  probeKey,
} from "./constants.js";
import { CliError } from "./errors.js";
import { CommandFailedError, execCapture } from "./exec.js";
import type { CommandRunner, ExecOptions } from "./exec.js";
import type { GhClient } from "./gh.js";
import type { Logger } from "./logger.js";
import { MARKER_MAX_AGE_SECONDS } from "./markers.js";
import { assertLabel } from "./options.js";
import { readVersion } from "./version.js";
import {
  PROBE_JOB_ID,
  applyWorkflowFix,
  hostedRunnerOs,
  inspectWorkflows,
  listWorkflowFiles,
} from "./workflows.js";
import type { RunsOnFix, RunsOnTarget } from "./workflows.js";

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

/** The probe job's own `runs-on` for the mode this run was asked for. */
function probeRunsOnFor(selfHostedProbe: boolean, noHostedFallback: boolean): string {
  if (noHostedFallback) return SELF_HOSTED_ONLY_PROBE_RUNS_ON;
  return selfHostedProbe ? SELF_HOSTED_PROBE_RUNS_ON : HOSTED_PROBE_RUNS_ON;
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
  /**
   * Let the probe job run on a self-hosted runner too, by reading
   * {@link PROBE_RUNS_ON_VAR}. Off by default: the probe job is the one job
   * that has to start for the rest to be scheduled at all, so it takes the
   * runner that is always there unless asked otherwise.
   */
  selfHostedProbe?: boolean;
  /**
   * Never name a GitHub-hosted runner in the rewritten workflows: every job
   * falls back to the self-hosted labels it prefers, so it queues until a runner
   * is up instead of resolving to one the repo may not be able to start.
   *
   * Implies {@link selfHostedProbe} — the probe job is the one every other job
   * waits on, so leaving it hosted would fail the workflow before any of the
   * fallbacks below could matter.
   */
  noHostedFallback?: boolean;
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
  /** The label the job prefers, alongside `self-hosted`. */
  label: string;
  /** The labels the job used to ask for, and still falls back to, e.g. `["macos-14"]`. */
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
      /** True when the PR also moves the probe job off GitHub-hosted runners. */
      selfHostedProbe: boolean;
      /** True when the PR leaves no GitHub-hosted runner named anywhere. */
      noHostedFallback: boolean;
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

    const noHostedFallback = options.noHostedFallback ?? false;
    // The probe job is the one every other job waits on. Leaving it on a hosted
    // runner would fail the workflow before any fallback below could matter, so
    // asking for no hosted runners asks for this too.
    const selfHostedProbe = noHostedFallback || (options.selfHostedProbe ?? false);

    // A repo fixed by an earlier run may have nothing left to repoint and still
    // need this PR: its probe job, or the runner its jobs fall back to, can have
    // been written the other way round. Rather than predict which, apply the
    // plan to every workflow and keep the files it actually changes — so
    // re-running the fix is how you switch a repo between the modes.
    if (wanted.length === 0 && !report.verdicts.some((verdict) => verdict.target.probe)) {
      return { status: "no-changes" };
    }

    const byFile = new Map<string, RunsOnTarget[]>();
    for (const target of wanted) {
      byFile.set(target.file, [...(byFile.get(target.file) ?? []), target]);
    }

    // A tag can be repointed; the commit it names today can't. Resolving it
    // here means the workflow this PR edits pins the action the same way this
    // repo pins the ones it consumes.
    const uses = await resolveActionRef(gh);

    const files: string[] = [];
    for (const name of (await listWorkflowFiles(worktree)) ?? []) {
      const file = `.github/workflows/${name}`;
      const path = join(worktree, file);
      const source = await readFile(path, "utf8");
      const fixes: RunsOnFix[] = (byFile.get(file) ?? []).map((target) => {
        const label = labelFor(target);
        return { target, key: probeKey(label), labels: ["self-hosted", label] };
      });

      const output = applyWorkflowFix(source, {
        jobId: PROBE_JOB_ID,
        actionRef: uses,
        fixes,
        probeRunsOn: probeRunsOnFor(selfHostedProbe, noHostedFallback),
        noHostedFallback,
      });
      if (output === source) continue;

      await writeFile(path, output);
      files.push(file);
    }

    if (files.length === 0) {
      return { status: "no-changes" };
    }

    const mode: ProbeMode = { selfHostedProbe, noHostedFallback };
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
        commitMessage(jobs, mode),
      ],
      {
        cwd: worktree,
      },
    );

    const done = { branch, base, files, jobs, selfHostedProbe, noHostedFallback };

    if (options.dryRun) {
      return { status: "dry-run", url: null, ...done };
    }

    await git(["push", "--quiet", "-u", "origin", branch], { cwd: worktree });

    const url = await gh.createPullRequest({
      repo,
      base,
      head: branch,
      title: pullRequestTitle(jobs, mode),
      body: pullRequestBody(jobs, mode),
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

/**
 * The `uses:` to write for the probe action.
 *
 * This version's own tag, resolved to the commit it points at. A build running
 * ahead of its release — a local checkout, a version whose tag was deleted —
 * would otherwise write a ref that doesn't contain the action at all, so the
 * tag is only used once the action has been seen there. Failing that, the
 * default branch: a mutable ref is worse than a pinned one, and better than a
 * workflow that can't resolve its action.
 */
async function resolveActionRef(gh: GhClient): Promise<string> {
  const version = readVersion();
  const tag = `v${version}`;
  const sha = await gh.tagSha(ACTION_REPO, tag);

  if (sha && (await gh.pathExists(ACTION_REPO, sha, `${ACTION_PATH}/action.yml`))) {
    return actionRef(version, sha);
  }

  const base = await gh.defaultBranch(ACTION_REPO).catch(() => "main");
  return `${ACTION_REPO}/${ACTION_PATH}@${base}`;
}

/** The distinct labels the rewrite writes, in the order jobs first ask for them. */
export function fixLabels(jobs: readonly FixedJob[]): string[] {
  return [...new Set(jobs.map((entry) => entry.label))];
}

/** Which of the three ways a run was asked to write the workflow. */
interface ProbeMode {
  selfHostedProbe: boolean;
  noHostedFallback: boolean;
}

/** What a job falls through to when no runner is online, in prose. */
function fallbackOf({ label, from }: FixedJob, mode: ProbeMode): string {
  if (mode.noHostedFallback) return `[self-hosted, ${label}]`;
  return from.length > 0 ? from.join(", ") : "its current runner";
}

function jobList(jobs: readonly FixedJob[], mode: ProbeMode): string {
  return jobs
    .map((entry) => {
      const target = `\`[self-hosted, ${entry.label}]\``;
      return mode.noHostedFallback
        ? `- \`${entry.job}\` in \`${entry.file}\` → ${target} ${`(was \`${entry.from.join(", ") || "its current runner"}\`)`}`
        : `- \`${entry.job}\` in \`${entry.file}\` → ${target}, else \`${fallbackOf(entry, mode)}\``;
    })
    .join("\n");
}

function commitMessage(jobs: readonly FixedJob[], mode: ProbeMode): string {
  const labels = fixLabels(jobs);

  const answer = mode.noHostedFallback
    ? "the self-hosted labels either way, so a job waits for a runner instead of"
    : "the self-hosted labels when a machine is registered, and otherwise";
  const otherwise = mode.noHostedFallback
    ? "falling back to a GitHub-hosted runner."
    : "exactly the runner it uses today.";

  const probeOnly = mode.noHostedFallback
    ? [
        "Nothing in these workflows names a GitHub-hosted runner any more.",
        `The ${PROBE_JOB_ID} job asks for the self-hosted labels outright, and`,
        "every job it picks runners for queues rather than falling back.",
      ]
    : [
        `The ${PROBE_JOB_ID} job now takes its own runs-on from the`,
        `${PROBE_RUNS_ON_VAR} repository variable, which gh-runner sets`,
        "while a runner is online.",
      ];

  const body =
    jobs.length === 0
      ? probeOnly
      : [
          `A ${PROBE_JOB_ID} job asks which runners are up, and each job's`,
          `runs-on reads the answer: ${answer}`,
          otherwise,
          "",
          ...labels.map((label) => `  ${label}: ${jobsFor(jobs, label).join(", ")}`),
        ];

  return [pullRequestTitle(jobs, mode), "", ...body, "", "Generated by gh-runner."].join("\n");
}

function jobsFor(jobs: readonly FixedJob[], label: string): string[] {
  return jobs.filter((entry) => entry.label === label).map((entry) => entry.job);
}

function pullRequestTitle(jobs: readonly FixedJob[], mode: ProbeMode): string {
  if (jobs.length === 0) {
    if (mode.noHostedFallback) return `Stop using GitHub-hosted runners in these workflows`;
    return mode.selfHostedProbe
      ? `Run the ${PROBE_JOB_ID} job on a self-hosted runner too`
      : `Run the ${PROBE_JOB_ID} job on a GitHub-hosted runner`;
  }
  const count = `${jobs.length} job${jobs.length === 1 ? "" : "s"}`;
  return mode.noHostedFallback
    ? `Move ${count} onto self-hosted runners only`
    : `Use a self-hosted runner for ${count} when one is online`;
}

function pullRequestBody(jobs: readonly FixedJob[], mode: ProbeMode): string {
  const minutes = Math.round(MARKER_MAX_AGE_SECONDS / 60);

  const lead = mode.noHostedFallback
    ? `Each of these jobs now runs on a self-hosted runner, and waits for one when none is online:`
    : `Each of these jobs now runs on a self-hosted runner when one is online, and on exactly the
runner it uses today when none is:`;

  const repointed =
    jobs.length === 0
      ? `## What this changes

The \`${PROBE_JOB_ID}\` job stops being pinned to a GitHub-hosted runner. Nothing else moves —
the jobs it already picks runners for are unchanged.
`
      : `## What this changes

${lead}

${jobList(jobs, mode)}

Picking between the two is a \`${PROBE_JOB_ID}\` job. It runs
[\`${ACTION_REPO}/${ACTION_PATH}\`](https://github.com/${ACTION_REPO}/tree/main/${ACTION_PATH}),
which needs nothing but \`contents: read\` and the built-in \`GITHUB_TOKEN\` — there is no secret to
add and no token to rotate.

Each job keeps the platform it had: a \`macos-*\` job asks for \`${osLabel("osx")}\`, \`ubuntu-*\` for
\`${osLabel("linux")}\`, \`windows-*\` for \`${osLabel("win")}\`. A job whose image doesn't name an OS gets the
generic \`${DEFAULT_LABEL}\` label, which any registered machine answers.
`;

  const staleMarker = mode.noHostedFallback
    ? `A marker that stops being re-stamped is ignored after ${minutes} minutes, so a laptop that
closes mid-session leaves the next run queued until a runner is back — which is what this PR asks
for.`
    : `A marker that stops being re-stamped is ignored after ${minutes} minutes,
so a laptop that closes mid-session sends the next run back to GitHub-hosted rather than leaving
it queued.`;

  const failure = mode.noHostedFallback
    ? `- **It fails closed, by design.** A broken token, an API error, or no runner online all leave
  these jobs queued rather than sending them to a GitHub-hosted runner. That is the point — a repo
  that can't start hosted runners gets nothing from a fallback onto them — but it does mean CI
  needs someone running \`gh-runner\` to make progress. Re-run
  \`gh-runner --fix-workflows\` without \`--no-hosted-fallback\` to put the hosted fallbacks back.`
    : `- It fails open. A broken token, an API error, or no runner online all resolve to the fallback
  above, so a merged version of this can't leave your CI waiting on hardware nobody has started.`;

  return `${repointed}${probeRunnerSection(mode)}
## How it knows

[\`gh-runner\`](https://www.npmjs.com/package/@singerbj/gh-runner) registers a developer machine as an
ephemeral self-hosted runner, and while it is up it publishes a ref under
\`refs/gh-runner/online/\` and re-stamps it every couple of minutes. The probe job reads those refs.

Asking GitHub directly which runners are online needs repo admin, and no \`GITHUB_TOKEN\` can be
granted it — hence the refs. ${staleMarker}

## Before you merge

${probeCaveat(mode)}
${failure}
- Nothing here makes a job *require* your machine. To do that, ask for the labels directly:
  \`runs-on: [self-hosted, ${DEFAULT_LABEL}]\`.

---
_Generated by [gh-runner](https://github.com/singerbj/gh-runner)_
`;
}

/** Where the probe job itself runs, and why. */
function probeRunnerSection(mode: ProbeMode): string {
  if (mode.noHostedFallback) {
    return `
## Where the probe runs

\`runs-on: ${SELF_HOSTED_ONLY_PROBE_RUNS_ON}\`

Named outright, with no fallback and no repository variable: there is nothing left to choose
between once GitHub-hosted runners are off the table. The probe job queues until a runner is up,
and so does everything downstream of it.

This is the mode for a repo that *cannot* use GitHub-hosted runners — a spending limit, a failed
payment, a disabled billing account. Falling back to a runner the repo can't start isn't a safety
net; it's the same failure with an extra step.
`;
  }

  if (!mode.selfHostedProbe) {
    return `
## Where the probe runs

On \`${HOSTED_PROBE_RUNS_ON}\`. It is the one job that has to start before any of the others can be
scheduled, so it takes the runner that is always there.

If GitHub-hosted runners aren't available to this repo — a spending limit, a failed payment — that
makes this job, and so the whole workflow, fail. Re-run \`gh-runner --fix-workflows
--self-hosted-probe\` to have it prefer your own machine instead.
`;
  }

  return `
## Where the probe runs

\`runs-on: ${SELF_HOSTED_PROBE_RUNS_ON}\`

\`gh-runner\` sets the \`${PROBE_RUNS_ON_VAR}\` repository variable while a runner is online and
deletes it on the way out, so the probe job runs on your machine whenever one is up and on
\`${HOSTED_PROBE_RUNS_ON}\` when none is. Nothing in the workflow then needs a GitHub-hosted runner,
which is what makes this work under a spending limit or a failed payment.

\`runs-on\` is resolved before any job starts, so it can't read the probe job's own output — a
repository variable is the only thing a runner can set that it can read.
`;
}

/** The line about the probe job in "Before you merge". */
function probeCaveat(mode: ProbeMode): string {
  if (mode.noHostedFallback) {
    return `- The probe adds a few seconds to every run, and it needs a runner like any other job.`;
  }

  if (!mode.selfHostedProbe) {
    return `- The probe adds a few seconds to every run, and it runs on a GitHub-hosted runner.`;
  }

  return `- The probe adds a few seconds to every run.
- A repository variable has no expiry, unlike the markers below. A runner killed hard enough to
  skip its own cleanup — \`kill -9\`, a laptop losing power — leaves \`${PROBE_RUNS_ON_VAR}\` set,
  and the probe job then queues until a runner is back or you delete the variable. Deleting it is
  always safe: the next run falls back to \`${HOSTED_PROBE_RUNS_ON}\`.`;
}
