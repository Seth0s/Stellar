import { describe, it, expect } from "vitest";
import { describeSendSettlementAck, shouldAckSendSettlement } from "../../src/main/send-settle-decision";
import type { CardDeliveryState } from "../../src/main/type-and-submit-decision";

/**
 * A POLÍTICA do ack do `send_to_card` (task 40e3b551, decisão do dono).
 *
 * Medido: 888 `send_to_card` numa sessão contra 10 consultas a `get_delivery`.
 * Um ack por send seriam 888 linhas novas — e num orquestrador claude cada linha
 * é um turno para ler. Então: **silêncio = entregue**; só o que NÃO é entrega
 * limpa interrompe o autor.
 */
const ALL: CardDeliveryState[] = ["queued", "delivered", "parked", "unconfirmed", "failed", "cancelled"];

describe("send settle: silêncio = entregue", () => {
  it("entrega limpa NÃO gera ack; todo o resto gera", () => {
    expect(shouldAckSendSettlement("delivered")).toBe(false);
    for (const s of ALL.filter((x) => x !== "delivered")) {
      expect(shouldAckSendSettlement(s), s).toBe(true);
    }
  });

  it("a frase diz o que FAZER em cada caso, e não é um relatório", () => {
    const parked = describeSendSettlementAck({ state: "parked", id: "d1", target: "c2" });
    expect(parked).toMatch(/mid-turn queue/);
    expect(parked).toMatch(/[Dd]o not resend/);
    const cancelled = describeSendSettlementAck({ state: "cancelled", id: "d1", target: "c2" });
    expect(cancelled).toMatch(/resend if it still matters/);
    for (const s of ["unconfirmed", "failed"] as const) {
      const text = describeSendSettlementAck({ state: s, id: "d1", target: "c2" });
      expect(text).toMatch(/NOT confirmed/);
      expect(text).toMatch(/check read_card c2/);
      expect(text).toContain("d1");
      expect(text.length).toBeLessThan(400);
    }
  });
});
