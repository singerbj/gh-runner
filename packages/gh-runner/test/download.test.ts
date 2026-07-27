import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadCached, isSha256, normalizeSha256, sha256File } from "../src/download.js";
import { CliError } from "../src/errors.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const TARBALL = "actions-runner-linux-x64-2.334.0.tar.gz";
const GOOD = "the real runner";
const GOOD_SHA = sha256(GOOD);

let cacheDir = "";

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "gh-runner-download-"));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

/** A fetch that answers every request with the same body. */
const serving = (body: string, calls: string[] = []): typeof fetch =>
  ((url: string) => {
    calls.push(String(url));
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as unknown as typeof fetch;

describe("normalizeSha256", () => {
  it("accepts the shapes GitHub reports a digest in", () => {
    const digest = "a".repeat(64);
    expect(normalizeSha256(digest)).toBe(digest);
    expect(normalizeSha256(`sha256:${digest}`)).toBe(digest);
    expect(normalizeSha256(`SHA256:${digest.toUpperCase()}`)).toBe(digest);
    expect(normalizeSha256(`  ${digest}  `)).toBe(digest);
  });

  it("rejects anything that isn't one", () => {
    expect(normalizeSha256("")).toBeNull();
    expect(normalizeSha256(null)).toBeNull();
    expect(normalizeSha256("deadbeef")).toBeNull();
    // 64 characters, but not 64 hex characters.
    expect(normalizeSha256("z".repeat(64))).toBeNull();
  });

  it("agrees with isSha256", () => {
    expect(isSha256("a".repeat(64))).toBe(true);
    expect(isSha256("A".repeat(64))).toBe(false);
    expect(isSha256("a".repeat(63))).toBe(false);
  });
});

describe("sha256File", () => {
  it("hashes what is actually on disk", async () => {
    const path = join(cacheDir, "x");
    await writeFile(path, GOOD);
    await expect(sha256File(path)).resolves.toBe(GOOD_SHA);
  });
});

describe("downloadCached", () => {
  it("keeps a cached file that matches the published checksum", async () => {
    const target = join(cacheDir, TARBALL);
    await writeFile(target, GOOD);
    const calls: string[] = [];

    await expect(
      downloadCached({
        url: "https://example.invalid/runner.tar.gz",
        cacheDir,
        fileName: TARBALL,
        expectedSha256: GOOD_SHA,
        fetchImpl: serving(GOOD, calls),
      }),
    ).resolves.toBe(target);

    // A verified cache hit is still a cache hit: nothing was fetched.
    expect(calls).toEqual([]);
  });

  it("re-downloads a cached file that does not match, instead of running it", async () => {
    const target = join(cacheDir, TARBALL);
    await writeFile(target, "#!/bin/sh\nrm -rf ~\n");
    const rejected: string[] = [];

    const path = await downloadCached({
      url: "https://example.invalid/runner.tar.gz",
      cacheDir,
      fileName: TARBALL,
      expectedSha256: GOOD_SHA,
      fetchImpl: serving(GOOD),
      onCacheRejected: ({ path: bad }) => rejected.push(bad),
    });

    expect(rejected).toEqual([target]);
    await expect(readFile(path, "utf8")).resolves.toBe(GOOD);
  });

  it("refuses a download whose checksum is wrong, and caches nothing", async () => {
    const calls: string[] = [];
    await expect(
      downloadCached({
        url: "https://example.invalid/runner.tar.gz",
        cacheDir,
        fileName: TARBALL,
        expectedSha256: sha256("something else entirely"),
        fetchImpl: serving(GOOD, calls),
      }),
    ).rejects.toThrow(/checksum mismatch/);

    // Not retried: the same asset will hash the same way three times over.
    expect(calls).toHaveLength(1);
    await expect(readFile(join(cacheDir, TARBALL), "utf8")).rejects.toThrow();
    await expect(readFile(`${join(cacheDir, TARBALL)}.part`, "utf8")).rejects.toThrow();
  });

  it("stores a download whose checksum is right", async () => {
    const path = await downloadCached({
      url: "https://example.invalid/runner.tar.gz",
      cacheDir,
      fileName: TARBALL,
      expectedSha256: GOOD_SHA,
      fetchImpl: serving(GOOD),
    });
    await expect(readFile(path, "utf8")).resolves.toBe(GOOD);
  });

  it("rejects an expectation that isn't a SHA-256 rather than skipping the check", async () => {
    await expect(
      downloadCached({
        url: "https://example.invalid/runner.tar.gz",
        cacheDir,
        fileName: TARBALL,
        expectedSha256: "not-a-digest",
        fetchImpl: serving(GOOD),
      }),
    ).rejects.toThrow(CliError);
  });

  it("still works with no checksum to check against", async () => {
    const path = await downloadCached({
      url: "https://example.invalid/runner.tar.gz",
      cacheDir,
      fileName: TARBALL,
      fetchImpl: serving(GOOD),
    });
    await expect(readFile(path, "utf8")).resolves.toBe(GOOD);
  });
});
