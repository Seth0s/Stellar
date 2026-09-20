import { describe, expect, it } from "vitest";
import { createNotifyCoalescer } from "../../src/main/notify-coalescer";

/**
 * O CONTRATO DA FATIA 3b (task ab83ba5f), travado ANTES do wiring.
 *
 * O que está em jogo, medido (seq 509): o push `task:changed` custa 3,75ms
 * de SQLite + 1,48MB de JSON, e as escritas são bimodais (153 de 217 gaps
 * de 0ms numa hora). Coalescer corta 70-77% dos pushes — mas é o canal de
 * LIVENESS da Fila: um debounce que descarta o último evento congela a Fila
 * mostrando estado velho e ninguém percebe até alguém reclamar.
 *
 * Por isso o que estes testes travam, em ordem de importância:
 *   1. a ÚLTIMA escrita sempre sai (trailing-edge é garantia, não descarte);
 *   2. `close()` FLUSHA — limpar o timer pendente sem entregar é o ÚNICO
 *      jeito de este conserto virar perda de dado;
 *   3. chave diferente na mesma janela não é engolida;
 *   4. escrita durante a entrega não se perde.
 *
 * O relógio é injetado: nenhum teste espera 200ms de verdade.
 */
function harness() {
  const timers: { id: number; fn: () => void; ms: number }[] = [];
  const delivered: string[] = [];
  let nextId = 1;
  let onDeliver: ((key: string) => void) | null = null;

  const coalescer = createNotifyCoalescer({
    windowMs: 200,
    deliver: (key) => {
      delivered.push(key);
      onDeliver?.(key);
    },
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimer: (handle) => {
      const i = timers.findIndex((t) => t.id === handle);
      if (i >= 0) timers.splice(i, 1);
    },
  });

  return {
    coalescer,
    delivered,
    timers,
    /** Dispara só os timers armados ATÉ AGORA (não os que a entrega armar). */
    fireTimers: () => {
      for (const t of timers.splice(0)) t.fn();
    },
    onDeliver: (fn: (key: string) => void) => {
      onDeliver = fn;
    },
  };
}

describe("notify-coalescer (ab83ba5f / fatia 3b)", () => {
  it("rajada: 5 avisos na mesma janela viram UMA entrega — e nada sai antes da janela", () => {
    const { coalescer, delivered, timers, fireTimers } = harness();

    for (let i = 0; i < 5; i += 1) coalescer.notify("118");

    expect(delivered).toEqual([]); // nada entregue antes da janela
    expect(timers).toHaveLength(1); // um timer por janela, não por aviso
    expect(timers[0].ms).toBe(200); // a janela do trailing-edge
    expect(coalescer.pendingKeys()).toEqual(["118"]);

    fireTimers();
    expect(delivered).toEqual(["118"]);
    expect(coalescer.pendingKeys()).toEqual([]);
  });

  it("a ÚLTIMA escrita sempre sai: rajada de UM aviso também entrega", () => {
    const { coalescer, delivered, fireTimers } = harness();

    coalescer.notify("118");
    fireTimers();

    expect(delivered).toEqual(["118"]);
  });

  it("duas chaves na mesma janela entregam as DUAS, uma vez cada (board B não é engolido)", () => {
    const { coalescer, delivered, timers, fireTimers } = harness();

    coalescer.notify("118");
    coalescer.notify("7");
    coalescer.notify("118"); // repetição não duplica a entrega

    expect(timers).toHaveLength(1);
    fireTimers();

    expect(delivered).toEqual(["118", "7"]);
  });

  it("escrita DURANTE a entrega não se perde: arma uma nova janela", () => {
    const { coalescer, delivered, timers, fireTimers, onDeliver } = harness();
    let reentered = false;
    onDeliver((key) => {
      if (reentered) return;
      reentered = true;
      coalescer.notify(key); // a escrita que chega enquanto o push acontece
    });

    coalescer.notify("118");
    fireTimers();
    expect(delivered).toEqual(["118"]);
    expect(timers).toHaveLength(1); // nova janela armada, nada perdido

    fireTimers();
    expect(delivered).toEqual(["118", "118"]);
  });

  it("close() FLUSHA o pendente — nunca limpa o timer sem entregar (o risco que não pode virar perda de dado)", () => {
    const { coalescer, delivered, timers } = harness();

    coalescer.notify("118");
    coalescer.close();

    expect(delivered).toEqual(["118"]); // entregou no close, sem esperar a janela
    expect(timers).toHaveLength(0); // e não deixou timer pendente
  });

  it("close() é idempotente, e depois dele notify() não agenda nada", () => {
    const { coalescer, delivered, timers } = harness();

    coalescer.notify("118");
    coalescer.close();
    coalescer.close();
    coalescer.notify("118");

    expect(delivered).toEqual(["118"]); // uma entrega, não duas
    expect(timers).toHaveLength(0);
    expect(coalescer.pendingKeys()).toEqual([]);
  });

  it("flush() entrega na hora, cancela o timer e NÃO entrega de novo quando ele venceria", () => {
    const { coalescer, delivered, timers, fireTimers } = harness();

    coalescer.notify("118");
    coalescer.flush();

    expect(delivered).toEqual(["118"]);
    expect(timers).toHaveLength(0);

    fireTimers(); // não há timer para vencer
    expect(delivered).toEqual(["118"]);
  });

  it("flush() sem pendência não entrega nada", () => {
    const { coalescer, delivered } = harness();

    coalescer.flush();

    expect(delivered).toEqual([]);
  });
});
