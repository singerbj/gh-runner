import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRunsOnFix, classifyTarget, inspectWorkflows, parseRunsOn } from "../src/workflows.js";

const RUNNER_LABELS = ["self-hosted", "Linux", "X64", "gh-runner", "my-box"];

describe("parseRunsOn", () => {
  it("reads the inline list form", () => {
    const targets = parseRunsOn(
      ["jobs:", "  build:", "    runs-on: [self-hosted, gh-runner]"].join("\n"),
      "ci.yml",
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      job: "build",
      line: 3,
      endLine: 3,
      labels: ["self-hosted", "gh-runner"],
    });
  });

  it("reads a plain scalar, quotes and trailing comments included", () => {
    const targets = parseRunsOn(
      ["jobs:", "  test:", '    runs-on: "ubuntu-latest" # hosted'].join("\n"),
      "ci.yml",
    );
    expect(targets[0]?.labels).toEqual(["ubuntu-latest"]);
    expect(targets[0]?.job).toBe("test");
  });

  it("reads the block sequence form", () => {
    const source = [
      "jobs:",
      "  build:",
      "    runs-on:",
      "      - self-hosted",
      "      - gh-runner",
      "    steps:",
      "      - run: make",
    ].join("\n");
    const targets = parseRunsOn(source, "ci.yml");
    expect(targets[0]).toMatchObject({
      labels: ["self-hosted", "gh-runner"],
      line: 3,
      endLine: 5,
    });
  });

  it("reads the group/labels mapping form", () => {
    const source = [
      "jobs:",
      "  build:",
      "    runs-on:",
      "      group: my-group",
      "      labels: [self-hosted, gh-runner]",
    ].join("\n");
    expect(parseRunsOn(source, "ci.yml")[0]?.labels).toEqual(["self-hosted", "gh-runner"]);
  });

  it("flags expressions instead of guessing at them", () => {
    const source = ["jobs:", "  build:", "    runs-on: ${{ matrix.os }}"].join("\n");
    const target = parseRunsOn(source, "ci.yml")[0];
    expect(target?.expression).toBe("${{ matrix.os }}");
    expect(target?.labels).toEqual([]);
  });

  it("attributes each runs-on to its own job", () => {
    const source = [
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    strategy:",
      "      matrix:",
      "        node: [20, 22]",
      "  deploy:",
      "    needs: build",
      "    runs-on: [self-hosted, gh-runner]",
    ].join("\n");
    expect(parseRunsOn(source, "ci.yml").map((t) => [t.job, t.labels])).toEqual([
      ["build", ["ubuntu-latest"]],
      ["deploy", ["self-hosted", "gh-runner"]],
    ]);
  });
});

describe("classifyTarget", () => {
  const target = (labels: string[]) => ({
    file: "ci.yml",
    job: "build",
    line: 1,
    endLine: 1,
    labels,
    expression: undefined,
  });

  it("matches when the runner carries every requested label", () => {
    expect(classifyTarget(target(["self-hosted", "gh-runner"]), RUNNER_LABELS).kind).toBe("match");
    // GitHub label matching is case-insensitive.
    expect(classifyTarget(target(["self-hosted", "linux", "GH-RUNNER"]), RUNNER_LABELS).kind).toBe(
      "match",
    );
  });

  it("reports exactly which labels are missing", () => {
    const verdict = classifyTarget(target(["self-hosted", "gpu", "cuda"]), RUNNER_LABELS);
    expect(verdict.kind).toBe("missing-labels");
    if (verdict.kind === "missing-labels") {
      expect(verdict.missing).toEqual(["gpu", "cuda"]);
    }
  });

  it("treats anything without self-hosted as GitHub-hosted", () => {
    expect(classifyTarget(target(["ubuntu-latest"]), RUNNER_LABELS).kind).toBe("hosted");
  });
});

describe("applyRunsOnFix", () => {
  it("rewrites an inline value, keeping indentation", () => {
    const source = ["jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps: []"].join("\n");
    const targets = parseRunsOn(source, "ci.yml");
    expect(applyRunsOnFix(source, targets, "gh-runner")).toBe(
      ["jobs:", "  build:", "    runs-on: [self-hosted, gh-runner]", "    steps: []"].join("\n"),
    );
  });

  it("collapses a block-form value onto one line", () => {
    const source = [
      "jobs:",
      "  build:",
      "    runs-on:",
      "      - ubuntu-latest",
      "    steps: []",
    ].join("\n");
    const targets = parseRunsOn(source, "ci.yml");
    expect(applyRunsOnFix(source, targets, "gh-runner")).toBe(
      ["jobs:", "  build:", "    runs-on: [self-hosted, gh-runner]", "    steps: []"].join("\n"),
    );
  });

  it("leaves untargeted jobs alone", () => {
    const source = [
      "jobs:",
      "  keep:",
      "    runs-on: ubuntu-latest",
      "  move:",
      "    runs-on: ubuntu-latest",
    ].join("\n");
    const targets = parseRunsOn(source, "ci.yml").filter((t) => t.job === "move");
    expect(applyRunsOnFix(source, targets, "gh-runner")).toContain("  keep:\n    runs-on: ubuntu");
    expect(applyRunsOnFix(source, targets, "gh-runner")).toContain(
      "  move:\n    runs-on: [self-hosted, gh-runner]",
    );
  });
});

describe("inspectWorkflows", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gh-runner-wf-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const write = async (name: string, body: string) => {
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await writeFile(join(root, ".github", "workflows", name), body);
  };

  it("reports no scan when the repo has no workflows", async () => {
    const report = await inspectWorkflows(root, RUNNER_LABELS);
    expect(report.scanned).toBe(false);
    expect(report.workflowCount).toBe(0);
  });

  it("sorts jobs into matches, near misses, and hosted", async () => {
    await write(
      "ci.yml",
      [
        "jobs:",
        "  hosted:",
        "    runs-on: ubuntu-latest",
        "  local:",
        "    runs-on: [self-hosted, gh-runner]",
        "  gpu:",
        "    runs-on: [self-hosted, cuda]",
        "  dynamic:",
        "    runs-on: ${{ matrix.os }}",
      ].join("\n"),
    );

    const report = await inspectWorkflows(root, RUNNER_LABELS);
    expect(report.scanned).toBe(true);
    expect(report.workflowCount).toBe(1);
    expect(report.matches.map((t) => t.job)).toEqual(["local"]);
    expect(report.hosted.map((t) => t.job)).toEqual(["hosted"]);
    expect(report.missing.map((m) => m.target.job)).toEqual(["gpu"]);
    expect(report.unknown.map((t) => t.job)).toEqual(["dynamic"]);
    expect(report.suggestedLabels).toEqual(["cuda"]);
  });

  it("reads every workflow file, .yaml included", async () => {
    await write("a.yml", "jobs:\n  one:\n    runs-on: ubuntu-latest");
    await write("b.yaml", "jobs:\n  two:\n    runs-on: [self-hosted, gh-runner]");
    const report = await inspectWorkflows(root, RUNNER_LABELS);
    expect(report.workflowCount).toBe(2);
    expect(report.matches.map((t) => t.job)).toEqual(["two"]);
  });
});
