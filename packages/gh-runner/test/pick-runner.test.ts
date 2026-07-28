import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markerRef } from "../src/markers.js";

const run = promisify(execFile);

// test/ -> gh-runner/ -> packages/ -> repo root
const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const ACTION = join(REPO_ROOT, "actions", "pick-runner", "pick-runner.mjs");

const TARGETS = JSON.stringify({
  linux: { labels: ["self-hosted", "gh-runner-linux"], fallback: "ubuntu-latest" },
  mac: { labels: ["self-hosted", "gh-runner-mac"], fallback: "macos-14" },
});

/**
 * The action is run the way the runner runs it — a real node process, reading
 * INPUT_* out of the environment and writing to GITHUB_OUTPUT — against a
 * stand-in for the refs API.
 */
describe("pick-runner action", () => {
  let server: Server;
  let url = "";
  let dir = "";
  let refs: string[] = [];
  let status = 200;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gh-runner-action-"));
    refs = [];
    status = 200;

    server = createServer((req, res) => {
      if (!req.url?.includes("/git/matching-refs/gh-runner/online")) {
        res.writeHead(404).end("[]");
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(refs.map((ref) => ({ ref }))));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    url = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const pick = async (overrides: Record<string, string> = {}) => {
    const outputFile = join(dir, "output");
    await run(process.execPath, [ACTION], {
      env: {
        ...process.env,
        INPUT_TARGETS: TARGETS,
        INPUT_TOKEN: "test-token",
        INPUT_REPOSITORY: "octocat/thing",
        "INPUT_API-URL": url,
        GITHUB_OUTPUT: outputFile,
        ...overrides,
      },
    });

    const written = await readFile(outputFile, "utf8");
    const outputs: Record<string, string> = {};
    const lines = written.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const header = /^([a-z-]+)<<(.+)$/.exec(lines[i] ?? "");
      if (!header?.[1] || !header[2]) continue;
      const end = lines.indexOf(header[2], i + 1);
      outputs[header[1]] = lines.slice(i + 1, end).join("\n");
      i = end;
    }
    return outputs;
  };

  const now = () => Math.floor(Date.now() / 1000);

  it("picks the self-hosted labels for a label that is online", async () => {
    refs = [markerRef("gh-runner-linux", now() - 30) as string];

    const outputs = await pick();
    expect(JSON.parse(outputs["runners"] ?? "{}")).toEqual({
      linux: ["self-hosted", "gh-runner-linux"],
      mac: "macos-14",
    });
    expect(JSON.parse(outputs["online"] ?? "[]")).toEqual(["linux"]);
    expect(outputs["any-online"]).toBe("true");
  });

  it("queues on the self-hosted labels when that is what the fallback says", async () => {
    // What `--no-hosted-fallback` writes: the fallback is the labels themselves,
    // so an offline platform resolves to a runs-on nothing hosted can answer and
    // the job waits. `hosted` records what was replaced and the action ignores it.
    const queued = JSON.stringify({
      linux: {
        labels: ["self-hosted", "gh-runner-linux"],
        fallback: ["self-hosted", "gh-runner-linux"],
        hosted: "ubuntu-latest",
      },
    });

    const outputs = await pick({ INPUT_TARGETS: queued });
    expect(JSON.parse(outputs["runners"] ?? "{}")).toEqual({
      linux: ["self-hosted", "gh-runner-linux"],
    });
    expect(outputs["any-online"]).toBe("false");
  });

  it("falls back for a marker that has aged out", async () => {
    refs = [markerRef("gh-runner-linux", now() - 10_000) as string];

    const outputs = await pick();
    expect(JSON.parse(outputs["runners"] ?? "{}")).toEqual({
      linux: "ubuntu-latest",
      mac: "macos-14",
    });
    expect(outputs["any-online"]).toBe("false");
  });

  it("honours max-age", async () => {
    refs = [markerRef("gh-runner-mac", now() - 500) as string];

    // Older than the default window, inside a wider one.
    expect(JSON.parse((await pick())["runners"] ?? "{}").mac).toBe("macos-14");
    expect(JSON.parse((await pick({ "INPUT_MAX-AGE": "900" }))["runners"] ?? "{}").mac).toEqual([
      "self-hosted",
      "gh-runner-mac",
    ]);
  });

  it("falls back rather than failing when the API says no", async () => {
    status = 500;

    const outputs = await pick();
    expect(JSON.parse(outputs["runners"] ?? "{}")).toEqual({
      linux: "ubuntu-latest",
      mac: "macos-14",
    });
  });

  it("falls back rather than failing when the API can't be reached at all", async () => {
    const outputs = await pick({ "INPUT_API-URL": "http://127.0.0.1:1" });
    expect(JSON.parse(outputs["runners"] ?? "{}").linux).toBe("ubuntu-latest");
  });

  it("survives a targets input that isn't usable", async () => {
    const outputs = await pick({ INPUT_TARGETS: "{not json" });
    // An empty map is what the generated `runs-on` expects on this path: its
    // own `|| 'ubuntu-latest'` takes over.
    expect(JSON.parse(outputs["runners"] ?? "null")).toEqual({});
  });
});
