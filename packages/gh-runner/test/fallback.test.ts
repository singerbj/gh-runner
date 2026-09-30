import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { fallbackRunsOn, labelForVariable, runnerVariable } from "../src/constants.js";
import {
  PROBE_JOB_ID,
  applyWorkflowFix,
  classifyTarget,
  hostedRunnerOs,
  parseRunsOn,
  parseWorkflow,
  readFallback,
} from "../src/workflows.js";
import type { RunsOnTarget, WorkflowFixPlan } from "../src/workflows.js";
import { LEGACY_NO_HOSTED_FALLBACK, LEGACY_PROBE } from "./support/legacy.js";
import { evaluate } from "./support/mock-github.js";

const LABELS = {
  osx: "gh-runner-mac",
  linux: "gh-runner-linux",
  win: "gh-runner-windows",
} as const;

/** Mirrors what proposeWorkflowFix builds: one fix per GitHub-hosted job. */
const planFor = (source: string): WorkflowFixPlan => ({
  fixes: parseRunsOn(source, "ci.yml")
    .filter((target) => classifyTarget(target, []).kind === "hosted" && !target.probe)
    .map((target) => ({ target, label: LABELS[hostedRunnerOs(target.labels) ?? "linux"] })),
});

const runsOnOf = (source: string, job: string): unknown =>
  (parse(source) as { jobs: Record<string, { "runs-on"?: unknown }> }).jobs[job]?.["runs-on"];

const scope = (vars: Record<string, string> = {}) => ({ vars, needs: new Map() });

describe("runnerVariable", () => {
  it("names one variable per label, the way someone would write it by hand", () => {
    expect(runnerVariable("gh-runner")).toBe("GH_RUNNER");
    expect(runnerVariable("gh-runner-linux")).toBe("GH_RUNNER_LINUX");
    expect(runnerVariable("gh-runner-mac")).toBe("GH_RUNNER_MAC");
    expect(runnerVariable("gh-runner-windows")).toBe("GH_RUNNER_WINDOWS");
  });

  it("keeps a custom label from colliding with one of ours", () => {
    expect(runnerVariable("cuda")).toBe("GH_RUNNER_LABEL_CUDA");
    expect(runnerVariable("big-box.2")).toBe("GH_RUNNER_LABEL_BIG_BOX_2");
  });

  it("maps back to the label", () => {
    for (const label of ["gh-runner", "gh-runner-linux", "gh-runner-mac", "cuda", "big-box"]) {
      expect(labelForVariable(runnerVariable(label))).toBe(label);
    }
    expect(labelForVariable("SOMETHING_ELSE")).toBeNull();
  });
});

describe("fallbackRunsOn", () => {
  it("is as short as a runs-on that switches can be", () => {
    expect(fallbackRunsOn("gh-runner-linux", ["ubuntu-latest"])).toBe(
      "${{ vars.GH_RUNNER_LINUX || 'ubuntu-latest' }}",
    );
  });

  it("means the hosted runner with the variable unset, and the label with it set", () => {
    const value = fallbackRunsOn("gh-runner-mac", ["macos-14"]);
    expect(evaluate(value, scope())).toBe("macos-14");
    expect(evaluate(value, scope({ GH_RUNNER_MAC: "" }))).toBe("macos-14");
    expect(evaluate(value, scope({ GH_RUNNER_MAC: "gh-runner-mac" }))).toBe("gh-runner-mac");
  });

  it("keeps a multi-label hosted runner a list, and reads it back", () => {
    const value = fallbackRunsOn("gh-runner", ["ubuntu-latest", "gpu"]);
    expect(evaluate(value, scope())).toEqual(["ubuntu-latest", "gpu"]);
    expect(readFallback(value)).toEqual({
      variable: "GH_RUNNER",
      label: "gh-runner",
      hosted: ["ubuntu-latest", "gpu"],
    });
  });

  it("round-trips, quotes and all", () => {
    expect(readFallback(fallbackRunsOn("gh-runner-linux", ["o'hare"]))?.hosted).toEqual(["o'hare"]);
  });

  it("leaves expressions it didn't write alone", () => {
    expect(readFallback("${{ vars.SOMETHING || 'ubuntu-latest' }}")).toBeNull();
    expect(readFallback("${{ matrix.os || vars.GH_RUNNER_LINUX || 'ubuntu-latest' }}")).toBeNull();
    expect(readFallback("${{ vars.GH_RUNNER_LINUX }}")).toBeNull();
  });
});

describe("applyWorkflowFix", () => {
  const source = [
    "name: CI",
    "on: [push]",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: make",
    "  # macOS only, for the signing step",
    "  mac:",
    "    needs: build",
    "    runs-on: [macos-14]",
    "    steps:",
    "      - run: make mac",
    "  local:",
    "    runs-on: [self-hosted, gh-runner]",
    "",
  ].join("\n");

  it("rewrites runs-on in place, and nothing else", () => {
    const fixed = applyWorkflowFix(source, planFor(source));

    expect(fixed).toBe(
      source
        .replace(
          "runs-on: ubuntu-latest",
          "runs-on: ${{ vars.GH_RUNNER_LINUX || 'ubuntu-latest' }}",
        )
        .replace("runs-on: [macos-14]", "runs-on: ${{ vars.GH_RUNNER_MAC || 'macos-14' }}"),
    );
  });

  it("writes YAML whose runs-on GitHub reads as the expression", () => {
    const fixed = applyWorkflowFix(source, planFor(source));
    expect(evaluate(runsOnOf(fixed, "build") as string, scope())).toBe("ubuntu-latest");
    expect(
      evaluate(runsOnOf(fixed, "mac") as string, scope({ GH_RUNNER_MAC: "gh-runner-mac" })),
    ).toBe("gh-runner-mac");
  });

  it("reads back as a job this runner takes, with the hosted runner it keeps", () => {
    const fixed = applyWorkflowFix(source, planFor(source));
    const build = parseWorkflow(fixed, "ci.yml").targets.find((t) => t.job === "build");

    expect(build?.fallback).toEqual({
      variable: "GH_RUNNER_LINUX",
      label: "gh-runner-linux",
      hosted: ["ubuntu-latest"],
    });
    expect(
      classifyTarget(build as RunsOnTarget, [["self-hosted", "gh-runner", "gh-runner-linux"]]).kind,
    ).toBe("match");
  });

  it("is idempotent", () => {
    const once = applyWorkflowFix(source, planFor(source));
    expect(applyWorkflowFix(once, planFor(once))).toBe(once);
  });

  it("converts an older probe-mode file, and takes the probe job out", () => {
    const fixed = applyWorkflowFix(LEGACY_PROBE, planFor(LEGACY_PROBE));

    expect(fixed).toBe(
      [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  build:",
        "    runs-on: ${{ vars.GH_RUNNER_LINUX || 'ubuntu-latest' }}",
        "    steps:",
        "      - run: make",
        "  test-mac:",
        "    needs: [build]",
        "    runs-on: ${{ vars.GH_RUNNER_MAC || 'macos-14' }}",
        "    steps:",
        "      - run: make test",
        "",
      ].join("\n"),
    );
  });

  it("restores the hosted runner a --no-hosted-fallback file only kept under `hosted`", () => {
    const fixed = applyWorkflowFix(LEGACY_NO_HOSTED_FALLBACK, planFor(LEGACY_NO_HOSTED_FALLBACK));
    expect(fixed).toBe(
      ["jobs:", "  build:", "    runs-on: ${{ vars.GH_RUNNER_LINUX || 'ubuntu-latest' }}", ""].join(
        "\n",
      ),
    );
  });

  it("takes the probe out of needs in every shape it can be written", () => {
    const withShapes = LEGACY_PROBE.replace(
      "    needs: [gh-runner-check]\n",
      "    needs: gh-runner-check\n",
    ).replace(
      "    needs: [build, gh-runner-check]\n",
      "    needs:\n      - build\n      - gh-runner-check\n",
    );
    const doc = parse(applyWorkflowFix(withShapes, planFor(withShapes))) as {
      jobs: Record<string, { needs?: unknown }>;
    };

    expect(Object.keys(doc.jobs)).toEqual(["build", "test-mac"]);
    expect(doc.jobs["build"]?.needs).toBeUndefined();
    expect(doc.jobs["test-mac"]?.needs).toEqual(["build"]);
  });

  it("leaves keys after `jobs:` alone when the probe is the last job", () => {
    const last = [
      "jobs:",
      "  build:",
      "    needs: gh-runner-check",
      "    runs-on: ${{ fromJSON(needs.gh-runner-check.outputs.runners).linux || 'ubuntu-latest' }}",
      ...LEGACY_PROBE.slice(
        LEGACY_PROBE.indexOf("  gh-runner-check:"),
        LEGACY_PROBE.indexOf("\n\n  build:"),
      ).split("\n"),
      "on: [push]",
      "",
    ].join("\n");
    const fixed = applyWorkflowFix(last, planFor(last));
    const doc = parse(fixed) as { on: unknown; jobs: Record<string, unknown> };

    expect(doc.on).toEqual(["push"]);
    expect(Object.keys(doc.jobs)).toEqual(["build"]);
  });

  it("keeps the probe job while something it didn't write still reads it", () => {
    const withStep = LEGACY_PROBE.replace(
      "      - run: make test",
      "      - run: echo ${{ needs.gh-runner-check.outputs.runners }}",
    );
    const fixed = applyWorkflowFix(withStep, planFor(withStep));

    expect(fixed).toContain(`${PROBE_JOB_ID}:`);
    expect(runsOnOf(fixed, "build")).toBe("${{ vars.GH_RUNNER_LINUX || 'ubuntu-latest' }}");
    // Still allowed to read it.
    expect(fixed).toContain("    needs: [build, gh-runner-check]\n");
  });
});
