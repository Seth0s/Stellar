import { describe, it, expect } from "vitest";
import { describeWindowProvenance, labelGateWindow, runTaskGates } from "../../src/main/gate-runner";

/**
 * O RÓTULO DA JANELA NO NÍVEL DO RUN (task c73fcd79).
 *
 * O diff já era rotulado (7096e8af), mas o rótulo morava DENTRO de `diff` —
 * quem lê `ok:false` / `tsc exit 2` lê o VEREDITO, e foi assim que dois
 * reviewers de hoje leram o vermelho do vizinho (um `message-bus.ts` de outro
 * card, editado em voo na MESMA árvore) como se fosse da entrega.
 *
 * O que estes testes travam:
 *   - o run carrega o rótulo AO LADO do veredito, e ele DIZ que o snapshot é
 *     da árvore compartilhada e PODE conter trabalho de outro card;
 *   - o caso LIMPO (tudo dentro do território declarado) NÃO ganha alarme — um
 *     rótulo que grita sempre vira ruído e ninguém lê;
 *   - a redação NUNCA afirma autoria.
 */

const STATUS = [
  " M src/main/pty-registry.ts",
  "?? src/main/card-status-decision.ts",
  " M src/renderer/src/ProvidersPage.tsx",
  " M docs/fora-do-territorio.md",
].join("\n");

const fakeGit = (stdout: string) => async (): Promise<{ ok: boolean; stdout: string; truncated: boolean }> => ({
  ok: true,
  stdout,
  truncated: false,
});

describe("describeWindowProvenance — o que a frase pode e não pode dizer", () => {
  it("VERMELHO + mudança fora do território: DIZ que pode ser de outro card, sem afirmar autoria", () => {
    const note = describeWindowProvenance({
      ok: false,
      total: 4,
      outsideTerritory: 3,
      territoryDeclared: true,
      gitRoot: "/repo",
    });
    expect(note).toMatch(/PODE vir de outro card/);
    expect(note).toContain("MESMO checkout");
    // O app observa MUDANÇA, não AUTORIA — em nenhuma forma a frase diz QUEM.
    expect(note).toMatch(/observa MUDANÇA, nunca AUTORIA/);
    expect(note).toContain("3 de 4");
  });

  it("CASO LIMPO (tudo dentro do território declarado): sem alarme, mesmo com o gate vermelho", () => {
    const note = describeWindowProvenance({
      ok: false,
      total: 4,
      outsideTerritory: 0,
      territoryDeclared: true,
      gitRoot: "/repo",
    });
    expect(note).not.toMatch(/PODE vir de outro card/);
    expect(note).toMatch(/ÁRVORE COMPARTILHADA/);
  });

  it("verde + mudança fora: o snapshot é misto (o rótulo diz), mas não há alarme de vermelho", () => {
    const note = describeWindowProvenance({
      ok: true,
      total: 4,
      outsideTerritory: 3,
      territoryDeclared: true,
      gitRoot: "/repo",
    });
    expect(note).not.toMatch(/PODE vir de outro card/);
    expect(note).toContain("3 de 4");
  });

  it("sem território declarado: diz que não há como dizer quais mudanças são dela (não chuta)", () => {
    const note = describeWindowProvenance({
      ok: false,
      total: 2,
      outsideTerritory: 0,
      territoryDeclared: false,
      gitRoot: "/repo",
    });
    expect(note).toMatch(/não declarou território/);
    expect(note).not.toMatch(/PODE vir de outro card/);
  });

  it("sem repositório: não inventa janela", () => {
    const note = describeWindowProvenance({
      ok: false,
      total: 0,
      outsideTerritory: 0,
      territoryDeclared: false,
      gitRoot: null,
    });
    expect(note).toMatch(/não é um repositório git/);
  });
});

describe("labelGateWindow — o booleano olha a JANELA, não o veredito", () => {
  const diff = (outside: number, total: number, territoryDeclared = true) =>
    ({
      gitRoot: "/repo",
      stat: "",
      patch: "",
      patchTruncated: false,
      files: [],
      filesTruncated: false,
      total,
      outsideTerritory: outside,
      territoryDeclared,
      note: "…",
    }) as Parameters<typeof labelGateWindow>[0];

  it("janela com trabalho não declarado ⇒ mayIncludeOtherTasksWork = true (mesmo verde)", () => {
    expect(labelGateWindow(diff(3, 4), true).mayIncludeOtherTasksWork).toBe(true);
    expect(labelGateWindow(diff(3, 4), false).mayIncludeOtherTasksWork).toBe(true);
  });

  it("janela limpa ⇒ false; e janela sem repositório ⇒ false (nada observado)", () => {
    expect(labelGateWindow(diff(0, 4), false).mayIncludeOtherTasksWork).toBe(false);
    expect(labelGateWindow(diff(0, 0, false), false).mayIncludeOtherTasksWork).toBe(false);
  });
});

describe("o rótulo chega à EVIDÊNCIA do run (a origem), ao lado do veredito", () => {
  it("snapshot com mudança FORA do território ⇒ o veredito DIZ que pode ser de outro card", async () => {
    const evidence = await runTaskGates({
      taskId: "t-rotulo",
      cwd: process.cwd(),
      declaredRoot: process.cwd(),
      gates: ["npx tsc --noEmit"],
      // Sem bwrap o comando vira RECUSA (comportamento existente) — o vermelho
      // do caso, e a captura da janela é observação independente do gate.
      sandboxBinary: null,
      territory: ["src/main/pty-registry.ts"],
      gitFn: fakeGit(STATUS),
    });

    expect(evidence.ok).toBe(false);
    expect(evidence.window).toBeDefined();
    expect(evidence.window!.mayIncludeOtherTasksWork).toBe(true);
    expect(evidence.window!.outsideTerritory).toBe(3);
    expect(evidence.window!.total).toBe(4);
    expect(evidence.window!.note).toMatch(/PODE vir de outro card/);
    // O rótulo por ARQUIVO continua no diff — o run-level só sobe o mesmo dado.
    expect(evidence.diff!.files.find((f) => f.path === "docs/fora-do-territorio.md")?.inTerritory).toBe(false);
  });

  it("snapshot LIMPO (tudo dentro do território declarado) ⇒ sem ruído no veredito", async () => {
    const evidence = await runTaskGates({
      taskId: "t-limpo",
      cwd: process.cwd(),
      declaredRoot: process.cwd(),
      gates: ["npx tsc --noEmit"],
      sandboxBinary: null,
      territory: ["src/main", "src/renderer", "docs"],
      gitFn: fakeGit(STATUS),
    });

    expect(evidence.window!.outsideTerritory).toBe(0);
    expect(evidence.window!.mayIncludeOtherTasksWork).toBe(false);
    expect(evidence.window!.note).not.toMatch(/PODE vir de outro card/);
  });
});
