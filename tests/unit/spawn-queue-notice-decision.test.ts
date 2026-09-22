import { describe, it, expect } from "vitest";
import {
  SPAWN_QUEUE_NOTICE_MIN_WAIT_MS,
  describeQueuedSpawnArrival,
  shouldNoticeQueuedSpawnArrival,
} from "../../src/main/spawn-queue-notice-decision";

/**
 * A segunda via do cardId quando a fila despacha depois do watchdog
 * (task bf1fb0a7, o card fantasma). O caso real: as duas chamadas antigravity de
 * 2026-09-21 resolveram 444s e 238s depois de emitidas; o watchdog de 300s do
 * cliente já tinha abortado as duas, e os cards nasceram depois do abort — sem
 * cardId, o orquestrador briefou à mão um card que não era o dele e o mesmo
 * enunciado foi para dois cards na mesma árvore.
 */
describe("spawn queue notice", () => {
  it("abaixo do piso NÃO avisa: o chamador ainda vai receber a própria resposta", () => {
    expect(shouldNoticeQueuedSpawnArrival(0)).toBe(false);
    expect(shouldNoticeQueuedSpawnArrival(SPAWN_QUEUE_NOTICE_MIN_WAIT_MS - 1)).toBe(false);
  });

  it("do piso para cima avisa, e o piso é bem menor que os 300s do watchdog medido", () => {
    expect(shouldNoticeQueuedSpawnArrival(SPAWN_QUEUE_NOTICE_MIN_WAIT_MS)).toBe(true);
    expect(SPAWN_QUEUE_NOTICE_MIN_WAIT_MS).toBeLessThan(300_000);
  });

  it("a frase diz o card, a espera em segundos, e o que NÃO fazer", () => {
    const text = describeQueuedSpawnArrival({
      cardId: "97924157",
      provider: "antigravity",
      waitedMs: 444_000,
      label: "Veredito escopado",
    });
    expect(text).toContain("97924157");
    expect(text).toContain("antigravity");
    expect(text).toContain("444s");
    expect(text).toMatch(/do not spawn another/);
    expect(text).toMatch(/close the duplicate/);
  });

  it("sem label a frase continua legível (não inventa nome)", () => {
    const text = describeQueuedSpawnArrival({ cardId: "c1", provider: "cline", waitedMs: 31_000 });
    expect(text).toContain("c1");
    expect(text).toContain("31s");
    expect(text).not.toMatch(/labelled/);
  });
});
