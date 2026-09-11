import { describe, it, expect } from "vitest";
import { deriveCardDisplayName, CARD_KIND_LABEL, type CardIdentitySnapshot } from "../../src/shared/card-identity";

// DESIGN-BACKLOG.md §2.1 "identidade e descoberta de card", ponto 1 —
// unifica 3 derivações independentes (main's antiga `describeCardLabel`,
// quebrada pra non-terminal; renderer's `describeCard`; o fallback embutido
// de cada header de card) numa função pura só. Casos pedidos explicitamente
// no briefing: card com label, sem label, dois do mesmo provider, provider
// diferente, card de outro board não deve entrar no ordinal.

function card(overrides: Partial<CardIdentitySnapshot> & { id: string }): CardIdentitySnapshot {
  return { kind: "terminal", label: null, provider: "codex", ...overrides };
}

describe("deriveCardDisplayName", () => {
  it("card com label => devolve o label, sem tocar em ordinal nem substantivo", () => {
    expect(deriveCardDisplayName(card({ id: "1", label: "Meu terminal" }), [])).toBe("Meu terminal");
  });

  it("terminal sem label, sozinho no board => 1° da lista", () => {
    const c = card({ id: "1" });
    expect(deriveCardDisplayName(c, [c])).toBe("Codex 1°");
  });

  it("dois terminais do MESMO provider, sem label => ordinal por ordem de id (nunca de criação)", () => {
    const a = card({ id: "5", provider: "codex" });
    const b = card({ id: "9", provider: "codex" });
    const same = [a, b];
    expect(deriveCardDisplayName(a, same)).toBe("Codex 1°");
    expect(deriveCardDisplayName(b, same)).toBe("Codex 2°");
  });

  it("dois terminais de provider DIFERENTE => cada um é 1° dentro do próprio provider, não compartilham contagem", () => {
    const claudeCard = card({ id: "3", provider: "claude" });
    const codexCard = card({ id: "4", provider: "codex" });
    const both = [claudeCard, codexCard];
    expect(deriveCardDisplayName(claudeCard, both)).toBe("Claude 1°");
    expect(deriveCardDisplayName(codexCard, both)).toBe("Codex 1°");
  });

  it("card de OUTRO board não entra no ordinal — caller passa só sameBoardCards, mas a função também nunca deveria contar alguém com id diferente do card mais ele mesmo fora da lista", () => {
    // Simula o caller filtrando por board ANTES de chamar (o contrato real
    // — a função em si não sabe de board nenhum, só do que recebe).
    const thisBoard = card({ id: "1", provider: "codex" });
    const otherBoardCodex = card({ id: "2", provider: "codex" }); // seria um 2º card codex, mas mora em outro board
    // Se o caller corretamente excluir `otherBoardCodex` da lista (porque é
    // de outro board), o resultado tem que continuar "1°" — nunca "2°" por
    // causa de alguém que nem deveria estar na conta.
    const sameBoardOnly = [thisBoard]; // otherBoardCodex já filtrado fora pelo caller
    expect(deriveCardDisplayName(thisBoard, sameBoardOnly)).toBe("Codex 1°");
  });

  it("fechar um card renumera os outros (ordinal é sobre EXIBIÇÃO, nunca identidade estável) — documentado, não uma regra nova", () => {
    const a = card({ id: "5", provider: "codex" });
    const b = card({ id: "9", provider: "codex" });
    expect(deriveCardDisplayName(b, [a, b])).toBe("Codex 2°");
    // `a` fechado — a mesma função, com a lista atualizada, dá um nome
    // DIFERENTE pro mesmo card `b`, sem que nada nele tenha mudado.
    expect(deriveCardDisplayName(b, [b])).toBe("Codex 1°");
  });

  it("kind não-terminal sem label => substantivo canônico capitalizado, sem id (ambiguidade entre 2 cards do mesmo kind é aceita, nunca foi diferente)", () => {
    expect(deriveCardDisplayName(card({ id: "10", kind: "files", provider: "" }), [])).toBe("Arquivos");
    expect(deriveCardDisplayName(card({ id: "11", kind: "task", provider: "" }), [])).toBe("Fila");
    expect(deriveCardDisplayName(card({ id: "12", kind: "changes", provider: "" }), [])).toBe("Changes");
  });

  it("kind não-terminal com fallbackHint => a pista específica vence o substantivo genérico (ex.: filename de um media sem label)", () => {
    expect(
      deriveCardDisplayName(card({ id: "13", kind: "media", provider: "", fallbackHint: "screenshot.png" }), []),
    ).toBe("screenshot.png");
  });

  it("fallbackHint vazio/null é ignorado, cai pro substantivo genérico", () => {
    expect(deriveCardDisplayName(card({ id: "14", kind: "media", provider: "", fallbackHint: "" }), [])).toBe("Mídia");
    expect(deriveCardDisplayName(card({ id: "15", kind: "media", provider: "", fallbackHint: null }), [])).toBe("Mídia");
  });

  it("kind desconhecido (nunca deveria acontecer, mas não deve lançar) => usa o próprio kind cru como substantivo", () => {
    expect(deriveCardDisplayName(card({ id: "16", kind: "algo-novo", provider: "" }), [])).toBe("Algo-novo");
  });

  it("CARD_KIND_LABEL cobre exatamente os 10 kinds conhecidos hoje", () => {
    expect(Object.keys(CARD_KIND_LABEL).sort()).toEqual(
      ["browser", "changes", "chat", "files", "media", "remote-window", "sticky", "stroke", "task", "terminal"].sort(),
    );
  });
});
