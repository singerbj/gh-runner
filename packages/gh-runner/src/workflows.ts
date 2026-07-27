import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface RunsOnTarget {
  /** Workflow file, relative to the repo root. */
  file: string;
  /** Job id the `runs-on` belongs to, best-effort. */
  job: string;
  /** 1-based line of the `runs-on:` key. */
  line: number;
  /** 1-based last line of the value, equal to `line` for inline forms. */
  endLine: number;
  /** Labels the job asks for. Empty when `expression` is set. */
  labels: string[];
  /** The raw value, when it contains a `${{ ... }}` we can't evaluate. */
  expression: string | undefined;
}

export type TargetVerdict =
  /** Every label this job asks for is one the runner will have. */
  | { kind: "match"; target: RunsOnTarget }
  /** Self-hosted, but asks for labels the runner won't have. */
  | { kind: "missing-labels"; target: RunsOnTarget; missing: string[] }
  /** Targets GitHub-hosted runners; nothing here will pick it up. */
  | { kind: "hosted"; target: RunsOnTarget }
  /** `runs-on` is an expression, so we can't tell statically. */
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
  /** GitHub-hosted jobs — the ones `--fix-workflows` would repoint. */
  hosted: RunsOnTarget[];
  /** Jobs whose `runs-on` is an expression we can't evaluate. */
  unknown: RunsOnTarget[];
  /** Labels a near-miss job wants that this runner doesn't have. */
  suggestedLabels: string[];
}

const WORKFLOW_EXTENSIONS = [".yml", ".yaml"];

/** Strips a trailing `# comment` that isn't inside quotes. */
function stripComment(value: string): string {
  let quote: string | undefined;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || value[i - 1] === " ")) {
      return value.slice(0, i);
    }
  }
  return value;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === '"' || first === "'") && trimmed.endsWith(first)) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function splitInlineList(value: string): string[] {
  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map(unquote)
    .filter((label) => label.length > 0);
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Extracts every `runs-on` in a workflow file.
 *
 * Deliberately a scanner rather than a YAML parse: `runs-on` only takes a
 * handful of shapes, this keeps the package dependency-free, and line numbers
 * survive so warnings and rewrites can point at the exact spot.
 */
export function parseRunsOn(source: string, file: string): RunsOnTarget[] {
  const lines = source.split("\n");
  const targets: RunsOnTarget[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const match = /^(\s*)runs-on:(.*)$/.exec(line);
    if (!match) continue;

    const indent = (match[1] ?? "").length;
    const inline = stripComment(match[2] ?? "").trim();

    // The nearest shallower `key:` above us is the job id.
    let job = "?";
    for (let j = i - 1; j >= 0; j -= 1) {
      const candidate = lines[j] ?? "";
      if (!candidate.trim() || candidate.trim().startsWith("#")) continue;
      if (indentOf(candidate) >= indent) continue;
      const keyMatch = /^\s*([A-Za-z_][\w.-]*):\s*$/.exec(candidate);
      if (keyMatch?.[1]) job = keyMatch[1];
      break;
    }

    const base = { file, job, line: i + 1 };

    if (inline.includes("${{")) {
      targets.push({ ...base, endLine: i + 1, labels: [], expression: inline });
      continue;
    }
    if (inline.startsWith("[")) {
      targets.push({
        ...base,
        endLine: i + 1,
        labels: splitInlineList(inline),
        expression: undefined,
      });
      continue;
    }
    if (inline) {
      targets.push({ ...base, endLine: i + 1, labels: [unquote(inline)], expression: undefined });
      continue;
    }

    // Block form: either a `- item` sequence or a `group:`/`labels:` mapping.
    const labels: string[] = [];
    let expression: string | undefined;
    let endLine = i + 1;

    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? "";
      if (!next.trim() || next.trim().startsWith("#")) continue;
      if (indentOf(next) <= indent) break;
      endLine = j + 1;

      const body = stripComment(next).trim();
      if (body.startsWith("- ")) {
        const value = unquote(body.slice(2));
        if (value.includes("${{")) expression = value;
        else if (value) labels.push(value);
        continue;
      }

      const labelsMatch = /^labels:\s*(.*)$/.exec(body);
      if (labelsMatch) {
        const value = (labelsMatch[1] ?? "").trim();
        if (value.includes("${{")) expression = value;
        else if (value.startsWith("[")) labels.push(...splitInlineList(value));
        else if (value) labels.push(unquote(value));
      }
      // `group:` names a runner group, not a label — nothing to match against.
    }

    targets.push({ ...base, endLine, labels, expression });
  }

  return targets;
}

/**
 * GitHub matches a job to a runner when the runner carries *every* label in
 * `runs-on`, case-insensitively.
 */
export function classifyTarget(
  target: RunsOnTarget,
  runnerLabels: readonly string[],
): TargetVerdict {
  if (target.expression !== undefined) {
    return { kind: "unknown", target };
  }

  const have = new Set(runnerLabels.map((label) => label.toLowerCase()));
  if (!target.labels.some((label) => label.toLowerCase() === "self-hosted")) {
    return { kind: "hosted", target };
  }

  const missing = target.labels.filter((label) => !have.has(label.toLowerCase()));
  return missing.length === 0
    ? { kind: "match", target }
    : { kind: "missing-labels", target, missing };
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
  runnerLabels: readonly string[],
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
      suggestedLabels: [],
    };
  }

  const verdicts: TargetVerdict[] = [];
  for (const name of files) {
    let source: string;
    try {
      source = await readFile(join(repoRoot, ".github", "workflows", name), "utf8");
    } catch {
      continue;
    }
    for (const target of parseRunsOn(source, `.github/workflows/${name}`)) {
      verdicts.push(classifyTarget(target, runnerLabels));
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
    suggestedLabels,
  };
}

/**
 * Rewrites the given `runs-on` values to `[self-hosted, <label>]`, preserving
 * indentation and collapsing block-form values onto the one line.
 */
export function applyRunsOnFix(
  source: string,
  targets: readonly RunsOnTarget[],
  label: string,
): string {
  if (targets.length === 0) return source;

  const lines = source.split("\n");
  const byStart = new Map(targets.map((target) => [target.line, target]));
  const output: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const target = byStart.get(i + 1);
    if (!target) {
      output.push(lines[i] ?? "");
      continue;
    }
    const line = lines[i] ?? "";
    const indent = " ".repeat(indentOf(line));
    output.push(`${indent}runs-on: [self-hosted, ${label}]`);
    // Skip the remaining lines of a block-form value.
    i += target.endLine - target.line;
  }

  return output.join("\n");
}
