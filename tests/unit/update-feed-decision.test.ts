import { describe, it, expect } from "vitest";
import { decideUpdateFeed } from "../../src/main/update-feed-decision";

/**
 * A saída do GitHub (2026-09-15) tirou o feed de updates do ar. O risco
 * não é ficar sem update — é o app dizer "sem novidades" para sempre,
 * que era exatamente o que o tratamento antigo de 404 faria agora.
 */
describe("decideUpdateFeed", () => {
  it("sem publish configurado, a ausência é um estado próprio — não um sucesso vazio", () => {
    const state = decideUpdateFeed(undefined);
    expect(state.configured).toBe(false);
    if (state.configured) throw new Error("unreachable");
    expect(state.reason).toBe("no-feed");
  });

  it("a mensagem diz o que NÃO vai acontecer e o que fazer no lugar", () => {
    const state = decideUpdateFeed(null);
    if (state.configured) throw new Error("unreachable");
    expect(state.message).toMatch(/desligada/i);
    expect(state.message).toMatch(/manualmente/i);
  });

  it("com provider configurado volta a ser feed normal — a VPS só precisa preencher isto", () => {
    expect(decideUpdateFeed({ provider: "generic", url: "https://exemplo/releases" })).toEqual({ configured: true });
  });

  it("aceita a forma de lista que o electron-builder também permite", () => {
    expect(decideUpdateFeed([{ provider: "generic", url: "https://exemplo" }])).toEqual({ configured: true });
  });

  it("lista vazia é ausência, não configuração", () => {
    expect(decideUpdateFeed([]).configured).toBe(false);
  });
});
