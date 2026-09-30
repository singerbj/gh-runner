import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { Pair } from "yaml";
import { fallbackRunsOn, labelForVariable } from "./constants.js";
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
   * True for the probe job an older version of the fix added. Nothing writes one
   * any more; it is recognised so a re-run of the fix can take it back out.
   */
  probe: boolean;
  /**
   * Set for a job the workflow fix rewrote: the variable it reads, the label
   * that variable moves it to, and the hosted runner it uses otherwise.
   * `labels` then holds the label, so the audit counts the job as one this
   * runner can take.
   */
  fallback?: RunnerFallback;
}

/** Both sides of a `${{ vars.GH_RUNNER_LINUX || 'ubuntu-latest' }}`. */
export interface RunnerFallback {
  variable: string;
  label: string;
  hosted: string[];
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
   * Workflow files with a job that reads a runner variable — the runs worth
   * re-running once a variable is set, since only those will move.
   */
  fallbackFiles: string[];
  /** True when an older fix's probe job is still in a workflow, and the fix would remove it. */
  legacyProbe: boolean;
}

export interface WorkflowParseResult {
  targets: RunsOnTarget[];
  /** Set when the file isn't valid YAML; `targets` is then empty. */
  error: string | undefined;
}

const WORKFLOW_EXTENSIONS = [".yml", ".yaml"];

const isExpression = (value: string): boolean => value.includes("${{");

/** Job id of the probe job older versions of the fix inserted. */
export const PROBE_JOB_ID = "gh-runner-check";

/** Path of the action that probe job ran, without the `owner/repo` or the ref. */
export const PROBE_ACTION_PATH = "actions/pick-runner";

/** What an old probe job resolved for one platform, read back out of its `targets` input. */
export interface ProbeSpec {
  /** Labels it used while a runner carrying them was online. */
  labels: string[];
  /** The runner it used when none was. */
  fallback: string[];
  /** The job's original `runs-on`, when `fallback` no longer held it (`--no-hosted-fallback`). */
  hosted?: string[];
}

/**
 * `${{ vars.GH_RUNNER_LINUX || 'ubuntu-latest' }}`, as {@link fallbackRunsOn}
 * writes it — anchored at both ends, so an expression someone wrote by hand
 * stays theirs.
 */
const FALLBACK_EXPRESSION =
  /^\$\{\{\s*vars\.(GH_RUNNER[A-Z0-9_]*)\s*\|\|\s*(?:fromJSON\(\s*'((?:[^']|'')*)'\s*\)|'((?:[^']|'')*)')\s*\}\}$/;

/** Both sides of a `runs-on` the workflow fix wrote, or null for anything else. */
export function readFallback(value: string): RunnerFallback | null {
  const match = FALLBACK_EXPRESSION.exec(value.trim());
  const variable = match?.[1];
  const label = variable ? labelForVariable(variable) : null;
  if (!match || !variable || !label) return null;

  let hosted: string[] | null = null;
  if (match[3] !== undefined) {
    hosted = [match[3].replaceAll("''", "'")];
  } else {
    try {
      const parsed: unknown = JSON.parse((match[2] ?? "").replaceAll("''", "'"));
      hosted =
        Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
          ? (parsed as string[])
          : null;
    } catch {
      hosted = null;
    }
  }
  if (!hosted || hosted.length === 0 || hosted[0] === "") return null;

  return { variable, label, hosted };
}

/**
 * `${{ fromJSON(needs.gh-runner-check.outputs.runners).linux || 'ubuntu-latest' }}`
 * — how an older fix wrote a job's `runs-on`.
 */
const PROBE_EXPRESSION =
  /fromJSON\(\s*needs\.([A-Za-z0-9_-]+)\.outputs\.runners\s*\)\s*\.\s*([A-Za-z0-9_]+)/;

/** The probe job and output key an older generated `runs-on` reads, or null. */
export function readProbeExpression(value: string): { jobId: string; key: string } | null {
  const match = PROBE_EXPRESSION.exec(value);
  if (!match?.[1] || !match[2]) return null;
  return { jobId: match[1], key: match[2] };
}

/** The platforms each old probe job in a workflow resolved, keyed `jobId::key`. */
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

/** An old probe's `targets` input, parsed. Anything malformed is dropped rather than guessed at. */
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

/** The one label that says which runner a label list wants — whatever isn't `self-hosted`. */
function preferredLabel(labels: readonly string[]): string | undefined {
  return labels.findLast((label) => label.toLowerCase() !== "self-hosted");
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
  fallback?: RunnerFallback;
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
 * Resolves a `runs-on` this tool generated back to the label it can move to —
 * which is what stops a second run from reporting an already-fixed job as
 * still GitHub-hosted. An older probe expression resolves through its probe's
 * `targets` input.
 */
function resolveRunsOn(
  read: ResolvedLabels,
  probes: ReadonlyMap<string, ProbeSpec>,
): ResolvedLabels {
  if (read.unresolved === undefined) return read;

  const fallback = readFallback(read.unresolved);
  if (fallback) return { labels: [fallback.label], unresolved: undefined, fallback };

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

    const range = runsOnRange(source, jobNode);
    if (!range) continue;
    const [start, end] = range;

    const jobValue = resolved[job];
    const runsOnValue =
      jobValue && typeof jobValue === "object"
        ? (jobValue as Record<string, unknown>)["runs-on"]
        : undefined;

    const { labels, unresolved, fallback } = resolveRunsOn(readRunsOnLabels(runsOnValue), probes);

    targets.push({
      file,
      job,
      line: lineCounter.linePos(start).line,
      endLine: lineCounter.linePos(end).line,
      labels,
      unresolved,
      range: [start, end],
      probe: probeJobs.has(job),
      ...(fallback ? { fallback } : {}),
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

  // A fixed job asks for one of our labels, which GitHub-hosted runners never
  // carry — so it's self-hosted, even without the `self-hosted` label.
  const selfHosted =
    target.fallback !== undefined ||
    target.labels.some((label) => label.toLowerCase() === "self-hosted");
  if (!selfHosted) {
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
      fallbackFiles: [],
      legacyProbe: false,
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
    // An old probe job isn't one to repoint — the fix removes it instead.
    hosted: verdicts.filter((v) => v.kind === "hosted" && !v.target.probe).map((v) => v.target),
    unknown: verdicts.filter((v) => v.kind === "unknown" && !v.target.probe).map((v) => v.target),
    unparsed,
    suggestedLabels,
    fallbackFiles: [
      ...new Set(verdicts.filter((v) => v.target.fallback).map((v) => v.target.file)),
    ],
    legacyProbe: verdicts.some((v) => v.target.probe),
  };
}

/** One job to move onto the variable, with the label it moves to. */
export interface RunsOnFix {
  /** The job, whose current `labels` are the hosted runner it keeps. */
  target: RunsOnTarget;
  /** The gh-runner label it switches to when GitHub-hosted runners can't start. */
  label: string;
}

export interface WorkflowFixPlan {
  fixes: readonly RunsOnFix[];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** A node's range with trailing whitespace — including the newline — left out. */
function trimEnd(source: string, start: number, end: number): number {
  let stop = end;
  while (stop > start && /\s/.test(source[stop - 1] ?? "")) stop -= 1;
  return stop;
}

/** Offset of the first character on the line containing `offset`. */
function lineStartOf(source: string, offset: number): number {
  return source.lastIndexOf("\n", offset - 1) + 1;
}

/** Offset just past the newline ending the line containing `offset`, or the end of the file. */
function lineEndOf(source: string, offset: number): number {
  const newline = source.indexOf("\n", offset);
  return newline < 0 ? source.length : newline + 1;
}

type Range = { range?: [number, number, number] };

function pairFor(node: unknown, key: string): Pair | undefined {
  if (!isMap(node)) return undefined;
  return (node.items as Pair[]).find((pair) => isScalar(pair.key) && pair.key.value === key);
}

/** Byte range of a job's `runs-on: <value>`, trailing whitespace excluded. */
function runsOnRange(source: string, jobNode: unknown): [number, number] | undefined {
  const pair = pairFor(jobNode, "runs-on");
  const keyRange = (pair?.key as Range | undefined)?.range;
  const valueRange = (pair?.value as Range | undefined)?.range;
  if (!keyRange || !valueRange) return undefined;
  return [keyRange[0], trimEnd(source, keyRange[0], valueRange[1])];
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

/** Removes a whole `key: value` pair from a mapping, lines and all. */
function removePair(source: string, pair: Pair): Edit | null {
  const keyRange = (pair.key as Range | undefined)?.range;
  const valueRange = (pair.value as Range | undefined)?.range;
  if (!keyRange || !valueRange) return null;
  const start = lineStartOf(source, keyRange[0]);
  return { start, end: lineEndOf(source, trimEnd(source, start, valueRange[1])), text: "" };
}

/** True when a job lists `jobId` in its `needs`, in any shape. */
function needsMentions(jobNode: unknown, jobId: string): boolean {
  const value = pairFor(jobNode, "needs")?.value;
  if (isScalar(value)) return String(value.value) === jobId;
  if (isSeq(value)) {
    return value.items.some((item) => isScalar(item) && String(item.value) === jobId);
  }
  return false;
}

/**
 * Takes `jobId` back out of a job's `needs`, in whichever shape it is written:
 * `[a, probe]`, a bare `probe`, or a block sequence. When it was the only
 * dependency the whole `needs:` goes, rather than leaving an empty one behind.
 */
function needsRemoval(source: string, jobNode: unknown, jobId: string): Edit | null {
  const needs = pairFor(jobNode, "needs");
  if (!needs?.value) return null;

  const value = needs.value;
  if (isScalar(value)) {
    return String(value.value) === jobId ? removePair(source, needs) : null;
  }
  if (!isSeq(value)) return null;

  const items = value.items;
  const index = items.findIndex((item) => isScalar(item) && String(item.value) === jobId);
  if (index < 0) return null;
  if (items.length === 1) return removePair(source, needs);

  const range = (value as Range).range;
  if (!range) return null;
  const start = range[0];
  const end = trimEnd(source, start, range[1]);

  if (source.slice(start, end).startsWith("[")) {
    const rest = items
      .filter((_, i) => i !== index)
      .map((item) => {
        const itemRange = (item as Range).range;
        return itemRange ? source.slice(itemRange[0], itemRange[1]) : "";
      });
    return { start, end, text: `[${rest.join(", ")}]` };
  }

  // A block sequence: drop the `- probe` line.
  const itemRange = (items[index] as Range).range;
  if (!itemRange) return null;
  return {
    start: lineStartOf(source, itemRange[0]),
    end: lineEndOf(source, itemRange[0]),
    text: "",
  };
}

interface ExistingProbe {
  jobId: string;
  specs: Map<string, ProbeSpec>;
}

/** The probe job an older fix left in this file, if there is one. */
function findProbeJob(jobs: ReadonlyMap<string, unknown>): ExistingProbe | null {
  for (const [jobId, jobNode] of jobs) {
    const steps = pairFor(jobNode, "steps")?.value;
    if (!isSeq(steps)) continue;

    for (const step of steps.items) {
      const uses = pairFor(step, "uses")?.value;
      if (!isScalar(uses) || !String(uses.value).includes(PROBE_ACTION_PATH)) continue;

      const targets = pairFor(pairFor(step, "with")?.value, "targets")?.value;
      if (!isScalar(targets)) continue;
      return { jobId, specs: parseTargetSpecs(String(targets.value)) };
    }
  }

  return null;
}

/**
 * Moves the given jobs onto a runner variable: each keeps the GitHub-hosted
 * runner it has, unless `gh-runner` has set the variable for its label.
 *
 * Splices only the bytes it has to — each `runs-on` value — so comments,
 * formatting, and every other line in the file survive untouched.
 *
 * A file an older version fixed with a probe job is converted too: every job
 * that read the probe reads its variable instead, with the labels and hosted
 * runner the probe's `targets` input recorded, and the probe job is removed
 * once nothing is left that depends on it. A job that `needs` the probe for a
 * reason this tool didn't write keeps it, and keeps working.
 */
export function applyWorkflowFix(source: string, plan: WorkflowFixPlan): string {
  const doc = parseDocument(source);
  const jobsNode = doc.get("jobs", true);
  if (!isMap(jobsNode)) return source;

  const jobPairs = jobsNode.items as Pair[];
  const jobNodes = new Map<string, unknown>();
  for (const pair of jobPairs) {
    if (isScalar(pair.key)) jobNodes.set(String(pair.key.value), pair.value);
  }

  const edits: Edit[] = plan.fixes.map(({ target, label }) => ({
    start: target.range[0],
    end: target.range[1],
    text: `runs-on: ${fallbackRunsOn(label, target.labels)}`,
  }));

  const probe = findProbeJob(jobNodes);
  if (probe) edits.push(...probeRemoval(source, plan, jobPairs, jobNodes, probe));

  return applyEdits(source, edits);
}

function probeRemoval(
  source: string,
  plan: WorkflowFixPlan,
  jobPairs: readonly Pair[],
  jobNodes: ReadonlyMap<string, unknown>,
  probe: ExistingProbe,
): Edit[] {
  const edits: Edit[] = [];
  // Only applied once the probe job itself goes: while it stays, a job that
  // still reads it somewhere else needs it in `needs` to be allowed to.
  const needsEdits: Edit[] = [];
  const repointed = new Set(plan.fixes.map((fix) => fix.target.job));
  let converted = 0;
  let keepProbe = false;

  for (const [job, node] of jobNodes) {
    if (job === probe.jobId || repointed.has(job)) continue;

    const range = runsOnRange(source, node);
    const reads = readProbeExpression(range ? source.slice(range[0], range[1]) : "");
    const readsProbe = reads?.jobId === probe.jobId;
    if (!readsProbe && !needsMentions(node, probe.jobId)) continue;

    const spec = readsProbe && reads ? probe.specs.get(reads.key) : undefined;
    const label = spec ? preferredLabel(spec.labels) : undefined;
    const hosted = spec ? (spec.hosted ?? spec.fallback) : [];
    // `--no-hosted-fallback` wrote the labels as the fallback, and kept the
    // hosted runner under `hosted`. Without that there's no hosted runner to
    // go back to, and nothing safe to write.
    const hostedIsReal =
      hosted.length > 0 && !hosted.some((l) => l.toLowerCase() === "self-hosted");
    if (!range || !label || !hostedIsReal) {
      keepProbe = true;
      continue;
    }

    edits.push({
      start: range[0],
      end: range[1],
      text: `runs-on: ${fallbackRunsOn(label, hosted)}`,
    });
    converted += 1;

    const needs = needsRemoval(source, node, probe.jobId);
    if (needs) needsEdits.push(needs);
  }

  // Anything else still reading the probe's output — a step, an `if:` — would
  // break without it. Every `runs-on` converted above accounts for one mention.
  const mentions = source.split(`needs.${probe.jobId}.`).length - 1;
  if (keepProbe || mentions > converted) return edits;

  const index = jobPairs.findIndex((pair) => isScalar(pair.key) && pair.key.value === probe.jobId);
  const probePair = jobPairs[index];
  const keyRange = (probePair?.key as Range | undefined)?.range;
  if (!probePair || !keyRange) return edits;

  const start = lineStartOf(source, keyRange[0]);
  const nextKey = (jobPairs[index + 1]?.key as Range | undefined)?.range;
  const valueRange = (probePair.value as Range | undefined)?.range;
  // Up to the next job's own comments, which were written about that job; the
  // last job ends with its own value, not with the file — `jobs:` needn't be
  // the last key in it.
  const end = nextKey
    ? commentBlockStart(source, lineStartOf(source, nextKey[0]))
    : lineEndOf(source, trimEnd(source, start, valueRange?.[1] ?? source.length));
  edits.push(...needsEdits, { start, end, text: "" });

  return edits;
}

/** Splices every edit in, back to front, so an earlier one can't shift a later one's offsets. */
function applyEdits(source: string, edits: readonly Edit[]): string {
  const ordered = edits
    .map((edit, index) => ({ edit, index }))
    .toSorted((a, b) => b.edit.start - a.edit.start || a.index - b.index);

  let output = source;
  for (const { edit } of ordered) {
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  }

  return output;
}
