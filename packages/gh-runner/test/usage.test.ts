import { describe, expect, it } from "vitest";
import { GhClient } from "../src/gh.js";
import { silentLogger } from "../src/logger.js";
import { BILLING_BLOCK_PATTERN, HostedUsageWatcher, startOfUtcMonth } from "../src/usage.js";
import { BILLING_MESSAGE, MockGitHub } from "./support/mock-github.js";

describe("BILLING_BLOCK_PATTERN", () => {
  it.each([
    [BILLING_MESSAGE],
    ["The job was not started because your account is locked due to a billing issue."],
    ["You've used 100% of included services for GitHub Actions — your spending limit is $0."],
  ])("recognises %s", (message) => {
    expect(BILLING_BLOCK_PATTERN.test(message)).toBe(true);
  });

  it.each([["Process completed with exit code 1."], ["The operation was canceled."]])(
    "ignores %s",
    (message) => {
      expect(BILLING_BLOCK_PATTERN.test(message)).toBe(false);
    },
  );
});

describe("startOfUtcMonth", () => {
  it("is midnight UTC on the first", () => {
    expect(new Date(startOfUtcMonth(Date.UTC(2026, 8, 30, 23, 59))).toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });
});

describe("HostedUsageWatcher", () => {
  const watcherFor = (github: MockGitHub, labels = ["gh-runner", "gh-runner-linux"]) =>
    new HostedUsageWatcher({
      repo: github.repo,
      gh: new GhClient({ runner: github.commandRunner() }),
      logger: silentLogger,
      labels,
      now: () => github.now,
      schedule: () => ({ close: () => {} }),
    });

  const WORKFLOW = [
    "jobs:",
    "  build:",
    "    runs-on: ${{ vars.GH_RUNNER_LINUX || 'ubuntu-latest' }}",
    "",
  ].join("\n");

  it("names one variable per label it serves", () => {
    expect(
      watcherFor(new MockGitHub(), ["gh-runner", "gh-runner-mac", "cuda"]).variableNames,
    ).toEqual(["GH_RUNNER", "GH_RUNNER_MAC", "GH_RUNNER_LABEL_CUDA"]);
  });

  it("shares one pass between overlapping checks", async () => {
    const github = new MockGitHub();
    const watcher = watcherFor(github);
    const [a, b] = await Promise.all([watcher.check(), watcher.check()]);
    expect(a).toBe(b);
    expect(github.log.filter((line) => line.includes("status=failure"))).toHaveLength(1);
  });

  it("reads a completed run's jobs once, however many checks pass", async () => {
    const github = new MockGitHub();
    github.push(["jobs:", "  x:", "    runs-on: ubuntu-latest", ""].join("\n"));
    github.runs[0]!.conclusion = "failure";
    const watcher = watcherFor(github);

    await watcher.check();
    await watcher.check();
    await watcher.check();
    expect(github.log.filter((line) => line.includes("/jobs"))).toHaveLength(1);
  });

  it("only looks at this month, since that's when included minutes reset", async () => {
    const github = new MockGitHub({ now: Date.UTC(2026, 8, 30, 12) });
    github.hostedAvailable = false;
    github.push(WORKFLOW);
    github.now = Date.UTC(2026, 9, 1, 1);

    expect((await watcherFor(github).check()).status.state).toBe("ok");
    expect(github.log.some((line) => line.includes("created=%3E%3D2026-10-01"))).toBe(true);
  });

  it("only asks about failed runs, so a busy month can't push a refusal off the page", async () => {
    const github = new MockGitHub();
    github.hostedAvailable = false;
    github.push(WORKFLOW);
    github.hostedAvailable = true;
    for (let i = 0; i < 40; i += 1)
      github.push(["jobs:", "  x:", "    runs-on: [self-hosted, gh-runner]", ""].join("\n"));

    expect((await watcherFor(github).check()).status.state).toBe("blocked");
  });

  it("clears stale copies of its own variables on its first check — never another label's", async () => {
    const github = new MockGitHub();
    github.variables.set("GH_RUNNER_MAC", "gh-runner-mac");
    const watcher = watcherFor(github);

    await watcher.check();
    await watcher.stop();
    // Another session's variable, for a label this one doesn't serve.
    expect([...github.variables.keys()]).toEqual(["GH_RUNNER_MAC"]);
    expect(github.log.filter((line) => line.startsWith("DELETE"))).toHaveLength(2);
  });
});
