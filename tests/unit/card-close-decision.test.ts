import { describe, it, expect } from "vitest";
import { decideCardClose } from "../../src/renderer/src/card-close-decision";

/**
 * O FECHO DE UM CARD NÃO PODE SER UM APAGAMENTO (task 4e4ec327).
 *
 * Este teste NASCE VERMELHO contra a política de hoje: fechar um terminal,
 * browser, files ou sticky apaga a linha, e a linha é a única coisa que nomeia o
 * card (label) e a única chave que faz os sobreviventes serem legíveis — medido:
 * 423 reports, 339 task_cards e 1750 task_verdicts já apontam para cards que não
 * existem mais.
 *
 * A distinção que o teste trava não é "arquivar é bonito": é que o GESTO de
 * fechar e o PEDIDO de exclusão são coisas diferentes. `explicitDelete` é a
 * porta do dono (o `delete_card` do MCP continua apagando de verdade, e é a
 * única coisa que apaga), e o fecho normal não é um pedido de exclusão.
 */
describe("decideCardClose — o fecho preserva a linha; só o pedido explícito apaga", () => {
  it("fechar um TERMINAL arquiva a linha (é ela que nomeia o card e sustenta os órfãos)", () => {
    expect(decideCardClose({ kind: "terminal" }).action).toBe("archive");
  });

  it("fechar um card de browser/files/sticky também arquiva", () => {
    for (const kind of ["browser", "files", "changes", "sticky", "media"]) {
      expect(decideCardClose({ kind }).action, `kind=${kind}`).toBe("archive");
    }
  });

  it("fechar um CHAT continua arquivando (o comportamento que já existia)", () => {
    expect(decideCardClose({ kind: "chat" }).action).toBe("archive");
  });

  it("e o PEDIDO EXPLÍCITO de exclusão continua apagando — para todo tipo", () => {
    for (const kind of ["chat", "terminal", "browser", "sticky"]) {
      expect(decideCardClose({ kind, explicitDelete: true }).action, `kind=${kind}`).toBe("delete");
    }
  });

  it("a decisão sempre carrega o motivo (quem lê o registro do fecho sabe por quê)", () => {
    for (const kind of ["chat", "terminal", "sticky"]) {
      expect(decideCardClose({ kind }).why.length).toBeGreaterThan(10);
    }
  });
});
