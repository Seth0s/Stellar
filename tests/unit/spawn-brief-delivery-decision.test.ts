import { describe, it, expect } from "vitest";
import {
  decideSpawnBriefMode,
  describeSpawnBriefDelivery,
} from "../../src/main/spawn-brief-delivery-decision";

/**
 * O contrato de VERDADE do `spawn_agent` sobre o brief (task bf1fb0a7).
 *
 * Antes disto a ferramenta respondia `{ok:true, cardId}` para quatro situações
 * indistinguíveis de fora — brief em argv, brief só enfileirado, brief nenhum,
 * brief enfileirado e perdido. O orquestrador (medido: 2026-09-22, quatro
 * chamadas sem `brief` no próprio transcript dele) leu as quatro como "o app
 * não entrega o brief" e passou a entregar tudo à mão.
 */
describe("spawn brief delivery — o que a chamada diz", () => {
  it("sem brief: diz que NADA foi entregue (e que o card vai ficar ocioso)", () => {
    const r = describeSpawnBriefDelivery({ hasBrief: false, canArgv: true, tooLarge: false });
    expect(r.briefMode).toBe("none");
    expect(r.briefDelivered).toBe(false);
    expect(r.briefDeliveryId).toBeUndefined();
    expect(r.briefNote).toMatch(/NO brief/);
    expect(r.briefNote).toMatch(/idle/);
  });

  it("brief no argv: é a única entrega que não depende de nada posterior", () => {
    const r = describeSpawnBriefDelivery({ hasBrief: true, canArgv: true, tooLarge: false });
    expect(r.briefMode).toBe("argv");
    expect(r.briefDelivered).toBe(true);
    expect(r.briefNote).toMatch(/argv/);
  });

  it("brief digitado: NÃO é entregue — é fila, e o veredito é consultável", () => {
    const r = describeSpawnBriefDelivery({
      hasBrief: true,
      canArgv: false,
      tooLarge: false,
      typedDeliveryId: "d-1",
    });
    expect(r.briefMode).toBe("typed");
    expect(r.briefDelivered).toBe(false);
    expect(r.briefDeliveryId).toBe("d-1");
    expect(r.briefNote).toMatch(/get_delivery\("d-1"\)/);
  });

  it("grande demais para o argv cai no caminho digitado mesmo com provider positional", () => {
    expect(decideSpawnBriefMode({ hasBrief: true, canArgv: true, tooLarge: true })).toBe("typed");
    const r = describeSpawnBriefDelivery({ hasBrief: true, canArgv: true, tooLarge: true });
    expect(r.briefDelivered).toBe(false);
    // Sem recibo o texto não foi a lugar nenhum: a frase tem de dizer isso, não
    // prometer uma fila que não existe.
    expect(r.briefNote).toMatch(/was NOT delivered/);
  });
});
