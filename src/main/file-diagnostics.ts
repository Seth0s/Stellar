/**
 * On-save Problems for the code card: run the OPEN PROJECT's own checker
 * as a subprocess in the card cwd. Never import `typescript` into main —
 * it is a devDependency and breaks packaged builds / Vite ESM inlining.
 */

import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  decideParseCheckerOutput,
  type RawCheckerDiagnostic,
} from "../shared/code-checker-output-decision";

const execFileP = promisify(execFile);

export type FileDiagnostic = RawCheckerDiagnostic;

export type ProjectDiagnoseResult =
  | { status: "ok"; diagnostics: FileDiagnostic[] }
  | { status: "no-checker" }
  | { status: "failed"; detail: string };

const TSCONFIG_NAMES = ["tsconfig.json", "tsconfig.app.json", "tsconfig.build.json"] as const;
const DIAGNOSE_TIMEOUT_MS = 90_000;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Walk up from `startDir` until `root` looking for a tsconfig. */
export async function findNearestTsconfig(root: string, startDir: string): Promise<string | null> {
  const rootAbs = resolve(root);
  let dir = resolve(startDir);
  for (;;) {
    if (!(dir === rootAbs || dir.startsWith(`${rootAbs}/`) || dir.startsWith(`${rootAbs}\\`))) {
      break;
    }
    for (const name of TSCONFIG_NAMES) {
      const candidate = join(dir, name);
      if (await exists(candidate)) return candidate;
    }
    if (dir === rootAbs) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function localTscAvailable(root: string): Promise<boolean> {
  const bin = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  if (await exists(bin)) return true;
  return exists(join(root, "node_modules", "typescript", "package.json"));
}

/**
 * Run the project's tsc (or report no-checker). `relativePath` only chooses
 * which directory to start the tsconfig walk from.
 */
export async function diagnoseProject(root: string, relativePath: string): Promise<ProjectDiagnoseResult> {
  const rootAbs = resolve(root);
  const fileAbs = resolve(rootAbs, relativePath);
  const startDir = dirname(fileAbs);
  const tsconfig = await findNearestTsconfig(rootAbs, startDir);
  if (!tsconfig) return { status: "no-checker" };
  if (!(await localTscAvailable(rootAbs))) return { status: "no-checker" };

  const configRel = relative(rootAbs, tsconfig) || "tsconfig.json";
  try {
    const { stdout, stderr } = await execFileP(
      "npx",
      ["--no-install", "tsc", "--noEmit", "-p", configRel, "--pretty", "false"],
      {
        cwd: rootAbs,
        timeout: DIAGNOSE_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: process.env,
      },
    );
    return { status: "ok", diagnostics: decideParseCheckerOutput(stdout ?? "", stderr ?? "") };
  } catch (err) {
    // tsc exits non-zero when there are type errors — still parse stdout.
    const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message?: string };
    if (e.killed) return { status: "failed", detail: `tsc timed out after ${DIAGNOSE_TIMEOUT_MS}ms` };
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    if (stdout || stderr) {
      return { status: "ok", diagnostics: decideParseCheckerOutput(stdout, stderr) };
    }
    const msg = e.message ?? String(err);
    if (/not found|ENOENT|Cannot find module|npx:.*tsc/i.test(msg)) {
      return { status: "no-checker" };
    }
    return { status: "failed", detail: msg };
  }
}
