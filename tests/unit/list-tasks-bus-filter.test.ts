import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type TaskRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { invalidBusRequest, readBus } from "../helpers/bus-response";

describe("message-bus list_tasks: filtros + projeção", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function baseTask(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
    const now = Date.now();
    return {
      id,
      prompt: `prompt of ${id} — ${"p".repeat(80)}`,
      provider: "claude",
      status: "pending",
      card_id: null,
      board_id: "board-a",
      cwd: null,
      result_json: JSON.stringify({ note: id }),
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

  function openBus(store: ReturnType<typeof openStore>, aliveCardIds: string[] = []) {
    const alive = new Set(aliveCardIds);
    return createMessageBus(
      join(dir, "a.sock"),
      new Proxy(
        {},
        {
          get: (_t, prop: string) => {
            if (prop === "listTasks") return () => store.listTasks();
            if (prop === "listTasksByBoard") return (boardId: string) => store.listTasksByBoard(boardId);
            // PERF (task c9db1d86) — `view:"summary"` deixou de usar o
            // statement largo e passou a chamar estes dois; sem eles o Proxy
            // devolvia `undefined` e o handler quebrava em `tasks.map`. O
            // duble tem que espelhar a interface inteira, não só o caminho
            // que o teste exercitava quando foi escrito.
            if (prop === "listTasksSummary") return () => store.listTasksSummary();
            if (prop === "listTasksSummaryByBoard")
              return (boardId: string) => store.listTasksSummaryByBoard(boardId);
            if (prop === "listCards") return () => aliveCardIds.map((id) => ({ id }));
            if (prop === "getCardBoardId") return (id: string) => id === "caller-card" || id === "c1" ? "board-a" : undefined;
            if (prop === "isCardAlive") return (id: string) => alive.has(id);
            if (prop === "listAllConnectors") return () => [];
        if (prop === "recordSpawn") return () => ({ id: "spawn-stub" });
        if (prop === "findSpawnByChild") return () => undefined;
        if (prop === "listSpawnsByParent") return () => [];
            if (prop === "nextReportSeqSeed") return () => 0;
            return () => undefined;
          },
        },
      ) as Parameters<typeof createMessageBus>[1],
    );
  }

  it("status=pending + hasCard: a verdade do BANCO no `status`, a participação no `hasCard`", async () => {
    // CAMADA 4 (task b41ac547): este teste pinava a FUSÃO — pedia
    // `status:"running"` e recebia uma linha `pending` no banco porque o card
    // estava vivo. A pergunta honesta por participação é `hasCard`, e o
    // `status` responde pelo que está gravado (aqui, `pending`).
    dir = mkdtempSync(join(tmpdir(), "stellar-list-tasks-query-bus-"));
    const store = openStore(dir);
    const now = Date.now();
    store.upsertTask(baseTask("live", { card_id: "c1", status: "pending", updated_at: now }));
    store.upsertTask(baseTask("ghost", { card_id: "c-gone", status: "pending", updated_at: now }));
    store.upsertTask(baseTask("idle", { card_id: null, status: "pending", updated_at: now }));
    store.upsertTask(baseTask("other-board", { board_id: "board-b", card_id: "c1", status: "pending", updated_at: now }));
    store.upsertTask(baseTask("done-live", { card_id: "c1", status: "done", updated_at: now }));

    const bus = openBus(store, ["c1"]);
    try {
      const res = (await bus.handleRequest({
        cmd: "list_tasks",
        requesterId: "caller-card",
        boardId: "board-a",
        status: "pending",
        hasCard: true,
        view: "summary",
      } as BusRequest, { callerCardId: "caller-card", scopeEnforced: true })) as { ok: boolean; tasks: Array<Record<string, unknown>> };

      expect(res.ok).toBe(true);
      expect(res.tasks).toHaveLength(1);
      expect(res.tasks[0]!.id).toBe("live");
      expect(res.tasks[0]!.cardId).toBe("c1");
      // O status é o do banco; o segundo fato viaja no campo próprio.
      expect(res.tasks[0]!.status).toBe("pending");
      // (task 6266d3e7) O summary é uma ALLOWLIST: `cardAlive` saiu dele.
      expect(res.tasks[0]!).not.toHaveProperty("prompt");
      expect(res.tasks[0]!).not.toHaveProperty("result");

      // E `status:"running"` não acha nada: `running` nunca é autoritativo,
      // então filtrar por ele não é o jeito de perguntar por participação.
      const byFused = readBus<{ tasks: unknown[] }>(
        await bus.handleRequest({
          cmd: "list_tasks",
          requesterId: "caller-card",
          boardId: "board-a",
          status: "running",
          view: "summary",
        } as BusRequest, { callerCardId: "caller-card", scopeEnforced: true }),
      );
      expect(byFused.tasks).toHaveLength(0);
    } finally {
      bus.close();
      store.close();
    }
  });

  it("view inválida é recusada; omitido = summary (task 6266d3e7), full é explícito", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-list-tasks-query-bus-"));
    const store = openStore(dir);
    store.upsertTask(baseTask("t1"));
    const bus = openBus(store);
    try {
      const anonymous = readBus<{ ok: boolean; error?: string }>(
        await bus.handleRequest({ cmd: "list_tasks", requesterId: "caller-card" } as BusRequest),
      );
      expect(anonymous.ok).toBe(false);
      expect(anonymous.error).toMatch(/caller board identity/);

      const bad = (await bus.handleRequest(invalidBusRequest({ cmd: "list_tasks", requesterId: "caller-card", view: "tiny" }), { callerCardId: "caller-card", scopeEnforced: true })) as {
        ok: boolean;
        error?: string;
      };
      expect(bad.ok).toBe(false);
      expect(bad.error).toMatch(/view/);

      // Omitir não traz mais o firehose: summary é o default.
      const def = (await bus.handleRequest({ cmd: "list_tasks", requesterId: "caller-card" } as BusRequest, { callerCardId: "caller-card", scopeEnforced: true })) as {
        ok: boolean;
        tasks: Array<Record<string, unknown>>;
      };
      expect(def.ok).toBe(true);
      expect(def.tasks[0]).not.toHaveProperty("prompt");

      // `view:"full"` explícito continua largo.
      const full = (await bus.handleRequest({ cmd: "list_tasks", requesterId: "caller-card", view: "full" } as BusRequest, { callerCardId: "caller-card", scopeEnforced: true })) as {
        ok: boolean;
        tasks: Array<Record<string, unknown>>;
      };
      expect(full.ok).toBe(true);
      expect(full.tasks[0]).toHaveProperty("prompt");
      expect(full.tasks[0]).toHaveProperty("result");
    } finally {
      bus.close();
      store.close();
    }
  });

  it("default summary de 120 tasks responde < 30 KB (aceite task 6266d3e7)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-list-tasks-size-"));
    const store = openStore(dir);
    for (let i = 0; i < 120; i++) {
      store.upsertTask(baseTask(`t-${i}`, { board_id: "board-a", prompt: `task ${i} — ${"p".repeat(200)}` }));
    }
    store.upsertTask(baseTask("foreign-board-task", { board_id: "board-b" }));
    const bus = openBus(store);
    try {
      const res = (await bus.handleRequest({ cmd: "list_tasks", requesterId: "caller-card" } as BusRequest, { callerCardId: "caller-card", scopeEnforced: true })) as {
        ok: boolean;
        tasks: unknown[];
      };
      expect(res.ok).toBe(true);
      expect(res.tasks).toHaveLength(120);
      // O firehose (>100 tasks) some no default: summary < 30 KB.
      const bytes = Buffer.byteLength(JSON.stringify(res.tasks), "utf8");
      expect(bytes).toBeLessThan(30_000);
    } finally {
      bus.close();
      store.close();
    }
  });
});
