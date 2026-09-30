/**
 * End to end, against a mocked GitHub: a repo runs out of hosted minutes and
 * CI keeps going.
 *
 * Every scenario goes through the real pieces — the workflow `applyWorkflowFix`
 * writes, the real `GhClient`, the real `HostedUsageWatcher` — and only GitHub
 * itself is simulated: its REST API, and a scheduler that resolves each job's
 * `runs-on` with an evaluator of its own and then runs it, queues it, or
 * refuses it the way GitHub does when an account is out of minutes.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HOSTED_BLOCKED_VAR, hostedFirstRunsOn } from "../src/constants.js";
import { execCommand } from "../src/exec.js";
import type { CommandRunner } from "../src/exec.js";
import { GhClient } from "../src/gh.js";
import { silentLogger } from "../src/logger.js";
import { HostedUsageWatcher, RERUN_WINDOW_MS } from "../src/usage.js";
import { PROBE_JOB_ID, applyWorkflowFix, hostedRunnerOs, parseRunsOn } from "../src/workflows.js";
import type { WorkflowFixPlan } from "../src/workflows.js";
import { BILLING_MESSAGE, MockGitHub } from "./support/mock-github.js";
import type { MockRun } from "./support/mock-github.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_GH = join(HERE, "support", "fake-gh.mjs");
const REPO_ROOT = dirname(dirname(dirname(HERE)));

const HOUR = 60 * 60 * 1000;

const LINUX_RUNNER = ["self-hosted", "gh-runner", "gh-runner-linux", "Linux", "X64"];
const MAC_RUNNER = ["self-hosted", "gh-runner", "gh-runner-mac", "macOS", "ARM64"];

/** The repo before `gh-runner --fix-workflows --hosted-first`. */
const ORIGINAL = [
  "name: CI",
  "on: [push]",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: make",
  "  test-mac:",
  "    needs: build",
  "    runs-on: macos-14",
  "    steps:",
  "      - run: make test",
  "",
].join("\n");

/** A workflow gh-runner didn't touch — `--fix-jobs` left it out — which stays hosted either way. */
const UNTOUCHED = ["jobs:", "  lint:", "    runs-on: ubuntu-latest", ""].join("\n");

const KEYS = { osx: "mac", linux: "linux", win: "windows" } as const;
const LABELS = {
  osx: "gh-runner-mac",
  linux: "gh-runner-linux",
  win: "gh-runner-windows",
} as const;

function fixed(source: string, extra: Partial<WorkflowFixPlan> = {}): string {
  return applyWorkflowFix(source, {
    jobId: PROBE_JOB_ID,
    actionRef: "singerbj/gh-runner/actions/pick-runner@abc123",
    fixes: parseRunsOn(source, "ci.yml").map((target) => {
      const os = hostedRunnerOs(target.labels) ?? "linux";
      return { target, key: KEYS[os], labels: ["self-hosted", LABELS[os]] };
    }),
    ...extra,
  });
}

const HOSTED_FIRST = fixed(ORIGINAL, { hostedFirst: true });

/** Where each job of a run's latest attempt ended up. */
function placement(run: MockRun): Record<string, string> {
  return Object.fromEntries(
    run.jobs.map((job) => {
      if (job.status !== "completed") return [job.name, "queued"];
      if (job.conclusion === "skipped") return [job.name, "skipped"];
      if (job.conclusion === "failure") {
        return [job.name, job.annotations.includes(BILLING_MESSAGE) ? "refused" : "failed"];
      }
      const selfHosted = job.labels.includes("self-hosted");
      return [job.name, selfHosted ? `self-hosted ${job.labels.join(",")}` : "hosted"];
    }),
  );
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

/**
 * A gh-runner session against the mock. `spawn` sends every `gh` call through
 * a real child process — fake-gh.mjs — so exit codes, stderr and stdout are
 * parsed exactly as they are from the real binary.
 */
async function session(github: MockGitHub, options: { spawn?: boolean } = {}) {
  let runner: CommandRunner = github.commandRunner();

  if (options.spawn) {
    const server = await github.listen();
    closers.push(server.close);
    runner = (command, args, execOptions) =>
      command === "gh"
        ? execCommand(process.execPath, [FAKE_GH, ...args], {
            ...execOptions,
            env: { ...process.env, MOCK_GH_URL: server.url },
          })
        : execCommand(command, args, execOptions);
  }

  const beats: Array<() => void> = [];
  const watcher = new HostedUsageWatcher({
    repo: github.repo,
    gh: new GhClient({ runner }),
    logger: silentLogger,
    now: () => github.now,
    schedule: (fn) => {
      beats.push(fn);
      return { close: () => beats.splice(0) };
    },
  });
  return { watcher, beats };
}

describe("out-of-minutes simulation", () => {
  it("leaves every job on its hosted runner while minutes last, runner online or not", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    const { watcher } = await session(github);

    const run = github.push(HOSTED_FIRST);
    expect(placement(run)).toEqual({ build: "hosted", "test-mac": "hosted" });

    const result = await watcher.check();
    expect(result).toMatchObject({ status: { state: "ok" }, action: "none", rerun: [] });
    expect(github.variables.has(HOSTED_BLOCKED_VAR)).toBe(false);
  });

  it("notices refused jobs, flips the variable, and re-runs them on the self-hosted runner", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    const { watcher } = await session(github, { spawn: true });

    // Minutes run out. GitHub refuses the first job; the one after it never
    // gets asked for a runner.
    github.hostedAvailable = false;
    const run = github.push(HOSTED_FIRST);
    expect(run.conclusion).toBe("failure");
    expect(placement(run)).toEqual({ build: "refused", "test-mac": "skipped" });

    github.advance(60_000);
    const result = await watcher.check();

    expect(result.action).toBe("set");
    expect(result.rerun).toEqual([run.id]);
    expect(Date.parse(github.variables.get(HOSTED_BLOCKED_VAR) ?? "")).toBe(github.now);

    // The re-run reads the variable, so it doesn't need a hosted runner.
    expect(run.run_attempt).toBe(2);
    expect(run.conclusion).toBe("success");
    expect(placement(run)).toEqual({
      build: "self-hosted self-hosted,gh-runner-linux",
      "test-mac": "self-hosted self-hosted,gh-runner-mac",
    });

    // Every push after that goes straight to the self-hosted runner.
    github.advance(HOUR);
    const next = github.push(HOSTED_FIRST);
    expect(next.conclusion).toBe("success");
    expect(placement(next)).toEqual({
      build: "self-hosted self-hosted,gh-runner-linux",
      "test-mac": "self-hosted self-hosted,gh-runner-mac",
    });

    // And the session doesn't flap: still blocked, nothing to re-run.
    expect(await watcher.check()).toMatchObject({
      status: { state: "blocked" },
      action: "none",
      rerun: [],
    });
    expect(github.reruns).toEqual([run.id]);
  });

  it("checks again on every heartbeat, not just at startup", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    const { watcher, beats } = await session(github);

    expect((await watcher.start()).action).toBe("none");
    expect(beats).toHaveLength(1);

    github.hostedAvailable = false;
    const run = github.push(HOSTED_FIRST);
    beats[0]?.();
    await watcher.check();

    expect(github.variables.has(HOSTED_BLOCKED_VAR)).toBe(true);
    expect(run.conclusion).toBe("success");

    watcher.stop();
    expect(beats).toHaveLength(0);
  });

  it("queues rather than fails while no runner is online, and runs when one comes up", async () => {
    const github = new MockGitHub();
    github.hostedAvailable = false;
    github.variables.set(HOSTED_BLOCKED_VAR, new Date(github.now).toISOString());

    const run = github.push(HOSTED_FIRST);
    expect(run.status).toBe("queued");
    expect(placement(run)).toEqual({ build: "queued", "test-mac": "queued" });

    github.online = [LINUX_RUNNER];
    github.drain();
    expect(placement(run)).toEqual({
      build: "self-hosted self-hosted,gh-runner-linux",
      "test-mac": "queued",
    });

    github.online = [LINUX_RUNNER, MAC_RUNNER];
    github.drain();
    expect(run.conclusion).toBe("success");
  });

  it("catches up when it starts after the fact — re-running the last day, not older", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    github.hostedAvailable = false;

    // Refused while nobody was running gh-runner.
    const stale = github.push(HOSTED_FIRST);
    github.advance(RERUN_WINDOW_MS + HOUR);
    const recent = github.push(HOSTED_FIRST);
    github.advance(HOUR);

    const { watcher } = await session(github);
    const result = await watcher.check();

    expect(result.action).toBe("set");
    expect(result.rerun).toEqual([recent.id]);
    expect(recent.conclusion).toBe("success");
    expect(stale.conclusion).toBe("failure");
    expect(stale.run_attempt).toBe(1);
  });

  it("never re-runs a fork's pull request on this machine by itself", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    github.hostedAvailable = false;

    const fork = github.push(HOSTED_FIRST, "CI", "stranger/thing");
    const ours = github.push(HOSTED_FIRST);
    github.advance(60_000);

    const { watcher } = await session(github);
    const result = await watcher.check();

    expect(result.action).toBe("set");
    expect(result.rerun).toEqual([ours.id]);
    expect(fork.run_attempt).toBe(1);
  });

  it("clears the variable when a hosted job gets through again", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    const { watcher } = await session(github);

    github.hostedAvailable = false;
    github.push(HOSTED_FIRST);
    github.push(UNTOUCHED, "Lint");
    github.advance(60_000);
    await watcher.check();
    expect(github.variables.has(HOSTED_BLOCKED_VAR)).toBe(true);

    // Someone raises the spending limit. The untouched workflow is the one that
    // still asks for a hosted runner, and it gets one.
    github.advance(HOUR);
    github.hostedAvailable = true;
    expect(placement(github.push(UNTOUCHED, "Lint"))).toEqual({ lint: "hosted" });
    github.advance(60_000);

    expect((await watcher.check()).action).toBe("cleared");
    expect(github.variables.has(HOSTED_BLOCKED_VAR)).toBe(false);
    expect(placement(github.push(HOSTED_FIRST))).toEqual({ build: "hosted", "test-mac": "hosted" });
  });

  it("tries hosted runners again in a new month, and flips straight back if they're still refused", async () => {
    const github = new MockGitHub({ now: Date.UTC(2026, 8, 29, 12) });
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    const { watcher } = await session(github);

    github.hostedAvailable = false;
    github.push(HOSTED_FIRST);
    github.advance(60_000);
    await watcher.check();
    expect(github.variables.has(HOSTED_BLOCKED_VAR)).toBe(true);

    // October 1st: the included minutes reset. Nothing has been refused yet
    // this month, so the variable comes down.
    github.now = Date.UTC(2026, 9, 1, 0, 5);
    expect((await watcher.check()).action).toBe("cleared");

    // Except this repo is over a spending limit, not just out of minutes.
    const refused = github.push(HOSTED_FIRST);
    expect(placement(refused)).toEqual({ build: "refused", "test-mac": "skipped" });
    github.advance(60_000);

    const result = await watcher.check();
    expect(result.action).toBe("set");
    expect(result.rerun).toEqual([refused.id]);
    expect(refused.conclusion).toBe("success");
  });

  it("changes nothing on an answer it couldn't get", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    const { watcher } = await session(github, { spawn: true });

    github.hostedAvailable = false;
    const run = github.push(HOSTED_FIRST);

    github.failing = (_method, path) => path.includes("/actions/runs");
    expect((await watcher.check()).status.state).toBe("unknown");
    expect(github.variables.has(HOSTED_BLOCKED_VAR)).toBe(false);

    github.failing = (_method, path) => path.includes("/annotations");
    expect((await watcher.check()).status.state).toBe("unknown");
    expect(github.variables.has(HOSTED_BLOCKED_VAR)).toBe(false);

    // Nor the other way: an outage mustn't take a set variable down.
    github.failing = null;
    await watcher.check();
    expect(github.variables.has(HOSTED_BLOCKED_VAR)).toBe(true);
    expect(run.conclusion).toBe("success");

    github.now = Date.UTC(2026, 9, 2);
    github.failing = (method, path) => method === "GET" && path.includes("/actions/variables");
    expect((await watcher.check()).status.state).toBe("unknown");
    expect(github.variables.has(HOSTED_BLOCKED_VAR)).toBe(true);
  });

  it("doesn't re-run anything when it couldn't set the variable — the re-run would be refused too", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    const { watcher } = await session(github);

    github.hostedAvailable = false;
    const run = github.push(HOSTED_FIRST);
    // No admin rights: variables can be read, not written.
    github.failing = (method, path) => method !== "GET" && path.includes("/actions/variables");

    expect((await watcher.check()).status.state).toBe("unknown");
    expect(github.reruns).toEqual([]);
    expect(run.run_attempt).toBe(1);
  });

  it("isn't fooled by jobs that failed for ordinary reasons", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER];
    const { watcher } = await session(github);

    const run = github.push(HOSTED_FIRST);
    // A red test: it had a runner and ran steps.
    const build = run.jobs[0];
    if (build) {
      build.conclusion = "failure";
      build.annotations = ["Process completed with exit code 1."];
    }
    run.conclusion = "failure";
    // A job that never started, for a reason that isn't billing.
    const broken = github.push(["jobs:", "  x:", "    runs-on: ''", ""].join("\n"));
    expect(placement(broken)).toEqual({ x: "failed" });

    expect(await watcher.check()).toMatchObject({ status: { state: "ok" }, action: "none" });
    expect(github.variables.has(HOSTED_BLOCKED_VAR)).toBe(false);
  });

  it("is why the probe had to go: a probe job is refused, and nothing downstream is even scheduled", () => {
    // The chicken-and-egg this mode exists to fix, reproduced: a runner is
    // online, the work could all run on it, and the run still fails — because
    // the job that decides where work runs needs a hosted runner of its own.
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    github.hostedAvailable = false;

    const probe = github.push(fixed(ORIGINAL));
    expect(placement(probe)).toEqual({
      [PROBE_JOB_ID]: "refused",
      build: "skipped",
      "test-mac": "skipped",
    });

    const hostedFirst = github.push(HOSTED_FIRST);
    github.variables.set(HOSTED_BLOCKED_VAR, new Date(github.now).toISOString());
    const next = github.push(HOSTED_FIRST);
    expect(placement(hostedFirst)).toEqual({ build: "refused", "test-mac": "skipped" });
    expect(next.conclusion).toBe("success");
  });
});

describe("the CI workflow that runs this simulation", () => {
  it("checks the exact expression the fix writes against GitHub's own evaluator", async () => {
    const workflow = await readFile(
      join(REPO_ROOT, ".github", "workflows", "hosted-first-simulation.yml"),
      "utf8",
    );
    const labels = ["self-hosted", "gh-runner-linux"];

    // `runs-on` itself, with the real variable — this workflow uses the mode it tests.
    expect(workflow).toContain(`runs-on: ${hostedFirstRunsOn(labels, ["ubuntu-latest"])}`);

    // And the same expression over a matrix value, so both states get evaluated
    // by GitHub on every run without anyone having to change a variable.
    const inner = hostedFirstRunsOn(labels, ["ubuntu-latest"], "matrix.blocked").slice(4, -3);
    expect(workflow).toContain(`RESOLVED: \${{ toJSON(${inner}) }}`);
  });
});
