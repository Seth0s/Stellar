/**
 * THE PREPARATION of a gate's isolated worktree — the I/O boundary of the pure
 * decision in `gate-isolation-decision.ts`.
 *
 * It reuses `prepareIsolatedWorktree` (the SAME preparation used by
 * `spawn_agent({isolation:"worktree"})`): a disposable worktree of HEAD under a
 * SHORT path (Unix socket, 108 bytes — docs/ORCHESTRATION.md §15) plus the
 * paths the `.gitignore` hides and the project declared in
 * `.stellar/worktree.json`.
 *
 * ON TOP OF THAT, this module applies ONLY the task's changes:
 *   - TRACKED (M/A/D/R) → `git diff --binary HEAD -- <paths>` collected from the
 *     source tree and `git apply` INSIDE the worktree (the repository's own
 *     route, already proven in `slice-verify-plan.ts`; binary and deletion come
 *     along);
 *   - UNTRACKED (`??`) → the file is COPIED into the worktree (plus `add -N`
 *     there, so a gate's `git status`/`git diff` also sees it).
 * None of this is written to the shared tree: the patch runs with cwd in the
 * worktree.
 *
 * NODE_MODULES. The gate runs confined (`bwrap`), and the sandbox's
 * `--tmpfs $HOME` masks everything under `$HOME` outside the re-bound root. The
 * worktree is born in `/tmp`, so a `node_modules` SYMLINK to the repo (under
 * `$HOME`) resolves on the host and stays INVISIBLE inside the sandbox —
 * measured on this machine: the symlink disappears and `require.resolve`
 * fails. For the symlink to hold in there, we return an explicit MOUNT
 * (`sandboxBinds`) that the gate-runner passes to `buildSandboxedBashArgs`; the
 * symlink is the LIGHT copy (the alternative was copying the whole
 * `node_modules` into `/tmp`, expensive). The mount is RW because vitest writes
 * cache in `node_modules/.vite` — the same the gate in the shared tree already
 * does.
 *
 * THE GIT DIRECTORY. A linked worktree's `.git` is a FILE: `gitdir: <repo>/.git/
 * worktrees/<name>`. That target lives in the main repository — under `$HOME`, or
 * in `/tmp` — and the sandbox masks both (`--tmpfs $HOME`, `--tmpfs /tmp`), so
 * inside it every git command in the worktree died with `fatal: not a git
 * repository` (measured: `git rev-parse --show-toplevel` exit 128; the project's own
 * tests that need git failed on a green tree). The main repository's COMMON git
 * directory is therefore mounted READ-ONLY at the same path: the worktree stays a
 * working checkout for `rev-parse`, `status`, `diff`, `log`, and the gate still
 * cannot write objects or refs of the real repository. Git writes that need the
 * real repository (a commit, a new ref) fail loudly, which is the point.
 *
 * CLEANUP IS ALWAYS THE LAST STEP, including on failure: an orphan worktree on
 * a machine with six streams is pain. `removeIsolatedWorktree` does the
 * `git worktree remove --force` and prunes dead references.
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { prepareIsolatedWorktree, removeIsolatedWorktree } from "./worktree-prep";

const execFileAsync = promisify(execFile);

/** An extra mount the sandbox must see (the `node_modules` symlink target,
 * which the `--tmpfs $HOME` would hide). */
export type GateIsolationMount = { src: string; dest: string; ro: boolean };

export type GateIsolationPrep =
  | {
      ok: true;
      /** The cwd where the gates run. */
      worktree: string;
      /** The git root the worktree was created from (for teardown). */
      sourceRoot: string;
      /** Paths that were actually applied (tracked + dirty untracked). */
      applied: string[];
      /** Extra mounts for the sandbox: `node_modules` when symlinked, and the main
       * repository's git directory (read-only) so git works in the worktree. */
      mounts: GateIsolationMount[];
    }
  | { ok: false; error: string; applied: string[] };

type GitResult = { code: number; stdout: string; stderr: string };

/** `git -C <cwd> …`, never throwing. */
async function git(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    if (err.code === "ENOENT") return { code: 127, stdout: "", stderr: "git: command not found on PATH" };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: (err.stderr ?? err.message ?? "").toString(),
    };
  }
}

/**
 * Applies only the declared files INSIDE the worktree. Returns the paths that
 * were actually changed (what the source `git status` reports as dirty), so the
 * note states the exact set.
 */
async function applyDeclaredFiles(input: {
  sourceRoot: string;
  worktree: string;
  files: readonly string[];
}): Promise<{ ok: true; applied: string[] } | { ok: false; error: string; applied: string[] }> {
  if (input.files.length === 0) return { ok: true, applied: [] };
  const status = await git(["status", "--porcelain=v1", "-uall", "--", ...input.files], input.sourceRoot);
  if (status.code !== 0) {
    return { ok: false, applied: [], error: `git status failed: ${status.stderr.trim() || `exit ${status.code}`}` };
  }
  const tracked: string[] = [];
  const untracked: string[] = [];
  const applied: string[] = [];
  for (const line of status.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const code = line.slice(0, 2).trim() || "??";
    let path = line.slice(3).trim();
    if (path.includes(" -> ")) path = path.split(" -> ").pop()!.trim();
    path = path.replace(/^"|"$/g, "");
    if (path === "") continue;
    applied.push(path);
    if (code === "??") untracked.push(path);
    else tracked.push(path);
  }

  if (tracked.length > 0) {
    const diff = await git(["diff", "--binary", "HEAD", "--", ...tracked], input.sourceRoot);
    if (diff.code !== 0) {
      return { ok: false, applied, error: `git diff HEAD failed: ${diff.stderr.trim() || `exit ${diff.code}`}` };
    }
    const patchFile = join(dirname(input.worktree), `${basename(input.worktree)}.patch`);
    try {
      await writeFile(patchFile, diff.stdout, "utf8");
      const appliedPatch = await git(["apply", "--whitespace=nowarn", patchFile], input.worktree);
      if (appliedPatch.code !== 0) {
        return {
          ok: false,
          applied,
          error: `git apply failed in the worktree: ${(appliedPatch.stderr || appliedPatch.stdout).trim() || `exit ${appliedPatch.code}`}`,
        };
      }
    } finally {
      await rm(patchFile, { force: true });
    }
  }

  for (const path of untracked) {
    const isDir = safeIsDir(join(input.sourceRoot, path));
    try {
      await execFileAsync("cp", isDir ? ["-r", "--parents", path, input.worktree] : ["--parents", path, input.worktree], {
        cwd: input.sourceRoot,
      });
    } catch (e) {
      return { ok: false, applied, error: `copying untracked "${path}" failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    // `add -N` INSIDE the worktree (its own index): a gate's diff also sees it.
    await git(["add", "-N", "--", path], input.worktree);
  }

  return { ok: true, applied };
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The absolute path of the repository's COMMON git directory as seen from the
 * worktree (`<main repo>/.git`, even when the source tree is itself a linked
 * worktree), or `null` when git cannot say or it is not a directory. It is the
 * directory the worktree's `.git` file points into, so it is what the sandbox has
 * to expose.
 */
export async function resolveCommonGitDir(worktree: string): Promise<string | null> {
  const res = await git(["rev-parse", "--git-common-dir"], worktree);
  if (res.code !== 0) return null;
  const raw = res.stdout.trim();
  if (raw === "") return null;
  // Relative answers (`.git`) are relative to the worktree; absolute ones pass through.
  const abs = isAbsolute(raw) ? raw : resolve(worktree, raw);
  return safeIsDir(abs) ? abs : null;
}

/**
 * Creates the isolated worktree, makes `node_modules` reachable and applies
 * only the declared paths. Never throws: every failure resolves to `{ ok:false
 * }` with the real reason, and ROLLS BACK any worktree it created.
 */
export async function prepareGateIsolation(opts: {
  sourceRoot: string;
  files: readonly string[];
}): Promise<GateIsolationPrep> {
  const prep = await prepareIsolatedWorktree({ sourceCwd: opts.sourceRoot });
  if (!prep.ok) return { ok: false, error: prep.error, applied: [] };

  const worktree = prep.path;
  const sourceRoot = prep.sourceRoot;
  const rollback = async (error: string, applied: string[]): Promise<GateIsolationPrep> => {
    await removeIsolatedWorktree({ sourceRoot, path: worktree });
    return { ok: false, error, applied };
  };

  const mounts: GateIsolationMount[] = [];
  const nmSource = join(sourceRoot, "node_modules");
  const nmDest = join(worktree, "node_modules");
  if (existsSync(nmSource) && !existsSync(nmDest)) {
    try {
      await symlink(nmSource, nmDest, "dir");
      // The symlink points outside the worktree; the sandbox's `--tmpfs $HOME`
      // would hide the target, so the SAME path is re-exposed via a mount.
      mounts.push({ src: nmSource, dest: nmSource, ro: false });
    } catch (e) {
      return await rollback(
        `linking node_modules into the worktree failed: ${e instanceof Error ? e.message : String(e)}`,
        [],
      );
    }
  }

  const gitDir = await resolveCommonGitDir(worktree);
  if (gitDir) mounts.push({ src: gitDir, dest: gitDir, ro: true });

  const applied = await applyDeclaredFiles({ sourceRoot, worktree, files: opts.files });
  if (!applied.ok) return await rollback(applied.error, applied.applied);

  return { ok: true, worktree, sourceRoot, applied: applied.applied, mounts };
}

/** Best-effort teardown of the isolated worktree — success or failure, it is
 * always removed. */
export async function teardownGateIsolation(prep: { sourceRoot: string; worktree: string }): Promise<void> {
  await removeIsolatedWorktree({ sourceRoot: prep.sourceRoot, path: prep.worktree });
}
