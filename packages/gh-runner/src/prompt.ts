import { createInterface } from "node:readline/promises";

/** Asks a yes/no question. Resolves to `fallback` when nobody can answer. */
export type Confirm = (question: string, fallback?: boolean) => Promise<boolean>;

export interface ConfirmOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/**
 * A prompt bound to the terminal. Without a TTY on both ends — piped output, a
 * CI job, a cron entry — it answers `fallback` rather than blocking forever.
 */
export function createConfirm(options: ConfirmOptions = {}): Confirm {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;

  return async (question, fallback = false) => {
    if (!input.isTTY) {
      return fallback;
    }

    const rl = createInterface({ input, output });
    try {
      const suffix = fallback ? "[Y/n]" : "[y/N]";
      const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
      if (!answer) return fallback;
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  };
}

/** Never asks, always declines — the default for library and non-interactive use. */
export const declineAll: Confirm = () => Promise.resolve(false);
