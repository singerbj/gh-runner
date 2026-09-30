/**
 * End to end, against a mocked GitHub: a repo runs out of hosted minutes and
 * CI keeps going — and a repo that doesn't never needs a gh-runner at all.
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
import { fallbackRunsOn } from "../src/constants.js";
import { execCommand } from "../src/exec.js";
import type { CommandRunner } from "../src/exec.js";
import { GhClient } from "../src/gh.js";
import { silentLogger } from "../src/logger.js";
import { HostedUsageWatcher, RERUN_WINDOW_MS } from "../src/usage.js";
import { PROBE_JOB_ID, applyWorkflowFix, hostedRunnerOs, parseRunsOn } from "../src/workflows.js";
import { LEGACY_PROBE } from "./support/legacy.js";
import { BILLING_MESSAGE, MockGitHub } from "./support/mock-github.js";
import type { MockRun } from "./support/mock-github.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_GH = join(HERE, "support", "fake-gh.mjs");
const REPO_ROOT = dirname(dirname(dirname(HERE)));

const HOUR = 60 * 60 * 1000;

/** What a runner registered by `gh-runner mac linux` on a Mac carries. */
const LINUX_RUNNER = ["self-hosted", "gh-runner", "gh-runner-linux", "Linux", "X64"];
const MAC_RUNNER = ["self-hosted", "gh-runner", "gh-runner-mac", "macOS", "ARM64"];
const MAC_SESSION = ["gh-runner", "gh-runner-mac", "gh-runner-linux"];
const LINUX_SESSION = ["gh-runner", "gh-runner-linux"];

/** The repo before `gh-runner --fix-workflows`. */
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

const LABELS = {
  osx: "gh-runner-mac",
  linux: "gh-runner-linux",
  win: "gh-runner-windows",
} as const;

const FIXED = applyWorkflowFix(ORIGINAL, {
  fixes: parseRunsOn(ORIGINAL, "ci.yml").map((target) => ({
    target,
    label: LABELS[hostedRunnerOs(target.labels) ?? "linux"],
  })),
});

/** A workflow gh-runner didn't touch — `--fix-jobs` left it out — which stays hosted either way. */
const UNTOUCHED = ["jobs:", "  lint:", "    runs-on: ubuntu-latest", ""].join("\n");

/** Where each job of a run's latest attempt ended up. */
function placement(run: MockRun): Record<string, string> {
  return Object.fromEntries(
    run.jobs.map((job) => {
      if (job.status !== "completed") return [job.name, "queued"];
      if (job.conclusion === "skipped") return [job.name, "skipped"];
      if (job.conclusion === "failure") {
        return [job.name, job.annotations.includes(BILLING_MESSAGE) ? "refused" : "failed"];
      }
      return [job.name, job.runner_name === "gh-runner-mock" ? job.labels.join(",") : "hosted"];
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
async function session(
  github: MockGitHub,
  options: { labels?: string[]; spawn?: boolean; workflowFiles?: string[] } = {},
) {
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
    labels: options.labels ?? MAC_SESSION,
    ...(options.workflowFiles ? { workflowFiles: options.workflowFiles } : {}),
    now: () => github.now,
    schedule: (fn) => {
      beats.push(fn);
      return { close: () => beats.splice(0) };
    },
  });
  return { watcher, beats };
}

describe("out-of-minutes simulation", () => {
  it("needs no gh-runner at all while the repo has minutes", () => {
    const github = new MockGitHub();
    const run = github.push(FIXED);
    expect(run.conclusion).toBe("success");
    expect(placement(run)).toEqual({ build: "hosted", "test-mac": "hosted" });
  });

  it("leaves jobs on GitHub-hosted runners while minutes last, even with a runner online", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    const { watcher } = await session(github);

    expect(placement(github.push(FIXED))).toEqual({ build: "hosted", "test-mac": "hosted" });
    expect(await watcher.check()).toMatchObject({ status: { state: "ok" }, action: "none" });
    expect([...github.variables.keys()]).toEqual([]);
  });

  it("notices refused jobs, sets the variables, and re-runs them on the self-hosted runner", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    const { watcher } = await session(github, { spawn: true });

    // Minutes run out. GitHub refuses the first job; the one after it never
    // gets asked for a runner.
    github.hostedAvailable = false;
    const run = github.push(FIXED);
    expect(placement(run)).toEqual({ build: "refused", "test-mac": "skipped" });

    github.advance(60_000);
    const result = await watcher.check();

    expect(result.action).toBe("set");
    expect(result.rerun).toEqual([run.id]);
    expect(Object.fromEntries(github.variables)).toEqual({
      GH_RUNNER: "gh-runner",
      GH_RUNNER_MAC: "gh-runner-mac",
      GH_RUNNER_LINUX: "gh-runner-linux",
    });

    // The re-run reads the variables, so it doesn't need a hosted runner.
    expect(run.run_attempt).toBe(2);
    expect(run.conclusion).toBe("success");
    expect(placement(run)).toEqual({ build: "gh-runner-linux", "test-mac": "gh-runner-mac" });

    // Every push after that goes straight to the self-hosted runner, and the
    // session doesn't flap now that the refused run has turned green.
    github.advance(HOUR);
    expect(github.push(FIXED).conclusion).toBe("success");
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
    const run = github.push(FIXED);
    beats[0]?.();
    await watcher.check();

    expect(github.variables.size).toBe(3);
    expect(run.conclusion).toBe("success");
  });

  it("gives the jobs back to GitHub when the session ends — nothing waits on a runner that's gone", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    const { watcher } = await session(github);

    github.hostedAvailable = false;
    github.push(FIXED);
    await watcher.start();
    expect(github.variables.size).toBe(3);

    // Ctrl+C.
    await watcher.stop();
    github.online = [];
    expect(github.variables.size).toBe(0);

    // Still out of minutes, and nobody's hosting: nothing can run this, and it
    // fails rather than sitting in a queue.
    const orphan = github.push(FIXED);
    expect(placement(orphan)).toEqual({ build: "refused", "test-mac": "skipped" });

    // Minutes come back: GitHub-hosted, no gh-runner needed.
    github.hostedAvailable = true;
    expect(placement(github.push(FIXED))).toEqual({ build: "hosted", "test-mac": "hosted" });
  });

  it("catches up when it starts after the fact — re-running the last day, not older", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    github.hostedAvailable = false;

    // Refused while nobody was running gh-runner.
    const stale = github.push(FIXED);
    github.advance(RERUN_WINDOW_MS + HOUR);
    const recent = github.push(FIXED);
    github.advance(HOUR);

    const { watcher } = await session(github);
    const result = await watcher.check();

    expect(result.action).toBe("set");
    expect(result.rerun).toEqual([recent.id]);
    expect(recent.conclusion).toBe("success");
    expect(stale.run_attempt).toBe(1);
  });

  it("only moves the platforms it serves — a Linux box never queues the macOS jobs", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER];
    const { watcher } = await session(github, { labels: LINUX_SESSION });

    github.hostedAvailable = false;
    const run = github.push(FIXED);
    await watcher.check();

    expect([...github.variables.keys()].toSorted()).toEqual(["GH_RUNNER", "GH_RUNNER_LINUX"]);
    // build ran here; test-mac had nowhere to go and was refused, not queued.
    expect(placement(run)).toEqual({ build: "gh-runner-linux", "test-mac": "refused" });
  });

  it("re-runs only runs that will move: not a fork's, and not a workflow that stays hosted", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    github.hostedAvailable = false;

    const fork = github.push(FIXED, { headRepository: "stranger/thing" });
    const lint = github.push(UNTOUCHED, { path: "lint.yml" });
    const ours = github.push(FIXED);
    github.advance(60_000);

    const { watcher } = await session(github, { workflowFiles: [".github/workflows/ci.yml"] });
    expect((await watcher.check()).rerun).toEqual([ours.id]);
    expect(fork.run_attempt).toBe(1);
    expect(lint.run_attempt).toBe(1);
  });

  it("clears the variables when a hosted job gets through again", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    const { watcher } = await session(github);

    github.hostedAvailable = false;
    github.push(FIXED);
    github.advance(60_000);
    await watcher.check();
    expect(github.variables.size).toBe(3);

    // Someone raises the spending limit. The untouched workflow still asks for
    // a hosted runner, and gets one.
    github.advance(HOUR);
    github.hostedAvailable = true;
    expect(placement(github.push(UNTOUCHED, { path: "lint.yml" }))).toEqual({ lint: "hosted" });
    github.advance(60_000);

    expect((await watcher.check()).action).toBe("cleared");
    expect(github.variables.size).toBe(0);
    expect(placement(github.push(FIXED))).toEqual({ build: "hosted", "test-mac": "hosted" });
  });

  it("tries GitHub-hosted runners again in a new month, and flips straight back if still refused", async () => {
    const github = new MockGitHub({ now: Date.UTC(2026, 8, 29, 12) });
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    const { watcher } = await session(github);

    github.hostedAvailable = false;
    github.push(FIXED);
    github.advance(60_000);
    await watcher.check();
    expect(github.variables.size).toBe(3);

    // October 1st: included minutes reset, so the variables come down.
    github.now = Date.UTC(2026, 9, 1, 0, 5);
    expect((await watcher.check()).action).toBe("cleared");

    // Except this repo is over a spending limit, not just out of minutes.
    const refused = github.push(FIXED);
    expect(placement(refused)).toEqual({ build: "refused", "test-mac": "skipped" });
    github.advance(60_000);

    const result = await watcher.check();
    expect(result.action).toBe("set");
    expect(result.rerun).toEqual([refused.id]);
    expect(refused.conclusion).toBe("success");
  });

  it("cleans up after a session that was killed too hard to clean up itself", async () => {
    const github = new MockGitHub();
    // `kill -9` mid-outage: the variables stayed up, the runner went away.
    github.variables.set("GH_RUNNER_LINUX", "gh-runner-linux");
    github.variables.set("GH_RUNNER_MAC", "gh-runner-mac");

    // The one case where a job waits for a runner that isn't there.
    expect(placement(github.push(FIXED))).toEqual({ build: "queued", "test-mac": "queued" });

    // The next session to start finds GitHub-hosted runners fine, and clears it.
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    const { watcher } = await session(github);
    await watcher.check();
    expect(github.variables.size).toBe(0);
    expect(placement(github.push(FIXED))).toEqual({ build: "hosted", "test-mac": "hosted" });
  });

  it("shares a label with another session without either stranding the other", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    const mac = await session(github, { labels: MAC_SESSION });
    const linux = await session(github, { labels: LINUX_SESSION });

    github.hostedAvailable = false;
    github.push(FIXED);
    await mac.watcher.check();
    await linux.watcher.check();

    // The Linux box goes home, taking GH_RUNNER and GH_RUNNER_LINUX with it.
    await linux.watcher.stop();
    expect([...github.variables.keys()]).toEqual(["GH_RUNNER_MAC"]);

    // The Mac, which serves Linux too, puts them back on its next check.
    await mac.watcher.check();
    expect(github.variables.size).toBe(3);
  });

  it("changes nothing on an answer it couldn't get", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    const { watcher } = await session(github, { spawn: true });

    github.hostedAvailable = false;
    const run = github.push(FIXED);

    github.failing = (_method, path) => path.includes("/actions/runs");
    expect((await watcher.check()).status.state).toBe("unknown");
    expect(github.variables.size).toBe(0);

    github.failing = (_method, path) => path.includes("/annotations");
    expect((await watcher.check()).status.state).toBe("unknown");
    expect(github.variables.size).toBe(0);

    // Nor the other way: an outage mustn't take the variables down.
    github.failing = null;
    await watcher.check();
    expect(run.conclusion).toBe("success");
    github.now = Date.UTC(2026, 9, 2);
    github.failing = (_method, path) => path.includes("/actions/runs");
    expect((await watcher.check()).status.state).toBe("unknown");
    expect(github.variables.size).toBe(3);
  });

  it("doesn't re-run anything when it couldn't set a variable — the re-run would be refused too", async () => {
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    const { watcher } = await session(github);

    github.hostedAvailable = false;
    const run = github.push(FIXED);
    // No admin rights.
    github.failing = (method, path) => method !== "GET" && path.includes("/actions/variables");

    expect((await watcher.check()).status.state).toBe("unknown");
    expect(github.reruns).toEqual([]);
    expect(run.run_attempt).toBe(1);
  });

  it("isn't fooled by jobs that failed for ordinary reasons", async () => {
    const github = new MockGitHub();
    const { watcher } = await session(github);

    const run = github.push(FIXED);
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
    expect(github.variables.size).toBe(0);
  });

  it("is why the probe job had to go: it's refused, and nothing downstream is even scheduled", () => {
    // The chicken-and-egg, reproduced: a runner is online, the work could all
    // run on it, and the run still fails — because the job that decides where
    // work runs needs a hosted runner of its own.
    const github = new MockGitHub();
    github.online = [LINUX_RUNNER, MAC_RUNNER];
    github.hostedAvailable = false;

    expect(placement(github.push(LEGACY_PROBE))).toEqual({
      [PROBE_JOB_ID]: "refused",
      build: "skipped",
      "test-mac": "skipped",
    });

    github.variables.set("GH_RUNNER_LINUX", "gh-runner-linux");
    github.variables.set("GH_RUNNER_MAC", "gh-runner-mac");
    expect(github.push(FIXED).conclusion).toBe("success");
  });
});

describe("the CI workflow that runs this simulation", () => {
  it("checks the exact expression the fix writes against GitHub's own evaluator", async () => {
    const workflow = await readFile(
      join(REPO_ROOT, ".github", "workflows", "fallback-simulation.yml"),
      "utf8",
    );

    // `runs-on` itself, with the real variable — this workflow uses what it tests.
    expect(workflow).toContain(`runs-on: ${fallbackRunsOn("gh-runner-linux", ["ubuntu-latest"])}`);

    // And the same expression over a matrix value, so both states get evaluated
    // by GitHub on every run without anyone having to set a variable.
    const inner = fallbackRunsOn("gh-runner-linux", ["ubuntu-latest"], "matrix.variable").slice(
      4,
      -3,
    );
    expect(workflow).toContain(`RESOLVED: \${{ toJSON(${inner}) }}`);
  });
});
