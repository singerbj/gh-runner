import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import type { CommandRunner, ExecResult } from "../src/exec.js";
import { GhClient } from "../src/gh.js";
import { ghRunner } from "../src/runner.js";

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
  cacheDir = await mkdtemp(join(tmpdir(), "gh-runner-test-"));
  // Pre-seed the cache so the run never reaches the network.
  await writeFile(join(cacheDir, TARBALL), "not-really-a-tarball");
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe("ghRunner", () => {
  it("registers, runs, and reports what it set up", async () => {
    const { runner, calls } = stubRunner();
    const summary = await ghRunner(
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
    expect(summary.labels).toEqual(["gh-runner", "gh-runner-linux", summary.hostLabel, "gpu"]);
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
    const summary = await ghRunner(
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

    await expect(ghRunner(options, context)).rejects.toThrow(CliError);
    await expect(ghRunner(options, context)).rejects.toThrow(/is PUBLIC/);

    await expect(ghRunner({ ...options, allowPublic: true }, context)).resolves.toMatchObject({
      repo: "octocat/open-source",
    });
  });

  it("turns a failed registration into a readable error", async () => {
    const { runner } = stubRunner({
      "config.sh": { code: 1, stdout: "", stderr: "Invalid registration token" },
    });
    await expect(
      ghRunner(
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

  it("audits the repo's workflows and offers to fix them", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "gh-runner-repo-"));
    await mkdir(join(repoRoot, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(repoRoot, ".github", "workflows", "ci.yml"),
      ["jobs:", "  build:", "    runs-on: ubuntu-latest"].join("\n"),
    );

    // `--show-toplevel` answers with the fixture; `ls-remote` succeeding means
    // the fix stops at "branch already exists" instead of touching a real repo.
    const { runner } = stubRunner({ "rev-parse --show-toplevel": ok(repoRoot) });
    const asked: string[] = [];
    const summary = await ghRunner(
      { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir },
      {
        commandRunner: runner,
        gh: new GhClient({ runner }),
        platform: PLATFORM,
        nodePlatform: "linux",
        confirm: (question) => {
          asked.push(question);
          return Promise.resolve(false);
        },
      },
    );

    expect(summary.workflows?.scanned).toBe(true);
    expect(summary.workflows?.hosted.map((t) => t.job)).toEqual(["build"]);
    expect(summary.workflows?.matches).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/Update 1 job to runs-on: \[self-hosted, gh-runner\]/);

    await rm(repoRoot, { recursive: true, force: true });
  });

  it("never asks when a job already targets the runner", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "gh-runner-repo-"));
    await mkdir(join(repoRoot, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(repoRoot, ".github", "workflows", "ci.yml"),
      ["jobs:", "  build:", "    runs-on: [self-hosted, gh-runner]"].join("\n"),
    );

    const { runner } = stubRunner({ "rev-parse --show-toplevel": ok(repoRoot) });
    let asked = 0;
    const summary = await ghRunner(
      { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir },
      {
        commandRunner: runner,
        gh: new GhClient({ runner }),
        platform: PLATFORM,
        nodePlatform: "linux",
        confirm: () => {
          asked += 1;
          return Promise.resolve(true);
        },
      },
    );

    expect(summary.workflows?.matches.map((t) => t.job)).toEqual(["build"]);
    expect(asked).toBe(0);

    await rm(repoRoot, { recursive: true, force: true });
  });

  it("skips the audit entirely with --no-workflow-check", async () => {
    const { runner } = stubRunner();
    const summary = await ghRunner(
      {
        repo: "octocat/private-thing",
        runnerVersion: VERSION,
        cacheDir,
        skipWorkflowCheck: true,
      },
      {
        commandRunner: runner,
        gh: new GhClient({ runner }),
        platform: PLATFORM,
        nodePlatform: "linux",
      },
    );
    expect(summary.workflows).toBeUndefined();
  });

  it("stops before touching the network when already aborted", async () => {
    const { runner, calls } = stubRunner();
    const abort = new AbortController();
    abort.abort();

    await expect(
      ghRunner(
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
