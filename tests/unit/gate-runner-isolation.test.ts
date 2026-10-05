import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskGates, type GateSpawn } from "../../src/main/gate-runner";

/**
 * ACCEPTANCE — the REAL path: two "cards" changing DIFFERENT files on the same
 * tree, one of them breaking `tsc`.
 *
 * THE DEFECT: the gate runs on the whole shared tree, so the GOOD task's `tsc`
 * picks up the neighbour card's broken `bad.ts` and comes back red — the "false
 * red on a good task" that was measured.
 *
 * THE ACCEPTANCE:
 *   - the GOOD task's gate, isolated → GREEN (only its diff is applied);
 *   - the BAD task's gate, isolated → RED (only its diff breaks it);
 *   - without attribution (shared mode) → RED for the good one, the defect.
 *
 * Everything real: real git, real worktree, real `tsc --noEmit`. Only `spawn`
 * is a seam that runs `bash -lc` on the host (without bwrap), because the
 * confinement has its own coverage and what this test measures is WHICH TREE
 * the gate measured in.
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
const TSC = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
const TSC_AVAILABLE = existsSync(TSC);

/** Runs the gate command on the host, in the cwd the bwrap argv points to —
 * ignoring the confinement flags (what matters here is WHERE it ran). */
function hostSpawn(): GateSpawn {
  return ((_file: string, args: string[], options: SpawnOptions) => {
    const chdir = args.indexOf("--chdir");
    const cwd = chdir >= 0 ? args[chdir + 1] : options.cwd;
    const lc = args.lastIndexOf("-lc");
    const command = args[lc + 1] ?? "true";
    return spawn("bash", ["-lc", command], {
      cwd,
      env: options.env,
      detached: options.detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }) as GateSpawn;
}

function makeRepo(): { dir: string; worktreeRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), "stellar-gateacc-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "stellar-gateacc-wt-"));
  cleanups.push(dir, worktreeRoot);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { noEmit: true, strict: true, skipLibCheck: true, types: [] }, include: ["*.ts"] }),
  );
  writeFileSync(join(dir, "good.ts"), "export const good: number = 1;\n");
  writeFileSync(join(dir, "bad.ts"), "export const bad: number = 1;\n");
  mkdirSync(join(dir, ".stellar"), { recursive: true });
  writeFileSync(join(dir, ".stellar", "worktree.json"), JSON.stringify({ worktreeRoot }));
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "base"]);
  // THE SHARED TREE: card A changes `good.ts` (valid); card B changes `bad.ts`
  // and BREAKS tsc. Both write to the SAME checkout.
  writeFileSync(join(dir, "good.ts"), "export const good: number = 2;\n");
  writeFileSync(join(dir, "bad.ts"), "export const bad: string = 1;\n");
  return { dir, worktreeRoot };
}

const GATE = `${process.execPath} ${TSC} --noEmit`;

describe.skipIf(!GIT_AVAILABLE || !TSC_AVAILABLE)("aceite: gate isolado por task (board 64)", () => {
  afterEach(() => {
    while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true });
  });

  it("dois cards, um quebrando o tsc: a task BOA fica VERDE isolada; a RUIM, VERMELHA; compartilhada, VERMELHA", async () => {
    const { dir } = makeRepo();
    const declared = [
      { cardId: "A", paths: ["good.ts"] },
      { cardId: "B", paths: ["bad.ts"] },
    ];

    // GOOD task (card A): isolated, only `good.ts` enters — tsc GREEN.
    const good = await runTaskGates({
      taskId: "acc-good",
      cardId: "A",
      cwd: dir,
      declaredRoot: dir,
      gates: [GATE],
      declaredFiles: declared,
      sandboxBinary: "/usr/bin/bwrap",
      spawnFn: hostSpawn(),
      timeoutMs: 60_000,
    });
    expect(good.ok).toBe(true);
    expect(good.isolation?.mode).toBe("isolated");
    expect(good.isolation?.appliedFiles).toEqual(["good.ts"]);
    expect(good.isolation?.worktree).toBeTruthy();
    // The worktree is DISPOSABLE: nothing was left.
    expect(existsSync(good.isolation!.worktree!)).toBe(false);

    // BAD task (card B): isolated, only `bad.ts` enters — tsc RED.
    const bad = await runTaskGates({
      taskId: "acc-bad",
      cardId: "B",
      cwd: dir,
      declaredRoot: dir,
      gates: [GATE],
      declaredFiles: declared,
      sandboxBinary: "/usr/bin/bwrap",
      spawnFn: hostSpawn(),
      timeoutMs: 60_000,
    });
    expect(bad.ok).toBe(false);
    expect(bad.isolation?.mode).toBe("isolated");
    expect(bad.isolation?.appliedFiles).toEqual(["bad.ts"]);

    // NO attribution: SHARED mode — the good task picks up the neighbour's
    // `bad.ts` and comes back red. It is the defect isolation closes.
    const shared = await runTaskGates({
      taskId: "acc-shared",
      cardId: "A",
      cwd: dir,
      declaredRoot: dir,
      gates: [GATE],
      sandboxBinary: "/usr/bin/bwrap",
      spawnFn: hostSpawn(),
      timeoutMs: 60_000,
    });
    expect(shared.ok).toBe(false);
    expect(shared.isolation?.mode).toBe("shared");
    expect(shared.isolation?.note).toMatch(/ÁRVORE COMPARTILHADA/);
  });

  it("arquivo declarado por DOIS cards → modo shared, com os dois ids no aviso", async () => {
    const { dir } = makeRepo();
    const good = await runTaskGates({
      taskId: "acc-dispute",
      cardId: "A",
      cwd: dir,
      declaredRoot: dir,
      gates: [GATE],
      declaredFiles: [
        { cardId: "A", paths: ["good.ts"] },
        { cardId: "B", paths: ["good.ts"] },
      ],
      sandboxBinary: "/usr/bin/bwrap",
      spawnFn: hostSpawn(),
      timeoutMs: 60_000,
    });
    expect(good.isolation?.mode).toBe("shared");
    expect(good.isolation?.disputed).toEqual([{ path: "good.ts", cardIds: ["A", "B"] }]);
    expect(good.isolation?.note).toContain("A e B");
  });
});
