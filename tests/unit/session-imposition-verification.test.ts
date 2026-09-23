import { describe, it, expect } from "vitest";
import {
  IMPOSITION_GRACE_MS,
  decideImpositionVerification,
  impositionFollowUp,
} from "../../src/main/session-imposition-verification";

/**
 * A REGRA QUE FALTA (task 201bd13b, parte 3).
 *
 * Hoje `canImposeSessionId` é uma AFIRMAÇÃO num arquivo de configuração, e o
 * sistema NUNCA a confere — pior: quando o id é imposto, `pty-registry.ts`
 * (linhas 1085-1090) grava o id como se tivesse sido ENCONTRADO e PULA o
 * watcher (`claimSessionId` + `onSessionFound`), então não existe nem o canal
 * que descobriria o id de verdade. Se a CLI ignorar o id em silêncio — que é o
 * que o cline fazia com um UUID — o card fica apontando para uma sessão que não
 * existe, e nada avisa.
 *
 * A detecção barata é comparar o id imposto com o que aparece no store
 * DECLARADO pelo provider logo depois do spawn. Esta função é a decisão pura
 * disso; o I/O (ler o store) fica de fora, com quem já sabe fazer isso
 * (`getResumeTargetEvidence` em `session-watch.ts`).
 */

describe("decideImpositionVerification", () => {
  const id = "11111111-2222-4333-8444-555555555555";

  it("antes da janela de espera NÃO se conclui nada (a CLI precisa de tempo para gravar)", () => {
    expect(
      decideImpositionVerification({ imposedId: id, elapsedMs: 10, storeRead: { exists: false, hasContent: false } }),
    ).toEqual({ verdict: "too-early" });
  });

  it("o id apareceu no store declarado -> CONFIRMADO", () => {
    expect(
      decideImpositionVerification({
        imposedId: id,
        elapsedMs: IMPOSITION_GRACE_MS + 1,
        storeRead: { exists: true, hasContent: true },
      }),
    ).toEqual({ verdict: "confirmed", id });
  });

  it("sessão vazia ainda CONFIRMA: a imposição promete que o ID existe, não que há conteúdo", () => {
    expect(
      decideImpositionVerification({
        imposedId: id,
        elapsedMs: IMPOSITION_GRACE_MS + 1,
        storeRead: { exists: true, hasContent: false },
      }),
    ).toEqual({ verdict: "confirmed", id });
  });

  it("passada a janela e o id NÃO está no store -> NÃO PEGOU (e a declaração está contradita)", () => {
    expect(
      decideImpositionVerification({
        imposedId: id,
        elapsedMs: IMPOSITION_GRACE_MS + 1,
        storeRead: { exists: false, hasContent: false },
      }),
    ).toEqual({ verdict: "not-imposed", id, declarationContradicted: true });
  });

  it("sem canal de medição (store ausente/ilegível) -> DESCONHECIDO, nunca uma acusação", () => {
    // `null` é o que `getResumeTargetEvidence` devolve quando o provider não
    // declara store, ou quando a leitura falhou. Sem canal, a resposta honesta
    // é "não sei" — acusar aqui reprovaria providers que impõem de verdade só
    // porque não sabemos ler o store deles.
    expect(
      decideImpositionVerification({ imposedId: id, elapsedMs: IMPOSITION_GRACE_MS + 1, storeRead: null }),
    ).toEqual({ verdict: "unknown", reason: "no-store" });
  });
});

describe("impositionFollowUp — o que o app faz com cada veredito", () => {
  const id = "x";

  it("não pegou -> re-armar o watcher (é ele que descobre o id real) e soltar a reivindicação", () => {
    expect(impositionFollowUp({ verdict: "not-imposed", id, declarationContradicted: true })).toBe(
      "rearm-watcher",
    );
  });

  it("confirmado -> nada a fazer; a reivindicação fica", () => {
    expect(impositionFollowUp({ verdict: "confirmed", id })).toBe("keep");
  });

  it("indefinido -> esperar/conservar, nunca agir no escuro", () => {
    expect(impositionFollowUp({ verdict: "too-early" })).toBe("wait");
    expect(impositionFollowUp({ verdict: "unknown", reason: "no-store" })).toBe("keep");
  });
});
