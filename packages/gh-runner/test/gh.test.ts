import { describe, expect, it, vi } from "vitest";
import { CliError } from "../src/errors.js";
import type { CommandRunner, ExecResult } from "../src/exec.js";
import { GhClient, parseDigestFromReleaseBody } from "../src/gh.js";

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

describe("parseDigestFromReleaseBody", () => {
  const DIGEST = "a".repeat(64);
  const ASSET = "actions-runner-linux-x64-2.334.0.tar.gz";

  it("reads the SHA markers the release notes carry", () => {
    const body = `## v2.334.0\n\n<!-- BEGIN SHA linux-x64 -->${DIGEST}<!-- END SHA linux-x64 -->\n`;
    expect(parseDigestFromReleaseBody(body, ASSET)).toBe(DIGEST);
  });

  it("takes the marker for this asset's platform, never a neighbour's", () => {
    const other = "b".repeat(64);
    const body =
      `<!-- BEGIN SHA linux-arm64 -->${other}<!-- END SHA linux-arm64 -->\n` +
      `<!-- BEGIN SHA linux-x64 -->${DIGEST}<!-- END SHA linux-x64 -->\n`;
    expect(parseDigestFromReleaseBody(body, ASSET)).toBe(DIGEST);
  });

  it("falls back to a line that names the asset", () => {
    expect(parseDigestFromReleaseBody(`| ${ASSET} | ${DIGEST} |`, ASSET)).toBe(DIGEST);
  });

  it("returns null rather than guessing when the notes say nothing", () => {
    expect(parseDigestFromReleaseBody("Nothing to see here.", ASSET)).toBeNull();
    // A digest for some other asset is not this asset's digest.
    expect(parseDigestFromReleaseBody(`| other.tar.gz | ${DIGEST} |`, ASSET)).toBeNull();
  });
});

describe("GhClient.runnerAssetDigest", () => {
  const DIGEST = "c".repeat(64);
  const ASSET = "actions-runner-linux-x64-2.334.0.tar.gz";

  it("prefers the digest the releases API reports, sha256: prefix and all", async () => {
    const { runner } = fakeRunner({ ".digest": okResult(`sha256:${DIGEST.toUpperCase()}\n`) });
    await expect(new GhClient({ runner }).runnerAssetDigest("2.334.0", ASSET)).resolves.toBe(
      DIGEST,
    );
  });

  it("falls back to the release notes when the API reports no digest", async () => {
    const { runner } = fakeRunner({
      ".digest": okResult(""),
      ".body": okResult(`<!-- BEGIN SHA linux-x64 -->${DIGEST}<!-- END SHA linux-x64 -->`),
    });
    await expect(new GhClient({ runner }).runnerAssetDigest("2.334.0", ASSET)).resolves.toBe(
      DIGEST,
    );
  });

  it("returns null when neither source has one", async () => {
    const { runner } = fakeRunner({}, errResult);
    await expect(new GhClient({ runner }).runnerAssetDigest("2.334.0", ASSET)).resolves.toBeNull();
  });

  it("refuses a version that isn't one, so nothing else can reach the API path", async () => {
    const { runner, calls } = fakeRunner({}, errResult);
    await expect(
      new GhClient({ runner }).runnerAssetDigest("2.334.0/../../evil", ASSET),
    ).rejects.toThrow(CliError);
    expect(calls).toHaveLength(0);
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

describe("GhClient variables", () => {
  it("updates first, so the call a heartbeat repeats costs one request", async () => {
    const { runner, calls } = fakeRunner({
      "actions/variables/GH_RUNNER_PROBE_RUNS_ON": okResult(""),
    });
    await expect(
      new GhClient({ runner }).setVariable("a/b", "GH_RUNNER_PROBE_RUNS_ON", "[]"),
    ).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "api",
      "-X",
      "PATCH",
      "repos/a/b/actions/variables/GH_RUNNER_PROBE_RUNS_ON",
      "-f",
      "name=GH_RUNNER_PROBE_RUNS_ON",
      "-f",
      "value=[]",
    ]);
  });

  it("creates the variable when there isn't one to update", async () => {
    const { runner, calls } = fakeRunner(
      { "-X POST repos/a/b/actions/variables": okResult("") },
      errResult,
    );
    await expect(new GhClient({ runner }).setVariable("a/b", "V", "x")).resolves.toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("reports failure rather than throwing when neither call lands", async () => {
    const { runner } = fakeRunner({}, errResult);
    await expect(new GhClient({ runner }).setVariable("a/b", "V", "x")).resolves.toBe(false);
    await expect(new GhClient({ runner }).deleteVariable("a/b", "V")).resolves.toBe(false);
  });

  it("deletes by name", async () => {
    const { runner, calls } = fakeRunner({ "actions/variables/V": okResult("") });
    await expect(new GhClient({ runner }).deleteVariable("a/b", "V")).resolves.toBe(true);
    expect(calls[0]?.args).toEqual(["api", "-X", "DELETE", "repos/a/b/actions/variables/V"]);
  });
});
