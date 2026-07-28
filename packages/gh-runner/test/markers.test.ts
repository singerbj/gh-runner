import { describe, expect, it } from "vitest";
import { PROBE_RUNS_ON_VALUE, PROBE_RUNS_ON_VAR } from "../src/constants.js";
import { MarkerPublisher } from "../src/heartbeat.js";
import type { GhClient } from "../src/gh.js";
import { silentLogger } from "../src/logger.js";
import {
  MARKER_MAX_AGE_SECONDS,
  labelsAreOnline,
  markerLabel,
  markerRef,
  onlineLabels,
  parseMarkerRef,
} from "../src/markers.js";

describe("markerRef", () => {
  it("names a ref outside refs/heads, stamped with the second it was written", () => {
    expect(markerRef("gh-runner-linux", 1_700_000_000)).toBe(
      "refs/gh-runner/online/gh-runner-linux/1700000000",
    );
  });

  it("lower-cases, because GitHub matches labels that way", () => {
    expect(markerRef("GH-Runner-Mac", 1)).toBe("refs/gh-runner/online/gh-runner-mac/1");
  });

  it("refuses labels git can't hold in a ref name", () => {
    expect(markerLabel("a..b")).toBeNull();
    expect(markerLabel("box.lock")).toBeNull();
    expect(markerLabel("-leading-dash")).toBeNull();
    expect(markerLabel("")).toBeNull();
    expect(markerRef("a..b", 1)).toBeNull();
  });

  it("round-trips through the parser", () => {
    const ref = markerRef("my-box", 1_700_000_000) as string;
    expect(parseMarkerRef(ref)).toEqual({ label: "my-box", at: 1_700_000_000 });
  });

  it("ignores refs that aren't ours", () => {
    expect(parseMarkerRef("refs/heads/main")).toBeNull();
    expect(parseMarkerRef("refs/gh-runner/online/no-stamp")).toBeNull();
    expect(parseMarkerRef("refs/gh-runner/online/label/not-a-number")).toBeNull();
  });
});

describe("onlineLabels", () => {
  const now = 1_700_000_000;

  it("counts a marker stamped within the window", () => {
    const refs = [markerRef("gh-runner-linux", now - 60) as string];
    expect([...onlineLabels(refs, now)]).toEqual(["gh-runner-linux"]);
  });

  it("forgets one that stopped being re-stamped", () => {
    const refs = [markerRef("gh-runner-linux", now - MARKER_MAX_AGE_SECONDS - 1) as string];
    expect(onlineLabels(refs, now).size).toBe(0);
  });

  it("trusts a stamp from the future — that's clock skew, not an outage", () => {
    const refs = [markerRef("gh-runner-mac", now + 300) as string];
    expect(onlineLabels(refs, now).has("gh-runner-mac")).toBe(true);
  });

  it("keeps a label alive while any one of its markers is fresh", () => {
    const refs = [
      markerRef("gh-runner", now - MARKER_MAX_AGE_SECONDS - 10) as string,
      markerRef("gh-runner", now - 5) as string,
    ];
    expect(onlineLabels(refs, now).has("gh-runner")).toBe(true);
  });
});

describe("labelsAreOnline", () => {
  const online = new Set(["gh-runner", "gh-runner-linux"]);

  it("needs every label a job asks for", () => {
    expect(labelsAreOnline(["self-hosted", "gh-runner-linux"], online)).toBe(true);
    expect(labelsAreOnline(["self-hosted", "gh-runner-mac"], online)).toBe(false);
    expect(labelsAreOnline(["self-hosted", "gh-runner", "cuda"], online)).toBe(false);
  });

  it("won't call a job online on the strength of `self-hosted` alone", () => {
    expect(labelsAreOnline(["self-hosted"], online)).toBe(false);
  });
});

describe("MarkerPublisher", () => {
  const stubGh = (calls: string[][]) =>
    ({
      defaultBranchSha: async () => "a".repeat(40),
      createRef: async (_repo: string, ref: string) => {
        calls.push(["create", ref]);
        return true;
      },
      deleteRef: async (_repo: string, ref: string) => {
        calls.push(["delete", ref]);
        return true;
      },
      setVariable: async (_repo: string, name: string, value: string) => {
        calls.push(["set-var", name, value]);
        return true;
      },
      deleteVariable: async (_repo: string, name: string) => {
        calls.push(["delete-var", name]);
        return true;
      },
    }) as unknown as GhClient;

  const publisher = (calls: string[][], now: () => number, probeVariable = false) => {
    const gh = stubGh(calls);
    let beat = () => {};
    const marker = new MarkerPublisher({
      repo: "octocat/thing",
      labels: ["gh-runner", "gh-runner-linux"],
      gh,
      cleanupGh: gh,
      logger: silentLogger,
      probeVariable,
      now,
      schedule: (fn) => {
        beat = fn;
        return { close: () => {} };
      },
    });
    return { marker, beat: () => beat() };
  };

  it("publishes one marker per label", async () => {
    const calls: string[][] = [];
    const { marker } = publisher(calls, () => 1_700_000_000_000);

    expect(await marker.start("main")).toBe(true);
    expect(calls).toEqual([
      ["create", "refs/gh-runner/online/gh-runner/1700000000"],
      ["create", "refs/gh-runner/online/gh-runner-linux/1700000000"],
    ]);
  });

  it("re-stamps on each heartbeat and takes the previous stamp down", async () => {
    const calls: string[][] = [];
    let now = 1_700_000_000_000;
    const { marker, beat } = publisher(calls, () => now);

    await marker.start("main");
    calls.length = 0;
    now += 120_000;
    beat();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toContainEqual(["create", "refs/gh-runner/online/gh-runner/1700000120"]);
    expect(calls).toContainEqual(["delete", "refs/gh-runner/online/gh-runner/1700000000"]);
  });

  it("removes every marker on stop", async () => {
    const calls: string[][] = [];
    const { marker } = publisher(calls, () => 1_700_000_000_000);

    await marker.start("main");
    calls.length = 0;
    await marker.stop();

    expect(calls).toEqual([
      ["delete", "refs/gh-runner/online/gh-runner/1700000000"],
      ["delete", "refs/gh-runner/online/gh-runner-linux/1700000000"],
    ]);

    // Safe to call twice — cleanup runs on more than one exit path.
    calls.length = 0;
    await marker.stop();
    expect(calls).toEqual([]);
  });

  it("leaves the probe variable alone unless asked for it", async () => {
    const calls: string[][] = [];
    const { marker } = publisher(calls, () => 1_700_000_000_000);

    await marker.start("main");
    await marker.stop();

    expect(calls.some(([verb]) => verb?.endsWith("-var"))).toBe(false);
  });

  it("publishes the probe variable alongside the markers, and clears it on stop", async () => {
    const calls: string[][] = [];
    const { marker } = publisher(calls, () => 1_700_000_000_000, true);

    await marker.start("main");
    expect(calls).toContainEqual(["set-var", PROBE_RUNS_ON_VAR, PROBE_RUNS_ON_VALUE]);

    calls.length = 0;
    await marker.stop();
    expect(calls).toContainEqual(["delete-var", PROBE_RUNS_ON_VAR]);

    // Nothing ages the variable out, so cleanup must not run twice and delete
    // one a session started since has published.
    calls.length = 0;
    await marker.stop();
    expect(calls).toEqual([]);
  });

  it("re-asserts the probe variable on every beat, in case a sibling cleared it", async () => {
    const calls: string[][] = [];
    let now = 1_700_000_000_000;
    const { marker, beat } = publisher(calls, () => now, true);

    await marker.start("main");
    calls.length = 0;
    now += 120_000;
    beat();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    expect(calls).toContainEqual(["set-var", PROBE_RUNS_ON_VAR, PROBE_RUNS_ON_VALUE]);
  });

  it("stays up when the variable can't be written, and doesn't try to delete it", async () => {
    const calls: string[][] = [];
    const gh = {
      defaultBranchSha: async () => "a".repeat(40),
      createRef: async () => true,
      deleteRef: async () => true,
      setVariable: async () => false,
      deleteVariable: async (_repo: string, name: string) => {
        calls.push(["delete-var", name]);
        return true;
      },
    } as unknown as GhClient;

    const marker = new MarkerPublisher({
      repo: "octocat/thing",
      labels: ["gh-runner"],
      gh,
      cleanupGh: gh,
      logger: silentLogger,
      probeVariable: true,
    });

    expect(await marker.start("main")).toBe(true);
    await marker.stop();
    expect(calls).toEqual([]);
  });

  it("carries on when it can't write refs at all", async () => {
    const gh = {
      defaultBranchSha: async () => "a".repeat(40),
      createRef: async () => false,
      deleteRef: async () => false,
    } as unknown as GhClient;

    const marker = new MarkerPublisher({
      repo: "octocat/thing",
      labels: ["gh-runner"],
      gh,
      cleanupGh: gh,
      logger: silentLogger,
    });

    expect(await marker.start("main")).toBe(false);
  });
});
