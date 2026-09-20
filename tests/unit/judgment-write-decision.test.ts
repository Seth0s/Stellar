import { describe, it, expect } from "vitest";
import {
  decideJudgmentWrite,
  decideReportVerdictWrite,
  describeImplementerJudgmentRefusal,
  emptyReportSchemaFields,
  roleOnTask,
} from "../../src/main/judgment-write-decision";

describe("decideJudgmentWrite (CAMADA 4)", () => {
  it("allows non-judgment status for implementer", () => {
    expect(decideJudgmentWrite({ proposedStatus: "running", requesterRoleOnTask: "implementer" })).toEqual({
      action: "allow",
    });
    expect(decideJudgmentWrite({ proposedStatus: "pending", requesterRoleOnTask: "implementer" })).toEqual({
      action: "allow",
    });
    expect(decideJudgmentWrite({ proposedStatus: null, requesterRoleOnTask: "implementer" })).toEqual({ action: "allow" });
  });

  it("refuses done/failed for implementer and names request_task_status", () => {
    const done = decideJudgmentWrite({ proposedStatus: "done", requesterRoleOnTask: "implementer" });
    expect(done).toEqual({ action: "refuse", error: describeImplementerJudgmentRefusal("done") });
    expect(done.action === "refuse" && done.error).toContain("request_task_status");

    const failed = decideJudgmentWrite({ proposedStatus: "failed", requesterRoleOnTask: "implementer" });
    expect(failed.action).toBe("refuse");
    expect(failed.action === "refuse" && failed.error).toContain("failed");
  });

  it("allows reviewer to write judgment (role is to judge)", () => {
    expect(decideJudgmentWrite({ proposedStatus: "done", requesterRoleOnTask: "reviewer" })).toEqual({ action: "allow" });
    expect(decideJudgmentWrite({ proposedStatus: "failed", requesterRoleOnTask: "reviewer" })).toEqual({ action: "allow" });
  });

  it("allows outsider (null role / no link) to write judgment", () => {
    expect(decideJudgmentWrite({ proposedStatus: "done", requesterRoleOnTask: null })).toEqual({ action: "allow" });
  });
});

describe("roleOnTask", () => {
  const cards = [
    { card_id: "10", role: "implementer" },
    { card_id: "20", role: "reviewer" },
  ];
  it("returns role for linked card, null otherwise", () => {
    expect(roleOnTask(cards, "10")).toBe("implementer");
    expect(roleOnTask(cards, "20")).toBe("reviewer");
    expect(roleOnTask(cards, "99")).toBeNull();
    expect(roleOnTask(cards, undefined)).toBeNull();
    expect(roleOnTask(cards, null)).toBeNull();
  });
});

/**
 * Task 8dd43b2c — a palavra "placeholder" passava pelo guard: um revisor
 * entregou `"achados": "placeholder"` com verdict de REPROVAÇÃO e o
 * servidor aceitou; quem recusou foi o orquestrador, na mão. A forma
 * escolhida (valor INTEIRO por vocabulário) e as duas formas REJEITADAS
 * (substring, limiar de tamanho) estão medidas contra o banco real e
 * travadas aqui.
 */
describe("evidência de veredito: placeholder por VOCABULÁRIO, no valor inteiro", () => {
  const SCHEMA = ["achados", "evidenciaMedida"];

  it("recusa a palavra inteira que não é evidência — o caso medido", () => {
    for (const word of ["placeholder", "Placeholder ", "PLACEHOLDER", "lorem ipsum", "wip", "fixme", "a preencher", "xxx", "sample"]) {
      expect(emptyReportSchemaFields({ achados: word, evidenciaMedida: "suíte verde" }, SCHEMA), word).toEqual(["achados"]);
    }
  });

  it("NÃO recusa substring: a frase que DESCREVE um placeholder é evidência legítima (medido: 288/2073 valores aceitos contêm um dos termos)", () => {
    expect(
      emptyReportSchemaFields(
        {
          achados:
            "O implementador deixou um placeholder no card e nenhum teste cobre o caminho de erro; o TODO do arquivo continua lá.",
          evidenciaMedida: "npx vitest run → 192/1988",
        },
        SCHEMA,
      ),
    ).toEqual([]);
  });

  it("NÃO recusa por TAMANHO: evidência curta e real passa ('1884 passed', um hash, um caminho)", () => {
    expect(emptyReportSchemaFields({ achados: "1884 passed", evidenciaMedida: "abc1234" }, SCHEMA)).toEqual([]);
    expect(emptyReportSchemaFields({ achados: "src/main/store.ts", evidenciaMedida: "commit 8dd43b2" }, SCHEMA)).toEqual([]);
  });

  it("o veredito de REPROVAÇÃO com evidência placeholder é recusado, e a mensagem nomeia a chave", () => {
    const decision = decideReportVerdictWrite({
      verdict: "reprovado",
      requesterRoleOnTask: "reviewer",
      reviewWanted: true,
      report: { achados: "placeholder", evidenciaMedida: "unidades verificadas" },
      reportSchema: SCHEMA,
    });
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") {
      expect(decision.error).toContain("achados");
      expect(decision.error).toContain("placeholder");
    }
  });

  it("a evidência real do MESMO veredito passa (o guard não pune evidência legítima)", () => {
    const decision = decideReportVerdictWrite({
      verdict: "reprovado",
      requesterRoleOnTask: "reviewer",
      reviewWanted: true,
      report: {
        achados: "Dois relógios na mesma função: o cálculo usa Date.now() e a comparação usa o timestamp do evento.",
        evidenciaMedida: "tests/unit/fuso.test.ts → 1 falha reproduzida",
      },
      reportSchema: SCHEMA,
    });
    expect(decision.action).toBe("allow");
  });

  it("relatório de FALHA sem veredito não passa por este gate (ok:false preservado)", () => {
    expect(
      decideReportVerdictWrite({
        verdict: null,
        requesterRoleOnTask: "implementer",
        report: { achados: "", evidenciaMedida: "" },
        reportSchema: SCHEMA,
      }),
    ).toEqual({ action: "allow" });
  });
});
