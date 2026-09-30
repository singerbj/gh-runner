import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HOSTED_BLOCKED_VAR, hostedFirstRunsOn } from "../src/constants.js";
import {
  PROBE_JOB_ID,
  applyWorkflowFix,
  classifyTarget,
  hostedRunnerOs,
  parseRunsOn,
  parseWorkflow,
  readHostedFirst,
} from "../src/workflows.js";
import type { RunsOnTarget, WorkflowFixPlan } from "../src/workflows.js";
import { evaluate } from "./support/mock-github.js";

const ACTION = "singerbj/gh-runner/actions/pick-runner@abc123";
const KEYS = { osx: "mac", linux: "linux", win: "windows" } as const;
const LABELS = {
  osx: "gh-runner-mac",
  linux: "gh-runner-linux",
  win: "gh-runner-windows",
} as const;

/** Mirrors what proposeWorkflowFix builds: one fix per statically known job. */
const planFor = (
  source: string,
  extra: Partial<WorkflowFixPlan> = {},
  pick: (target: RunsOnTarget) => boolean = (target) =>
    target.labels.length > 0 &&
    !target.probe &&
    !target.labels.some((label) => label === "self-hosted"),
): WorkflowFixPlan => ({
  jobId: PROBE_JOB_ID,
  actionRef: ACTION,
  fixes: parseRunsOn(source, "ci.yml")
    .filter(pick)
    .map((target) => {
      const os = hostedRunnerOs(target.labels) ?? "linux";
      return { target, key: KEYS[os], labels: ["self-hosted", LABELS[os]] };
    }),
  ...extra,
});

const runsOnOf = (source: string, job: string): unknown =>
  (parse(source) as { jobs: Record<string, { "runs-on"?: unknown }> }).jobs[job]?.["runs-on"];

describe("hostedFirstRunsOn", () => {
  it("reads the variable, and names both runners in full", () => {
    expect(hostedFirstRunsOn(["self-hosted", "gh-runner-linux"], ["ubuntu-latest"])).toBe(
      `\${{ vars.${HOSTED_BLOCKED_VAR} && fromJSON('["self-hosted","gh-runner-linux"]') || 'ubuntu-latest' }}`,
    );
  });

  it("means the hosted runner with the variable unset, and the labels with it set", () => {
    const value = hostedFirstRunsOn(["self-hosted", "gh-runner-mac"], ["macos-14"]);
    const scope = (vars: Record<string, string>) => ({ vars, needs: new Map() });

    expect(evaluate(value, scope({}))).toBe("macos-14");
    expect(evaluate(value, scope({ [HOSTED_BLOCKED_VAR]: "" }))).toBe("macos-14");
    expect(evaluate(value, scope({ [HOSTED_BLOCKED_VAR]: "2026-09-30T00:00:00.000Z" }))).toEqual([
      "self-hosted",
      "gh-runner-mac",
    ]);
  });

  it("keeps a multi-label hosted runner a list", () => {
    const value = hostedFirstRunsOn(["self-hosted", "gh-runner"], ["ubuntu-latest", "big"]);
    expect(evaluate(value, { vars: {}, needs: new Map() })).toEqual(["ubuntu-latest", "big"]);
    expect(readHostedFirst(value)).toEqual({
      labels: ["self-hosted", "gh-runner"],
      hosted: ["ubuntu-latest", "big"],
    });
  });

  it("round-trips, quotes and all", () => {
    const value = hostedFirstRunsOn(["self-hosted", "it's"], ["o'hare"]);
    expect(readHostedFirst(value)).toEqual({ labels: ["self-hosted", "it's"], hosted: ["o'hare"] });
  });

  it("leaves expressions it didn't write alone", () => {
    expect(readHostedFirst("${{ vars.SOMETHING && 'a' || 'b' }}")).toBeNull();
    expect(
      readHostedFirst(`\${{ vars.${HOSTED_BLOCKED_VAR} && 'self-hosted' || 'ubuntu-latest' }}`),
    ).toBeNull();
    expect(
      readHostedFirst(
        `\${{ matrix.x || vars.${HOSTED_BLOCKED_VAR} && fromJSON('["a"]') || 'ubuntu-latest' }}`,
      ),
    ).toBeNull();
  });
});

describe("applyWorkflowFix with hostedFirst", () => {
  const source = [
    "name: CI",
    "on: [push]",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: make",
    "  mac:",
    "    needs: build",
    "    runs-on: [macos-14]",
    "    steps:",
    "      - run: make mac",
    "",
  ].join("\n");

  it("rewrites runs-on in place, and adds no probe job and no needs", () => {
    const fixed = applyWorkflowFix(source, planFor(source, { hostedFirst: true }));

    expect(fixed).not.toContain(PROBE_JOB_ID);
    expect(fixed).not.toContain("pick-runner");
    expect(fixed).toContain(
      `runs-on: ${hostedFirstRunsOn(["self-hosted", "gh-runner-linux"], ["ubuntu-latest"])}`,
    );
    expect(fixed).toContain(
      `runs-on: ${hostedFirstRunsOn(["self-hosted", "gh-runner-mac"], ["macos-14"])}`,
    );
    // The only needs left is the one that was there.
    expect(fixed.match(/needs:/g)).toHaveLength(1);
    expect(fixed).toContain("    needs: build\n");
    // Everything else is byte-for-byte what it was.
    expect(fixed.replaceAll(/runs-on: .*\n/g, "")).toBe(source.replaceAll(/runs-on: .*\n/g, ""));
  });

  it("writes YAML whose runs-on GitHub reads as the expression", () => {
    const fixed = applyWorkflowFix(source, planFor(source, { hostedFirst: true }));
    const value = runsOnOf(fixed, "build");
    expect(typeof value).toBe("string");
    expect(evaluate(value as string, { vars: {}, needs: new Map() })).toBe("ubuntu-latest");
  });

  it("counts a rewritten job as one this runner takes, and says the repo is hosted-first", () => {
    const fixed = applyWorkflowFix(source, planFor(source, { hostedFirst: true }));
    const { targets } = parseWorkflow(fixed, "ci.yml");
    const build = targets.find((target) => target.job === "build") as RunsOnTarget;

    expect(build.hostedFirst).toEqual({
      labels: ["self-hosted", "gh-runner-linux"],
      hosted: ["ubuntu-latest"],
    });
    expect(classifyTarget(build, [["self-hosted", "gh-runner", "gh-runner-linux"]]).kind).toBe(
      "match",
    );
  });

  it("is idempotent", () => {
    const once = applyWorkflowFix(source, planFor(source, { hostedFirst: true }));
    expect(applyWorkflowFix(once, planFor(once, { hostedFirst: true }))).toBe(once);
  });

  it("converts a probe-mode file and drops the probe job once nothing needs it", () => {
    const probeMode = applyWorkflowFix(source, planFor(source));
    expect(probeMode).toContain(`${PROBE_JOB_ID}:`);

    const fixed = applyWorkflowFix(probeMode, planFor(probeMode, { hostedFirst: true }));

    expect(fixed).not.toContain(PROBE_JOB_ID);
    expect(fixed).not.toContain("pick-runner");
    // `needs: build` became `[build, probe]` and is now `[build]`: the same
    // thing to GitHub, if not the same bytes.
    expect(fixed.replace("needs: [build]", "needs: build")).toBe(
      applyWorkflowFix(source, planFor(source, { hostedFirst: true })),
    );
  });

  it("converts a --no-hosted-fallback file back to the hosted runner each job came from", () => {
    const closed = applyWorkflowFix(
      source,
      planFor(source, { noHostedFallback: true, probeRunsOn: "[self-hosted, gh-runner]" }),
    );
    const fixed = applyWorkflowFix(closed, planFor(closed, { hostedFirst: true }));

    expect(runsOnOf(fixed, "mac")).toBe(
      hostedFirstRunsOn(["self-hosted", "gh-runner-mac"], ["macos-14"]),
    );
    expect(fixed).not.toContain(PROBE_JOB_ID);
  });

  it("takes the probe out of needs in every shape it can be written", () => {
    const probeMode = [
      "jobs:",
      `  ${PROBE_JOB_ID}:`,
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - uses: ${ACTION}`,
      "        id: pick",
      "        with:",
      "          targets: |",
      `            { "linux": { "labels": ["self-hosted","gh-runner-linux"], "fallback": "ubuntu-latest" } }`,
      "",
      "  lint:",
      "    runs-on: ubuntu-latest",
      "  flow:",
      `    needs: [lint, ${PROBE_JOB_ID}]`,
      `    runs-on: \${{ fromJSON(needs.${PROBE_JOB_ID}.outputs.runners).linux || 'ubuntu-latest' }}`,
      "  block:",
      "    needs:",
      "      - lint",
      `      - ${PROBE_JOB_ID}`,
      `    runs-on: \${{ fromJSON(needs.${PROBE_JOB_ID}.outputs.runners).linux || 'ubuntu-latest' }}`,
      "  bare:",
      `    needs: ${PROBE_JOB_ID}`,
      `    runs-on: \${{ fromJSON(needs.${PROBE_JOB_ID}.outputs.runners).linux || 'ubuntu-latest' }}`,
      "    steps:",
      "      - run: echo",
      "",
      "on: [push]",
      "",
    ].join("\n");

    const fixed = applyWorkflowFix(
      probeMode,
      planFor(probeMode, { hostedFirst: true }, () => false),
    );
    const doc = parse(fixed) as {
      on: unknown;
      jobs: Record<string, { needs?: unknown; "runs-on"?: unknown }>;
    };
    const expected = hostedFirstRunsOn(["self-hosted", "gh-runner-linux"], ["ubuntu-latest"]);

    expect(Object.keys(doc.jobs)).toEqual(["lint", "flow", "block", "bare"]);
    expect(doc.jobs["flow"]).toEqual({ needs: ["lint"], "runs-on": expected });
    expect(doc.jobs["block"]).toEqual({ needs: ["lint"], "runs-on": expected });
    expect(doc.jobs["bare"]?.needs).toBeUndefined();
    expect(doc.jobs["bare"]?.["runs-on"]).toBe(expected);
    // A key after `jobs:` survives the probe job's removal.
    expect(doc.on).toEqual(["push"]);
  });

  it("keeps the probe job while something it didn't write still reads it", () => {
    const probeMode = applyWorkflowFix(source, planFor(source));
    const withStep = probeMode.replace(
      "      - run: make mac",
      `      - run: echo \${{ needs.${PROBE_JOB_ID}.outputs.runners }}`,
    );
    const fixed = applyWorkflowFix(withStep, planFor(withStep, { hostedFirst: true }));

    expect(fixed).toContain(`${PROBE_JOB_ID}:`);
    expect(fixed).toContain(`needs.${PROBE_JOB_ID}.outputs.runners }}`);
  });

  it("goes back to a probe the other way, keeping the hosted runner as the fallback", () => {
    const hostedFirst = applyWorkflowFix(source, planFor(source, { hostedFirst: true }));
    // What proposeWorkflowFix does: hosted-first jobs are hosted jobs again, on
    // the runner written in their own runs-on.
    const plan = planFor(hostedFirst, {}, () => false);
    plan.fixes = parseRunsOn(hostedFirst, "ci.yml")
      .filter((target) => target.hostedFirst)
      .map((target) => {
        const labels = target.hostedFirst?.labels ?? [];
        const os = hostedRunnerOs(target.hostedFirst?.hosted ?? []) ?? "linux";
        return {
          target: { ...target, labels: target.hostedFirst?.hosted ?? [] },
          key: KEYS[os],
          labels,
        };
      });

    const back = applyWorkflowFix(hostedFirst, plan);
    expect(back).toBe(applyWorkflowFix(source, planFor(source)));
  });
});
