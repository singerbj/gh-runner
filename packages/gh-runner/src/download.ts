import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
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
  /**
   * Lowercase hex SHA-256 the file must hash to. Checked on a cache hit as well
   * as after a download — the cache directory is an ordinary, writable path, so
   * a file sitting in it has proved nothing.
   */
  expectedSha256?: string | undefined;
  attempts?: number;
  signal?: AbortSignal;
  /** Called only when a download actually happens (i.e. on a cache miss). */
  onDownloadStart?: () => void;
  /** Called when a cached file failed its checksum and was thrown away. */
  onCacheRejected?: (detail: { path: string; expected: string; actual: string }) => void;
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

/** Lowercase hex SHA-256 of a file, streamed so a large tarball stays off the heap. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** True for the one shape a SHA-256 can take here: 64 lowercase hex digits. */
export function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * Normalises the forms GitHub reports a digest in — `sha256:<hex>`, bare hex,
 * any casing — into lowercase hex, or null when it isn't a SHA-256 at all.
 */
export function normalizeSha256(value: string | null | undefined): string | null {
  if (!value) return null;
  const hex = value
    .trim()
    .replace(/^sha256:/i, "")
    .toLowerCase();
  return isSha256(hex) ? hex : null;
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
 * Downloads `url` into `cacheDir/fileName` unless a verified copy is already
 * there. Writes to a `.part` sibling first so an interrupted run never leaves a
 * truncated tarball that a later run would happily extract.
 *
 * When `expectedSha256` is given nothing is returned until it matches. That
 * matters most for the cache: what lands there is later unpacked and executed,
 * and the directory is writable by anything running as this user, so a hit is
 * re-verified rather than trusted on the strength of its filename.
 */
export async function downloadCached(options: DownloadOptions): Promise<string> {
  const { url, cacheDir, fileName, signal } = options;
  const attempts = options.attempts ?? 3;
  const doFetch = options.fetchImpl ?? fetch;
  const expected = options.expectedSha256;
  const target = join(cacheDir, fileName);

  if (expected !== undefined && !isSha256(expected)) {
    throw new CliError(`not a SHA-256 digest: ${expected}`);
  }

  if (await exists(target)) {
    if (expected === undefined) {
      return target;
    }
    const actual = await sha256File(target);
    if (actual === expected) {
      return target;
    }
    // Tampered, truncated, or left over from a release that was re-cut. Any of
    // those is a reason to fetch it again, and none is a reason to run it.
    await rm(target, { force: true });
    options.onCacheRejected?.({ path: target, expected, actual });
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

      // Verified before the rename, so a mismatch never becomes a cache entry.
      if (expected !== undefined) {
        const actual = await sha256File(partial);
        if (actual !== expected) {
          throw new CliError(
            `checksum mismatch — expected ${expected}, got ${actual}.\n` +
              `       Refusing to unpack it. This should never happen on a good download.`,
          );
        }
      }

      await rename(partial, target);
      return target;
    } catch (error) {
      lastError = error;
      await rm(partial, { force: true });
      if (signal?.aborted) break;
      // A retry can fix a truncated transfer; it cannot fix a bad signature on
      // the same asset, and hammering the URL only obscures what happened.
      if (error instanceof CliError) break;
      if (attempt < attempts) {
        await delay(attempt * 1000, signal);
      }
    }
  }

  if (lastError instanceof CliError) throw lastError;
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
        // Both paths arrive through the environment and are referenced by name.
        // Spliced into the command string they would be PowerShell source, and
        // a directory named `$(...)` is a directory name a user can create.
        "Expand-Archive -LiteralPath $env:GHR_ARCHIVE -DestinationPath $env:GHR_DEST -Force",
      ],
      {
        ...exec,
        env: { ...process.env, GHR_ARCHIVE: archive, GHR_DEST: destination },
      },
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
