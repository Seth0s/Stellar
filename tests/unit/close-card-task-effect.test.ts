import { describe, it, expect } from "vitest";
import {
  decideCloseCardTaskEffect,
  describeCloseWithoutSuccessRefusal,
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
  // S1: review="wanted", reviewer with aprovado already on record — close
  // releases the link only. Done is a separate judgment write (update_task /
  // human), never a side effect of closing the card.
  it("S1: reviewer aprovado no close só libera o vínculo — NÃO conclui", () => {
    const result = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: true,
      targetRole: "reviewer",
      targetVerdicts: [{ role: "reviewer", verdict: "aprovado" }],
    });
    expect(result).toEqual({ action: "release-link", taskId: "T1" });
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

  // S9: no review required and no accepted success report of this task in the
  // round, asked by someone who is not the implementer: nothing to conclude, so
  // the link is released and the status is left alone.
  it("S9: sem review, sem report ok:true da rodada, pedido por terceiro → solta o vínculo", () => {
    const result = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: false,
      lastReportOk: false,
    });
    expect(result).toEqual({ action: "release-link", taskId: "T1" });
  });

  // S9b: the implementer asking for its own close is leaving by itself.
  it("S9b: o próprio implementer pedindo, sem report ok:true da rodada, é recusado", () => {
    const result = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: false,
      lastReportOk: false,
      requesterRoleOnTask: "implementer",
    });
    expect(result).toEqual({
      action: "refuse",
      error: describeCloseWithoutSuccessRefusal("T1", "C1"),
    });
  });

  // S9c: a reviewer link on a task with no review requirement has nothing to sign.
  it("S9c: o card fechado é revisor numa task sem review exigido → só fecha, mesmo com report ok:true", () => {
    expect(decideCloseCardTaskEffect({ ...base, targetRole: "reviewer", lastReportOk: true })).toEqual({
      action: "allow-close",
    });
    expect(decideCloseCardTaskEffect({ ...base, targetRole: "reviewer", lastReportOk: false })).toEqual({
      action: "allow-close",
    });
  });

  // S10: sem review, ok:true+final, o próprio implementer pede o close —
  // libera o vínculo e NÃO conclui (done só por julgamento explícito).
  it("S10: sem review, ok:true, implementer no próprio close → solta vínculo, não conclui", () => {
    const result = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: false,
      lastReportOk: true,
      requesterRoleOnTask: "implementer",
    });
    expect(result).toEqual({ action: "release-link", taskId: "T1" });
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

  // S14: carimbo de outra task não apaga um aprovado real — close still
  // only releases; it never concludes.
  it("S14: aprovado REAL seguido de carimbo antigo → só libera vínculo", () => {
    const result = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: true,
      targetRole: "reviewer",
      targetVerdicts: [
        { role: "reviewer", verdict: "aprovado", rule: "declared_this_task" },
        { role: "reviewer", verdict: null, rule: "declared_other_task" },
      ],
    });
    expect(result).toEqual({ action: "release-link", taskId: "T1" });
  });

  // S11 (dono 2026-10-09): close_card NUNCA conclui. Implementer reported
  // ok:true (+ final); orchestrator/outsider closes → release only, status
  // untouched. Real case: faae5162 closed as done solely from ok:true.
  it("S11: sem review, ok:true+final, requester não-implementer NÃO conclui — só libera", () => {
    const asReviewer = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: false,
      lastReportOk: true,
      requesterRoleOnTask: "reviewer",
    });
    expect(asReviewer).toEqual({ action: "release-link", taskId: "T1" });

    const asOutsider = decideCloseCardTaskEffect({
      ...base,
      reviewWanted: false,
      lastReportOk: true,
      requesterRoleOnTask: null,
    });
    expect(asOutsider).toEqual({ action: "release-link", taskId: "T1" });
  });
});
