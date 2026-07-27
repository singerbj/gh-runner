import { CliError } from "./errors.js";
import { execCapture, execCommand, execSucceeds } from "./exec.js";
import type { CommandRunner, ExecOptions } from "./exec.js";

export type RepoVisibility = "PUBLIC" | "PRIVATE" | "INTERNAL" | "UNKNOWN";

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

  /** `gh api <path>`, optionally with a `--jq` filter. */
  async api(
    path: string,
    options: { method?: "GET" | "POST" | "DELETE"; jq?: string } = {},
  ): Promise<string> {
    const args = ["api"];
    if (options.method && options.method !== "GET") {
      args.push("-X", options.method);
    }
    args.push(path);
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
      return version;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("couldn't reach the GitHub API to find the latest runner version");
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
