import { describe, expect, it, vi } from "vitest";
import { CliError } from "../src/errors.js";
import type { CommandRunner } from "../src/exec.js";
import {
  defaultCacheDir,
  detectHostLabel,
  detectPlatform,
  runnerDownloadUrl,
  runnerTarball,
  slugify,
} from "../src/platform.js";

const ok = (stdout: string): ReturnType<CommandRunner> =>
  Promise.resolve({ code: 0, stdout, stderr: "" });
const fail = (): ReturnType<CommandRunner> =>
  Promise.resolve({ code: 1, stdout: "", stderr: "boom" });

describe("detectPlatform", () => {
  it("maps supported platform/arch pairs onto runner asset names", () => {
    expect(detectPlatform("darwin", "arm64")).toEqual({ os: "osx", arch: "arm64" });
    expect(detectPlatform("darwin", "x64")).toEqual({ os: "osx", arch: "x64" });
    expect(detectPlatform("linux", "x64")).toEqual({ os: "linux", arch: "x64" });
    expect(detectPlatform("linux", "arm64")).toEqual({ os: "linux", arch: "arm64" });
  });

  it("refuses unsupported platforms and architectures", () => {
    expect(() => detectPlatform("win32", "x64")).toThrow(CliError);
    expect(() => detectPlatform("linux", "s390x")).toThrow(/unsupported architecture/);
  });
});

describe("runner asset naming", () => {
  it("builds the tarball name and its release URL", () => {
    const platform = { os: "osx", arch: "arm64" } as const;
    expect(runnerTarball(platform, "2.334.0")).toBe("actions-runner-osx-arm64-2.334.0.tar.gz");
    expect(runnerDownloadUrl(platform, "2.334.0")).toBe(
      "https://github.com/actions/runner/releases/download/v2.334.0/actions-runner-osx-arm64-2.334.0.tar.gz",
    );
  });
});

describe("slugify", () => {
  it("produces a label GitHub will accept", () => {
    expect(slugify("Ben's MacBook Pro")).toBe("ben-s-macbook-pro");
    expect(slugify("---build-box---")).toBe("build-box");
    expect(slugify("!!!")).toBe("");
  });
});

describe("detectHostLabel", () => {
  it("prefers the macOS computer name", async () => {
    const runner = vi.fn<CommandRunner>(() => ok("Ben's MacBook Pro\n"));
    await expect(detectHostLabel(runner, "darwin")).resolves.toBe("ben-s-macbook-pro");
    expect(runner).toHaveBeenCalledWith("scutil", ["--get", "ComputerName"], undefined);
  });

  it("falls back to the short hostname when scutil is unavailable", async () => {
    const runner = vi.fn<CommandRunner>(() => fail());
    const label = await detectHostLabel(runner, "darwin");
    expect(label).not.toBe("");
    expect(label).toMatch(/^[a-z0-9-]+$/);
  });

  it("never shells out to scutil on Linux", async () => {
    const runner = vi.fn<CommandRunner>(() => ok("unused"));
    const label = await detectHostLabel(runner, "linux");
    expect(runner).not.toHaveBeenCalled();
    expect(label).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("defaultCacheDir", () => {
  it("honours XDG_CACHE_HOME, then HOME", () => {
    expect(defaultCacheDir({ XDG_CACHE_HOME: "/xdg" })).toBe("/xdg/gh-runner-here");
    expect(defaultCacheDir({ HOME: "/home/ben" })).toBe("/home/ben/.cache/gh-runner-here");
  });
});
