/**
 * Build a single-file local plugin: dist/opencode-run-stats.js
 *
 * opencode (v1 and v2) auto-loads every .js file and package directory under
 * ~/.config/opencode/plugins/ and registers every exported function as a
 * plugin. One file that exports only RunStats avoids double-loading.
 *
 * Requires Bun (opencode ships it): bun build.
 */
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";

const dir = dirname(fileURLToPath(import.meta.url));

execFileSync(
  "bun",
  ["build", "index.js", "--outfile", "dist/opencode-run-stats.js", "--target", "node", "--format", "esm"],
  { cwd: dir, stdio: "inherit" },
);

console.log(`wrote dist/opencode-run-stats.js (${statSync(`${dir}/dist/opencode-run-stats.js`).size} bytes)`);
