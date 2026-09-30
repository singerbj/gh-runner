import { HOSTED_BLOCKED_VAR } from "./constants.js";
import type { GhClient } from "./gh.js";
import type { Logger } from "./logger.js";
import { HEARTBEAT_INTERVAL_MS } from "./markers.js";

/**
 * Watching for a repo that has run out of GitHub-hosted minutes.
 *
 * The question can't be answered from inside a workflow. A job that asks needs
 * a runner to start on, and "GitHub won't start a hosted runner here" is the
 * one answer that job can never give — it just doesn't run. So `gh-runner`
 * asks from the outside, on the machine that is about to take the work, and
 * writes the answer into {@link HOSTED_BLOCKED_VAR}, which `runs-on` reads
 * before anything is scheduled.
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

/** How many recent runs to look at on each check. */
const RUNS_PER_CHECK = 30;

/** How many runs after a refusal to check for a hosted job that got through. */
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
  head_repository?: { full_name?: string } | null;
}

interface WorkflowJob {
  id: number;
  status?: string | null;
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
  logger: Logger;
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

function ranOnHosted(job: WorkflowJob): boolean {
  return (
    job.conclusion === "success" &&
    Boolean(job.runner_name) &&
    !(job.labels ?? []).some((label) => label.toLowerCase() === "self-hosted")
  );
}

/**
 * Decides whether GitHub-hosted runners can start jobs in a repo, and keeps
 * {@link HOSTED_BLOCKED_VAR} in step with the answer.
 *
 * - A job refused for billing reasons, with no hosted job succeeding after it,
 *   means blocked: the variable is set, and the refused runs from the last day
 *   are re-run so they land on the self-hosted runner instead.
 * - A hosted job succeeding after the variable was set means unblocked.
 * - So does a new month with no refusal in it yet: included minutes reset on
 *   the first. If hosted runners are still unavailable — a spending limit, a
 *   failed payment — the next job is refused and the variable goes straight
 *   back up, with that run re-run.
 *
 * Nothing changes on an answer it couldn't get. A failed API call leaves the
 * variable exactly as it was, whichever way that is.
 *
 * Unlike the marker refs and the probe variable, the variable is *not* taken
 * down when the session ends. It says something about the repo's billing, not
 * about this machine, and a job queued for a self-hosted runner is a better
 * outcome than one GitHub refuses outright.
 */
export class HostedUsageWatcher {
  private readonly options: HostedUsageWatcherOptions;
  private readonly now: () => number;
  private readonly intervalMs: number;
  /** Verdicts by `runId:attempt` — a completed attempt is immutable, so each is read once. */
  private readonly verdicts = new Map<string, RunVerdict>();
  /** Runs this session has already asked GitHub to re-run. */
  private readonly rerun = new Set<number>();
  private timer: { close: () => void } | undefined;
  private running: Promise<UsageCheckResult> | undefined;
  private warned = false;

  constructor(options: HostedUsageWatcherOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  }

  /** Checks once now, then on every interval until {@link stop}. */
  async start(): Promise<UsageCheckResult> {
    const first = await this.check();

    const schedule =
      this.options.schedule ??
      ((fn, ms) => {
        const timer = setInterval(fn, ms);
        timer.unref();
        return { close: () => clearInterval(timer) };
      });
    this.timer = schedule(() => {
      void this.check();
    }, this.intervalMs);

    return first;
  }

  stop(): void {
    this.timer?.close();
    this.timer = undefined;
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
    const variable = await this.readVariable();
    if (variable.state === "error") {
      return this.unknown(`couldn't read ${HOSTED_BLOCKED_VAR}: ${variable.reason}`);
    }

    const status = await this.hostedStatus(now, variable.value);
    if (status.state === "unknown") return this.unknown(status.reason);

    const { repo, gh, logger } = this.options;
    const { dim, yellow, green } = logger.styles;
    const line = (text: string) => logger.raw(`    ${text}\n`);

    if (status.state === "blocked") {
      let action: UsageCheckResult["action"] = "none";

      if (variable.value === null) {
        if (!(await gh.setVariable(repo, HOSTED_BLOCKED_VAR, new Date(now).toISOString()))) {
          return this.unknown(`couldn't set ${HOSTED_BLOCKED_VAR} — it needs admin on ${repo}`);
        }
        action = "set";
        line(
          `${yellow("!")} GitHub won't start hosted jobs in ${repo} ${dim(
            `(no minutes left, or a billing limit) — set ${HOSTED_BLOCKED_VAR}, so jobs run here instead`,
          )}`,
        );
      }

      // Only runs refused before the variable went up: a job refused after it is
      // one that never reads it, and a re-run would only be refused again.
      const rerun: number[] = [];
      for (const runId of status.refusedRuns) {
        if (this.rerun.has(runId)) continue;
        this.rerun.add(runId);
        if (await gh.rerunFailedJobs(repo, runId)) {
          rerun.push(runId);
          line(`${green("↻")} re-running refused run ${runId} ${dim("on the self-hosted runner")}`);
        }
      }

      this.warned = false;
      return { status, action, rerun };
    }

    if (variable.value !== null) {
      await gh.deleteVariable(repo, HOSTED_BLOCKED_VAR);
      line(
        `${green("✓")} GitHub-hosted runners are available to ${repo} again ${dim(
          `— cleared ${HOSTED_BLOCKED_VAR}`,
        )}`,
      );
      this.warned = false;
      return { status, action: "cleared", rerun: [] };
    }

    this.warned = false;
    return { status, action: "none", rerun: [] };
  }

  /**
   * Blocked or not, from the runs themselves.
   *
   * Only this month counts, since that's when included minutes last reset. A
   * variable set in an earlier month is therefore dropped unless there's a
   * refusal this month too — and a refusal as late as the one that set it
   * keeps it up until a hosted job gets through after it.
   */
  async hostedStatus(now: number, variableValue: string | null = null): Promise<HostedStatus> {
    const since = startOfUtcMonth(now);
    const runs = await this.listRuns(since);
    if (runs === null) return { state: "unknown", reason: "couldn't list workflow runs" };

    const completed = runs.filter((run) => run.status === "completed");

    let lastRefusal: number | null = null;
    const refusedRuns: Array<{ id: number; at: number; ours: boolean }> = [];

    for (const run of completed) {
      if (run.conclusion !== "failure") continue;
      const verdict = await this.verdict(run);
      if (verdict === null) return { state: "unknown", reason: `couldn't read run ${run.id}` };
      if (verdict.refusedAt === null) continue;

      lastRefusal = latest(lastRefusal, verdict.refusedAt);
      refusedRuns.push({
        id: run.id,
        at: verdict.refusedAt,
        ours: run.head_repository?.full_name?.toLowerCase() === this.options.repo.toLowerCase(),
      });
    }

    // A variable set this month is itself evidence of a refusal — possibly one
    // whose run has since been deleted, or that fell off the first page. One
    // set by hand to something that isn't a time counts from the start of the
    // month, so a hosted job getting through still clears it.
    const setAt = variableValue === null ? null : (time(variableValue) ?? since);
    const evidence = latest(lastRefusal, setAt !== null && setAt >= since ? setAt : null);
    if (evidence === null) return { state: "ok" };

    // Did anything get through on a hosted runner after that?
    let hostedOk: number | null = null;
    const after = completed
      .filter((run) => run.conclusion === "success" && (time(run.created_at) ?? 0) >= evidence)
      .slice(0, RECOVERY_RUNS);
    for (const run of after) {
      const verdict = await this.verdict(run);
      if (verdict === null) return { state: "unknown", reason: `couldn't read run ${run.id}` };
      hostedOk = latest(hostedOk, verdict.hostedOkAt);
    }
    if (hostedOk !== null && hostedOk > evidence) return { state: "ok" };

    const cutoff = Math.max(now - RERUN_WINDOW_MS, since);
    return {
      state: "blocked",
      since: evidence,
      refusedRuns: refusedRuns
        // A run from a fork is someone else's code. Re-running it here is a
        // decision for a person, not for a heartbeat.
        .filter((run) => run.ours && run.at >= cutoff && (setAt === null || run.at <= setAt))
        .map((run) => run.id),
    };
  }

  private async listRuns(since: number): Promise<WorkflowRun[] | null> {
    const created = encodeURIComponent(`>=${new Date(since).toISOString()}`);
    const body = await this.json<{ workflow_runs?: WorkflowRun[] }>(
      `repos/${this.options.repo}/actions/runs?per_page=${RUNS_PER_CHECK}&created=${created}`,
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
      if (ranOnHosted(job)) hostedOkAt = latest(hostedOkAt, time(job.completed_at));
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

  private async readVariable(): Promise<
    { state: "ok"; value: string | null } | { state: "error"; reason: string }
  > {
    const value = await this.options.gh.getVariable(this.options.repo, HOSTED_BLOCKED_VAR);
    if (value === undefined) return { state: "error", reason: "API error" };
    return { state: "ok", value: value === "" ? null : value };
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
        `    ${dim(`! couldn't check whether hosted runners are available (${reason}) — leaving ${HOSTED_BLOCKED_VAR} as it is`)}\n`,
      );
    }
    return { status: { state: "unknown", reason }, action: "none", rerun: [] };
  }
}
