import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import {
  availableTargets,
  parseTargetName,
  parseTargetNames,
  planOptions,
  resolveTargets,
} from "../src/targets.js";

const ready = (hostOs: "osx" | "linux" | "win", dockerReady = true) =>
  planOptions({ hostOs, dockerReady, dockerReason: "Docker isn't running" });

const modes = (options: ReturnType<typeof planOptions>) =>
  Object.fromEntries(options.map((option) => [option.os, option.mode]));

describe("planOptions", () => {
  it("serves the host OS natively and Linux from a container", () => {
    expect(modes(ready("osx"))).toEqual({ osx: "native", linux: "docker", win: null });
    expect(modes(ready("win"))).toEqual({ osx: null, linux: "docker", win: "native" });
  });

  it("prefers native Linux on a Linux host", () => {
    expect(modes(ready("linux"))).toEqual({ osx: null, linux: "native", win: null });
  });

  it("containerises Linux even on Linux when asked to", () => {
    const options = planOptions({ hostOs: "linux", dockerReady: true, preferDocker: true });
    expect(modes(options)).toEqual({ osx: null, linux: "docker", win: null });
  });

  it("marks Linux unavailable, with the reason, when Docker isn't usable", () => {
    const options = ready("osx", false);
    const linux = options.find((option) => option.os === "linux");
    expect(linux?.available).toBe(false);
    expect(linux?.detail).toBe("Docker isn't running");
  });

  it("explains why macOS and Windows can't be faked", () => {
    const options = ready("linux");
    expect(options.find((o) => o.os === "osx")?.detail).toMatch(/can't be containerised/);
    expect(options.find((o) => o.os === "win")?.detail).toMatch(/only run on Windows/);
  });
});

describe("parseTargetName", () => {
  it.each([
    ["mac", "osx"],
    ["macOS", "osx"],
    ["darwin", "osx"],
    ["OSX", "osx"],
    ["linux", "linux"],
    ["windows", "win"],
    ["win", "win"],
  ])("reads %s as %s", (input, expected) => {
    expect(parseTargetName(input)).toBe(expected);
  });

  it("rejects anything else", () => {
    expect(() => parseTargetName("solaris")).toThrow(CliError);
    expect(() => parseTargetName("solaris")).toThrow(/unknown platform: solaris/);
  });
});

describe("parseTargetNames", () => {
  it("accepts separate words and comma-separated lists alike", () => {
    expect(parseTargetNames(["mac", "linux"]).targets).toEqual(["osx", "linux"]);
    expect(parseTargetNames(["mac,linux"]).targets).toEqual(["osx", "linux"]);
    expect(parseTargetNames(["mac, linux ,windows"]).targets).toEqual(["osx", "linux", "win"]);
  });

  it("deduplicates and keeps the order given", () => {
    expect(parseTargetNames(["linux", "mac", "linux"]).targets).toEqual(["linux", "osx"]);
  });

  it("flags all separately, so it can mean 'whatever works'", () => {
    expect(parseTargetNames(["all"])).toEqual({ all: true, targets: [] });
    expect(parseTargetNames(["all", "mac"])).toEqual({ all: true, targets: ["osx"] });
  });

  it("treats an empty list as no request at all", () => {
    expect(parseTargetNames([])).toEqual({ all: false, targets: [] });
  });
});

describe("resolveTargets", () => {
  it("resolves what the host can serve", () => {
    const resolved = resolveTargets(["osx", "linux"], ready("osx"));
    expect(resolved.map((target) => [target.os, target.mode])).toEqual([
      ["osx", "native"],
      ["linux", "docker"],
    ]);
    expect(resolved[0]?.label).toBe("gh-runner-mac");
  });

  it("errors on a platform this machine can't be", () => {
    expect(() => resolveTargets(["win"], ready("osx"))).toThrow(CliError);
    expect(() => resolveTargets(["win"], ready("osx"))).toThrow(/Windows: needs a Windows machine/);
  });

  it("errors on Linux when Docker isn't usable, quoting the reason", () => {
    expect(() => resolveTargets(["linux"], ready("osx", false))).toThrow(/Docker isn't running/);
  });

  it("lists every impossible platform in one error", () => {
    const message = (() => {
      try {
        resolveTargets(["osx", "win"], ready("linux"));
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : "";
      }
    })();
    expect(message).toMatch(/macOS:/);
    expect(message).toMatch(/Windows:/);
    expect(message).toMatch(/those runners/);
  });
});

describe("availableTargets", () => {
  it("is what --all expands to, and never errors", () => {
    expect(availableTargets(ready("osx"))).toEqual(["osx", "linux"]);
    expect(availableTargets(ready("linux"))).toEqual(["linux"]);
    expect(availableTargets(ready("win", false))).toEqual(["win"]);
  });
});
