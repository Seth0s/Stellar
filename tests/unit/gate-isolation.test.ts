import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { prepareGateIsolation, teardownGateIsolation } from "../../src/main/gate-isolation";
import { buildSandboxedBashArgs } from "../../src/main/sandbox";

/**
 * THE PREPARATION of the isolated worktree — against a real git repository.
 *
 * What these tests lock:
 *   - the worktree is born from HEAD and receives ONLY the declared files
 *     (tracked by patch, untracked by copy), without touching the shared tree;
 *   - `node_modules` is reachable by SYMLINK (light copy) and the mount the
 *     sandbox needs is RETURNED — without it, bwrap's `--tmpfs $HOME` would hide
 *     the target;
 *   - cleanup removes the worktree from disk, including when the mode ends in
 *     failure.
 */

const cleanups: string[] = [];

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const GIT_AVAILABLE = hasGit();

function makeRepo(): { dir: string; worktreeRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), "stellar-gateiso-src-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "stellar-gateiso-wt-"));
  cleanups.push(dir, worktreeRoot);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  writeFileSync(join(dir, "keep.txt"), "base\n");
  writeFileSync(join(dir, "del.txt"), "vai sumir\n");
  mkdirSync(join(dir, ".stellar"), { recursive: true });
  writeFileSync(join(dir, ".stellar", "worktree.json"), JSON.stringify({ worktreeRoot }));
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "base"]);
  return { dir, worktreeRoot };
}

describe.skipIf(!GIT_AVAILABLE)("prepareGateIsolation — repo git real", () => {
  afterEach(() => {
    while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true });
  });

  it("aplica SÓ os arquivos declarados na worktree e NÃO toca a árvore de origem", async () => {
    const { dir, worktreeRoot } = makeRepo();
    // The task's changes (the "card" API): modify tracked, create untracked,
    // delete another tracked.
    writeFileSync(join(dir, "keep.txt"), "base\nchange\n");
    writeFileSync(join(dir, "novo.txt"), "novo\n");
    rmSync(join(dir, "del.txt"));

    const prep = await prepareGateIsolation({ sourceRoot: dir, files: ["keep.txt", "novo.txt", "del.txt"] });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;

    expect(prep.worktree.startsWith(worktreeRoot)).toBe(true);
    // Only the declared ones entered.
    expect(readFileSync(join(prep.worktree, "keep.txt"), "utf8")).toBe("base\nchange\n");
    expect(readFileSync(join(prep.worktree, "novo.txt"), "utf8")).toBe("novo\n");
    expect(existsSync(join(prep.worktree, "del.txt"))).toBe(false);
    expect(prep.applied.sort()).toEqual(["del.txt", "keep.txt", "novo.txt"]);
    // The source tree still has its work (nothing there was reverted).
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("base\nchange\n");

    await teardownGateIsolation(prep);
    expect(existsSync(prep.worktree)).toBe(false);
  });

  it("node_modules vira SYMLINK (cópia leve) e o mount do sandbox é devolvido", async () => {
    const { dir } = makeRepo();
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "marker.txt"), "dep\n");

    const prep = await prepareGateIsolation({ sourceRoot: dir, files: [] });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;

    const linked = join(prep.worktree, "node_modules");
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(linked, "marker.txt"), "utf8")).toBe("dep\n");
    // The mount re-exposes the symlink TARGET (the repo, under $HOME), which
    // bwrap's `--tmpfs $HOME` would hide.
    expect(prep.mounts).toEqual([{ src: join(dir, "node_modules"), dest: join(dir, "node_modules"), ro: false }]);

    await teardownGateIsolation(prep);
  });

  it("arquivo limpo/ausente na declaração não vira aplicação — ausência é dado", async () => {
    const { dir } = makeRepo();
    const prep = await prepareGateIsolation({ sourceRoot: dir, files: ["keep.txt", "nao-existe.txt"] });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    // `keep.txt` is clean (equal to HEAD) → nothing to apply; the worktree
    // comes out of HEAD with it intact.
    expect(prep.applied).toEqual([]);
    expect(readFileSync(join(prep.worktree, "keep.txt"), "utf8")).toBe("base\n");
    await teardownGateIsolation(prep);
  });
});

describe("buildSandboxedBashArgs — mounts extras do modo isolado", () => {
  it("sem mounts o argv é o de sempre (compatibilidade)", () => {
    const base = buildSandboxedBashArgs("/tmp/root", "echo hi");
    expect(buildSandboxedBashArgs("/tmp/root", "echo hi", [])).toEqual(base);
  });

  it("mount extra entra DEPOIS do tmpfs do $HOME — é a única posição que reexpõe", () => {
    const args = buildSandboxedBashArgs("/tmp/root", "echo hi", [
      { src: "/home/u/repo/node_modules", dest: "/home/u/repo/node_modules", ro: false },
    ]);
    const tmpfsHome = args.indexOf(homedir());
    const bind = args.indexOf("/home/u/repo/node_modules");
    const chdir = args.indexOf("--chdir");
    expect(bind).toBeGreaterThan(tmpfsHome);
    expect(bind).toBeLessThan(chdir);
    // `ro:false` is the `--bind` (RW) the vitest cache needs.
    expect(args[bind - 1]).toBe("--bind");
    // The default is `--ro-bind`.
    const ro = buildSandboxedBashArgs("/tmp/root", "x", [{ src: "/a", dest: "/a" }]);
    expect(ro[ro.indexOf("/a") - 1]).toBe("--ro-bind");
  });
});

