#!/usr/bin/env node
import type { ChildProcess } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, InterruptedError } from "./errors.js";
import { createLogger } from "./logger.js";
import { USAGE, parseArgs } from "./options.js";
import { createConfirm } from "./prompt.js";
import { ghRunner, terminalPlatformPicker } from "./runner.js";

function readVersion(): string {
  try {
    const pkgPath = join(dirname(dirname(fileURLToPath(import.meta.url))), "package.json");
    const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string") {
      return pkg.version;
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const logger = createLogger();

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (parsed.kind === "help") {
    logger.raw(USAGE);
    return 0;
  }
  if (parsed.kind === "version") {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  const abort = new AbortController();
  let child: ChildProcess | undefined;
  let interrupts = 0;

  const onSignal = (signal: NodeJS.Signals) => {
    interrupts += 1;
    if (interrupts > 1) {
      // Second Ctrl+C: the user wants out now. Cleanup already had its chance.
      process.exit(130);
    }
    // When we own a terminal the signal already reached the whole foreground
    // process group, run.sh included; otherwise it has to be forwarded.
    if (child && !process.stdout.isTTY && !process.stdin.isTTY) {
      child.kill(signal);
    }
    abort.abort(new InterruptedError(signal));
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    await ghRunner(parsed.options, {
      logger,
      confirm: createConfirm(),
      selectPlatforms: terminalPlatformPicker,
      signal: abort.signal,
      onRunnerSpawn: (spawned) => {
        child = spawned;
      },
    });
    logger.say(`${logger.styles.green("Done.")} Nothing left registered, nothing left on disk.`);
    return 0;
  } catch (error) {
    if (error instanceof InterruptedError || abort.signal.aborted) {
      logger.say(`${logger.styles.green("Done.")} Nothing left registered, nothing left on disk.`);
      return 130;
    }
    if (error instanceof CliError) {
      logger.error(error.message);
      return error.exitCode;
    }
    logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/** True when this file is the process entrypoint (`npx`/`.bin` symlinks included). */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
