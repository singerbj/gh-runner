import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LABEL } from "./constants.js";
import { downloadCached, extractArchive } from "./download.js";
import { CliError, InterruptedError } from "./errors.js";
import { proposeWorkflowFix } from "./fix.js";
import type { WorkflowFixResult } from "./fix.js";
import { CommandFailedError, execCommand } from "./exec.js";
import type { CommandRunner, SpawnHook } from "./exec.js";
import { GhClient } from "./gh.js";
import { silentLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { emptyOptions } from "./options.js";
import type { RunnerOptions } from "./options.js";
import { declineAll } from "./prompt.js";
import type { Confirm } from "./prompt.js";
import {
  defaultCacheDir,
  detectHostLabel,
  detectPlatform,
  implicitLabels,
  runnerArchive,
  runnerDownloadUrl,
  runnerScript,
} from "./platform.js";
import type { RunnerPlatform } from "./platform.js";
import { inspectWorkflows } from "./workflows.js";
import type { WorkflowReport } from "./workflows.js";

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
  /** How to ask before opening the workflow PR. Defaults to never asking. */
  confirm?: Confirm;
}

export interface RunSummary {
  repo: string;
  runnerName: string;
  /** Custom labels registered, starting with `gh-runner`. */
  labels: string[];
  hostLabel: string;
  runnerVersion: string;
  platform: RunnerPlatform;
  ephemeral: boolean;
  /** Result of the `runs-on` audit, when one ran. */
  workflows: WorkflowReport | undefined;
}

/**
 * Builds the argv for one of the runner's own scripts. Node won't spawn a
 * `.cmd` without a shell, so Windows goes through `cmd.exe` explicitly — argv
 * stays a real array rather than a concatenated command line.
 */
function runnerCommand(
  platform: RunnerPlatform,
  runnerDir: string,
  script: "config" | "run",
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } {
  const path = join(runnerDir, runnerScript(platform, script));
  if (platform.os === "win") {
    return { command: env["COMSPEC"] || "cmd.exe", args: ["/d", "/s", "/c", path, ...args] };
  }
  return { command: path, args: [...args] };
}

/**
 * Registers this machine as a self-hosted runner for `options.repo`, waits for
 * work, then deregisters and removes every trace of itself — including when the
 * caller aborts or the process is interrupted.
 */
export async function ghRunner(
  partialOptions: Partial<RunnerOptions> = {},
  context: RunContext = {},
): Promise<RunSummary> {
  const options: RunnerOptions = { ...emptyOptions(), ...partialOptions };
  const logger = context.logger ?? silentLogger;
  const { bold, dim, green } = logger.styles;
  const commandRunner = context.commandRunner ?? execCommand;
  const env = context.env ?? process.env;
  const signal = context.signal;
  const confirm = context.confirm ?? declineAll;
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
  const hostLabel = await detectHostLabel(commandRunner, context.nodePlatform);
  const labels = [DEFAULT_LABEL, hostLabel, ...options.labels];
  const runnerName = options.name ?? `${hostLabel}-${process.pid}`;
  const allLabels = [...implicitLabels(platform), ...labels];

  // Auditing and fixing workflows both need the checkout, not just the slug.
  const repoRoot = await gh.repoRoot(options.cwd ?? process.cwd());

  let workflows: WorkflowReport | undefined;
  if (!options.skipWorkflowCheck && repoRoot) {
    logger.say("Checking .github/workflows for a matching runs-on...");
    workflows = await inspectWorkflows(repoRoot, allLabels);
    reportWorkflows(logger, workflows);
    throwIfAborted();
  }

  const fixing = await shouldFixWorkflows(options, workflows, confirm);
  if (!fixing && workflowsNeedFix(workflows)) {
    logger.raw(
      `    ${dim(`add runs-on: [self-hosted, ${DEFAULT_LABEL}] to a job, or re-run with --fix-workflows`)}\n`,
    );
  }

  if (fixing) {
    if (!repoRoot) {
      throw new CliError("--fix-workflows needs to run inside the checkout of the target repo");
    }
    const fix = await proposeWorkflowFix({
      repo,
      repoRoot,
      label: DEFAULT_LABEL,
      jobs: options.fixJobs,
      commandRunner,
      gh,
      logger,
      ...(signal ? { signal } : {}),
    });
    reportFix(logger, fix);
    throwIfAborted();
  }

  let runnerVersion = options.runnerVersion;
  if (!runnerVersion) {
    logger.say("Looking up the latest runner release...");
    runnerVersion = await gh.latestRunnerVersion();
  }
  throwIfAborted();

  const cacheDir = options.cacheDir ?? defaultCacheDir(env, context.nodePlatform);
  const archive = runnerArchive(platform, runnerVersion);
  const version = runnerVersion;
  const cached = await downloadCached({
    url: runnerDownloadUrl(platform, version),
    cacheDir,
    fileName: archive,
    ...(signal ? { signal } : {}),
    onDownloadStart: () => {
      logger.say(
        `Downloading runner v${version} (${platform.os}-${platform.arch})... ${dim("cached for next time")}`,
      );
    },
  });
  throwIfAborted();

  const tmpRoot = await mkdtemp(join(env["TMPDIR"] || tmpdir(), "gh-runner-"));
  const runnerDir = join(tmpRoot, "runner");
  let summary: RunSummary | undefined;

  try {
    await mkdir(runnerDir, { recursive: true });
    await extractArchive(commandRunner, cached, runnerDir, {
      ...(signal ? { signal } : {}),
      zip: platform.os === "win",
    });
    throwIfAborted();

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
    const config = runnerCommand(platform, runnerDir, "config", configArgs, env);
    try {
      const result = await commandRunner(config.command, config.args, {
        cwd: runnerDir,
        ...(signal ? { signal } : {}),
      });
      if (result.code !== 0) {
        throw new CommandFailedError(config.command, config.args, result);
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
      workflows,
    };

    logger.raw(
      [
        "",
        `  ${green("Runner is live.")}  Target it with:`,
        "",
        `      ${bold(`runs-on: [self-hosted, ${DEFAULT_LABEL}]`)}`,
        "",
        `  Repo:   ${repo}`,
        `  Labels: ${allLabels.join(", ")}`,
        `  Mode:   ${
          options.keep ? "staying online until you Ctrl+C" : "ephemeral — exits after one job"
        }`,
        "",
        `  ${dim("Ctrl+C to stop and deregister.")}`,
        "",
        "",
      ].join("\n"),
    );

    // No abort signal here: Ctrl+C reaches the runner through the terminal's
    // foreground process group, and it shuts itself down cleanly.
    const run = runnerCommand(platform, runnerDir, "run", [], env);
    await commandRunner(run.command, run.args, {
      cwd: runnerDir,
      inherit: true,
      ...(context.onRunnerSpawn ? { onSpawn: context.onRunnerSpawn } : {}),
    });
  } finally {
    await deregister(cleanupGh, commandRunner, repo, runnerDir, logger, platform, env);
    await rm(tmpRoot, { recursive: true, force: true });
  }

  if (!summary) {
    throw new CliError("runner exited before it finished registering");
  }
  return summary;
}

/**
 * Only worth interrupting someone over when nothing at all would pick this
 * runner up — if some job already targets it, the setup is working.
 */
export function workflowsNeedFix(report: WorkflowReport | undefined): boolean {
  return Boolean(report?.scanned && report.matches.length === 0 && report.hosted.length > 0);
}

async function shouldFixWorkflows(
  options: RunnerOptions,
  report: WorkflowReport | undefined,
  confirm: Confirm,
): Promise<boolean> {
  if (options.fixWorkflows === "never") return false;
  if (options.fixWorkflows === "always") return true;
  if (!workflowsNeedFix(report)) return false;

  const count = report?.hosted.length ?? 0;
  return confirm(
    `Update ${count} job${count === 1 ? "" : "s"} to runs-on: [self-hosted, ${DEFAULT_LABEL}] and open a pull request?`,
    false,
  );
}

function reportWorkflows(logger: Logger, report: WorkflowReport): void {
  const { dim, green, bold } = logger.styles;
  const line = (text: string) => logger.raw(`    ${text}\n`);

  if (!report.scanned) {
    line(dim("no .github/workflows directory — nothing to check"));
    return;
  }

  for (const target of report.matches) {
    line(`${green("✓")} ${target.file} ${dim("→")} ${bold(target.job)} will run here`);
  }

  for (const { target, missing } of report.missing) {
    line(
      `${dim("!")} ${target.file}:${target.line} ${dim("→")} ${bold(target.job)} wants ` +
        `${missing.join(", ")}, which this runner won't have`,
    );
    line(`  ${dim(`register it too with: --labels ${missing.join(",")}`)}`);
  }

  if (report.unknown.length > 0) {
    const count = report.unknown.length;
    line(
      dim(
        `${count} job${count === 1 ? " uses" : "s use"} an expression for runs-on — can't tell statically`,
      ),
    );
  }

  if (report.matches.length === 0) {
    const hosted = report.hosted.length;
    line(
      `${dim("!")} no job targets this runner` +
        (hosted > 0 ? `; ${hosted} target${hosted === 1 ? "s" : ""} GitHub-hosted runners` : ""),
    );
  }
}

function reportFix(logger: Logger, fix: WorkflowFixResult): void {
  const { dim, green, bold } = logger.styles;
  const line = (text: string) => logger.raw(`    ${text}\n`);

  switch (fix.status) {
    case "no-changes":
      line(dim("nothing to change in the workflows on the default branch"));
      return;
    case "branch-exists":
      line(
        `${dim("!")} ${fix.branch} already exists on the remote` +
          (fix.url ? ` ${dim("→")} ${fix.url}` : ""),
      );
      return;
    case "dry-run":
      line(dim(`would change ${fix.files.join(", ")} on ${fix.branch}`));
      return;
    case "opened":
      for (const { file, job } of fix.jobs) {
        line(`${green("✓")} ${file} ${dim("→")} ${bold(job)} now targets this runner`);
      }
      line(`${green("Pull request opened:")} ${fix.url ?? `branch ${fix.branch}`}`);
      return;
  }
}

async function deregister(
  gh: GhClient,
  commandRunner: CommandRunner,
  repo: string,
  runnerDir: string,
  logger: Logger,
  platform: RunnerPlatform,
  env: NodeJS.ProcessEnv,
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

  const remove = runnerCommand(platform, runnerDir, "config", ["remove", "--token", token], env);
  try {
    await commandRunner(remove.command, remove.args, { cwd: runnerDir });
  } catch {
    // Best effort: an ephemeral runner is removed server-side after its job
    // anyway, and we are on the way out.
  }
}
