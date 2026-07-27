import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors.js";
import { execCapture } from "./exec.js";
import type { CommandRunner } from "./exec.js";

export type RunnerOs = "osx" | "linux";
export type RunnerArch = "x64" | "arm64";

export interface RunnerPlatform {
  os: RunnerOs;
  arch: RunnerArch;
}

/** Maps Node's platform/arch onto the names used in actions/runner release assets. */
export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): RunnerPlatform {
  let os: RunnerOs;
  switch (platform) {
    case "darwin":
      os = "osx";
      break;
    case "linux":
      os = "linux";
      break;
    default:
      throw new CliError(`unsupported OS: ${platform} (macOS and Linux only)`);
  }

  let runnerArch: RunnerArch;
  switch (arch) {
    case "arm64":
      runnerArch = "arm64";
      break;
    case "x64":
      runnerArch = "x64";
      break;
    default:
      throw new CliError(`unsupported architecture: ${arch}`);
  }

  return { os, arch: runnerArch };
}

export function runnerTarball(platform: RunnerPlatform, version: string): string {
  return `actions-runner-${platform.os}-${platform.arch}-${version}.tar.gz`;
}

export function runnerDownloadUrl(platform: RunnerPlatform, version: string): string {
  return `https://github.com/actions/runner/releases/download/v${version}/${runnerTarball(platform, version)}`;
}

/**
 * Lowercases and collapses everything that isn't `[a-z0-9]` into single dashes,
 * matching the `tr -cs` behaviour of the original shell script.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A stable, human-recognisable label for this machine. On macOS the
 * user-facing computer name beats the mDNS hostname, so try `scutil` first.
 */
export async function detectHostLabel(
  runner: CommandRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  let raw = "";

  if (platform === "darwin") {
    try {
      raw = await execCapture(runner, "scutil", ["--get", "ComputerName"]);
    } catch {
      raw = "";
    }
  }

  if (!raw) {
    raw = hostname().split(".")[0] ?? "";
  }

  return slugify(raw) || "local";
}

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env["XDG_CACHE_HOME"] || join(env["HOME"] || homedir(), ".cache");
  return join(base, "gh-runner-here");
}
