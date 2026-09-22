import { describe, it, expect } from "vitest";
import { planSliceVerification, type SliceEntry } from "../../src/main/slice-verify-plan";

/**
 * O PLANO DA FATIA (task 56604aca, fase 1) — o que o shell executa.
 *
 * O que estes testes travam: cada ARQUIVO carrega a sua VIA (tracked = patch;
 * untracked = cópia + `add -N` DENTRO do worktree), o symlink do `node_modules`
 * existe (é o procedimento do repo e é o que faz `tsc`/`vitest` rodarem lá), os
 * gates rodam NO WORKTREE, e a limpeza é o ÚLTIMO passo — sempre.
 */

const REPO = "/repo";
const WT = "/tmp/wt-fatia";

const tracked = (path: string): SliceEntry => ({ path, tracked: true });
const untracked = (path: string): SliceEntry => ({ path, tracked: false });

function plan(entries: SliceEntry[], gates: string[] = []) {
  return planSliceVerification({
    repoRoot: REPO,
    worktree: WT,
    patchFile: "/tmp/fatia.patch",
    entries,
    gates,
  });
}

describe("vias por arquivo", () => {
  it("tracked: patch coletado no repo e aplicado no worktree", () => {
    const p = plan([tracked("src/main/a.ts")]);

    const collect = p.steps.find((s) => s.kind === "collect-patch")!;
    expect(collect.argv).toEqual([
      "git",
      "-C",
      REPO,
      "diff",
      "--binary",
      "HEAD",
      "--",
      "src/main/a.ts",
    ]);
    expect(collect.outFile).toBe("/tmp/fatia.patch");

    const apply = p.steps.find((s) => s.kind === "apply-patch")!;
    expect(apply.argv).toEqual(["git", "-C", WT, "apply", "/tmp/fatia.patch"]);
    expect(p.steps.some((s) => s.kind === "copy-untracked")).toBe(false);
  });

  it("untracked: COPIA o arquivo e marca `add -N` DENTRO do worktree (o patch não o carrega)", () => {
    const p = plan([untracked("src/main/novo.ts")]);

    // Caminho RELATIVO com cwd no repo: com o absoluto, o `cp --parents`
    // recriaria `/home/...` dentro do worktree.
    const copy = p.steps.find((s) => s.kind === "copy-untracked")!;
    expect(copy.argv).toEqual(["cp", "--parents", "src/main/novo.ts", WT]);
    expect(copy.cwd).toBe(REPO);
    expect(copy.file).toBe("src/main/novo.ts");

    const intent = p.steps.find((s) => s.kind === "intent-to-add")!;
    expect(intent.argv).toEqual(["git", "-C", WT, "add", "-N", "--", "src/main/novo.ts"]);
    expect(intent.cwd).toBe(WT);
    // Sem tracked não há patch nenhum a coletar.
    expect(p.steps.some((s) => s.kind === "collect-patch")).toBe(false);
  });

  it("a VIA de cada arquivo vai no plano — é o que a tela diz", () => {
    const p = plan([tracked("src/main/a.ts"), untracked("src/main/b.ts")]);

    expect(p.routes).toEqual([
      { path: "src/main/a.ts", route: "tracked-patch" },
      { path: "src/main/b.ts", route: "untracked-copy" },
    ]);
  });
});

describe("infraestrutura e ordem", () => {
  it("o worktree nasce e o node_modules entra por SYMLINK (o procedimento do repo)", () => {
    const p = plan([tracked("a.ts")]);

    const add = p.steps.find((s) => s.kind === "worktree-add")!;
    expect(add.argv).toEqual(["git", "-C", REPO, "worktree", "add", WT, "HEAD"]);
    const link = p.steps.find((s) => s.kind === "node-modules-symlink")!;
    expect(link.argv).toEqual(["ln", "-s", `${REPO}/node_modules`, `${WT}/node_modules`]);
    // O worktree antes do symlink, sempre.
    expect(p.steps.indexOf(add)).toBeLessThan(p.steps.indexOf(link));
  });

  it("os gates rodam NO WORKTREE, na ordem declarada, por argv de `bash -lc`", () => {
    const p = plan([tracked("a.ts")], ["npx tsc --noEmit", "npx vitest run"]);
    const gates = p.steps.filter((s) => s.kind === "gate");

    expect(gates.map((g) => g.command)).toEqual(["npx tsc --noEmit", "npx vitest run"]);
    expect(gates.every((g) => g.cwd === WT)).toBe(true);
    expect(gates[0].argv).toEqual(["bash", "-lc", "npx tsc --noEmit"]);
  });

  it("a LIMPEZA é o último passo, sempre — inclusive quando um gate falha", () => {
    const p = plan([tracked("a.ts"), untracked("b.ts")], ["npx tsc --noEmit"]);

    const last = p.steps[p.steps.length - 1];
    expect(last.kind).toBe("cleanup");
    expect(last.argv).toEqual(["git", "-C", REPO, "worktree", "remove", "--force", WT]);
  });
});
