import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type TaskRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

// DESIGN-BACKLOG.md §2.1 item 6 — review adversarial (Gemini 3.1 Pro),
// severidade média: message-bus.ts's cmd `list_tasks` carregava a tabela
// INTEIRA via `callbacks.listTasks()` e filtrava por `board_id` em JS,
// mesmo quando `boardId` era passado — descartando a maior parte do
// resultado depois de já ter pago o custo de trazer tudo pra memória do
// Node. `store.listTasksByBoard` (SQL indexado, `idx_tasks_board_id`) já
// existia e já era testado direto contra o store (task-transitions.test.ts)
// — o que faltava era a FIAÇÃO: `index.ts` estava travado por outro agente
// quando isso foi documentado, agora liberado.
//
// Este teste não repete a lógica de filtro (isso já é coberto contra o
// store real) — cobre o INVARIANTE que motivou o achado: com `boardId`,
// o cmd nunca deve tocar o caminho "lista tudo". Provado contando chamadas
// nas duas callbacks (Proxy backed por spies), não lendo o código-fonte do
// handler.
describe("message-bus.ts: list_tasks usa o statement indexado por board", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function baseTaskFields(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
    const now = Date.now();
    return {
      id,
      prompt: "faz X",
      provider: "claude",
      status: "pending",
      card_id: null,
      board_id: "default",
      result_json: null,
      deps_json: null,
      retry_count: 0,
      attempted_providers_json: null,
      max_retries: null,
      fallback_providers_json: null,
      order: null,
      suggested_order: null,
      implicit_order: null,
      diverged_status: null,
      diverged_actor: null,
      created_at: now,
      updated_at: now,
      ...overrides,
    } as TaskRow;
  }

  function callbacksBackedByStore(
    store: ReturnType<typeof openStore>,
    counts: { listTasks: number; listTasksByBoard: number },
  ): Parameters<typeof createMessageBus>[1] {
    return new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === "listTasks") {
            return () => {
              counts.listTasks++;
              return store.listTasks();
            };
          }
          if (prop === "listTasksByBoard") {
            return (boardId: string) => {
              counts.listTasksByBoard++;
              return store.listTasksByBoard(boardId);
            };
          }
          if (prop === "listAllConnectors") return () => [];
          if (prop === "listCards") return () => [];
          return () => undefined;
        },
      },
    ) as Parameters<typeof createMessageBus>[1];
  }

  it("com boardId: só listTasksByBoard é chamada, nunca listTasks; sem boardId: comportamento antigo intacto", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-list-tasks-board-"));
    const store = openStore(dir);
    const counts = { listTasks: 0, listTasksByBoard: 0 };
    const bus = createMessageBus(join(dir, "a.sock"), callbacksBackedByStore(store, counts));
    try {
      store.upsertTask(baseTaskFields("t1", { board_id: "board-a" }));
      store.upsertTask(baseTaskFields("t2", { board_id: "board-b" }));
      store.upsertTask(baseTaskFields("t3", { board_id: "board-a" }));

      const filtered = (await bus.handleRequest({ cmd: "list_tasks", boardId: "board-a" } as BusRequest)) as {
        ok: boolean;
        tasks: { id: string }[];
      };
      expect(filtered.ok).toBe(true);
      expect(filtered.tasks.map((t) => t.id).sort()).toEqual(["t1", "t3"]);
      expect(counts.listTasksByBoard).toBe(1);
      expect(counts.listTasks).toBe(0);

      const unfiltered = (await bus.handleRequest({ cmd: "list_tasks" } as BusRequest)) as {
        ok: boolean;
        tasks: { id: string }[];
      };
      expect(unfiltered.ok).toBe(true);
      expect(unfiltered.tasks.map((t) => t.id).sort()).toEqual(["t1", "t2", "t3"]);
      expect(counts.listTasks).toBe(1);
      // still only the one call from the boardId request above.
      expect(counts.listTasksByBoard).toBe(1);

      // An empty board is a real, correct result — not an error.
      const empty = (await bus.handleRequest({ cmd: "list_tasks", boardId: "board-nonexistent" } as BusRequest)) as {
        ok: boolean;
        tasks: unknown[];
      };
      expect(empty.ok).toBe(true);
      expect(empty.tasks).toEqual([]);
    } finally {
      bus.close();
      store.close();
    }
  });
});
