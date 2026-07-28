import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROBE_JOB_ID,
  applyWorkflowFix,
  classifyTarget,
  hostedRunnerOs,
  inspectWorkflows,
  parseRunsOn,
  parseWorkflow,
  readRunsOnLabels,
} from "../src/workflows.js";
import type { RunsOnTarget, WorkflowFixPlan } from "../src/workflows.js";

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
    probe: false,
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

describe("applyWorkflowFix", () => {
  const ACTION = "singerbj/gh-runner/actions/pick-runner@abc123";
  const KEYS = { osx: "mac", linux: "linux", win: "windows" } as const;
  const LABELS = {
    osx: "gh-runner-mac",
    linux: "gh-runner-linux",
    win: "gh-runner-windows",
  } as const;

  /** Mirrors what proposeWorkflowFix builds: one fix per hosted job. */
  const planFor = (source: string, only?: readonly string[]): WorkflowFixPlan => ({
    jobId: PROBE_JOB_ID,
    actionRef: ACTION,
    fixes: parseRunsOn(source, "ci.yml")
      .filter((target) => target.labels.length > 0 && (!only || only.includes(target.job)))
      .map((target) => {
        const os = hostedRunnerOs(target.labels) ?? "linux";
        return { target, key: KEYS[os], labels: ["self-hosted", LABELS[os]] };
      }),
  });

  it("prefers each platform's own runner and keeps the hosted one as the fallback", () => {
    const source = [
      "jobs:",
      "  mac:",
      "    runs-on: macos-14",
      "  linux:",
      "    runs-on: ubuntu-latest",
    ].join("\n");
    const fixed = applyWorkflowFix(source, planFor(source));

    expect(fixed).toContain(
      "runs-on: ${{ fromJSON(needs.gh-runner-check.outputs.runners).mac || 'macos-14' }}",
    );
    expect(fixed).toContain(
      "runs-on: ${{ fromJSON(needs.gh-runner-check.outputs.runners).linux || 'ubuntu-latest' }}",
    );
    expect(fixed).toContain('"mac": { "labels": ["self-hosted","gh-runner-mac"]');
    expect(fixed).toContain('"fallback": "ubuntu-latest" }');
  });

  it("adds the probe job once, above the jobs that read it", () => {
    const source = ["jobs:", "  a:", "    runs-on: ubuntu-latest"].join("\n");
    const fixed = applyWorkflowFix(source, planFor(source));

    expect(fixed.indexOf("gh-runner-check:")).toBeLessThan(fixed.indexOf("  a:"));
    expect(fixed.match(/gh-runner-check:/g)).toHaveLength(1);
    expect(fixed).toContain(`- uses: ${ACTION}`);
    expect(fixed).toContain("contents: read");
  });

  it("adds needs in whichever shape the job already uses", () => {
    const source = [
      "jobs:",
      "  none:",
      "    runs-on: ubuntu-latest",
      "  scalar:",
      "    needs: none",
      "    runs-on: ubuntu-latest",
      "  flow:",
      "    needs: [none, scalar]",
      "    runs-on: ubuntu-latest",
      "  block:",
      "    needs:",
      "      - none",
      "    runs-on: ubuntu-latest",
    ].join("\n");
    const fixed = applyWorkflowFix(source, planFor(source));

    expect(fixed).toContain("  none:\n    needs: [gh-runner-check]\n    runs-on:");
    expect(fixed).toContain("needs: [none, gh-runner-check]");
    expect(fixed).toContain("needs: [none, scalar, gh-runner-check]");
    expect(fixed).toContain("needs:\n      - none\n      - gh-runner-check");
  });

  it("still parses, and reads back as asking for this runner", () => {
    const source = ["jobs:", "  a:", "    runs-on:", "      - ubuntu-latest", "    steps: []"].join(
      "\n",
    );
    const fixed = applyWorkflowFix(source, planFor(source));
    const reparsed = parseWorkflow(fixed, "ci.yml");

    expect(reparsed.error).toBeUndefined();
    const job = reparsed.targets.find((target) => target.job === "a");
    expect(job?.labels).toEqual(["self-hosted", "gh-runner-linux"]);
    expect(job?.unresolved).toBeUndefined();
    expect(classifyTarget(job as RunsOnTarget, [RUNNER_LABELS]).kind).toBe("match");
  });

  it("joins a job to the probe that is already there instead of adding a second", () => {
    const source = ["jobs:", "  a:", "    runs-on: ubuntu-latest"].join("\n");
    const once = applyWorkflowFix(source, planFor(source));

    // A macOS job added after the first fix.
    const grown = `${once}\n  mac:\n    runs-on: macos-14\n`;
    const twice = applyWorkflowFix(grown, planFor(grown, ["mac"]));

    expect(twice.match(/gh-runner-check:/g)).toHaveLength(1);
    expect(twice).toContain('"linux": { "labels": ["self-hosted","gh-runner-linux"]');
    expect(twice).toContain('"mac": { "labels": ["self-hosted","gh-runner-mac"]');
    expect(parseWorkflow(twice, "ci.yml").error).toBeUndefined();
  });

  it("goes above the comment written about the first job, not below it", () => {
    const source = [
      "jobs:",
      "  # this one is expensive",
      "  a:",
      "    runs-on: ubuntu-latest",
    ].join("\n");
    const fixed = applyWorkflowFix(source, planFor(source));

    expect(fixed).toContain("  # this one is expensive\n  a:");
    expect(fixed.indexOf("gh-runner-check:")).toBeLessThan(
      fixed.indexOf("# this one is expensive"),
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
    const fixed = applyWorkflowFix(source, planFor(source));

    expect(fixed).toContain("# top comment");
    expect(fixed).toContain("  build: # the important one");
    expect(fixed).toContain("}} # hosted for now");
    expect(fixed).toContain("      - run: make # build it");
  });

  it("leaves untargeted jobs alone", () => {
    const source = [
      "jobs:",
      "  keep:",
      "    runs-on: ubuntu-latest",
      "  move:",
      "    runs-on: ubuntu-latest",
    ].join("\n");
    const fixed = applyWorkflowFix(source, planFor(source, ["move"]));

    expect(fixed).toContain("  keep:\n    runs-on: ubuntu-latest");
    expect(fixed).toContain("  move:\n    needs: [gh-runner-check]");
  });

  it("does not shadow a job that already owns the name", () => {
    const source = [
      "jobs:",
      "  gh-runner-check:",
      "    runs-on: ubuntu-latest",
      "    steps: []",
      "  a:",
      "    runs-on: ubuntu-latest",
    ].join("\n");
    const fixed = applyWorkflowFix(source, planFor(source, ["a"]));

    expect(fixed).toContain("gh-runner-check-2:");
    expect(fixed).toContain("needs: [gh-runner-check-2]");
    expect(parseWorkflow(fixed, "ci.yml").error).toBeUndefined();
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
