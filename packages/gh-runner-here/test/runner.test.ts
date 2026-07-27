import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import type { CommandRunner, ExecResult } from "../src/exec.js";
import { GhClient } from "../src/gh.js";
import { ghRunnerHere } from "../src/runner.js";

const VERSION = "2.334.0";
const PLATFORM = { os: "linux", arch: "x64" } as const;
const TARBALL = `actions-runner-linux-x64-${VERSION}.tar.gz`;

interface Recorded {
  command: string;
  args: readonly string[];
}

function stubRunner(overrides: Record<string, ExecResult> = {}) {
  const calls: Recorded[] = [];
  const runner: CommandRunner = (command, args) => {
    calls.push({ command, args });
    const line = `${command} ${args.join(" ")}`;
    for (const [needle, result] of Object.entries(overrides)) {
      if (line.includes(needle)) return Promise.resolve(result);
    }
    if (line.includes("gh --version")) return Promise.resolve(ok("gh version 2.60.0"));
    if (line.includes("auth status")) return Promise.resolve(ok("Logged in"));
    if (line.includes("--json visibility")) return Promise.resolve(ok("PRIVATE"));
    if (line.includes("registration-token")) return Promise.resolve(ok("REG123"));
    if (line.includes("remove-token")) return Promise.resolve(ok("RM123"));
    return Promise.resolve(ok(""));
  };
  return { runner, calls };
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });

let cacheDir = "";

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "gh-runner-here-test-"));
  // Pre-seed the cache so the run never reaches the network.
  await writeFile(join(cacheDir, TARBALL), "not-really-a-tarball");
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe("ghRunnerHere", () => {
  it("registers, runs, and reports what it set up", async () => {
    const { runner, calls } = stubRunner();
    const summary = await ghRunnerHere(
      { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir, labels: ["gpu"] },
      {
        commandRunner: runner,
        gh: new GhClient({ runner }),
        platform: PLATFORM,
        nodePlatform: "linux",
      },
    );

    expect(summary.repo).toBe("octocat/private-thing");
    expect(summary.ephemeral).toBe(true);
    expect(summary.labels).toEqual([summary.hostLabel, "gpu"]);
    expect(summary.runnerName).toBe(`${summary.hostLabel}-${process.pid}`);

    const config = calls.find((c) => c.command.endsWith("config.sh"));
    expect(config).toBeDefined();
    expect(config?.args).toContain("--ephemeral");
    expect(config?.args).toContain("--unattended");
    expect(config?.args.join(" ")).toContain("https://github.com/octocat/private-thing");
    expect(config?.args).toContain("REG123");

    expect(calls.some((c) => c.command.endsWith("run.sh"))).toBe(true);
    expect(calls.some((c) => c.command === "tar")).toBe(true);
  });

  it("drops --ephemeral when --keep is set", async () => {
    const { runner, calls } = stubRunner();
    const summary = await ghRunnerHere(
      { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir, keep: true },
      {
        commandRunner: runner,
        gh: new GhClient({ runner }),
        platform: PLATFORM,
        nodePlatform: "linux",
      },
    );

    expect(summary.ephemeral).toBe(false);
    const config = calls.find((c) => c.command.endsWith("config.sh"));
    expect(config?.args).not.toContain("--ephemeral");
  });

  it("refuses a public repo unless --allow-public is passed", async () => {
    const { runner } = stubRunner({ "--json visibility": ok("PUBLIC") });
    const context = {
      commandRunner: runner,
      gh: new GhClient({ runner }),
      platform: PLATFORM,
      nodePlatform: "linux" as const,
    };
    const options = { repo: "octocat/open-source", runnerVersion: VERSION, cacheDir };

    await expect(ghRunnerHere(options, context)).rejects.toThrow(CliError);
    await expect(ghRunnerHere(options, context)).rejects.toThrow(/is PUBLIC/);

    await expect(ghRunnerHere({ ...options, allowPublic: true }, context)).resolves.toMatchObject({
      repo: "octocat/open-source",
    });
  });

  it("turns a failed registration into a readable error", async () => {
    const { runner } = stubRunner({
      "config.sh": { code: 1, stdout: "", stderr: "Invalid registration token" },
    });
    await expect(
      ghRunnerHere(
        { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir },
        {
          commandRunner: runner,
          gh: new GhClient({ runner }),
          platform: PLATFORM,
          nodePlatform: "linux",
        },
      ),
    ).rejects.toThrow(/runner registration failed[\s\S]*Invalid registration token/);
  });

  it("stops before touching the network when already aborted", async () => {
    const { runner, calls } = stubRunner();
    const abort = new AbortController();
    abort.abort();

    await expect(
      ghRunnerHere(
        { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir },
        {
          commandRunner: runner,
          gh: new GhClient({ runner }),
          platform: PLATFORM,
          nodePlatform: "linux",
          signal: abort.signal,
        },
      ),
    ).rejects.toThrow();

    expect(calls.some((c) => c.command.endsWith("run.sh"))).toBe(false);
  });
});
