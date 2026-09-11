import { describe, it, expect } from "vitest";
import { decideResumeValidity, type ResumeTargetEvidence } from "../../src/main/session-resume-validation";

// DESIGN-BACKLOG.md, "resume_id nao sobrevive ao restart", achado 2
// (2026-09-11) — card 330 restaurou com `resume_id = ae126710...`
// apontando pro arquivo de 2550 bytes de um spawn travado (nunca cresceu,
// nunca recebeu um turno de verdade) em vez de `53fcab93...` (15.9 MB, a
// sessão de fato em uso) — um `--resume` silencioso pra uma sessão vazia,
// sem aviso nenhum. `decideResumeValidity` é a metade pura desse conserto
// (encaminhamento 3): dado uma evidência já normalizada por provider
// (`getResumeTargetEvidence`, session-watch.ts — I/O real, fora do escopo
// deste teste, mesmo split que `session-rearm-decision.ts` já estabeleceu
// pro rearm), decide se um `resumeId` restaurado merece confiança.
//
// Deliberadamente NÃO testa "turno completo" (encaminhamento 2, adiado
// por decisão de escopo) — só as duas perguntas baratas da leitura:
// existe alguma coisa aqui, e não está vazia?

function evidence(overrides: Partial<ResumeTargetEvidence>): ResumeTargetEvidence {
  return { exists: true, hasContent: true, ...overrides };
}

describe("decideResumeValidity", () => {
  it("um resumeId com arquivo/registro existente e com conteúdo real é válido", () => {
    expect(decideResumeValidity(evidence({ exists: true, hasContent: true }))).toEqual({ valid: true });
  });

  it("nada encontrado pra este id é inválido com motivo 'missing' — o caso comum (apagado, ou nunca existiu)", () => {
    expect(decideResumeValidity(evidence({ exists: false, hasContent: true }))).toEqual({
      valid: false,
      reason: "missing",
    });
  });

  it("existe, mas nunca recebeu conteúdo, é inválido com motivo 'empty' — o caso ao vivo do card 330 (2550 bytes, nunca cresceu)", () => {
    expect(decideResumeValidity(evidence({ exists: true, hasContent: false }))).toEqual({
      valid: false,
      reason: "empty",
    });
  });

  it("'missing' vence 'empty' quando exists já é false — hasContent não importa nesse caso (documentado como ignorado)", () => {
    // `exists: false` já é o suficiente pra decidir; `hasContent: true`
    // aqui só prova que a função não olha esse campo quando exists é
    // false, não que os dois sinais sejam contraditórios na prática.
    expect(decideResumeValidity({ exists: false, hasContent: true })).toEqual({ valid: false, reason: "missing" });
  });
});
