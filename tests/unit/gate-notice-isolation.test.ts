import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideGateIsolation } from "../../src/main/gate-isolation-decision";
import { runTaskGates, type GateSpawn } from "../../src/main/gate-runner";

/**
 * TERRITORY AUGMENTATION of isolation. The defect: isolation used only the
 * DECLARED `filesChanged` — a card that forgets to declare a changed file
 * inside its own territory got a FALSE GREEN (the file never entered the
 * gate). The fix: dirty files of the territory that no card declared ENTER
 * the isolated set.
 *
 * Two layers: the pure decision (the augment and the exclusion of files
 * another card declared) and the REAL path (git + worktree + tsc), which
 * proves the second territory file actually turns the gate red.
 */

describe("decideGateIsolation: acréscimo do território (puro)", () => {
  const REPO = "/repo";

  it("declara 1 de 2 arquivos do território → os DOIS entram; o não-declarado é listado", () => {
    const d = decideGateIsolation({
      cardId: "A",
      declared: [{ cardId: "A", paths: ["src/a.ts"] }],
      gitRoot: REPO,
      territoryDirty: ["src/a.ts", "src/b.ts"],
    });
    expect(d.mode).toBe("isolated");
    expect(d.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(d.undeclaredInTerritory).toEqual(["src/b.ts"]);
  });

  it("território sujo já declarado por OUTRO card fica de fora (disputa não vira palpite)", () => {
    const d = decideGateIsolation({
      cardId: "A",
      declared: [
        { cardId: "A", paths: ["src/a.ts"] },
        { cardId: "B", paths: ["src/b.ts"] },
      ],
      gitRoot: REPO,
      territoryDirty: ["src/a.ts", "src/b.ts"],
    });
    expect(d.mode).toBe("isolated");
    expect(d.files).toEqual(["src/a.ts"]);
    expect(d.undeclaredInTerritory).toEqual([]);
  });

  it("sem `territoryDirty` nada muda — o comportamento declarado de sempre", () => {
    const d = decideGateIsolation({
      cardId: "A",
      declared: [{ cardId: "A", paths: ["src/a.ts"] }],
      gitRoot: REPO,
    });
    expect(d.files).toEqual(["src/a.ts"]);
    expect(d.undeclaredInTerritory).toEqual([]);
  });

  it("card que não declarou NADA continua `shared` — sem atribuição não se isola", () => {
    const d = decideGateIsolation({
      cardId: "A",
      declared: [{ cardId: "A", paths: [] }],
      gitRoot: REPO,
      territoryDirty: ["src/b.ts"],
    });
    expect(d.mode).toBe("shared");
    expect(d.undeclaredInTerritory).toEqual([]);
  });
});

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
const GATE = `${process.execPath} ${TSC} --noEmit`;

/** Runs the gate command on the host, in the cwd the bwrap argv points to —
 * ignoring the containment flags (what matters here is WHERE it ran). */
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

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "stellar-gate-terr-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "stellar-gate-terr-wt-"));
  cleanups.push(dir, worktreeRoot);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { noEmit: true, strict: true, skipLibCheck: true, types: [] }, include: ["src/**/*.ts"] }),
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a: number = 1;\n");
  writeFileSync(join(dir, "src", "b.ts"), "export const b: number = 1;\n");
  mkdirSync(join(dir, ".stellar"), { recursive: true });
  writeFileSync(join(dir, ".stellar", "worktree.json"), JSON.stringify({ worktreeRoot }));
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "base"]);
  // THE SHARED TREE: card A changes `src/a.ts` (valid) and ALSO `src/b.ts`
  // (broken) — but declares only `src/a.ts`. `src/b.ts` is the undeclared
  // territory file that must enter the isolated gate.
  writeFileSync(join(dir, "src", "a.ts"), "export const a: number = 2;\n");
  writeFileSync(join(dir, "src", "b.ts"), "export const b: string = 1;\n");
  return dir;
}

describe.skipIf(!GIT_AVAILABLE || !TSC_AVAILABLE)("aceite: território não declarado entra no gate isolado", () => {
  afterEach(() => {
    while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true });
  });

  it("card declara 1 de 2 arquivos do território: os DOIS entram, e o gate pega o não declarado", async () => {
    const dir = makeRepo();
    const declared = [{ cardId: "A", paths: ["src/a.ts"] }];

    // WITHOUT a declared territory: isolates only `src/a.ts` → FALSE GREEN.
    const withoutTerritory = await runTaskGates({
      taskId: "terr-none",
      cardId: "A",
      cwd: dir,
      declaredRoot: dir,
      gates: [GATE],
      declaredFiles: declared,
      sandboxBinary: "/usr/bin/bwrap",
      spawnFn: hostSpawn(),
      timeoutMs: 60_000,
    });
    expect(withoutTerritory.ok).toBe(true);
    expect(withoutTerritory.isolation?.appliedFiles).toEqual(["src/a.ts"]);

    // WITH the `src` territory: the undeclared dirty `src/b.ts` enters → red,
    // and the evidence names WHAT entered without a declaration.
    const withTerritory = await runTaskGates({
      taskId: "terr-yes",
      cardId: "A",
      cwd: dir,
      declaredRoot: dir,
      gates: [GATE],
      declaredFiles: declared,
      territory: ["src"],
      sandboxBinary: "/usr/bin/bwrap",
      spawnFn: hostSpawn(),
      timeoutMs: 60_000,
    });
    expect(withTerritory.ok).toBe(false);
    expect(withTerritory.isolation?.mode).toBe("isolated");
    expect(withTerritory.isolation?.appliedFiles.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(withTerritory.isolation?.undeclaredInTerritory).toEqual(["src/b.ts"]);
    expect(withTerritory.isolation?.note).toContain("não declarados entraram no gate");
    // The worktree is DISPOSABLE: nothing left behind.
    expect(existsSync(withTerritory.isolation!.worktree!)).toBe(false);
  });
});
