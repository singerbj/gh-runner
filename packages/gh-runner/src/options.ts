import { DEFAULT_LABEL, OS_LABELS } from "./constants.js";
import { DEFAULT_IMAGE } from "./docker.js";
import { CliError } from "./errors.js";
import { parseTargetNames } from "./targets.js";

export interface RunnerOptions {
  /** Stay online for many jobs instead of exiting after one. */
  keep: boolean;
  /** Register on a public repo, where any fork PR could run code here. */
  allowPublic: boolean;
  /** OWNER/NAME. When omitted, detected from `cwd`. */
  repo: string | undefined;
  /** Extra labels on top of `gh-runner` and the host label. */
  labels: string[];
  /** Skip the `runs-on` audit of the repo's workflows. */
  skipWorkflowCheck: boolean;
  /**
   * Whether to open a PR repointing GitHub-hosted jobs at this runner.
   * `ask` prompts when no job would match and there's a terminal to ask on.
   */
  fixWorkflows: "ask" | "always" | "never";
  /** Limit the fix to these job ids. Empty means every hosted job. */
  fixJobs: string[];
  /** Label the fix PR writes into `runs-on`. Defaults to `gh-runner`. */
  fixLabel: string | undefined;
  /**
   * Platforms to serve, as given on the command line. Empty means "ask", or
   * "just this machine" when there's no terminal to ask on.
   */
  platforms: string[];
  /** Serve every platform this host can — no menu, no error for the rest. */
  all: boolean;
  /** Image for containerised runners. Defaults to GitHub's runner image. */
  dockerImage: string | undefined;
  /** `--platform` for containerised runners, e.g. `linux/amd64`. */
  dockerPlatform: string | undefined;
  /** Pin the actions/runner version. When omitted, the latest release is used. */
  runnerVersion: string | undefined;
  /** Explicit runner name. Defaults to `<host-label>-<pid>`. */
  name: string | undefined;
  /** Where downloaded runner tarballs are kept between runs. */
  cacheDir: string | undefined;
  /** Directory used to detect the repo. Defaults to `process.cwd()`. */
  cwd: string | undefined;
}

export interface ParsedArgs {
  kind: "run" | "help" | "version";
  options: RunnerOptions;
}

export const USAGE = `gh-runner — temporarily register this machine as a GitHub Actions runner

USAGE
  gh-runner [platforms...] [options]     # run from inside a git repo
  npx gh-runner [platforms...] [options]

PLATFORMS
  gh-runner                Pick from a menu (or just this machine, with no terminal)
  gh-runner mac            One platform
  gh-runner mac linux      Several — one runner each, in parallel
  gh-runner --all          Every platform this machine can serve
  gh-runner --os mac,linux Same as the positional form

  Names: mac | macos | darwin, linux, windows | win, all
  Linux can come from a container, so any machine can serve it. macOS and
  Windows have to be native, so asking for one this machine isn't errors.

OPTIONS
  --all                  Serve every platform this machine can
  --os a,b               Platforms to serve (same as positional arguments)
  --keep                 Stay online for multiple jobs (default: exit after one)
  --labels a,b,c         Extra labels in addition to gh-runner and the host label
  --repo OWNER/NAME      Target a specific repo instead of detecting from cwd
  --name NAME            Runner name to register (default: <host>-<pid>)
  --allow-public         Permit registration on a public repo (dangerous)
  --docker-image IMAGE   Image for containerised runners (default: ${DEFAULT_IMAGE})
  --docker-platform P    Container platform, e.g. linux/amd64
  --runner-version X.Y.Z Pin the runner version (default: latest release)
  --cache-dir PATH       Where to cache runner tarballs
  --no-workflow-check    Skip the runs-on audit of .github/workflows
  --fix-workflows        Open the workflow PR without asking first
  --no-fix-workflows     Never offer to open it
  --fix-jobs a,b         Limit the fix to these job ids
  --fix-label LABEL      Label the fix PR writes (default: ${DEFAULT_LABEL})
  -h, --help             Show this help
  -v, --version          Show the gh-runner version

IN YOUR WORKFLOW
  jobs:
    any-machine:
      runs-on: [self-hosted, ${DEFAULT_LABEL}]
    mac-only:
      runs-on: [self-hosted, ${OS_LABELS.osx}]
    linux-only:
      runs-on: [self-hosted, ${OS_LABELS.linux}]
    windows-only:
      runs-on: [self-hosted, ${OS_LABELS.win}]
`;

export function emptyOptions(): RunnerOptions {
  return {
    keep: false,
    allowPublic: false,
    repo: undefined,
    labels: [],
    skipWorkflowCheck: false,
    fixWorkflows: "ask",
    fixJobs: [],
    fixLabel: undefined,
    platforms: [],
    all: false,
    dockerImage: undefined,
    dockerPlatform: undefined,
    runnerVersion: undefined,
    name: undefined,
    cacheDir: undefined,
    cwd: undefined,
  };
}

export function parseLabels(value: string): string[] {
  return value
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

export function assertRepoSlug(repo: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new CliError(`--repo expects OWNER/NAME, got: ${repo}`);
  }
  return repo;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const options = emptyOptions();

  const requireValue = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith("-")) {
      throw new CliError(`${flag} needs a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--keep":
        options.keep = true;
        break;
      case "--allow-public":
        options.allowPublic = true;
        break;
      case "--repo":
        options.repo = assertRepoSlug(requireValue("--repo", argv[i + 1]));
        i += 1;
        break;
      case "--labels":
        options.labels = parseLabels(requireValue("--labels", argv[i + 1]));
        i += 1;
        break;
      case "--name":
        options.name = requireValue("--name", argv[i + 1]);
        i += 1;
        break;
      case "--runner-version":
        options.runnerVersion = requireValue("--runner-version", argv[i + 1]).replace(/^v/, "");
        i += 1;
        break;
      case "--cache-dir":
        options.cacheDir = requireValue("--cache-dir", argv[i + 1]);
        i += 1;
        break;
      case "--no-workflow-check":
        options.skipWorkflowCheck = true;
        break;
      case "--fix-workflows":
        options.fixWorkflows = "always";
        break;
      case "--no-fix-workflows":
        options.fixWorkflows = "never";
        break;
      case "--fix-jobs":
        options.fixJobs = parseLabels(requireValue("--fix-jobs", argv[i + 1]));
        options.fixWorkflows = "always";
        i += 1;
        break;
      case "--fix-label":
        options.fixLabel = requireValue("--fix-label", argv[i + 1]);
        i += 1;
        break;
      case "--all":
        options.all = true;
        break;
      case "--os":
      case "--platform":
        options.platforms.push(requireValue(arg, argv[i + 1]));
        i += 1;
        break;
      case "--docker-image":
        options.dockerImage = requireValue("--docker-image", argv[i + 1]);
        i += 1;
        break;
      case "--docker-platform":
        options.dockerPlatform = requireValue("--docker-platform", argv[i + 1]);
        i += 1;
        break;
      case "-h":
      case "--help":
        return { kind: "help", options };
      case "-v":
      case "--version":
        return { kind: "version", options };
      default:
        if (arg.startsWith("-")) {
          throw new CliError(`unknown option: ${arg}  (try --help)`);
        }
        // A bare word is a platform: `gh-runner mac linux`.
        options.platforms.push(arg);
    }
  }

  // Validate names now so a typo fails before anything is registered.
  parseTargetNames(options.platforms);

  return { kind: "run", options };
}
