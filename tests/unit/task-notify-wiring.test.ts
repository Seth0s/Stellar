import { describe, expect, it } from "vitest";
import { createNotifyCoalescer } from "../../src/main/notify-coalescer";
import { createTaskWriteFunnel } from "../../src/main/task-write-funnel";
import type { StatusWriteDecision } from "../../src/main/status-write-decision";
import type { TaskRow } from "../../src/main/store";

/**
 * A COMPOSIÇÃO DA FIAÇÃO (task ab83ba5f, fatia 3b) — o pedaço que o contrato
 * do módulo puro NÃO cobre.
 *
 * O módulo já prova que `close()` nunca limpa o timer sem entregar; o que
 * estes testes travam é o CALL SITE como ele está em `index.ts`: o funil
 * avisa UMA vez por escrita (não por task de um arraste em lote), a chave é
 * o board (`""` quando a task não tem board, porque o rodapé de escopo é
 * global), e a saída da janela flusheia o pendente em vez de descartá-lo.
 *
 * Se alguém trocar o `afterWrite` por um `notify` por task, o teste do
 * arraste pega; se alguém acrescentar um caminho de saída que só limpa o
 * timer, o teste do close pega.
 */
const DECISION: StatusWriteDecision = {
  status: "running",
  statusChanged: false,
  divergedStatus: null,
  divergedActor: null,
  recordDeclaration: false,
  warnAgent: false,
  declaredStatus: null,
};

function row(boardId: string | null): TaskRow {
  return { id: "T-1", board_id: boardId, status: "running" } as TaskRow;
}

function harness() {
  const timers: { id: number; fn: () => void; ms: number }[] = [];
  const delivered: string[] = [];
  let nextId = 1;
  const coalescer = createNotifyCoalescer({
    windowMs: 200,
    deliver: (key) => delivered.push(key),
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
  // Mesma forma da fiação em index.ts: `afterWrite` avisa o coalescer com o
  // board como chave (vazio quando não há board).
  const funnel = createTaskWriteFunnel({
    upsertTask: () => DECISION,
    applyColumnDrop: () => DECISION,
    afterWrite: (boardId) => coalescer.notify(boardId ?? ""),
    onTaskDone: () => {},
  });
  return {
    coalescer,
    funnel,
    delivered,
    timers,
    fireTimers: () => {
      for (const t of timers.splice(0)) t.fn();
    },
  };
}

describe("fiação do funil com o coalescer (ab83ba5f / 3b)", () => {
  it("5 escritas em rajada viram UMA entrega, com o board como chave", () => {
    const { funnel, delivered, timers, fireTimers } = harness();

    for (let i = 0; i < 5; i += 1) funnel.persistTask(row("118"));

    expect(timers).toHaveLength(1);
    expect(delivered).toEqual([]);
    fireTimers();
    expect(delivered).toEqual(["118"]);
  });

  it("arraste em lote (persistColumnDrop) avisa UMA vez, não uma por task", () => {
    const { funnel, delivered, timers, fireTimers } = harness();

    funnel.persistColumnDrop(row("118"), [
      { id: "sib-1", implicitOrder: 1 },
      { id: "sib-2", implicitOrder: 2 },
    ]);

    expect(timers).toHaveLength(1); // uma transação = um aviso
    fireTimers();
    expect(delivered).toEqual(["118"]);
  });

  it("task sem board ainda avisa: chave vazia (só o rodapé de escopo sai)", () => {
    const { funnel, delivered, timers, fireTimers } = harness();

    funnel.persistTask(row(null));

    expect(timers).toHaveLength(1);
    fireTimers();
    expect(delivered).toEqual([""]);
  });

  it("a SAÍDA da janela (close) FLUSHA o pendente — a última escrita não se perde", () => {
    const { funnel, coalescer, delivered, timers } = harness();

    funnel.persistTask(row("118")); // fica pendente na janela
    coalescer.close(); // é o que `win.on("close")` / `before-quit` fazem

    expect(delivered).toEqual(["118"]);
    expect(timers).toHaveLength(0);
  });

  it("duas rajadas separadas entregam duas vezes (o trailing edge não engole a segunda)", () => {
    const { funnel, delivered, timers, fireTimers } = harness();

    funnel.persistTask(row("118"));
    fireTimers();
    expect(delivered).toEqual(["118"]);

    funnel.persistTask(row("118"));
    expect(timers).toHaveLength(1); // nova janela armada
    fireTimers();
    expect(delivered).toEqual(["118", "118"]);
  });
});
