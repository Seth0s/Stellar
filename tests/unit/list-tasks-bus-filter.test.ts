import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type TaskRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

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

  it("status=running + hasCard: stored pending com card vivo deriva running, sem prompt/result", async () => {
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
        boardId: "board-a",
        status: "running",
        hasCard: true,
        view: "summary",
      } as BusRequest)) as { ok: boolean; tasks: Array<Record<string, unknown>> };

      expect(res.ok).toBe(true);
      expect(res.tasks).toHaveLength(1);
      expect(res.tasks[0]!.id).toBe("live");
      expect(res.tasks[0]!.cardId).toBe("c1");
      expect(res.tasks[0]!.status).toBe("running");
      expect(res.tasks[0]!).not.toHaveProperty("prompt");
      expect(res.tasks[0]!).not.toHaveProperty("result");
    } finally {
      bus.close();
      store.close();
    }
  });

  it("view inválida é recusada; omitido preserva firehose full", async () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-list-tasks-query-bus-"));
    const store = openStore(dir);
    store.upsertTask(baseTask("t1"));
    const bus = openBus(store);
    try {
      const bad = (await bus.handleRequest({ cmd: "list_tasks", view: "tiny" } as BusRequest)) as {
        ok: boolean;
        error?: string;
      };
      expect(bad.ok).toBe(false);
      expect(bad.error).toMatch(/view/);

      const full = (await bus.handleRequest({ cmd: "list_tasks" } as BusRequest)) as {
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
});
