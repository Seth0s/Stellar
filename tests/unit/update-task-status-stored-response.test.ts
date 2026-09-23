import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type TaskRow } from "../../src/main/store";
import { createMessageBus, type BusRequest } from "../../src/main/message-bus";

/**
 * "A resposta diz o que FICOU GRAVADO" — task 34e27f66.
 *
 * O defeito medido: `update_task status:"running"` é aceito pelo schema, o
 * store normaliza para `pending` (`coerceStoredTaskStatus`, o domínio
 * ESCRITO não tem `running`) e a resposta voltava `{ok:true}` SEM `status`
 * nenhum. O agente acreditava ter escrito `running` — a mesma família do
 * relatório gravado sob id fantasma: a porta de escrita afirmando um fato
 * que não aconteceu.
 *
 * O rig fala pela PORTA REAL (`handleRequest({cmd:"update_task"})`) com o
 * store REAL (`openStore`), porque é o store que faz a normalização — um
 * duble que devolvesse `decision.status` copiando a proposta não mediria
 * nada.
 *
 * PROVA POR MUTAÇÃO (ver gatesOutput): (i) tirar `...storedStatusFields`
 * da resposta deixa o primeiro caso vermelho; (ii) emitir a nota sempre
 * (não só quando a proposta difere) deixa o controle de `done` vermelho.
 */

function baseTask(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: "work",
    provider: "cline",
    status: "pending",
    card_id: null,
    board_id: "board-a",
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

describe("update_task: a resposta carrega o status GRAVADO (task 34e27f66)", () => {
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

  function rig(task: TaskRow) {
    dir = mkdtempSync(join(tmpdir(), "stellar-update-task-stored-"));
    store = openStore(dir);
    store.upsertTask(task);
    const live = store;
    bus = createMessageBus(
      join(dir, "agent-canvas.sock"),
      new Proxy(
        {},
        {
          get: (_t, prop: string) => {
            if (prop === "getTask") return (id: string) => live.getTask(id);
            if (prop === "listTasks") return () => live.listTasks();
            if (prop === "upsertTask") return (row: TaskRow) => live.upsertTask(row);
            if (prop === "getTaskCards") return () => [];
            if (prop === "getBoardCwd") return () => undefined;
            if (prop === "getBoardOrchestratorCardId") return () => null;
            return () => undefined;
          },
        },
      ) as Parameters<typeof createMessageBus>[1],
    );
    return bus;
  }

  it("status:'running' — a resposta diz 'pending' e nomeia a diferença (o defeito)", async () => {
    const res = (await rig(baseTask("t-running")).handleRequest({
      cmd: "update_task",
      taskId: "t-running",
      status: "running",
    } as BusRequest)) as { ok: boolean; status?: string; warning?: string };

    expect(res.ok).toBe(true);
    // O FATO: o valor gravado, não a proposta.
    expect(res.status).toBe("pending");
    expect(store!.getTask("t-running")?.status).toBe("pending");
    // E a diferença é NOMEADA — um `pending` mudo ainda deixaria o agente
    // acreditando que escreveu `running`.
    expect(res.warning).toContain('status stored: "pending"');
    expect(res.warning).toContain('"running"');
  });

  it("status:'done' — a resposta diz 'done' e NÃO inventa diferença (controle)", async () => {
    const res = (await rig(baseTask("t-done")).handleRequest({
      cmd: "update_task",
      taskId: "t-done",
      status: "done",
    } as BusRequest)) as { ok: boolean; status?: string; warning?: string };

    expect(res.ok).toBe(true);
    expect(res.status).toBe("done");
    expect(res.warning).toBeUndefined();
  });

  it("sem status no pedido — a resposta não inventa a chave `status` (controle)", async () => {
    const res = (await rig(baseTask("t-none")).handleRequest({
      cmd: "update_task",
      taskId: "t-none",
      result: { note: "n" },
    } as BusRequest)) as { ok: boolean; status?: string };

    expect(res.ok).toBe(true);
    expect(res.status).toBeUndefined();
  });
});
