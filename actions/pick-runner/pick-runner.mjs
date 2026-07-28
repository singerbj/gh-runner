// Resolves `runs-on` for each platform a workflow was repointed for.
//
// A gh-runner publishes `refs/gh-runner/online/<label>/<unix-seconds>` while it
// is registered, and re-stamps it every couple of minutes. Reading refs only
// needs `contents: read`, so this works with the built-in GITHUB_TOKEN — unlike
// the runners API, which needs repo admin.
//
// This step never fails the build. Anything unexpected — no token, a network
// error, malformed input — resolves to the hosted fallback, which is exactly
// where the job ran before it was repointed.

import { appendFileSync } from "node:fs";

const MARKER_PREFIX = "gh-runner/online";
const DEFAULT_MAX_AGE_SECONDS = 420;

const input = (name) => process.env[`INPUT_${name.toUpperCase()}`] ?? "";

/** Parses `refs/gh-runner/online/<label>/<stamp>`, or null if it isn't ours. */
function parseMarkerRef(ref) {
  const withoutRefs = ref.startsWith("refs/") ? ref.slice("refs/".length) : ref;
  if (!withoutRefs.startsWith(`${MARKER_PREFIX}/`)) return null;

  const rest = withoutRefs.slice(MARKER_PREFIX.length + 1);
  const slash = rest.lastIndexOf("/");
  if (slash <= 0) return null;

  const at = Number(rest.slice(slash + 1));
  if (!Number.isFinite(at) || at <= 0) return null;

  return { label: rest.slice(0, slash).toLowerCase(), at };
}

async function readMarkers({ apiUrl, repository, token }) {
  const url = `${apiUrl.replace(/\/$/, "")}/repos/${repository}/git/matching-refs/${MARKER_PREFIX}`;
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "gh-runner-pick-runner",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });

  // A repo that has never had a runner online has no matching refs at all, and
  // some API versions answer that with a 404 rather than an empty list.
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const body = await response.json();
  return Array.isArray(body) ? body.map((entry) => entry?.ref).filter(Boolean) : [];
}

function onlineLabels(refs, now, maxAgeSeconds) {
  const online = new Set();
  const cutoff = now - maxAgeSeconds;

  for (const ref of refs) {
    const marker = parseMarkerRef(ref);
    // A stamp from the future is clock skew between two machines, not a reason
    // to take CI offline.
    if (marker && marker.at >= cutoff) online.add(marker.label);
  }

  return online;
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `ghadelimiter_${name}_${process.pid}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

async function main() {
  let targets;
  try {
    targets = JSON.parse(input("targets"));
  } catch (error) {
    throw new Error(`targets is not valid JSON: ${error.message}`, { cause: error });
  }
  if (!targets || typeof targets !== "object") {
    throw new Error("targets must be a JSON object");
  }

  const maxAge = Number(process.env["INPUT_MAX-AGE"]) || DEFAULT_MAX_AGE_SECONDS;
  const now = Math.floor(Date.now() / 1000);

  let online = new Set();
  let reason = "";
  try {
    const refs = await readMarkers({
      apiUrl: input("api-url") || "https://api.github.com",
      repository: input("repository"),
      token: input("token"),
    });
    online = onlineLabels(refs, now, maxAge);
  } catch (error) {
    // Fail open: everything goes to the runner it used to run on.
    reason = error instanceof Error ? error.message : String(error);
    console.log(
      `::warning title=gh-runner::couldn't read runner markers (${reason}) — using hosted runners`,
    );
  }

  const runners = {};
  const picked = [];

  for (const [key, spec] of Object.entries(targets)) {
    const labels = Array.isArray(spec?.labels) ? spec.labels : [];
    const fallback = spec?.fallback ?? "ubuntu-latest";

    // `self-hosted` is on every self-hosted runner and identifies none of them.
    const wanted = labels.map((l) => String(l).toLowerCase()).filter((l) => l !== "self-hosted");
    const isOnline = wanted.length > 0 && wanted.every((label) => online.has(label));

    runners[key] = isOnline ? labels : fallback;
    if (isOnline) picked.push(key);

    const shown = Array.isArray(runners[key]) ? `[${runners[key].join(", ")}]` : runners[key];
    console.log(`${key}: ${shown}${isOnline ? "" : "  (no runner online)"}`);
  }

  setOutput("runners", JSON.stringify(runners));
  setOutput("online", JSON.stringify(picked));
  setOutput("any-online", picked.length > 0 ? "true" : "false");

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const rows = Object.entries(runners).map(([key, value]) => {
      const shown = Array.isArray(value) ? `\`[${value.join(", ")}]\`` : `\`${value}\``;
      return `| ${key} | ${shown} | ${picked.includes(key) ? "self-hosted" : "GitHub-hosted"} |`;
    });
    appendFileSync(
      summary,
      [
        `### gh-runner`,
        "",
        "| target | runs-on | where |",
        "| --- | --- | --- |",
        ...rows,
        "",
      ].join("\n"),
    );
  }
}

try {
  await main();
} catch (error) {
  // Even a broken `targets` input must not take the workflow down: emit an
  // empty map and let the caller's `||` fall through to its own default.
  console.log(
    `::warning title=gh-runner::${error instanceof Error ? error.message : String(error)}`,
  );
  setOutput("runners", "{}");
  setOutput("online", "[]");
  setOutput("any-online", "false");
}
