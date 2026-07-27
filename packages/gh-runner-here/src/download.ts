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

/** Extracts a gzipped tarball into `destination` using the system `tar`. */
export async function extractTarball(
  runner: CommandRunner,
  tarball: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  try {
    await execCapture(runner, "tar", ["xzf", tarball, "-C", destination], {
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new CliError(`couldn't extract ${tarball} — delete it and try again`);
  }
}
