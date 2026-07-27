import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execCommand } from "../src/exec.js";
import type { CommandRunner, ExecResult } from "../src/exec.js";
import { GhClient } from "../src/gh.js";
import { proposeWorkflowFix } from "../src/fix.js";
import { silentLogger } from "../src/logger.js";

const WORKFLOW = [
  "name: CI",
  "on: push",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: make",
  "  local:",
  "    runs-on: [self-hosted, gh-runner]",
  "    steps:",
  "      - run: make bench",
  "",
].join("\n");

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

let root = "";
let checkout = "";
let ghCalls: Array<readonly string[]> = [];

/** Real git, stubbed gh. */
const runner: CommandRunner = (command, args, options) => {
  if (command === "gh") {
    ghCalls.push(args);
    const line = args.join(" ");
    if (line.includes("defaultBranchRef")) return Promise.resolve(ok("main\n"));
    if (line.includes("pr list")) return Promise.resolve(ok(""));
    if (line.includes("pr create")) {
      return Promise.resolve(ok("https://github.com/octocat/thing/pull/7\n"));
    }
    return Promise.resolve(ok(""));
  }
  return execCommand(command, args, options);
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(async () => {
  ghCalls = [];
  root = await mkdtemp(join(tmpdir(), "gh-runner-test-"));

  // A bare repo standing in for origin, plus a checkout with one workflow.
  const origin = join(root, "origin.git");
  checkout = join(root, "checkout");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["clone", "--quiet", origin, checkout]);

  git(checkout, "config", "user.email", "test@example.com");
  git(checkout, "config", "user.name", "Test");
  await mkdir(join(checkout, ".github", "workflows"), { recursive: true });
  await writeFile(join(checkout, ".github", "workflows", "ci.yml"), WORKFLOW);
  git(checkout, "add", "-A");
  git(checkout, "commit", "--quiet", "-m", "init");
  git(checkout, "push", "--quiet", "-u", "origin", "main");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const propose = (overrides: Partial<Parameters<typeof proposeWorkflowFix>[0]> = {}) =>
  proposeWorkflowFix({
    repo: "octocat/thing",
    repoRoot: checkout,
    label: "gh-runner",
    commandRunner: runner,
    gh: new GhClient({ runner }),
    logger: silentLogger,
    ...overrides,
  });

describe("proposeWorkflowFix", () => {
  it("opens a PR that repoints only the hosted jobs", async () => {
    const result = await propose();

    expect(result.status).toBe("opened");
    if (result.status !== "opened") return;
    expect(result.files).toEqual([".github/workflows/ci.yml"]);
    expect(result.jobs).toEqual([{ file: ".github/workflows/ci.yml", job: "build" }]);
    expect(result.url).toBe("https://github.com/octocat/thing/pull/7");

    // The branch really landed on the remote, with only `build` changed.
    const pushed = git(
      checkout,
      "show",
      "refs/remotes/origin/gh-runner/target-self-hosted:.github/workflows/ci.yml",
    );
    expect(pushed).toContain("  build:\n    runs-on: [self-hosted, gh-runner]");
    expect(pushed).toContain("  local:\n    runs-on: [self-hosted, gh-runner]");
    expect(pushed).not.toContain("ubuntu-latest");

    const prCreate = ghCalls.find((args) => args.join(" ").includes("pr create"));
    expect(prCreate).toBeDefined();
    expect(prCreate).toContain("--base");
    expect(prCreate).toContain("main");
  });

  it("never touches the working tree, the index, or the current branch", async () => {
    // Uncommitted work in flight, exactly what a developer would have.
    await writeFile(join(checkout, "scratch.txt"), "work in progress");
    await writeFile(join(checkout, ".github", "workflows", "ci.yml"), `${WORKFLOW}# local edit\n`);
    git(checkout, "add", "scratch.txt");
    const statusBefore = git(checkout, "status", "--porcelain");
    const headBefore = git(checkout, "rev-parse", "HEAD");
    const branchBefore = git(checkout, "rev-parse", "--abbrev-ref", "HEAD");

    await propose();

    expect(git(checkout, "status", "--porcelain")).toBe(statusBefore);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branchBefore);
    expect(await readFile(join(checkout, ".github", "workflows", "ci.yml"), "utf8")).toContain(
      "# local edit",
    );
  });

  it("leaves no worktree, local branch, or temp directory behind", async () => {
    const before = await readdir(tmpdir());
    await propose();

    expect(git(checkout, "worktree", "list").split("\n")).toHaveLength(1);
    expect(git(checkout, "branch", "--list", "gh-runner/target-self-hosted")).toBe("");

    const after = await readdir(tmpdir());
    const leaked = after.filter(
      (entry) => entry.startsWith("gh-runner-fix-") && !before.includes(entry),
    );
    expect(leaked).toEqual([]);
  });

  it("cleans up even when opening the PR fails", async () => {
    const failing: CommandRunner = (command, args, options) => {
      if (command === "gh" && args.join(" ").includes("pr create")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "no permission" });
      }
      return runner(command, args, options);
    };

    await expect(
      propose({ commandRunner: failing, gh: new GhClient({ runner: failing }) }),
    ).rejects.toThrow(/couldn't open a pull request/);
    expect(git(checkout, "worktree", "list").split("\n")).toHaveLength(1);
    expect(git(checkout, "branch", "--list", "gh-runner/target-self-hosted")).toBe("");
  });

  it("narrows the rewrite to the jobs it was given", async () => {
    const result = await propose({ jobs: ["nope"] });
    expect(result.status).toBe("no-changes");
    expect(git(checkout, "branch", "--list", "gh-runner/target-self-hosted")).toBe("");
  });

  it("refuses to stack a second PR on an existing branch", async () => {
    await propose();
    const second = await propose();
    expect(second.status).toBe("branch-exists");
  });

  it("reports no changes when every job already targets the runner", async () => {
    await writeFile(
      join(checkout, ".github", "workflows", "ci.yml"),
      ["jobs:", "  local:", "    runs-on: [self-hosted, gh-runner]"].join("\n"),
    );
    git(checkout, "commit", "--quiet", "-am", "all local");
    git(checkout, "push", "--quiet", "origin", "main");

    expect((await propose()).status).toBe("no-changes");
  });
});
