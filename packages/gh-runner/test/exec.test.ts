import { describe, expect, it, vi } from "vitest";
import { CommandFailedError, execCapture, execCommand, execSucceeds } from "../src/exec.js";
import type { ExecResult } from "../src/exec.js";

describe("execCommand", () => {
  it("captures stdout and stderr separately", async () => {
    const result = await execCommand("node", ["-e", "console.log('out'); console.error('err')"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
  });

  it("reports a non-zero exit rather than throwing", async () => {
    const result = await execCommand("node", ["-e", "process.exit(3)"]);
    expect(result.code).toBe(3);
  });

  it("passes argv verbatim, with no shell in between", async () => {
    // With a shell this would expand; as argv it stays one literal string.
    const result = await execCommand("node", ["-e", "console.log(process.argv[1])", "$HOME; ls"]);
    expect(result.stdout.trim()).toBe("$HOME; ls");
  });

  it("feeds stdin when given input", async () => {
    const result = await execCommand("node", ["-e", "process.stdin.pipe(process.stdout)"], {
      input: "hello",
    });
    expect(result.stdout).toBe("hello");
  });
});

describe("output prefixing", () => {
  /** Captures what the child's output looks like once prefixed. */
  async function prefixed(script: string, prefix = "[macOS] ") {
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    try {
      await execCommand("node", ["-e", script], { prefix });
    } finally {
      spy.mockRestore();
    }
    return written;
  }

  it("puts the prefix at the start of every line", async () => {
    const written = await prefixed("console.log('one'); console.log('two')");
    expect(written).toEqual(["[macOS] one\n", "[macOS] two\n"]);
  });

  it("waits for a full line before prefixing, so writes can't interleave mid-line", async () => {
    // Three writes, one line: the prefix must appear exactly once.
    const written = await prefixed(
      "process.stdout.write('a'); process.stdout.write('b'); process.stdout.write('c\\n')",
    );
    expect(written.join("")).toBe("[macOS] abc\n");
  });

  it("flushes a trailing line that never got its newline", async () => {
    const written = await prefixed("process.stdout.write('no newline')");
    expect(written.join("")).toBe("[macOS] no newline\n");
  });

  it("still captures the raw output for the caller", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const result = await execCommand("node", ["-e", "console.log('x')"], { prefix: "[p] " });
      expect(result.stdout).toBe("x\n");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("execCapture / execSucceeds", () => {
  it("returns trimmed stdout on success", async () => {
    await expect(execCapture(execCommand, "node", ["-e", "console.log(' hi ')"])).resolves.toBe(
      "hi",
    );
  });

  it("throws with the command and result attached on failure", async () => {
    const error = await execCapture(execCommand, "node", ["-e", "process.exit(2)"]).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as CommandFailedError).result.code).toBe(2);
  });

  it("says what the command said, not just how it exited", async () => {
    const said = (result: Partial<ExecResult>) =>
      new CommandFailedError("git", ["worktree", "add"], {
        code: 255,
        stdout: "",
        stderr: "",
        ...result,
      }).message;

    expect(said({ stderr: "fatal: a branch named 'x' already exists\nhint: ignored\n" })).toBe(
      "`git worktree add` exited with 255: fatal: a branch named 'x' already exists",
    );
    // Falls back to stdout — some commands fail without saying so on stderr.
    expect(said({ stdout: "no such remote" })).toBe(
      "`git worktree add` exited with 255: no such remote",
    );
    // Nothing to add when the command said nothing at all.
    expect(said({})).toBe("`git worktree add` exited with 255");
  });

  it("reduces an exit code to a boolean", async () => {
    await expect(execSucceeds(execCommand, "node", ["-e", ""])).resolves.toBe(true);
    await expect(execSucceeds(execCommand, "definitely-not-a-real-binary", [])).resolves.toBe(
      false,
    );
  });
});
