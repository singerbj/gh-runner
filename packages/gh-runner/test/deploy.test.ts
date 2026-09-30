import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { OS_LABELS, fallbackRunsOn } from "../src/constants.js";
import { parseArgs } from "../src/options.js";
import { readFallback } from "../src/workflows.js";

/**
 * The Docker Compose file and the AI setup prompt ship with every release but
 * aren't code, so nothing else would notice them drifting from the CLI.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const compose = read("deploy/docker-compose.yml");
const entrypoint = read("deploy/entrypoint.sh");
const dockerfile = read("deploy/Dockerfile");
const prompt = read("prompts/setup-repo.md");

interface ComposeService {
  image: string;
  restart: string;
  stop_grace_period: string;
  environment: Record<string, string>;
  volumes: string[];
}

const service = (parse(compose) as { services: Record<string, ComposeService> }).services[
  "gh-runner"
] as ComposeService;

describe("deploy/docker-compose.yml", () => {
  it("runs the published image, and keeps it running", () => {
    // release.yml rewrites exactly this to the release's own tag in the copy
    // it attaches.
    expect(service.image).toBe("ghcr.io/singerbj/gh-runner:latest");
    expect(service.restart).toBe("unless-stopped");
    expect(service.stop_grace_period).toBe("60s");
    expect(service.volumes).toEqual(["gh-runner:/home/node"]);
  });

  it("passes on every variable the entrypoint reads", () => {
    const used = [...entrypoint.matchAll(/\$\{(GH_[A-Z_]+)/g)].map((match) => match[1]);
    expect(Object.keys(service.environment).toSorted()).toEqual([...new Set(used)].toSorted());
  });
});

describe("deploy/Dockerfile", () => {
  it("starts the entrypoint under tini, as the unprivileged node user", () => {
    expect(dockerfile).toMatch(/^FROM node:lts$/m);
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toContain('ENTRYPOINT ["tini", "--", "gh-runner-entrypoint"]');
    expect(dockerfile).toContain(
      "COPY --chmod=755 entrypoint.sh /usr/local/bin/gh-runner-entrypoint",
    );
  });

  it("installs the version the release workflow passes in", () => {
    expect(dockerfile).toMatch(/^ARG GH_RUNNER_VERSION=latest$/m);
    expect(dockerfile).toContain('"@singerbj/gh-runner@${GH_RUNNER_VERSION}"');
  });
});

describe("deploy/entrypoint.sh", () => {
  it("only passes flags the CLI accepts", () => {
    const argv = [...entrypoint.matchAll(/args\+?=\((.*)\)/g)]
      .flatMap((match) => (match[1] ?? "").split(/\s+/))
      .filter(Boolean)
      .map((word) => (word.startsWith('"$') ? "placeholder" : word));
    argv.splice(argv.indexOf("--repo") + 1, 1, "octocat/thing");

    const { kind, options } = parseArgs(argv);
    expect(kind).toBe("run");
    expect(options.platforms).toEqual(["linux"]);
    expect(options.repo).toBe("octocat/thing");
    expect(options.fixWorkflows).toBe("never");
    expect(options.labels).toEqual(["placeholder"]);
  });

  it("hands the process to gh-runner, so tini's SIGTERM reaches it", () => {
    expect(entrypoint).toContain('exec gh-runner "${args[@]}" "$@"');
  });
});

describe("prompts/setup-repo.md", () => {
  const examples: Array<[label: string, hosted: string[]]> = [
    [OS_LABELS.linux, ["ubuntu-latest"]],
    [OS_LABELS.osx, ["macos-14"]],
    [OS_LABELS.win, ["windows-latest"]],
    ["gh-runner", ["my-big-runner"]],
    [OS_LABELS.linux, ["ubuntu-latest", "gpu"]],
  ];

  it.each(examples)("spells the %s rewrite of %j the way gh-runner writes it", (label, hosted) => {
    const expression = fallbackRunsOn(label, hosted);
    expect(prompt).toContain(expression);
    expect(readFallback(expression)).toEqual(expect.objectContaining({ label, hosted }));
  });
});
