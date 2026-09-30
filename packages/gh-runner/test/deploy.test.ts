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

const compose = readFileSync(new URL("../deploy/docker-compose.yml", import.meta.url), "utf8");
const prompt = readFileSync(new URL("../prompts/setup-repo.md", import.meta.url), "utf8");

interface ComposeService {
  image: string;
  restart: string;
  init: boolean;
  environment: Record<string, string>;
  command: string[];
}

const service = (parse(compose) as { services: Record<string, ComposeService> }).services[
  "gh-runner"
] as ComposeService;
const script = service.command.join("\n");

describe("deploy/docker-compose.yml", () => {
  it("keeps gh-runner up as the container's own process", () => {
    expect(service.image).toBe("node:lts");
    expect(service.restart).toBe("unless-stopped");
    // Without an init, SIGTERM never reaches gh-runner's cleanup.
    expect(service.init).toBe(true);
    expect(script).toMatch(/exec setpriv --reuid=node .* gh-runner "\$\$\{args\[@\]\}"/s);
  });

  it("carries the version default the release workflow pins", () => {
    // release.yml rewrites this exact string in the copy it attaches.
    expect(compose).toContain("${GH_RUNNER_VERSION:-latest}");
    expect(service.environment["GH_RUNNER_VERSION"]).toBe("${GH_RUNNER_VERSION:-latest}");
  });

  it("only passes flags the CLI accepts", () => {
    const argv = [...script.matchAll(/args(?:\+)?=\((.*)\)/g)]
      .flatMap((match) => (match[1] ?? "").split(/\s+/))
      .filter(Boolean)
      .map((word) => (word.startsWith('"$${') ? "placeholder" : word));
    argv.splice(argv.indexOf("--repo") + 1, 1, "octocat/thing");

    const { kind, options } = parseArgs(argv);
    expect(kind).toBe("run");
    expect(options.platforms).toEqual(["linux"]);
    expect(options.repo).toBe("octocat/thing");
    expect(options.fixWorkflows).toBe("never");
    expect(options.labels).toEqual(["placeholder"]);
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
