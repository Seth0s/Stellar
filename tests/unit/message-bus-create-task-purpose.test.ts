import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import { openStore } from "../../src/main/store";

/**
 * `create_task.purpose` (2026-09-13) — the column entered in 51332f3
 * without a writer; almost every task is born over MCP/acbridge, so this
 * is where the field starts existing. Real store behind the bus on
 * purpose: the immutability claim ("update_task cannot relabel it") is
 * about what lands in SQLite, not about what a mock received.
 */
describe("message-bus: create_task purpose (write-once, refused when unknown)", () => {
  let dir: string;
  let bus: ReturnType<typeof createMessageBus> | null;
  let store: ReturnType<typeof openStore> | null;

  afterEach(() => {
    bus?.close();
    bus = null;
    store?.close();
    store = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function boot() {
    dir = mkdtempSync(join(tmpdir(), "stellar-create-task-purpose-"));
    const s = openStore(dir);
    store = s;
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      new Proxy(
        {},
        {
          get: (_t, prop: string) => {
            if (prop === "getTask") return (id: string) => s.getTask(id);
            if (prop === "upsertTask") return (task: Parameters<typeof s.upsertTask>[0]) => s.upsertTask(task);
            if (prop === "listTasks") return () => s.listTasks();
            if (prop === "boardExists") return () => true;
            if (prop === "getCardBoardId") return () => undefined;
            if (prop === "listAllConnectors") return () => [];
        if (prop === "recordSpawn") return () => ({ id: "spawn-stub" });
        if (prop === "findSpawnByChild") return () => undefined;
        if (prop === "listSpawnsByParent") return () => [];
            if (prop === "listCards") return () => [];
            if (prop === "listTaskCardsForCard") return (cardId: string) => s.listTaskCardsForCard(cardId);
            return () => undefined;
          },
        },
      ) as Parameters<typeof createMessageBus>[1],
    );
    return { bus, store: s };
  }

  async function createTask(fields: Record<string, unknown>) {
    // `boardId` por padrão desde 2026-09-19: `create_task` sem board nenhum
    // é RECUSADO (task órfã, invisível na Fila). Os casos aqui são sobre
    // `purpose`, então o board não pode ser o que falta.
    return (await bus!.handleRequest({ cmd: "create_task", boardId: "b1", ...fields } as BusRequest)) as { ok: boolean; taskId?: string; error?: string };
  }

  it("purpose válido é gravado e volta em list_tasks/get_task", async () => {
    const { store } = boot();
    const res = await createTask({ prompt: "why does X fail", purpose: "investigate" });
    expect(res.ok).toBe(true);
    expect(store.getTask(res.taskId!)!.purpose).toBe("investigate");

    const got = (await bus!.handleRequest({ cmd: "get_task", taskId: res.taskId } as BusRequest)) as { task: { purpose: unknown } };
    expect(got.task.purpose).toBe("investigate");
    const listed = (await bus!.handleRequest({ cmd: "list_tasks" } as BusRequest)) as { tasks: Array<{ id: string; purpose: unknown }> };
    expect(listed.tasks.find((t) => t.id === res.taskId)!.purpose).toBe("investigate");
  });

  it("purpose omitido: task nasce normal, purpose null (ausência é estado NORMAL, não default)", async () => {
    const { store } = boot();
    const res = await createTask({ prompt: "no idea yet" });
    expect(res.ok).toBe(true);
    expect(store.getTask(res.taskId!)!.purpose).toBeNull();
    const got = (await bus!.handleRequest({ cmd: "get_task", taskId: res.taskId } as BusRequest)) as { task: { purpose: unknown } };
    expect(got.task.purpose).toBeNull();
  });

  it("purpose inválido: RECUSADO, nenhuma task criada — não vira null nem implement em silêncio", async () => {
    const { store } = boot();
    for (const bad of ["banana", "INVESTIGATE", "review", "implementer", ""]) {
      const res = await createTask({ prompt: "x", purpose: bad });
      expect(res.ok, `purpose ${JSON.stringify(bad)} must be refused`).toBe(false);
      expect(res.error).toContain(`got "${bad}"`);
      expect(res.error).toContain('"investigate", "implement", "measure", "fix", "integrate"');
    }
    expect(store.listTasks()).toHaveLength(0);
  });

  it("purpose continua imutável: update_task com `purpose` no corpo (como o acbridge pode mandar) não muda a linha", async () => {
    const { store } = boot();
    const created = await createTask({ prompt: "fix the leak", purpose: "fix" });
    // acbridge `update-task <id> <json>` spreads the raw JSON into the
    // request, so a `purpose` key CAN reach the bus. The BusRequest type
    // does not declare it; the cast is the runtime shape, not the API.
    const upd = (await bus!.handleRequest({
      cmd: "update_task",
      taskId: created.taskId,
      status: "done",
      purpose: "investigate",
    } as unknown as BusRequest)) as { ok: boolean };
    expect(upd.ok).toBe(true);
    const row = store.getTask(created.taskId!)!;
    expect(row.status).toBe("done");
    expect(row.purpose).toBe("fix");
  });

  it("purpose imutável também quando nasceu null: update_task não consegue preenchê-lo depois", async () => {
    const { store } = boot();
    const created = await createTask({ prompt: "later" });
    await bus!.handleRequest({ cmd: "update_task", taskId: created.taskId, purpose: "measure", status: "running" } as unknown as BusRequest);
    expect(store.getTask(created.taskId!)!.purpose).toBeNull();
  });
});
