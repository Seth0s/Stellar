import { describe, it, expect } from "vitest";
import { claimSessionId, releaseSessionId, isSessionIdClaimed } from "../../src/main/session-watch";

// Review adversarial RODADA 8 (2026-09-10), achado 2 — `claimedSessionIds`
// era um `Set` com `delete()` incondicional, assumindo (errado) que um id
// só tem UM detentor por vez. Cenário real: dois cards restaurados com o
// MESMO `resumeId` explícito (um board reaberto com dois cards apontando
// pro mesmo `resume_id`) — se um deles trocar de sessão via `/resume` e
// `releaseSessionId` apagar o id incondicionalmente, o OUTRO card, que
// continua usando aquela sessão de verdade, fica sem proteção: um
// terceiro watcher pode roubá-la em pleno uso. `claimedSessionIds` virou
// `Map<string, number>` (contagem de referências) — estes testes vão
// direto na dupla `claimSessionId`/`releaseSessionId` (estado síncrono,
// módulo-level, sem I/O nenhum) usando `isSessionIdClaimed` (hook só de
// observação, existe unicamente pra isto) pra checar o resultado.
//
// Ids aleatórios por teste (não reaproveitados) — `claimedSessionIds` é
// module-level e vive pra vida inteira do processo, sem reset entre
// testes; ids únicos evitam qualquer teste pisar no estado de outro.
function freshId(label: string): string {
  return `sess-${label}-${Math.random().toString(36).slice(2)}`;
}

describe("claimSessionId / releaseSessionId — RODADA 8, achado 2: contagem de referências", () => {
  it("id nunca reivindicado => isSessionIdClaimed é false", () => {
    expect(isSessionIdClaimed(freshId("never-claimed"))).toBe(false);
  });

  it("um claim, um release => id fica livre de novo", () => {
    const id = freshId("single-holder");
    claimSessionId(id);
    expect(isSessionIdClaimed(id)).toBe(true);
    releaseSessionId(id);
    expect(isSessionIdClaimed(id)).toBe(false);
  });

  it("RODADA 8, achado 2 — dois claim no MESMO id (dois cards com o mesmo resumeId) + UM release => id continua reivindicado, o outro detentor continua protegido", () => {
    const id = freshId("two-holders");
    claimSessionId(id); // card A
    claimSessionId(id); // card B, mesmo resumeId
    expect(isSessionIdClaimed(id)).toBe(true);

    releaseSessionId(id); // card A troca de sessão via /resume e solta este id
    // Este é o caso exato que a RODADA 7 quebrava: com um Set simples,
    // esta linha já teria apagado o id inteiramente — card B, que ainda
    // está usando a sessão de verdade, ficaria sem proteção.
    expect(isSessionIdClaimed(id)).toBe(true);

    releaseSessionId(id); // card B agora também solta (ex.: fechou o card)
    expect(isSessionIdClaimed(id)).toBe(false);
  });

  it("release de um id nunca reivindicado é no-op seguro — não lança, não deixa a contagem negativa", () => {
    const id = freshId("release-without-claim");
    expect(() => releaseSessionId(id)).not.toThrow();
    expect(isSessionIdClaimed(id)).toBe(false);

    // Um claim/release normal DEPOIS disso continua funcionando — prova
    // que o release sem claim correspondente não deixou nenhum estado
    // corrompido (ex.: contagem em -1) que atrapalhasse o próximo ciclo.
    claimSessionId(id);
    expect(isSessionIdClaimed(id)).toBe(true);
    releaseSessionId(id);
    expect(isSessionIdClaimed(id)).toBe(false);
  });

  it("release chamado MAIS vezes que claim (dois releases pro mesmo claim) não deixa a contagem negativa nem corrompida", () => {
    const id = freshId("over-release");
    claimSessionId(id);
    releaseSessionId(id);
    releaseSessionId(id); // 2ª liberação, sem claim correspondente
    expect(isSessionIdClaimed(id)).toBe(false);

    // Um novo claim depois do over-release ainda funciona normalmente —
    // não fica "preso" num estado -1 que precisaria de 2 claims pra
    // voltar a ficar protegido.
    claimSessionId(id);
    expect(isSessionIdClaimed(id)).toBe(true);
  });

  it("claim, claim, release, claim, release, release => três claims no total, três releases no total, livre só no final", () => {
    const id = freshId("interleaved");
    claimSessionId(id); // 1
    claimSessionId(id); // 2
    releaseSessionId(id); // 1
    expect(isSessionIdClaimed(id)).toBe(true);
    claimSessionId(id); // 2
    releaseSessionId(id); // 1
    expect(isSessionIdClaimed(id)).toBe(true);
    releaseSessionId(id); // 0
    expect(isSessionIdClaimed(id)).toBe(false);
  });
});
