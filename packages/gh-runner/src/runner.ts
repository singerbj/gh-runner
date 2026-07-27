import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LABEL, OS_NAMES, osForLabel, osLabel } from "./constants.js";
import {
  DEFAULT_IMAGE,
  archForDockerPlatform,
  assertDockerAvailable,
  removeContainer,
  runInDocker,
} from "./docker.js";
import { downloadCached, extractArchive } from "./download.js";
import { CliError, InterruptedError } from "./errors.js";
import { CommandFailedError, execCommand } from "./exec.js";
import type { CommandRunner, ExecOptions, SpawnHook } from "./exec.js";
import { proposeWorkflowFix } from "./fix.js";
import type { WorkflowFixResult } from "./fix.js";
import { GhClient } from "./gh.js";
import { silentLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { promptMultiSelect } from "./menu.js";
import type { MenuChoice } from "./menu.js";
import { emptyOptions } from "./options.js";
import type { RunnerOptions } from "./options.js";
import {
  defaultCacheDir,
  detectHostLabel,
  detectPlatform,
  implicitLabels,
  runnerArchive,
  runnerDownloadUrl,
  runnerScript,
} from "./platform.js";
import type { RunnerOs, RunnerPlatform } from "./platform.js";
import { declineAll } from "./prompt.js";
import type { Confirm } from "./prompt.js";
import { availableTargets, parseTargetNames, planOptions, resolveTargets } from "./targets.js";
import type { PlatformOption, ResolvedTarget } from "./targets.js";
import { inspectWorkflows } from "./workflows.js";
import type { WorkflowReport } from "./workflows.js";

export interface RunContext {
  logger?: Logger;
  commandRunner?: CommandRunner;
  gh?: GhClient;
  /** Aborting this asks every runner to shut down and deregister. */
  signal?: AbortSignal;
  platform?: RunnerPlatform;
  /** Node platform id, used for host-label detection. */
  nodePlatform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Receives each spawned runner child so callers can forward signals. */
  onRunnerSpawn?: SpawnHook;
  /** How to ask before opening the workflow PR. Defaults to never asking. */
  confirm?: Confirm;
  /**
   * How to ask which platforms to serve. Defaults to the terminal menu; a
   * library caller that passes nothing simply gets the host platform.
   */
  selectPlatforms?: (choices: ReadonlyArray<MenuChoice<RunnerOs>>) => Promise<RunnerOs[] | null>;
}

export interface RunSummary {
  repo: string;
  runnerName: string;
  /** Custom labels registered, starting with `gh-runner`. */
  labels: string[];
  hostLabel: string;
  runnerVersion: string;
  platform: RunnerPlatform;
  /** How this runner was hosted. */
  mode: "native" | "docker";
  ephemeral: boolean;
}

export interface RunResult {
  /** One entry per platform served. */
  runners: RunSummary[];
  /** Result of the `runs-on` audit, when one ran. */
  workflows: WorkflowReport | undefined;
}

const SHORT_NAME: Readonly<Record<RunnerOs, string>> = {
  osx: "mac",
  linux: "linux",
  win: "windows",
};

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

/** Everything one platform's runner needs, resolved and ready to go. */
interface TargetPlan {
  target: ResolvedTarget;
  platform: RunnerPlatform;
  runnerName: string;
  /** Custom labels, `gh-runner` first. */
  labels: string[];
  /** Custom labels plus the ones GitHub adds for free. */
  allLabels: string[];
  /** `[macOS] ` when several runners share the terminal, otherwise undefined. */
  prefix: string | undefined;
}

/**
 * Registers this machine as a self-hosted runner for one or more platforms,
 * waits for work, then deregisters and removes every trace of itself —
 * including when the caller aborts or the process is interrupted.
 */
export async function ghRunner(
  partialOptions: Partial<RunnerOptions> = {},
  context: RunContext = {},
): Promise<RunResult> {
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

  const hostPlatform = context.platform ?? detectPlatform();
  const hostLabel = await detectHostLabel(commandRunner, context.nodePlatform);

  const requested = parseTargetNames(options.platforms);
  const wantsAll = options.all || requested.all;
  const preferDocker = Boolean(options.dockerImage || options.dockerPlatform);
  // Probing Docker is only worth it when something other than this machine's
  // own OS might be on the table.
  const mayNeedDocker =
    wantsAll ||
    preferDocker ||
    requested.targets.some((os) => os !== hostPlatform.os) ||
    (requested.targets.length === 0 && Boolean(context.selectPlatforms));

  let dockerReady = false;
  let dockerReason: string | undefined;
  if (mayNeedDocker) {
    try {
      await assertDockerAvailable(commandRunner, signal ? { signal } : {});
      dockerReady = true;
    } catch (error) {
      dockerReason = error instanceof Error ? error.message : String(error);
    }
  } else {
    dockerReason = "not checked";
  }

  const platformOptions = planOptions({
    hostOs: hostPlatform.os,
    dockerReady,
    dockerReason,
    preferDocker,
  });

  const chosen = await choosePlatforms({
    options,
    requested,
    wantsAll,
    platformOptions,
    hostOs: hostPlatform.os,
    logger,
    ...(context.selectPlatforms ? { selectPlatforms: context.selectPlatforms } : {}),
  });
  throwIfAborted();

  const targets = resolveTargets(chosen, platformOptions);
  if (targets.length === 0) {
    throw new CliError("no platforms selected — nothing to do");
  }

  const plans: TargetPlan[] = targets.map((target) => {
    const platform: RunnerPlatform =
      target.mode === "docker"
        ? { os: "linux", arch: archForDockerPlatform(options.dockerPlatform, hostPlatform.arch) }
        : { os: target.os, arch: hostPlatform.arch };

    const labels = [DEFAULT_LABEL, osLabel(target.os), hostLabel, ...options.labels];
    const short = SHORT_NAME[target.os];
    const base = options.name ?? `${hostLabel}-${short}`;
    const runnerName =
      options.name && targets.length === 1 ? options.name : `${base}-${process.pid}`;

    return {
      target,
      platform,
      runnerName,
      labels,
      allLabels: [...implicitLabels(platform), ...labels],
      prefix: targets.length > 1 ? `[${target.name}] ` : undefined,
    };
  });

  // Auditing and fixing workflows both need the checkout, not just the slug.
  const repoRoot = await gh.repoRoot(options.cwd ?? process.cwd());

  let workflows: WorkflowReport | undefined;
  if (!options.skipWorkflowCheck && repoRoot) {
    logger.say("Checking .github/workflows for a matching runs-on...");
    workflows = await inspectWorkflows(
      repoRoot,
      plans.map((plan) => plan.allLabels),
    );
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
      label: options.fixLabel ?? DEFAULT_LABEL,
      jobs: options.fixJobs,
      commandRunner,
      gh,
      logger,
      ...(signal ? { signal } : {}),
    });
    reportFix(logger, fix);
    throwIfAborted();
  }

  // One version lookup covers every native runner; containers bring their own.
  let runnerVersion = options.runnerVersion;
  if (!runnerVersion && plans.some((plan) => plan.target.mode === "native")) {
    logger.say("Looking up the latest runner release...");
    runnerVersion = await gh.latestRunnerVersion();
  }
  throwIfAborted();

  logger.raw(
    [
      "",
      `  ${green(`Bringing up ${plans.length} runner${plans.length === 1 ? "" : "s"}.`)}  Target ${plans.length === 1 ? "it" : "them"} with:`,
      "",
      ...bannerTargets(plans, bold, dim),
      "",
      `  Repo:   ${repo}`,
      `  Mode:   ${
        options.keep ? "staying online until you Ctrl+C" : `ephemeral — each exits after one job`
      }`,
      "",
      `  ${dim("Ctrl+C to stop and deregister.")}`,
      "",
      "",
    ].join("\n"),
  );

  const shared = {
    repo,
    options,
    hostLabel,
    logger,
    commandRunner,
    gh,
    cleanupGh,
    env,
    ...(signal ? { signal } : {}),
    ...(context.onRunnerSpawn ? { onRunnerSpawn: context.onRunnerSpawn } : {}),
  };

  // Every runner gets to finish and clean up even if a sibling blows up.
  const settled = await Promise.allSettled(
    plans.map((plan) =>
      plan.target.mode === "docker"
        ? runDockerTarget({ ...shared, plan })
        : runNativeTarget({ ...shared, plan, runnerVersion: runnerVersion as string }),
    ),
  );

  const runners: RunSummary[] = [];
  let failure: unknown;
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") runners.push(outcome.value);
    else failure ??= outcome.reason;
  }

  if (failure && runners.length === 0) throw failure;
  if (failure) {
    logger.error(failure instanceof Error ? failure.message : String(failure));
  }

  return { runners, workflows };
}

interface ChooseInput {
  options: RunnerOptions;
  requested: { all: boolean; targets: RunnerOs[] };
  wantsAll: boolean;
  platformOptions: PlatformOption[];
  hostOs: RunnerOs;
  logger: Logger;
  selectPlatforms?: (choices: ReadonlyArray<MenuChoice<RunnerOs>>) => Promise<RunnerOs[] | null>;
}

/** `--all` beats a menu, an explicit list beats both, and a menu beats a guess. */
async function choosePlatforms(input: ChooseInput): Promise<RunnerOs[]> {
  const { requested, wantsAll, platformOptions, hostOs } = input;

  if (requested.targets.length > 0) {
    // `all` alongside explicit names means "these, plus whatever else works".
    const extra = wantsAll ? availableTargets(platformOptions) : [];
    return [...new Set([...requested.targets, ...extra])];
  }

  if (wantsAll) {
    return availableTargets(platformOptions);
  }

  if (input.selectPlatforms) {
    const available = platformOptions.filter((option) => option.available);

    // A menu with one answer is a keypress that teaches nothing. Say what this
    // machine can serve, and why the rest are out, then get on with it.
    if (available.length === 1 && available[0]) {
      const only = available[0];
      const { dim } = input.logger.styles;
      const width = Math.max(...platformOptions.map((option) => option.name.length));

      input.logger.say(`${only.name} is the only platform this machine can serve.`);
      for (const option of platformOptions) {
        if (option.available) continue;
        input.logger.raw(`    ${dim(`✗ ${option.name.padEnd(width)}  ${option.detail}`)}\n`);
      }
      return [only.os];
    }

    const choices: Array<MenuChoice<RunnerOs>> = platformOptions.map((option) => ({
      value: option.os,
      label: option.name,
      detail: option.detail,
      disabled: !option.available,
      // Pre-tick this machine's own OS: the common case is one keypress.
      selected: option.available && option.os === hostOs,
    }));

    const picked = await input.selectPlatforms(choices);
    if (picked === null) {
      throw new InterruptedError();
    }
    if (picked.length > 0) {
      return picked;
    }
  }

  return [hostOs];
}

function bannerTargets(
  plans: readonly TargetPlan[],
  bold: (s: string) => string,
  dim: (s: string) => string,
): string[] {
  const rows: Array<[string, string]> = [
    [`runs-on: [self-hosted, ${DEFAULT_LABEL}]`, "any registered machine"],
    ...plans.map((plan): [string, string] => [
      `runs-on: [self-hosted, ${plan.target.label}]`,
      `${plan.target.name} only ${plan.target.mode === "docker" ? "(container)" : "(native)"}`,
    ]),
  ];
  const width = Math.max(...rows.map(([snippet]) => snippet.length));

  return rows.map(
    ([snippet, note]) =>
      `      ${bold(snippet)}${" ".repeat(width - snippet.length)}  ${dim(note)}`,
  );
}

interface TargetRun {
  plan: TargetPlan;
  repo: string;
  options: RunnerOptions;
  hostLabel: string;
  logger: Logger;
  commandRunner: CommandRunner;
  gh: GhClient;
  cleanupGh: GhClient;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onRunnerSpawn?: SpawnHook;
}

/** Downloads, registers, and runs a runner directly on this machine. */
async function runNativeTarget(run: TargetRun & { runnerVersion: string }): Promise<RunSummary> {
  const { plan, repo, options, logger, commandRunner, gh, cleanupGh, env, signal } = run;
  const { platform } = plan;
  const say = (message: string) => logger.say(`${plan.prefix ?? ""}${message}`);

  const cacheDir = options.cacheDir ?? defaultCacheDir(env);
  const archive = runnerArchive(platform, run.runnerVersion);
  const cached = await downloadCached({
    url: runnerDownloadUrl(platform, run.runnerVersion),
    cacheDir,
    fileName: archive,
    ...(signal ? { signal } : {}),
    onDownloadStart: () => {
      say(
        `Downloading runner v${run.runnerVersion} (${platform.os}-${platform.arch})... ${logger.styles.dim("cached for next time")}`,
      );
    },
  });

  const tmpRoot = await mkdtemp(join(env["TMPDIR"] || tmpdir(), "gh-runner-"));
  const runnerDir = join(tmpRoot, "runner");

  try {
    await mkdir(runnerDir, { recursive: true });
    await extractArchive(commandRunner, cached, runnerDir, {
      ...(signal ? { signal } : {}),
      zip: platform.os === "win",
    });

    say(`Requesting a registration token for ${logger.styles.bold(repo)}...`);
    const registrationToken = await gh.registrationToken(repo);

    const configArgs = [
      "--unattended",
      "--replace",
      "--url",
      `https://github.com/${repo}`,
      "--token",
      registrationToken,
      "--name",
      plan.runnerName,
      "--labels",
      plan.labels.join(","),
      "--work",
      "_work",
    ];
    if (!options.keep) configArgs.push("--ephemeral");

    say("Registering...");
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
      throw new CliError(
        `${plan.prefix ?? ""}runner registration failed${detail ? `\n       ${detail}` : ""}`,
      );
    }
    say(`${logger.styles.green("Runner is live.")} Waiting for a job...`);

    // No abort signal here: Ctrl+C reaches the runner through the terminal's
    // foreground process group, and it shuts itself down cleanly.
    const runScript = runnerCommand(platform, runnerDir, "run", [], env);
    const stdio: ExecOptions = plan.prefix ? { prefix: plan.prefix } : { inherit: true };
    await commandRunner(runScript.command, runScript.args, {
      cwd: runnerDir,
      ...stdio,
      ...(run.onRunnerSpawn ? { onSpawn: run.onRunnerSpawn } : {}),
    });
  } finally {
    await deregisterNative(cleanupGh, commandRunner, repo, runnerDir, logger, platform, env, plan);
    await rm(tmpRoot, { recursive: true, force: true });
  }

  return {
    repo,
    runnerName: plan.runnerName,
    labels: plan.labels,
    hostLabel: run.hostLabel,
    runnerVersion: run.runnerVersion,
    platform,
    mode: "native",
    ephemeral: !options.keep,
  };
}

/**
 * Runs a Linux runner inside a container.
 *
 * Nothing is downloaded or extracted — GitHub's runner image already has it —
 * and nothing is written to the host at all. Deregistration goes through the
 * API rather than `config.sh remove`, because by then the container is gone.
 */
async function runDockerTarget(run: TargetRun): Promise<RunSummary> {
  const { plan, repo, options, logger, commandRunner, gh, cleanupGh } = run;
  const say = (message: string) => logger.say(`${plan.prefix ?? ""}${message}`);
  const image = options.dockerImage ?? DEFAULT_IMAGE;
  const containerName = `${plan.runnerName}`;

  say(`Requesting a registration token for ${logger.styles.bold(repo)}...`);
  const registrationToken = await gh.registrationToken(repo);

  say(
    `Starting ${image}... ${logger.styles.dim("the first run pulls the image, which takes a while")}`,
  );

  try {
    await runInDocker(
      commandRunner,
      {
        repo,
        image,
        dockerPlatform: options.dockerPlatform,
        containerName,
        runnerName: plan.runnerName,
        labels: plan.labels,
        ephemeral: !options.keep,
        registrationToken,
      },
      run.onRunnerSpawn,
      plan.prefix,
    );
  } finally {
    await removeContainer(commandRunner, containerName);
    // An ephemeral runner that took a job is already retired; this catches the
    // one that never did.
    if (await cleanupGh.deleteRunnerByName(repo, plan.runnerName)) {
      say("Deregistered runner.");
    }
  }

  return {
    repo,
    runnerName: plan.runnerName,
    labels: plan.labels,
    hostLabel: run.hostLabel,
    runnerVersion: "container",
    platform: plan.platform,
    mode: "docker",
    ephemeral: !options.keep,
  };
}

/**
 * Only worth interrupting someone over when nothing at all would pick these
 * runners up — if some job already targets them, the setup is working.
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
        `${missing.join(", ")}, which no runner here will have`,
    );

    // A label pinned to another OS isn't something --labels can fix.
    const otherOs = missing.map(osForLabel).find((os) => os !== null);
    if (otherOs) {
      line(
        `  ${dim(`that job wants ${OS_NAMES[otherOs]} — add it with: gh-runner ${SHORT_NAME[otherOs]}`)}`,
      );
    } else {
      line(`  ${dim(`register it too with: --labels ${missing.join(",")}`)}`);
    }
  }

  for (const { file, message } of report.unparsed) {
    line(`${dim("!")} ${file} isn't valid YAML — skipped ${dim(`(${message.split("\n")[0]})`)}`);
  }

  if (report.unknown.length > 0) {
    const count = report.unknown.length;
    line(
      dim(
        `${count} job${count === 1 ? " has a runs-on" : "s have a runs-on"} we can't resolve statically`,
      ),
    );
  }

  if (report.matches.length === 0) {
    const hosted = report.hosted.length;
    line(
      `${dim("!")} no job targets these runners` +
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
        line(`${green("✓")} ${file} ${dim("→")} ${bold(job)} now targets these runners`);
      }
      line(`${green("Pull request opened:")} ${fix.url ?? `branch ${fix.branch}`}`);
      return;
  }
}

async function deregisterNative(
  gh: GhClient,
  commandRunner: CommandRunner,
  repo: string,
  runnerDir: string,
  logger: Logger,
  platform: RunnerPlatform,
  env: NodeJS.ProcessEnv,
  plan: TargetPlan,
): Promise<void> {
  // `.runner` only exists once config.sh has actually registered us.
  if (!existsSync(join(runnerDir, ".runner"))) {
    return;
  }

  logger.say(`${plan.prefix ?? ""}Deregistering runner...`);
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

/** The default platform picker: the terminal menu. */
export function terminalPlatformPicker(
  choices: ReadonlyArray<MenuChoice<RunnerOs>>,
): Promise<RunnerOs[] | null> {
  return promptMultiSelect({
    title: "Which platforms should this machine serve?",
    choices,
  });
}
