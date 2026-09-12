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
// por decisão de escopo) — só as perguntas baratas da leitura:
// existe alguma coisa aqui, não está vazia, e (causa 2 do item
// "envelhece sozinho") o mtime ainda casa com a atividade do card.

function evidence(overrides: Partial<ResumeTargetEvidence>): ResumeTargetEvidence {
  return { exists: true, hasContent: true, mtimeMs: 1_000, ...overrides };
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

  it("sem referenceActivityMs o ramo stale NÃO dispara — idle overnight continua válido", () => {
    // Cause 2 precisa de atividade conhecida do card; relógio de parede
    // sozinho confundiria resume legítimo depois de horas parado.
    expect(
      decideResumeValidity(evidence({ mtimeMs: 1 }), {
        // sem referenceActivityMs
        staleAfterMs: 5_000,
      }),
    ).toEqual({ valid: true });
  });

  it("mtime velho demais frente à atividade do card => inválido com motivo 'stale'", () => {
    expect(
      decideResumeValidity(evidence({ mtimeMs: 1_000 }), {
        referenceActivityMs: 1_000 + 5 * 60_000 + 1,
        staleAfterMs: 5 * 60_000,
      }),
    ).toEqual({ valid: false, reason: "stale" });
  });

  it("mtime ainda dentro do limiar frente à atividade do card => válido", () => {
    expect(
      decideResumeValidity(evidence({ mtimeMs: 1_000 }), {
        referenceActivityMs: 1_000 + 5 * 60_000,
        staleAfterMs: 5 * 60_000,
      }),
    ).toEqual({ valid: true });
  });

  it("mtime null com referenceActivityMs => válido (sem sinal de tempo, não inventa stale)", () => {
    expect(
      decideResumeValidity(evidence({ mtimeMs: null }), {
        referenceActivityMs: 999_999,
        staleAfterMs: 1,
      }),
    ).toEqual({ valid: true });
  });
});
