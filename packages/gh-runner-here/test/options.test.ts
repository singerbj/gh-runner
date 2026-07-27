import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { parseArgs, parseLabels } from "../src/options.js";

describe("parseArgs", () => {
  it("defaults to a single ephemeral job on the detected repo", () => {
    const { kind, options } = parseArgs([]);
    expect(kind).toBe("run");
    expect(options.keep).toBe(false);
    expect(options.allowPublic).toBe(false);
    expect(options.repo).toBeUndefined();
    expect(options.labels).toEqual([]);
  });

  it("reads every long option", () => {
    const { options } = parseArgs([
      "--keep",
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

    expect(options.keep).toBe(true);
    expect(options.allowPublic).toBe(true);
    expect(options.repo).toBe("octocat/hello-world");
    expect(options.labels).toEqual(["gpu", "macos"]);
    expect(options.name).toBe("bench-01");
    expect(options.runnerVersion).toBe("2.334.0");
    expect(options.cacheDir).toBe("/tmp/cache");
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
    expect(() => parseArgs(["--labels", "--keep"])).toThrow(/--labels needs a value/);
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
