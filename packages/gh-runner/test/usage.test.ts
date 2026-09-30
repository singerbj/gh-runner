import { describe, expect, it } from "vitest";
import { HOSTED_BLOCKED_VAR } from "../src/constants.js";
import type { CommandRunner } from "../src/exec.js";
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

describe("GhClient variables", () => {
  const client = (answer: Awaited<ReturnType<CommandRunner>>) =>
    new GhClient({ runner: () => Promise.resolve(answer) });

  it("tells a missing variable apart from one it couldn't read", async () => {
    expect(
      await client({ code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" }).getVariable(
        "o/r",
        HOSTED_BLOCKED_VAR,
      ),
    ).toBeNull();
    expect(
      await client({ code: 1, stdout: "", stderr: "gh: Server Error (HTTP 500)\n" }).getVariable(
        "o/r",
        HOSTED_BLOCKED_VAR,
      ),
    ).toBeUndefined();
    expect(
      await client({ code: 0, stdout: "2026-09-30\n", stderr: "" }).getVariable(
        "o/r",
        HOSTED_BLOCKED_VAR,
      ),
    ).toBe("2026-09-30");
  });
});

describe("HostedUsageWatcher", () => {
  const watcherFor = (github: MockGitHub) =>
    new HostedUsageWatcher({
      repo: github.repo,
      gh: new GhClient({ runner: github.commandRunner() }),
      logger: silentLogger,
      now: () => github.now,
      schedule: () => ({ close: () => {} }),
    });

  const WORKFLOW = [
    "jobs:",
    "  build:",
    `    runs-on: \${{ vars.${HOSTED_BLOCKED_VAR} && fromJSON('["self-hosted","gh-runner-linux"]') || 'ubuntu-latest' }}`,
    "",
  ].join("\n");

  it("shares one pass between overlapping checks", async () => {
    const github = new MockGitHub();
    const watcher = watcherFor(github);
    const [a, b] = await Promise.all([watcher.check(), watcher.check()]);
    expect(a).toBe(b);
    expect(github.log.filter((line) => line.includes("/actions/runs?"))).toHaveLength(1);
  });

  it("reads a completed run's jobs once, however many heartbeats pass", async () => {
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

  it("keeps a variable set by hand this month, until a hosted job gets through", async () => {
    const github = new MockGitHub();
    github.variables.set(HOSTED_BLOCKED_VAR, "true");
    const watcher = watcherFor(github);

    expect((await watcher.check()).status.state).toBe("blocked");
    expect(github.variables.get(HOSTED_BLOCKED_VAR)).toBe("true");

    github.advance(60_000);
    github.push(["jobs:", "  lint:", "    runs-on: ubuntu-latest", ""].join("\n"));
    github.advance(60_000);
    expect((await watcher.check()).action).toBe("cleared");
  });
});
