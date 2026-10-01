# Programmatic API

```sh
npm install @singerbj/gh-runner
```

```ts
import { ghRunner, createLogger } from "@singerbj/gh-runner";

const { runners, workflows } = await ghRunner(
  { repo: "octocat/hello-world", platforms: ["mac", "linux"], labels: ["gpu"] },
  { logger: createLogger(), signal: AbortSignal.timeout(30 * 60_000) },
);

for (const runner of runners) {
  console.log(runner.runnerName, runner.mode, runner.labels);
}
console.log(workflows?.matches); // jobs that will land here
```

`ghRunner` resolves once every runner has finished and deregistered. Abort the signal to shut them down.

It never prompts unless you pass `confirm` or `selectPlatforms` in the context. `createConfirm()` and `terminalPlatformPicker` are the terminal versions.

## Other exports

| Export               | Purpose                                     |
| -------------------- | ------------------------------------------- |
| `ghRunnerSetup`      | Run `gh-runner setup` programmatically      |
| `inspectWorkflows`   | Check which jobs target a set of labels     |
| `parseRunsOn`        | Parse a `runs-on` value                     |
| `classifyTarget`     | Classify a job's runner                     |
| `hostedRunnerOs`     | Map a hosted runner name to its OS          |
| `applyWorkflowFix`   | Rewrite `runs-on` values in a workflow      |
| `fixLabelFor`        | Pick the fallback label for a hosted runner |
| `proposeWorkflowFix` | Open the workflow fix PR                    |
| `HostedUsageWatcher` | Watch for refused hosted jobs and fall back |
