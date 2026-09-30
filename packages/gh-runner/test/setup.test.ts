import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { execCommand } from "../src/exec.js";
import type { CommandRunner, ExecResult } from "../src/exec.js";
import { silentLogger } from "../src/logger.js";
import { parseArgs } from "../src/options.js";
import { ghRunnerSetup } from "../src/setup.js";

const WORKFLOW = [
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "  bundle:",
  "    runs-on: macos-14",
  "",
].join("\n");

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

let root = "";
let checkout = "";
let visibility = "PRIVATE";
let ghCalls: string[] = [];

/** Real git, stubbed gh. */
const runner: CommandRunner = (command, args, options) => {
  if (command === "gh") {
    const line = args.join(" ");
    ghCalls.push(line);
    if (line.includes("nameWithOwner")) return Promise.resolve(ok("octocat/thing\n"));
    if (line.includes("visibility")) return Promise.resolve(ok(`${visibility}\n`));
    if (line.includes("defaultBranchRef")) return Promise.resolve(ok("main\n"));
    if (line.includes("pr create")) {
      return Promise.resolve(ok("https://github.com/octocat/thing/pull/9\n"));
    }
    return Promise.resolve(ok(""));
  }
  return execCommand(command, args, options);
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const remoteBranches = () => git(checkout, "ls-remote", "--heads", "origin");

beforeEach(async () => {
  ghCalls = [];
  visibility = "PRIVATE";
  root = await mkdtemp(join(tmpdir(), "gh-runner-setup-"));
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

const setup = (options: Parameters<typeof ghRunnerSetup>[0] = {}) =>
  ghRunnerSetup({ cwd: checkout, ...options }, { commandRunner: runner, logger: silentLogger });

describe("ghRunnerSetup", () => {
  it("opens the fallback PR for every hosted job, and registers nothing", async () => {
    const { repo, fix } = await setup();

    expect(repo).toBe("octocat/thing");
    expect(fix.status).toBe("opened");
    if (fix.status !== "opened") return;
    expect(fix.url).toBe("https://github.com/octocat/thing/pull/9");
    expect(fix.jobs.map((job) => [job.job, job.label])).toEqual([
      ["build", "gh-runner-linux"],
      ["bundle", "gh-runner-mac"],
    ]);

    const pushed = git(checkout, "show", `origin/${fix.branch}:.github/workflows/ci.yml`);
    expect(pushed).toContain("runs-on: ${{ vars.GH_RUNNER_LINUX || 'ubuntu-latest' }}");
    expect(pushed).toContain("runs-on: ${{ vars.GH_RUNNER_MAC || 'macos-14' }}");

    // No registration token, no runner release lookup, no variables.
    expect(ghCalls.some((call) => call.includes("actions/runners"))).toBe(false);
    expect(ghCalls.some((call) => call.includes("actions/variables"))).toBe(false);
    expect(ghCalls.some((call) => call.includes("actions/runner/releases"))).toBe(false);
  });

  it("pushes nothing on a dry run", async () => {
    const { fix } = await setup({ dryRun: true });

    expect(fix.status).toBe("dry-run");
    expect(remoteBranches()).not.toContain("gh-runner/");
    expect(ghCalls.some((call) => call.includes("pr create"))).toBe(false);
  });

  it("says so when the repo is already set up", async () => {
    await writeFile(
      join(checkout, ".github", "workflows", "ci.yml"),
      "jobs:\n  build:\n    runs-on: ${{ vars.GH_RUNNER_LINUX || 'ubuntu-latest' }}\n",
    );
    git(checkout, "commit", "--quiet", "-am", "already");
    git(checkout, "push", "--quiet", "origin", "main");

    const { fix } = await setup();
    expect(fix.status).toBe("no-changes");
  });

  it("refuses a public repo, since no gh-runner would ever serve it", async () => {
    visibility = "PUBLIC";

    await expect(setup()).rejects.toThrow(CliError);
    await expect(setup()).rejects.toThrow(/PUBLIC/);
    expect(remoteBranches()).not.toContain("gh-runner/");
  });

  it("goes ahead on a public repo with --allow-public", async () => {
    visibility = "PUBLIC";

    const { fix } = await setup({ allowPublic: true, dryRun: true });
    expect(fix.status).toBe("dry-run");
  });

  it("needs a checkout to work from", async () => {
    await expect(setup({ cwd: root })).rejects.toThrow(/inside a checkout/);
  });
});

describe("parseArgs setup", () => {
  it("reads setup and its flags", () => {
    const { kind, options } = parseArgs(["setup", "--dry-run", "--fix-jobs", "build"]);
    expect(kind).toBe("setup");
    expect(options.dryRun).toBe(true);
    expect(options.fixJobs).toEqual(["build"]);
  });

  it("rejects platforms, which setup would ignore", () => {
    expect(() => parseArgs(["setup", "linux"])).toThrow(/no platforms/);
    expect(() => parseArgs(["setup", "--all"])).toThrow(/no platforms/);
  });

  it("keeps --dry-run to setup", () => {
    expect(() => parseArgs(["--dry-run"])).toThrow(/only applies to: gh-runner setup/);
  });

  it("still shows help", () => {
    expect(parseArgs(["setup", "--help"]).kind).toBe("help");
  });
});
