import { CliError } from "./errors.js";
import { execCommand } from "./exec.js";
import { proposeWorkflowFix } from "./fix.js";
import type { WorkflowFixResult } from "./fix.js";
import { GhClient } from "./gh.js";
import { silentLogger } from "./logger.js";
import { assertRepoSlug, emptyOptions } from "./options.js";
import type { RunnerOptions } from "./options.js";
import { reportFix } from "./runner.js";
import type { RunContext } from "./runner.js";

/** Where every release's Docker Compose deployment can be fetched from. */
export const COMPOSE_URL =
  "https://github.com/singerbj/gh-runner/releases/latest/download/docker-compose.yml";

export interface SetupResult {
  repo: string;
  fix: WorkflowFixResult;
}

/**
 * `gh-runner setup`: opens the pull request that lets the repo's GitHub-hosted
 * jobs fall back to a gh-runner, and registers nothing.
 *
 * It's the same rewrite a runner session offers — same worktree, same branch
 * naming, same `runs-on` expression — without having to bring a runner up to
 * get it, so setting up a new project is one command.
 */
export async function ghRunnerSetup(
  partialOptions: Partial<RunnerOptions> = {},
  context: Pick<RunContext, "logger" | "commandRunner" | "gh" | "signal"> = {},
): Promise<SetupResult> {
  const options: RunnerOptions = { ...emptyOptions(), ...partialOptions };
  const logger = context.logger ?? silentLogger;
  const { bold, dim, green } = logger.styles;
  const commandRunner = context.commandRunner ?? execCommand;
  const signal = context.signal;
  const gh = context.gh ?? new GhClient({ runner: commandRunner, ...(signal ? { signal } : {}) });

  await gh.preflight();

  const cwd = options.cwd ?? process.cwd();
  const repoRoot = await gh.repoRoot(cwd);
  if (!repoRoot) {
    throw new CliError("run gh-runner setup inside a checkout of the repo to set up");
  }
  const detected = options.repo ?? (await gh.detectRepo(cwd));
  if (!detected) {
    throw new CliError("couldn't resolve the GitHub repo for this directory");
  }
  const repo = assertRepoSlug(detected);

  // gh-runner won't register on a repo it can't confirm is private, so a
  // fallback there would send jobs to a runner that can never come.
  const visibility = await gh.visibility(repo);
  if (visibility !== "PRIVATE" && visibility !== "INTERNAL" && !options.allowPublic) {
    throw new CliError(
      visibility === "PUBLIC"
        ? `${repo} is PUBLIC, and gh-runner refuses to serve public repos: any fork could\n` +
            `       open a PR and run code on the runner machine. Nothing changed. Pass\n` +
            `       --allow-public only if you fully trust everyone who can open a pull request.`
        : `couldn't confirm whether ${repo} is private, and gh-runner refuses to serve a\n` +
            `       repo it can't confirm is private. Nothing changed. Check \`gh auth status\`\n` +
            `       and that you can see ${repo}, or pass --allow-public.`,
    );
  }

  logger.say(`Setting up ${bold(repo)} to fall back to gh-runner...`);
  const fix = await proposeWorkflowFix({
    repo,
    repoRoot,
    ...(options.fixLabel ? { label: options.fixLabel } : {}),
    jobs: options.fixJobs,
    commandRunner,
    gh,
    logger,
    dryRun: options.dryRun,
    ...(signal ? { signal } : {}),
  });
  reportFix(logger, fix);

  if (fix.status === "opened") {
    logger.raw(
      `\n    Jobs stay on GitHub-hosted runners. Once this is merged, they move to a\n` +
        `    gh-runner only while the repo can't start hosted jobs. To provide one:\n\n` +
        `      ${green("npx @singerbj/gh-runner")}    ${dim("# this machine, while the command runs")}\n` +
        `      ${green(COMPOSE_URL)}\n` +
        `      ${dim("# a Linux runner that stays online, with Docker Compose")}\n`,
    );
  }

  return { repo, fix };
}
