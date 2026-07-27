import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadCached, extractTarball } from "./download.js";
import { CliError, InterruptedError } from "./errors.js";
import { CommandFailedError, execCommand } from "./exec.js";
import type { CommandRunner, SpawnHook } from "./exec.js";
import { GhClient } from "./gh.js";
import { silentLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { emptyOptions } from "./options.js";
import type { RunnerOptions } from "./options.js";
import {
  defaultCacheDir,
  detectHostLabel,
  detectPlatform,
  runnerDownloadUrl,
  runnerTarball,
} from "./platform.js";
import type { RunnerPlatform } from "./platform.js";

export interface RunContext {
  logger?: Logger;
  commandRunner?: CommandRunner;
  gh?: GhClient;
  /** Aborting this asks the runner to shut down and deregister. */
  signal?: AbortSignal;
  platform?: RunnerPlatform;
  /** Node platform id, used for host-label detection. */
  nodePlatform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Receives the spawned `run.sh` child so callers can forward signals. */
  onRunnerSpawn?: SpawnHook;
}

export interface RunSummary {
  repo: string;
  runnerName: string;
  labels: string[];
  hostLabel: string;
  runnerVersion: string;
  platform: RunnerPlatform;
  ephemeral: boolean;
}

/**
 * Registers this machine as a self-hosted runner for `options.repo`, waits for
 * work, then deregisters and removes every trace of itself — including when the
 * caller aborts or the process is interrupted.
 */
export async function ghRunnerHere(
  partialOptions: Partial<RunnerOptions> = {},
  context: RunContext = {},
): Promise<RunSummary> {
  const options: RunnerOptions = { ...emptyOptions(), ...partialOptions };
  const logger = context.logger ?? silentLogger;
  const { bold, dim, green } = logger.styles;
  const commandRunner = context.commandRunner ?? execCommand;
  const env = context.env ?? process.env;
  const signal = context.signal;
  const gh = context.gh ?? new GhClient({ runner: commandRunner, ...(signal ? { signal } : {}) });
  // Cleanup must survive the abort that triggered it, so it gets its own client.
  const cleanupGh = new GhClient({ runner: commandRunner });

  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new InterruptedError();
    }
  };

  await gh.preflight();
  throwIfAborted();

  const repo = options.repo ?? (await gh.detectRepo(options.cwd ?? process.cwd()));
  if (!repo) {
    throw new CliError("couldn't resolve the GitHub repo for this directory");
  }

  // Registering on a public repo lets any fork PR execute arbitrary code here.
  const visibility = await gh.visibility(repo);
  if (visibility === "PUBLIC" && !options.allowPublic) {
    throw new CliError(
      `${repo} is PUBLIC. Any fork could open a PR and run arbitrary code on this\n` +
        `       machine. Refusing. Pass --allow-public only if you fully trust every\n` +
        `       contributor who can open a pull request.`,
    );
  }
  throwIfAborted();

  const platform = context.platform ?? detectPlatform();

  let runnerVersion = options.runnerVersion;
  if (!runnerVersion) {
    logger.say("Looking up the latest runner release...");
    runnerVersion = await gh.latestRunnerVersion();
  }
  throwIfAborted();

  const cacheDir = options.cacheDir ?? defaultCacheDir(env);
  const tarball = runnerTarball(platform, runnerVersion);
  const version = runnerVersion;
  const cached = await downloadCached({
    url: runnerDownloadUrl(platform, version),
    cacheDir,
    fileName: tarball,
    ...(signal ? { signal } : {}),
    onDownloadStart: () => {
      logger.say(
        `Downloading runner v${version} (${platform.os}-${platform.arch})... ${dim("cached for next time")}`,
      );
    },
  });
  throwIfAborted();

  const tmpRoot = await mkdtemp(join(env["TMPDIR"] || tmpdir(), "gh-runner-here-"));
  const runnerDir = join(tmpRoot, "runner");
  let summary: RunSummary | undefined;

  try {
    await mkdir(runnerDir, { recursive: true });
    await extractTarball(commandRunner, cached, runnerDir, signal);
    throwIfAborted();

    const hostLabel = await detectHostLabel(commandRunner, context.nodePlatform);
    const labels = [hostLabel, ...options.labels];
    const runnerName = options.name ?? `${hostLabel}-${process.pid}`;

    logger.say(`Requesting a registration token for ${bold(repo)}...`);
    const registrationToken = await gh.registrationToken(repo);
    throwIfAborted();

    const configArgs = [
      "--unattended",
      "--replace",
      "--url",
      `https://github.com/${repo}`,
      "--token",
      registrationToken,
      "--name",
      runnerName,
      "--labels",
      labels.join(","),
      "--work",
      "_work",
    ];
    if (!options.keep) {
      configArgs.push("--ephemeral");
    }

    logger.say("Registering...");
    try {
      const result = await commandRunner(join(runnerDir, "config.sh"), configArgs, {
        cwd: runnerDir,
        ...(signal ? { signal } : {}),
      });
      if (result.code !== 0) {
        throw new CommandFailedError("config.sh", configArgs, result);
      }
    } catch (error) {
      if (error instanceof InterruptedError) throw error;
      const detail = error instanceof CommandFailedError ? error.result.stderr.trim() : "";
      throw new CliError(`runner registration failed${detail ? `\n       ${detail}` : ""}`);
    }

    summary = {
      repo,
      runnerName,
      labels,
      hostLabel,
      runnerVersion: version,
      platform,
      ephemeral: !options.keep,
    };

    logger.raw(
      [
        "",
        `  ${green("Runner is live.")}  Target it with:`,
        "",
        `      ${bold(`runs-on: [self-hosted, ${hostLabel}]`)}`,
        "",
        `  Repo:   ${repo}`,
        `  Labels: self-hosted, ${platform.os}, ${platform.arch}, ${labels.join(", ")}`,
        `  Mode:   ${
          options.keep ? "staying online until you Ctrl+C" : "ephemeral — exits after one job"
        }`,
        "",
        `  ${dim("Ctrl+C to stop and deregister.")}`,
        "",
        "",
      ].join("\n"),
    );

    // No abort signal here: Ctrl+C reaches run.sh through the terminal's
    // foreground process group, and the runner shuts itself down cleanly.
    await commandRunner(join(runnerDir, "run.sh"), [], {
      cwd: runnerDir,
      inherit: true,
      ...(context.onRunnerSpawn ? { onSpawn: context.onRunnerSpawn } : {}),
    });
  } finally {
    await deregister(cleanupGh, commandRunner, repo, runnerDir, logger);
    await rm(tmpRoot, { recursive: true, force: true });
  }

  if (!summary) {
    throw new CliError("runner exited before it finished registering");
  }
  return summary;
}

async function deregister(
  gh: GhClient,
  commandRunner: CommandRunner,
  repo: string,
  runnerDir: string,
  logger: Logger,
): Promise<void> {
  // `.runner` only exists once config.sh has actually registered us.
  if (!existsSync(join(runnerDir, ".runner"))) {
    return;
  }

  logger.say("Deregistering runner...");
  const token = await gh.removeToken(repo);
  if (!token) {
    logger.error(
      `couldn't mint a removal token — the runner may still be listed at\n` +
        `       https://github.com/${repo}/settings/actions/runners`,
    );
    return;
  }

  try {
    await commandRunner(join(runnerDir, "config.sh"), ["remove", "--token", token], {
      cwd: runnerDir,
    });
  } catch {
    // Best effort: an ephemeral runner is removed server-side after its job
    // anyway, and we are on the way out.
  }
}
