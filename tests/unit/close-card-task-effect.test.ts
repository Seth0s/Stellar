import { describe, it, expect } from "vitest";
import {
  decideCloseCardTaskEffect,
  describeCloseWithoutSuccessRefusal,
  describeImplementerJudgmentRefusal,
  describeReviewerLeavingUnsignedRefusal,
  describeStrandedReviewTaskCloseRefusal,
  type CloseCardLinkedTask,
} from "../../src/main/judgment-write-decision";

const base: CloseCardLinkedTask = {
  taskId: "T1",
  targetCardId: "C1",
  reviewWanted: false,
  targetRole: null,
  requesterRoleOnTask: null,
  otherLiveReviewers: 0,
  lastReportOk: true,
  targetVerdicts: [],
};

describe("decideCloseCardTaskEffect", () => {
  // S1: review="wanted", o card fechado É o reviewer e seu último round
  // de reviewer foi aprovado — a assinatura viaja com o fechamento.
  it("S1: reviewer aprovado conclui a task junto com o fechamento", () => {
    const result = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: true,
      targetRole: "reviewer",
      targetVerdicts: [{ role: "reviewer", verdict: "aprovado" }],
    });
    expect(result).toEqual({ action: "conclude-task", taskId: "T1", reason: "reviewer-signature" });
  });

  // S2: reviewer julgou e reprovou — o destino da task não depende mais
  // deste card, fechar não prende nada.
  it("S2: reviewer reprovado permite fechar sem concluir", () => {
    const result = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: true,
      targetRole: "reviewer",
      targetVerdicts: [{ role: "reviewer", verdict: "reprovado" }],
    });
    expect(result).toEqual({ action: "allow-close" });
  });

  // S3: reviewer julgou mas o round mais recente tem verdict null (ex.:
  // registrado sem veredito formal) — contou como "já julgou", não aprovado.
  it("S3: reviewer com round mas verdict null permite fechar sem concluir", () => {
    const result = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: true,
      targetRole: "reviewer",
      targetVerdicts: [{ role: "reviewer", verdict: null }],
    });
    expect(result).toEqual({ action: "allow-close" });
  });

  // S4: reviewer sem NENHUM round registrado nesta task — é o único vivo
  // saindo sem assinar, a task ficaria presa.
  it("S4: reviewer sem veredito nenhum é recusado", () => {
    const result = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: true,
      targetRole: "reviewer",
      targetVerdicts: [],
    });
    expect(result).toEqual({
      action: "refuse",
      error: describeReviewerLeavingUnsignedRefusal("T1", "C1"),
    });
  });

  // S5: discrimina que a busca usa o round MAIS RECENTE de reviewer, não
  // "algum" aprovado no histórico — um aprovado antigo seguido de um
  // reprovado atual não deve concluir a task.
  it("S5: aprovado antigo seguido de reprovado mais recente não conclui", () => {
    const result = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: true,
      targetRole: "reviewer",
      targetVerdicts: [
        { role: "reviewer", verdict: "aprovado" },
        { role: "reviewer", verdict: "reprovado" },
      ],
    });
    expect(result).toEqual({ action: "allow-close" });
  });

  // S6: card fechado não é o reviewer (é implementer ou outsider) e sobra
  // outro reviewer vivo linkado — fechar não deixa a task órfã.
  it("S6: não-reviewer fecha quando sobra outro reviewer vivo", () => {
    const result = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: true,
      targetRole: "implementer",
      otherLiveReviewers: 1,
    });
    expect(result).toEqual({ action: "allow-close" });
  });

  // S7: mesma situação, mas SEM nenhum outro reviewer vivo — é exatamente
  // o gerador medido dos 7 órfãos.
  it("S7: não-reviewer sem outro reviewer vivo é recusado", () => {
    const result = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: true,
      targetRole: "implementer",
      otherLiveReviewers: 0,
    });
    expect(result).toEqual({
      action: "refuse",
      error: describeStrandedReviewTaskCloseRefusal("T1", "C1"),
    });
  });

  // S8: mesmo caso do S7 mas com targetRole null (card sem role linkada
  // fechando, ex.: card principal sem link de papel) — mesma recusa.
  it("S8: card sem role linkada e sem outro reviewer vivo é recusado", () => {
    const result = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: true,
      targetRole: null,
      otherLiveReviewers: 0,
    });
    expect(result).toEqual({
      action: "refuse",
      error: describeStrandedReviewTaskCloseRefusal("T1", "C1"),
    });
  });

  // S9: sem review exigido, mas o último report aceito não foi ok:true —
  // fechar deixaria a task aberta e órfã em silêncio.
  it("S9: sem review, último report não ok:true é recusado", () => {
    const result = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: false,
      lastReportOk: false,
    });
    expect(result).toEqual({
      action: "refuse",
      error: describeCloseWithoutSuccessRefusal("T1", "C1"),
    });
  });

  // S10: sem review, último report ok:true, mas quem fecha é o PRÓPRIO
  // implementer da task — CAMADA 4 recusa mesmo aqui, fechar não vira uma
  // porta lateral para autoconcluir.
  it("S10: sem review, ok:true, mas quem pede é o implementer é recusado (CAMADA 4)", () => {
    const result = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: false,
      lastReportOk: true,
      requesterRoleOnTask: "implementer",
    });
    expect(result).toEqual({
      action: "refuse",
      error: describeImplementerJudgmentRefusal("done"),
    });
  });

  // S12 (task 156e6d08): o round que o fan-out antigo carimbou NESTA task é
  // de OUTRA task — não é assinatura deste revisor aqui. Antes da regra de
  // leitura ele chegava como `aprovado` e CONCLUÍA a task; agora chega
  // `verdict: null` + `rule: declared_other_task`, e o revisor sai sem
  // assinar: recusa, como S4.
  it("S12: carimbo de fan-out (declared_other_task) NÃO conclui nem serve de assinatura — recusa", () => {
    const result = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: true,
      targetRole: "reviewer",
      targetVerdicts: [
        { role: "reviewer", verdict: null, rule: "declared_other_task" },
      ],
    });
    expect(result).toEqual({
      action: "refuse",
      error: describeReviewerLeavingUnsignedRefusal("T1", "C1"),
    });
  });

  // S13: rodada indecidível (N vínculos, o report não nomeou nenhum) é
  // "não sei", e "não sei" não sustenta assinatura — também recusa.
  it("S13: rodada indecidível (undeclared_round) recusa, não 'já julgou'", () => {
    const result = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: true,
      targetRole: "reviewer",
      targetVerdicts: [{ role: "reviewer", verdict: null, rule: "undeclared_round" }],
    });
    expect(result).toEqual({
      action: "refuse",
      error: describeReviewerLeavingUnsignedRefusal("T1", "C1"),
    });
  });

  // S14: e o carimbo não APAGA a assinatura de verdade: um aprovado real
  // (declared_this_task) seguido de um carimbo antigo continua concluindo a
  // task com o fechamento. A rodada que nem fala desta task não pode ser a
  // "última palavra" sobre ela.
  it("S14: aprovado REAL seguido de carimbo antigo continua concluindo a task", () => {
    const result = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: true,
      targetRole: "reviewer",
      targetVerdicts: [
        { role: "reviewer", verdict: "aprovado", rule: "declared_this_task" },
        { role: "reviewer", verdict: null, rule: "declared_other_task" },
      ],
    });
    expect(result).toEqual({ action: "conclude-task", taskId: "T1", reason: "reviewer-signature" });
  });

  // S11: sem review, ok:true, quem pede NÃO é o implementer (reviewer,
  // outsider, ou papel desconhecido) — conclui a task junto com o
  // fechamento, o caso que a mensagem de S9 promete.
  it("S11: sem review, ok:true, requester não-implementer conclui a task", () => {
    const asReviewer = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: false,
      lastReportOk: true,
      requesterRoleOnTask: "reviewer",
    });
    expect(asReviewer).toEqual({ action: "conclude-task", taskId: "T1", reason: "success-report" });

    const asOutsider = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: false,
      lastReportOk: true,
      requesterRoleOnTask: null,
    });
    expect(asOutsider).toEqual({ action: "conclude-task", taskId: "T1", reason: "success-report" });
  });
});
