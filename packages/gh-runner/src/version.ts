import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This package's own version.
 *
 * Read from disk rather than baked in by the build: the release workflow bumps
 * package.json and publishes, so a constant compiled from it would be one
 * version behind whatever is actually running.
 */
export function readVersion(): string {
  try {
    const pkgPath = join(dirname(dirname(fileURLToPath(import.meta.url))), "package.json");
    const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string") {
      return pkg.version;
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}
