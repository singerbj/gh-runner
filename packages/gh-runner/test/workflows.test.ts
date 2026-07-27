import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyRunsOnFix,
  classifyTarget,
  hostedRunnerOs,
  inspectWorkflows,
  parseRunsOn,
  parseWorkflow,
  readRunsOnLabels,
} from "../src/workflows.js";
import type { RunsOnTarget } from "../src/workflows.js";

const RUNNER_LABELS = ["self-hosted", "Linux", "X64", "gh-runner", "gh-runner-linux", "my-box"];

describe("parseWorkflow", () => {
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
    expect(parseRunsOn(source, "ci.yml")[0]).toMatchObject({
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

  it("treats a bare runner group as unresolvable rather than hosted", () => {
    const source = ["jobs:", "  build:", "    runs-on:", "      group: my-group"].join("\n");
    expect(parseRunsOn(source, "ci.yml")[0]?.unresolved).toBe("group: my-group");
  });

  it("flags expressions instead of guessing at them", () => {
    const source = ["jobs:", "  build:", "    runs-on: ${{ matrix.os }}"].join("\n");
    const target = parseRunsOn(source, "ci.yml")[0];
    expect(target?.unresolved).toBe("${{ matrix.os }}");
    expect(target?.labels).toEqual([]);
  });

  it("flags a list that mixes literals with an expression", () => {
    const source = ["jobs:", "  build:", "    runs-on: [self-hosted, '${{ matrix.tier }}']"].join(
      "\n",
    );
    expect(parseRunsOn(source, "ci.yml")[0]?.unresolved).toBe("${{ matrix.tier }}");
  });

  // The scanner this replaced could not do any of the following.
  it("resolves anchors and aliases", () => {
    const source = [
      "x-labels: &local [self-hosted, gh-runner]",
      "jobs:",
      "  build:",
      "    runs-on: *local",
    ].join("\n");
    expect(parseRunsOn(source, "ci.yml")[0]?.labels).toEqual(["self-hosted", "gh-runner"]);
  });

  it("ignores a runs-on that isn't a job's own key", () => {
    const source = [
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: |",
      "          echo 'runs-on: [self-hosted, gh-runner]' >> notes.txt",
      "      - name: 'runs-on: not a key'",
      "        run: true",
    ].join("\n");
    const targets = parseRunsOn(source, "ci.yml");
    expect(targets).toHaveLength(1);
    expect(targets[0]?.labels).toEqual(["ubuntu-latest"]);
  });

  it("handles quoted and unusual job ids", () => {
    const source = [
      "jobs:",
      '  "build-2":',
      "    runs-on: ubuntu-latest",
      "  deploy_prod:",
      "    runs-on: [self-hosted, gh-runner]",
    ].join("\n");
    expect(parseRunsOn(source, "ci.yml").map((t) => t.job)).toEqual(["build-2", "deploy_prod"]);
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

  it("reports invalid YAML instead of mis-reading it", () => {
    const result = parseWorkflow("jobs:\n  build:\n   runs-on: [oops\n", "ci.yml");
    expect(result.error).toBeTruthy();
    expect(result.targets).toEqual([]);
  });

  it("returns nothing for a workflow with no jobs", () => {
    expect(parseRunsOn("name: CI\non: push\n", "ci.yml")).toEqual([]);
  });
});

describe("readRunsOnLabels", () => {
  it("normalises every accepted shape", () => {
    expect(readRunsOnLabels("ubuntu-latest").labels).toEqual(["ubuntu-latest"]);
    expect(readRunsOnLabels(["a", "b"]).labels).toEqual(["a", "b"]);
    expect(readRunsOnLabels({ group: "g", labels: ["a"] }).labels).toEqual(["a"]);
    expect(readRunsOnLabels({ labels: "a" }).labels).toEqual(["a"]);
    expect(readRunsOnLabels(undefined).labels).toEqual([]);
  });
});

describe("classifyTarget", () => {
  const target = (labels: string[]): RunsOnTarget => ({
    file: "ci.yml",
    job: "build",
    line: 1,
    endLine: 1,
    labels,
    unresolved: undefined,
    range: [0, 0],
  });

  it("matches when the runner carries every requested label", () => {
    expect(classifyTarget(target(["self-hosted", "gh-runner"]), [RUNNER_LABELS]).kind).toBe(
      "match",
    );
    // GitHub label matching is case-insensitive.
    expect(
      classifyTarget(target(["self-hosted", "linux", "GH-RUNNER"]), [RUNNER_LABELS]).kind,
    ).toBe("match");
  });

  it("reports exactly which labels are missing", () => {
    const verdict = classifyTarget(target(["self-hosted", "gpu", "cuda"]), [RUNNER_LABELS]);
    expect(verdict.kind).toBe("missing-labels");
    if (verdict.kind === "missing-labels") {
      expect(verdict.missing).toEqual(["gpu", "cuda"]);
    }
  });

  it("treats an OS label for another OS as a miss", () => {
    const verdict = classifyTarget(target(["self-hosted", "gh-runner-mac"]), [RUNNER_LABELS]);
    expect(verdict.kind).toBe("missing-labels");
    if (verdict.kind === "missing-labels") {
      expect(verdict.missing).toEqual(["gh-runner-mac"]);
    }
  });

  it("treats anything without self-hosted as GitHub-hosted", () => {
    expect(classifyTarget(target(["ubuntu-latest"]), [RUNNER_LABELS]).kind).toBe("hosted");
  });
});

describe("hostedRunnerOs", () => {
  it("reads the OS out of every image variant GitHub ships", () => {
    expect(hostedRunnerOs(["macos-latest"])).toBe("osx");
    expect(hostedRunnerOs(["macos-14"])).toBe("osx");
    expect(hostedRunnerOs(["macos-13-xlarge"])).toBe("osx");
    expect(hostedRunnerOs(["macOS-latest"])).toBe("osx");
    expect(hostedRunnerOs(["ubuntu-latest"])).toBe("linux");
    expect(hostedRunnerOs(["ubuntu-24.04-arm"])).toBe("linux");
    expect(hostedRunnerOs(["ubuntu-latest-8-cores"])).toBe("linux");
    expect(hostedRunnerOs(["windows-2022"])).toBe("win");
  });

  it("ignores labels that sit alongside the image", () => {
    expect(hostedRunnerOs(["macos-14", "large"])).toBe("osx");
  });

  it("won't guess", () => {
    // A larger runner someone named themselves, or a group — no OS in sight.
    expect(hostedRunnerOs(["our-beefy-box"])).toBeNull();
    expect(hostedRunnerOs([])).toBeNull();
    // "ubuntu-ish" starts with the family name but isn't one of GitHub's.
    expect(hostedRunnerOs(["ubuntufan"])).toBeNull();
    // Two images that disagree: nothing sensible to pick.
    expect(hostedRunnerOs(["macos-14", "ubuntu-latest"])).toBeNull();
  });
});

describe("applyRunsOnFix", () => {
  it("takes a label per job", () => {
    const source = [
      "jobs:",
      "  mac:",
      "    runs-on: macos-14",
      "  linux:",
      "    runs-on: ubuntu-latest",
    ].join("\n");
    const fixed = applyRunsOnFix(source, parseRunsOn(source, "ci.yml"), (target) =>
      target.job === "mac" ? "gh-runner-mac" : "gh-runner-linux",
    );
    expect(fixed).toBe(
      [
        "jobs:",
        "  mac:",
        "    runs-on: [self-hosted, gh-runner-mac]",
        "  linux:",
        "    runs-on: [self-hosted, gh-runner-linux]",
      ].join("\n"),
    );
  });

  it("rewrites an inline value, keeping indentation", () => {
    const source = ["jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps: []"].join("\n");
    expect(applyRunsOnFix(source, parseRunsOn(source, "ci.yml"), "gh-runner")).toBe(
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
    expect(applyRunsOnFix(source, parseRunsOn(source, "ci.yml"), "gh-runner")).toBe(
      ["jobs:", "  build:", "    runs-on: [self-hosted, gh-runner]", "    steps: []"].join("\n"),
    );
  });

  it("preserves comments and every other line", () => {
    const source = [
      "# top comment",
      "name: CI",
      "",
      "jobs:",
      "  build: # the important one",
      "    runs-on: ubuntu-latest # hosted for now",
      "    steps:",
      "      - run: make # build it",
    ].join("\n");
    const fixed = applyRunsOnFix(source, parseRunsOn(source, "ci.yml"), "gh-runner");

    expect(fixed).toContain("# top comment");
    expect(fixed).toContain("  build: # the important one");
    expect(fixed).toContain("    runs-on: [self-hosted, gh-runner] # hosted for now");
    expect(fixed).toContain("      - run: make # build it");
  });

  it("rewrites several jobs in one pass without shifting each other", () => {
    const source = [
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "  b:",
      "    runs-on:",
      "      - macos-14",
      "      - large",
      "  c:",
      "    runs-on: windows-latest",
    ].join("\n");
    const fixed = applyRunsOnFix(source, parseRunsOn(source, "ci.yml"), "gh-runner");
    expect(fixed).toBe(
      [
        "jobs:",
        "  a:",
        "    runs-on: [self-hosted, gh-runner]",
        "  b:",
        "    runs-on: [self-hosted, gh-runner]",
        "  c:",
        "    runs-on: [self-hosted, gh-runner]",
      ].join("\n"),
    );
  });

  it("still parses after being rewritten", () => {
    const source = ["jobs:", "  a:", "    runs-on:", "      - ubuntu-latest", "    steps: []"].join(
      "\n",
    );
    const fixed = applyRunsOnFix(source, parseRunsOn(source, "ci.yml"), "gh-runner-mac");
    const reparsed = parseWorkflow(fixed, "ci.yml");
    expect(reparsed.error).toBeUndefined();
    expect(reparsed.targets[0]?.labels).toEqual(["self-hosted", "gh-runner-mac"]);
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
    const fixed = applyRunsOnFix(source, targets, "gh-runner");
    expect(fixed).toContain("  keep:\n    runs-on: ubuntu-latest");
    expect(fixed).toContain("  move:\n    runs-on: [self-hosted, gh-runner]");
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
    const report = await inspectWorkflows(root, [RUNNER_LABELS]);
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

    const report = await inspectWorkflows(root, [RUNNER_LABELS]);
    expect(report.scanned).toBe(true);
    expect(report.workflowCount).toBe(1);
    expect(report.matches.map((t) => t.job)).toEqual(["local"]);
    expect(report.hosted.map((t) => t.job)).toEqual(["hosted"]);
    expect(report.missing.map((m) => m.target.job)).toEqual(["gpu"]);
    expect(report.unknown.map((t) => t.job)).toEqual(["dynamic"]);
    expect(report.suggestedLabels).toEqual(["cuda"]);
  });

  it("keeps going when one workflow is malformed", async () => {
    await write("broken.yml", "jobs:\n  a:\n   runs-on: [oops\n");
    await write("good.yml", "jobs:\n  b:\n    runs-on: [self-hosted, gh-runner]\n");

    const report = await inspectWorkflows(root, [RUNNER_LABELS]);
    expect(report.unparsed.map((u) => u.file)).toEqual([".github/workflows/broken.yml"]);
    expect(report.matches.map((t) => t.job)).toEqual(["b"]);
  });

  it("reads every workflow file, .yaml included", async () => {
    await write("a.yml", "jobs:\n  one:\n    runs-on: ubuntu-latest");
    await write("b.yaml", "jobs:\n  two:\n    runs-on: [self-hosted, gh-runner]");
    const report = await inspectWorkflows(root, [RUNNER_LABELS]);
    expect(report.workflowCount).toBe(2);
    expect(report.matches.map((t) => t.job)).toEqual(["two"]);
  });
});
