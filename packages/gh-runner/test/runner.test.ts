import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import type { CommandRunner, ExecResult } from "../src/exec.js";
import { GhClient } from "../src/gh.js";
import { silentLogger } from "../src/logger.js";
import { ghRunner } from "../src/runner.js";
import type { RunContext } from "../src/runner.js";
import type { RunnerPlatform } from "../src/platform.js";

const VERSION = "2.334.0";
const LINUX = { os: "linux", arch: "x64" } as const;
const MAC = { os: "osx", arch: "arm64" } as const;
const TARBALL = `actions-runner-linux-x64-${VERSION}.tar.gz`;
const MAC_TARBALL = `actions-runner-osx-arm64-${VERSION}.tar.gz`;

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
    if (line.includes("docker --version")) return Promise.resolve(ok("27.0.0"));
    if (line.includes("docker info")) return Promise.resolve(ok("27.0.0"));
    return Promise.resolve(ok(""));
  };
  return { runner, calls };
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });

let cacheDir = "";

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "gh-runner-test-"));
  // Pre-seed the cache so no run ever reaches the network.
  await writeFile(join(cacheDir, TARBALL), "not-really-a-tarball");
  await writeFile(join(cacheDir, MAC_TARBALL), "not-really-a-tarball");
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

/** A logger that keeps everything it was told, for asserting on messages. */
const recordingLogger = (lines: string[]) => ({
  ...silentLogger,
  say: (message: string) => lines.push(`${message}\n`),
  raw: (message: string) => lines.push(message),
});

const base = (runner: CommandRunner, platform: RunnerPlatform = LINUX): RunContext => ({
  commandRunner: runner,
  gh: new GhClient({ runner }),
  platform,
  nodePlatform: platform.os === "osx" ? "darwin" : "linux",
});

describe("ghRunner", () => {
  it("defaults to this machine alone when nothing is asked for", async () => {
    const { runner, calls } = stubRunner();
    const { runners } = await ghRunner(
      { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir, labels: ["gpu"] },
      base(runner),
    );

    expect(runners).toHaveLength(1);
    const [only] = runners;
    expect(only?.mode).toBe("native");
    expect(only?.platform).toEqual(LINUX);
    expect(only?.labels).toEqual(["gh-runner", "gh-runner-linux", only?.hostLabel, "gpu"]);
    expect(only?.ephemeral).toBe(true);

    const config = calls.find((c) => c.command.endsWith("config.sh"));
    expect(config?.args).toContain("--ephemeral");
    expect(config?.args).toContain("REG123");
    expect(calls.some((c) => c.command.endsWith("run.sh"))).toBe(true);
    // Docker is never probed when only the host platform is wanted.
    expect(calls.some((c) => c.command === "docker")).toBe(false);
  });

  it("drops --ephemeral when --keep is set", async () => {
    const { runner, calls } = stubRunner();
    const { runners } = await ghRunner(
      { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir, keep: true },
      base(runner),
    );

    expect(runners[0]?.ephemeral).toBe(false);
    expect(calls.find((c) => c.command.endsWith("config.sh"))?.args).not.toContain("--ephemeral");
  });

  it("refuses a public repo unless --allow-public is passed", async () => {
    const { runner } = stubRunner({ "--json visibility": ok("PUBLIC") });
    const options = { repo: "octocat/open-source", runnerVersion: VERSION, cacheDir };

    await expect(ghRunner(options, base(runner))).rejects.toThrow(CliError);
    await expect(ghRunner(options, base(runner))).rejects.toThrow(/is PUBLIC/);
    await expect(ghRunner({ ...options, allowPublic: true }, base(runner))).resolves.toMatchObject({
      runners: [{ repo: "octocat/open-source" }],
    });
  });

  it("turns a failed registration into a readable error", async () => {
    const { runner } = stubRunner({
      "config.sh": { code: 1, stdout: "", stderr: "Invalid registration token" },
    });
    await expect(
      ghRunner({ repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir }, base(runner)),
    ).rejects.toThrow(/runner registration failed[\s\S]*Invalid registration token/);
  });
});

describe("platform selection", () => {
  it("serves a named platform", async () => {
    const { runner } = stubRunner();
    const { runners } = await ghRunner(
      {
        repo: "octocat/private-thing",
        runnerVersion: VERSION,
        cacheDir,
        platforms: ["linux"],
      },
      base(runner),
    );
    expect(runners.map((r) => [r.platform.os, r.mode])).toEqual([["linux", "native"]]);
  });

  it("errors when the platform can't exist on this host", async () => {
    const { runner } = stubRunner();
    await expect(
      ghRunner(
        { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir, platforms: ["windows"] },
        base(runner, MAC),
      ),
    ).rejects.toThrow(/Windows: needs a Windows machine/);
  });

  it("errors for Linux when Docker isn't reachable", async () => {
    const { runner } = stubRunner({ "docker info": { code: 1, stdout: "", stderr: "no daemon" } });
    await expect(
      ghRunner(
        { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir, platforms: ["linux"] },
        base(runner, MAC),
      ),
    ).rejects.toThrow(/Linux: .*daemon isn't reachable/);
  });

  it("runs a native and a containerised runner side by side", async () => {
    const { runner, calls } = stubRunner({ "runners?per_page": ok("") });
    const { runners } = await ghRunner(
      {
        repo: "octocat/private-thing",
        runnerVersion: VERSION,
        cacheDir,
        platforms: ["mac", "linux"],
      },
      base(runner, MAC),
    );

    expect(runners.map((r) => [r.platform.os, r.mode]).sort()).toEqual([
      ["linux", "docker"],
      ["osx", "native"],
    ]);

    // The macOS one runs natively, the Linux one in a container.
    expect(calls.some((c) => c.command.endsWith("run.sh"))).toBe(true);
    expect(calls.some((c) => c.command === "docker" && c.args[0] === "run")).toBe(true);

    // Distinct names, so both can register at once.
    expect(new Set(runners.map((r) => r.runnerName)).size).toBe(2);
    expect(runners.find((r) => r.mode === "docker")?.labels).toContain("gh-runner-linux");
    expect(runners.find((r) => r.mode === "native")?.labels).toContain("gh-runner-mac");
  });

  it("--all takes everything possible and never errors on the rest", async () => {
    const { runner } = stubRunner({ "runners?per_page": ok("") });
    const { runners } = await ghRunner(
      { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir, all: true },
      base(runner, MAC),
    );
    // A Mac can serve macOS and, via Docker, Linux — but not Windows.
    expect(runners.map((r) => r.platform.os).sort()).toEqual(["linux", "osx"]);
  });

  it("--all on a host with no Docker falls back to the host alone", async () => {
    const { runner } = stubRunner({ "docker --version": { code: 1, stdout: "", stderr: "" } });
    const { runners } = await ghRunner(
      { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir, all: true },
      base(runner, MAC),
    );
    expect(runners.map((r) => r.platform.os)).toEqual(["osx"]);
  });

  it("asks interactively when nothing is specified", async () => {
    const { runner } = stubRunner({ "runners?per_page": ok("") });
    let offered: Array<{ label: string; disabled: boolean; selected: boolean }> = [];

    const { runners } = await ghRunner(
      { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir },
      {
        ...base(runner, MAC),
        selectPlatforms: (choices) => {
          offered = choices.map((c) => ({
            label: c.label,
            disabled: c.disabled,
            selected: c.selected,
          }));
          return Promise.resolve(["linux"]);
        },
      },
    );

    expect(offered).toEqual([
      { label: "macOS", disabled: false, selected: true },
      { label: "Linux", disabled: false, selected: false },
      { label: "Windows", disabled: true, selected: false },
    ]);
    expect(runners.map((r) => r.platform.os)).toEqual(["linux"]);
  });

  it("skips the menu when there's only one answer, and says why", async () => {
    // A Linux box with no Docker can only ever be a Linux runner.
    const { runner } = stubRunner({ "docker --version": { code: 1, stdout: "", stderr: "" } });
    let asked = 0;
    const lines: string[] = [];

    const { runners } = await ghRunner(
      { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir },
      {
        ...base(runner),
        logger: recordingLogger(lines),
        selectPlatforms: () => {
          asked += 1;
          return Promise.resolve([]);
        },
      },
    );

    expect(asked).toBe(0);
    expect(runners.map((r) => r.platform.os)).toEqual(["linux"]);

    const said = lines.join("");
    expect(said).toContain("Linux is the only platform this machine can serve");
    expect(said).toContain("✗ macOS");
    expect(said).toContain("✗ Windows");
  });

  it("still asks when the machine can serve more than one platform", async () => {
    const { runner } = stubRunner({ "runners?per_page": ok("") });
    let asked = 0;

    await ghRunner(
      { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir },
      {
        ...base(runner, MAC),
        selectPlatforms: () => {
          asked += 1;
          return Promise.resolve(["osx"]);
        },
      },
    );

    expect(asked).toBe(1);
  });

  it("treats a cancelled menu as an interrupt", async () => {
    // A Mac with Docker has two options, so the menu really is shown.
    const { runner } = stubRunner();
    await expect(
      ghRunner(
        { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir },
        { ...base(runner, MAC), selectPlatforms: () => Promise.resolve(null) },
      ),
    ).rejects.toThrow(/interrupted/);
  });
});

describe("containerised runners", () => {
  it("removes the container and deregisters even when the run fails", async () => {
    const { runner, calls } = stubRunner({
      "docker run": { code: 1, stdout: "", stderr: "boom" },
      "runners?per_page": ok("42"),
    });

    await ghRunner(
      {
        repo: "octocat/private-thing",
        runnerVersion: VERSION,
        cacheDir,
        platforms: ["linux"],
        dockerImage: "my/runner:1",
      },
      base(runner),
    );

    expect(calls.some((c) => c.command === "docker" && c.args[0] === "rm")).toBe(true);
    expect(calls.some((c) => c.args.join(" ").includes("-X DELETE"))).toBe(true);
  });

  it("labels the container by the platform it was told to use", async () => {
    const { runner } = stubRunner({ "runners?per_page": ok("") });
    const { runners } = await ghRunner(
      {
        repo: "octocat/private-thing",
        runnerVersion: VERSION,
        cacheDir,
        platforms: ["linux"],
        dockerPlatform: "linux/amd64",
      },
      base(runner, MAC),
    );
    expect(runners[0]?.platform).toEqual({ os: "linux", arch: "x64" });
  });
});

describe("the workflow audit", () => {
  const withWorkflow = async (body: string) => {
    const repoRoot = await mkdtemp(join(tmpdir(), "gh-runner-repo-"));
    await mkdir(join(repoRoot, ".github", "workflows"), { recursive: true });
    await writeFile(join(repoRoot, ".github", "workflows", "ci.yml"), body);
    return repoRoot;
  };

  it("audits against every runner's labels and offers to fix", async () => {
    const repoRoot = await withWorkflow(
      ["jobs:", "  build:", "    runs-on: ubuntu-latest"].join("\n"),
    );
    const { runner } = stubRunner({ "rev-parse --show-toplevel": ok(repoRoot) });
    const asked: string[] = [];

    const { workflows } = await ghRunner(
      { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir },
      {
        ...base(runner),
        confirm: (question) => {
          asked.push(question);
          return Promise.resolve(false);
        },
      },
    );

    expect(workflows?.hosted.map((t) => t.job)).toEqual(["build"]);
    expect(asked[0]).toMatch(/Update 1 job to runs-on: \[self-hosted, gh-runner\]/);
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("counts a job as matching when any one runner can take it", async () => {
    const repoRoot = await withWorkflow(
      ["jobs:", "  only-linux:", "    runs-on: [self-hosted, gh-runner-linux]"].join("\n"),
    );
    const { runner } = stubRunner({
      "rev-parse --show-toplevel": ok(repoRoot),
      "runners?per_page": ok(""),
    });
    let asked = 0;

    // A Mac serving both macOS and Linux: the Linux-only job matches.
    const { workflows } = await ghRunner(
      {
        repo: "octocat/private-thing",
        runnerVersion: VERSION,
        cacheDir,
        platforms: ["mac", "linux"],
      },
      {
        ...base(runner, MAC),
        confirm: () => {
          asked += 1;
          return Promise.resolve(true);
        },
      },
    );

    expect(workflows?.matches.map((t) => t.job)).toEqual(["only-linux"]);
    expect(asked).toBe(0);
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("skips the audit entirely with --no-workflow-check", async () => {
    const { runner } = stubRunner();
    const { workflows } = await ghRunner(
      { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir, skipWorkflowCheck: true },
      base(runner),
    );
    expect(workflows).toBeUndefined();
  });
});

describe("interruption", () => {
  it("stops before touching the network when already aborted", async () => {
    const { runner, calls } = stubRunner();
    const abort = new AbortController();
    abort.abort();

    await expect(
      ghRunner(
        { repo: "octocat/private-thing", runnerVersion: VERSION, cacheDir },
        { ...base(runner), signal: abort.signal },
      ),
    ).rejects.toThrow();

    expect(calls.some((c) => c.command.endsWith("run.sh"))).toBe(false);
  });
});
