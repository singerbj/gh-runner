/**
 * Marker refs — how a workflow finds out whether a runner is online.
 *
 * Asking GitHub directly (`GET /repos/{repo}/actions/runners`) needs repo admin
 * access, and there is no `administration` scope a workflow's `GITHUB_TOKEN`
 * can be granted. So the runner publishes its own liveness instead: a ref under
 * `refs/gh-runner/online/`, which any job can read with `contents: read`.
 *
 * The timestamp lives in the ref name rather than in the object it points at,
 * so a heartbeat is two cheap API calls and never writes a new git object. A
 * marker left behind by a killed process stops counting once it ages out.
 */

/** Everything below this lives outside `refs/heads`, so it never looks like a branch. */
export const MARKER_PREFIX = "gh-runner/online";

/** How often a live runner re-stamps its markers. */
export const HEARTBEAT_INTERVAL_MS = 120_000;

/**
 * How old a marker may be before a workflow stops trusting it. Three missed
 * heartbeats: long enough to ride out a slow API call or a laptop that briefly
 * loses its network, short enough that a hard kill is forgotten quickly.
 */
export const MARKER_MAX_AGE_SECONDS = 420;

export interface Marker {
  /** Lower-cased runner label, e.g. `gh-runner-linux`. */
  label: string;
  /** Unix seconds the marker was stamped. */
  at: number;
}

/**
 * Git forbids `..` and a `.lock` suffix in ref names, and our labels are
 * matched case-insensitively by GitHub anyway.
 */
export function markerLabel(label: string): string | null {
  const value = label.trim().toLowerCase();
  if (!value || value.includes("..") || value.endsWith(".lock")) return null;
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(value)) return null;
  return value;
}

/** `refs/gh-runner/online/<label>/<unix-seconds>`, or null for a label git can't hold. */
export function markerRef(label: string, at: number): string | null {
  const safe = markerLabel(label);
  if (!safe) return null;
  return `refs/${MARKER_PREFIX}/${safe}/${Math.floor(at)}`;
}

/** The label and stamp a marker ref carries, or null if it isn't one of ours. */
export function parseMarkerRef(ref: string): Marker | null {
  const withoutRefs = ref.startsWith("refs/") ? ref.slice("refs/".length) : ref;
  if (!withoutRefs.startsWith(`${MARKER_PREFIX}/`)) return null;

  const rest = withoutRefs.slice(MARKER_PREFIX.length + 1);
  const slash = rest.lastIndexOf("/");
  if (slash <= 0) return null;

  const label = rest.slice(0, slash);
  const at = Number(rest.slice(slash + 1));
  if (!Number.isFinite(at) || at <= 0) return null;

  return { label: label.toLowerCase(), at };
}

/**
 * The labels a runner is currently online for.
 *
 * A stamp from the future is treated as fresh: clock skew between the machine
 * that wrote the marker and the one reading it should not take CI offline.
 */
export function onlineLabels(
  refs: readonly string[],
  now: number,
  maxAgeSeconds: number = MARKER_MAX_AGE_SECONDS,
): Set<string> {
  const online = new Set<string>();
  const cutoff = now - maxAgeSeconds;

  for (const ref of refs) {
    const marker = parseMarkerRef(ref);
    if (marker && marker.at >= cutoff) online.add(marker.label);
  }

  return online;
}

/** True when every label a job asks for is currently marked online. */
export function labelsAreOnline(labels: readonly string[], online: ReadonlySet<string>): boolean {
  const wanted = labels
    .map((label) => label.toLowerCase())
    // Every self-hosted runner carries this one; it says nothing about which.
    .filter((label) => label !== "self-hosted");

  return wanted.length > 0 && wanted.every((label) => online.has(label));
}
