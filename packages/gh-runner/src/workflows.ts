import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { LineCounter, isMap, isScalar, parseDocument } from "yaml";
import type { Pair } from "yaml";

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
}

export interface WorkflowParseResult {
  targets: RunsOnTarget[];
  /** Set when the file isn't valid YAML; `targets` is then empty. */
  error: string | undefined;
}

const WORKFLOW_EXTENSIONS = [".yml", ".yaml"];

const isExpression = (value: string): boolean => value.includes("${{");

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

    const { labels, unresolved } = readRunsOnLabels(runsOnValue);

    targets.push({
      file,
      job,
      line: lineCounter.linePos(start).line,
      endLine: lineCounter.linePos(end).line,
      labels,
      unresolved,
      range: [start, end],
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
      .sort();
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
    hosted: verdicts.filter((v) => v.kind === "hosted").map((v) => v.target),
    unknown: verdicts.filter((v) => v.kind === "unknown").map((v) => v.target),
    unparsed,
    suggestedLabels,
  };
}

/**
 * Rewrites the given `runs-on` values to `[self-hosted, <label>]`.
 *
 * Splices only the bytes each value occupies, so comments, formatting, and
 * every other line in the file survive untouched.
 */
export function applyRunsOnFix(
  source: string,
  targets: readonly RunsOnTarget[],
  label: string,
): string {
  const ordered = [...targets].sort((a, b) => b.range[0] - a.range[0]);
  let output = source;

  for (const target of ordered) {
    const [start, end] = target.range;
    output = `${output.slice(0, start)}runs-on: [self-hosted, ${label}]${output.slice(end)}`;
  }

  return output;
}
