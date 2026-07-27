import { CliError } from "./errors.js";
import { execCapture, execSucceeds } from "./exec.js";
import type { CommandRunner, ExecOptions, SpawnHook } from "./exec.js";
import type { RunnerArch } from "./platform.js";

/**
 * GitHub's own runner image. It ships the runner already installed, so the
 * container path skips the download-and-extract dance entirely.
 */
export const DEFAULT_IMAGE = "ghcr.io/actions/actions-runner:latest";

export interface DockerRunOptions {
  repo: string;
  image: string;
  /** e.g. `linux/amd64`, to run under emulation on Apple silicon. */
  dockerPlatform: string | undefined;
  containerName: string;
  runnerName: string;
  labels: readonly string[];
  ephemeral: boolean;
  registrationToken: string;
}

/** Maps a `--platform` value onto the arch GitHub will label the runner with. */
export function archForDockerPlatform(
  platform: string | undefined,
  hostArch: RunnerArch,
): RunnerArch {
  if (!platform) return hostArch;
  if (platform.endsWith("/amd64") || platform.endsWith("/x86_64")) return "x64";
  if (platform.endsWith("/arm64") || platform.endsWith("/aarch64")) return "arm64";
  throw new CliError(`unsupported --docker-platform: ${platform} (linux/amd64 or linux/arm64)`);
}

export async function assertDockerAvailable(
  runner: CommandRunner,
  options: ExecOptions = {},
): Promise<void> {
  const present = await execSucceeds(runner, "docker", ["--version"], options);
  if (!present) {
    throw new CliError(
      "--docker needs the Docker CLI — install Docker Desktop or the engine from https://docs.docker.com/get-docker/",
    );
  }

  const running = await execSucceeds(
    runner,
    "docker",
    ["info", "--format", "{{.ServerVersion}}"],
    options,
  );
  if (!running) {
    throw new CliError("the Docker daemon isn't reachable — start Docker and try again");
  }
}

/**
 * The script the container runs. Every value the API handed us arrives through
 * the environment and is referenced by name, so nothing untrusted is ever
 * spliced into a shell command.
 */
export function containerScript(ephemeral: boolean): string {
  const config = [
    "./config.sh",
    "--unattended",
    "--replace",
    '--url "$GHR_URL"',
    '--token "$GHR_TOKEN"',
    '--name "$GHR_NAME"',
    '--labels "$GHR_LABELS"',
    "--work _work",
    ...(ephemeral ? ["--ephemeral"] : []),
  ].join(" ");
  return `set -e; ${config}; ./run.sh`;
}

export function dockerRunArgs(options: DockerRunOptions): string[] {
  const args = ["run", "--rm", "--name", options.containerName];

  if (options.dockerPlatform) {
    args.push("--platform", options.dockerPlatform);
  }

  args.push(
    "-e",
    `GHR_URL=https://github.com/${options.repo}`,
    "-e",
    `GHR_TOKEN=${options.registrationToken}`,
    "-e",
    `GHR_NAME=${options.runnerName}`,
    "-e",
    `GHR_LABELS=${options.labels.join(",")}`,
    // Custom images sometimes run as root, which the runner refuses by default.
    "-e",
    "RUNNER_ALLOW_RUNASROOT=1",
    // Deterministic regardless of the image's own entrypoint.
    "--entrypoint",
    "bash",
    options.image,
    "-c",
    containerScript(options.ephemeral),
  );

  return args;
}

/** Runs the containerised runner in the foreground, streaming its output. */
export async function runInDocker(
  runner: CommandRunner,
  options: DockerRunOptions,
  onSpawn?: SpawnHook,
  prefix?: string,
): Promise<number> {
  const result = await runner("docker", dockerRunArgs(options), {
    ...(prefix ? { prefix } : { inherit: true }),
    ...(onSpawn ? { onSpawn } : {}),
  });
  return result.code;
}

/** Best-effort container teardown; `--rm` usually got there first. */
export async function removeContainer(runner: CommandRunner, name: string): Promise<void> {
  try {
    await execCapture(runner, "docker", ["rm", "--force", name]);
  } catch {
    // Already gone, which is the normal case.
  }
}
