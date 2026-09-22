import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureDiff, describeDiffAuthorship, isInsideTerritory, runTaskGates } from "../../src/main/gate-runner";

/**
 * O diff anexado à task (task 7096e8af) — captura, rótulo honesto e
 * truncamento.
 *
 * O que estes testes travam:
 *   - o app observa MUDANÇA, e a redação NUNCA afirma AUTORIA numa árvore
 *     compartilhada (cinco cards no mesmo checkout);
 *   - o território declarado é RÓTULO, nunca filtro: arquivo fora do
 *     território APARECE e é CONTADO, não descartado (medido: 75,5% dos
 *     arquivos declarados caem fora — filtrar apagaria o desvio, que é o
 *     motivo de alguém querer ver o diff);
 *   - untracked entra na lista (não tem patch, mas mudou);
 *   - o truncamento é o MESMO do gate (mesma constante, com marca), não uma
 *     disciplina paralela que diverge na primeira mudança.
 */

type GitResult = { ok: boolean; stdout: string; truncated: boolean };

function fakeGit(table: Record<string, Partial<GitResult>>) {
  return async (args: string[]): Promise<GitResult> => {
    const key = args.join(" ");
    const hit = table[key];
    if (!hit) return { ok: true, stdout: "", truncated: false };
    return { ok: hit.ok ?? true, stdout: hit.stdout ?? "", truncated: hit.truncated ?? false };
  };
}

const STATUS = [
  " M src/main/pty-registry.ts",
  "?? src/main/card-status-decision.ts",
  " M src/renderer/src/ProvidersPage.tsx",
  " M docs/fora-do-territorio.md",
].join("\n");

describe("captureDiff", () => {
  it("rotula dentro/fora do território e CONTA os de fora — sem descartar nenhum", async () => {
    const diff = await captureDiff({
      gitRoot: "/repo",
      territory: ["src/main/pty-registry.ts"],
      gitFn: fakeGit({
        "status --porcelain=v1": { stdout: STATUS },
        "diff --stat": { stdout: " 3 files changed" },
        diff: { stdout: "--- a/src/main/pty-registry.ts\n+++ b/..." },
      }),
    });

    expect(diff.total).toBe(4);
    // Três fora do território declarado (o próprio pty-registry é o único dentro).
    expect(diff.outsideTerritory).toBe(3);
    // O ponto central: o de FORA aparece na lista, não é filtrado.
    expect(diff.files.map((f) => f.path)).toContain("docs/fora-do-territorio.md");
    expect(diff.files.find((f) => f.path === "src/main/pty-registry.ts")?.inTerritory).toBe(true);
    expect(diff.files.find((f) => f.path === "docs/fora-do-territorio.md")?.inTerritory).toBe(false);
    // Untracked entra na lista: mudou, mesmo sem patch.
    expect(diff.files.find((f) => f.path === "src/main/card-status-decision.ts")?.status).toBe("??");
  });

  it("a redação NUNCA soa como autoria — diz o que o app não sabe", async () => {
    const diff = await captureDiff({
      gitRoot: "/repo",
      territory: ["src/main/pty-registry.ts"],
      gitFn: fakeGit({ "status --porcelain=v1": { stdout: STATUS } }),
    });
    expect(diff.note).toContain("mudaram nesta janela");
    expect(diff.note).toContain("3 deles fora do território declarado");
    // A frase que impede um revisor apressado de ler "fulano tocou X".
    expect(diff.note).toContain("MUDANÇA");
    expect(diff.note).toContain("não AUTORIA");
    expect(diff.note).toContain("não sabe dizer");
  });

  it("sem território declarado: NÃO inventa rótulo, e DIZ isso", async () => {
    const diff = await captureDiff({
      gitRoot: "/repo",
      territory: null,
      gitFn: fakeGit({ "status --porcelain=v1": { stdout: STATUS } }),
    });
    expect(diff.outsideTerritory).toBe(0);
    expect(diff.files.every((f) => f.territoryDeclared === false)).toBe(true);
    expect(diff.note).toContain("não declarou território");
  });

  it("marca de truncamento vem da captura (diff truncado que não se anuncia é mentira)", async () => {
    const diff = await captureDiff({
      gitRoot: "/repo",
      territory: [],
      gitFn: fakeGit({ diff: { stdout: "corpo cortado", truncated: true } }),
    });
    expect(diff.patchTruncated).toBe(true);
    expect(diff.patch).toBe("corpo cortado");
  });

  // O TETO VALE PARA A LISTA TAMBÉM (task 56604aca): o patch já dizia que
  // truncou, a lista de caminhos não dizia — e ela é justamente de onde sai
  // "N arquivos mudaram". Hoje a maior lista medida tem 48 caminhos (~3 KB)
  // contra 16 KB de teto, e é exatamente esse "hoje não chega perto" que o teto
  // do patch já desmentiu uma vez.
  it("a lista de caminhos DECLARA o próprio truncamento, em vez de prometer completude", async () => {
    const diff = await captureDiff({
      gitRoot: "/repo",
      territory: [],
      gitFn: fakeGit({
        "status --porcelain=v1": { stdout: STATUS, truncated: true },
        diff: { stdout: "corpo" },
      }),
    });

    expect(diff.filesTruncated).toBe(true);
    // O que chegou continua na lista: o truncamento é um AVISO, nunca um filtro.
    expect(diff.files.map((f) => f.path)).toContain("docs/fora-do-territorio.md");
    // E sem truncamento o campo diz que não — nunca inferido do tamanho.
    const inteira = await captureDiff({
      gitRoot: "/repo",
      territory: [],
      gitFn: fakeGit({ "status --porcelain=v1": { stdout: STATUS } }),
    });
    expect(inteira.filesTruncated).toBe(false);
  });

  it("sem repositório, lista vazia é COMPLETA — truncamento seria perder o que não existiu", async () => {
    const diff = await captureDiff({ gitRoot: null });
    expect(diff.filesTruncated).toBe(false);
  });

  it("cwd que não é repo: nada de diff, e a ausência é explicada", async () => {
    const diff = await captureDiff({ gitRoot: null, territory: ["x"] });
    expect(diff.gitRoot).toBeNull();
    expect(diff.files).toEqual([]);
    expect(diff.note).toContain("não é um repositório git");
  });
});

// ---------------------------------------------------------------------------
// O TETO DE CAPTURA (task 56604aca) — este bloco usa `git` DE VERDADE, e é o
// único lugar da suíte onde o coletor roda: todos os testes acima passam um
// `gitFn` falso, que devolve string já pronta e por isso NUNCA exercita o teto.
//
// O que ele trava, e é a razão de existir: a captura guardava a CAUDA do diff,
// e a cauda de uma árvore real com 48 arquivos sujos tinha 2 a 6 arquivos — e
// ZERO de `src/main` em 29 patches medidos. Ou seja, o arquivo que alguém
// precisa separar era exatamente o que o teto comia.
// ---------------------------------------------------------------------------
describe("o teto do diff guarda a CABEÇA, não a cauda", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  /** Repo de verdade com N arquivos alterados cujo diff passa de 16 KB. */
  function repoWithBigDiff(count: number): string {
    const dir = mkdtempSync(join(tmpdir(), "stellar-diffcap-"));
    dirs.push(dir);
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git(["init", "-q"]);
    git(["config", "user.email", "teste@teste"]);
    git(["config", "user.name", "teste"]);
    const names = Array.from({ length: count }, (_, i) => `f${String(i).padStart(2, "0")}.txt`);
    for (const n of names) writeFileSync(join(dir, n), "base\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "base"]);
    // Cada arquivo ganha ~3,6 KB de diff: 8 arquivos já passam dos 16 KB.
    for (const n of names) writeFileSync(join(dir, n), "y\n".repeat(900));
    return dir;
  }

  it("o patch retido tem os PRIMEIROS arquivos; o que se perde é a cauda", async () => {
    const dir = repoWithBigDiff(8);

    const diff = await captureDiff({ gitRoot: dir, territory: null });

    expect(diff.patchTruncated).toBe(true);
    // A cabeça está lá: o primeiro arquivo em ordem alfabética.
    expect(diff.patch).toContain("diff --git a/f00.txt");
    // A cauda é o que se perde — e é isso que o conserto assume.
    expect(diff.patch).not.toContain("diff --git a/f07.txt");
    // A LISTA de caminhos não é truncada por isso: 8 mudanças, 8 entradas.
    expect(diff.files.map((f) => f.path).sort()).toEqual([
      "f00.txt",
      "f01.txt",
      "f02.txt",
      "f03.txt",
      "f04.txt",
      "f05.txt",
      "f06.txt",
      "f07.txt",
    ]);
  });

  it("sem estourar o teto nada muda: patch inteiro, sem marca de truncamento", async () => {
    const dir = repoWithBigDiff(1);

    const diff = await captureDiff({ gitRoot: dir, territory: null });

    expect(diff.patchTruncated).toBe(false);
    expect(diff.patch).toContain("diff --git a/f00.txt");
    expect(diff.patch).toContain("+y");
  });
});

describe("isInsideTerritory", () => {
  it("aceita caminho exato, prefixo de diretório, e a entrada com prosa (43 das 366 são assim)", () => {
    expect(isInsideTerritory("src/main/store.ts", ["src/main/store.ts"])).toBe(true);
    expect(isInsideTerritory("src/main/sub/a.ts", ["src/main"])).toBe(true);
    // Medido no banco: entradas como `src/main (browser tools)` e `src/renderer/src (Fila)`.
    expect(isInsideTerritory("src/renderer/src/App.tsx", ["src/renderer/src (Fila)"])).toBe(true);
    expect(isInsideTerritory("src/renderer/src/App.tsx", ["(Fila)"])).toBe(false);
    expect(isInsideTerritory("src/other/a.ts", ["src/main"])).toBe(false);
  });
});

describe("describeDiffAuthorship", () => {
  it("sem território declarado não finge um rótulo", () => {
    const note = describeDiffAuthorship(2, 0, false);
    expect(note).toContain("não declarou território");
    expect(note).not.toContain("fora do território declarado");
  });
});

describe("runTaskGates anexa o diff à evidência", () => {
  it("a evidência carrega `diff` ao lado do contrato — sem sandbox o gate recusa, e o diff ainda é observado", async () => {
    const evidence = await runTaskGates({
      taskId: "t1",
      // O cwd REAL (o vitest roda na raiz do repo): é ele que faz
      // `resolveGitRoot` achar o gitRoot. A observação do diff continua sendo
      // o fake — o teste não lê o working tree de verdade.
      cwd: process.cwd(),
      // Desde 2026-09-21 o runner RECUSA sem raiz declarada; aqui a raiz é o
      // próprio cwd do repo, que é onde este teste roda.
      declaredRoot: process.cwd(),
      gates: ["npx tsc --noEmit"],
      // Sem bwrap: os comandos viram recusa (comportamento existente), mas a
      // captura do diff é observação independente do gate.
      sandboxBinary: null,
      territory: ["src/main/pty-registry.ts"],
      gitFn: fakeGit({ "status --porcelain=v1": { stdout: STATUS } }),
    });
    expect(evidence.diff).toBeDefined();
    expect(evidence.diff!.total).toBe(4);
    expect(evidence.diff!.files.some((f) => f.path === "docs/fora-do-territorio.md")).toBe(true);
    // O veredito do gate continua sendo o exit code, não a observação.
    expect(evidence.ok).toBe(false);
  });
});
