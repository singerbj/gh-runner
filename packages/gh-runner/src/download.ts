import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CliError } from "./errors.js";
import { execCapture } from "./exec.js";
import type { CommandRunner } from "./exec.js";

export interface DownloadOptions {
  url: string;
  cacheDir: string;
  fileName: string;
  attempts?: number;
  signal?: AbortSignal;
  /** Called only when a download actually happens (i.e. on a cache miss). */
  onDownloadStart?: () => void;
  fetchImpl?: typeof fetch;
}

async function exists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      },
      { once: true },
    );
  });

/**
 * Downloads `url` into `cacheDir/fileName` unless it is already there. Writes to
 * a `.part` sibling first so an interrupted run never leaves a truncated
 * tarball that a later run would happily extract.
 */
export async function downloadCached(options: DownloadOptions): Promise<string> {
  const { url, cacheDir, fileName, signal } = options;
  const attempts = options.attempts ?? 3;
  const doFetch = options.fetchImpl ?? fetch;
  const target = join(cacheDir, fileName);

  if (await exists(target)) {
    return target;
  }

  options.onDownloadStart?.();
  await mkdir(cacheDir, { recursive: true });

  const partial = `${target}.part`;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await doFetch(url, { redirect: "follow", ...(signal ? { signal } : {}) });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      await rename(partial, target);
      return target;
    } catch (error) {
      lastError = error;
      await rm(partial, { force: true });
      if (signal?.aborted) break;
      if (attempt < attempts) {
        await delay(attempt * 1000, signal);
      }
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new CliError(`download failed: ${url}\n       ${reason}`);
}

/**
 * Extracts the runner archive into `destination`.
 *
 * `tar` handles both shapes — it has shipped with Windows 10 since 1803 and
 * reads zips — so it is tried first everywhere. PowerShell's `Expand-Archive`
 * is the fallback for older Windows installs.
 */
export async function extractArchive(
  runner: CommandRunner,
  archive: string,
  destination: string,
  options: { signal?: AbortSignal; zip?: boolean } = {},
): Promise<void> {
  const { signal, zip = archive.endsWith(".zip") } = options;
  const exec = signal ? { signal } : {};
  await mkdir(destination, { recursive: true });

  const tarArgs = zip ? ["-xf", archive, "-C", destination] : ["xzf", archive, "-C", destination];
  try {
    await execCapture(runner, "tar", tarArgs, exec);
    return;
  } catch (tarError) {
    if (!zip) {
      throw new CliError(
        `couldn't extract ${archive} — delete it and try again\n       ${describe(tarError)}`,
      );
    }
  }

  try {
    await execCapture(
      runner,
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath "${archive}" -DestinationPath "${destination}" -Force`,
      ],
      exec,
    );
  } catch (error) {
    throw new CliError(
      `couldn't extract ${archive} — delete it and try again\n       ${describe(error)}`,
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
