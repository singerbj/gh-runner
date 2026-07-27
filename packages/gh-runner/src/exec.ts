import { spawn } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";

/** Called with the child as soon as it is spawned, e.g. to forward signals. */
export type SpawnHook = (child: ChildProcess) => void;

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Forward stdio to the parent instead of capturing it. */
  inherit?: boolean;
  /** Text piped to the child's stdin (ignored when `inherit` is set). */
  input?: string;
  signal?: AbortSignal;
  onSpawn?: SpawnHook;
  /**
   * Echo the child's output line by line behind this prefix. Used when several
   * runners share one terminal — `inherit` would interleave them mid-line.
   */
  prefix?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command without a shell. `argv` is passed through verbatim, so tokens
 * that came from the network (registration tokens, repo names) can never be
 * re-interpreted as shell syntax.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export const execCommand: CommandRunner = (command, args, options = {}) =>
  new Promise<ExecResult>((resolve, reject) => {
    const stdio: StdioOptions =
      options.inherit && options.prefix === undefined
        ? ["inherit", "inherit", "inherit"]
        : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"];

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio,
      // Never a shell: see CommandRunner.
      shell: false,
      signal: options.signal,
    });

    options.onSpawn?.(child);

    let stdout = "";
    let stderr = "";

    // Buffers partial lines so a prefix only ever lands at a real line start.
    const echo = (prefix: string, sink: NodeJS.WritableStream) => {
      let pending = "";
      return {
        push(chunk: string) {
          pending += chunk;
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) sink.write(`${prefix}${line}\n`);
        },
        flush() {
          if (pending) sink.write(`${prefix}${pending}\n`);
          pending = "";
        },
      };
    };

    const outEcho = options.prefix ? echo(options.prefix, process.stdout) : undefined;
    const errEcho = options.prefix ? echo(options.prefix, process.stderr) : undefined;

    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      outEcho?.push(chunk);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      errEcho?.push(chunk);
    });

    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input);
    }

    child.on("error", reject);
    child.on("close", (code, signal) => {
      outEcho?.flush();
      errEcho?.flush();
      // A child killed by a signal reports code === null; surface it as a
      // conventional 128+n so callers can still branch on a number.
      const exitCode = code ?? (signal ? 128 : 1);
      resolve({ code: exitCode, stdout, stderr });
    });
  });

export class CommandFailedError extends Error {
  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly result: ExecResult,
  ) {
    // Without the child's own words an exit code is a riddle: git says 255 for
    // everything from a bad ref to a branch that already exists.
    const said = firstLine(result.stderr) || firstLine(result.stdout);
    super(
      `\`${command} ${args.join(" ")}\` exited with ${result.code}` + (said ? `: ${said}` : ""),
    );
    this.name = "CommandFailedError";
  }
}

function firstLine(output: string): string {
  return (
    output
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

/** Runs a command and throws unless it exits 0. Returns trimmed stdout. */
export async function execCapture(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  options?: ExecOptions,
): Promise<string> {
  const result = await runner(command, args, options);
  if (result.code !== 0) {
    throw new CommandFailedError(command, args, result);
  }
  return result.stdout.trim();
}

/** Runs a command and reports only whether it succeeded. */
export async function execSucceeds(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  options?: ExecOptions,
): Promise<boolean> {
  try {
    const result = await runner(command, args, options);
    return result.code === 0;
  } catch {
    return false;
  }
}
