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

    return true;
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
  }

  private warn(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.options.logger.raw(`    ${this.options.logger.styles.dim(`! ${message}`)}\n`);
  }
}
