/**
 * An error whose message is meant for a human at a terminal — printed as
 * `error: <message>` with no stack trace.
 */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

/** Thrown when the user interrupts (Ctrl+C) before the runner starts a job. */
export class InterruptedError extends Error {
  constructor(signal: NodeJS.Signals = "SIGINT") {
    super(`interrupted by ${signal}`);
    this.name = "InterruptedError";
  }
}
