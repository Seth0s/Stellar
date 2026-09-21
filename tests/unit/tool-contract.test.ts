import { describe, it, expect } from "vitest";
import * as z from "zod";
import {
  decideMisplacedCallFields,
  misplacedCallFields,
  type ToolContractDecl,
} from "../../src/main/tool-contract";

/**
 * O CASO (task a477f3d4): campo de CHAMADA escrito DENTRO do payload.
 *
 * `report` é declarado `z.unknown()`, então qualquer chave é legítima ali
 * dentro por construção — o zod não tem como recusar um `verdict` que veio no
 * lugar do argumento `verdict`. Medido no banco real: `reports` seq 515
 * (card 97924132, canal http, 2026-09-20 16:41) entrou com o revisor convicto
 * de que tinha assinado, `reports.verdict` NULL e a task seguindo `running`.
 * O próprio revisor narra o caso no relatório seguinte (seq 519).
 *
 * Este arquivo é da peça PURA (`tool-contract.ts`) — o outro lado, o schema
 * publicado e a recusa atravessando o servidor MCP de verdade, vive em
 * `tool-contract-anti-drift.test.ts` e `mcp-server-task-fields.test.ts`.
 */

/** A declaração com a forma do `report` real: um payload livre e dois campos
 * de CHAMADA que ninguém deveria escrever por dentro dele. */
const REPORT_LIKE: ToolContractDecl = {
  tool: "report",
  fields: [
    { name: "callerCardId", schema: z.string(), accepted: "o id do seu próprio card (ver AGENT_CANVAS_CARD_ID)" },
    { name: "report", required: true, freeForm: true, schema: z.unknown(), accepted: "o relatório como objeto JSON" },
    { name: "verdict", schema: z.enum(["aprovado", "reprovado"]), accepted: 'um dos valores "aprovado" ou "reprovado"' },
  ],
};

describe("tool-contract: campo de chamada dentro do payload", () => {
  it("o caso medido: `verdict` no payload em vez do campo da chamada", () => {
    const found = misplacedCallFields({
      contract: REPORT_LIKE,
      args: { report: { ok: true, achados: "5 pontos medidos", verdict: "APROVADO" } },
    });
    expect(found).toEqual([{ field: "verdict", payloadField: "report", got: "APROVADO" }]);
  });

  it("o valor recebido é literal, seja qual for a forma: é ele que a recusa mostra", () => {
    // O revisor do caso real escreveu "APROVADO" — maiúsculas, que o
    // `isFormalVerdict` do bus NÃO promove. Não importa para esta varredura:
    // ela não julga o valor, ela vê que a chave está no lugar errado.
    for (const got of ["aprovado", "APROVADO", "aprovado — com ressalvas", null, 3, { nested: true }]) {
      const found = misplacedCallFields({ contract: REPORT_LIKE, args: { report: { verdict: got } } });
      expect(found, `valor ${JSON.stringify(got)}`).toEqual([{ field: "verdict", payloadField: "report", got }]);
    }
  });

  it("não opina sobre o CONTEÚDO do payload: chave que não é campo da chamada passa", () => {
    // As chaves reais de um reportSchema (`achados`, `evidenciaMedida`, …) e
    // a prosa livre não têm nada a ver com a chamada — 141 chaves distintas
    // declaradas no banco real, nenhuma colidindo.
    const found = misplacedCallFields({
      contract: REPORT_LIKE,
      args: { report: { ok: true, achados: ["a"], evidenciaMedida: "npx vitest run", taskId: "T1", verdict_summary: "APROVADO" } },
    });
    expect(found).toEqual([]);
  });

  it("não recusa quando o campo da chamada VEIO: o explícito vence e nada se perde", () => {
    const found = misplacedCallFields({
      contract: REPORT_LIKE,
      args: { report: { ok: true, verdict: "reprovado" }, verdict: "aprovado" },
    });
    expect(found).toEqual([]);
  });

  it("payload que não é objeto não esconde chave nenhuma — string, array, null", () => {
    for (const report of ["done, see notes", '{"ok":true}', ["ok"], null, 7]) {
      expect(
        misplacedCallFields({ contract: REPORT_LIKE, args: { report } }),
        `payload ${JSON.stringify(report)}`,
      ).toEqual([]);
    }
  });

  it("envelope entregue como string de JSON é decodificado antes da varredura", () => {
    // Sem o decode esta varredura seria cega no caso mais provável (o modelo
    // serializa o payload). O handler usa `decodeReportArgument` — a MESMA
    // função é injetada aqui, para os dois verem o mesmo valor.
    const decode = (raw: unknown) => {
      if (typeof raw !== "string") return raw;
      try {
        const parsed: unknown = JSON.parse(raw);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : raw;
      } catch {
        return raw;
      }
    };
    const found = misplacedCallFields({
      contract: REPORT_LIKE,
      args: { report: '{"ok":true,"verdict":"aprovado"}' },
      decode,
    });
    expect(found).toEqual([{ field: "verdict", payloadField: "report", got: "aprovado" }]);
    // String que não decodifica permanece invisível — limite declarado no
    // cabeçalho do módulo (é a metade do envelope, task 10cf58d0).
    expect(misplacedCallFields({ contract: REPORT_LIKE, args: { report: '{"ok":true' }, decode })).toEqual([]);
  });

  it("o payload aninhado dentro de si mesmo não é campo de chamada deslocado", () => {
    const found = misplacedCallFields({ contract: REPORT_LIKE, args: { report: { report: "prosa" } } });
    expect(found).toEqual([]);
  });

  it("tool sem payload de forma livre não tem onde esconder campo de chamada", () => {
    // `update_task` tem campo livre (`result`) e MUITOS campos de chamada
    // (`status`, `gates`, `review`, …) — a mesma regra lá seria uma máquina
    // de falso positivo (medido: 33 de 139 `result_json` reais já usam
    // `gates`/`review` como CONTEÚDO legítimo). A declaração é quem decide:
    // sem `freeForm`, a varredura nem olha.
    const noFreeForm: ToolContractDecl = {
      tool: "card_status",
      fields: [{ name: "target", required: true, schema: z.string(), accepted: "o id de um card" }],
    };
    expect(
      misplacedCallFields({ contract: noFreeForm, args: { target: "c1", result: { status: "done", gates: ["x"] } } }),
    ).toEqual([]);
  });

  it("a recusa nomeia O QUE veio, ONDE veio e ONDE vai — e não gravou nada", () => {
    const decision = decideMisplacedCallFields({
      contract: REPORT_LIKE,
      args: { report: { ok: true, verdict: "APROVADO" } },
    });
    expect(decision.action).toBe("refuse");
    const error = decision.action === "refuse" ? decision.error : "";
    expect(error).toContain("`verdict`"); // o campo
    expect(error).toContain("DENTRO do payload `report`"); // de onde veio
    expect(error).toContain('"APROVADO"'); // o que chegou
    expect(error).toContain('"aprovado" ou "reprovado"'); // o que o campo aceita
    expect(error).toContain("campo próprio da chamada"); // para onde vai
    expect(error).toContain("nada foi gravado");
    // Mesma voz das outras recusas do módulo (o leitor é o modelo no turno).
    expect(error.startsWith("[de: stellar] report recusado:")).toBe(true);
  });

  it("dois campos deslocados na mesma chamada saem os dois na mesma frase", () => {
    const decision = decideMisplacedCallFields({
      contract: REPORT_LIKE,
      args: { report: { ok: true, verdict: "aprovado", callerCardId: "c9" } },
    });
    expect(decision.action).toBe("refuse");
    const error = decision.action === "refuse" ? decision.error : "";
    expect(error).toContain("`verdict`");
    expect(error).toContain("`callerCardId`");
  });

  it("payload limpo é `ok` — o caminho quente não ganha recusa nova", () => {
    expect(
      decideMisplacedCallFields({
        contract: REPORT_LIKE,
        args: { report: { ok: true, achados: "tudo verde" }, verdict: "aprovado" },
      }),
    ).toEqual({ action: "ok" });
    expect(decideMisplacedCallFields({ contract: REPORT_LIKE, args: {} })).toEqual({ action: "ok" });
  });
});
