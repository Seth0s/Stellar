import { describe, expect, it } from "vitest";
import {
  UNCONFIRMED_ESCALATE_MS,
  isProvisionalUnknown,
  shouldEscalateUnconfirmed,
} from "../../src/renderer/src/composer-status-decision";

/**
 * O CHIP DO COMPOSER para `unknown` (2026-10-05). O defeito: uma mensagem que
 * CHEGOU aparecia como "Sem confirmação · Master: unknown — tentar de novo", um
 * alarme que induzia o reenvio e a duplicata. A decisão que separa o estado
 * NEUTRO ("enviado") do alerta é pura e mora em `composer-status-decision.ts`;
 * é ela que estes testes prendem.
 */
describe("composer-status: `unknown` é neutro, não alarme", () => {
  it("o desfecho `unknown` do laço é o estado neutro; os outros `unconfirmed` são alerta", () => {
    // `unknown` = o laço não VIU a evidência a tempo — trata como enviado.
    expect(isProvisionalUnknown("unconfirmed", "unknown")).toBe(true);
    // Incerteza mais forte (não deu para perguntar): segue alerta.
    for (const result of ["read-failed", "card-gone", "error", "unsent", "sent", null]) {
      expect(isProvisionalUnknown("unconfirmed", result), String(result)).toBe(false);
    }
    // Estados que não são `unconfirmed` nunca viram o neutro.
    for (const delivery of ["delivered", "parked", "failed", "queued"]) {
      expect(isProvisionalUnknown(delivery, "unknown"), delivery).toBe(false);
    }
  });

  it("a janela neutra é de ~20 s: ANTES dela a UI não escala para alerta", () => {
    expect(UNCONFIRMED_ESCALATE_MS).toBe(20_000);
    expect(shouldEscalateUnconfirmed(0)).toBe(false);
    expect(shouldEscalateUnconfirmed(UNCONFIRMED_ESCALATE_MS - 1)).toBe(false);
    // Só ao completar a janela — sem nenhum sinal nesse meio-tempo — vira alerta.
    expect(shouldEscalateUnconfirmed(UNCONFIRMED_ESCALATE_MS)).toBe(true);
    expect(shouldEscalateUnconfirmed(UNCONFIRMED_ESCALATE_MS + 1)).toBe(true);
  });
});
