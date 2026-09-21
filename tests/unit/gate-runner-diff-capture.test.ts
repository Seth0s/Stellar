import { describe, it, expect } from "vitest";
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

  it("cwd que não é repo: nada de diff, e a ausência é explicada", async () => {
    const diff = await captureDiff({ gitRoot: null, territory: ["x"] });
    expect(diff.gitRoot).toBeNull();
    expect(diff.files).toEqual([]);
    expect(diff.note).toContain("não é um repositório git");
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
