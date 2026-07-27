import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE,
  archForDockerPlatform,
  assertDockerAvailable,
  containerScript,
  dockerRunArgs,
} from "../src/docker.js";
import { CliError } from "../src/errors.js";
import type { CommandRunner, ExecResult } from "../src/exec.js";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (): ExecResult => ({ code: 1, stdout: "", stderr: "nope" });

const RUN = {
  repo: "octocat/thing",
  image: DEFAULT_IMAGE,
  dockerPlatform: undefined,
  containerName: "gh-runner-123",
  runnerName: "my-box-docker-123",
  labels: ["gh-runner", "gh-runner-linux", "my-box"],
  ephemeral: true,
  registrationToken: "REG123",
};

describe("archForDockerPlatform", () => {
  it("defaults to the host architecture", () => {
    expect(archForDockerPlatform(undefined, "arm64")).toBe("arm64");
    expect(archForDockerPlatform(undefined, "x64")).toBe("x64");
  });

  it("follows an explicit platform, so labels match what actually runs", () => {
    expect(archForDockerPlatform("linux/amd64", "arm64")).toBe("x64");
    expect(archForDockerPlatform("linux/arm64", "x64")).toBe("arm64");
  });

  it("rejects a platform it can't label", () => {
    expect(() => archForDockerPlatform("linux/riscv64", "x64")).toThrow(CliError);
  });
});

describe("assertDockerAvailable", () => {
  it("passes when the CLI is installed and the daemon answers", async () => {
    const runner: CommandRunner = () => Promise.resolve(ok("27.0.0"));
    await expect(assertDockerAvailable(runner)).resolves.toBeUndefined();
  });

  it("explains how to install Docker when the CLI is missing", async () => {
    const runner: CommandRunner = () => Promise.resolve(fail());
    await expect(assertDockerAvailable(runner)).rejects.toThrow(/needs the Docker CLI/);
  });

  it("distinguishes a stopped daemon from a missing CLI", async () => {
    const runner: CommandRunner = (_cmd, args) =>
      Promise.resolve(args.includes("--version") ? ok("27.0.0") : fail());
    await expect(assertDockerAvailable(runner)).rejects.toThrow(/daemon isn't reachable/);
  });
});

describe("containerScript", () => {
  it("reads every value from the environment, never from the command string", () => {
    const script = containerScript(true);
    expect(script).toContain('--token "$GHR_TOKEN"');
    expect(script).toContain('--url "$GHR_URL"');
    expect(script).toContain('--labels "$GHR_LABELS"');
    expect(script).toContain("--ephemeral");
    expect(script).toContain("./run.sh");
    // No interpolation of anything the API handed us.
    expect(script).not.toContain("REG123");
  });

  it("drops --ephemeral when the runner should stay online", () => {
    expect(containerScript(false)).not.toContain("--ephemeral");
  });
});

describe("dockerRunArgs", () => {
  it("builds a self-removing, named, foreground container", () => {
    const args = dockerRunArgs(RUN);
    expect(args[0]).toBe("run");
    expect(args).toContain("--rm");
    expect(args).toContain("--name");
    expect(args).toContain("gh-runner-123");
    expect(args).toContain(DEFAULT_IMAGE);
    expect(args).not.toContain("-d");
    // No host mounts at all — the job cannot reach the developer's filesystem.
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--volume");
    expect(args.join(" ")).not.toContain("docker.sock");
  });

  it("passes the token and labels as environment, not as shell text", () => {
    const args = dockerRunArgs(RUN);
    expect(args).toContain("GHR_TOKEN=REG123");
    expect(args).toContain("GHR_URL=https://github.com/octocat/thing");
    expect(args).toContain("GHR_LABELS=gh-runner,gh-runner-linux,my-box");
    expect(args).toContain("GHR_NAME=my-box-docker-123");

    const script = args[args.length - 1] ?? "";
    expect(script).not.toContain("REG123");
  });

  it("overrides the entrypoint so any image behaves the same", () => {
    const args = dockerRunArgs(RUN);
    const at = args.indexOf("--entrypoint");
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe("bash");
  });

  it("forwards --platform only when asked", () => {
    expect(dockerRunArgs(RUN)).not.toContain("--platform");
    const args = dockerRunArgs({ ...RUN, dockerPlatform: "linux/amd64" });
    expect(args[args.indexOf("--platform") + 1]).toBe("linux/amd64");
  });

  it("uses a custom image when given one", () => {
    const args = dockerRunArgs({ ...RUN, image: "my/runner:1" });
    expect(args).toContain("my/runner:1");
    expect(args).not.toContain(DEFAULT_IMAGE);
  });
});
