import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareGateIsolation, resolveCommonGitDir, teardownGateIsolation } from "../../src/main/gate-isolation";
import { runTaskGates } from "../../src/main/gate-runner";
import { buildSandboxedBashArgs, findSandboxBinary } from "../../src/main/sandbox";

/**
 * A gate's isolated worktree must be a WORKING git checkout inside the sandbox.
 *
 * Measured: the project's own tests that need git (`resolveGitRoot(process.cwd())`,
 * the diff capture, the window label) passed on the repository tree and failed in
 * the isolated gate. A linked worktree's `.git` is a file pointing into the main
 * repository's `.git/worktrees/<name>`, and the sandbox's `--tmpfs $HOME` / `--tmpfs
 * /tmp` hide that target: every git command in there died with `fatal: not a git
 * repository`. The main repository's git directory is mounted read-only now.
 *
 * Everything here is real: real git, real worktree, real bwrap. The tests skip where
 * bubblewrap cannot start (no user namespaces), because then no gate runs at all.
 */

const cleanups: string[] = [];

function has(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const GIT_AVAILABLE = has("git", ["--version"]);
const BWRAP = findSandboxBinary();
const BWRAP_WORKS = !!BWRAP && has(BWRAP, ["--ro-bind", "/", "/", "true"]);

function makeRepo(): { dir: string; worktreeRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), "stellar-gategit-src-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "stellar-gategit-wt-"));
  cleanups.push(dir, worktreeRoot);
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "keep.txt"), "base\n");
  mkdirSync(join(dir, ".stellar"), { recursive: true });
  writeFileSync(join(dir, ".stellar", "worktree.json"), JSON.stringify({ worktreeRoot }));
  git("add", "-A");
  git("commit", "-qm", "base subject");
  writeFileSync(join(dir, "keep.txt"), "base\nchanged by the task\n");
  return { dir, worktreeRoot };
}

describe.skipIf(!GIT_AVAILABLE)("prepareGateIsolation — o diretório git do repo principal", () => {
  afterEach(() => {
    while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true });
  });

  it("devolve o .git comum como mount SOMENTE LEITURA, no mesmo caminho", async () => {
    const { dir } = makeRepo();
    const prep = await prepareGateIsolation({ sourceRoot: dir, files: ["keep.txt"] });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    try {
      const gitMount = prep.mounts.find((m) => m.src.endsWith(".git"));
      expect(gitMount).toEqual({ src: realpathSync(join(dir, ".git")), dest: realpathSync(join(dir, ".git")), ro: true });
    } finally {
      await teardownGateIsolation({ sourceRoot: prep.sourceRoot, worktree: prep.worktree });
    }
  });

  it("resolveCommonGitDir: absoluto, e null fora de um repositório", async () => {
    const { dir } = makeRepo();
    const prep = await prepareGateIsolation({ sourceRoot: dir, files: [] });
    if (!prep.ok) throw new Error(prep.error);
    try {
      const common = await resolveCommonGitDir(prep.worktree);
      expect(common).toBe(realpathSync(join(dir, ".git")));
    } finally {
      await teardownGateIsolation({ sourceRoot: prep.sourceRoot, worktree: prep.worktree });
    }
    const outside = mkdtempSync(join(tmpdir(), "stellar-gategit-none-"));
    cleanups.push(outside);
    expect(await resolveCommonGitDir(outside)).toBeNull();
  });
});

describe.skipIf(!GIT_AVAILABLE || !BWRAP_WORKS)("gate isolado de verdade, dentro do bwrap real", () => {
  afterEach(() => {
    while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true });
  });

  it("CONTROLE: sem o mount, o git da worktree morre dentro do sandbox (a premissa do defeito)", async () => {
    const { dir } = makeRepo();
    const prep = await prepareGateIsolation({ sourceRoot: dir, files: [] });
    if (!prep.ok) throw new Error(prep.error);
    try {
      const withoutGitMount = prep.mounts.filter((m) => !m.src.endsWith(".git"));
      const run = (mounts: typeof prep.mounts) =>
        spawnSync(BWRAP!, buildSandboxedBashArgs(prep.worktree, "git rev-parse --show-toplevel", mounts), { encoding: "utf8" });
      const broken = run(withoutGitMount);
      expect(broken.status).not.toBe(0);
      expect(broken.stderr).toMatch(/not a git repository/);
      const fixed = run(prep.mounts);
      expect(fixed.status).toBe(0);
      expect(fixed.stdout.trim()).toBe(realpathSync(prep.worktree));
    } finally {
      await teardownGateIsolation({ sourceRoot: prep.sourceRoot, worktree: prep.worktree });
    }
  });

  it("um gate `git rev-parse --show-toplevel` na worktree isolada PASSA, e vê a raiz da worktree", async () => {
    const { dir } = makeRepo();
    const result = await runTaskGates({
      taskId: "git-in-worktree",
      cardId: "A",
      cwd: dir,
      declaredRoot: dir,
      gates: ["git rev-parse --show-toplevel"],
      declaredFiles: [{ cardId: "A", paths: ["keep.txt"] }],
      sandboxBinary: BWRAP!,
      timeoutMs: 60_000,
    });
    expect(result.isolation?.mode).toBe("isolated");
    expect(result.commands[0].exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.commands[0].stdout.trim()).toBe(result.isolation!.worktree);
  });

  it("os comandos de leitura do git funcionam lá dentro: status vê o arquivo da task, log e diff idem", async () => {
    const { dir } = makeRepo();
    const result = await runTaskGates({
      taskId: "git-reads",
      cardId: "A",
      cwd: dir,
      declaredRoot: dir,
      gates: ["git status --short", "git log -1 --format=%s", "git diff HEAD --stat"],
      declaredFiles: [{ cardId: "A", paths: ["keep.txt"] }],
      sandboxBinary: BWRAP!,
      timeoutMs: 60_000,
    });
    expect(result.ok).toBe(true);
    expect(result.commands[0].stdout).toContain("keep.txt");
    expect(result.commands[1].stdout.trim()).toBe("base subject");
    expect(result.commands[2].stdout).toContain("keep.txt");
  });

  it("o gate NÃO consegue escrever no repositório real: um commit dentro do sandbox falha e o HEAD não anda", async () => {
    const { dir } = makeRepo();
    const headBefore = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const result = await runTaskGates({
      taskId: "git-ro",
      cardId: "A",
      cwd: dir,
      declaredRoot: dir,
      gates: ["git -c user.email=x@y -c user.name=x commit --allow-empty -m from-the-gate"],
      declaredFiles: [{ cardId: "A", paths: ["keep.txt"] }],
      sandboxBinary: BWRAP!,
      timeoutMs: 60_000,
    });
    expect(result.ok).toBe(false);
    expect(result.commands[0].exitCode).not.toBe(0);
    const headAfter = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(headAfter).toBe(headBefore);
    const log = execFileSync("git", ["-C", dir, "log", "--format=%s"], { encoding: "utf8" });
    expect(log).not.toContain("from-the-gate");
  });
});
