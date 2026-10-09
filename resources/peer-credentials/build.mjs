import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const nodeGyp = require.resolve("node-gyp/bin/node-gyp.js");
const compilerEnv =
  process.platform === "linux"
    ? { CC: "/usr/bin/gcc", CXX: "/usr/bin/g++", PATH: `/usr/bin:${process.env.PATH ?? ""}` }
    : process.platform === "darwin"
      ? { CC: "clang", CXX: "clang++", PATH: `/usr/bin:/bin:${process.env.PATH ?? ""}` }
      : {};
const result = spawnSync(process.execPath, [nodeGyp, "rebuild", "--directory", here], {
  cwd: root,
  env: { ...process.env, ...compilerEnv },
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);

const built = join(here, "build", "Release", "stellar_peer_credentials.node");
const outputDir = join(root, "resources", "bin");
mkdirSync(outputDir, { recursive: true });
copyFileSync(built, join(outputDir, "stellar-peer-credentials.node"));
