/**
 * A stand-in for the slice of GitHub that `--hosted-first` depends on: the
 * Actions REST API gh-runner reads and writes, and — separately — the
 * scheduler that turns a workflow's `runs-on` into a job that ran, queued, or
 * was refused for billing reasons.
 *
 * The scheduler evaluates `runs-on` expressions with its own small evaluator,
 * not with anything from `src/`. The point of the simulation is to check that
 * what the fix writes means what we think it means, and a parser shared with
 * the code under test would agree with it by construction.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { parse } from "yaml";
import type { CommandRunner, ExecResult } from "../../src/exec.js";

export const BILLING_MESSAGE =
  "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings";

export interface MockStep {
  name: string;
  status: "completed";
  conclusion: "success";
  number: number;
}

export interface MockJob {
  id: number;
  name: string;
  status: "queued" | "completed";
  conclusion: "success" | "failure" | "skipped" | null;
  labels: string[];
  runner_name: string | null;
  steps: MockStep[];
  started_at: string | null;
  completed_at: string | null;
  annotations: string[];
  outputs: Record<string, string>;
}

export interface MockRun {
  id: number;
  name: string;
  run_attempt: number;
  created_at: string;
  status: "queued" | "completed";
  conclusion: "success" | "failure" | null;
  head_repository: { full_name: string };
  path: string;
  /** Parsed workflow, so a re-run evaluates `runs-on` again against the vars of the moment. */
  workflow: WorkflowJobs;
  jobs: MockJob[];
}

type WorkflowJobs = Record<string, { "runs-on"?: unknown; needs?: string | string[] }>;

interface Response {
  status: number;
  body: unknown;
}

export interface MockGitHubOptions {
  repo?: string;
  /** Epoch millis the mock starts at. */
  now?: number;
}

export class MockGitHub {
  readonly repo: string;
  now: number;
  /** Whether GitHub will start hosted runners for this repo. */
  hostedAvailable = true;
  /** Labels of self-hosted runners currently online. */
  online: string[][] = [];
  variables = new Map<string, string>();
  runs: MockRun[] = [];
  reruns: number[] = [];
  /** Requests this returns true for fail with a 500, as an outage would. */
  failing: ((method: string, path: string) => boolean) | null = null;
  /** Every request, as `METHOD path`. */
  log: string[] = [];
  /** What a successful probe job outputs, keyed by output name. */
  probeOutputs: Record<string, string> = { runners: "{}" };

  private nextId = 1000;

  constructor(options: MockGitHubOptions = {}) {
    this.repo = options.repo ?? "octocat/thing";
    this.now = options.now ?? Date.UTC(2026, 8, 15, 12);
  }

  advance(ms: number): void {
    this.now += ms;
  }

  private iso(at = this.now): string {
    return new Date(at).toISOString();
  }

  // --- the scheduler ------------------------------------------------------

  /** A push: one new run of `workflowYaml`, scheduled against the current state. */
  push(workflowYaml: string, options: { path?: string; headRepository?: string } = {}): MockRun {
    const doc = parse(workflowYaml) as { jobs?: WorkflowJobs };
    const run: MockRun = {
      id: this.nextId++,
      name: options.path ?? "ci.yml",
      run_attempt: 1,
      created_at: this.iso(),
      status: "queued",
      conclusion: null,
      head_repository: { full_name: options.headRepository ?? this.repo },
      path: `.github/workflows/${options.path ?? "ci.yml"}`,
      workflow: doc.jobs ?? {},
      jobs: [],
    };
    this.schedule(run, new Set());
    this.runs.unshift(run);
    return run;
  }

  /** Brings queued self-hosted jobs up once a runner for them is online. */
  drain(): void {
    for (const run of this.runs) {
      if (run.status === "completed") continue;
      const keep = new Set(run.jobs.filter((job) => job.status === "completed").map((j) => j.name));
      const previous = run.jobs;
      this.schedule(run, keep, previous);
    }
  }

  runsOnFor(run: MockRun, job: string, needs: ReadonlyMap<string, MockJob>): unknown {
    const value = run.workflow[job]?.["runs-on"];
    return typeof value === "string" && value.includes("${{")
      ? evaluate(value, { vars: Object.fromEntries(this.variables), needs })
      : value;
  }

  /**
   * Evaluates every job not in `keep`, in dependency order. Jobs in `keep`
   * carry over from `previous` untouched — that is a re-run of failed jobs.
   */
  private schedule(run: MockRun, keep: ReadonlySet<string>, previous: MockJob[] = []): void {
    const done = new Map<string, MockJob>();
    for (const job of previous) if (keep.has(job.name)) done.set(job.name, job);

    const names = Object.keys(run.workflow);
    let progress = true;
    while (progress) {
      progress = false;
      for (const name of names) {
        if (done.has(name)) continue;
        const needs = [run.workflow[name]?.needs ?? []].flat();
        if (!needs.every((need) => done.has(need))) continue;

        const deps = new Map(needs.map((need) => [need, done.get(need) as MockJob]));
        done.set(name, this.runJob(run, name, deps));
        progress = true;
      }
    }

    run.jobs = names.map((name) => done.get(name) as MockJob);
    const pending = run.jobs.some((job) => job.status !== "completed");
    run.status = pending ? "queued" : "completed";
    run.conclusion = pending
      ? null
      : run.jobs.some((job) => job.conclusion === "failure")
        ? "failure"
        : "success";
  }

  private runJob(run: MockRun, name: string, needs: ReadonlyMap<string, MockJob>): MockJob {
    const job: MockJob = {
      id: this.nextId++,
      name,
      status: "completed",
      conclusion: null,
      labels: [],
      runner_name: null,
      steps: [],
      started_at: null,
      completed_at: this.iso(),
      annotations: [],
      outputs: {},
    };

    if ([...needs.values()].some((dep) => dep.status !== "completed")) {
      // Waiting on a job that is itself waiting for a runner.
      job.status = "queued";
      job.completed_at = null;
      return job;
    }

    if ([...needs.values()].some((dep) => dep.conclusion !== "success")) {
      // GitHub skips a job whose dependency didn't succeed — it never asks for
      // a runner at all.
      job.conclusion = "skipped";
      return job;
    }

    const runsOn = this.runsOnFor(run, name, needs);
    job.labels = (
      typeof runsOn === "string" ? [runsOn] : Array.isArray(runsOn) ? (runsOn as string[]) : []
    ).filter((label) => typeof label === "string" && label.length > 0);
    if (job.labels.length === 0) {
      job.conclusion = "failure";
      job.annotations = ["Unable to resolve runs-on"];
      return job;
    }

    // GitHub only starts one of its own runners for one of its own image names;
    // any other label — `self-hosted`, `gh-runner-linux` — is a self-hosted job.
    const selfHosted = !job.labels.every((label) => /^(ubuntu|macos|windows)(-|$)/i.test(label));
    if (selfHosted) {
      const runner = this.online.find((labels) =>
        job.labels.every((label) =>
          labels.some((have) => have.toLowerCase() === label.toLowerCase()),
        ),
      );
      if (!runner) {
        job.status = "queued";
        job.completed_at = null;
        return job;
      }
      return this.succeed(job, "gh-runner-mock");
    }

    if (!this.hostedAvailable) {
      job.conclusion = "failure";
      job.annotations = [BILLING_MESSAGE];
      return job;
    }

    const ok = this.succeed(job, "GitHub Actions 2");
    if (name.includes("check")) ok.outputs = { ...this.probeOutputs };
    return ok;
  }

  private succeed(job: MockJob, runner: string): MockJob {
    job.runner_name = runner;
    job.started_at = this.iso();
    job.completed_at = this.iso();
    job.conclusion = "success";
    job.steps = [{ name: "Run", status: "completed", conclusion: "success", number: 1 }];
    return job;
  }

  // --- the REST API -------------------------------------------------------

  handle(method: string, rawPath: string, fields: Record<string, string>): Response {
    this.log.push(`${method} ${rawPath}`);
    const url = new URL(rawPath.replace(/^\/?/, "/"), "http://mock");
    const path = url.pathname;
    if (this.failing?.(method, path)) return { status: 500, body: { message: "Server Error" } };

    const prefix = `/repos/${this.repo}`;
    if (!path.startsWith(prefix)) return notFound();
    const rest = path.slice(prefix.length);

    let match: RegExpExecArray | null;

    if (method === "GET" && rest === "/actions/runs") {
      const created = url.searchParams.get("created") ?? "";
      const since = created.startsWith(">=") ? Date.parse(created.slice(2)) : 0;
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const status = url.searchParams.get("status");
      const runs = this.runs
        .filter((run) => Date.parse(run.created_at) >= since)
        // GitHub's `status` takes a status or a conclusion.
        .filter((run) => !status || run.status === status || run.conclusion === status)
        .slice(0, perPage)
        .map(({ workflow: _w, jobs: _j, ...run }) => run);
      return ok({ total_count: runs.length, workflow_runs: runs });
    }

    if ((match = /^\/actions\/runs\/(\d+)\/jobs$/.exec(rest)) && method === "GET") {
      const run = this.runs.find((entry) => entry.id === Number(match?.[1]));
      if (!run) return notFound();
      return ok({
        total_count: run.jobs.length,
        jobs: run.jobs.map(({ annotations: _a, outputs: _o, ...job }) =>
          Object.assign(job, { run_id: run.id, run_attempt: run.run_attempt }),
        ),
      });
    }

    if ((match = /^\/check-runs\/(\d+)\/annotations$/.exec(rest)) && method === "GET") {
      const job = this.runs.flatMap((run) => run.jobs).find((j) => j.id === Number(match?.[1]));
      if (!job) return notFound();
      return ok(
        job.annotations.map((message) => ({
          annotation_level: "failure",
          message,
          path: ".github",
        })),
      );
    }

    if ((match = /^\/actions\/runs\/(\d+)\/rerun-failed-jobs$/.exec(rest)) && method === "POST") {
      const run = this.runs.find((entry) => entry.id === Number(match?.[1]));
      if (!run) return notFound();
      if (run.status !== "completed" || run.conclusion !== "failure") {
        return { status: 403, body: { message: "This workflow run cannot be rerun" } };
      }
      this.reruns.push(run.id);
      run.run_attempt += 1;
      const keep = new Set(
        run.jobs.filter((job) => job.conclusion === "success").map((job) => job.name),
      );
      this.schedule(run, keep, run.jobs);
      return { status: 201, body: {} };
    }

    if ((match = /^\/actions\/variables\/([A-Za-z0-9_]+)$/.exec(rest))) {
      const name = match[1] as string;
      if (method === "GET") {
        const value = this.variables.get(name);
        return value === undefined ? notFound() : ok({ name, value });
      }
      if (method === "PATCH") {
        if (!this.variables.has(name)) return notFound();
        this.variables.set(name, fields["value"] ?? "");
        return { status: 204, body: "" };
      }
      if (method === "DELETE") {
        if (!this.variables.delete(name)) return notFound();
        return { status: 204, body: "" };
      }
    }

    if (rest === "/actions/variables" && method === "POST") {
      const name = fields["name"] ?? "";
      if (this.variables.has(name)) return { status: 409, body: { message: "Already exists" } };
      this.variables.set(name, fields["value"] ?? "");
      return { status: 201, body: {} };
    }

    return notFound();
  }

  /**
   * Answers a `gh` command line the way gh does: the body on stdout and exit 0,
   * or `gh: <message> (HTTP <status>)` on stderr and exit 1.
   */
  gh(args: readonly string[]): ExecResult {
    const parsed = parseGhArgs(args);
    if (!parsed) return { code: 2, stdout: "", stderr: `mock gh: unsupported ${args.join(" ")}` };

    const response = this.handle(parsed.method, parsed.path, parsed.fields);
    if (response.status >= 400) {
      const message = (response.body as { message?: string })?.message ?? "Error";
      return { code: 1, stdout: "", stderr: `gh: ${message} (HTTP ${response.status})\n` };
    }

    let out = typeof response.body === "string" ? response.body : JSON.stringify(response.body);
    if (parsed.jq) {
      const value = jq(response.body, parsed.jq);
      if (value === undefined) {
        return { code: 2, stdout: "", stderr: `mock gh: unsupported --jq ${parsed.jq}` };
      }
      out = value;
    }
    return { code: 0, stdout: out ? `${out}\n` : "", stderr: "" };
  }

  /** A `CommandRunner` that answers `gh` in-process. */
  commandRunner(): CommandRunner {
    return async (command, args) => {
      if (command !== "gh") return { code: 127, stdout: "", stderr: `${command}: not mocked` };
      return this.gh(args);
    };
  }

  /**
   * Serves {@link gh} over HTTP, for `fake-gh.mjs` to forward to — so the code
   * under test spawns a real process, reads its real exit code, and parses its
   * real stdout, exactly as it does with the real `gh`.
   */
  async listen(): Promise<{ url: string; close: () => Promise<void> }> {
    const server: Server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (body += chunk));
      req.on("end", () => {
        const { args } = JSON.parse(body) as { args: string[] };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(this.gh(args)));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }
}

const ok = (body: unknown): Response => ({ status: 200, body });
const notFound = (): Response => ({ status: 404, body: { message: "Not Found" } });

function parseGhArgs(
  args: readonly string[],
): { method: string; path: string; fields: Record<string, string>; jq?: string } | null {
  if (args[0] !== "api") return null;
  let method = "GET";
  let path = "";
  let jqFilter: string | undefined;
  const fields: Record<string, string> = {};

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "-X" || arg === "--method") method = args[++i] ?? "GET";
    else if (arg === "-f" || arg === "-F" || arg === "--raw-field" || arg === "--field") {
      const pair = args[++i] ?? "";
      const eq = pair.indexOf("=");
      fields[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (arg === "--jq" || arg === "-q") jqFilter = args[++i];
    else if (arg.startsWith("-")) return null;
    else path = arg;
  }
  // gh sends -f fields as a POST body unless a method says otherwise.
  if (method === "GET" && Object.keys(fields).length > 0) method = "POST";
  return { method, path, fields, ...(jqFilter ? { jq: jqFilter } : {}) };
}

/** The one jq shape gh-runner's variable read uses: `.field`. */
function jq(body: unknown, filter: string): string | undefined {
  const match = /^\.([A-Za-z_]+)$/.exec(filter.trim());
  if (!match || !body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[match[1] as string];
  return value === undefined || value === null ? "" : String(value);
}

// --- a tiny, independent GitHub expression evaluator ------------------------

interface Scope {
  vars: Record<string, string>;
  needs: ReadonlyMap<string, MockJob>;
}

/**
 * Evaluates the `${{ }}` subset gh-runner writes: property paths into `vars`
 * and `needs`, string literals, `fromJSON()`, member access, `&&` and `||` —
 * with GitHub's truthiness, where `''`, `null`, `0` and `false` are falsy.
 */
export function evaluate(source: string, scope: Scope): unknown {
  const match = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(source);
  if (!match) return source;

  const text = match[1] as string;
  let pos = 0;

  const skip = () => {
    while (/\s/.test(text[pos] ?? "")) pos += 1;
  };
  const eat = (token: string): boolean => {
    skip();
    if (text.startsWith(token, pos)) {
      pos += token.length;
      return true;
    }
    return false;
  };
  const truthy = (value: unknown) =>
    !(value === "" || value === null || value === undefined || value === 0 || value === false);

  const or = (): unknown => {
    let left = and();
    while (eat("||")) {
      const right = and();
      left = truthy(left) ? left : right;
    }
    return left;
  };
  const and = (): unknown => {
    let left = postfix();
    while (eat("&&")) {
      const right = postfix();
      left = truthy(left) ? right : left;
    }
    return left;
  };
  const postfix = (): unknown => {
    let value = primary();
    while (eat(".")) {
      const name = /^[A-Za-z0-9_-]+/.exec(text.slice(pos))?.[0] ?? "";
      pos += name.length;
      value =
        value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined;
    }
    return value;
  };
  const primary = (): unknown => {
    skip();
    if (text[pos] === "'") {
      let out = "";
      pos += 1;
      while (pos < text.length) {
        if (text[pos] === "'" && text[pos + 1] === "'") {
          out += "'";
          pos += 2;
        } else if (text[pos] === "'") {
          pos += 1;
          return out;
        } else {
          out += text[pos];
          pos += 1;
        }
      }
      throw new Error(`unterminated string in ${source}`);
    }
    if (eat("(")) {
      const value = or();
      if (!eat(")")) throw new Error(`expected ) in ${source}`);
      return value;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(pos))?.[0];
    if (!name) throw new Error(`unexpected ${text.slice(pos)} in ${source}`);
    pos += name.length;

    if (name === "fromJSON") {
      if (!eat("(")) throw new Error(`expected ( in ${source}`);
      const arg = or();
      if (!eat(")")) throw new Error(`expected ) in ${source}`);
      return JSON.parse(String(arg));
    }
    if (name === "vars") {
      return scope.vars;
    }
    if (name === "needs") {
      const needs: Record<string, unknown> = {};
      for (const [id, job] of scope.needs) {
        needs[id] = { result: job.conclusion, outputs: job.outputs };
      }
      return needs;
    }
    throw new Error(`unknown name ${name} in ${source}`);
  };

  const value = or();
  skip();
  if (pos !== text.length) throw new Error(`trailing input in ${source}`);
  // An unset variable reads as an empty string, not as undefined.
  return value === undefined ? "" : value;
}
