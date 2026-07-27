import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE,
  archForDockerPlatform,
  assertDockerAvailable,
  containerScript,
  dockerRunArgs,
  dockerRunEnv,
  runInDocker,
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

  it("forwards the token and labels by name, keeping them out of argv", () => {
    const args = dockerRunArgs(RUN);
    for (const name of ["GHR_URL", "GHR_TOKEN", "GHR_NAME", "GHR_LABELS"]) {
      expect(args[args.indexOf(name) - 1]).toBe("-e");
    }

    // argv is world-readable through `ps` and /proc, so a live registration
    // token must not appear anywhere in it — nor in the script, nor as a value.
    expect(args.join(" ")).not.toContain("REG123");
    expect(args).not.toContain("GHR_TOKEN=REG123");
    expect(args[args.length - 1] ?? "").not.toContain("REG123");
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

describe("dockerRunEnv", () => {
  it("carries every value the container reads by name", () => {
    const env = dockerRunEnv(RUN, { PATH: "/usr/bin" });
    expect(env["GHR_TOKEN"]).toBe("REG123");
    expect(env["GHR_URL"]).toBe("https://github.com/octocat/thing");
    expect(env["GHR_NAME"]).toBe("my-box-docker-123");
    expect(env["GHR_LABELS"]).toBe("gh-runner,gh-runner-linux,my-box");
    // The docker client still needs the rest of the environment to find itself.
    expect(env["PATH"]).toBe("/usr/bin");
  });
});

describe("runInDocker", () => {
  it("spawns docker with the token in its environment and not its argv", async () => {
    let seen: { args: readonly string[]; env: NodeJS.ProcessEnv | undefined } | undefined;
    const runner: CommandRunner = (_command, args, options) => {
      seen = { args, env: options?.env };
      return Promise.resolve(ok());
    };

    await runInDocker(runner, RUN, undefined, undefined, { PATH: "/usr/bin" });

    expect(seen?.args.join(" ")).not.toContain("REG123");
    expect(seen?.env?.["GHR_TOKEN"]).toBe("REG123");
  });
});
