import { PROBE_RUNS_ON_VALUE, PROBE_RUNS_ON_VAR } from "./constants.js";
import type { GhClient } from "./gh.js";
import type { Logger } from "./logger.js";
import { HEARTBEAT_INTERVAL_MS, markerRef } from "./markers.js";

export interface MarkerPublisherOptions {
  repo: string;
  /** Labels this session is serving, e.g. `gh-runner`, `gh-runner-linux`. */
  labels: readonly string[];
  gh: GhClient;
  /** A client that outlives an abort, so the markers still come down on Ctrl+C. */
  cleanupGh: GhClient;
  logger: Logger;
  /**
   * Also publish {@link PROBE_RUNS_ON_VAR}, so a workflow whose probe job reads
   * it runs that job here instead of on a GitHub-hosted runner. Off unless the
   * repo's workflows actually ask for it.
   */
  probeVariable?: boolean;
  /** Injected in tests; defaults to `Date.now`. */
  now?: () => number;
  intervalMs?: number;
  /** Injected in tests; defaults to `setInterval`. */
  schedule?: (fn: () => void, ms: number) => { close: () => void };
}

/**
 * Publishes "this runner is online" as refs a workflow can read.
 *
 * A workflow can't ask GitHub which runners are up — that needs repo admin, and
 * no `GITHUB_TOKEN` can be granted it — so the runner says so itself, under
 * `refs/gh-runner/online/<label>/<unix-seconds>`.
 *
 * The stamp is re-published on a timer rather than written once, so a session
 * that dies without cleaning up stops counting as online a few minutes later
 * instead of sending jobs to a machine that isn't there.
 */
export class MarkerPublisher {
  private readonly options: MarkerPublisherOptions;
  private readonly now: () => number;
  private readonly intervalMs: number;
  /** Refs currently published, so a heartbeat knows what to take down. */
  private published = new Set<string>();
  private timer: { close: () => void } | undefined;
  private sha: string | undefined;
  private warned = false;
  /** True once the probe variable is up, so `stop` knows to take it down. */
  private variablePublished = false;
  private variableWarned = false;

  constructor(options: MarkerPublisherOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  }

  /** True once at least one marker is up; false when publishing isn't possible. */
  async start(base: string): Promise<boolean> {
    const { repo, gh } = this.options;

    // Any commit will do — nothing reads the object, only the ref's name. The
    // default branch tip is one that certainly exists and is never garbage.
    this.sha = (await gh.defaultBranchSha(repo, base)) ?? undefined;
    if (!this.sha) {
      this.warn("couldn't resolve a commit to point markers at");
      return false;
    }

    const up = await this.publish();
    if (!up) return false;

    const schedule =
      this.options.schedule ??
      ((fn, ms) => {
        // Unreffed: the heartbeat should never be the reason the process stays up.
        const timer = setInterval(fn, ms);
        timer.unref();
        return { close: () => clearInterval(timer) };
      });

    this.timer = schedule(() => {
      void this.publish();
    }, this.intervalMs);

    return true;
  }

  /** Stamps a fresh marker for every label and removes the previous stamps. */
  private async publish(): Promise<boolean> {
    const { repo, gh, labels } = this.options;
    const sha = this.sha;
    if (!sha) return false;

    const at = Math.floor(this.now() / 1000);
    const stale = this.published;
    const fresh = new Set<string>();

    for (const label of labels) {
      const ref = markerRef(label, at);
      if (!ref) continue;
      if (await gh.createRef(repo, ref, sha)) fresh.add(ref);
    }

    if (fresh.size === 0) {
      // Writing a ref needs push access. Say so once: the runner still works,
      // it just won't be picked up by a workflow that waits to be told.
      this.warn("couldn't publish runner markers — jobs will use their hosted fallback");
      return false;
    }

    this.published = fresh;
    for (const ref of stale) {
      if (!fresh.has(ref)) await gh.deleteRef(repo, ref);
    }

    await this.publishVariable();

    return true;
  }

  /**
   * Re-asserts the probe variable on every beat rather than setting it once.
   *
   * Two sessions can overlap, and the one that stops first takes the variable
   * down; re-publishing puts it back within a heartbeat instead of leaving the
   * survivor's probe job on a hosted runner for the rest of the day.
   */
  private async publishVariable(): Promise<void> {
    if (!this.options.probeVariable) return;

    const { repo, gh } = this.options;
    if (await gh.setVariable(repo, PROBE_RUNS_ON_VAR, PROBE_RUNS_ON_VALUE)) {
      this.variablePublished = true;
      return;
    }

    // Variables need admin on the repo — the same rights a registration token
    // already needed, so this is usually a token scope rather than a permission.
    if (this.variableWarned) return;
    this.variableWarned = true;
    this.options.logger.raw(
      `    ${this.options.logger.styles.dim(
        `! couldn't set ${PROBE_RUNS_ON_VAR} — the probe job will use a GitHub-hosted runner`,
      )}\n`,
    );
  }

  /** Takes every marker down. Safe to call twice, and after an abort. */
  async stop(): Promise<void> {
    this.timer?.close();
    this.timer = undefined;

    const refs = [...this.published];
    this.published = new Set();

    for (const ref of refs) {
      await this.options.cleanupGh.deleteRef(this.options.repo, ref);
    }

    // Before the markers would have aged out, because nothing ages this one
    // out: a probe job that still believes in this machine waits for it.
    if (this.variablePublished) {
      this.variablePublished = false;
      await this.options.cleanupGh.deleteVariable(this.options.repo, PROBE_RUNS_ON_VAR);
    }
  }

  private warn(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.options.logger.raw(`    ${this.options.logger.styles.dim(`! ${message}`)}\n`);
  }
}
