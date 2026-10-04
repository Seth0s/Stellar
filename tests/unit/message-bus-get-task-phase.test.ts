import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";
import type { TaskRow } from "../../src/main/store";

/**
 * Task 6266d3e7 — get_task aceita ID CURTO (prefixo >= 8, único) e devolve a
 * `phase` DERIVADA. `get_task("0871b484")` respondia "no such task".
 */

function task(id: string, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    prompt: "work",
    provider: "commandcode",
    status: "pending",
    card_id: null,
    board_id: "b1",
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
    created_at: 1,
    updated_at: 1,
    ...over,
  } as unknown as TaskRow;
}

const A = "0871b484-aaaa-4bbb-8ccc-000000000001";
const B = "deadbeef-0000-4000-8000-000000000003";

describe("task 6266d3e7 — get_task: id curto + phase", () => {
  let ctx: { bus: ReturnType<typeof createMessageBus>; dir: string } | null = null;
  afterEach(() => {
    ctx?.bus.close();
    if (ctx) rmSync(ctx.dir, { recursive: true, force: true });
    ctx = null;
  });

  function rig(rows: TaskRow[], implementers: Array<{ card_id: string; reservation_state: string | null }>, report?: { updated_at: number }) {
    const dir = mkdtempSync(join(tmpdir(), "stellar-get-task-phase-"));
    const byId = new Map(rows.map((t) => [t.id, t]));
    const callbacks = new Proxy(
      {
        listTasks: () => rows,
        getTask: (id: string) => byId.get(id),
        listLiveImplementersForTask: () => implementers,
        getReport: () => report,
        getTaskVerdicts: () => [],
        getTaskTransitions: () => [],
        listTaskCardsForTask: () => [],
        listTaskCardsForCard: () => [],
      },
      { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => undefined) },
    ) as unknown as Parameters<typeof createMessageBus>[1];
    const bus = createMessageBus(join(dir, "agent-canvas.sock"), callbacks);
    ctx = { bus, dir };
    return bus;
  }

  it("prefixo único de 8 resolve e a task vem com `phase`", async () => {
    const bus = rig([task(A), task(B)], []);
    const res = (await bus.handleRequest({ cmd: "get_task", taskId: "0871b484" } as BusRequest)) as unknown as { ok: boolean; task?: { id: string; phase?: string } };
    expect(res.ok).toBe(true);
    expect(res.task?.id).toBe(A);
    expect(res.task?.phase).toBe("ready");
  });

  it("prefixo AMBÍGUO é recusado listando os candidatos (nunca adivinha)", async () => {
    const bus = rig([task(A), task("0871b484-aaaa-4bbb-8ccc-000000000002")], []);
    const res = (await bus.handleRequest({ cmd: "get_task", taskId: "0871b484" } as BusRequest)) as unknown as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("ambiguous");
  });

  it("implementer ativo sem report → phase running", async () => {
    const bus = rig([task(A)], [{ card_id: "c1", reservation_state: null }]);
    const res = (await bus.handleRequest({ cmd: "get_task", taskId: A } as BusRequest)) as unknown as { task: { phase?: string } };
    expect(res.task.phase).toBe("running");
  });

  it("report do implementer depois da entrega → phase awaiting_review", async () => {
    const bus = rig([task(A)], [{ card_id: "c1", reservation_state: null }], { updated_at: 10 });
    const res = (await bus.handleRequest({ cmd: "get_task", taskId: A } as BusRequest)) as unknown as { task: { phase?: string } };
    expect(res.task.phase).toBe("awaiting_review");
  });
});
