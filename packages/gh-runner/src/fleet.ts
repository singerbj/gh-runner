import type { ChildProcess } from "node:child_process";
import { DEFAULT_LABEL } from "./constants.js";
import { CliError, InterruptedError } from "./errors.js";
import { execCommand } from "./exec.js";
import { GhClient } from "./gh.js";
import type { OwnedRepo } from "./gh.js";
import { prefixLogger, silentLogger } from "./logger.js";
import { emptyOptions } from "./options.js";
import type { RunnerOptions } from "./options.js";
import { declineAll } from "./prompt.js";
import { ghRunner, planHost } from "./runner.js";
import type { RunContext, RunSummary } from "./runner.js";
import { githubWorkflows, inspectWorkflows } from "./workflows.js";
import type { WorkflowReport } from "./workflows.js";

/**
 * Serving every repo you own from one command.
 *
 * GitHub only lets a personal account register runners per repo — there is no
 * account-wide pool — so this registers one runner per repo per platform, and
 * finds the repos by reading their workflows on the default branch.
 *
 * Several machines doing this share the work without coordinating: each
 * registers its own runners with the same labels, and GitHub hands every
 * queued job to whichever matching runner is idle. A machine that goes away
 * deregisters, and its jobs go to the others; one that comes back registers
 * again and starts taking them.
 */

/** How often the repos are scanned again, for ones set up since. */
export const RESCAN_INTERVAL_MS = 10 * 60_000;

/** First wait before a repo whose runner failed is tried again; it doubles each time. */
export const RETRY_BASE_MS = 60_000;

/** Wait before a repo whose runner ended cleanly — `--once` — comes back up. */
const RESTART_MS = 5_000;

/** How many repos have their workflows read at once. */
const SCAN_CONCURRENCY = 4;

export interface FleetContext extends RunContext {
  /** Injected in tests. */
  rescanMs?: number;
  retryBaseMs?: number;
  /** Called after each scan, with the repos it decided to serve. */
  onScan?: (scan: RepoScan) => void;
}

export interface RepoScan {
  /** Repos this machine serves, sorted. */
  serve: string[];
  /** Repos skipped because they're public, and `allowPublic` wasn't given. */
  skippedPublic: string[];
  /** Repos whose workflows couldn't be read this time. */
  unreadable: string[];
  /** How many repos were looked at in all. */
  scanned: number;
}

export interface FleetResult {
  /** Every repo served at some point. */
  repos: string[];
  runners: RunSummary[];
}

/**
 * Whether a report shows a job this machine's runners would take: one whose
 * `runs-on` names a gh-runner label — directly or through a `GH_RUNNER_*`
 * variable — and nothing these runners don't carry.
 *
 * A bare `[self-hosted]` doesn't count. It would match, but it says nothing
 * about gh-runner, and a repo with its own runners shouldn't gain one of ours.
 */
export function usesGhRunner(report: WorkflowReport, customLabels: readonly string[]): boolean {
  const ours = new Set(customLabels.map((label) => label.toLowerCase()));
  return report.matches.some(
    (target) =>
      target.fallback !== undefined || target.labels.some((label) => ours.has(label.toLowerCase())),
  );
}

interface Session {
  abort: AbortController;
  children: Set<ChildProcess>;
  done: Promise<void>;
}

/**
 * Serves every repo that `options` selects until `context.signal` aborts:
 * `repos` as given, plus — with `allRepos` — every private repo of `owners`
 * (or yours) whose workflows send jobs to gh-runner.
 */
export async function ghRunnerFleet(
  partialOptions: Partial<RunnerOptions> = {},
  context: FleetContext = {},
): Promise<FleetResult> {
  const options: RunnerOptions = { ...emptyOptions(), ...partialOptions };
  const logger = context.logger ?? silentLogger;
  const { bold, dim, green } = logger.styles;
  const commandRunner = context.commandRunner ?? execCommand;
  const signal = context.signal;
  const gh = context.gh ?? new GhClient({ runner: commandRunner, ...(signal ? { signal } : {}) });
  const rescanMs = context.rescanMs ?? RESCAN_INTERVAL_MS;
  const retryBaseMs = context.retryBaseMs ?? RETRY_BASE_MS;

  if (!options.allRepos && options.repos.length === 0) {
    throw new CliError("nothing to serve — set allRepos, owners, or repos");
  }

  await gh.preflight();

  // One answer for every repo: the menu is asked once, not once per repo.
  const host = await planHost(options, context, logger);
  const platforms = host.targets.map((target) => target.os);
  const labelSets = host.runners.map((runner) => runner.allLabels);
  const customLabels = [
    ...new Set([DEFAULT_LABEL, ...host.runners.flatMap((runner) => runner.labels)]),
  ];

  const sessions = new Map<string, Session>();
  const failures = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const served = new Set<string>();
  const runners: RunSummary[] = [];
  /** Report per repo, reused while nothing has been pushed to it. */
  const reports = new Map<string, { pushedAt: string; uses: boolean }>();
  let wanted = new Set<string>();

  const aborted = () => signal?.aborted ?? false;

  const later = (ms: number, fn: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  const start = (repo: string) => {
    const abort = new AbortController();
    const onParentAbort = () => abort.abort(signal?.reason);
    signal?.addEventListener("abort", onParentAbort, { once: true });

    const children = new Set<ChildProcess>();
    const prefix = `[${repo}] `;
    const sessionContext: RunContext = {
      ...context,
      logger: prefixLogger(logger, prefix),
      outputPrefix: prefix,
      useCheckout: false,
      confirm: declineAll,
      signal: abort.signal,
      gh: context.gh ?? new GhClient({ runner: commandRunner, signal: abort.signal }),
      onRunnerSpawn: (child) => {
        children.add(child);
        child.once("exit", () => children.delete(child));
        context.onRunnerSpawn?.(child);
      },
    };
    delete sessionContext.selectPlatforms;

    const session: Session = { abort, children, done: Promise.resolve() };
    session.done = ghRunner(
      {
        ...options,
        repo,
        repos: [],
        allRepos: false,
        owners: [],
        platforms: platforms.map(String),
        all: false,
        fixWorkflows: "never",
      },
      sessionContext,
    )
      .then(
        (result) => {
          runners.push(...result.runners);
          failures.delete(repo);
          return RESTART_MS;
        },
        (error: unknown) => {
          if (error instanceof InterruptedError || abort.signal.aborted) return RESTART_MS;
          const count = (failures.get(repo) ?? 0) + 1;
          failures.set(repo, count);
          const wait = Math.min(retryBaseMs * 2 ** (count - 1), Math.max(rescanMs, retryBaseMs));
          logger.error(
            `${prefix}${error instanceof Error ? error.message : String(error)}\n` +
              `       ${dim(`trying ${repo} again in ${Math.round(wait / 1000)}s`)}`,
          );
          return wait;
        },
      )
      .then((wait) => {
        signal?.removeEventListener("abort", onParentAbort);
        sessions.delete(repo);
        if (!aborted() && wanted.has(repo)) later(wait, reconcile);
      });

    sessions.set(repo, session);
    served.add(repo);
  };

  const stop = (repo: string, session: Session) => {
    logger.say(`${bold(repo)} no longer sends jobs to gh-runner — taking its runner down`);
    session.abort.abort(new InterruptedError());
    // A native runner only hears Ctrl+C through the terminal; this one has to
    // be told. It exits — cancelling a job it was in the middle of — and is
    // deregistered on the way out.
    for (const child of session.children) child.kill("SIGINT");
  };

  function reconcile(): void {
    if (aborted()) return;
    for (const repo of wanted) {
      if (!sessions.has(repo)) start(repo);
    }
    for (const [repo, session] of sessions) {
      if (!wanted.has(repo) && !session.abort.signal.aborted) stop(repo, session);
    }
  }

  const scan = async (): Promise<RepoScan | null> => {
    const explicit = options.repos;
    if (!options.allRepos) {
      return { serve: [...explicit].toSorted(), skippedPublic: [], unreadable: [], scanned: 0 };
    }

    let owned: OwnedRepo[];
    try {
      const owners = options.owners.length > 0 ? options.owners : [undefined];
      const lists = await Promise.all(owners.map((owner) => gh.listRepos(owner)));
      const byName = new Map(lists.flat().map((repo) => [repo.fullName.toLowerCase(), repo]));
      owned = [...byName.values()];
    } catch (error) {
      if (aborted()) return null;
      logger.warn(
        `${error instanceof Error ? error.message : String(error)} — keeping the repos already served`,
      );
      return null;
    }

    const skippedPublic: string[] = [];
    const unreadable: string[] = [];
    const candidates = owned.filter((repo) => {
      if (repo.visibility === "PRIVATE" || repo.visibility === "INTERNAL") return true;
      if (options.allowPublic) return true;
      skippedPublic.push(repo.fullName);
      return false;
    });

    const serve = new Set(explicit);
    const queue = [...candidates];
    const worker = async () => {
      for (let repo = queue.shift(); repo; repo = queue.shift()) {
        if (aborted()) return;
        const cached = reports.get(repo.fullName);
        if (cached && cached.pushedAt === repo.pushedAt && repo.pushedAt !== "") {
          if (cached.uses) serve.add(repo.fullName);
          continue;
        }
        try {
          const report = await inspectWorkflows(githubWorkflows(gh, repo.fullName), labelSets);
          const uses = usesGhRunner(report, customLabels);
          reports.set(repo.fullName, { pushedAt: repo.pushedAt, uses });
          if (uses) serve.add(repo.fullName);
        } catch {
          unreadable.push(repo.fullName);
          // Still served if it was before: a blip shouldn't take a runner down.
          if (wanted.has(repo.fullName)) serve.add(repo.fullName);
        }
      }
    };
    await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
    if (aborted()) return null;

    return {
      serve: [...serve].toSorted(),
      skippedPublic: skippedPublic.toSorted(),
      unreadable: unreadable.toSorted(),
      scanned: owned.length,
    };
  };

  const report = (result: RepoScan, first: boolean) => {
    const added = result.serve.filter((repo) => !wanted.has(repo));
    if (!first && added.length === 0) return;
    if (first) {
      const where = options.owners.length > 0 ? options.owners.join(", ") : "your account";
      if (options.allRepos) {
        logger.say(
          `Scanned ${result.scanned} repo${result.scanned === 1 ? "" : "s"} on ${where}: ` +
            `${result.serve.length} send${result.serve.length === 1 ? "s" : ""} jobs to gh-runner`,
        );
      }
      for (const repo of result.serve) logger.raw(`    ${green("✓")} ${repo}\n`);
      if (result.skippedPublic.length > 0) {
        logger.raw(
          `    ${dim(`skipped ${result.skippedPublic.length} public repo${result.skippedPublic.length === 1 ? "" : "s"} — any fork could run code here; --allow-public to include them`)}\n`,
        );
      }
      if (result.serve.length === 0) {
        logger.raw(
          `    ${dim(`nothing to serve yet — run \`gh-runner setup\` in a repo and it is picked up within ${Math.round(rescanMs / 60_000)} min, or \`gh-runner --here\` to serve that repo now`)}\n`,
        );
      }
      return;
    }
    for (const repo of added) logger.say(`${green("New:")} ${bold(repo)} sends jobs to gh-runner`);
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (aborted()) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    });

  let first = true;
  while (!aborted()) {
    const result = await scan();
    if (result) {
      report(result, first);
      first = false;
      wanted = new Set(result.serve);
      context.onScan?.(result);
      reconcile();
    }
    await sleep(rescanMs);
  }

  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  await Promise.all([...sessions.values()].map((session) => session.done));

  return { repos: [...served].toSorted(), runners };
}
