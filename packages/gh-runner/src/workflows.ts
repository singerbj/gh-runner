import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { Pair } from "yaml";
import { HOSTED_PROBE_RUNS_ON, PROBE_RUNS_ON_VAR } from "./constants.js";
import type { RunnerOs } from "./platform.js";

export interface RunsOnTarget {
  /** Workflow file, relative to the repo root. */
  file: string;
  /** Job id the `runs-on` belongs to. */
  job: string;
  /** 1-based line of the `runs-on:` key. */
  line: number;
  /** 1-based last line of the value, equal to `line` for inline forms. */
  endLine: number;
  /** Labels the job asks for. Empty when `unresolved` is set. */
  labels: string[];
  /** Set when the value can't be resolved statically — an expression, or a runner group. */
  unresolved: string | undefined;
  /** Byte range of `runs-on: <value>`, so a rewrite can splice just that. */
  range: [number, number];
  /**
   * True for the probe job a previous fix added. It runs on a GitHub-hosted
   * runner by design — repointing it at a self-hosted one would make it depend
   * on the answer it exists to produce.
   */
  probe: boolean;
}

export type TargetVerdict =
  /** Every label this job asks for is one the runner will have. */
  | { kind: "match"; target: RunsOnTarget }
  /** Self-hosted, but asks for labels the runner won't have. */
  | { kind: "missing-labels"; target: RunsOnTarget; missing: string[] }
  /** Targets GitHub-hosted runners; nothing here will pick it up. */
  | { kind: "hosted"; target: RunsOnTarget }
  /** The value isn't statically knowable, so we don't guess. */
  | { kind: "unknown"; target: RunsOnTarget };

export interface WorkflowReport {
  /** False when the repo has no `.github/workflows` directory at all. */
  scanned: boolean;
  workflowCount: number;
  verdicts: TargetVerdict[];
  /** Jobs this runner will pick up as things stand. */
  matches: RunsOnTarget[];
  /** Self-hosted jobs that want labels this runner won't have. */
  missing: Array<{ target: RunsOnTarget; missing: string[] }>;
  /** GitHub-hosted jobs — the ones the workflow fix would repoint. */
  hosted: RunsOnTarget[];
  /** Jobs whose `runs-on` we can't resolve statically. */
  unknown: RunsOnTarget[];
  /** Files that aren't valid YAML, with the parser's complaint. */
  unparsed: Array<{ file: string; message: string }>;
  /** Labels a near-miss job wants that this runner doesn't have. */
  suggestedLabels: string[];
  /**
   * True when a probe job in this repo picks its own runner from
   * {@link PROBE_RUNS_ON_VAR}, so a session here should publish it.
   */
  selfHostedProbe: boolean;
}

export interface WorkflowParseResult {
  targets: RunsOnTarget[];
  /** Set when the file isn't valid YAML; `targets` is then empty. */
  error: string | undefined;
}

const WORKFLOW_EXTENSIONS = [".yml", ".yaml"];

const isExpression = (value: string): boolean => value.includes("${{");

/** Job id of the probe job the fix inserts. */
export const PROBE_JOB_ID = "gh-runner-check";

/** True for a probe job that picks its own runner from the repo variable. */
export function usesProbeVariable(target: RunsOnTarget): boolean {
  return target.probe && (target.unresolved?.includes(PROBE_RUNS_ON_VAR) ?? false);
}

/** Path of the action the probe job runs, without the `owner/repo` or the ref. */
export const PROBE_ACTION_PATH = "actions/pick-runner";

/** What the probe job resolves for one platform. */
export interface ProbeSpec {
  /** Labels to use when a runner carrying them is online. */
  labels: string[];
  /** The runner to use when none is. Normally the job's original `runs-on`. */
  fallback: string[];
  /**
   * The job's original `runs-on`, recorded only when `fallback` no longer holds
   * it — that is, under `--no-hosted-fallback`, which replaces the fallback with
   * the labels themselves.
   *
   * Overwriting `fallback` in place would otherwise throw away the one record of
   * where the job ran before it was ever repointed, and with it any way back.
   * The action ignores this field; it exists so a later run can restore it.
   */
  hosted?: string[];
}

/**
 * `${{ fromJSON(needs.gh-runner-check.outputs.runners).linux || 'ubuntu-latest' }}`
 *
 * Only the shape this tool writes is recognised. Anything else stays
 * `unresolved`, because guessing at someone's own expression is how a scan
 * starts reporting things that aren't true.
 */
const PROBE_EXPRESSION =
  /fromJSON\(\s*needs\.([A-Za-z0-9_-]+)\.outputs\.runners\s*\)\s*\.\s*([A-Za-z0-9_]+)/;

/** The probe job and output key a generated `runs-on` reads, or null. */
export function readProbeExpression(value: string): { jobId: string; key: string } | null {
  const match = PROBE_EXPRESSION.exec(value);
  if (!match?.[1] || !match[2]) return null;
  return { jobId: match[1], key: match[2] };
}

/**
 * The `|| ...` a generated `runs-on` falls through to — `'ubuntu-latest'` or
 * `fromJSON('["self-hosted","gh-runner-linux"]')` — as a label list.
 *
 * Null when the tail isn't one of those two shapes, which is how a hand-edited
 * expression stays hand-edited: a rewrite that can't read what is there now
 * leaves it alone rather than overwriting it with a guess.
 */
const PROBE_FALLBACK = /\|\|\s*(?:fromJSON\(\s*'((?:[^']|'')*)'\s*\)|'((?:[^']|'')*)')\s*\}\}/;

export function readProbeFallback(value: string): string[] | null {
  const match = PROBE_FALLBACK.exec(value);
  if (!match) return null;

  const [, json, scalar] = match;
  if (scalar !== undefined) return [scalar.replaceAll("''", "'")];
  if (json === undefined) return null;

  try {
    const parsed: unknown = JSON.parse(json.replaceAll("''", "'"));
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? (parsed as string[])
      : null;
  } catch {
    return null;
  }
}

/** Label lists GitHub would treat as the same request. */
function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  return (
    a.length === b.length && a.every((label, i) => label.toLowerCase() === b[i]?.toLowerCase())
  );
}

/**
 * The platforms each probe job in a workflow resolves, read back out of the
 * `targets` input it was generated with.
 *
 * This is what lets a second run of the audit see that a repointed job already
 * asks for this runner: the labels live in the probe's input, not in the
 * `runs-on` expression that consumes them.
 */
export function readProbeTargets(jobs: Record<string, unknown>): Map<string, ProbeSpec> {
  const byJobAndKey = new Map<string, ProbeSpec>();

  for (const [jobId, job] of Object.entries(jobs)) {
    if (!job || typeof job !== "object") continue;
    const steps = (job as { steps?: unknown }).steps;
    if (!Array.isArray(steps)) continue;

    for (const step of steps) {
      if (!step || typeof step !== "object") continue;
      const uses = (step as { uses?: unknown }).uses;
      if (typeof uses !== "string" || !uses.includes(PROBE_ACTION_PATH)) continue;

      const targets = (step as { with?: Record<string, unknown> }).with?.["targets"];
      if (typeof targets !== "string") continue;

      for (const [key, spec] of parseTargetSpecs(targets)) {
        byJobAndKey.set(probeSpecKey(jobId, key), spec);
      }
    }
  }

  return byJobAndKey;
}

/** Job ids can't contain a colon, so this can't be ambiguous. */
function probeSpecKey(jobId: string, key: string): string {
  return `${jobId}::${key}`;
}

/** The `targets` input, parsed. Anything malformed is dropped rather than guessed at. */
export function parseTargetSpecs(raw: string): Map<string, ProbeSpec> {
  const specs = new Map<string, ProbeSpec>();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return specs;
  }
  if (!parsed || typeof parsed !== "object") return specs;

  for (const [key, spec] of Object.entries(parsed as Record<string, unknown>)) {
    if (!spec || typeof spec !== "object") continue;

    const labels = (spec as { labels?: unknown }).labels;
    if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string")) continue;

    const hosted = readLabelList((spec as { hosted?: unknown }).hosted);
    specs.set(key, {
      labels: labels as string[],
      fallback: readLabelList((spec as { fallback?: unknown }).fallback),
      ...(hosted.length > 0 ? { hosted } : {}),
    });
  }

  return specs;
}

/** A `runs-on` in the spec JSON, which is a bare string or a list of them. */
function readLabelList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

/**
 * The image families GitHub hosts, by the OS each one boots.
 *
 * Matching on the family covers every variant of a name — `macos-latest`,
 * `macos-14`, `macos-13-xlarge`, `ubuntu-24.04-arm`, `ubuntu-latest-8-cores` —
 * without a list that goes stale the next time GitHub ships an image.
 */
const HOSTED_IMAGE_FAMILIES: ReadonlyArray<readonly [string, RunnerOs]> = [
  ["macos", "osx"],
  ["ubuntu", "linux"],
  ["windows", "win"],
];

/** The OS a hosted runner image boots, or null if the name isn't one of GitHub's. */
function imageOs(label: string): RunnerOs | null {
  const name = label.trim().toLowerCase();
  for (const [family, os] of HOSTED_IMAGE_FAMILIES) {
    if (name === family || name.startsWith(`${family}-`)) return os;
  }
  return null;
}

/**
 * The OS a GitHub-hosted `runs-on` asks for, or null when nothing in it names a
 * hosted image — a runner-group label, or a larger runner someone named
 * themselves — and when two labels disagree about the OS.
 *
 * This is what makes a macOS build stay a macOS build: the job's own image name
 * says which platform it needs, so the rewrite can pin it to that platform's
 * runner instead of whichever machine happens to be free.
 */
export function hostedRunnerOs(labels: readonly string[]): RunnerOs | null {
  let found: RunnerOs | null = null;

  for (const label of labels) {
    const os = imageOs(label);
    if (os === null) continue;
    if (found !== null && found !== os) return null;
    found = os;
  }

  return found;
}

interface ResolvedLabels {
  labels: string[];
  unresolved: string | undefined;
}

/**
 * Normalises the four shapes `runs-on` accepts — a scalar, a sequence, and the
 * `group:`/`labels:` mapping (with or without labels) — into a label list, or
 * an explanation of why it can't be pinned down.
 */
export function readRunsOnLabels(value: unknown): ResolvedLabels {
  if (typeof value === "string") {
    return isExpression(value)
      ? { labels: [], unresolved: value }
      : { labels: [value], unresolved: undefined };
  }

  if (Array.isArray(value)) {
    const labels: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") {
        return { labels: [], unresolved: JSON.stringify(value) };
      }
      if (isExpression(entry)) {
        return { labels: [], unresolved: entry };
      }
      labels.push(entry);
    }
    return { labels, unresolved: undefined };
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("labels" in record) {
      return readRunsOnLabels(record["labels"]);
    }
    // A bare `group:` matches any runner in that group — nothing to compare
    // labels against, so say so rather than guess.
    if ("group" in record) {
      return { labels: [], unresolved: `group: ${String(record["group"])}` };
    }
  }

  return { labels: [], unresolved: undefined };
}

/**
 * Resolves a `runs-on` this tool generated back to the labels it asks for.
 *
 * The expression itself only names a probe job and an output key; the labels
 * are in that job's `targets` input. Reading them back is what stops a second
 * run from reporting an already-repointed job as still GitHub-hosted.
 */
function resolveRunsOn(
  read: ResolvedLabels,
  probes: ReadonlyMap<string, ProbeSpec>,
): ResolvedLabels {
  if (read.unresolved === undefined) return read;

  const probe = readProbeExpression(read.unresolved);
  if (!probe) return read;

  const spec = probes.get(probeSpecKey(probe.jobId, probe.key));
  if (!spec || spec.labels.length === 0) return read;

  return { labels: spec.labels, unresolved: undefined };
}

/** Reads every `runs-on` in a workflow file, with the position of each. */
export function parseWorkflow(source: string, file: string): WorkflowParseResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter });

  const fatal = doc.errors[0];
  if (fatal) {
    return { targets: [], error: fatal.message };
  }

  const jobsNode = doc.get("jobs", true);
  if (!isMap(jobsNode)) {
    return { targets: [], error: undefined };
  }

  // Values come from a fully resolved copy so anchors and aliases behave the
  // way GitHub sees them; the nodes are only consulted for positions.
  let resolved: Record<string, unknown> = {};
  try {
    const js = doc.toJS({ maxAliasCount: -1 }) as { jobs?: Record<string, unknown> } | null;
    resolved = js?.jobs ?? {};
  } catch {
    resolved = {};
  }

  const targets: RunsOnTarget[] = [];
  const probes = readProbeTargets(resolved);
  const probeJobs = new Set([...probes.keys()].map((key) => key.split("::")[0]));

  for (const jobPair of jobsNode.items as Pair[]) {
    const job = isScalar(jobPair.key) ? String(jobPair.key.value) : String(jobPair.key);
    const jobNode = jobPair.value;
    if (!isMap(jobNode)) continue;

    const runsOn = (jobNode.items as Pair[]).find(
      (pair) => isScalar(pair.key) && pair.key.value === "runs-on",
    );
    if (!runsOn?.key || !runsOn.value) continue;

    const keyRange = (runsOn.key as { range?: [number, number, number] }).range;
    const valueRange = (runsOn.value as { range?: [number, number, number] }).range;
    if (!keyRange || !valueRange) continue;

    const start = keyRange[0];
    // Block values include their trailing newline; keep it out of the range so
    // a rewrite doesn't glue the next key onto ours.
    let end = valueRange[1];
    while (end > start && /\s/.test(source[end - 1] ?? "")) end -= 1;

    const jobValue = resolved[job];
    const runsOnValue =
      jobValue && typeof jobValue === "object"
        ? (jobValue as Record<string, unknown>)["runs-on"]
        : undefined;

    const { labels, unresolved } = resolveRunsOn(readRunsOnLabels(runsOnValue), probes);

    targets.push({
      file,
      job,
      line: lineCounter.linePos(start).line,
      endLine: lineCounter.linePos(end).line,
      labels,
      unresolved,
      range: [start, end],
      probe: probeJobs.has(job),
    });
  }

  return { targets, error: undefined };
}

/** Convenience wrapper around {@link parseWorkflow} that ignores parse errors. */
export function parseRunsOn(source: string, file: string): RunsOnTarget[] {
  return parseWorkflow(source, file).targets;
}

/**
 * GitHub matches a job to a runner when that runner carries *every* label in
 * `runs-on`, case-insensitively.
 *
 * With several runners registered, a job only has to match one of them, so the
 * verdict is the best across all the label sets — and the reported "missing"
 * is the shortest gap, which is the most useful thing to tell someone.
 */
export function classifyTarget(
  target: RunsOnTarget,
  runnerLabelSets: ReadonlyArray<readonly string[]>,
): TargetVerdict {
  if (target.unresolved !== undefined || target.labels.length === 0) {
    return { kind: "unknown", target };
  }

  if (!target.labels.some((label) => label.toLowerCase() === "self-hosted")) {
    return { kind: "hosted", target };
  }

  let best: string[] | undefined;
  for (const labels of runnerLabelSets) {
    const have = new Set(labels.map((label) => label.toLowerCase()));
    const missing = target.labels.filter((label) => !have.has(label.toLowerCase()));
    if (missing.length === 0) return { kind: "match", target };
    if (!best || missing.length < best.length) best = missing;
  }

  return { kind: "missing-labels", target, missing: best ?? target.labels };
}

/** Lists `.github/workflows/*.y{a,}ml` under a repo root, or null if there are none. */
export async function listWorkflowFiles(repoRoot: string): Promise<string[] | null> {
  try {
    const entries = await readdir(join(repoRoot, ".github", "workflows"), {
      withFileTypes: true,
    });
    return entries
      .filter(
        (entry) => entry.isFile() && WORKFLOW_EXTENSIONS.some((ext) => entry.name.endsWith(ext)),
      )
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    return null;
  }
}

/**
 * Reads a repo's workflows and works out which jobs — if any — a runner with
 * `runnerLabels` will actually pick up.
 */
export async function inspectWorkflows(
  repoRoot: string,
  runnerLabelSets: ReadonlyArray<readonly string[]>,
): Promise<WorkflowReport> {
  const files = await listWorkflowFiles(repoRoot);
  if (files === null) {
    return {
      scanned: false,
      workflowCount: 0,
      verdicts: [],
      matches: [],
      missing: [],
      hosted: [],
      unknown: [],
      unparsed: [],
      suggestedLabels: [],
      selfHostedProbe: false,
    };
  }

  const verdicts: TargetVerdict[] = [];
  const unparsed: Array<{ file: string; message: string }> = [];

  for (const name of files) {
    const file = `.github/workflows/${name}`;
    let source: string;
    try {
      source = await readFile(join(repoRoot, ".github", "workflows", name), "utf8");
    } catch {
      continue;
    }

    const { targets, error } = parseWorkflow(source, file);
    if (error) {
      unparsed.push({ file, message: error });
      continue;
    }
    for (const target of targets) {
      verdicts.push(classifyTarget(target, runnerLabelSets));
    }
  }

  const missing = verdicts
    .filter((verdict) => verdict.kind === "missing-labels")
    .map((verdict) => ({ target: verdict.target, missing: verdict.missing }));

  const suggestedLabels: string[] = [];
  for (const entry of missing) {
    for (const label of entry.missing) {
      if (!suggestedLabels.some((existing) => existing.toLowerCase() === label.toLowerCase())) {
        suggestedLabels.push(label);
      }
    }
  }

  return {
    scanned: true,
    workflowCount: files.length,
    verdicts,
    matches: verdicts.filter((v) => v.kind === "match").map((v) => v.target),
    missing,
    // The probe job picks its own runner, and repointing it would point it at
    // the answer it is there to work out. That also keeps it out of `unknown`:
    // its `runs-on` is an expression by design, not one we failed to read.
    hosted: verdicts.filter((v) => v.kind === "hosted" && !v.target.probe).map((v) => v.target),
    unknown: verdicts.filter((v) => v.kind === "unknown" && !v.target.probe).map((v) => v.target),
    unparsed,
    suggestedLabels,
    selfHostedProbe: verdicts.some((v) => usesProbeVariable(v.target)),
  };
}

/** One job's move onto a self-hosted runner, with the hosted runner it keeps as a fallback. */
export interface RunsOnFix {
  target: RunsOnTarget;
  /** Key this job reads out of the probe job's output, e.g. `linux`. */
  key: string;
  /** Labels to prefer while a runner carrying them is online. */
  labels: string[];
}

export interface WorkflowFixPlan {
  /** Job id given to the probe job. */
  jobId: string;
  /** `owner/repo/actions/pick-runner@ref`. */
  actionRef: string;
  fixes: readonly RunsOnFix[];
  /**
   * The probe job's own `runs-on`. Defaults to a GitHub-hosted runner, which
   * always starts; {@link SELF_HOSTED_PROBE_RUNS_ON} keeps the whole workflow
   * off hosted runners at the cost of trusting a variable with no expiry.
   */
  probeRunsOn?: string;
  /**
   * Never name a GitHub-hosted runner: every job falls back to the self-hosted
   * labels it prefers, so it queues until a runner is up instead of resolving to
   * a runner the repo may not be able to start at all.
   *
   * For a repo whose hosted runners are unavailable — a spending limit, a failed
   * payment — falling back to one is not a safety net, because the fallback
   * can't start either.
   */
  noHostedFallback?: boolean;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** The column a byte offset sits at, 0-based. */
function columnOf(source: string, offset: number): number {
  return offset - (source.lastIndexOf("\n", offset - 1) + 1);
}

/** A node's range with trailing whitespace — including the newline — left out. */
function trimEnd(source: string, start: number, end: number): number {
  let stop = end;
  while (stop > start && /\s/.test(source[stop - 1] ?? "")) stop -= 1;
  return stop;
}

function pairFor(node: unknown, key: string): Pair | undefined {
  if (!isMap(node)) return undefined;
  return (node.items as Pair[]).find((pair) => isScalar(pair.key) && pair.key.value === key);
}

/**
 * The `runs-on` a repointed job asks for.
 *
 * The `||` matters: if the probe job produced nothing — a broken input, an API
 * the token couldn't read — the expression falls through rather than resolving
 * to null and failing the run outright. Where it falls through *to* is the
 * plan's fallback mode: the runner the job used before, or, with
 * `noHostedFallback`, the self-hosted labels it would rather queue for.
 */
function runsOnExpression(jobId: string, key: string, fallback: readonly string[]): string {
  const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const value =
    fallback.length === 1
      ? quoted(fallback[0] as string)
      : `fromJSON(${quoted(JSON.stringify(fallback))})`;

  return `runs-on: \${{ fromJSON(needs.${jobId}.outputs.runners).${key} || ${value} }}`;
}

/**
 * Every platform the probe job resolves after this plan is applied — the specs
 * already in the file, plus one per newly repointed job, with each fallback set
 * to what the plan's mode asks for.
 *
 * Built once and used for both halves of the rewrite, so a job's `||` and the
 * probe's `targets` can't disagree about where that job goes when nothing is
 * online.
 */
function planSpecs(
  plan: WorkflowFixPlan,
  existing: ReadonlyMap<string, ProbeSpec>,
): Map<string, ProbeSpec> {
  const merged = new Map<string, ProbeSpec>(existing);
  for (const fix of plan.fixes) {
    if (merged.has(fix.key)) continue;
    merged.set(fix.key, { labels: fix.labels, fallback: fix.target.labels });
  }

  const specs = new Map<string, ProbeSpec>();
  for (const [key, spec] of merged) {
    // Wherever it is recorded, `hosted` is where this job ran before any of
    // this — the fallback until a run replaced it, and the way back after.
    const hosted = spec.hosted ?? spec.fallback;
    specs.set(key, {
      labels: spec.labels,
      fallback: plan.noHostedFallback ? spec.labels : hosted,
      ...(plan.noHostedFallback ? { hosted } : {}),
    });
  }

  return specs;
}

/** Written as-is into the probe job; kept out of the template literals below. */
const PROBE_OUTPUT_EXPRESSION = "${{ steps.pick.outputs.runners }}";

/** One `"key": { "labels": [...], "fallback": ... }` line per platform. */
function targetEntries(specs: ReadonlyMap<string, ProbeSpec>): string[] {
  // A single label is written as a bare string, the way someone would have
  // written the `runs-on` it came from.
  const one = (labels: readonly string[]) => (labels.length === 1 ? labels[0] : labels);

  return [...specs].map(([key, spec]) => {
    const fields = [
      `"labels": ${JSON.stringify(spec.labels)}`,
      `"fallback": ${JSON.stringify(one(spec.fallback))}`,
      ...(spec.hosted ? [`"hosted": ${JSON.stringify(one(spec.hosted))}`] : []),
    ];
    return `${JSON.stringify(key)}: { ${fields.join(", ")} }`;
  });
}

/** The `targets:` input, as the block scalar the probe job carries it in. */
function targetsBlock(entries: readonly string[], indent: number): string {
  const pad = " ".repeat(indent);
  return [
    "targets: |",
    `${pad}  {`,
    ...entries.map(
      (entry, index) => `${pad}    ${entry}${index === entries.length - 1 ? "" : ","}`,
    ),
    `${pad}  }`,
  ].join("\n");
}

/**
 * The probe job's `runs-on:` line.
 *
 * Written as a plain scalar: the expression form carries both quote characters,
 * and it has nothing in it — no leading indicator, no `: `, no ` #` — that
 * makes YAML read it as anything but a string.
 */
function probeRunsOnLine(plan: WorkflowFixPlan): string {
  return `runs-on: ${plan.probeRunsOn ?? HOSTED_PROBE_RUNS_ON}`;
}

/** The probe job, indented to sit alongside the jobs already in the file. */
function probeJobText(plan: WorkflowFixPlan, indent: number, entries: readonly string[]): string {
  const pad = " ".repeat(indent);
  const step = "  ";

  return [
    `${pad}${plan.jobId}:`,
    `${pad}${step}name: Pick runners`,
    `${pad}${step}${probeRunsOnLine(plan)}`,
    `${pad}${step}permissions:`,
    `${pad}${step}${step}contents: read`,
    `${pad}${step}outputs:`,
    `${pad}${step}${step}runners: "${PROBE_OUTPUT_EXPRESSION}"`,
    `${pad}${step}steps:`,
    `${pad}${step}${step}- uses: ${plan.actionRef}`,
    `${pad}${step}${step}  id: pick`,
    `${pad}${step}${step}  with:`,
    `${pad}${step}${step}    ${targetsBlock(entries, indent + step.length * 2 + 4)}`,
    "",
  ].join("\n");
}

/**
 * Adds the probe job to a job's `needs`, in whichever shape it already uses.
 *
 * A job with no `needs` at all gets one inserted immediately above its
 * `runs-on`, which is the only position guaranteed to exist.
 */
function needsEdit(
  source: string,
  jobNode: unknown,
  jobId: string,
  runsOnKeyStart: number,
): Edit | null {
  const indent = columnOf(source, runsOnKeyStart);
  const needs = pairFor(jobNode, "needs");

  if (!needs?.value) {
    return {
      start: runsOnKeyStart,
      end: runsOnKeyStart,
      text: `needs: [${jobId}]\n${" ".repeat(indent)}`,
    };
  }

  const range = (needs.value as { range?: [number, number, number] }).range;
  if (!range) return null;

  const start = range[0];
  const end = trimEnd(source, start, range[1]);
  const text = source.slice(start, end);

  // Already wired up — re-running the fix must not add it twice.
  if (new RegExp(`(^|[^A-Za-z0-9_-])${jobId}([^A-Za-z0-9_-]|$)`).test(text)) return null;

  if (text.startsWith("[")) {
    const close = text.lastIndexOf("]");
    if (close < 0) return null;
    const inner = text.slice(1, close).trim();
    return {
      start,
      end,
      text: `[${inner ? `${inner}, ` : ""}${jobId}]${text.slice(close + 1)}`,
    };
  }

  if (text.includes("\n") || text.startsWith("-")) {
    // A block sequence's value starts at its first `-`, so that dash's own
    // column is the one the new item has to line up with.
    const itemIndent = text.startsWith("-")
      ? columnOf(source, start)
      : (/^([ \t]*)-/m.exec(text)?.[1]?.length ?? indent + 2);
    return { start: end, end, text: `\n${" ".repeat(itemIndent)}- ${jobId}` };
  }

  return { start, end, text: `[${text.trim()}, ${jobId}]` };
}

/**
 * Walks back over the comment lines directly above `lineStart`.
 *
 * Only comment lines: a blank line means whatever is above it was not written
 * about the job below, so the walk stops there.
 */
function commentBlockStart(source: string, lineStart: number): number {
  let start = lineStart;

  while (start > 0) {
    const previousStart = source.lastIndexOf("\n", start - 2) + 1;
    const line = source.slice(previousStart, start - 1).trim();
    if (!line.startsWith("#")) break;
    start = previousStart;
  }

  return start;
}

/** A job id that isn't taken yet, so the probe can never shadow a real job. */
function uniqueJobId(preferred: string, taken: ReadonlyMap<string, unknown>): string {
  if (!taken.has(preferred)) return preferred;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${preferred}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

interface ExistingProbe {
  jobId: string;
  /** Byte range of `targets: <value>`, so a rewrite can splice just that. */
  range: [number, number];
  /** Byte range of the probe job's own `runs-on: <value>`, when it has one. */
  runsOnRange: [number, number] | undefined;
  /** The probe job's current `runs-on`, verbatim. */
  runsOn: string | undefined;
  specs: Map<string, ProbeSpec>;
}

/** Byte range of a job's `runs-on: <value>`, trailing whitespace excluded. */
function runsOnRange(source: string, jobNode: unknown): [number, number] | undefined {
  const pair = pairFor(jobNode, "runs-on");
  const keyRange = (pair?.key as { range?: [number, number, number] } | undefined)?.range;
  const valueRange = (pair?.value as { range?: [number, number, number] } | undefined)?.range;
  if (!keyRange || !valueRange) return undefined;
  return [keyRange[0], trimEnd(source, keyRange[0], valueRange[1])];
}

/** The probe job a previous fix left in this file, if there is one. */
function findProbeJob(source: string, jobs: ReadonlyMap<string, unknown>): ExistingProbe | null {
  for (const [jobId, jobNode] of jobs) {
    const steps = pairFor(jobNode, "steps")?.value;
    if (!isSeq(steps)) continue;

    for (const step of steps.items) {
      const uses = pairFor(step, "uses")?.value;
      if (!isScalar(uses) || !String(uses.value).includes(PROBE_ACTION_PATH)) continue;

      const targets = pairFor(pairFor(step, "with")?.value, "targets");
      const keyRange = (targets?.key as { range?: [number, number, number] } | undefined)?.range;
      const valueRange = (targets?.value as { range?: [number, number, number] } | undefined)
        ?.range;
      if (!keyRange || !valueRange || !isScalar(targets?.value)) continue;

      const own = runsOnRange(source, jobNode);
      return {
        jobId,
        range: [keyRange[0], trimEnd(source, keyRange[0], valueRange[1])],
        runsOnRange: own,
        runsOn: own ? source.slice(own[0], own[1]) : undefined,
        specs: parseTargetSpecs(String(targets.value.value)),
      };
    }
  }

  return null;
}

/**
 * Repoints the given jobs at a runner chosen when the workflow runs, and adds
 * the job that does the choosing.
 *
 * Splices only the bytes it has to — the `runs-on` values, each job's `needs`,
 * and one insertion above the first job — so comments, formatting, and every
 * other line in the file survive untouched.
 *
 * With no jobs to repoint this still has work to do in a file that was fixed
 * before: the probe job already there may pick its own runner differently to
 * what this plan asks for.
 */
export function applyWorkflowFix(source: string, plan: WorkflowFixPlan): string {
  const doc = parseDocument(source);
  const jobsNode = doc.get("jobs", true);
  if (!isMap(jobsNode)) return source;

  const jobNodes = new Map<string, unknown>();
  for (const pair of jobsNode.items as Pair[]) {
    if (isScalar(pair.key)) jobNodes.set(String(pair.key.value), pair.value);
  }

  // A file fixed once already has a probe job; a job added since then joins it
  // rather than getting a second one.
  const existing = findProbeJob(source, jobNodes);
  if (plan.fixes.length === 0 && !existing) return source;

  const jobId = existing?.jobId ?? uniqueJobId(plan.jobId, jobNodes);
  const resolved: WorkflowFixPlan = { ...plan, jobId };

  const specs = planSpecs(resolved, existing?.specs ?? new Map());
  const fallbackFor = (key: string, target: RunsOnTarget) =>
    specs.get(key)?.fallback ?? target.labels;

  const edits: Edit[] = [];

  for (const fix of resolved.fixes) {
    const [start, end] = fix.target.range;
    edits.push({
      start,
      end,
      text: runsOnExpression(jobId, fix.key, fallbackFor(fix.key, fix.target)),
    });

    const needs = needsEdit(source, jobNodes.get(fix.target.job), jobId, start);
    if (needs) edits.push(needs);
  }

  // Jobs an earlier run already repointed. Their labels are right and their
  // `needs` is wired up; what this plan can still disagree with is where they
  // fall through to when nothing is online, which is the half of the rewrite
  // the fallback mode decides. Without this, switching a repo that was fixed
  // once would move the probe job and leave every other job pointed at a
  // hosted runner.
  const repointed = new Set(resolved.fixes.map((fix) => fix.target.job));
  for (const [job, node] of jobNodes) {
    if (job === jobId || repointed.has(job)) continue;

    const range = runsOnRange(source, node);
    if (!range) continue;

    const text = source.slice(range[0], range[1]);
    const probe = readProbeExpression(text);
    if (!probe || probe.jobId !== jobId) continue;

    const spec = specs.get(probe.key);
    const current = readProbeFallback(text);
    if (!spec || !current || sameLabels(current, spec.fallback)) continue;

    edits.push({
      start: range[0],
      end: range[1],
      text: runsOnExpression(jobId, probe.key, spec.fallback),
    });
  }

  const entries = targetEntries(specs);

  if (existing) {
    edits.push({
      start: existing.range[0],
      end: existing.range[1],
      text: targetsBlock(entries, columnOf(source, existing.range[0])),
    });

    // A probe job written by an earlier run picks its runner the way that run
    // was asked to, not the way this one was. Bring it in line, so re-running
    // the fix is how you switch a repo between the two.
    const wanted = probeRunsOnLine(resolved);
    if (existing.runsOnRange && existing.runsOn !== wanted) {
      edits.push({ start: existing.runsOnRange[0], end: existing.runsOnRange[1], text: wanted });
    }
  } else {
    // The probe job goes in above the first job, so the file reads in the order
    // it runs. An empty `jobs:` map has no first job to anchor to; there is also
    // nothing to fix in one, so `plan.fixes` would be empty.
    const first = (jobsNode.items as Pair[])[0]?.key as { range?: [number, number, number] };
    if (first?.range) {
      const indent = columnOf(source, first.range[0]);
      // Insert at the start of that job's line, not at its key: the indentation
      // already on the line belongs to the job, and the generated text brings
      // its own. Comments sitting directly above it were written about that
      // job, so go above them too rather than leaving them explaining ours.
      const anchor = commentBlockStart(source, first.range[0] - indent);
      edits.push({
        start: anchor,
        end: anchor,
        text: `${probeJobText(resolved, indent, entries)}\n`,
      });
    }
  }

  // Back to front, so an earlier splice can't shift a later edit's offsets.
  // Insertions at the same offset keep the order they were queued in.
  const ordered = edits
    .map((edit, index) => ({ edit, index }))
    .toSorted((a, b) => b.edit.start - a.edit.start || a.index - b.index);

  let output = source;
  for (const { edit } of ordered) {
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  }

  return output;
}
