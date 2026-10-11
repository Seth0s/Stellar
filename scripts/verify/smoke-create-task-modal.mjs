/**
 * Isolated smoke: form → create_task contract via unit suite (no Electron).
 * Run: node scripts/verify/smoke-create-task-modal.mjs
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const r = spawnSync(
  process.execPath,
  [
    join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "tests/unit/create-task-form-decisions.test.ts",
    "tests/unit/create-task-ipc.test.ts",
  ],
  { cwd: root, encoding: "utf8" },
);
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
if (r.status !== 0) {
  console.error("smoke-create-task-modal: vitest failed");
  process.exit(r.status ?? 1);
}
console.log("smoke-create-task-modal: ok");
