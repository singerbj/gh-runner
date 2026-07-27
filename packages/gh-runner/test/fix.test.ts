import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
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

/** One job per platform, plus one whose runner name says nothing about an OS. */
const MIXED_WORKFLOW = [
  "jobs:",
  "  mac:",
  "    runs-on: macos-14",
  "  linux:",
  "    runs-on: [ubuntu-latest]",
  "  windows:",
  "    runs-on: windows-2022",
  "  big:",
  "    runs-on: our-beefy-box",
  "",
].join("\n");

/** Replaces ci.yml on main, so a fix run sees this instead of {@link WORKFLOW}. */
const commitWorkflow = async (body: string) => {
  await writeFile(join(checkout, ".github", "workflows", "ci.yml"), body);
  git(checkout, "commit", "--quiet", "-am", "workflow");
  git(checkout, "push", "--quiet", "origin", "main");
};

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
    expect(result.jobs).toEqual([
      {
        file: ".github/workflows/ci.yml",
        job: "build",
        label: "gh-runner-linux",
        from: ["ubuntu-latest"],
      },
    ]);
    expect(result.url).toBe("https://github.com/octocat/thing/pull/7");

    // Randomized, so a branch left behind by an earlier run can't collide.
    expect(result.branch).toMatch(/^gh-runner\/target-self-hosted-[0-9a-f]{8}$/);

    // The branch really landed on the remote, with only `build` changed.
    const pushed = git(
      checkout,
      "show",
      `refs/remotes/origin/${result.branch}:.github/workflows/ci.yml`,
    );
    expect(pushed).toContain("  build:\n    runs-on: [self-hosted, gh-runner-linux]");
    expect(pushed).toContain("  local:\n    runs-on: [self-hosted, gh-runner]");
    expect(pushed).not.toContain("ubuntu-latest");

    const prCreate = ghCalls.find((args) => args.join(" ").includes("pr create"));
    expect(prCreate).toBeDefined();
    expect(prCreate).toContain("--base");
    expect(prCreate).toContain("main");
  });

  it("keeps each job on the platform it already ran on", async () => {
    await commitWorkflow(MIXED_WORKFLOW);

    const result = await propose();
    expect(result.status).toBe("opened");
    if (result.status !== "opened") return;

    expect(result.jobs.map(({ job, label }) => [job, label])).toEqual([
      ["mac", "gh-runner-mac"],
      ["linux", "gh-runner-linux"],
      ["windows", "gh-runner-windows"],
      // Nothing in `our-beefy-box` names an OS, so any machine will do.
      ["big", "gh-runner"],
    ]);

    const pushed = git(
      checkout,
      "show",
      `refs/remotes/origin/${result.branch}:.github/workflows/ci.yml`,
    );
    expect(pushed).toContain("  mac:\n    runs-on: [self-hosted, gh-runner-mac]");
    expect(pushed).toContain("  linux:\n    runs-on: [self-hosted, gh-runner-linux]");
    expect(pushed).toContain("  windows:\n    runs-on: [self-hosted, gh-runner-windows]");
    expect(pushed).toContain("  big:\n    runs-on: [self-hosted, gh-runner]");
  });

  it("says which platform each job wants in the PR it opens", async () => {
    await commitWorkflow(MIXED_WORKFLOW);
    await propose();

    const create = ghCalls.find((args) => args.join(" ").includes("pr create"));
    const body = create?.[create.indexOf("--body") + 1] ?? "";
    const title = create?.[create.indexOf("--title") + 1] ?? "";

    expect(title).toBe("Run CI on self-hosted runners");
    expect(body).toContain("`mac` in `.github/workflows/ci.yml` → `[self-hosted, gh-runner-mac]`");
    expect(body).toContain("was `macos-14`");
  });

  it("lets --fix-label override the per-job choice", async () => {
    await commitWorkflow(MIXED_WORKFLOW);

    const result = await propose({ label: "gh-runner-mac" });
    if (result.status !== "opened") throw new Error(`expected a PR, got ${result.status}`);
    expect(new Set(result.jobs.map((entry) => entry.label))).toEqual(new Set(["gh-runner-mac"]));
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
    expect(git(checkout, "branch", "--list", "gh-runner/target-self-hosted*")).toBe("");

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
    expect(git(checkout, "branch", "--list", "gh-runner/target-self-hosted*")).toBe("");
  });

  it("narrows the rewrite to the jobs it was given", async () => {
    const result = await propose({ jobs: ["nope"] });
    expect(result.status).toBe("no-changes");
    expect(git(checkout, "branch", "--list", "gh-runner/target-self-hosted*")).toBe("");
  });

  it("refuses to stack a second PR on an existing branch", async () => {
    const first = await propose();
    const second = await propose();
    expect(second.status).toBe("branch-exists");
    if (second.status !== "branch-exists" || first.status !== "opened") return;
    // Reported as the branch that is actually on the remote, not ours.
    expect(second.branch).toBe(first.branch);
  });

  it("works when an earlier run left its branch and worktree behind", async () => {
    // Exactly what a killed run leaves: a local branch and a stale worktree.
    const stale = await mkdtemp(join(tmpdir(), "gh-runner-stale-"));
    git(checkout, "worktree", "add", "--quiet", "-b", "gh-runner/target-self-hosted", stale);

    const result = await propose();

    expect(result.status).toBe("opened");
    if (result.status !== "opened") return;
    expect(result.branch).not.toBe("gh-runner/target-self-hosted");
    expect(git(checkout, "branch", "--list", result.branch)).toBe("");

    git(checkout, "worktree", "remove", "--force", stale);
    git(checkout, "branch", "-D", "gh-runner/target-self-hosted");
    await rm(stale, { recursive: true, force: true });
  });

  it("explains a worktree it couldn't check out", async () => {
    // The one name a run can't randomize is one it was handed.
    git(checkout, "branch", "taken");

    const failed = await propose({ branch: "taken" }).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(CliError);
    expect((failed as Error).message).toContain("couldn't check out taken");
    expect((failed as Error).message).toContain("already exists");
  });

  it("gives each run its own branch", async () => {
    const first = await propose();
    if (first.status !== "opened") throw new Error(`expected a PR, got ${first.status}`);

    // A pushed branch would short-circuit the second run, so start clean.
    git(checkout, "push", "--quiet", "origin", "--delete", first.branch);
    git(checkout, "fetch", "--quiet", "--prune", "origin");

    const second = await propose();
    if (second.status !== "opened") throw new Error(`expected a PR, got ${second.status}`);
    expect(second.branch).not.toBe(first.branch);
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
