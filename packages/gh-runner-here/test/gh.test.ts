import { describe, expect, it, vi } from "vitest";
import { CliError } from "../src/errors.js";
import type { CommandRunner, ExecResult } from "../src/exec.js";
import { GhClient } from "../src/gh.js";

type Reply = ExecResult | ((args: readonly string[]) => ExecResult);

/** A fake `gh`/`git` that answers from a table keyed by a substring of argv. */
function fakeRunner(table: Record<string, Reply>, fallback?: ExecResult) {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner: CommandRunner = (command, args) => {
    calls.push({ command, args });
    const key = Object.keys(table).find((k) => `${command} ${args.join(" ")}`.includes(k));
    const reply = key ? table[key] : fallback;
    if (!reply) {
      return Promise.resolve({ code: 1, stdout: "", stderr: `unexpected: ${command}` });
    }
    return Promise.resolve(typeof reply === "function" ? reply(args) : reply);
  };
  return { runner: vi.fn(runner) as unknown as CommandRunner, calls };
}

const okResult = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const errResult: ExecResult = { code: 1, stdout: "", stderr: "nope" };

describe("GhClient.preflight", () => {
  it("passes when gh exists and is authenticated", async () => {
    const { runner } = fakeRunner({
      "gh --version": okResult("gh version 2.60.0"),
      "gh auth status": okResult("Logged in"),
    });
    await expect(new GhClient({ runner }).preflight()).resolves.toBeUndefined();
  });

  it("explains how to install gh when it is missing", async () => {
    const { runner } = fakeRunner({}, errResult);
    await expect(new GhClient({ runner }).preflight()).rejects.toThrow(/GitHub CLI \(gh\)/);
  });

  it("explains how to log in when gh is not authenticated", async () => {
    const { runner } = fakeRunner({ "gh --version": okResult("gh version 2.60.0") }, errResult);
    await expect(new GhClient({ runner }).preflight()).rejects.toThrow(/gh auth login/);
  });
});

describe("GhClient.detectRepo", () => {
  it("returns OWNER/NAME for a GitHub checkout", async () => {
    const { runner } = fakeRunner({
      "git rev-parse": okResult("true"),
      "gh repo view --json nameWithOwner": okResult("octocat/hello-world\n"),
    });
    await expect(new GhClient({ runner }).detectRepo("/tmp/x")).resolves.toBe(
      "octocat/hello-world",
    );
  });

  it("refuses to guess outside a git repo", async () => {
    const { runner } = fakeRunner({}, errResult);
    await expect(new GhClient({ runner }).detectRepo("/tmp/x")).rejects.toThrow(
      /not inside a git repo/,
    );
  });

  it("returns null when the checkout has no GitHub remote", async () => {
    const { runner } = fakeRunner({ "git rev-parse": okResult("true") }, errResult);
    await expect(new GhClient({ runner }).detectRepo("/tmp/x")).resolves.toBeNull();
  });
});

describe("GhClient.visibility", () => {
  it("normalises the visibility gh reports", async () => {
    const { runner } = fakeRunner({ "gh repo view": okResult("public") });
    await expect(new GhClient({ runner }).visibility("a/b")).resolves.toBe("PUBLIC");
  });

  it("reports UNKNOWN rather than throwing when gh fails", async () => {
    const { runner } = fakeRunner({}, errResult);
    await expect(new GhClient({ runner }).visibility("a/b")).resolves.toBe("UNKNOWN");
  });
});

describe("GhClient tokens and versions", () => {
  it("strips the leading v from the latest runner tag", async () => {
    const { runner } = fakeRunner({ "releases/latest": okResult("v2.334.0\n") });
    await expect(new GhClient({ runner }).latestRunnerVersion()).resolves.toBe("2.334.0");
  });

  it("surfaces a missing-admin-rights hint for registration tokens", async () => {
    const { runner } = fakeRunner({}, errResult);
    const client = new GhClient({ runner });
    await expect(client.registrationToken("a/b")).rejects.toThrow(CliError);
    await expect(client.registrationToken("a/b")).rejects.toThrow(/admin rights on a\/b/);
  });

  it("POSTs to the registration-token endpoint", async () => {
    const { runner, calls } = fakeRunner({ "registration-token": okResult("REG123") });
    await expect(new GhClient({ runner }).registrationToken("a/b")).resolves.toBe("REG123");
    expect(calls[0]?.args).toEqual([
      "api",
      "-X",
      "POST",
      "repos/a/b/actions/runners/registration-token",
      "--jq",
      ".token",
    ]);
  });

  it("returns null instead of throwing when a removal token cannot be minted", async () => {
    const { runner } = fakeRunner({}, errResult);
    await expect(new GhClient({ runner }).removeToken("a/b")).resolves.toBeNull();
  });
});
