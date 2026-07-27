import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { OS_NAMES } from "./constants.js";
import { CliError } from "./errors.js";
import { execCapture } from "./exec.js";
import type { CommandRunner } from "./exec.js";

export type RunnerOs = "osx" | "linux" | "win";
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
    case "win32":
      os = "win";
      break;
    default:
      throw new CliError(`unsupported OS: ${platform} (macOS, Linux, and Windows only)`);
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

/** actions/runner ships Windows as a .zip and everything else as a .tar.gz. */
export function runnerArchive(platform: RunnerPlatform, version: string): string {
  const extension = platform.os === "win" ? "zip" : "tar.gz";
  return `actions-runner-${platform.os}-${platform.arch}-${version}.${extension}`;
}

export function runnerDownloadUrl(platform: RunnerPlatform, version: string): string {
  return `https://github.com/actions/runner/releases/download/v${version}/${runnerArchive(platform, version)}`;
}

/** `config.sh`/`run.sh`, or their `.cmd` counterparts on Windows. */
export function runnerScript(platform: RunnerPlatform, name: "config" | "run"): string {
  return platform.os === "win" ? `${name}.cmd` : `${name}.sh`;
}

/** The labels GitHub attaches to every self-hosted runner, as it spells them. */
export function implicitLabels(platform: RunnerPlatform): string[] {
  return ["self-hosted", OS_NAMES[platform.os], platform.arch.toUpperCase()];
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

export function defaultCacheDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return join(env["LOCALAPPDATA"] || join(homedir(), "AppData", "Local"), "gh-runner", "cache");
  }
  const base = env["XDG_CACHE_HOME"] || join(env["HOME"] || homedir(), ".cache");
  return join(base, "gh-runner");
}
