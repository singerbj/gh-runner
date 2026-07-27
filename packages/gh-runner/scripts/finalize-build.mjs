#!/usr/bin/env node
// tsc keeps the shebang but not the executable bit. npm re-applies it on install,
// but `node dist/cli.js`-free local runs (and `npm link`) are nicer with it set here.
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = join(pkgRoot, "dist", "cli.js");

if (!existsSync(bin)) {
  console.error(`finalize-build: expected ${bin} to exist after tsc`);
  process.exit(1);
}

chmodSync(bin, 0o755);
