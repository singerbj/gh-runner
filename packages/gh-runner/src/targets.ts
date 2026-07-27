import { OS_NAMES, osLabel } from "./constants.js";
import { CliError } from "./errors.js";
import type { RunnerOs } from "./platform.js";

/** The platforms a user can ask for, in the order the menu lists them. */
export const TARGET_ORDER: readonly RunnerOs[] = ["osx", "linux", "win"];

/** Every spelling accepted on the command line, mapped to a runner OS. */
const ALIASES: Readonly<Record<string, RunnerOs>> = {
  mac: "osx",
  macos: "osx",
  "mac-os": "osx",
  osx: "osx",
  darwin: "osx",
  apple: "osx",
  linux: "linux",
  ubuntu: "linux",
  win: "win",
  windows: "win",
};

/** How a platform would be served from this host, or why it can't be. */
export type TargetMode = "native" | "docker";

export interface PlatformOption {
  os: RunnerOs;
  /** `macOS`, `Linux`, `Windows`. */
  name: string;
  /** The label a runner for this platform registers. */
  label: string;
  /** How it would run, or null when this host can't serve it at all. */
  mode: TargetMode | null;
  /** One line explaining the mode, or the reason it's unavailable. */
  detail: string;
  available: boolean;
}

export interface PlanInput {
  hostOs: RunnerOs;
  /** Whether the Docker CLI is installed and its daemon is answering. */
  dockerReady: boolean;
  /** Why Docker can't be used, when `dockerReady` is false. */
  dockerReason?: string | undefined;
  /** Use a container for Linux even when the host is already Linux. */
  preferDocker?: boolean;
}

/**
 * Works out, for this host, how each platform could be served.
 *
 * Only Linux can come from somewhere other than the host: Docker runs Linux
 * containers everywhere. macOS has no container runtime at all, and Windows
 * containers share the host kernel, so those two are native-or-nothing.
 */
export function planOptions(input: PlanInput): PlatformOption[] {
  const { hostOs, dockerReady, preferDocker = false } = input;
  const dockerReason = input.dockerReason ?? "Docker isn't available";

  return TARGET_ORDER.map((os): PlatformOption => {
    const base = { os, name: OS_NAMES[os], label: osLabel(os) };

    if (os === hostOs && !(os === "linux" && preferDocker)) {
      return { ...base, mode: "native", detail: "native — this machine", available: true };
    }

    if (os === "linux") {
      return dockerReady
        ? {
            ...base,
            mode: "docker",
            detail: hostOs === "linux" ? "in a container" : "in a container, via Docker",
            available: true,
          }
        : { ...base, mode: null, detail: dockerReason, available: false };
    }

    return {
      ...base,
      mode: null,
      detail:
        os === "osx"
          ? `needs a ${OS_NAMES[os]} machine — macOS can't be containerised`
          : `needs a ${OS_NAMES[os]} machine — Windows containers only run on Windows`,
      available: false,
    };
  });
}

/** Turns `mac`, `macOS`, `darwin`, … into a runner OS. */
export function parseTargetName(value: string): RunnerOs {
  const key = value.trim().toLowerCase();
  const os = ALIASES[key];
  if (!os) {
    throw new CliError(`unknown platform: ${value}  (expected mac, linux, windows, or all)`);
  }
  return os;
}

export interface RequestedTargets {
  /** `all` was asked for: every platform this host can actually serve. */
  all: boolean;
  /** Explicitly named platforms, deduplicated, in the order given. */
  targets: RunnerOs[];
}

/** Parses a platform list like `mac,linux` or `all`. */
export function parseTargetNames(values: readonly string[]): RequestedTargets {
  const targets: RunnerOs[] = [];
  let all = false;

  for (const value of values) {
    for (const part of value.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      if (trimmed.toLowerCase() === "all") {
        all = true;
        continue;
      }

      const os = parseTargetName(trimmed);
      if (!targets.includes(os)) targets.push(os);
    }
  }

  return { all, targets };
}

export interface ResolvedTarget {
  os: RunnerOs;
  name: string;
  label: string;
  mode: TargetMode;
}

/**
 * Matches requested platforms against what this host can serve.
 *
 * An explicit request for something impossible is an error, not a warning —
 * asking for a Windows runner on a Mac is a mistake worth stopping for.
 */
export function resolveTargets(
  requested: readonly RunnerOs[],
  options: readonly PlatformOption[],
): ResolvedTarget[] {
  const unavailable = requested
    .map((os) => options.find((option) => option.os === os))
    .filter((option): option is PlatformOption => option !== undefined && !option.available);

  if (unavailable.length > 0) {
    const lines = unavailable.map((option) => `       ${option.name}: ${option.detail}`);
    throw new CliError(
      `this machine can't run ${unavailable.length === 1 ? "that runner" : "those runners"}\n${lines.join("\n")}`,
    );
  }

  return requested.flatMap((os) => {
    const option = options.find((candidate) => candidate.os === os);
    if (!option?.mode) return [];
    return [{ os: option.os, name: option.name, label: option.label, mode: option.mode }];
  });
}

/** The platforms `all` resolves to on this host — everything actually servable. */
export function availableTargets(options: readonly PlatformOption[]): RunnerOs[] {
  return options.filter((option) => option.available).map((option) => option.os);
}
