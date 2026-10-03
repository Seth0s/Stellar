import { describe, expect, it } from "vitest";
import { parseGateDiffEvidence } from "../../src/main/gate-runner";
import { decideTaskDiffPresentation } from "../../src/renderer/src/task-diff-presentation";

/**
 * O SEAM DO DIFF ATÉ A FILA (task 7096e8af, fatia que faltava).
 *
 * A captura e o rótulo honesto já estavam no HEAD; o que não existia era o
 * caminho até quem revisa: `task-diff-presentation.ts` sem chamador de produção
 * e nenhum arquivo do renderer lendo `gateRun`. Aqui se prova o degrau NOVO —
 * `parseGateDiffEvidence` (main) — e que a decisão do renderer trabalha sobre
 * o que ele extrai, preservando os invariantes que a fatia 3 já cravou:
 * arquivo fora do território APARECE e é contado; sem território declarado a
 * leitura é "sem território", NUNCA "0 de N fora"; e os DOIS truncamentos se
 * anunciam.
 */

function evidence(over: Record<string, unknown> = {}) {
  return {
    gitRoot: "/repo",
    stat: " src/a.ts | 2 +-",
    patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n",
    patchTruncated: false,
    files: [{ path: "src/a.ts", status: " M", inTerritory: true, territoryDeclared: true }],
    filesTruncated: false,
    total: 1,
    outsideTerritory: 0,
    note: "Estes arquivos mudaram nesta janela do repositório, 1 no total — ...",
    ...over,
  };
}

const wrap = (diff: unknown) => JSON.stringify({ value: { ok: true }, gateRun: { diff } });

describe("parseGateDiffEvidence — o diff da task, sob demanda (task 7096e8af)", () => {
  it("extrai `gateRun.diff`; ausência ou JSON podre => null (o bloco não existe)", () => {
    const ev = evidence();
    expect(parseGateDiffEvidence(wrap(ev))).toEqual(ev);
    expect(parseGateDiffEvidence(JSON.stringify({ gateRun: {} }))).toBeNull();
    expect(parseGateDiffEvidence(JSON.stringify({ value: 1 }))).toBeNull();
    expect(parseGateDiffEvidence("{ nao-e-json")).toBeNull();
    expect(parseGateDiffEvidence(null)).toBeNull();
    expect(parseGateDiffEvidence("")).toBeNull();
  });

  it("o que a Fila decide: fora do território APARECE e é contado (invariante 1)", () => {
    const ev = evidence({
      total: 2,
      outsideTerritory: 1,
      files: [
        { path: "src/a.ts", status: " M", inTerritory: true, territoryDeclared: true },
        { path: "src/fora.ts", status: "??", inTerritory: false, territoryDeclared: true },
      ],
    });
    const view = decideTaskDiffPresentation(parseGateDiffEvidence(wrap(ev)));
    expect(view.present).toBe(true);
    expect(view.summary).toEqual({ kind: "outside", outside: 1, total: 2 });
    expect(view.files.map((f) => f.territory)).toEqual(["inside", "outside"]);
    expect(view.files[1].untracked).toBe(true);
  });

  it("sem território declarado: 'sem território', nunca '0 de N fora' (invariante 4)", () => {
    const ev = evidence({
      files: [{ path: "x.ts", status: " M", inTerritory: false, territoryDeclared: false }],
      total: 1,
      outsideTerritory: 0,
    });
    const view = decideTaskDiffPresentation(parseGateDiffEvidence(wrap(ev)));
    expect(view.summary).toEqual({ kind: "no-territory", total: 1 });
    expect(view.files[0].territory).toBe("unlabeled");
  });

  it("os DOIS truncamentos se anunciam (invariante 3)", () => {
    const view = decideTaskDiffPresentation(parseGateDiffEvidence(wrap(evidence({ patchTruncated: true, filesTruncated: true }))));
    expect(view.patchTruncated).toBe(true);
    expect(view.filesTruncated).toBe(true);
  });

  it("sem evidência, o bloco é AUSENTE — a UI não desenha nada", () => {
    expect(decideTaskDiffPresentation(parseGateDiffEvidence(null)).present).toBe(false);
  });
});
