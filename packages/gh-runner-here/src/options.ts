import { CliError } from "./errors.js";

export interface RunnerOptions {
  /** Stay online for many jobs instead of exiting after one. */
  keep: boolean;
  /** Register on a public repo, where any fork PR could run code here. */
  allowPublic: boolean;
  /** OWNER/NAME. When omitted, detected from `cwd`. */
  repo: string | undefined;
  /** Extra labels on top of the host label. */
  labels: string[];
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

export const USAGE = `gh-runner-here — temporarily register this machine as a GitHub Actions runner

USAGE
  gh-runner-here [options]          # run from inside a git repo
  npx gh-runner-here [options]

OPTIONS
  --keep                 Stay online for multiple jobs (default: exit after one)
  --labels a,b,c         Extra labels in addition to the default host label
  --repo OWNER/NAME      Target a specific repo instead of detecting from cwd
  --name NAME            Runner name to register (default: <host>-<pid>)
  --allow-public         Permit registration on a public repo (dangerous)
  --runner-version X.Y.Z Pin the runner version (default: latest release)
  --cache-dir PATH       Where to cache runner tarballs
  -h, --help             Show this help
  -v, --version          Show the gh-runner-here version

IN YOUR WORKFLOW
  jobs:
    build:
      runs-on: [self-hosted, <label printed at startup>]
`;

export function emptyOptions(): RunnerOptions {
  return {
    keep: false,
    allowPublic: false,
    repo: undefined,
    labels: [],
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
      case "-h":
      case "--help":
        return { kind: "help", options };
      case "-v":
      case "--version":
        return { kind: "version", options };
      default:
        throw new CliError(`unknown option: ${arg}  (try --help)`);
    }
  }

  return { kind: "run", options };
}
