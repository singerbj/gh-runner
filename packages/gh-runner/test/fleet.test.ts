import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandRunner, ExecResult } from "../src/exec.js";
import { ghRunnerFleet, usesGhRunner } from "../src/fleet.js";
import type { FleetContext, RepoScan } from "../src/fleet.js";
import { GhClient } from "../src/gh.js";
import { createLogger, silentLogger } from "../src/logger.js";
import { inspectWorkflows } from "../src/workflows.js";

const VERSION = "2.334.0";
const TARBALL = `actions-runner-linux-x64-${VERSION}.tar.gz`;

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const notFound: ExecResult = { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };

const FALLBACK = "jobs:\n  build:\n    runs-on: ${{ vars.GH_RUNNER_LINUX || 'ubuntu-latest' }}\n";
const DIRECT = "jobs:\n  build:\n    runs-on: [self-hosted, gh-runner]\n";
const HOSTED = "jobs:\n  build:\n    runs-on: ubuntu-latest\n";
const BARE = "jobs:\n  build:\n    runs-on: [self-hosted]\n";
const MAC_ONLY = "jobs:\n  build:\n    runs-on: [self-hosted, gh-runner-mac]\n";

interface FakeRepo {
  visibility: "PRIVATE" | "PUBLIC";
  /** ci.yml's text, or null for a repo with no workflows. */
  workflow: string | null;
  pushedAt?: string;
}

/**
 * A `gh` and an actions runner, enough for the fleet: repos to list, their
 * workflows, and a run.sh that stays up until it's sent SIGINT — the way the
 * real one does.
 */
function fakeWorld(repos: Record<string, FakeRepo>) {
  const calls: string[] = [];
  const live = new Map<string, () => void>();

  const runner: CommandRunner = (command, args, options) => {
    const line = `${command} ${args.join(" ")}`;
    calls.push(line);

    if (command.endsWith("run.sh")) {
      const url = configs.get(options?.cwd ?? "") ?? "?";
      return new Promise((resolve) => {
        const child = new EventEmitter() as unknown as ChildProcess;
        const finish = () => {
          live.delete(url);
          resolve(ok(""));
          (child as unknown as EventEmitter).emit("exit", 0);
        };
        (child as unknown as { kill: () => boolean }).kill = () => {
          finish();
          return true;
        };
        live.set(url, finish);
        options?.onSpawn?.(child);
      });
    }
    if (command.endsWith("config.sh") && args[0] !== "remove") {
      const url = args[args.indexOf("--url") + 1] ?? "";
      configs.set(options?.cwd ?? "", url.replace("https://github.com/", ""));
      return writeFile(join(options?.cwd ?? "", ".runner"), "{}").then(() => ok(""));
    }

    if (line.includes("gh --version")) return Promise.resolve(ok("gh version 2.60.0"));
    if (line.includes("auth status")) return Promise.resolve(ok("Logged in"));
    if (line.includes("api user --jq .login")) return Promise.resolve(ok("me"));
    if (line.includes("--paginate user/repos")) {
      return Promise.resolve(
        ok(
          Object.entries(repos)
            .map(
              ([name, repo]) =>
                `${name}\t${repo.visibility.toLowerCase()}\t${repo.pushedAt ?? "t1"}`,
            )
            .join("\n"),
        ),
      );
    }
    const visibility = /repo view (\S+) --json visibility/.exec(line);
    if (visibility) return Promise.resolve(ok(repos[visibility[1] ?? ""]?.visibility ?? ""));

    const list = /api repos\/([^/]+\/[^/]+)\/contents\/\.github\/workflows --jq/.exec(line);
    if (list) {
      const repo = repos[list[1] ?? ""];
      return Promise.resolve(repo?.workflow ? ok("ci.yml") : notFound);
    }
    const read = /repos\/([^/]+\/[^/]+)\/contents\/\.github\/workflows\/ci\.yml/.exec(line);
    if (read) return Promise.resolve(ok(repos[read[1] ?? ""]?.workflow ?? ""));

    if (line.includes("registration-token")) return Promise.resolve(ok("REG123"));
    if (line.includes("remove-token")) return Promise.resolve(ok("RM123"));
    return Promise.resolve(ok(""));
  };
  const configs = new Map<string, string>();

  return { runner, calls, live };
}

let cacheDir = "";
beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "gh-runner-fleet-"));
  await writeFile(join(cacheDir, TARBALL), "not-really-a-tarball");
});
afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

const until = async (condition: () => boolean, what: string) => {
  for (let i = 0; i < 400; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const context = (
  runner: CommandRunner,
  abort: AbortController,
  extra: Partial<FleetContext> = {},
) => ({
  commandRunner: runner,
  gh: new GhClient({ runner }),
  platform: { os: "linux", arch: "x64" } as const,
  nodePlatform: "linux" as const,
  logger: process.env.DEBUG_FLEET ? createLogger() : silentLogger,
  signal: abort.signal,
  ...extra,
});

const opts = () => ({ runnerVersion: VERSION, cacheDir, skipWorkflowCheck: true });

describe("ghRunnerFleet", () => {
  it("serves every private repo whose workflows send jobs to gh-runner, and nothing else", async () => {
    const world = fakeWorld({
      "me/fallback": { visibility: "PRIVATE", workflow: FALLBACK },
      "me/direct": { visibility: "PRIVATE", workflow: DIRECT },
      "me/hosted": { visibility: "PRIVATE", workflow: HOSTED },
      "me/bare": { visibility: "PRIVATE", workflow: BARE },
      "me/mac-only": { visibility: "PRIVATE", workflow: MAC_ONLY },
      "me/empty": { visibility: "PRIVATE", workflow: null },
      "me/open": { visibility: "PUBLIC", workflow: DIRECT },
    });
    const abort = new AbortController();
    const scans: RepoScan[] = [];

    const done = ghRunnerFleet(
      { ...opts(), allRepos: true },
      context(world.runner, abort, { onScan: (scan) => scans.push(scan) }),
    );
    await until(() => world.live.size === 2, "two runners");

    expect([...world.live.keys()].toSorted()).toEqual(["me/direct", "me/fallback"]);
    expect(scans[0]).toMatchObject({
      serve: ["me/direct", "me/fallback"],
      skippedPublic: ["me/open"],
      scanned: 7,
    });

    abort.abort();
    for (const finish of world.live.values()) finish();
    const result = await done;
    expect(result.repos).toEqual(["me/direct", "me/fallback"]);
    expect(result.runners.map((r) => r.repo).toSorted()).toEqual(["me/direct", "me/fallback"]);
    // Both deregistered on the way out.
    expect(world.calls.filter((c) => c.includes("config.sh remove"))).toHaveLength(2);
  });

  it("serves --repos as given, without scanning anything", async () => {
    const world = fakeWorld({ "me/named": { visibility: "PRIVATE", workflow: HOSTED } });
    const abort = new AbortController();

    const done = ghRunnerFleet({ ...opts(), repos: ["me/named"] }, context(world.runner, abort));
    await until(() => world.live.has("me/named"), "the named repo");

    expect(world.calls.some((c) => c.includes("user/repos"))).toBe(false);
    abort.abort();
    for (const finish of world.live.values()) finish();
    await done;
  });

  it("picks up a repo set up later, and takes down one that stopped using gh-runner", async () => {
    const repos: Record<string, FakeRepo> = {
      "me/old": { visibility: "PRIVATE", workflow: DIRECT },
      "me/new": { visibility: "PRIVATE", workflow: HOSTED },
    };
    const world = fakeWorld(repos);
    const abort = new AbortController();

    const done = ghRunnerFleet(
      { ...opts(), allRepos: true },
      context(world.runner, abort, { rescanMs: 30 }),
    );
    await until(() => world.live.has("me/old"), "the first repo");

    repos["me/new"] = { visibility: "PRIVATE", workflow: FALLBACK, pushedAt: "t2" };
    repos["me/old"] = { visibility: "PRIVATE", workflow: HOSTED, pushedAt: "t2" };
    await until(() => world.live.has("me/new") && !world.live.has("me/old"), "the swap");

    abort.abort();
    for (const finish of world.live.values()) finish();
    const result = await done;
    expect(result.repos).toEqual(["me/new", "me/old"]);
  });

  it("doesn't re-read a repo nothing was pushed to", async () => {
    const world = fakeWorld({ "me/direct": { visibility: "PRIVATE", workflow: DIRECT } });
    const abort = new AbortController();
    let scans = 0;

    const done = ghRunnerFleet(
      { ...opts(), allRepos: true },
      context(world.runner, abort, { rescanMs: 10, onScan: () => (scans += 1) }),
    );
    await until(() => scans >= 3, "three scans");
    abort.abort();
    for (const finish of world.live.values()) finish();
    await done;

    const reads = world.calls.filter((c) => c.includes("contents/.github/workflows/ci.yml"));
    expect(reads).toHaveLength(1);
  });

  it("tries a repo whose runner failed again, later", async () => {
    const world = fakeWorld({ "me/flaky": { visibility: "PRIVATE", workflow: DIRECT } });
    let tokens = 0;
    const runner: CommandRunner = (command, args, execOptions) => {
      if (args.join(" ").includes("registration-token") && (tokens += 1) === 1) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "HTTP 403" });
      }
      return world.runner(command, args, execOptions);
    };
    const abort = new AbortController();

    const done = ghRunnerFleet(
      { ...opts(), allRepos: true },
      context(runner, abort, { retryBaseMs: 10 }),
    );
    await until(() => world.live.has("me/flaky"), "the retry");
    expect(tokens).toBe(2);

    abort.abort();
    for (const finish of world.live.values()) finish();
    await done;
  });
});

describe("usesGhRunner", () => {
  const report = (yaml: string) =>
    inspectWorkflows({ list: async () => ["ci.yml"], read: async () => yaml }, [
      ["self-hosted", "Linux", "X64", "gh-runner", "gh-runner-linux", "box"],
    ]);
  const labels = ["gh-runner", "gh-runner-linux", "box"];

  it("is true for a fallback job or one that names a gh-runner label", async () => {
    expect(usesGhRunner(await report(FALLBACK), labels)).toBe(true);
    expect(usesGhRunner(await report(DIRECT), labels)).toBe(true);
  });

  it("is false for hosted jobs, a bare self-hosted, and labels this machine lacks", async () => {
    expect(usesGhRunner(await report(HOSTED), labels)).toBe(false);
    expect(usesGhRunner(await report(BARE), labels)).toBe(false);
    expect(usesGhRunner(await report(MAC_ONLY), labels)).toBe(false);
  });
});
