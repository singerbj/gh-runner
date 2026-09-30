import { runnerVariable } from "./constants.js";
import type { GhClient } from "./gh.js";
import type { Logger } from "./logger.js";

/**
 * Moving jobs onto this machine when — and only when — a repo can't start
 * GitHub-hosted ones.
 *
 * The question can't be answered from inside a workflow. A job that asks needs
 * a runner to start on, and "GitHub won't start a hosted runner here" is the
 * one answer that job can never give — it just doesn't run. So `gh-runner`
 * asks from the outside, on the machine that is about to take the work, and
 * writes the answer into a repository variable per label (see
 * {@link runnerVariable}), which `runs-on` reads before anything is scheduled.
 *
 * It asks GitHub's own verdict rather than doing arithmetic on billing data.
 * Included minutes, budgets, spending limits and failed payments all end the
 * same way — a job that fails without starting, carrying an annotation that
 * says why — and that is what this looks for.
 */

/**
 * What GitHub says on a job it refused to start. Matched loosely: the exact
 * wording has changed before, and a job has to have failed without running a
 * single step, on no runner, before its annotations are even read.
 */
export const BILLING_BLOCK_PATTERN =
  /spending limit|payments? (?:have|has) failed|billing|out of (?:actions )?minutes/i;

/** How often a session checks, and re-asserts the variables it holds. */
export const CHECK_INTERVAL_MS = 120_000;

/** How many of this month's failed runs to look at on each check. */
const FAILED_RUNS_PER_CHECK = 30;

/** How many successful runs after a refusal to check for a hosted job that got through. */
const RECOVERY_RUNS = 10;

/**
 * Refused runs older than this aren't re-run. A day covers a runner that was
 * started the morning after, without resurrecting last week's CI for branches
 * nobody is looking at any more.
 */
export const RERUN_WINDOW_MS = 24 * 60 * 60 * 1000;

interface WorkflowRun {
  id: number;
  run_attempt?: number;
  status?: string | null;
  conclusion?: string | null;
  created_at?: string;
  /** `.github/workflows/ci.yml`, sometimes with `@ref` on the end. */
  path?: string;
  head_repository?: { full_name?: string } | null;
}

interface WorkflowJob {
  id: number;
  conclusion?: string | null;
  completed_at?: string | null;
  runner_name?: string | null;
  labels?: string[];
  steps?: unknown[];
}

interface Annotation {
  message?: string | null;
}

/** What one attempt of one run says about hosted runners. Completed attempts never change. */
interface RunVerdict {
  /** When GitHub refused to start a job for billing reasons, if it did. */
  refusedAt: number | null;
  /** When a job on a GitHub-hosted runner last finished successfully in it. */
  hostedOkAt: number | null;
}

export type HostedStatus =
  | { state: "blocked"; since: number; refusedRuns: number[] }
  | { state: "ok" }
  /** The API couldn't be read, so nothing should change. */
  | { state: "unknown"; reason: string };

export interface UsageCheckResult {
  status: HostedStatus;
  /** What the check did about it. */
  action: "set" | "cleared" | "none";
  rerun: number[];
}

export interface HostedUsageWatcherOptions {
  repo: string;
  gh: GhClient;
  /** A client that outlives an abort, so the variables still come down on Ctrl+C. */
  cleanupGh?: GhClient;
  logger: Logger;
  /** Labels this session serves; one variable is set for each while blocked. */
  labels: readonly string[];
  /**
   * Workflow files whose jobs read a runner variable. A refused run of any other
   * workflow would only be refused again, so it isn't re-run. Unset means every
   * workflow.
   */
  workflowFiles?: readonly string[];
  /** Injected in tests; defaults to `Date.now`. */
  now?: () => number;
  intervalMs?: number;
  /** Injected in tests; defaults to `setInterval`. */
  schedule?: (fn: () => void, ms: number) => { close: () => void };
}

/** Midnight UTC on the first of the month `at` falls in — when included minutes reset. */
export function startOfUtcMonth(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

const time = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const latest = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.max(a, b);

/**
 * A job GitHub never started: it failed, but no runner took it and not one
 * step ran. Jobs that fail for any ordinary reason have at least a runner.
 */
function neverStarted(job: WorkflowJob): boolean {
  return job.conclusion === "failure" && !job.runner_name && (!job.steps || job.steps.length === 0);
}

/** Our labels are never on a GitHub-hosted runner, and neither is `self-hosted`. */
function ranOnHosted(job: WorkflowJob, selfHostedLabels: ReadonlySet<string>): boolean {
  return (
    job.conclusion === "success" &&
    Boolean(job.runner_name) &&
    !(job.labels ?? []).some((label) => selfHostedLabels.has(label.toLowerCase()))
  );
}

/**
 * Decides whether GitHub-hosted runners can start jobs in a repo, and holds the
 * runner variables for this session's labels while they can't.
 *
 * - A job refused for billing reasons, with no hosted job succeeding after it,
 *   means blocked: the variables are set, and the refused runs from the last
 *   day are re-run so they land here instead.
 * - A hosted job succeeding after that means unblocked.
 * - So does a new month with no refusal in it yet: included minutes reset on
 *   the first. If hosted runners are still unavailable — a spending limit, a
 *   failed payment — the next job is refused, and the variables go straight
 *   back up with that run re-run.
 *
 * The variables mean "a gh-runner for this label is up, and hosted runners
 * aren't", so they come down when the session ends. With nobody running
 * `gh-runner`, every job goes back to GitHub-hosted: the repo never depends on
 * a self-hosted runner being there. They are re-asserted on every check, since
 * another session serving the same label may have taken them down on its way
 * out.
 *
 * Nothing changes on an answer it couldn't get: a failed API call leaves the
 * variables as they were, whichever way that is.
 */
export class HostedUsageWatcher {
  private readonly options: HostedUsageWatcherOptions;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly variables: Map<string, string>;
  private readonly selfHostedLabels: Set<string>;
  /** Verdicts by `runId:attempt` — a completed attempt is immutable, so each is read once. */
  private readonly verdicts = new Map<string, RunVerdict>();
  /** Runs this session has already asked GitHub to re-run. */
  private readonly rerun = new Set<number>();
  /**
   * The latest refusal this session has seen. Remembered, because a refused run
   * that is re-run and succeeds stops looking refused — and is still the reason
   * the variables are up.
   */
  private refusedAt: number | null = null;
  /** True while this session holds the variables up. */
  private holding = false;
  /** False until the first check has had an answer. */
  private settled = false;
  private timer: { close: () => void } | undefined;
  private running: Promise<UsageCheckResult> | undefined;
  private warned = false;

  constructor(options: HostedUsageWatcherOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS;
    this.variables = new Map(options.labels.map((label) => [runnerVariable(label), label]));
    this.selfHostedLabels = new Set([
      "self-hosted",
      ...options.labels.map((label) => label.toLowerCase()),
    ]);
  }

  /** The variables this session sets while blocked, and the label each one holds. */
  get variableNames(): string[] {
    return [...this.variables.keys()];
  }

  /** Checks once now, then on every interval until {@link stop}. */
  async start(): Promise<UsageCheckResult> {
    const first = await this.check();

    const schedule =
      this.options.schedule ??
      ((fn, ms) => {
        // Unreffed: the watcher should never be the reason the process stays up.
        const timer = setInterval(fn, ms);
        timer.unref();
        return { close: () => clearInterval(timer) };
      });
    this.timer = schedule(() => {
      void this.check();
    }, this.intervalMs);

    return first;
  }

  /** Stops checking and takes this session's variables down. Safe to call twice. */
  async stop(): Promise<void> {
    this.timer?.close();
    this.timer = undefined;
    await this.running?.catch(() => {});
    if (this.holding) await this.release(this.options.cleanupGh ?? this.options.gh);
  }

  /** One pass. Overlapping calls share the pass already in flight. */
  check(): Promise<UsageCheckResult> {
    this.running ??= this.checkOnce().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async checkOnce(): Promise<UsageCheckResult> {
    const now = this.now();
    const status = await this.hostedStatus(now);
    if (status.state === "unknown") return this.unknown(status.reason);
    this.warned = false;

    const { repo, gh, logger } = this.options;
    const { dim, yellow, green } = logger.styles;
    const line = (text: string) => logger.raw(`    ${text}\n`);
    const names = this.variableNames.join(", ");

    const first = !this.settled;
    this.settled = true;

    if (status.state === "ok") {
      // A session killed too hard to clean up — `kill -9`, a power cut — leaves
      // its variables set, and jobs queued behind a runner that isn't there.
      // The first session to come back and find hosted runners working takes
      // them down. A sibling that still needs one puts it back on its next check.
      if (first && !this.holding) {
        await this.release(gh);
        return { status, action: "none", rerun: [] };
      }
      if (!this.holding) return { status, action: "none", rerun: [] };
      await this.release(gh);
      line(
        `${green("✓")} GitHub-hosted runners are available to ${repo} again ${dim(`— cleared ${names}`)}`,
      );
      return { status, action: "cleared", rerun: [] };
    }

    // Re-asserted every time: a sibling session serving the same label takes
    // it down on its way out.
    let set = 0;
    for (const [name, label] of this.variables) {
      if (await gh.setVariable(repo, name, label)) set += 1;
    }
    if (set === 0) {
      // Nothing is pointing jobs here, so a re-run would only be refused again.
      return this.unknown(`couldn't set ${names} — that needs admin on ${repo}`);
    }

    const action = this.holding ? "none" : "set";
    if (!this.holding) {
      this.holding = true;
      line(
        `${yellow("!")} GitHub won't start hosted jobs in ${repo} ${dim(
          `(no minutes left, or a billing limit) — set ${names}, so they run here`,
        )}`,
      );
    }

    const rerun: number[] = [];
    for (const runId of status.refusedRuns) {
      if (this.rerun.has(runId)) continue;
      this.rerun.add(runId);
      if (await gh.rerunFailedJobs(repo, runId)) {
        rerun.push(runId);
        line(`${green("↻")} re-running refused run ${runId} ${dim("here")}`);
      }
    }

    return { status, action, rerun };
  }

  private async release(gh: GhClient): Promise<void> {
    this.holding = false;
    for (const name of this.variables.keys()) {
      await gh.deleteVariable(this.options.repo, name);
    }
  }

  /**
   * Blocked or not, from the runs themselves.
   *
   * Only this month counts, since that's when included minutes last reset. A
   * refusal keeps the repo blocked until a hosted job gets through after it.
   */
  async hostedStatus(now: number): Promise<HostedStatus> {
    const since = startOfUtcMonth(now);
    const failed = await this.listRuns(since, "failure", FAILED_RUNS_PER_CHECK);
    if (failed === null) return { state: "unknown", reason: "couldn't list workflow runs" };

    let lastRefusal = this.refusedAt !== null && this.refusedAt >= since ? this.refusedAt : null;
    const refused: Array<{ run: WorkflowRun; at: number }> = [];

    for (const run of failed) {
      if (run.status !== "completed") continue;
      const verdict = await this.verdict(run);
      if (verdict === null) return { state: "unknown", reason: `couldn't read run ${run.id}` };
      if (verdict.refusedAt === null) continue;
      lastRefusal = latest(lastRefusal, verdict.refusedAt);
      refused.push({ run, at: verdict.refusedAt });
    }

    if (lastRefusal === null) {
      this.refusedAt = null;
      return { state: "ok" };
    }

    // Did anything get through on a hosted runner after that?
    const succeeded = await this.listRuns(lastRefusal, "success", RECOVERY_RUNS);
    if (succeeded === null) return { state: "unknown", reason: "couldn't list workflow runs" };
    for (const run of succeeded) {
      const verdict = await this.verdict(run);
      if (verdict === null) return { state: "unknown", reason: `couldn't read run ${run.id}` };
      if (verdict.hostedOkAt !== null && verdict.hostedOkAt > lastRefusal) {
        this.refusedAt = null;
        return { state: "ok" };
      }
    }

    this.refusedAt = lastRefusal;
    const cutoff = Math.max(now - RERUN_WINDOW_MS, since);
    const files = this.options.workflowFiles;
    return {
      state: "blocked",
      since: lastRefusal,
      refusedRuns: refused
        .filter(({ run, at }) => {
          // A run from a fork is someone else's code. Re-running it here is a
          // decision for a person, not for a heartbeat.
          const ours =
            run.head_repository?.full_name?.toLowerCase() === this.options.repo.toLowerCase();
          const moves = !files || files.includes((run.path ?? "").split("@")[0] ?? "");
          return ours && moves && at >= cutoff;
        })
        .map(({ run }) => run.id),
    };
  }

  private async listRuns(
    since: number,
    status: "failure" | "success",
    perPage: number,
  ): Promise<WorkflowRun[] | null> {
    const created = encodeURIComponent(`>=${new Date(since).toISOString()}`);
    const body = await this.json<{ workflow_runs?: WorkflowRun[] }>(
      `repos/${this.options.repo}/actions/runs?status=${status}&per_page=${perPage}&created=${created}`,
    );
    return body && Array.isArray(body.workflow_runs) ? body.workflow_runs : null;
  }

  /** What a completed run's latest attempt says, or null when it couldn't be read. */
  private async verdict(run: WorkflowRun): Promise<RunVerdict | null> {
    const key = `${run.id}:${run.run_attempt ?? 1}`;
    const cached = this.verdicts.get(key);
    if (cached) return cached;

    const body = await this.json<{ jobs?: WorkflowJob[] }>(
      `repos/${this.options.repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
    );
    if (!body || !Array.isArray(body.jobs)) return null;

    let refusedAt: number | null = null;
    let hostedOkAt: number | null = null;

    for (const job of body.jobs) {
      if (ranOnHosted(job, this.selfHostedLabels)) {
        hostedOkAt = latest(hostedOkAt, time(job.completed_at));
      }
      if (!neverStarted(job)) continue;

      const annotations = await this.json<Annotation[]>(
        `repos/${this.options.repo}/check-runs/${job.id}/annotations`,
      );
      if (!Array.isArray(annotations)) return null;
      if (annotations.some((note) => BILLING_BLOCK_PATTERN.test(note.message ?? ""))) {
        refusedAt = latest(refusedAt, time(job.completed_at) ?? time(run.created_at));
      }
    }

    const verdict = { refusedAt, hostedOkAt };
    this.verdicts.set(key, verdict);
    return verdict;
  }

  private async json<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await this.options.gh.api(path)) as T;
    } catch {
      return null;
    }
  }

  private unknown(reason: string): UsageCheckResult {
    // Once per outage, not once per heartbeat.
    if (!this.warned) {
      this.warned = true;
      const { dim } = this.options.logger.styles;
      this.options.logger.raw(
        `    ${dim(`! couldn't check whether GitHub-hosted runners are available (${reason}) — changing nothing`)}\n`,
      );
    }
    return { status: { state: "unknown", reason }, action: "none", rerun: [] };
  }
}
