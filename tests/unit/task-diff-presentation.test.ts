import { describe, it, expect } from "vitest";
import type { DiffCaptureEvidence, DiffFileEntry } from "../../src/main/gate-runner";
import {
  TASK_DIFF_KEYS,
  TASK_DIFF_SUMMARY_KEYS,
  decideTaskDiffPresentation,
} from "../../src/renderer/src/task-diff-presentation";

/**
 * Task 80858d79 (fatia 3 da 7096e8af) — a DECISÃO de apresentação do diff
 * anexado à task. Os quatro invariantes que são o valor das fatias 1 e 2
 * ficam travados AQUI, em teste unitário, e não em teste de DOM: eles são
 * sobre o que a UI pode afirmar, não sobre pixels.
 */

function file(path: string, status: string, territory: { declared: boolean; inside: boolean }): DiffFileEntry {
  return {
    path,
    status,
    inTerritory: territory.inside,
    territoryDeclared: territory.declared,
  };
}

function evidence(over: Partial<DiffCaptureEvidence> = {}): DiffCaptureEvidence {
  return {
    gitRoot: "/repo",
    stat: " 4 files changed",
    patch: "diff --git a/x b/x",
    patchTruncated: false,
    files: [],
    filesTruncated: false,
    total: 0,
    outsideTerritory: 0,
    note: "o app observa MUDANÇA, nunca AUTORIA: a árvore é compartilhada.",
    ...over,
  };
}

const DECLARED = { declared: true, inside: true };
const OUTSIDE = { declared: true, inside: false };
const UNDECLARED = { declared: false, inside: false };

describe("decideTaskDiffPresentation — sem evidência, o bloco não existe", () => {
  it("null/undefined → present false e nada inventado", () => {
    for (const input of [null, undefined]) {
      const view = decideTaskDiffPresentation(input);
      expect(view.present).toBe(false);
      expect(view.files).toEqual([]);
      expect(view.note).toBe("");
      expect(view.summary).toEqual({ kind: "no-files" });
    }
  });

  it("o formato ausente é uma cópia nova a cada chamada (ninguém muta o compartilhado)", () => {
    expect(decideTaskDiffPresentation(null)).not.toBe(decideTaskDiffPresentation(null));
  });
});

describe("invariante 1 — TERRITÓRIO É RÓTULO, NUNCA FILTRO", () => {
  it("arquivo fora do território APARECE na lista e é CONTADO", () => {
    const view = decideTaskDiffPresentation(
      evidence({
        files: [
          file("src/main/pty-registry.ts", " M", DECLARED),
          file("docs/fora-do-territorio.md", " M", OUTSIDE),
          file("src/renderer/src/ProvidersPage.tsx", " M", OUTSIDE),
          file("src/main/card-status-decision.ts", "??", OUTSIDE),
        ],
        total: 4,
        outsideTerritory: 3,
      }),
    );

    // A lista sai COMPLETA — os três de fora estão ali, não filtrados.
    expect(view.files.map((f) => f.path)).toEqual([
      "src/main/pty-registry.ts",
      "docs/fora-do-territorio.md",
      "src/renderer/src/ProvidersPage.tsx",
      "src/main/card-status-decision.ts",
    ]);
    expect(view.files.filter((f) => f.territory === "outside")).toHaveLength(3);
    expect(view.files.find((f) => f.path === "docs/fora-do-territorio.md")?.territory).toBe("outside");
    expect(view.files.find((f) => f.path === "src/main/pty-registry.ts")?.territory).toBe("inside");
    // Contagens vêm da evidência (fonte única), e o resumo é o "N de M fora".
    expect(view.total).toBe(4);
    expect(view.outside).toBe(3);
    expect(view.summary).toEqual({ kind: "outside", outside: 3, total: 4 });
    expect(view.territoryDeclared).toBe(true);
  });
});

describe("invariante 2 — O RÓTULO NÃO PODE SOAR COMO AUTORIA", () => {
  it("a única frase entregue é a DA EVIDÊNCIA, repassada sem reescrita", () => {
    const source = evidence({ note: "o app observa MUDANÇA, nunca AUTORIA — a árvore é compartilhada." });
    const view = decideTaskDiffPresentation(source);
    expect(view.note).toBe(source.note);
    expect(view.note.startsWith("o app observa")).toBe(true);
  });

  it("o módulo não carrega prosa própria: tudo que ele exporta além da nota é CHAVE ou estrutura", () => {
    // Nenhuma chave pode ser uma frase: o contrato é `task.diff.<nome>`.
    for (const key of Object.values(TASK_DIFF_KEYS)) {
      expect(key).toMatch(/^task\.diff\.[a-zA-Z]+$/);
    }
    // E o resumo aponta para uma dessas chaves — nunca para um literal.
    for (const key of Object.values(TASK_DIFF_SUMMARY_KEYS)) {
      expect(Object.values(TASK_DIFF_KEYS)).toContain(key);
    }
    // O título é o único lugar onde o texto poderia escorregar para "o que
    // esta task mudou": a chave é neutra por construção (o TEXTO entra no
    // catálogo, com a redação de MUDANÇA, nunca de autoria).
    expect(TASK_DIFF_KEYS.sectionTitle).toBe("task.diff.title");
  });
});

describe("invariante 3 — TRUNCAMENTO E UNTRACKED NÃO PODEM MENTIR", () => {
  it("patchTruncated sobe cru e tem chave para o componente anunciar", () => {
    const view = decideTaskDiffPresentation(
      evidence({ patchTruncated: true, files: [file("src/a.ts", " M", DECLARED)], total: 1 }),
    );
    expect(view.patchTruncated).toBe(true);
    // O TEXTO mudou com o conserto do teto (task 56604aca): o patch truncado
    // agora mostra o COMEÇO (o coletor de git guarda a cabeça), não o fim.
    expect(TASK_DIFF_KEYS.patchTruncated).toBe("task.diff.patchTruncated");
  });

  it("filesTruncated também sobe cru: a LISTA pode estar incompleta, e isso é dito", () => {
    const view = decideTaskDiffPresentation(
      evidence({ filesTruncated: true, files: [file("src/a.ts", " M", DECLARED)], total: 1 }),
    );
    expect(view.filesTruncated).toBe(true);
    // Chave própria: o aviso da lista não é o mesmo aviso do patch (o patch
    // cortado perde o FIM; a lista cortada perde os últimos caminhos).
    expect(TASK_DIFF_KEYS.filesTruncated).toBe("task.diff.filesTruncated");
  });

  it("untracked ganha a leitura própria; tracked não é marcado como novo", () => {
    const view = decideTaskDiffPresentation(
      evidence({
        files: [
          file("src/main/novo.ts", "??", DECLARED),
          file("src/main/velho.ts", " M", DECLARED),
        ],
        total: 2,
      }),
    );
    expect(view.files.find((f) => f.path === "src/main/novo.ts")?.untracked).toBe(true);
    expect(view.files.find((f) => f.path === "src/main/velho.ts")?.untracked).toBe(false);
    expect(TASK_DIFF_KEYS.untracked).toBe("task.diff.untracked");
  });
});

describe("invariante 4 — SEM TERRITÓRIO DECLARADO NÃO HÁ RÓTULO", () => {
  it("cada arquivo sai unlabeled e o resumo NÃO vira '0 de N fora'", () => {
    const view = decideTaskDiffPresentation(
      evidence({
        files: [
          file("src/a.ts", " M", UNDECLARED),
          file("src/b.ts", "??", UNDECLARED),
        ],
        total: 2,
        // A captura zera `outsideTerritory` quando não há território — e é
        // isso que a UI NÃO pode ler como "zero arquivos fora".
        outsideTerritory: 0,
      }),
    );
    expect(view.files.map((f) => f.territory)).toEqual(["unlabeled", "unlabeled"]);
    expect(view.territoryDeclared).toBe(false);
    expect(view.summary).toEqual({ kind: "no-territory", total: 2 });
    expect(TASK_DIFF_SUMMARY_KEYS["no-territory"]).toBe(TASK_DIFF_KEYS.noTerritory);
  });

  it("sem nenhum arquivo na janela não dá para saber: não afirma nem um nem outro", () => {
    const view = decideTaskDiffPresentation(evidence({ files: [], total: 0, outsideTerritory: 0 }));
    expect(view.present).toBe(true);
    expect(view.territoryDeclared).toBeNull();
    expect(view.summary).toEqual({ kind: "no-files" });
  });

  it("cwd que não é repositório git: presente, sem arquivos, com a nota do main explicando", () => {
    const view = decideTaskDiffPresentation(
      evidence({
        gitRoot: null,
        files: [],
        total: 0,
        note: "o cwd desta task não é um repositório git — não há diff a observar.",
      }),
    );
    expect(view.present).toBe(true);
    expect(view.files).toEqual([]);
    expect(view.note).toContain("não é um repositório git");
    expect(view.summary).toEqual({ kind: "no-files" });
  });
});
