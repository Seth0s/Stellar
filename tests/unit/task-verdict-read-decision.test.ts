import { describe, expect, it } from "vitest";
import { deriveTaskVerdictReading } from "../../src/main/task-verdict-read-decision";

/**
 * A REGRA DE LEITURA DO PASSADO (task 156e6d08), sozinha — sem banco.
 *
 * O que está preso aqui, em uma frase por caso:
 *   - a rodada é UMA: todas as linhas com o mesmo `(card_id, at)` carregam o
 *     mesmo veredito, e só a que o report NOMEOU pode reivindicá-lo;
 *   - sem declaração, quem decide é o tamanho da rodada — 1 vínculo não tinha
 *     como carimbar a task errada, N > 1 é indecidível;
 *   - um id declarado que não é task nenhuma (id truncado copiado de
 *     briefing) NÃO é declaração, e não vira palpite por prefixo;
 *   - `null` na coluna nunca vira veredito, e veredito real nunca vira `null`
 *     sem uma razão nomeada.
 *
 * Os dados são do FORMATO REAL: o grupo de fan-out com N linhas nasceu do
 * banco do dono (card 97924122, 6 tasks vivas, 126 linhas carimbadas com o
 * mesmo `at`).
 */

const TASK = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER = "bbbbbbbb-0000-0000-0000-000000000002";

describe("deriveTaskVerdictReading — a linha carimbada, lida", () => {
  it("declarou ESTA task: o veredito é desta task, e a coluna não é tocada", () => {
    const r = deriveTaskVerdictReading({
      taskId: TASK,
      storedVerdict: "aprovado",
      declaredTaskId: TASK,
      declaredNamesTask: true,
      roundLinks: 6,
      reportFound: true,
    });
    expect(r).toEqual({
      verdict: "aprovado",
      storedVerdict: "aprovado",
      rule: "declared_this_task",
      declaredTaskId: TASK,
      declaredNamesTask: true,
      roundLinks: 6,
      reportFound: true,
    });
  });

  it("declarou OUTRA task: carimbo de fan-out — o veredito NÃO é desta task, e o gravado continua visível", () => {
    const r = deriveTaskVerdictReading({
      taskId: TASK,
      storedVerdict: "aprovado",
      declaredTaskId: OTHER,
      declaredNamesTask: true,
      roundLinks: 6,
      reportFound: true,
    });
    // `verdict: null` é a RESPOSTA ("não é desta task"); `storedVerdict` é a
    // prova do que a coluna diz — os dois juntos, nunca um só.
    expect(r.verdict).toBeNull();
    expect(r.storedVerdict).toBe("aprovado");
    expect(r.rule).toBe("declared_other_task");
    expect(r.declaredTaskId).toBe(OTHER);
  });

  it("reprovado carimbado em outra task: o erro também esconde o reprovado, não só o aprovado", () => {
    const r = deriveTaskVerdictReading({
      taskId: TASK,
      storedVerdict: "reprovado",
      declaredTaskId: OTHER,
      declaredNamesTask: true,
      roundLinks: 3,
      reportFound: true,
    });
    expect(r).toEqual(expect.objectContaining({ verdict: null, rule: "declared_other_task" }));
  });

  it("sem declaração e com UM vínculo: a rodada não tinha outra candidata — o veredito é real", () => {
    const r = deriveTaskVerdictReading({
      taskId: TASK,
      storedVerdict: "reprovado",
      declaredTaskId: null,
      declaredNamesTask: false,
      roundLinks: 1,
      reportFound: true,
    });
    expect(r).toEqual(expect.objectContaining({ verdict: "reprovado", rule: "sole_link" }));
  });

  it("sem declaração e com N > 1 vínculos: DESCONHECIDO, e a evidência viaja junto", () => {
    const r = deriveTaskVerdictReading({
      taskId: TASK,
      storedVerdict: "aprovado",
      declaredTaskId: null,
      declaredNamesTask: false,
      roundLinks: 6,
      reportFound: true,
    });
    expect(r).toEqual({
      verdict: null,
      storedVerdict: "aprovado",
      rule: "undeclared_round",
      declaredTaskId: null,
      declaredNamesTask: false,
      roundLinks: 6,
      reportFound: true,
    });
  });

  it("id declarado que NÃO é task (id truncado de briefing) não decide nada: cai na regra do tamanho", () => {
    // Medido no banco do dono: 34 linhas com veredito declaram um id de 8
    // caracteres ("30d858c5"). Tratá-lo como declaração diria que o veredito
    // "é de uma task que não existe"; resolvê-lo por PREFIXO seria palpite.
    const multi = deriveTaskVerdictReading({
      taskId: TASK,
      storedVerdict: "reprovado",
      declaredTaskId: "30d858c5",
      declaredNamesTask: false,
      roundLinks: 8,
      reportFound: true,
    });
    expect(multi.rule).toBe("undeclared_round");
    expect(multi.verdict).toBeNull();
    // ...e o id fica no registro, pra quem audita ver o que o report disse.
    expect(multi.declaredTaskId).toBe("30d858c5");
    expect(multi.declaredNamesTask).toBe(false);

    // Com UM vínculo só, o mesmo id inválido não apaga um veredito que só
    // podia ser daquele vínculo.
    const single = deriveTaskVerdictReading({
      taskId: TASK,
      storedVerdict: "reprovado",
      declaredTaskId: "30d858c5",
      declaredNamesTask: false,
      roundLinks: 1,
      reportFound: true,
    });
    expect(single.rule).toBe("sole_link");
    expect(single.verdict).toBe("reprovado");
  });

  it("rodada sem veredito nenhum: nada a atribuir, nada a reparar", () => {
    const r = deriveTaskVerdictReading({
      taskId: TASK,
      storedVerdict: null,
      declaredTaskId: TASK,
      declaredNamesTask: true,
      roundLinks: 6,
      reportFound: false,
    });
    expect(r.rule).toBe("no_verdict");
    expect(r.verdict).toBeNull();
    expect(r.storedVerdict).toBeNull();
  });

  it("report podado (`reportFound: false`) não muda a regra do tamanho — e fica registrado", () => {
    const r = deriveTaskVerdictReading({
      taskId: TASK,
      storedVerdict: "aprovado",
      declaredTaskId: null,
      declaredNamesTask: false,
      roundLinks: 4,
      reportFound: false,
    });
    expect(r.rule).toBe("undeclared_round");
    expect(r.reportFound).toBe(false);
  });

  it("veredito fora do par formal (lixo gravado) é preservado, nunca 'corrigido'", () => {
    const r = deriveTaskVerdictReading({
      taskId: TASK,
      storedVerdict: "ship",
      declaredTaskId: TASK,
      declaredNamesTask: true,
      roundLinks: 1,
      reportFound: true,
    });
    expect(r.verdict).toBe("ship");
    expect(r.rule).toBe("declared_this_task");
  });

  it("`roundLinks: 0` (impossível no banco: a linha que se lê é uma do grupo) não vira 'indecidível'", () => {
    const r = deriveTaskVerdictReading({
      taskId: TASK,
      storedVerdict: "aprovado",
      roundLinks: 0,
      reportFound: true,
    });
    expect(r.roundLinks).toBe(1);
    expect(r.rule).toBe("sole_link");
  });

  it("FAN-OUT REAL: N linhas, UM veredito, e só uma sobrevive — a que o report nomeou", () => {
    // O grupo medido: card 97924122 reportou uma vez e o `recordParticipationRound`
    // de então carimbou TODAS as 6 tasks vivas dele com o mesmo `at`.
    const tasks = [TASK, OTHER, "c", "d", "e", "f"];
    const readings = tasks.map((taskId) =>
      deriveTaskVerdictReading({
        taskId,
        storedVerdict: "aprovado",
        declaredTaskId: "d",
        declaredNamesTask: true,
        roundLinks: tasks.length,
        reportFound: true,
      }),
    );
    expect(readings.filter((r) => r.verdict === "aprovado")).toHaveLength(1);
    expect(readings.filter((r) => r.rule === "declared_other_task")).toHaveLength(5);
    // E o MESMO grupo sem declaração: nenhuma sobrevive, nenhuma é chutada.
    const unnamed = tasks.map((taskId) =>
      deriveTaskVerdictReading({ taskId, storedVerdict: "aprovado", roundLinks: tasks.length, reportFound: true }),
    );
    expect(unnamed.every((r) => r.verdict === null && r.rule === "undeclared_round")).toBe(true);
  });
});

