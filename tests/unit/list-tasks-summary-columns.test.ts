import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type TaskRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

// PERF (task c9db1d86, medido na 41813ab3 seq 447) — `list_tasks` com
// `view:"summary"` selecionava as 31 colunas (incluindo `prompt` e
// `result_json`, 82% dos bytes) e só descartava as duas no FIM, dentro de
// `projectListedTask`. O parâmetro que existe justamente pra economizar
// economizava apenas o fio do IPC: o SELECT e a serialização eram pagos
// inteiros. Medido com 284 tasks: 9,154ms e 1.348.938 bytes no caminho
// full contra 1,218ms e 236.824 bytes no summary.
//
// Este arquivo cobre os DOIS invariantes que a mudança pode quebrar:
//
// 1a — o statement `summary` tem que devolver EXATAMENTE as mesmas linhas,
//      na mesma ordem, com os mesmos campos do `full`; o único delta
//      permitido é `prompt`/`result_json` virem `null`. Sem isso, o ganho
//      seria uma regressão disfarçada (campo sumido, ordem trocada, linha
//      faltando).
// 1b — o handler tem que ESCOLHER o statement pela `view`, provado contando
//      qual callback foi chamado (mesma técnica do
//      `list-tasks-board-filter.test.ts`), não lendo o fonte do handler.
//
// O contrato do default fica travado aqui também: sem `view`, e com
// `view:"full"`, continua valendo o caminho largo — trocar o default é
// decisão do dono do repo, não desta task.
describe("list_tasks view=summary — statement dedicado e escolha pela view", () => {
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
      cwd: null,
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

  describe("1a — o statement summary devolve as mesmas linhas, menos prompt/result_json", () => {
    it("mesmos ids, mesma ordem, mesmas chaves; só prompt/result_json nulos", () => {
      dir = mkdtempSync(join(tmpdir(), "stellar-list-tasks-summary-"));
      const store = openStore(dir);
      try {
        // Prompt e result grandes e de tipos variados: o que o summary NÃO
        // pode é perder ou alterar qualquer outro campo por causa do corte.
        store.upsertTask(
          baseTaskFields("t1", {
            board_id: "board-a",
            prompt: "x".repeat(20_000),
            result_json: JSON.stringify({ ok: true, nested: { deep: [1, 2, 3] } }),
            deps_json: JSON.stringify(["dep-1"]),
            purpose: "fix",
            review: "wanted",
            gates_json: JSON.stringify(["npx tsc --noEmit"]),
            territory_json: JSON.stringify(["src/main/store.ts"]),
            allow_commit: 0,
            report_schema_json: JSON.stringify(["evidenciaMedida"]),
            retry_count: 2,
            attempted_providers_json: JSON.stringify(["claude"]),
            max_retries: 5,
            order: 7,
            suggested_order: 3,
            implicit_order: 1,
            diverged_status: "done",
            diverged_actor: "human",
            requested_status: "done",
            requested_reason: "porque sim",
            requested_by: "97924121",
            requested_at: 1234,
            sprint_id: "sprint-1",
          }),
        );
        store.upsertTask(baseTaskFields("t2", { board_id: "board-b", prompt: null, result_json: null }));
        store.upsertTask(baseTaskFields("t3", { board_id: "board-a", prompt: "curto" }));

        const full = store.listTasks();
        const summary = store.listTasksSummary();

        // Mesmas linhas, na mesma ordem.
        expect(summary.map((t) => t.id)).toEqual(full.map((t) => t.id));

        // Mesmas chaves em toda linha — nenhum campo sumiu.
        for (let i = 0; i < full.length; i++) {
          expect(Object.keys(summary[i]!).sort()).toEqual(Object.keys(full[i]!).sort());
        }

        // Todo campo exceto os dois grandes bate byte a byte.
        for (let i = 0; i < full.length; i++) {
          for (const [k, v] of Object.entries(full[i]!)) {
            if (k === "prompt" || k === "result_json") continue;
            expect(summary[i]![k as keyof TaskRow], `${full[i]!.id}.${k}`).toEqual(v);
          }
        }

        // E o único delta é exatamente: os dois em null.
        expect(summary[0]!.prompt).toBeNull();
        expect(summary[0]!.result_json).toBeNull();
        // ...enquanto o full continua trazendo os dois de verdade.
        expect((full[0]!.prompt ?? "").length).toBe(20_000);
        expect(full[0]!.result_json).not.toBeNull();
      } finally {
        store.close();
      }
    });

    it("a variante por board devolve as mesmas linhas do board, com prompt/result_json nulos", () => {
      dir = mkdtempSync(join(tmpdir(), "stellar-list-tasks-summary-board-"));
      const store = openStore(dir);
      try {
        store.upsertTask(baseTaskFields("t1", { board_id: "board-a", prompt: "a".repeat(5_000) }));
        store.upsertTask(baseTaskFields("t2", { board_id: "board-b", prompt: "b".repeat(5_000) }));
        store.upsertTask(baseTaskFields("t3", { board_id: "board-a", prompt: "c" }));

        const full = store.listTasksByBoard("board-a");
        const summary = store.listTasksSummaryByBoard("board-a");

        expect(summary.map((t) => t.id)).toEqual(full.map((t) => t.id));
        expect(summary.map((t) => t.id)).toEqual(["t1", "t3"]);
        for (const t of summary) {
          expect(t.prompt).toBeNull();
          expect(t.result_json).toBeNull();
        }
        // O board de fora não vaza pra nenhum dos dois.
        expect(full.some((t) => t.id === "t2")).toBe(false);
        expect(summary.some((t) => t.id === "t2")).toBe(false);
      } finally {
        store.close();
      }
    });
  });

  describe("1b — o handler escolhe o statement pela view", () => {
    function callbacksBackedByStore(
      store: ReturnType<typeof openStore>,
      counts: { listTasks: number; listTasksByBoard: number; listTasksSummary: number; listTasksSummaryByBoard: number },
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
            if (prop === "listTasksSummary") {
              return () => {
                counts.listTasksSummary++;
                return store.listTasksSummary();
              };
            }
            if (prop === "listTasksSummaryByBoard") {
              return (boardId: string) => {
                counts.listTasksSummaryByBoard++;
                return store.listTasksSummaryByBoard(boardId);
              };
            }
            if (prop === "listAllConnectors") return () => [];
            if (prop === "recordSpawn") return () => ({ id: "spawn-stub" });
            if (prop === "findSpawnByChild") return () => undefined;
            if (prop === "listSpawnsByParent") return () => [];
            if (prop === "listCards") return () => [];
            return () => undefined;
          },
        },
      ) as Parameters<typeof createMessageBus>[1];
    }

    it("view=summary usa o statement summary; sem view e view=full continuam no caminho largo", async () => {
      dir = mkdtempSync(join(tmpdir(), "stellar-list-tasks-summary-wiring-"));
      const store = openStore(dir);
      const counts = { listTasks: 0, listTasksByBoard: 0, listTasksSummary: 0, listTasksSummaryByBoard: 0 };
      const bus = createMessageBus(join(dir, "a.sock"), callbacksBackedByStore(store, counts));
      try {
        store.upsertTask(baseTaskFields("t1", { board_id: "board-a", prompt: "prompt secreto", result_json: '{"v":1}' }));
        store.upsertTask(baseTaskFields("t2", { board_id: "board-a" }));

        const summary = (await bus.handleRequest({ cmd: "list_tasks", view: "summary" } as BusRequest)) as {
          ok: boolean;
          tasks: { id: string; prompt?: unknown; result?: unknown }[];
        };
        expect(summary.ok).toBe(true);
        expect(summary.tasks.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
        // O statement largo não pode ter sido tocado.
        expect(counts.listTasksSummary).toBe(1);
        expect(counts.listTasks).toBe(0);
        expect(counts.listTasksSummaryByBoard).toBe(0);
        expect(counts.listTasksByBoard).toBe(0);
        // E a projeção continua valendo: os dois campos não saem no payload.
        for (const t of summary.tasks) {
          expect("prompt" in t).toBe(false);
          expect("result" in t).toBe(false);
        }

        // `view:"summary"` + boardId → statement summary por board.
        const summaryBoard = (await bus.handleRequest({
          cmd: "list_tasks",
          view: "summary",
          boardId: "board-a",
        } as BusRequest)) as { ok: boolean; tasks: { id: string }[] };
        expect(summaryBoard.ok).toBe(true);
        expect(counts.listTasksSummaryByBoard).toBe(1);
        expect(counts.listTasksByBoard).toBe(0);
        expect(counts.listTasks).toBe(0);

        // Contrato do default intacto: sem `view`, caminho largo.
        const def = (await bus.handleRequest({ cmd: "list_tasks" } as BusRequest)) as {
          ok: boolean;
          tasks: { id: string; prompt?: unknown }[];
        };
        expect(def.ok).toBe(true);
        expect(counts.listTasks).toBe(1);
        expect(counts.listTasksSummary).toBe(1);

        // E `view:"full"` explícito também continua largo.
        const full = (await bus.handleRequest({ cmd: "list_tasks", view: "full" } as BusRequest)) as {
          ok: boolean;
          tasks: { id: string; prompt?: unknown }[];
        };
        expect(full.ok).toBe(true);
        expect(counts.listTasks).toBe(2);
        expect(counts.listTasksSummary).toBe(1);
        // O `full` de verdade continua trazendo o prompt — a prova de que a
        // economia do summary não vazou pro caminho largo.
        expect(full.tasks.find((t) => t.id === "t1")?.prompt).toBe("prompt secreto");

        // Valor de view desconhecido continua recusado (nada de cair no full
        // fingindo que o filtro funcionou).
        const bad = (await bus.handleRequest({ cmd: "list_tasks", view: "resumido" } as BusRequest)) as {
          ok: boolean;
          error?: string;
        };
        expect(bad.ok).toBe(false);
      } finally {
        bus.close();
        store.close();
      }
    });
  });
});
