import { describe, it, expect } from "vitest";
import { resolveCallerCardId } from "../../src/main/caller-identity";

/**
 * DESIGN-BACKLOG.md §0, review adversarial do card 337 ("fila 85975417",
 * 2026-09-11) — ACHADO CRÍTICO: `callerCardId` explícito vencia o carimbo da
 * URL, permitindo um card num board comum forjar a identidade de um card
 * num board autônomo e pular consentimento (`spawn_agent`/`open_url`/
 * `close_card`). Conserto: o carimbo da URL vence SEMPRE que existe — o
 * explícito só serve de fallback quando não há carimbo nenhum. Ver o
 * comentário grande de `caller-identity.ts` pro porquê da assimetria.
 */
describe("resolveCallerCardId", () => {
  it("[cenário de escalada, negativo] card com carimbo real forjando o id de OUTRO card (ex.: um card de board autônomo) — o carimbo vence, a forja é ignorada", () => {
    const result = resolveCallerCardId({ urlCardId: "card-comum-real", explicitCallerCardId: "card-vitima-board-autonomo" });
    expect(result).toBe("card-comum-real");
    expect(result).not.toBe("card-vitima-board-autonomo");
  });

  it("carimbo presente e explícito ausente: usa o carimbo (caso comum, callerCardId omitido)", () => {
    expect(resolveCallerCardId({ urlCardId: "card-a", explicitCallerCardId: undefined })).toBe("card-a");
  });

  it("carimbo presente e explícito É o mesmo card: sem diferença prática, mas a fonte de verdade continua sendo o carimbo", () => {
    expect(resolveCallerCardId({ urlCardId: "card-a", explicitCallerCardId: "card-a" })).toBe("card-a");
  });

  it("SEM carimbo (cliente MCP externo genuíno, URL sem ?card=): cai pro explícito, exatamente como antes desta correção", () => {
    expect(resolveCallerCardId({ urlCardId: undefined, explicitCallerCardId: "card-externo" })).toBe("card-externo");
  });

  it("sem carimbo E sem explícito: undefined, sem identidade nenhuma pra atribuir", () => {
    expect(resolveCallerCardId({ urlCardId: undefined, explicitCallerCardId: undefined })).toBeUndefined();
  });

  it("carimbo vazio/só espaço conta como AUSENTE — cai pro explícito, mesmo tratamento que a string vazia já tinha do lado do explícito", () => {
    expect(resolveCallerCardId({ urlCardId: "", explicitCallerCardId: "card-b" })).toBe("card-b");
    expect(resolveCallerCardId({ urlCardId: "   ", explicitCallerCardId: "card-b" })).toBe("card-b");
  });

  it("explícito vazio/só espaço conta como ausente — um modelo que preenche \"\" não está se identificando", () => {
    expect(resolveCallerCardId({ urlCardId: undefined, explicitCallerCardId: "" })).toBeUndefined();
    expect(resolveCallerCardId({ urlCardId: undefined, explicitCallerCardId: "   " })).toBeUndefined();
  });

  it("tolera espaço em volta de um carimbo real (mesma tolerância que o explícito já tinha)", () => {
    expect(resolveCallerCardId({ urlCardId: " card-a ", explicitCallerCardId: undefined })).toBe("card-a");
  });
});
