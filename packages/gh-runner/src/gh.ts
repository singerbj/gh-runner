import { normalizeSha256 } from "./download.js";
import { CliError } from "./errors.js";
import { CommandFailedError, execCapture, execCommand, execSucceeds } from "./exec.js";
import type { CommandRunner, ExecOptions } from "./exec.js";
import { assertRunnerVersion } from "./platform.js";

/**
 * `UNKNOWN` means the question wasn't answered — not that the repo is safe.
 * Callers that gate on visibility have to treat it as the unknown it is.
 */
export type RepoVisibility = "PUBLIC" | "PRIVATE" | "INTERNAL" | "UNKNOWN";

/**
 * Digs the SHA-256 of one release asset out of an `actions/runner` release
 * body. The release notes carry `<!-- BEGIN SHA linux-x64 -->…` markers; a line
 * naming the asset next to a digest is accepted as a second shape, since the
 * notes are prose and prose gets reformatted.
 */
export function parseDigestFromReleaseBody(body: string, assetName: string): string | null {
  const key = /^actions-runner-([a-z0-9]+-[a-z0-9]+)-/.exec(assetName)?.[1];
  if (key) {
    const marked = new RegExp(
      `<!--\\s*BEGIN SHA ${key}\\s*-->\\s*([0-9a-fA-F]{64})\\s*<!--\\s*END SHA ${key}\\s*-->`,
    ).exec(body);
    const digest = normalizeSha256(marked?.[1]);
    if (digest) return digest;
  }

  for (const line of body.split("\n")) {
    if (!line.includes(assetName)) continue;
    const digest = normalizeSha256(/\b([0-9a-fA-F]{64})\b/.exec(line)?.[1]);
    if (digest) return digest;
  }

  return null;
}

export interface GhClientOptions {
  runner?: CommandRunner;
  /** Path to the `gh` binary. Defaults to `gh` on PATH. */
  bin?: string;
  signal?: AbortSignal;
}

/**
 * Thin wrapper around the GitHub CLI. Every network call goes through `gh` so
 * we inherit the user's existing `gh auth login` credentials and never touch a
 * token ourselves.
 */
export class GhClient {
  private readonly runner: CommandRunner;
  private readonly bin: string;
  private readonly signal: AbortSignal | undefined;

  constructor(options: GhClientOptions = {}) {
    this.runner = options.runner ?? execCommand;
    this.bin = options.bin ?? "gh";
    this.signal = options.signal;
  }

  private get execOptions(): ExecOptions {
    return this.signal ? { signal: this.signal } : {};
  }

  /** Fails with a friendly message when `gh` is missing or logged out. */
  async preflight(): Promise<void> {
    const present = await execSucceeds(this.runner, this.bin, ["--version"], this.execOptions);
    if (!present) {
      throw new CliError(
        "the GitHub CLI (gh) is required — install it from https://cli.github.com (macOS: brew install gh)",
      );
    }

    const authed = await execSucceeds(this.runner, this.bin, ["auth", "status"], this.execOptions);
    if (!authed) {
      throw new CliError("gh is not authenticated — run: gh auth login");
    }
  }

  /** `gh api <path>`, optionally with a `--jq` filter and string fields. */
  async api(
    path: string,
    options: {
      method?: "GET" | "POST" | "PATCH" | "DELETE";
      jq?: string;
      fields?: Readonly<Record<string, string>>;
    } = {},
  ): Promise<string> {
    const args = ["api"];
    if (options.method && options.method !== "GET") {
      args.push("-X", options.method);
    }
    args.push(path);
    for (const [name, value] of Object.entries(options.fields ?? {})) {
      // `-f` sends the value as a string and never as a shell word: gh parses
      // `name=value` itself, so a value with spaces or quotes stays intact.
      args.push("-f", `${name}=${value}`);
    }
    if (options.jq) {
      args.push("--jq", options.jq);
    }
    return execCapture(this.runner, this.bin, args, this.execOptions);
  }

  /** Resolves OWNER/NAME for a working directory, or null if there is none. */
  async detectRepo(cwd: string): Promise<string | null> {
    const inRepo = await execSucceeds(this.runner, "git", ["rev-parse", "--is-inside-work-tree"], {
      ...this.execOptions,
      cwd,
    });
    if (!inRepo) {
      throw new CliError("not inside a git repo — cd into one, or pass --repo OWNER/NAME");
    }

    try {
      const nameWithOwner = await execCapture(
        this.runner,
        this.bin,
        ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
        { ...this.execOptions, cwd },
      );
      return nameWithOwner || null;
    } catch {
      return null;
    }
  }

  /** Top level of the git checkout containing `cwd`, or null if there is none. */
  async repoRoot(cwd: string): Promise<string | null> {
    try {
      const root = await execCapture(this.runner, "git", ["rev-parse", "--show-toplevel"], {
        ...this.execOptions,
        cwd,
      });
      return root || null;
    } catch {
      return null;
    }
  }

  async visibility(repo: string): Promise<RepoVisibility> {
    try {
      const value = await execCapture(
        this.runner,
        this.bin,
        ["repo", "view", repo, "--json", "visibility", "--jq", ".visibility"],
        this.execOptions,
      );
      const upper = value.toUpperCase();
      if (upper === "PUBLIC" || upper === "PRIVATE" || upper === "INTERNAL") {
        return upper;
      }
      return "UNKNOWN";
    } catch {
      return "UNKNOWN";
    }
  }

  /** Latest `actions/runner` release, without the leading `v`. */
  async latestRunnerVersion(): Promise<string> {
    try {
      const tag = await this.api("repos/actions/runner/releases/latest", { jq: ".tag_name" });
      const version = tag.replace(/^v/, "").trim();
      if (!version) {
        throw new CliError("could not determine a runner version");
      }
      return assertRunnerVersion(version);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("couldn't reach the GitHub API to find the latest runner version");
    }
  }

  /**
   * The published SHA-256 of one `actions/runner` release asset, or null when
   * the release doesn't carry one.
   *
   * Two sources, because only the first is structured: the `digest` field the
   * releases API attaches to an asset, then the digests the release notes
   * publish. Null is a real answer — a release genuinely may not say — and the
   * caller decides what an unverifiable download is worth.
   */
  async runnerAssetDigest(version: string, assetName: string): Promise<string | null> {
    const path = `repos/actions/runner/releases/tags/v${assertRunnerVersion(version)}`;
    const selector = `select(.name == ${JSON.stringify(assetName)})`;

    try {
      const reported = await this.api(path, {
        jq: `.assets[] | ${selector} | .digest // empty`,
      });
      const digest = normalizeSha256(reported.split("\n")[0]);
      if (digest) return digest;
    } catch {
      // Fall through: an older API, or no such asset. The body may still say.
    }

    try {
      const body = await this.api(path, { jq: ".body // empty" });
      return parseDigestFromReleaseBody(body, assetName);
    } catch {
      return null;
    }
  }

  async registrationToken(repo: string): Promise<string> {
    try {
      return await this.api(`repos/${repo}/actions/runners/registration-token`, {
        method: "POST",
        jq: ".token",
      });
    } catch {
      throw new CliError(`couldn't mint a registration token — you need admin rights on ${repo}`);
    }
  }

  /** The repo's default branch, e.g. `main`. */
  async defaultBranch(repo: string): Promise<string> {
    try {
      const branch = await execCapture(
        this.runner,
        this.bin,
        ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
        this.execOptions,
      );
      if (branch) return branch;
    } catch {
      // fall through
    }
    throw new CliError(`couldn't determine the default branch of ${repo}`);
  }

  /** URL of the pull request whose head is `branch`, if one is open. */
  async pullRequestForBranch(repo: string, branch: string): Promise<string | null> {
    try {
      const url = await execCapture(
        this.runner,
        this.bin,
        [
          "pr",
          "list",
          "--repo",
          repo,
          "--head",
          branch,
          "--state",
          "open",
          "--json",
          "url",
          "--jq",
          ".[0].url",
        ],
        this.execOptions,
      );
      return url || null;
    } catch {
      return null;
    }
  }

  /** Opens a pull request and returns its URL. */
  async createPullRequest(options: {
    repo: string;
    base: string;
    head: string;
    title: string;
    body: string;
    cwd?: string;
  }): Promise<string | null> {
    const args = [
      "pr",
      "create",
      "--repo",
      options.repo,
      "--base",
      options.base,
      "--head",
      options.head,
      "--title",
      options.title,
      "--body",
      options.body,
    ];
    try {
      const output = await execCapture(this.runner, this.bin, args, {
        ...this.execOptions,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
      const url = output.split("\n").find((line) => line.startsWith("https://"));
      return url ?? null;
    } catch (error) {
      const detail = error instanceof CommandFailedError ? error.result.stderr.trim() : "";
      throw new CliError(`couldn't open a pull request${detail ? `\n       ${detail}` : ""}`);
    }
  }

  /**
   * Deletes a runner by name through the API.
   *
   * The container path can't run `config.sh remove` — the container is gone by
   * then — so it deregisters from the outside instead. Best effort: an
   * ephemeral runner that took a job is already retired, and this returns false
   * rather than complicating an exit path.
   */
  async deleteRunnerByName(repo: string, name: string): Promise<boolean> {
    try {
      const id = await this.api(`repos/${repo}/actions/runners?per_page=100`, {
        // JSON-quoted so a name with a quote in it can't break out of the filter.
        jq: `.runners[] | select(.name == ${JSON.stringify(name)}) | .id`,
      });
      const runnerId = id.split("\n")[0]?.trim();
      if (!runnerId) return false;

      await this.api(`repos/${repo}/actions/runners/${runnerId}`, { method: "DELETE" });
      return true;
    } catch {
      return false;
    }
  }

  /** The commit a tag points at, or null when the tag doesn't exist. */
  async tagSha(repo: string, tag: string): Promise<string | null> {
    try {
      // An annotated tag's ref points at the tag object; `object.sha` is what
      // `uses:` needs either way, since GitHub resolves both.
      const sha = (
        await this.api(`repos/${repo}/git/ref/tags/${tag}`, { jq: ".object.sha" })
      ).trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    } catch {
      return null;
    }
  }

  /** True when `path` exists in `repo` at `ref`. */
  async pathExists(repo: string, ref: string, path: string): Promise<boolean> {
    try {
      const type = await this.api(`repos/${repo}/contents/${path}?ref=${ref}`, { jq: ".type" });
      return type.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** The commit at the tip of the repo's default branch. */
  async defaultBranchSha(repo: string, branch: string): Promise<string | null> {
    try {
      const sha = (
        await this.api(`repos/${repo}/git/ref/heads/${branch}`, { jq: ".object.sha" })
      ).trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    } catch {
      return null;
    }
  }

  /**
   * Creates a ref, replacing one that already exists.
   *
   * Markers live outside `refs/heads` and `refs/tags`, so nothing here can
   * touch a branch or a release — the worst a bug could do is leave a dangling
   * pointer at a commit that already existed.
   */
  async createRef(repo: string, ref: string, sha: string): Promise<boolean> {
    try {
      await this.api(`repos/${repo}/git/refs`, { method: "POST", fields: { ref, sha } });
      return true;
    } catch {
      // 422 means it already exists; move it instead.
      try {
        await this.api(`repos/${repo}/git/${ref}`, {
          method: "PATCH",
          fields: { sha, force: "true" },
        });
        return true;
      } catch {
        return false;
      }
    }
  }

  /** Best effort — a marker that outlives its runner ages out on its own. */
  async deleteRef(repo: string, ref: string): Promise<boolean> {
    try {
      await this.api(`repos/${repo}/git/${ref}`, { method: "DELETE" });
      return true;
    } catch {
      return false;
    }
  }

  /** Every ref under `refs/<prefix>`, as full ref names. */
  async matchingRefs(repo: string, prefix: string): Promise<string[]> {
    try {
      const output = await this.api(`repos/${repo}/git/matching-refs/${prefix}`, {
        jq: ".[].ref",
      });
      return output.split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Best-effort: cleanup should never fail louder than the thing it cleans up. */
  async removeToken(repo: string): Promise<string | null> {
    try {
      const token = await this.api(`repos/${repo}/actions/runners/remove-token`, {
        method: "POST",
        jq: ".token",
      });
      return token || null;
    } catch {
      return null;
    }
  }
}
