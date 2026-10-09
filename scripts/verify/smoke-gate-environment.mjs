import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const vitestCli = join(projectRoot, "node_modules", "vitest", "vitest.mjs");
const child = spawn(
  process.execPath,
  [vitestCli, "run", "tests/unit/gate-runner-environment.test.ts"],
  { cwd: projectRoot, stdio: "inherit" },
);
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code) => resolve(code ?? 1));
});
if (exitCode !== 0) {
  process.exitCode = Number(exitCode);
} else {
  console.log("[PASS] Gate runner environment regression measured with real Git and bubblewrap.");
}
