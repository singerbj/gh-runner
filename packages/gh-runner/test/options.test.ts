import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { parseArgs, parseLabels } from "../src/options.js";

describe("parseArgs", () => {
  it("defaults to staying online on the detected repo", () => {
    const { kind, options } = parseArgs([]);
    expect(kind).toBe("run");
    expect(options.once).toBe(false);
    expect(options.allowPublic).toBe(false);
    expect(options.repo).toBeUndefined();
    expect(options.labels).toEqual([]);
  });

  it("reads every long option", () => {
    const { options } = parseArgs([
      "--once",
      "--allow-public",
      "--repo",
      "octocat/hello-world",
      "--labels",
      "gpu, macos ,",
      "--name",
      "bench-01",
      "--runner-version",
      "v2.334.0",
      "--cache-dir",
      "/tmp/cache",
    ]);

    expect(options.once).toBe(true);
    expect(options.allowPublic).toBe(true);
    expect(options.repo).toBe("octocat/hello-world");
    expect(options.labels).toEqual(["gpu", "macos"]);
    expect(options.name).toBe("bench-01");
    expect(options.runnerVersion).toBe("2.334.0");
    expect(options.cacheDir).toBe("/tmp/cache");
  });

  it.each([["--self-hosted-probe"], ["--no-hosted-fallback"], ["--hosted-first"]])(
    "still accepts the retired %s, and says it isn't needed",
    (flag) => {
      const parsed = parseArgs([flag, "linux"]);
      expect(parsed.kind).toBe("run");
      expect(parsed.options.platforms).toEqual(["linux"]);
      expect(parsed.warnings).toEqual([expect.stringContaining(`${flag} is no longer needed`)]);
    },
  );

  it("serves every repo with --all-repos, and an owner implies it", () => {
    expect(parseArgs(["--all-repos", "linux"]).options).toMatchObject({
      allRepos: true,
      owners: [],
      platforms: ["linux"],
      fixWorkflows: "never",
    });
    expect(parseArgs(["--owner", "me,my-org"]).options).toMatchObject({
      allRepos: true,
      owners: ["me", "my-org"],
    });
    expect(parseArgs(["--repos", "me/a, me/b"]).options).toMatchObject({
      allRepos: false,
      repos: ["me/a", "me/b"],
    });
  });

  it("serves every repo by default, and one repo when asked to", () => {
    expect(parseArgs([]).options).toMatchObject({ allRepos: true, fixWorkflows: "never" });
    expect(parseArgs(["mac", "linux"]).options.allRepos).toBe(true);
    expect(parseArgs(["--here"]).options).toMatchObject({ allRepos: false, fixWorkflows: "ask" });
    expect(parseArgs(["--repo", "me/a"]).options).toMatchObject({ allRepos: false, repo: "me/a" });
    // Changing workflows needs one repo's checkout.
    expect(parseArgs(["--fix-workflows"]).options).toMatchObject({
      allRepos: false,
      fixWorkflows: "always",
    });
    expect(parseArgs(["--fix-jobs", "build"]).options.allRepos).toBe(false);
    expect(parseArgs(["--fix-label", "gh-runner"]).options.allRepos).toBe(false);
  });

  it("refuses one repo and several at once", () => {
    expect(() => parseArgs(["--here", "--owner", "me"])).toThrow(/--here serves one repo/);
    expect(() => parseArgs(["--repo", "me/a", "--repos", "me/b"])).toThrow(/--repo serves one/);
    expect(() => parseArgs(["--owner", "me", "--fix-jobs", "build"])).toThrow(/--here/);
  });

  it("refuses what can't mean anything across several repos", () => {
    expect(() => parseArgs(["--all-repos", "--repo", "me/a"])).toThrow(/--repos/);
    expect(() => parseArgs(["--all-repos", "--fix-workflows"])).toThrow(/setup/);
    expect(() => parseArgs(["--repos", "not-a-slug"])).toThrow(CliError);
    expect(() => parseArgs(["--owner", "bad/owner"])).toThrow(/--owner/);
  });

  it("has nothing to warn about normally", () => {
    expect(parseArgs(["--fix-workflows"]).warnings).toEqual([]);
  });

  it.each([["-h"], ["--help"]])("treats %s as help", (flag) => {
    expect(parseArgs([flag]).kind).toBe("help");
  });

  it.each([["-v"], ["--version"]])("treats %s as version", (flag) => {
    expect(parseArgs([flag]).kind).toBe("version");
  });

  it("rejects unknown options", () => {
    expect(() => parseArgs(["--nope"])).toThrow(CliError);
    expect(() => parseArgs(["--nope"])).toThrow(/unknown option: --nope/);
  });

  it("rejects a flag whose value is missing", () => {
    expect(() => parseArgs(["--repo"])).toThrow(/--repo needs a value/);
    expect(() => parseArgs(["--labels", "--once"])).toThrow(/--labels needs a value/);
  });

  it("rejects a repo that is not OWNER/NAME", () => {
    expect(() => parseArgs(["--repo", "hello-world"])).toThrow(/expects OWNER\/NAME/);
    expect(() => parseArgs(["--repo", "a/b/c"])).toThrow(/expects OWNER\/NAME/);
  });
});

describe("parseLabels", () => {
  it("trims, drops empties, and preserves order", () => {
    expect(parseLabels(" a , b ,,c,")).toEqual(["a", "b", "c"]);
    expect(parseLabels("")).toEqual([]);
  });
});
